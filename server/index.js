require('dotenv').config({ path: './.env' });

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const { startScheduler, getSnapshot, inventory, reloadInventory, sshExec } = require('./monitor');
const { attachWsServer } = require('./ws');
const { createSession, executeCommand, closeSession, createSessionV2, executeCommandV2, closeSessionV2 } = require('./terminal');

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
        console.warn('Не удалось создать резервную копию:', e.message);
      }
    }
    
    // Сохраняем новый файл
    const jsonContent = JSON.stringify(data, null, 2);
    await fs.writeFile(inventoryPath, jsonContent, 'utf8');
    
    res.json({ ok: true, message: 'Файл inventory.json успешно сохранен' });
    
  } catch (e) {
    console.error('Ошибка сохранения inventory.json:', e);
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
  try {
    const data = await fs.readFile(logFilePath, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.json([]); // Файл не найден, это нормально. Отдаем пустой массив.
    }
    console.error('Error reading or parsing log file:', err);
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
          console.warn(`Файл документации не найден: ${file}`);
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
      console.warn('Ошибка чтения документации:', e.message);
    }
    
    // Формируем системный промпт
    const baseSystemPrompt = process.env.AI_SYSTEM_PROMPT_HELP || `
Ты - AI помощник для системы мониторинга Kosmos Panel. 
Отвечай на русском языке, кратко и по делу.
Используй предоставленную документацию для ответов.
Если вопрос не относится к системе, вежливо объясни это.
`;

    const systemPrompt = `${baseSystemPrompt}\n\nДокументация системы:\n${contextDocs}`;
    
    // Отправляем запрос на AI сервер
    const aiServerUrl = process.env.AI_SERVER_URL_HELP || process.env.AI_SERVER_URL || 'http://localhost:3002/api/send-request';
    const aiModel = process.env.AI_MODEL_HELP || process.env.AI_MODEL || 'moonshotai/kimi-dev-72b:free';
    const aiProvider = process.env.AI_PROVIDER_HELP || process.env.AI_PROVIDER || 'openroute';
    
    const aiResponse = await fetch(aiServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: aiModel,
        provider: aiProvider,
        prompt: systemPrompt,
        inputText: query
      })
    });
    
    if (!aiResponse.ok) {
      throw new Error(`AI сервер вернул ошибку: ${aiResponse.status}`);
    }
    
    const aiResult = await aiResponse.json();
    
    if (aiResult.success) {
      res.json({ 
        success: true, 
        response: aiResult.content || 'Пустой ответ от AI' 
      });
    } else {
      res.json({ 
        success: false, 
        error: aiResult.error || 'Неизвестная ошибка AI сервера' 
      });
    }
    
  } catch (error) {
    console.error('Ошибка AI Help:', error);
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

app.use('/', express.static(path.join(process.cwd(), 'web')));

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const server = http.createServer(app);
attachWsServer(server);

server.listen(port, () => {
  console.log(`UI: http://localhost:${port}`);
  startScheduler();
});


