# Мониторинг Hermes Gateway в Kosmos Panel

Документ описывает, как настроен мониторинг Hermes Gateway (Telegram-ботов) через Kosmos Panel.

## Архитектура

```
health-server.js (PM2: hermes-health, порт 3100)
         │
         ├── Carl-DB Gateway (@erv_hermes_bot, планировщик Windows)
         │   └── проверка: процесс hermes.exe жив + gateway.log свежий (< 5 мин)
         │
         ├── Pilot-Work Gateway (@erv_hermes_pilot_work_bot, PM2)
         │   └── проверка: pm2 status = online
         │
         └── Projects-Ex Gateway (@erv_hermes_projects_bot, PM2)
             └── проверка: pm2 status = online
                    │
                    ▼
             Kosmos Panel (httpJson проверки)
```

Все три Hermes Gateway не слушают TCP-порты — они работают через Telegram Long Polling (только исходящие соединения). Поэтому прямой HTTP/TCP мониторинг невозможен. Вместо этого используется **health-server.js** — промежуточный HTTP-сервис, который опрашивает систему и отдаёт статус в JSON.

## Компоненты

### 1. health-server.js

Расположение: `C:\ERV\projects-ex\kosmos-panel\health-server.js`

Небольшой Node.js HTTP-сервер. При каждом запросе `/health` возвращает JSON вида:
```json
{
  "ok": true,
  "ts": "2026-06-26T08:11:28.538Z",
  "gateways": {
    "carl-db": {
      "name": "Hermes Carl-DB Gateway",
      "alive": true,
      "process": "running",
      "log": "fresh",
      "detail": "OK"
    },
    "pilot-work": {
      "name": "Hermes Pilot-Work Gateway",
      "alive": true,
      "pm2_status": "online",
      "detail": "OK"
    },
    "projects-ex": {
      "name": "Hermes Projects-Ex Gateway",
      "alive": true,
      "pm2_status": "online",
      "detail": "OK"
    }
  }
}
```

- **Порт:** 3100
- **Интервал проверки:** каждые 30 секунд (кэшируется)
- **Запуск:** через PM2 как `hermes-health`
- **Endpoint:** `http://127.0.0.1:3100/health` (JSON) или `http://127.0.0.1:3100/` (HTML-страница)

### 2. Мониторинг в Kosmos Panel

В `inventory.json` (сервер `localhostserver`) добавлены 3 сервиса типа `httpJson`:

| ID | Название | Что проверяет |
|----|----------|---------------|
| `hermes-carl-db` | 🤖 Carl-DB Gateway | `$.gateways.carl-db.alive` == true |
| `hermes-pilot-work` | 🤖 Pilot-Work Gateway | `$.gateways.pilot-work.alive` == true |
| `hermes-projects-ex` | 🤖 Projects-Ex Gateway | `$.gateways.projects-ex.alive` == true |

### 3. Запуск в PM2

Добавлен в `ecosystem.config.js`:
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

## Логика проверки каждого gateway

### Carl-DB Gateway (из планировщика Windows)

Основной gateway запускается через задачу в планировщике Windows, **не через PM2**. Проверка двухфакторная (оба условия обязательны):

1. **Процесс жив:** `Get-Process hermes` — проверяет, что процесс `hermes.exe` запущен
2. **Лог свежий:** `(Get-Item gateway.log).LastWriteTime > (Get-Date).AddMinutes(-5)` — проверяет, что gateway активно поллингует Telegram

GREEN только когда оба условия выполнены.

### Pilot-Work / Projects-Ex (через PM2)

Запускаются через PM2. Проверка:
- `pm2 jlist` → JSON.parse → поиск приложения по `name` → проверка `pm2_env.status === 'online'`

## Как проверить вручную

```bash
# Общий статус всех gateway
curl http://127.0.0.1:3100/health

# HTML-статус (с автообновлением каждые 10 сек)
# Открыть в браузере: http://127.0.0.1:3100/

# Статус в Kosmos Panel
curl http://127.0.0.1:3000/api/servers | jq '.servers[] | select(.id=="localhostserver") | .services[] | select(.id | startswith("hermes-"))'
```

## Восстановление после сбоя

Если `hermes-health` упал:
```bash
cd /c/ERV/projects-ex
pm2 start hermes-health
pm2 save
```

Если gateway упал — health-server покажет RED, Kosmos Panel покажет красную плитку. Действия по восстановлению каждого gateway описаны в других документах.

## Известные ограничения

- Health-server запущен на том же ПК, что и gateway — если ПК выключен, health не работает (но gateway тоже не работают)
- Требует Node.js для работы
- Не мониторит другие PM2-процессы (только gateway) — при необходимости можно расширить

**Последнее обновление:** 2026-06-26
