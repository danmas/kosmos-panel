# Мониторинг Hermes Gateway — руководство по настройке

В этом документе описан общий подход к мониторингу Hermes Gateway через Kosmos Panel, с примерами для Windows и Linux.

## Зачем это нужно

Hermes Gateway не слушают TCP-порты — они работают через Telegram Long Polling (только исходящие соединения). Поэтому прямой HTTP/TCP мониторинг невозможен.

**Решение (рекомендуемое):** `/health` endpoint **встроен прямо в Kosmos Panel** (`server.js`, порт 3000). Запускается автоматически при старте `kosmos-panel`.

**Альтернатива (для удалённых машин без Kosmos Panel):** `health-server.js` (Windows) / `health-server-linux.js` (Linux) — отдельный Node.js HTTP-сервис.

## Архитектура (рекомендуемая)

```
  Kosmos Panel server.js (порт 3000, GET /health)
         │
         ├── Gateway 1 — проверка: процесс hermes.exe жив / лог свежий
         ├── Gateway 2 — PM2 jlist → online/stopped
         ├── Gateway N — ...
         │
         ▼
  inventory.json (httpJson проверки на http://127.0.0.1:3000/health)
```

Один процесс — один порт. Не требует отдельного `hermes-health` в PM2.

## Архитектура (альтернативная — standalone)

```
|**Windows:** `health-server.js` (порт 3100, процесс: hermes-health)
|**Linux:** `health-server-linux.js` (порт 3100, процесс: hermes-health)
         │
         ├── Gateway 1 — проверка: процесс жив / systemd active / PM2 online
         ├── Gateway 2 — проверка: ... (по ситуации)
         ├── Gateway N — ...
         │
         ▼
  Kosmos Panel (httpJson проверки в inventory.json)
```

Принцип универсален:
- На **Windows** gateway может быть запущен через **планировщик** или **PM2** → `health-server.js`
- На **Linux** — через **systemd** или **PM2** → `health-server-linux.js`
- Каждый файл адаптирован под свою ОС; их можно копировать на соответствующие машины как готовые сценарии проверки

---

## 1. Компонент: health-server.js / health-server-linux.js

Расположение:
- `./health-server.js` (Windows) — в корне проекта kosmos-panel
- `./health-server-linux.js` (Linux) — готовый файл для копирования на Linux-сервер

Файлы содержат логику проверки gateway под конкретную ОС. Принцип работы:

1. Запускается как HTTP-сервер (порт по умолчанию **3100**, задаётся через `HEALTH_PORT`)
2. Периодически (каждые **30 секунд**) проверяет состояние gateway
3. Отдаёт JSON на `GET /health` и HTML-статус на `GET /`
4. Формат JSON:

```json
{
  "ok": true,
  "ts": "2026-06-26T08:11:28.538Z",
  "gateways": {
    "gateway-id": {
      "name": "Название для отображения",
      "alive": true,
      "detail": "OK"
    }
  }
}
```

Поле `ok` — `true` только когда все gateway `alive: true`. Kosmos Panel использует JSONPath `$.gateways.<id>.alive` для проверки каждого gateway.

### Как адаптировать под свою ОС

Логика проверки каждого gateway описывается внутри `checkProcesses()` в `health-server.js` (Windows) или `health-server-linux.js` (Linux). В секции PM2 gateway используется универсальный парсинг `pm2 jlist` — работает и на Windows, и на Linux.

Для gateway, запущенных **не через PM2** (через systemd, планировщик Windows), нужно написать свою проверку. Примеры ниже.

---

## 2. Запуск проверки gateway

### Рекомендуемый способ (встроен в Kosmos Panel)

Логика проверки gateway встроена прямо в `server.js`. Запускается автоматически:

```bash
pm2 restart kosmos-panel
```

После запуска `/health` доступен на том же порту, что и панель:
```
http://localhost:3000/health
```

Проверка работает каждые 30 секунд. Отдельный PM2-процесс не требуется.

