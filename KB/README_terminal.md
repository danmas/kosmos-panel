# Терминал Kosmos Panel — документация

Терминал в Kosmos Panel реализован двумя способами: **WebSocket** (интерактивный PTY в браузере) и **REST API** (сессии + выполнение одной команды). Дополнительно есть **REST‑мост к WebSocket** для отправки команд в уже открытый браузерный терминал.

---

## 1. WebSocket `/ws/terminal`

Интерактивная PTY‑оболочка по SSH. Используется в `term.html` и плавающих окнах терминала в панели.

**Подключение:**  
`ws://<host>/ws/terminal?serverId=<id>&cols=120&rows=30`

**Query-параметры:**
- `serverId` (обязательный) — ID сервера из `inventory.json`
- `cols`, `rows` — размер терминала (по умолчанию 120×30)

**Сообщения от клиента → сервер (JSON):**
- `{ type: "data", data: string }` — ввод с клавиатуры
- `{ type: "resize", cols: number, rows: number }` — изменить размер
- `{ type: "close" }` — закрыть
- `{ type: "ai_query", prompt: string }` — AI‑команда (префикс `ai:`)

**Сообщения от сервера → клиент (JSON):**
- `{ type: "data", data: string }` — вывод (stdout)
- `{ type: "err", data: string }` — stderr
- `{ type: "fatal", error: string }` — ошибка, соединение закрывается
- `{ type: "session", sessionId: string }` — ID сессии (для REST‑моста)
- `{ type: "os_detected", os: "linux"|"windows" }` — ОС на удалённом сервере
- `{ type: "remote_command", commandId, command, requireConfirmation }` — команда от REST‑моста (подтверждение при необходимости)

Подробнее про AI‑команды и Skills см. [README_AI.md](README_AI.md).

---

## 2. REST API терминала (server/terminal.js)

Отдельные SSH‑сессии без PTY: создаётся сессия, в неё отправляются команды через `exec`, ответ — stdout/stderr и код выхода. Удобно для скриптов и автоматизации.

### Версия 1 (прямые ответы)

| Метод | Путь | Тело (JSON) | Ответ |
|-------|------|-------------|--------|
| POST | `/api/v1/terminal/sessions` | `{ serverId }` | `201` + `{ sessionId }` или ошибка |
| POST | `/api/v1/terminal/sessions/:sessionId/exec` | `{ command, timeout? }` | `{ exitCode, signal, stdout, stderr }` или ошибка |
| DELETE | `/api/v1/terminal/sessions/:sessionId` | — | `200` + `{ message: "Session closed" }` или ошибка |

- `timeout` — мс (по умолчанию 30000). При превышении — 500 и ответ с накопленными stdout/stderr.

### Версия 2 (единый формат ответа)

Те же пути под префиксом `/api/v2/terminal/`:

- **Успех:** `{ success: true, data: ... }`
- **Ошибка:** `{ success: false, error: { message: string } }`

Эндпоинты:
- `POST /api/v2/terminal/sessions` — тело `{ serverId }`, ответ `data: { sessionId }`
- `POST /api/v2/terminal/sessions/:sessionId/exec` — тело `{ command, timeout? }`, ответ `data: { exitCode, signal, stdout, stderr }`
- `DELETE /api/v2/terminal/sessions/:sessionId` — ответ `data: { message: "Session closed" }`

**Таймаут сессии:** неактивные сессии закрываются через 10 минут.

---

## 3. REST‑мост к WebSocket‑терминалу

Позволяет отправить команду в уже открытый браузерный терминал (сессия из `/ws/terminal`) и опционально дождаться результата. Реализовано в `server.js` и `server/ws.js`.

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/ws-terminal/sessions` | Список активных WS‑сессий: `{ success: true, data: [{ sessionId, serverId, serverName, connectedAt }] }` |
| POST | `/api/ws-terminal/:sessionId/command` | Отправить команду в сессию. Тело: `{ command, requireConfirmation?, timeout?, wait? }`. При `wait: true` ответ после выполнения (или таймаут). |
| GET | `/api/ws-terminal/command/:commandId` | Статус/результат команды: `{ success, data: { commandId, sessionId, command, status, result, createdAt } }` |
| DELETE | `/api/ws-terminal/command/:commandId` | Отменить ожидающую команду |

- `requireConfirmation` — запрос подтверждения в браузере перед выполнением.
- `timeout` — мс при `wait: true` (макс. 300000).
- `status`: `pending`, `awaiting_confirmation`, `completed`, `timeout`, `cancelled` и т.п.

---

## 4. История команд (логирование)

**Где хранится:** один файл `logs/terminal/terminal_log.json`. Формат — JSON-массив записей (append-only). Директория создаётся при первой записи.

**Кто пишет:** только **WebSocket-терминал** (`server/ws.js`) через `appendToLog()`. **REST-терминал** (`server/terminal.js`) в лог **не пишет** — команды, выполненные через `/api/v1/terminal/...` и `/api/v2/terminal/...`, в историю не попадают.

**Формат записи:** у каждой записи есть `id`, `sessionId`, `timestamp`, `type` и привязка к серверу: `serverId`, `serverName`, `serverHost`. По `type`:
- `stdin` — введённая команда: поле `executed_command`; опционально `ai_query_id`, `user_ai_query`, `skill_name`, `skill_step`.
- `stdout` — вывод команды: `terminal_output`; опционально `stdin_id` (связь с записью команды).
- `stderr` — stderr: `terminal_output`.
- `ai_query` — AI-запрос: `user_ai_query`.
- `skill_invoke` — запуск skill: `skill_name`, `skill_params`, `user_prompt` и др.

**Просмотр через API:**
- `GET /api/logs` — весь лог (все сессии, все серверы).
- `GET /api/logs?sessionId=<id>` — только записи одной WebSocket-сессии.

**Просмотр в UI:**
- **Все команды со всех терминалов:** страница `/raw-logs.html` запрашивает `/api/logs` без параметров и показывает полный лог (сырой JSON).
- **Лог одной сессии:** `/logs.html?sessionId=<id>` — «красивый» вывод (команды, вывод, AI, фильтры по типу). Без `sessionId` страница не показывает записи.

Итого: история одна на все WebSocket-терминалы; смотреть всё сразу — через `/api/logs` без `sessionId` или `/raw-logs.html`.

---

## Сводка

| Режим | Назначение |
|-------|------------|
| **WebSocket `/ws/terminal`** | Интерактивный терминал в браузере, AI‑команды, Skills |
| **REST v1/v2** | Скрипты: создать сессию → выполнить команды → закрыть сессию |
| **WS‑мост** | Внешние системы отправляют команды в уже открытый браузерный терминал |

Логирование ввода/вывода команд в терминале описано в [README_TERMINAL_LOGGING.md](README_TERMINAL_LOGGING.md).
