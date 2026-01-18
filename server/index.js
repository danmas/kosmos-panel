require('dotenv').config({ path: './.env' });

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const { startScheduler, getSnapshot, inventory, reloadInventory, sshExec } = require('./monitor');
const { attachWsServer, wsSessions, pendingCommands } = require('./ws');
const { v4: uuidv4 } = require('uuid');
const { createSession, executeCommand, closeSession, createSessionV2, executeCommandV2, closeSessionV2 } = require('./terminal');
const logger = require('./logger');

const app = express();
app.use(express.json());

// Terminal API v1 routes
app.post('/api/v1/terminal/sessions', createSession);
app.post('/api/v1/terminal/sessions/:sessionId/exec', executeCommand);
app.delete('/api/v1/terminal/sessions/:sessionId', closeSession);

// Terminal API v2 routes
app.post('/api/v2/terminal/sessions', createSessionV2);
app.post('/api/v2/terminal/sessions/:sessionId/exec', executeCommandV2);
app.delete('/api/v2/terminal/sessions/:sessionId', closeSessionV2);


app.get('/api/servers', (req, res) => {
  const snap = getSnapshot();
  // Сохраняем порядок серверов как в оригинальной конфигурации
  const inventoryServers = inventory.servers || [];
  const list = inventoryServers
    .filter(server => snap.servers[server.id]) // Фильтруем только существующие сервера
    .map(server => {
      const s = snap.servers[server.id];
      return {
        id: s.id,
        name: s.name,
        env: s.env,
        color: s.color,
        ssh: s.ssh,
        services: Object.entries(s.services).map(([id, sv]) => {
          // Находим оригинальный сервис из inventory для получения description
          const originalService = server.services.find(svc => svc.id === id);
          return { 
            id, 
            ...sv, 
            description: originalService?.description || undefined 
          };
        }),
      };
    });
  res.json({ ts: snap.ts, servers: list });
});

app.get('/api/service-log', (req, res) => {
  const { serverId, serviceId } = req.query;
  const snap = getSnapshot();
  
  const server = snap.servers[serverId];
  if (!server) {
    return res.status(404).json({ success: false, error: 'Сервер не найден' });
  }
  
  const service = server.services[serviceId];
  
  if (!service) {
    return res.status(404).json({ success: false, error: 'Сервис не найден' });
  }
  
  res.json({ success: true, log: service.detail || '(пустой лог)' });
});

app.get('/api/inventory', (req, res) => {
  res.json(inventory);
});