### Альтернативный способ (отдельный health-server)

Для удалённых машин или если Kosmos Panel не используется — запустить как самостоятельный сервис:

**Через PM2** — добавить в `ecosystem.config.js`:
```javascript
{
  name: 'hermes-health',
  cwd: './kosmos-panel',
  script: 'health-server.js',
  interpreter: 'node',
  instances: 1,
  autorestart: true,
  watch: false,
  max_memory_restart: '128M',
  exec_mode: 'fork',
  env: {
    HEALTH_PORT: 3100
  }
}
```

После добавления:
```bash
cd <project-root>     # где лежит ecosystem.config.js
pm2 start ecosystem.config.js --only hermes-health
pm2 save
```

**Без PM2** — как обычный Node.js процесс:
```bash
# Windows
node ./kosmos-panel/health-server.js
# Linux
node ./kosmos-panel/health-server-linux.js
```

---

## 3. Мониторинг в Kosmos Panel

В `inventory.json` для нужного сервера добавляются сервисы типа `httpJson`. **Для встроенного решения (порт Kosmos Panel):**

```json
{
  "id": "hermes-<gateway-id>",
  "type": "httpJson",
  "name": "🤖 <Название Gateway>",
  "url": "http://127.0.0.1:3000/health",
  "timeoutMs": 5000,
  "rules": [
    { "name": "Gateway alive", "path": "$.gateways.<gateway-id>.alive", "equals": true }
  ]
}
```

**Для отдельного health-server (порт 3100):**
```json
  "url": "http://127.0.0.1:3100/health",
```

JSONPath `$.gateways.<gateway-id>.alive` должен совпадать с ключом, указанным в `server.js` (или `health-server.js`).

---

## 4. Пример: Windows (данная установка)

### 4.1. Как запущены gateway

| Gateway | Профиль | Откуда запущен | Проверка |
|---------|---------|---------------|----------|
| @erv_HA_WORK_bot (ты тут) | default | **Планировщик Windows** (задача `HermesGateway`, BootTrigger) | процесс `hermes.exe` + свежесть `gateway.log` |
| carl-db | carl-db | PM2 (`hermes-carl-db-gateway`) | `pm2 jlist` → online |
| pilot-work | pilot-work | PM2 (`hermes-pilot-work-gateway`) | `pm2 jlist` → online |
| projects-ex | projects-ex | PM2 (`hermes-projects-ex-gateway`) | `pm2 jlist` → online |

### 4.2. Логика проверки (встроена в server.js)

Код проверки — в `server.js`, функции `checkGateways()`.

**Default gateway (планировщик):** двухфакторная проверка:
1. Процесс `hermes.exe` запущен
2. `gateway.log` обновлялся за последние 5 минут — признак активного Long Polling

Оба условия обязательны для статуса `alive`.

**PM2 gateway:** универсальная проверка через `pm2 jlist`:
- Парсинг JSON → поиск по `name` → проверка `pm2_env.status === 'online'`

### 4.3. Запуск

Отдельный процесс не требуется — `/health` стартует вместе с `kosmos-panel`:

```bash
pm2 start kosmos-panel   # автоматически включает /health
```

### 4.4. inventory.json (сервер localhost)

```json
{
  "id": "hermes-default",
  "type": "httpJson",
  "name": "🤖 HA-Work Gateway (default)",
  "url": "http://127.0.0.1:3000/health",
  "rules": [
    { "name": "Gateway alive", "path": "$.gateways.default.alive", "equals": true }
  ]
}
```

---

## 5. Пример: Linux

> **Готовый файл:** `health-server-linux.js` — скопируйте его на Linux-сервер и используйте как есть. Содержит проверки для systemd, логи и расширяемый блок для PM2.

### 5.1. Gateway через systemd

На Linux Hermes Gateway обычно запускается через systemd (установка через `hermes gateway install`).

**Проверка в `health-server-linux.js`:**

