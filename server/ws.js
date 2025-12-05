const WebSocket = require('ws');
const { Client } = require('ssh2');
const { inventory } = require('./monitor');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { findServer, resolvePrivateKey } = require('./ws-utils');

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
          console.error('Error reading log file for appending:', readErr);
        }
      }
      logs.push(logEntry);
      await fs.writeFile(LOG_FILE_PATH, JSON.stringify(logs, null, 2));
    } catch (writeErr) {
      console.error('Error writing to log file:', writeErr);
    }
  }).catch(err => {
    // Prevent unhandled promise rejection
    console.error('Error in log queue:', err);
  });
}

function stripAnsi(str) {
  // This regex removes ANSI escape codes used for colors, cursor movement, etc.
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}


function attachWsServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', (ws, req) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/ws/terminal') return handleTerminal(ws, url);
      if (url.pathname === '/ws/tail') return handleTail(ws, url);
      ws.close(1008, 'unknown path');
    } catch (e) {
      try { ws.close(1008, 'bad request'); } catch {}
    }
  });
}

function handleTerminal(ws, url) {
  // query: serverId, cols, rows
  const serverId = url.searchParams.get('serverId');
  const cols = Number(url.searchParams.get('cols') || 120);
  const rows = Number(url.searchParams.get('rows') || 30);
  const server = findServer(serverId);
  if (!server) return ws.close(1008, 'server not found');

  let key, passphrase, password, useAgent;
  try {
    const r = resolvePrivateKey(server.ssh.credentialId);
    key = r.key; passphrase = r.passphrase; password = r.password; useAgent = r.useAgent;
  } catch (e) {
    try { ws.send(JSON.stringify({ type: 'fatal', error: 'credential error: ' + e.message })); } catch {}
    return setTimeout(() => { try { ws.close(1011, 'credential error'); } catch {} }, 10);
  }
  const sessionId = uuidv4();

  const conn = new Client();
  console.log(`[ws] terminal: connecting to ${server.ssh.user}@${server.ssh.host}`);
  conn
    .on('ready', () => {
      conn.shell({ term: 'xterm-color', cols, rows }, (err, stream) => {
        if (err) {
          try { ws.send(JSON.stringify({ type: 'fatal', error: 'shell error: ' + err.message })); } catch {}
          setTimeout(() => { try { ws.close(1011, 'shell error'); } catch {}; conn.end(); }, 10);
          return;
        }

        // Сохраняем сессию для REST API bridge
        wsSessions[sessionId] = {
          ws,
          stream,
          serverId,
          serverName: server.name || serverId,
          connectedAt: new Date().toISOString()
        };
        console.log(`[ws] Session ${sessionId} registered for REST bridge`);

        // Отправляем sessionId клиенту
        try {
          ws.send(JSON.stringify({ type: 'session', sessionId }));
        } catch (e) {
          console.error('[ws] Failed to send sessionId to client:', e.message);
        }

        let stdoutBuffer = '';
        let stderrBuffer = '';
        
        // Переменные для связывания записей
        let currentAiQueryId = null;
        let currentStdinId = null;
        
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
            console.log('[DEBUG] Обнаружен промпт, сохраняем вывод команды в лог');
            
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
            if (commandOutput.trim()) {
              const cleanOutput = stripAnsi(commandOutput).trim();
              
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
                console.log('[DEBUG] Записан stdout с stdin_id:', currentStdinId);
              } else if (cleanOutput.includes('ai:')) {
                console.log('[DEBUG] Отфильтровано эхо ai: команды:', cleanOutput);
              }
            }
            
            // Сбрасываем ID после записи stdout
            currentStdinId = null;
            
            // Очищаем буфер
            stdoutBuffer = '';
          }
        };

        ws.on('message', async (msg) => {
          try {
            const obj = JSON.parse(msg.toString());
            const { type, data, prompt, command } = obj;

            if (type === 'data') {
              stream.write(data);
            } else if (type === 'resize' && obj.cols && obj.rows) {
              stream.setWindow(obj.rows, obj.cols, 600, 800);
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
                console.log(`[ws] Received command_result for ${obj.commandId}: status=${obj.status}`);
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
                console.warn(`[ws] command_result for unknown commandId: ${obj.commandId}`);
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

              try {
                const aiServerUrl = process.env.AI_SERVER_URL || 'http://localhost:3002/api/send-request';
                const aiModel = process.env.AI_MODEL || 'moonshotai/kimi-dev-72b:free';
                const aiProvider = process.env.AI_PROVIDER || 'openroute';
                const baseSystemPrompt = process.env.AI_SYSTEM_PROMPT || 'You are a Linux terminal AI assistant. Your task is to convert the user\'s request into a valid shell command, and return ONLY the shell command itself without any explanation.';

                // --- START: Получение знаний ---

                // 1. С удаленной машины по SSH
                const getRemoteKnowledge = (sshConn) => new Promise((resolve) => {
                  let content = '';
                  let commandTimeout;
                  console.log('[AI Knowledge] Attempting to read remote knowledge file: ~/.kosmos/README_kosmos.md');

                  commandTimeout = setTimeout(() => {
                    console.error('[AI Knowledge] Remote command timed out.');
                    resolve('');
                  }, 5000); // 5 секунд таймаут

                  sshConn.exec('cat ~/.kosmos/README_kosmos.md', (err, stream) => {
                    if (err) {
                      clearTimeout(commandTimeout);
                      console.error('[AI Knowledge] Error executing remote command:', err.message);
                      return resolve(''); // Ошибка создания канала, вернем пустоту
                    }
                    stream.on('data', (data) => { content += data.toString(); });
                    stream.stderr.on('data', (data) => {
                      console.error('[AI Knowledge] Remote command stderr:', data.toString().trim());
                    });
                    stream.on('close', (code) => {
                      clearTimeout(commandTimeout);
                      if (code === 0 && content) {
                        console.log(`[AI Knowledge] Successfully read remote knowledge (${content.length} bytes).`);
                        resolve(content);
                      } else {
                        console.log('[AI Knowledge] Remote knowledge file not found, empty, or command failed.');
                        resolve('');
                      }
                    });
                  });
                });

                // 2. С локального сервера панели
                const getLocalKnowledge = async () => {
                  const knowledgePath = path.join(process.cwd(), '.kosmos', 'README_kosmos_server.md');
                  console.log(`[AI Knowledge] Attempting to read local knowledge file: ${knowledgePath}`);
                  try {
                    const content = await fs.readFile(knowledgePath, 'utf8');
                    console.log(`[AI Knowledge] Successfully read local knowledge (${content.length} bytes).`);
                    return content;
                  } catch (e) {
                    console.log('[AI Knowledge] Local knowledge file not found or could not be read.');
                    return '';
                  } // Файл может не существовать
                };

                const [remoteKnowledge, localKnowledge] = await Promise.all([
                  getRemoteKnowledge(conn),
                  getLocalKnowledge()
                ]);

                let aiSystemPrompt = baseSystemPrompt;
                if (remoteKnowledge.trim()) {
                  aiSystemPrompt = `Context from remote system:\n${remoteKnowledge.trim()}\n\n---\n\n${aiSystemPrompt}`;
                }
                if (localKnowledge.trim()) {
                  aiSystemPrompt = `Context from panel server:\n${localKnowledge.trim()}\n\n---\n\n${aiSystemPrompt}`;
                }
                
                // --- END: Получение знаний ---
                
                console.log(`[AI] Preparing to send request to: ${aiServerUrl}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 секунд

                try {
                  const aiResponse = await fetch(aiServerUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      model: aiModel,
                      prompt: aiSystemPrompt,
                      inputText: aiPrompt,
                      provider: aiProvider
                    }),
                    signal: controller.signal
                  });

                  clearTimeout(timeoutId);

                  console.log(`[AI] Request sent for prompt: "${aiPrompt}". Status: ${aiResponse.status}`);
                  const aiResult = await aiResponse.json();
                  console.log('[AI] Response received:', JSON.stringify(aiResult, null, 2));

                  if (aiResult.success && aiResult.content) {
                    let commandToExecute = aiResult.content.trim();
                    
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
                    throw new Error(aiResult.error || 'Invalid response from AI API');
                  }
                } catch (e) {
                  clearTimeout(timeoutId);
                  console.error('[AI Error]', e);
                  const errorMsg = `\r\n\x1b[1;31m[AI Error] ${e.name === 'AbortError' ? 'Request timed out' : e.message}\x1b[0m\r\n`;
                  ws.send(JSON.stringify({ type: 'data', data: errorMsg }));
                  stream.write('\r');
                }
              } catch (e) {
                console.error('[ERROR] in ws.on(message):', e);
              }
            }
          } catch (e) {
            console.error('[ERROR] in ws.on(message):', e);
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
        stream.on('close', () => { 
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
          
          try { ws.close(); } catch {}; 
          conn.end(); 
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
            console.log(`[ws] Session ${sessionId} removed from REST bridge`);
            delete wsSessions[sessionId];
          }
          
          try { stream.end(); } catch {}; 
          try { conn.end(); } catch {}; 
        });
      });
    })
    .on('error', (e) => {
      console.error('[ws] terminal ssh error:', e.message);
      try { ws.send(JSON.stringify({ type: 'fatal', error: e.message })); } catch {}
      setTimeout(() => { try { ws.close(1011, e.message); } catch {} }, 10);
    })
    .connect((() => {
      const base = { host: server.ssh.host, port: Number(server.ssh.port) || 22, username: server.ssh.user };
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
    try { ws.send(JSON.stringify({ type: 'fatal', error: 'credential error: ' + e.message })); } catch {}
    return setTimeout(() => { try { ws.close(1011, 'credential error'); } catch {} }, 10);
  }
  const sessionId = uuidv4();

  const conn = new Client();
  console.log(`[ws] tail connect: serverId=${serverId} path=${logPath}`);
  conn
    .on('ready', () => {
      const cmd = `test -f ${logPath} && tail -n ${lines} -F ${logPath} || echo 'File not found: ${logPath}'`;
      conn.exec(cmd, { pty: false }, (err, stream) => {
        if (err) {
          try { ws.send(JSON.stringify({ type: 'fatal', error: 'tail error: ' + err.message })); } catch {}
          setTimeout(() => { try { ws.close(1011, 'tail error'); } catch {}; conn.end(); }, 10);
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
        stream.on('close', () => { try { ws.close(); } catch {}; conn.end(); });
        ws.on('close', () => { try { stream.end(); } catch {}; try { conn.end(); } catch {}; });
      });
    })
    .on('error', (e) => {
      console.error('[ws] tail ssh error:', e.message);
      try { ws.send(JSON.stringify({ type: 'fatal', error: e.message })); } catch {}
      setTimeout(() => { try { ws.close(1011, e.message); } catch {} }, 10);
    })
    .connect((() => {
      const base = { host: server.ssh.host, port: Number(server.ssh.port) || 22, username: server.ssh.user };
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