app.post('/api/reload', (req, res) => {
  try {
    reloadInventory();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// API для редактора inventory.json
app.get('/inventory.json', async (req, res) => {
  try {
    const inventoryPath = path.join(process.cwd(), 'inventory.json');
    const data = await fs.readFile(inventoryPath, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      res.status(404).json({ error: 'Файл inventory.json не найден' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

app.post('/api/inventory', async (req, res) => {
  try {
    const inventoryPath = path.join(process.cwd(), 'inventory.json');
    
    // Валидация входящих данных
    const data = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Некорректные данные' });
    }
    
    if (!Array.isArray(data.credentials)) {
      return res.status(400).json({ error: 'Поле "credentials" должно быть массивом' });
    }
    
    if (!Array.isArray(data.servers)) {
      return res.status(400).json({ error: 'Поле "servers" должно быть массивом' });
    }
    
    if (!data.poll || typeof data.poll !== 'object') {
      return res.status(400).json({ error: 'Поле "poll" должно быть объектом' });
    }
    
    // Валидация серверов
    for (let i = 0; i < data.servers.length; i++) {
      const server = data.servers[i];
      if (!server.id) {
        return res.status(400).json({ error: `Сервер ${i + 1}: отсутствует поле "id"` });
      }
      if (!server.name) {
        return res.status(400).json({ error: `Сервер ${i + 1}: отсутствует поле "name"` });
      }
      if (!server.ssh || !server.ssh.host || !server.ssh.user) {
        return res.status(400).json({ error: `Сервер ${i + 1}: некорректные настройки SSH` });
      }
      if (!Array.isArray(server.services)) {
        return res.status(400).json({ error: `Сервер ${i + 1}: поле "services" должно быть массивом` });
      }
    }
    
    // Проверка уникальности ID серверов
    const serverIds = data.servers.map(s => s.id);
    const duplicateIds = serverIds.filter((id, index) => serverIds.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      return res.status(400).json({ error: `Дублирующиеся ID серверов: ${duplicateIds.join(', ')}` });
    }
    
    // Валидация учетных данных
    for (let i = 0; i < data.credentials.length; i++) {
      const cred = data.credentials[i];
      if (!cred.id) {
        return res.status(400).json({ error: `Учетные данные ${i + 1}: отсутствует поле "id"` });
      }
      if (!cred.type) {
        return res.status(400).json({ error: `Учетные данные ${i + 1}: отсутствует поле "type"` });
      }
    }
    
    // Проверка уникальности ID учетных данных
    const credIds = data.credentials.map(c => c.id);
    const duplicateCredIds = credIds.filter((id, index) => credIds.indexOf(id) !== index);
    if (duplicateCredIds.length > 0) {
      return res.status(400).json({ error: `Дублирующиеся ID учетных данных: ${duplicateCredIds.join(', ')}` });
    }
    
    // Создаем резервную копию
    const backupPath = `${inventoryPath}.backup.${Date.now()}`;
    try {
      await fs.copyFile(inventoryPath, backupPath);
    } catch (e) {
      // Игнорируем ошибку если исходный файл не существует
      if (e.code !== 'ENOENT') {
        logger.warn('api', 'Не удалось создать резервную копию', { error: e.message });
      }
    }
    
    // Сохраняем новый файл
    const jsonContent = JSON.stringify(data, null, 2);
    await fs.writeFile(inventoryPath, jsonContent, 'utf8');
    
    res.json({ ok: true, message: 'Файл inventory.json успешно сохранен' });
    
  } catch (e) {
    logger.error('api', 'Ошибка сохранения inventory.json', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/test-ssh', async (req, res) => {
  try {
    const serverId = String(req.query.serverId || '');
    const server = (inventory.servers || []).find((s) => s.id === serverId);
    if (!server) return res.status(404).json({ ok: false, error: 'server not found' });
    
    // Добавляем отладочную информацию
    // getCredential не экспортируется, поэтому ловим только ошибки
    const credInfo = {
      envVars: {
        SSH_KEY_PATH: process.env.SSH_KEY_PATH,
        SSH_PASSPHRASE: process.env.SSH_PASSPHRASE,
        SSH_PASSWORD: process.env.SSH_PASSWORD,
        USE_SSH_AGENT: process.env.USE_SSH_AGENT,
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK
      }
    };

    const r = await sshExec({ ssh: server.ssh, command: 'echo __OK__' , timeoutMs: 5000});
    res.json({ ok: true, result: r, debug: { server: server.ssh, credentials: credInfo } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, debug: { 
      server: server?.ssh,
      envVars: {
        SSH_KEY_PATH: process.env.SSH_KEY_PATH,
        SSH_PASSPHRASE: process.env.SSH_PASSPHRASE,
        SSH_PASSWORD: process.env.SSH_PASSWORD,
        USE_SSH_AGENT: process.env.USE_SSH_AGENT,
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK
      }
    }});
  }
});

app.get('/api/logs', async (req, res) => {
  const logFilePath = path.join(__dirname, '..', 'terminal_log.json');
  const sessionId = req.query.sessionId;
  try {
    const data = await fs.readFile(logFilePath, 'utf8');
    let logs = JSON.parse(data);
    
    // Фильтрация по sessionId если указан
    if (sessionId) {
      logs = logs.filter(log => log.sessionId === sessionId);
    }
    
    res.json(logs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.json([]); // Файл не найден, это нормально. Отдаем пустой массив.
    }
    logger.error('api', 'Error reading or parsing log file', { error: err.message });
    res.status(500).json({ error: 'Failed to read or parse log file' });
  }
});


// AI Help endpoint
app.post('/api/ai-help', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ success: false, error: 'Отсутствует запрос' });
    }
    
    // Читаем документацию из KB
    const kbPath = path.join(process.cwd(), 'KB');
    
    let contextDocs = '';
    
    try {
      const contextFiles = process.env.AI_HELP_CONTEXT_FILES 
        ? process.env.AI_HELP_CONTEXT_FILES.split(',')
        : ['README_AI.md', 'README_AUTH.md'];

      for (const file of contextFiles) {
        const filePath = path.join(process.cwd(), file.trim());
        if (await fs.stat(filePath).catch(() => null)) {
          const content = await fs.readFile(filePath, 'utf8');
          contextDocs += `=== ${path.basename(file)} ===\n${content}\n\n`;
        } else {
          logger.warn('ai', `Файл документации не найден: ${file}`);
        }
      }

      // Если AI_HELP_CONTEXT_FILES не задан, по умолчанию добавляем все из KB
      if (!process.env.AI_HELP_CONTEXT_FILES) {
        const kbFiles = await fs.readdir(kbPath);
        for (const file of kbFiles) {
          if (file.endsWith('.md')) {
            const content = await fs.readFile(path.join(kbPath, file), 'utf8');
            contextDocs += `=== KB/${file} ===\n${content}\n\n`;
          }
        }
      }
    } catch (e) {
      logger.warn('ai', 'Ошибка чтения документации', { error: e.message });
    }
    
    // Формируем системный промпт
    const baseSystemPrompt = process.env.AI_SYSTEM_PROMPT_HELP || `
Ты - AI помощник для системы мониторинга Kosmos Panel. 
Отвечай на русском языке, кратко и по делу.
Используй предоставленную документацию для ответов.
Если вопрос не относится к системе, вежливо объясни это.
`;

    const systemPrompt = `${baseSystemPrompt}\n\nДокументация системы:\n${contextDocs}`;
    
    // OpenAI-совместимый API
    const aiBaseUrl = process.env.AI_KOSMOS_MODEL_BASE_URL || 'http://localhost:3002/v1';
    const aiServerUrl = `${aiBaseUrl}/chat/completions`;
    const aiModel = process.env.AI_MODEL || 'CHEAP';
    
    // OpenAI-совместимый формат запроса
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query }
    ];

    const aiResponse = await fetch(aiServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: aiModel,
        messages,
        temperature: 0.7,
        max_tokens: 2048
      })
    });
    
    if (!aiResponse.ok) {
      const errorData = await aiResponse.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `AI сервер вернул ошибку: ${aiResponse.status}`);
    }
    
    const aiResult = await aiResponse.json();
    
    // OpenAI-совместимый формат ответа
    const aiContent = aiResult.choices?.[0]?.message?.content;
    if (aiContent) {
      res.json({ 
        success: true, 
        response: aiContent 
      });
    } else {
      res.json({ 
        success: false, 
        error: aiResult.error?.message || 'Пустой ответ от AI' 
      });
    }
    
  } catch (error) {
    logger.error('ai', 'Ошибка AI Help', { error: error.message });
    res.status(500).json({ 
      success: false, 
      error: `Ошибка обработки запроса: ${error.message}` 
    });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    aiCommandPrefix: process.env.AI_COMMAND_PREFIX || 'ai:',
  });
});

