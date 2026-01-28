const WebSocket = require('ws');
const { Client } = require('ssh2');
const { inventory } = require('./monitor');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { findServer, resolvePrivateKey } = require('./ws-utils');
const logger = require('./logger');

const LOG_FILE_PATH = path.join(__dirname, '..', 'terminal_log.json');

let logQueue = Promise.resolve();

// Глобальные хранилища для REST API bridge
const wsSessions = {};
// sessionId -> { ws, stream, serverId, serverName, connectedAt }

const pendingCommands = {};
// commandId -> { sessionId, command, status, result, resolve, reject, timeoutId, createdAt }

function appendToLog(logEntry) {
  logQueue = logQueue.then(async () => {
    try {
      let logs = [];
      try {
        const data = await fs.readFile(LOG_FILE_PATH, 'utf8');
        logs = JSON.parse(data);
      } catch (readErr) {
        if (readErr.code !== 'ENOENT') { // ENOENT means file doesn't exist, which is fine
          logger.error('terminal', 'Error reading log file for appending', { error: readErr.message });
        }
      }
      logs.push(logEntry);
      await fs.writeFile(LOG_FILE_PATH, JSON.stringify(logs, null, 2));
    } catch (writeErr) {
      logger.error('terminal', 'Error writing to log file', { error: writeErr.message });
    }
  }).catch(err => {
    // Prevent unhandled promise rejection
    logger.error('terminal', 'Error in log queue', { error: err.message });
  });
}

function stripAnsi(str) {
  // This regex removes ANSI escape codes used for colors, cursor movement, etc.
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

// --- START: Skills support ---

/**
 * Парсит YAML frontmatter из SKILL.md
 * Формат:
 * ---
 * name: skill-name
 * description: Описание skill
 * params:
 *   - name: param1
 *     description: Описание параметра
 *     required: false
 * ---
 * ## What I do
 * ...
 */
function parseSkillFrontmatter(content, fallbackName = 'unknown') {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { name: fallbackName, description: '', params: [], content: content.trim() };
  }

  const frontmatter = match[1];
  const body = match[2].trim();

  // Простой парсер YAML (без зависимостей)
  const result = { name: fallbackName, description: '', params: [], content: body };

  // Парсим name
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Парсим description
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  if (descMatch) result.description = descMatch[1].trim();

  // Парсим params (упрощённо — только имена)
  const paramsMatch = frontmatter.match(/^params:\s*\n((?:\s+-[\s\S]*?(?=\n[^\s-]|$))+)/m);
  if (paramsMatch) {
    const paramsBlock = paramsMatch[1];
    const paramMatches = paramsBlock.matchAll(/^\s+-\s*name:\s*(\S+)/gm);
    for (const pm of paramMatches) {
      result.params.push({ name: pm[1] });
    }
  }

  return result;
}

/**
 * Получает список всех skills с удалённого сервера
 * @param {Object} sshConn - SSH connection (ssh2 Client)
 * @returns {Promise<Array<{name, description, params}>>}
 */
function getRemoteSkills(sshConn, remoteOS = 'linux') {
  return new Promise((resolve) => {
    let cmd;
    
    if (remoteOS === 'windows') {
      // PowerShell команда для Windows с UTF-8
      cmd = `powershell -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $skillsDir = Join-Path $env:USERPROFILE '.config/kosmos-panel/skills'; if (Test-Path $skillsDir) { Get-ChildItem -Path $skillsDir -Directory | ForEach-Object { $skillFile = Join-Path $_.FullName 'SKILL.md'; if (Test-Path $skillFile) { Write-Host '===SKILL:' $_.Name '==='; Get-Content $skillFile -Raw -Encoding UTF8; Write-Host '===END_SKILL===' } } }"`;
    } else {
      // Bash команда для Linux/macOS
      const skillsPath = '$HOME/.config/kosmos-panel/skills';
      cmd = `for d in ${skillsPath}/*/; do if [ -f "$d/SKILL.md" ]; then echo "===SKILL:$(basename "$d")==="; cat "$d/SKILL.md"; echo "===END_SKILL==="; fi; done 2>/dev/null`;
    }

    const commandTimeout = setTimeout(() => {
      logger.warn('skills', 'Remote skills command timed out');
      resolve([]);
    }, 5000);

    let content = '';
    sshConn.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(commandTimeout);
        logger.error('skills', 'Error executing remote skills command', { error: err.message });
        return resolve([]);
      }
      stream.on('data', (data) => { content += data.toString(); });
      stream.stderr.on('data', (data) => { logger.info('skills', 'stderr: ' + data.toString()); });
      stream.on('close', () => {
        clearTimeout(commandTimeout);
        logger.info('skills', 'Raw skills output', { content: content.substring(0, 500), remoteOS });
        
        if (!content.includes('===SKILL:')) {
          logger.info('skills', 'No skills found - no ===SKILL: marker in output');
          return resolve([]);
        }

        // Парсим skills по маркерам
        const skills = [];
        const skillBlocks = content.split('===SKILL:');
        
        for (const block of skillBlocks) {
          if (!block.trim()) continue;
          
          const nameEndIdx = block.indexOf('===');
          if (nameEndIdx === -1) continue;
          
          const skillName = block.substring(0, nameEndIdx).trim();
          const endMarkerIdx = block.indexOf('===END_SKILL===');
          const skillContent = endMarkerIdx !== -1 
            ? block.substring(nameEndIdx + 3, endMarkerIdx).trim()
            : block.substring(nameEndIdx + 3).trim();
          
          if (skillContent) {
            const parsed = parseSkillFrontmatter(skillContent, skillName);
            skills.push({
              name: parsed.name,
              description: parsed.description,
              params: parsed.params
            });
          }
        }

        logger.info('skills', 'Successfully loaded remote skills', { count: skills.length });
        resolve(skills);
      });
    });
  });
}

