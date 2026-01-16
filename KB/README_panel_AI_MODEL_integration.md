# Руководство по интеграции AI Model Server

Данная инструкция описывает процесс внедрения взаимодействия с внешним сервером AI-моделей в веб-приложение на Node.js (архитектура: Express + WebSocket + Vanilla JS). 

!ПРОЕКТ ВЫПОЛНЕН НА УСТАРЕВШЕЙ ВЕРСИИ KOSMOS-MODEL 
 
Руководство составлено на основе реализации в проекте **Kosmos Panel**.

---

## 1. Архитектура интеграции

Взаимодействие строится по схеме "Тонкий клиент - AI Сервер". Ваше приложение выступает **клиентом**, который подготавливает контекст и передает запрос на выполнение "умному" внешнему сервису.

### Компоненты:
1.  **AI Server** — внешний HTTP-сервис (например, обертка над OpenAI API, Anthropic или локальная LLM), принимающий промпты и возвращающий текст.
2.  **Backend (Node.js)** — отвечает за:
    *   Хранение секретов (URL, ключи API) в `.env`.
    *   Сбор контекста (RAG): чтение документации, логов, конфигураций.
    *   Отправку запросов к AI Server.
    *   Обработку терминальных сессий (WebSocket) и перехват AI-команд.
3.  **Frontend** — интерфейс ввода команд (терминал, чат), отображение статуса "Думаю..." и результата.

---

## 2. Контракт API (Protocol)

Ваше приложение должно уметь общаться с AI Server по следующему протоколу.

**Метод:** `POST`
**Headers:** `Content-Type: application/json`

### Тело запроса (Request)
```json
{
  "model": "gpt-4-turbo",      // Идентификатор модели (обязательно)
  "prompt": "Ты - Linux эксперт. Твоя задача...", // Системный промпт + Контекст (RAG)
  "inputText": "как проверить место на диске?"   // Запрос пользователя
}
```

### Ответ сервера (Response)
```json
{
  "success": true,
  "content": "df -h",     // Результат генерации (текст, код, команда)
  "error": null           // Описание ошибки, если success: false
}
```

---

## 3. Настройка окружения (Backend)

Добавьте в ваш `.env` файл следующие переменные:

```ini
# URL вашего AI шлюза
AI_SERVER_URL=http://localhost:3002/api/send-request

# Используемая модель (должна поддерживаться сервером)
AI_MODEL=moonshotai/kimi-dev-72b:free

# (Опционально) Системный промпт для переопределения стандартного поведения
AI_SYSTEM_PROMPT="You are a helpful assistant."
```

---

## 4. Реализация на Backend (Node.js)

### 4.1. Базовая функция запроса (Wrapper)

Создайте утилиту для отправки запросов. Используйте `timeout` (через `AbortController`), так как LLM могут отвечать долго.