// ========== WS Terminal REST Bridge API ==========

// Список активных WebSocket терминалов
app.get('/api/ws-terminal/sessions', (req, res) => {
  const sessions = Object.entries(wsSessions).map(([sessionId, session]) => ({
    sessionId,
    serverId: session.serverId,
    serverName: session.serverName,
    connectedAt: session.connectedAt
  }));
  res.json({ success: true, data: sessions });
});

// Отправить команду в WebSocket терминал
app.post('/api/ws-terminal/:sessionId/command', (req, res) => {
  const { sessionId } = req.params;
  const { command, requireConfirmation = false, timeout = 60000, wait = false } = req.body;

  if (!command) {
    return res.status(400).json({ success: false, error: 'command is required' });
  }

  const session = wsSessions[sessionId];
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found. Terminal may be closed.' });
  }

  const commandId = uuidv4();
  const cmd = {
    commandId,
    sessionId,
    command,
    requireConfirmation,
    status: requireConfirmation ? 'awaiting_confirmation' : 'pending',
    result: null,
    createdAt: new Date().toISOString(),
    resolve: null,
    reject: null,
    timeoutId: null
  };

  pendingCommands[commandId] = cmd;

  // Отправляем команду в браузерный терминал через WebSocket
  try {
    session.ws.send(JSON.stringify({
      type: 'remote_command',
      commandId,
      command,
      requireConfirmation
    }));
    logger.info('ws-bridge', 'Sent command to session', { commandId, sessionId, command });
  } catch (e) {
    delete pendingCommands[commandId];
    return res.status(500).json({ success: false, error: 'Failed to send command to terminal: ' + e.message });
  }

  if (!wait) {
    // Async режим - сразу возвращаем commandId
    return res.json({ 
      success: true, 
      data: { 
        commandId, 
        status: cmd.status 
      } 
    });
  }

  // Sync режим - ждём результат
  const timeoutMs = Math.min(timeout, 300000); // Максимум 5 минут

  const promise = new Promise((resolve, reject) => {
    cmd.resolve = resolve;
    cmd.reject = reject;

    cmd.timeoutId = setTimeout(() => {
      cmd.status = 'timeout';
      reject(new Error('Command execution timed out'));
    }, timeoutMs);
  });

  promise
    .then((result) => {
      res.json({
        success: true,
        data: {
          commandId: result.commandId,
          status: result.status,
          stdout: result.result?.stdout || '',
          stderr: result.result?.stderr || '',
          exitCode: result.result?.exitCode
        }
      });
    })
    .catch((err) => {
      res.json({
        success: false,
        error: err.message,
        data: {
          commandId,
          status: cmd.status
        }
      });
    })
    .finally(() => {
      // Очищаем команду через 60 секунд после завершения
      setTimeout(() => {
        delete pendingCommands[commandId];
      }, 60000);
    });
});

