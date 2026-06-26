# Мониторинг Hermes Gateway — руководство по настройке

В этом документе описан общий подход к мониторингу Hermes Gateway через Kosmos Panel, с примерами для Windows и Linux.

## Зачем это нужно

Hermes Gateway не слушают TCP-порты — они работают через Telegram Long Polling (только исходящие соединения). Поэтому прямой HTTP/TCP мониторинг невозможен. Решение — **health-server.js (Windows) / health-server-linux.js (Linux)**: промежуточный Node.js HTTP-сервис, который запущен на той же машине, что и gateway, опрашивает локальную систему и отдаёт статус gateway в JSON.

Kosmos Panel мониторит health-server через **httpJson** проверки.

## Архитектура

```
|**Windows:** `health-server.js` (порт 3100, процесс/сервис: hermes-health)
**Linux:** `health-server-linux.js` (порт 3100, процесс/сервис: hermes-health)
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

## 2. Запуск health-server

Через PM2 — добавить в `ecosystem.config.js`:

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

Если PM2 не используется — можно запустить как обычный Node.js процесс:
```bash
# Windows
node ./kosmos-panel/health-server.js
# Linux
node ./kosmos-panel/health-server-linux.js
```

---

## 3. Мониторинг в Kosmos Panel

В `inventory.json` для нужного сервера добавляются сервисы типа `httpJson`:

```json
{
  "id": "hermes-<gateway-id>",
  "type": "httpJson",
  "name": "🤖 <Название Gateway>",
  "url": "http://127.0.0.1:3100/health",
  "timeoutMs": 5000,
  "rules": [
    { "name": "Gateway alive", "path": "$.gateways.<gateway-id>.alive", "equals": true }
  ]
}
```

JSONPath `$.gateways.<gateway-id>.alive` должен совпадать с ключом, указанным в `health-server.js`.

---

## 4. Пример: Windows (данная установка)

### 4.1. Как запущены gateway

| Gateway | Профиль | Откуда запущен |
|---------|---------|---------------|
| @erv_HA_WORK_bot (ты тут) | default | **Планировщик Windows** (задача `HermesGateway`, BootTrigger) |
| carl-db | carl-db | PM2 (`hermes-carl-db-gateway`) |
| pilot-work | pilot-work | PM2 (`hermes-pilot-work-gateway`) |
| projects-ex | projects-ex | PM2 (`hermes-projects-ex-gateway`) |

### 4.2. Логика проверки в health-server.js

**Default gateway (планировщик):** двухфакторная проверка:
1. Процесс `hermes.exe` запущен
2. `gateway.log` обновлялся за последние 5 минут — признак активного Long Polling

Оба условия обязательны для статуса `alive`.

**PM2 gateway:** универсальная проверка через `pm2 jlist`:
- Парсинг JSON → поиск по `name` → проверка `pm2_env.status === 'online'`

### 4.3. Запуск health-server

Через PM2 как `hermes-health` (см. секцию 2). Автостарт — через задачу `PM2-User-Startup` в планировщике (LogonTrigger). При перезагрузке Windows требуется вход пользователя для PM2; основной gateway (HermesGateway) стартует сам по BootTrigger.

### 4.4. inventory.json (сервер localhost)

```json
{
  "id": "hermes-default",
  "type": "httpJson",
  "name": "🤖 HA-Work Gateway (default)",
  "url": "http://127.0.0.1:3100/health",
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

## 6. Расширение health-server.js / health-server-linux.js

Чтобы добавить новый gateway в мониторинг, отредактируйте нужный файл под свою ОС:

1. В `health-server.js` (Windows) или `health-server-linux.js` (Linux), внутри `checkProcesses()`, добавить блок проверки:
```javascript
try {
  // ... команда проверки под вашу ОС ...
  gateways['my-gateway'] = {
    name: '🤖 Мой Gateway',
    alive: условие,
    detail: 'OK' или описание ошибки
  };
} catch (e) {
  gateways['my-gateway'] = { name: 'Мой Gateway', alive: false, error: e.message };
}
```

2. В `inventory.json` добавить httpJson сервис с JSONPath `$.gateways.my-gateway.alive`

3. Перезапустить health-server и перезагрузить Kosmos Panel

---

## 7. Проверка

```bash
# Статус всех gateway через health-server
curl http://127.0.0.1:3100/health

# HTML-страница (автообновление каждые 10 сек)
# Открыть в браузере: http://127.0.0.1:3100/

# Статус в Kosmos Panel
curl http://<kosmos-panel-host>:3000/api/servers | jq '.servers[] | select(.id=="<server-id>") | .services[] | select(.id | startswith("hermes-"))'
```

---

## 8. Восстановление после сбоя

**Если health-server упал (PM2):**
```bash
pm2 start hermes-health
pm2 save
```

**Если health-server упал (systemd):**
```bash
sudo systemctl restart hermes-health
```

**Если gateway упал** — health-server покажет RED, Kosmos Panel — красную плитку. Действия по восстановлению gateway зависят от способа запуска (systemd restart, pm2 restart, etc.).

---

## 9. Ограничения

- Health-server должен работать на той же машине, что и gateway (иначе не сможет проверять локальные процессы)
- Требует Node.js
- При перезагрузке ОС нужно убедиться, что health-server настроен на автозапуск

**Последнее обновление:** 2026-06-26 (добавлен `health-server-linux.js`)