```javascript
const fetch = require('node-fetch'); // Или встроенный fetch в Node.js 18+

async function queryAiServer(userQuery, systemContext) {
  const aiServerUrl = process.env.AI_SERVER_URL;
  const model = process.env.AI_MODEL;
  
  if (!model) throw new Error('AI_MODEL env var is not set');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 сек таймаут

  try {
    const response = await fetch(aiServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        prompt: systemContext,
        inputText: userQuery
      }),
      signal: controller.signal
    });

    const result = await response.json();
    if (!result.success) {
      throw new Error(result.error || 'AI Server returned error');
    }
    
    return result.content; // Строка с ответом
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('AI request timed out');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

### 4.2. Сценарий 1: AI-помощник (Endpoint)

Используется для чата с документацией ("Как добавить сервер?").

1.  **Сбор контекста (RAG):**
    Прочитайте markdown-файлы документации с диска и склейте их.
    ```javascript
    const docs = await fs.readFile('./README.md', 'utf8');
    const systemPrompt = `Ты помощник по продукту. Отвечай на основе документации:\n\n${docs}`;
    ```

2.  **API Route:**
    ```javascript
    app.post('/api/ai-help', async (req, res) => {
      try {
        const { query } = req.body;
        const answer = await queryAiServer(query, systemPrompt);
        res.json({ success: true, response: answer });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
    ```

### 4.3. Сценарий 2: Интеграция в терминал (WebSocket)

Сложнейший сценарий, где AI управляет сервером через SSH.

1.  **Логика перехвата:**
    В обработчике сообщений WebSocket ищите префикс `ai:` (или другой настроенный).

    ```javascript
    ws.on('message', async (msg) => {
      const { type, prompt } = JSON.parse(msg);
      
      if (type === 'ai_query') {
        // 1. Очищаем ввод пользователя в терминале (удаляем "ai: ...")
        // stream.write('\b'.repeat(prompt.length)); // Backspace hack
        
        // 2. Извлекаем чистый вопрос
        const question = prompt.replace(/^ai:\s*/, '');
        
        // 3. Собираем контекст (см. пункт ниже)
        const context = await buildTerminalContext(currentServerId);
        const systemPrompt = "Преобразуй запрос в одну безопасную Linux команду. Верни ТОЛЬКО команду.";
        
        // 4. Запрос к AI
        try {
          const command = await queryAiServer(question, systemPrompt + context);
          
          // 5. Впечатываем команду в терминал (авто-ввод)
          stream.write(command); 
        } catch (e) {
          ws.send(JSON.stringify({ type: 'data', data: `Error: ${e.message}\r\n` }));
        }
      }
    });
    ```

2.  **Динамический контекст (Advanced RAG):**
    Чтобы AI знал структуру файлов на удаленном сервере, выполните скрытую команду перед запросом.
    ```javascript
    // Получение "знаний" с удаленного сервера через существующий SSH канал
    function getRemoteKnowledge(sshStream) {
       return new Promise(resolve => {
          sshStream.exec('cat ~/.project_context.md', (err, stream) => {
             // ... чтение stdout ...
             // resolve(content);
          });
       });
    }
    ```

---

## 5. Реализация Frontend

Если у вас кастомный терминал на xterm.js:

1.  **Перехват ввода:**
    Используйте `attachCustomKeyEventHandler` или слушайте события ввода перед отправкой в сокет.
2.  **Детекция паттерна:**
    Если нажата `Enter` и текущая строка начинается с `ai:`:
    *   НЕ отправлять `\r` (Enter) в сокет сразу (иначе Shell выдаст "command not found").
    *   Вместо этого отправить специальный пакет `{ type: 'ai_query', prompt: 'ai: text' }` через WebSocket.

```javascript
term.onData(data => {
  // Накапливаем буфер текущей строки
  currentLine += data;
  
  if (data === '\r') { // Enter
    if (currentLine.trim().startsWith('ai:')) {
      // Это команда AI
      socket.send(JSON.stringify({ 
        type: 'ai_query', 
        prompt: currentLine.trim() 
      }));
      currentLine = '';
      return; // Прерываем стандартную отправку Enter
    }
    // Обычная обработка...
  }
});
```

---

## 6. Безопасность и нюансы

1.  **Санитизация:** Всегда удаляйте markdown-обертку из ответа AI (```bash ... ```), так как модель любит форматировать код.
    ```javascript
    command = command.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
    ```
2.  **Мульти-строки:** Для терминала опасно принимать многострочные скрипты. Рекомендуется брать только первую строку или экранировать `\n`.
3.  **Таймауты:** Generative AI работает медленно (5-10 сек). UI должен показывать индикатор загрузки, иначе пользователь начнет паниковать и нажимать кнопки.
4.  **SSH Агент:** Убедитесь, что `process.env` корректно пробрасывается для доступа к SSH сокетам, если AI должен генерировать команды, использующие ssh.

---

## 7. Чек-лист проверки

- [ ] `.env` содержит `AI_SERVER_URL` и `AI_MODEL`.
- [ ] Сервер AI доступен по сети (curl запрос проходит).
- [ ] Backend корректно обрабатывает таймауты (не виснет навсегда).
- [ ] Очистка ввода в терминале работает (пользователь не видит `ai:` + `command`).
- [ ] Контекст документации передается в промпт (AI знает о проекте).