/**
 * Получает конкретный skill по имени с удалённого сервера
 * @param {Object} sshConn - SSH connection (ssh2 Client)
 * @param {string} skillName - Имя skill
 * @param {string} remoteOS - 'linux' или 'windows'
 * @returns {Promise<{name, description, params, content} | null>}
 */
function getRemoteSkill(sshConn, skillName, remoteOS = 'linux') {
  return new Promise((resolve) => {
    let cmd;
    
    if (remoteOS === 'windows') {
      cmd = `powershell -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content (Join-Path $env:USERPROFILE '.config/kosmos-panel/skills/${skillName}/SKILL.md') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue"`;
    } else {
      const skillPath = `~/.config/kosmos-panel/skills/${skillName}/SKILL.md`;
      cmd = `cat ${skillPath} 2>/dev/null`;
    }

    const commandTimeout = setTimeout(() => {
      logger.warn('skills', 'Remote skill command timed out', { skillName });
      resolve(null);
    }, 5000);

    let content = '';
    sshConn.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(commandTimeout);
        logger.error('skills', 'Error executing remote skill command', { skillName, error: err.message });
        return resolve(null);
      }
      stream.on('data', (data) => { content += data.toString(); });
      stream.on('close', () => {
        clearTimeout(commandTimeout);
        
        if (!content.trim()) {
          logger.debug('skills', 'Skill not found', { skillName });
          return resolve(null);
        }

        const parsed = parseSkillFrontmatter(content, skillName);
        logger.info('skills', 'Successfully loaded skill', { skillName, bytes: content.length });
        resolve(parsed);
      });
    });
  });
}

// --- END: Skills support ---

function attachWsServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer });

  // Heartbeat mechanism
  const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
      if (ws.isAlive === false) {
        logger.warn('ws', 'Terminating inactive connection');
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', function close() {
    clearInterval(interval);
  });

  wss.on('connection', (ws, req) => {
    // Heartbeat setup
    ws.isAlive = true;
    ws.on('pong', function heartbeat() {
      this.isAlive = true;
    });

    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/ws/terminal') return handleTerminal(ws, url);
      if (url.pathname === '/ws/tail') return handleTail(ws, url);

      logger.warn('ws', `Unknown path: ${url.pathname}`);
      ws.close(1008, 'unknown path');
    } catch (e) {
      logger.error('ws', 'Connection handling error', { error: e.message });
      try { ws.close(1008, 'bad request'); } catch { }
    }
  });
}