```javascript
// Linux: systemd-запущенный gateway
try {
  const r = await execPromise('systemctl is-active --user hermes-gateway');
  const active = r.stdout.trim() === 'active';
  gateways['default'] = {
    name: '🤖 Hermes Gateway (systemd)',
    alive: active,
    detail: active ? 'OK' : 'not active'
  };
} catch (e) {
  gateways['default'] = { name: 'Hermes Gateway', alive: false, error: e.message };
}
```

### 5.2. Gateway через PM2 на Linux

Аналогично Windows — универсальный парсинг `pm2 jlist`.

### 5.3. Запуск health-server через systemd

Создать `/etc/systemd/system/hermes-health.service`:

```ini
[Unit]
Description=Hermes Gateway Health Check
After=network.target

[Service]
Type=simple
User=<username>
WorkingDirectory=/path/to/kosmos-panel
|ExecStart=/usr/bin/node /path/to/kosmos-panel/health-server-linux.js
Restart=always
RestartSec=5
Environment=HEALTH_PORT=3100

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-health
```

### 5.4. inventory.json

Если Kosmos Panel и gateway на одной Linux-машине:

```json
{
  "id": "hermes-linux-gw",
  "type": "httpJson",
  "name": "🤖 Linux Gateway (systemd)",
  "url": "http://127.0.0.1:3100/health",
  "rules": [
    { "name": "Gateway alive", "path": "$.gateways.default.alive", "equals": true }
  ]
}
```

Если Kosmos Panel на другой машине — заменить `127.0.0.1` на IP Linux-сервера.

---

## 6. Расширение (добавление нового gateway)

### Для встроенного решения (server.js)

В `server.js`, внутри функции `checkGateways()`, добавить блок проверки:

```javascript
try {
  // ... команда проверки ...
  gateways['my-gateway'] = {
    name: '🤖 Мой Gateway',
    alive: условие,
    detail: 'OK' или описание ошибки
  };
} catch (e) {
  gateways['my-gateway'] = { name: 'Мой Gateway', alive: false, error: e.message };
}
```

### Для отдельного health-server

Аналогично — в `health-server.js` (Windows) или `health-server-linux.js` (Linux), внутри `checkProcesses()`.

### inventory.json

В любом случае — добавить httpJson сервис с JSONPath `$.gateways.my-gateway.alive`.

### Перезапуск

```bash
pm2 restart kosmos-panel
# или для отдельного health-server:
pm2 restart hermes-health
```

---

## 7. Проверка

```bash
# Статус всех gateway (встроенный в Kosmos Panel)
curl http://127.0.0.1:3000/health

# Для отдельного health-server
curl http://127.0.0.1:3100/health

# HTML-страница (автообновление каждые 10 сек)
# http://localhost:3000/  →  health-server.html
# или для отдельного: http://localhost:3100/

# Статус в Kosmos Panel
curl http://<kosmos-panel-host>:3000/api/servers | jq '.servers[] | select(.id=="<server-id>") | .services[] | select(.id | startswith("hermes-"))'
```

---

## 8. Восстановление после сбоя

**Если Kosmos Panel упал:**
```bash
pm2 start kosmos-panel    # автостарт /health вместе с панелью
```

**Если используется отдельный health-server:**
```bash
pm2 restart hermes-health
# или (systemd):
sudo systemctl restart hermes-health
```

**Если gateway упал** — `/health` покажет RED, Kosmos Panel — красную плитку. Действия по восстановлению gateway зависят от способа запуска (systemd restart, pm2 restart, перезапуск планировщика Windows).

---

## 9. Ограничения

- Проверка должна работать на той же машине, что и gateway (иначе не сможет проверять локальные процессы)
- Встроенное `/health` работает только вместе с Kosmos Panel; для удалённых машин — отдельный `health-server.js`
- Требует Node.js

**Последнее обновление:** 2026-06-29 | встроенное /health в server.js, отдельный health-server.js — альтернатива
