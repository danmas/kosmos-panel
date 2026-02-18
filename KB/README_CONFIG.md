# Kosmos Panel — Система конфигурации

Документ описывает систему управления конфигурацией AI-настроек через `config.json`.

## Обзор

С версии от 2026-02-16 AI-настройки вынесены из `.env` в отдельный файл `config.json` в корне проекта. Это позволяет:
- Перезагружать AI-конфигурацию без перезапуска сервера
- Редактировать настройки через веб-интерфейс
- Управлять конфигурацией через REST API

## Структура config.json

```json
{
  "AI_KOSMOS_MODEL_BASE_URL": "http://usa:3002/v1",
  "AI_MODEL": "FAST",
  "AI_SERVER_URL_HELP": "http://localhost:3002/api/send-request",
  "AI_MODEL_HELP": "moonshotai/kimi-dev-72b:free",
  "AI_PROVIDER_HELP": "openroute",
  "AI_SYSTEM_PROMPT_HELP": "Ты - AI помощник для системы мониторинга...",
  "AI_HELP_CONTEXT_FILES": "README_AI.md,KB/README_INVENTORY_EDITOR.md"
}
```

Промпты для терминального AI и для skills хранятся в **prompts.json** (ключи `AI_SYSTEM_PROMPT`, `SKILL_SYSTEM_PROMPT_WITH_ASK`). См. `prompts.json.example`. Если в `prompts.json` нет `AI_SYSTEM_PROMPT`, используется значение из config/env.

### Описание полей

| Поле | Назначение | Пример |
|------|------------|--------|
| `AI_KOSMOS_MODEL_BASE_URL` | Base URL AI-сервера для терминальных команд | `http://usa:3002/v1` |
| `AI_MODEL` | Модель для терминального AI | `FAST`, `CHEAP`, `SMART` |
| `AI_SERVER_URL_HELP` | URL AI-сервера для системы помощи | `http://localhost:3002/api/send-request` |
| `AI_MODEL_HELP` | Модель для AI-помощника | `moonshotai/kimi-dev-72b:free` |
| `AI_PROVIDER_HELP` | Провайдер AI для помощника | `openroute`, `groq` |
| `AI_SYSTEM_PROMPT_HELP` | Системный промпт для AI-помощника | "Ты - AI помощник..." |
| `AI_HELP_CONTEXT_FILES` | Файлы контекста (через запятую) | `README_AI.md,KB/doc.md` |

## Загрузка конфигурации

### При старте сервера

Файл `config.json` загружается функцией `loadConfig()` в `server.js`:

```javascript
function loadConfig() {
  try {
    const configPath = path.join(process.cwd(), 'config.json');
    const configData = require('fs').readFileSync(configPath, 'utf8');
    appConfig = JSON.parse(configData);
    
    // Inject config values into process.env
    Object.keys(appConfig).forEach(key => {
      process.env[key] = appConfig[key];
    });
    
    logger.info('config', 'Config loaded successfully', { keys: Object.keys(appConfig) });
  } catch (e) {
    logger.error('config', 'Failed to load config.json - server cannot start', { error: e.message });
    console.error('ERROR: config.json is missing or invalid. Server stopped.');
    process.exit(1);
  }
}
```

**Важно:** Если `config.json` отсутствует или содержит невалидный JSON — сервер останавливается с ошибкой.

### Использование в коде

После загрузки, все переменные из `config.json` доступны через `process.env`:

```javascript
// В server/ws.js — URL и модель из config/env
const aiBaseUrl = process.env.AI_KOSMOS_MODEL_BASE_URL || 'http://localhost:3002/v1';
const aiModel = process.env.AI_MODEL || 'CHEAP';
// Системный промпт — из prompts.json (fallback: config/env), см. server/prompts.js
const systemPrompt = getPrompt('AI_SYSTEM_PROMPT');
```

## REST API

### GET /api/config

Получить текущую конфигурацию.

**Ответ:**
```json
{
  "AI_KOSMOS_MODEL_BASE_URL": "http://usa:3002/v1",
  "AI_MODEL": "FAST",
  ...
}
```

### POST /api/config

Сохранить новую конфигурацию. Автоматически вызывает `loadConfig()` после сохранения.

**Запрос:**
```json
{
  "AI_KOSMOS_MODEL_BASE_URL": "http://new-server:3002/v1",
  "AI_MODEL": "SMART",
  ...
}
```