function handleTerminal(ws, url) {
  // query: serverId, cols, rows
  const serverId = url.searchParams.get('serverId');
  const cols = Number(url.searchParams.get('cols') || 120);
  const rows = Number(url.searchParams.get('rows') || 30);

  // Добавляем обработчик закрытия для диагностики
  ws.on('close', (code, reason) => {
    const reasonStr = reason ? reason.toString() : 'no reason';
    if (code === 1006) {
      logger.warn('ws', 'Terminal socket abnormal closure (1006)', { 
        code, 
        reason: reasonStr,
        hint: 'Connection lost without close frame - network issue, browser closed, or server restart'
      });
    } else if (code === 1001) {
      logger.info('ws', 'Terminal socket closed (going away)', { code, reason: reasonStr });
    } else {
      logger.info('ws', 'Terminal socket closed', { code, reason: reasonStr });
    }
  });

  ws.on('error', (err) => {
    logger.error('ws', 'Terminal socket error', { error: err.message });
  });

  const server = findServer(serverId);
  if (!server) return ws.close(1008, 'server not found');

  let key, passphrase, password, useAgent;
  try {
    const r = resolvePrivateKey(server.ssh.credentialId);
    key = r.key; passphrase = r.passphrase; password = r.password; useAgent = r.useAgent;
  } catch (e) {
    try { ws.send(JSON.stringify({ type: 'fatal', error: 'credential error: ' + e.message })); } catch { }
    return setTimeout(() => { try { ws.close(1011, 'credential error'); } catch { } }, 10);
  }
  const sessionId = uuidv4();

  const conn = new Client();
  logger.info('ws', `Terminal connecting to ${server.ssh.user}@${server.ssh.host}`);
  conn
    .on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          try { ws.send(JSON.stringify({ type: 'fatal', error: 'shell error: ' + err.message })); } catch { }
          setTimeout(() => { try { ws.close(1011, 'shell error'); } catch { }; conn.end(); }, 10);
          return;
        }

        // Определяем ОС удалённого сервера
        let remoteOS = 'linux'; // по умолчанию
        let osDetectionDone = false;
        const detectOS = () => new Promise((resolve) => {
          conn.exec('uname -s 2>&1', (err, osStream) => {
            if (err) return resolve('linux');
            let osOut = '';
            let osErr = '';
            osStream.on('data', (d) => { osOut += d.toString(); });
            osStream.stderr.on('data', (d) => { osErr += d.toString(); });
            osStream.on('close', () => {
              const combined = (osOut + osErr).toUpperCase();
              // Windows SSH вернёт ошибку "not recognized" для uname
              if (combined.includes('NOT RECOGNIZED') || combined.includes('WINDOWS')) {
                resolve('windows');
              } else if (combined.includes('LINUX') || combined.includes('DARWIN') || combined.includes('FREEBSD')) {
                resolve('linux');
              } else {
                resolve('linux'); // по умолчанию
              }
            });
          });
        });
        detectOS().then(os => {
          remoteOS = os;
          osDetectionDone = true;
          logger.info('ws', `Detected remote OS: ${remoteOS}`);
          // Отправляем клиенту информацию об ОС
          try { ws.send(JSON.stringify({ type: 'os_detected', os: remoteOS })); } catch {}
        });

        // Сохраняем сессию для REST API bridge
        wsSessions[sessionId] = {
          ws,
          stream,
          serverId,
          serverName: server.name || serverId,
          connectedAt: new Date().toISOString(),
          getOS: () => remoteOS
        };
        logger.info('ws', `Session registered for REST bridge`, { sessionId });

        // Отправляем sessionId клиенту
        try {
          ws.send(JSON.stringify({ type: 'session', sessionId }));
        } catch (e) {
          logger.error('ws', 'Failed to send sessionId to client', { error: e.message });
        }

        let stdoutBuffer = '';
        let stderrBuffer = '';

        // Переменные для связывания записей
        let currentAiQueryId = null;
        let currentStdinId = null;

        // Multi-step skill state
        let activeSkill = null; // { name, messages: [], step: 0, maxSteps: 10, waitingForOutput: false, waitingForUser: false }

        // Информация о сервере для логирования
        const serverInfo = {
          serverId: serverId,
          serverName: server.name || serverId,
          serverHost: server.ssh.host
        };

        // Проверяем, есть ли промпт в буфере (команда завершилась)
        const checkForPromptAndFlush = () => {
          // Ищем промпт типа "user@host:path$ " или "root@host:path# "
          const promptRegex = /\w+@\w+[^$#>]*[\$#>]\s*$/m;

          if (promptRegex.test(stdoutBuffer)) {
            logger.debug('terminal', 'Обнаружен промпт, сохраняем вывод команды в лог');

            // Разделяем буфер на вывод команды и промпт
            const lines = stdoutBuffer.split('\n');
            let commandOutput = '';
            let promptFound = false;

            for (let i = 0; i < lines.length; i++) {
              if (promptRegex.test(lines[i])) {
                // Нашли строку с промптом
                promptFound = true;
                break;
              } else {
                commandOutput += lines[i] + '\n';
              }
            }

            // Записываем только вывод команды (без промпта)
            let cleanOutput = '';
            if (commandOutput.trim()) {
              cleanOutput = stripAnsi(commandOutput).trim();

              // Фильтруем эхо ввода ai: команд
              if (cleanOutput && !cleanOutput.includes('ai:')) {
                const logEntry = {
                  id: uuidv4(),
                  sessionId,
                  timestamp: new Date().toISOString(),
                  type: 'stdout',
                  terminal_output: cleanOutput,
                  ...serverInfo
                };

                // Связываем stdout с предыдущей stdin командой
                if (currentStdinId) {
                  logEntry.stdin_id = currentStdinId;
                }

                appendToLog(logEntry);
                logger.debug('terminal', 'Записан stdout', { stdin_id: currentStdinId });
              } else if (cleanOutput.includes('ai:')) {
                logger.debug('terminal', 'Отфильтровано эхо ai: команды', { output: cleanOutput });
              }
            }

            // Сбрасываем ID после записи stdout
            currentStdinId = null;

            // ========== Multi-step Skill: продолжить после выполнения команды ==========
            if (activeSkill && activeSkill.waitingForOutput) {
              activeSkill.waitingForOutput = false;
              const outputForAI = cleanOutput || '(no output)';
              logger.debug('skills', 'Command output received, continuing skill', { 
                step: activeSkill.step, 
                outputLength: outputForAI.length 
              });
              
              // Асинхронно продолжаем skill
              setImmediate(async () => {
                try {
                  await activeSkill.sendNextRequest(`Command output:\n${outputForAI}`);
                } catch (e) {
                  logger.error('skills', 'Error continuing skill', { error: e.message });
                  ws.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[1;31m[Skill Error] ${e.message}\x1b[0m\r\n` }));
                  activeSkill = null;
                }
              });
            }

            // Очищаем буфер
            stdoutBuffer = '';
          }
        };

        ws.on('message', async (msg) => {
          try {
            const obj = JSON.parse(msg.toString());
            const { type, data, prompt, command } = obj;
            
            // Логируем все входящие сообщения кроме data (слишком много)
            if (type !== 'data') {
              logger.info('ws', 'Received message', { type, hasPrompt: !!prompt, hasCommand: !!command });
            }

            if (type === 'data') {
              stream.write(data);
            } else if (type === 'resize' && obj.cols && obj.rows) {
              stream.setWindow(Number(obj.rows), Number(obj.cols), 0, 0);
            } else if (type === 'close') {
              stream.end();
            } else if (type === 'command_log' && command) {
              // Записываем команду в лог
              const stdinId = uuidv4();
              const logEntry = {
                id: stdinId,
                sessionId,
                timestamp: new Date().toISOString(),
                type: 'stdin',
                executed_command: command,
                ...serverInfo
              };

              // Связываем stdin с AI запросом, если есть
              if (currentAiQueryId) {
                logEntry.ai_query_id = currentAiQueryId;
                currentAiQueryId = null; // Сбрасываем после использования
              }

              currentStdinId = stdinId; // Сохраняем для связи с stdout
              appendToLog(logEntry);
            } else if (type === 'command_result' && obj.commandId) {
              // Обработка результата команды от клиента (REST bridge)
              const cmd = pendingCommands[obj.commandId];
              if (cmd) {
                logger.info('ws', 'Received command_result', { commandId: obj.commandId, status: obj.status });
                cmd.status = obj.status;
                cmd.result = {
                  stdout: obj.stdout || '',
                  stderr: obj.stderr || '',
                  exitCode: obj.exitCode
                };

                // Очищаем таймаут
                if (cmd.timeoutId) {
                  clearTimeout(cmd.timeoutId);
                }

                // Разрешаем Promise для sync режима
                if (cmd.resolve) {
                  cmd.resolve(cmd);
                }
              } else {
                logger.warn('ws', 'command_result for unknown commandId', { commandId: obj.commandId });
              }
            } else if (type === 'skills_list') {
              // Ждём определения ОС если ещё не завершено
              if (!osDetectionDone) {
                await new Promise(r => setTimeout(r, 500));
              }
              // Получаем список skills с удалённого сервера
              logger.info('skills', 'Received skills_list request', { remoteOS });
              try {
                const skills = await getRemoteSkills(conn, remoteOS);
                logger.info('skills', 'Sending skills_list response', { count: skills.length });
                ws.send(JSON.stringify({ type: 'skills_list', skills }));
              } catch (e) {
                logger.error('skills', 'Error getting skills list', { error: e.message });
                ws.send(JSON.stringify({ type: 'skills_list', skills: [], error: e.message }));
              }
            } else if (type === 'skill_invoke' && obj.name) {
              // ========== Multi-step Skill Invoke ==========
              const skillName = obj.name;
              const skillParams = obj.params || {};
              const userPrompt = obj.prompt || '';
              
              try {
                const skill = await getRemoteSkill(conn, skillName, remoteOS);
                if (!skill) {
                  ws.send(JSON.stringify({ type: 'skill_error', error: `Skill "${skillName}" not found` }));
                  return;
                }

                const aiBaseUrl = process.env.AI_KOSMOS_MODEL_BASE_URL || 'http://localhost:3002/v1';
                const aiServerUrl = `${aiBaseUrl}/chat/completions`;
                const aiModel = process.env.AI_MODEL || 'CHEAP';
                
                // Специальный системный промпт для multi-step skills
                const skillSystemPrompt = `You are a Linux terminal AI assistant executing a multi-step skill.

RESPONSE FORMAT - Use EXACTLY ONE of these formats per response:

1. [CMD] command_here
   Execute this shell command. You will receive the command output.

2. [MESSAGE] your message here
   Show this message to the user and wait for their response.
   Use this to ask questions or request input (like commit messages).

3. [DONE] final message here
   The skill is complete. Show this final message to the user.

RULES:
- Always start your response with [CMD], [MESSAGE], or [DONE]
- Only ONE format per response
- For [CMD]: provide only the command, no explanations
- For [MESSAGE]: ask clear, specific questions
- For [DONE]: summarize what was accomplished`;

                // Получаем knowledge
                const getRemoteKnowledge = (sshConn) => new Promise((resolve) => {
                  let commandTimeout = setTimeout(() => resolve(''), 5000);
                  let cmd;
                  if (remoteOS === 'windows') {
                    cmd = `powershell -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p1 = './.kosmos-panel/kosmos-panel.md'; $p2 = Join-Path $env:USERPROFILE '.config/kosmos-panel/kosmos-panel.md'; if (Test-Path $p1) { Get-Content $p1 -Raw -Encoding UTF8 } elseif (Test-Path $p2) { Get-Content $p2 -Raw -Encoding UTF8 }"`;
                  } else {
                    cmd = `cat ./.kosmos-panel/kosmos-panel.md 2>/dev/null || cat ~/.config/kosmos-panel/kosmos-panel.md 2>/dev/null`;
                  }
                  let content = '';
                  sshConn.exec(cmd, (err, execStream) => {
                    if (err) { clearTimeout(commandTimeout); return resolve(''); }
                    execStream.on('data', (data) => { content += data.toString(); });
                    execStream.on('close', () => { clearTimeout(commandTimeout); resolve(content.trim() || ''); });
                  });
                });

                const remoteKnowledge = await getRemoteKnowledge(conn);

                // Формируем системный промпт
                let fullSystemPrompt = skillSystemPrompt;
                if (remoteKnowledge.trim()) {
                  fullSystemPrompt += `\n\n--- System Context ---\n${remoteKnowledge.trim()}`;
                }
                fullSystemPrompt += `\n\n--- Active Skill: ${skill.name} ---\n${skill.content}`;

                // Формируем первый user prompt
                let firstUserPrompt = userPrompt || `Execute skill: ${skillName}`;
                if (Object.keys(skillParams).length > 0) {
                  firstUserPrompt += `\n\nParameters:\n${Object.entries(skillParams).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
                }
                firstUserPrompt += `\n\n[Step 1 of 10]`;

                // Инициализируем activeSkill
                activeSkill = {
                  name: skillName,
                  description: skill.description,
                  aiServerUrl,
                  aiModel,
                  messages: [
                    { role: 'system', content: fullSystemPrompt },
                    { role: 'user', content: firstUserPrompt }
                  ],
                  step: 1,
                  maxSteps: 10,
                  waitingForOutput: false,
                  waitingForUser: false
                };

                // Логируем
                const aiQueryId = uuidv4();
                appendToLog({
                  id: aiQueryId,
                  sessionId,
                  timestamp: new Date().toISOString(),
                  type: 'skill_invoke',
                  skill_name: skillName,
                  skill_params: skillParams,
                  user_prompt: firstUserPrompt,
                  ...serverInfo
                });
                currentAiQueryId = aiQueryId;

                // Уведомление в терминал
                ws.send(JSON.stringify({ 
                  type: 'data', 
                  data: `\r\n\x1b[1;36m[Skill: ${skillName}]\x1b[0m ${skill.description || ''}\r\n` 
                }));
                ws.send(JSON.stringify({ type: 'skill_step', step: 1, max: 10 }));

                // Функция обработки ответа AI
                const processSkillResponse = async (aiContent) => {
                  if (!activeSkill) return;

                  const content = aiContent.trim();
                  
                  // Парсим формат ответа
                  const cmdMatch = content.match(/^\[CMD\]\s*(.+)$/im);
                  const msgMatch = content.match(/^\[MESSAGE\]\s*(.+)$/ims);
                  const doneMatch = content.match(/^\[DONE\]\s*(.*)$/ims);

                  if (cmdMatch) {
                    // [CMD] - выполнить команду
                    let command = cmdMatch[1].trim();
                    command = command.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
                    
                    activeSkill.messages.push({ role: 'assistant', content: content });
                    activeSkill.waitingForOutput = true;
                    
                    ws.send(JSON.stringify({ type: 'data', data: `\x1b[90m$ ${command}\x1b[0m\r\n` }));
                    stream.write(command + '\r');

                    const stdinId = uuidv4();
                    appendToLog({
                      id: stdinId,
                      sessionId,
                      timestamp: new Date().toISOString(),
                      type: 'stdin',
                      executed_command: command,
                      skill_name: activeSkill.name,
                      skill_step: activeSkill.step,
                      ...serverInfo
                    });
                    currentStdinId = stdinId;

                  } else if (msgMatch) {
                    // [MESSAGE] - показать сообщение и ждать ввода
                    const message = msgMatch[1].trim();
                    
                    activeSkill.messages.push({ role: 'assistant', content: content });
                    activeSkill.waitingForUser = true;
                    
                    ws.send(JSON.stringify({ type: 'skill_message', text: message }));
                    ws.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[1;33m[Skill вопрос]\x1b[0m ${message}\r\n` }));

                  } else if (doneMatch) {
                    // [DONE] - skill завершён
                    const finalMessage = doneMatch[1].trim() || 'Skill completed';
                    
                    ws.send(JSON.stringify({ type: 'skill_complete', text: finalMessage }));
                    ws.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[1;32m[Skill завершён]\x1b[0m ${finalMessage}\r\n` }));
                    
                    activeSkill = null;

                  } else {
                    // Неизвестный формат - пробуем выполнить как команду
                    logger.warn('skills', 'Unknown response format, treating as command', { content: content.substring(0, 100) });
                    
                    let command = content.split('\n')[0].trim();
                    command = command.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
                    
                    if (command) {
                      activeSkill.messages.push({ role: 'assistant', content: `[CMD] ${command}` });
                      activeSkill.waitingForOutput = true;
                      
                      ws.send(JSON.stringify({ type: 'data', data: `\x1b[90m$ ${command}\x1b[0m\r\n` }));
                      stream.write(command + '\r');
                    } else {
                      throw new Error('Empty or invalid AI response');
                    }
                  }
                };

                // Сохраняем функцию в activeSkill для использования в других местах
                activeSkill.processResponse = processSkillResponse;
                activeSkill.sendNextRequest = async (userContent) => {
                  if (!activeSkill) return;
                  
                  activeSkill.step++;
                  if (activeSkill.step > activeSkill.maxSteps) {
                    ws.send(JSON.stringify({ type: 'skill_complete', text: 'Maximum steps reached' }));
                    ws.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[1;33m[Skill]\x1b[0m Достигнут лимит шагов (${activeSkill.maxSteps})\r\n` }));
                    activeSkill = null;
                    return;
                  }

                  activeSkill.messages.push({ role: 'user', content: userContent + `\n\n[Step ${activeSkill.step} of ${activeSkill.maxSteps}]` });
                  ws.send(JSON.stringify({ type: 'skill_step', step: activeSkill.step, max: activeSkill.maxSteps }));

                  try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 30000);

                    const aiResponse = await fetch(activeSkill.aiServerUrl, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        model: activeSkill.aiModel,
                        messages: activeSkill.messages,
                        temperature: 0.3,
                        max_tokens: 512
                      }),
                      signal: controller.signal
                    });

                    clearTimeout(timeoutId);
                    const aiResult = await aiResponse.json();
                    const aiContent = aiResult.choices?.[0]?.message?.content;

                    if (aiContent) {
                      await activeSkill.processResponse(aiContent);
                    } else {
                      throw new Error(aiResult.error?.message || 'Invalid AI response');
                    }
                  } catch (e) {
                    logger.error('skills', 'Skill step error', { step: activeSkill.step, error: e.message });
                    ws.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[1;31m[Skill Error] ${e.message}\x1b[0m\r\n` }));
                    activeSkill = null;
                  }
                };

                // Первый запрос к AI
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);

                const aiResponse = await fetch(aiServerUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    model: aiModel,
                    messages: activeSkill.messages,
                    temperature: 0.3,
                    max_tokens: 512
                  }),
                  signal: controller.signal
                });

                clearTimeout(timeoutId);
                const aiResult = await aiResponse.json();
                const aiContent = aiResult.choices?.[0]?.message?.content;

                if (aiContent) {
                  await processSkillResponse(aiContent);
                } else {
                  throw new Error(aiResult.error?.message || 'Invalid AI response');
                }

              } catch (e) {
                logger.error('skills', 'Skill invoke error', { skillName, error: e.message });
                ws.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[1;31m[Skill Error] ${e.message}\x1b[0m\r\n` }));
                activeSkill = null;
              }
            } else if (type === 'skill_user_input' && activeSkill && activeSkill.waitingForUser) {
              // ========== User input for skill ==========
              const userInput = obj.text || '';
              activeSkill.waitingForUser = false;
              
              ws.send(JSON.stringify({ type: 'data', data: `\x1b[90m> ${userInput}\x1b[0m\r\n` }));
              
              await activeSkill.sendNextRequest(`User response: ${userInput}`);

            } else if (type === 'skill_cancel') {
              // ========== Cancel active skill ==========
              if (activeSkill) {
                ws.send(JSON.stringify({ type: 'data', data: `\r\n\x1b[1;33m[Skill отменён]\x1b[0m\r\n` }));
                ws.send(JSON.stringify({ type: 'skill_complete', text: 'Cancelled by user' }));
                activeSkill = null;
              }

            } else if (type === 'ai_query' && prompt) {
              // Очищаем текущую строку в shell (удаляем команду ai:...)
              // Старый метод: stream.write('\x15'); // CTRL+U, не работает на Windows
              // Новый, универсальный метод:
              stream.write('\b'.repeat(prompt.length));

              const aiPrompt = prompt.substring(prompt.indexOf('ai:') + 3).trim();
              const aiQueryId = uuidv4();

              appendToLog({
                id: aiQueryId,
                sessionId,
                timestamp: new Date().toISOString(),
                type: 'ai_query',
                user_ai_query: aiPrompt,
                ...serverInfo
              });

              // Сохраняем ID для связи с будущей stdin записью
              currentAiQueryId = aiQueryId;

              // OpenAI-совместимый API
              try {
                const aiBaseUrl = process.env.AI_KOSMOS_MODEL_BASE_URL || 'http://localhost:3002/v1';
                const aiServerUrl = `${aiBaseUrl}/chat/completions`;
                const aiModel = process.env.AI_MODEL || 'CHEAP';
                const baseSystemPrompt = process.env.AI_SYSTEM_PROMPT || 'You are a Linux terminal AI assistant. Your task is to convert the user\'s request into a valid shell command, and return ONLY the shell command itself without any explanation.';

                // --- START: Получение знаний ---
                // Приоритет: 1) ./.kosmos-panel/kosmos-panel.md  2) ~/.config/kosmos-panel/kosmos-panel.md
                const getRemoteKnowledge = (sshConn) => new Promise((resolve) => {
                  let commandTimeout;
                  let cmd;
                  
                  if (remoteOS === 'windows') {
                    cmd = `powershell -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p1 = './.kosmos-panel/kosmos-panel.md'; $p2 = Join-Path $env:USERPROFILE '.config/kosmos-panel/kosmos-panel.md'; if (Test-Path $p1) { Get-Content $p1 -Raw -Encoding UTF8 } elseif (Test-Path $p2) { Get-Content $p2 -Raw -Encoding UTF8 }"`;
                  } else {
                    const primaryPath = './.kosmos-panel/kosmos-panel.md';
                    const fallbackPath = '~/.config/kosmos-panel/kosmos-panel.md';
                    cmd = `cat ${primaryPath} 2>/dev/null || cat ${fallbackPath} 2>/dev/null`;
                  }
                  
                  logger.debug('ai', 'Attempting to read remote knowledge', { remoteOS });

                  commandTimeout = setTimeout(() => {
                    logger.warn('ai', 'Remote knowledge command timed out');
                    resolve('');
                  }, 5000); // 5 секунд таймаут

                  let content = '';
                  sshConn.exec(cmd, (err, stream) => {
                    if (err) {
                      clearTimeout(commandTimeout);
                      logger.error('ai', 'Error executing remote knowledge command', { error: err.message });
                      return resolve('');
                    }
                    stream.on('data', (data) => { content += data.toString(); });
                    stream.on('close', (code) => {
                      clearTimeout(commandTimeout);
                      if (content.trim()) {
                        logger.info('ai', 'Successfully read remote knowledge', { bytes: content.length });
                        resolve(content);
                      } else {
                        logger.debug('ai', 'Remote knowledge files not found or empty');
                        resolve('');
                      }
                    });
                  });
                });

                const remoteKnowledge = await getRemoteKnowledge(conn);

                let aiSystemPrompt = baseSystemPrompt;
                if (remoteKnowledge.trim()) {
                  aiSystemPrompt = `System context:\n${remoteKnowledge.trim()}\n\n---\n\n${aiSystemPrompt}`;
                }

                // --- END: Получение знаний ---

                logger.info('ai', `Preparing to send request`, { url: aiServerUrl });

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 секунд

                try {
                  // OpenAI-совместимый формат запроса
                  const messages = [
                    { role: 'system', content: aiSystemPrompt },
                    { role: 'user', content: aiPrompt }
                  ];

                  const aiResponse = await fetch(aiServerUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      model: aiModel,
                      messages,
                      temperature: 0.3,
                      max_tokens: 512
                    }),
                    signal: controller.signal
                  });

                  clearTimeout(timeoutId);

                  logger.info('ai', 'Request sent', { prompt: aiPrompt, status: aiResponse.status });
                  const aiResult = await aiResponse.json();
                  logger.info('ai', 'Response received', { result: aiResult });

                  // OpenAI-совместимый формат ответа
                  const aiContent = aiResult.choices?.[0]?.message?.content;
                  if (aiContent) {
                    let commandToExecute = aiContent.trim();

                    // Если AI вернул многострочный ответ, берем только первую строку
                    const lines = commandToExecute.split('\n');
                    if (lines.length > 1) {
                      commandToExecute = lines[0].trim();
                    }

                    // Удаляем markdown кавычки, если есть
                    commandToExecute = commandToExecute.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();

                    stream.write(commandToExecute + '\r');

                    // Создаем связанную stdin запись
                    const stdinId = uuidv4();
                    appendToLog({
                      id: stdinId,
                      sessionId,
                      timestamp: new Date().toISOString(),
                      type: 'stdin',
                      executed_command: commandToExecute,
                      user_ai_query: aiPrompt,
                      ai_query_id: currentAiQueryId,
                      ...serverInfo
                    });

                    // Сохраняем для связи с будущим stdout
                    currentStdinId = stdinId;
                    currentAiQueryId = null; // Сбрасываем после использования
                  } else {
                    // OpenAI-совместимый формат ошибки
                    const errorMsg = aiResult.error?.message || aiResult.error || 'Invalid response from AI API';
                    throw new Error(errorMsg);
                  }
                } catch (e) {
                  clearTimeout(timeoutId);
                  logger.error('ai', 'AI request error', { error: e.message, name: e.name });
                  const errorMsg = `\r\n\x1b[1;31m[AI Error] ${e.name === 'AbortError' ? 'Request timed out' : e.message}\x1b[0m\r\n`;
                  ws.send(JSON.stringify({ type: 'data', data: errorMsg }));
                  stream.write('\r');
                }
              } catch (e) {
                logger.error('ws', 'Error in ws.on(message)', { error: e.message });
              }
            }
          } catch (e) {
            logger.error('ws', 'Error in ws.on(message)', { error: e.message });
          }
        });

        stream.on('data', (d) => {
          const data = d.toString('utf8');
          ws.send(JSON.stringify({ type: 'data', data }));
          stdoutBuffer += data;
          checkForPromptAndFlush(); // Проверяем, завершилась ли команда
        });
        stream.stderr.on('data', (d) => {
          const data = d.toString('utf8');
          ws.send(JSON.stringify({ type: 'err', data }));
          stderrBuffer += data;

          // Для stderr используем простой таймер, так как ошибки не содержат промптов
          setTimeout(() => {
            const cleanStderr = stripAnsi(stderrBuffer).trim();
            if (cleanStderr) {
              appendToLog({
                id: uuidv4(),
                sessionId,
                timestamp: new Date().toISOString(),
                type: 'stderr',
                terminal_output: cleanStderr,
                ...serverInfo
              });
            }
            stderrBuffer = '';
          }, 500);
        });
        stream.on('close', (code, signal) => {
          logger.info('ssh', 'SSH stream closed', { 
            sessionId, 
            serverId,
            code: code !== undefined ? code : 'none',
            signal: signal || 'none'
          });
          
          // Принудительно сохраняем оставшийся вывод при закрытии
          if (stdoutBuffer.trim()) {
            const cleanOutput = stripAnsi(stdoutBuffer).trim();
            if (cleanOutput) {
              appendToLog({
                id: uuidv4(),
                sessionId,
                timestamp: new Date().toISOString(),
                type: 'stdout',
                terminal_output: cleanOutput,
                ...serverInfo
              });
            }
          }

          if (stderrBuffer.trim()) {
            const cleanStderr = stripAnsi(stderrBuffer).trim();
            if (cleanStderr) {
              appendToLog({
                id: uuidv4(),
                sessionId,
                timestamp: new Date().toISOString(),
                type: 'stderr',
                terminal_output: cleanStderr,
                ...serverInfo
              });
            }
          }

          try { ws.close(); } catch { };
          conn.end();
        });
        
        stream.on('error', (err) => {
          logger.error('ssh', 'SSH stream error', { sessionId, serverId, error: err.message });
        });
        ws.on('close', () => {
          // Аналогично для закрытия WebSocket
          if (stdoutBuffer.trim()) {
            const cleanOutput = stripAnsi(stdoutBuffer).trim();
            if (cleanOutput) {
              appendToLog({
                id: uuidv4(),
                sessionId,
                timestamp: new Date().toISOString(),
                type: 'stdout',
                terminal_output: cleanOutput,
                ...serverInfo
              });
            }
          }

          if (stderrBuffer.trim()) {
            const cleanStderr = stripAnsi(stderrBuffer).trim();
            if (cleanStderr) {
              appendToLog({
                id: uuidv4(),
                sessionId,
                timestamp: new Date().toISOString(),
                type: 'stderr',
                terminal_output: cleanStderr,
                ...serverInfo
              });
            }
          }

          // Удаляем сессию из REST bridge
          if (wsSessions[sessionId]) {
            logger.info('ws', 'Session removed from REST bridge', { sessionId });
            delete wsSessions[sessionId];
          }

          try { stream.end(); } catch { };
          try { conn.end(); } catch { };
        });
      });
    })
    .on('error', (e) => {
      logger.error('ssh', 'Terminal SSH error', { error: e.message });
      try { ws.send(JSON.stringify({ type: 'fatal', error: e.message })); } catch { }
      setTimeout(() => { try { ws.close(1011, e.message); } catch { } }, 10);
    })
    .on('end', () => {
      logger.info('ssh', 'Terminal SSH connection ended', { serverId });
    })
    .on('close', () => {
      logger.info('ssh', 'Terminal SSH connection closed', { serverId });
    })
    .connect((() => {
      const base = { 
        host: server.ssh.host, 
        port: Number(server.ssh.port) || 22, 
        username: server.ssh.user,
        keepaliveInterval: 10000,  // Пинг каждые 10 сек для предотвращения разрыва
        keepaliveCountMax: 3,      // 3 пропущенных пинга = disconnect
        readyTimeout: 30000        // Таймаут на handshake 30 сек
      };
      const auth = { ...base };
      const agentSock = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      if (useAgent) auth.agent = agentSock;
      if (key) auth.privateKey = key;
      if (passphrase) auth.passphrase = passphrase;
      if (password) auth.password = password;
      return auth;
    })());
}

