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

        // Сохраняем сессию для REST API bridge
        wsSessions[sessionId] = {
          ws,
          stream,
          serverId,
          serverName: server.name || serverId,
          connectedAt: new Date().toISOString()
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
                logger.debug('terminal', 'Записан stdout', { stdin_id: currentStdinId });
              } else if (cleanOutput.includes('ai:')) {
                logger.debug('terminal', 'Отфильтровано эхо ai: команды', { output: cleanOutput });
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
                  const primaryPath = './.kosmos-panel/kosmos-panel.md';
                  const fallbackPath = '~/.config/kosmos-panel/kosmos-panel.md';
                  
                  // Команда: попытаться прочитать primary, если не найден — fallback
                  const cmd = `cat ${primaryPath} 2>/dev/null || cat ${fallbackPath} 2>/dev/null`;
                  
                  logger.debug('ai', 'Attempting to read remote knowledge', { primaryPath, fallbackPath });

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