**Ответ:**
```json
{
  "ok": true,
  "message": "Config saved and reloaded successfully"
}
```

### POST /api/reload-config

Перезагрузить `config.json` без изменения файла.

**Ответ:**
```json
{
  "ok": true,
  "message": "Config reloaded successfully"
}
```

## Веб-интерфейс

### Inventory Editor

В редакторе инвентаря (`/inventory-editor.html`) добавлена вкладка **AI Config** с формой для редактирования всех AI-настроек.

**Функции:**
- **Load Current Config** — загрузить текущую конфигурацию в форму
- **Save AI Config** — сохранить изменения (вызывает `POST /api/config`)
- **Reload Config** — кнопка в шапке редактора для перезагрузки конфигурации (вызывает `POST /api/reload-config`)

**Реализация:**

```javascript
// web/inventory-editor.js

async loadAiConfig() {
  const response = await fetch('/api/config');
  const config = await response.json();
  
  // Fill form fields
  Object.keys(config).forEach(key => {
    const input = this.aiConfigForm.querySelector(`[name="${key}"]`);
    if (input) input.value = config[key] || '';
  });
}

async saveAiConfig(event) {
  event.preventDefault();
  
  const formData = new FormData(this.aiConfigForm);
  const config = {};
  for (const [key, value] of formData.entries()) {
    config[key] = value;
  }
  
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  
  const result = await response.json();
  alert(result.message);
}

async reloadConfig() {
  const response = await fetch('/api/reload-config', { method: 'POST' });
  const result = await response.json();
  alert('Config.json reloaded successfully!');
}
```

## Горячая перезагрузка

**Преимущества горячей перезагрузки:**
- Не нужно останавливать сервер
- Не прерываются активные WebSocket-соединения
- Изменения применяются мгновенно
- Можно тестировать разные AI-модели "на лету"

**Когда перезагружать:**
- После изменения настроек через UI
- После ручного редактирования `config.json`
- При переключении между разными AI-провайдерами
- При отладке промптов

**Команда:**
```bash
curl -X POST http://localhost:3000/api/reload-config
```

Или через кнопку **Reload Config** в inventory editor.

## Миграция с .env

Старые переменные из `.env` больше не используются для AI-настроек:
- ~~`AI_SERVER_URL`~~ → `AI_KOSMOS_MODEL_BASE_URL`
- ~~`AI_COMMAND_PREFIX`~~ → удалено (зашито `ai:`)

`.env` по-прежнему используется для:
- SSH-ключей и паролей (`SSH_KEY_PATH`, `SSH_PASSPHRASE`)
- Порта сервера (`PORT`)
- Других системных переменных

## Безопасность

- `config.json` содержит только URL и названия моделей — никаких секретов
- Файл может быть добавлен в git (если нет чувствительных данных)
- API endpoints не требуют аутентификации (защита на уровне сети/firewall)

## Отладка

### Проверить загрузку конфигурации

При старте сервера в логах появляется:
```
[INFO] [config] Config loaded successfully {"keys":["AI_KOSMOS_MODEL_BASE_URL","AI_MODEL",...]}
```

### Проверить текущие значения

```bash
curl http://localhost:3000/api/config
```

### Ошибка загрузки

Если `config.json` невалиден или отсутствует:
```
[ERROR] [config] Failed to load config.json - server cannot start
ERROR: config.json is missing or invalid. Server stopped.
```

Сервер немедленно завершится с кодом 1.

## Примеры использования

### Быстрая смена модели AI

```bash
# 1. Получить текущую конфигурацию
curl http://localhost:3000/api/config > config_backup.json

# 2. Изменить модель
cat config_backup.json | jq '.AI_MODEL = "SMART"' > new_config.json

# 3. Загрузить новую конфигурацию
curl -X POST -H "Content-Type: application/json" \
  -d @new_config.json \
  http://localhost:3000/api/config

# 4. Проверить применение
curl http://localhost:3000/api/config | jq '.AI_MODEL'
```

### A/B тестирование промптов

1. Открыть `/inventory-editor.html`
2. Перейти на вкладку **AI Config**
3. Нажать **Load Current Config**
4. Изменить `AI_SYSTEM_PROMPT`
5. Нажать **Save AI Config**
6. Протестировать команды в терминале
7. При необходимости откатить через кнопку **Load Current Config**

---

**Последнее обновление:** 2026-02-16