function handleTail(ws, url) {
  // query: serverId, path, lines
  const serverId = url.searchParams.get('serverId');
  const logPath = url.searchParams.get('path');
  const lines = Number(url.searchParams.get('lines') || 200);
  const server = findServer(serverId);
  if (!server || !logPath) return ws.close(1008, 'bad params');

  let key, passphrase, password, useAgent;
  try {
    const r = resolvePrivateKey(server.ssh.credentialId);
    key = r.key; passphrase = r.passphrase; password = r.password; useAgent = r.useAgent;
  } catch (e) {
    try { ws.send(JSON.stringify({ type: 'fatal', error: 'credential error: ' + e.message })); } catch { }
    return setTimeout(() => { try { ws.close(1011, 'credential error'); } catch { } }, 10);
  }
  const sessionId = uuidv4();

  const conn = new Client();
  logger.info('ws', 'Tail connecting', { serverId, path: logPath });
  conn
    .on('ready', () => {
      const cmd = `test -f ${logPath} && tail -n ${lines} -F ${logPath} || echo 'File not found: ${logPath}'`;
      conn.exec(cmd, { pty: false }, (err, stream) => {
        if (err) {
          try { ws.send(JSON.stringify({ type: 'fatal', error: 'tail error: ' + err.message })); } catch { }
          setTimeout(() => { try { ws.close(1011, 'tail error'); } catch { }; conn.end(); }, 10);
          return;
        }
        stream.on('data', (d) => {
          const data = d.toString('utf8');
          ws.send(JSON.stringify({ type: 'data', data }));
          appendToLog({
            id: uuidv4(),
            sessionId,
            timestamp: new Date().toISOString(),
            type: 'stdout',
            terminal_output: data
          });
        });
        stream.stderr.on('data', (d) => {
          const data = d.toString('utf8');
          ws.send(JSON.stringify({ type: 'err', data }));
          appendToLog({
            id: uuidv4(),
            sessionId,
            timestamp: new Date().toISOString(),
            type: 'stderr',
            terminal_output: data
          });
        });
        stream.on('close', () => { try { ws.close(); } catch { }; conn.end(); });
        ws.on('close', () => { try { stream.end(); } catch { }; try { conn.end(); } catch { }; });
      });
    })
    .on('error', (e) => {
      logger.error('ssh', 'Tail SSH error', { error: e.message });
      try { ws.send(JSON.stringify({ type: 'fatal', error: e.message })); } catch { }
      setTimeout(() => { try { ws.close(1011, e.message); } catch { } }, 10);
    })
    .on('end', () => {
      logger.info('ssh', 'Tail SSH connection ended', { serverId });
    })
    .on('close', () => {
      logger.info('ssh', 'Tail SSH connection closed', { serverId });
    })
    .connect((() => {
      const base = { 
        host: server.ssh.host, 
        port: Number(server.ssh.port) || 22, 
        username: server.ssh.user,
        keepaliveInterval: 10000,  // Пинг каждые 10 сек для предотвращения разрыва
        keepaliveCountMax: 3,      // 3 пропущенных пинга = disconnect
        readyTimeout: 30000        // Таймаут на handshake 30 сек
      };
      const auth = { ...base };
      const agentSock = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      if (useAgent) auth.agent = agentSock;
      if (key) auth.privateKey = key;
      if (passphrase) auth.passphrase = passphrase;
      if (password) auth.password = password;
      return auth;
    })());
}

module.exports = { attachWsServer, wsSessions, pendingCommands };