// Получить статус/результат команды
app.get('/api/ws-terminal/command/:commandId', (req, res) => {
  const { commandId } = req.params;
  const cmd = pendingCommands[commandId];

  if (!cmd) {
    return res.status(404).json({ success: false, error: 'Command not found or expired' });
  }

  res.json({
    success: true,
    data: {
      commandId: cmd.commandId,
      sessionId: cmd.sessionId,
      command: cmd.command,
      status: cmd.status,
      result: cmd.result,
      createdAt: cmd.createdAt
    }
  });
});

// Отменить ожидающую команду
app.delete('/api/ws-terminal/command/:commandId', (req, res) => {
  const { commandId } = req.params;
  const cmd = pendingCommands[commandId];

  if (!cmd) {
    return res.status(404).json({ success: false, error: 'Command not found or expired' });
  }

  // Очищаем таймаут
  if (cmd.timeoutId) {
    clearTimeout(cmd.timeoutId);
  }

  // Отправляем отмену в браузер
  const session = wsSessions[cmd.sessionId];
  if (session) {
    try {
      session.ws.send(JSON.stringify({
        type: 'cancel_command',
        commandId
      }));
    } catch (e) {
      logger.warn('ws-bridge', 'Failed to send cancel to terminal', { error: e.message });
    }
  }

  cmd.status = 'cancelled';
  if (cmd.reject) {
    cmd.reject(new Error('Command cancelled'));
  }

  delete pendingCommands[commandId];
  res.json({ success: true, data: { message: 'Command cancelled' } });
});

// ========== End WS Terminal REST Bridge API ==========

app.use('/', express.static(path.join(process.cwd(), 'web')));

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const server = http.createServer(app);
attachWsServer(server);

server.listen(port, () => {
  logger.info('server', `UI: http://localhost:${port}`);
  startScheduler();
});

// Graceful shutdown для логирования при pm2 restart
function gracefulShutdown(signal) {
  logger.warn('server', `Received ${signal}, shutting down gracefully...`);
  
  // Закрываем все WebSocket сессии
  const sessionCount = Object.keys(wsSessions).length;
  if (sessionCount > 0) {
    logger.info('server', `Closing ${sessionCount} WebSocket sessions`);
    for (const [sessionId, session] of Object.entries(wsSessions)) {
      try {
        session.ws.close(1001, 'Server shutting down');
      } catch (e) {
        logger.error('server', 'Error closing session', { sessionId, error: e.message });
      }
    }
  }
  
  server.close(() => {
    logger.info('server', 'HTTP server closed');
    process.exit(0);
  });
  
  // Force exit after 5 seconds
  setTimeout(() => {
    logger.warn('server', 'Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));


