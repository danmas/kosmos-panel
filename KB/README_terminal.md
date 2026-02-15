# Терминал Kosmos Panel

Документация по работе с SSH-терминалом: WebSocket-терминал, REST API сессий, мост для удалённого выполнения команд, логирование и интеграция с AI.

---

## Обзор

Терминал в Kosmos Panel реализован двумя способами:

1. **WebSocket-терминал** (`/ws/terminal`) — интерактивная PTY-сессия: ввод с клавиатуры, вывод в реальном времени, resize, AI-команды и Skills. Используется в UI (дашборд, `/term.html`, плавающие окна).
2. **REST API терминала** (v1 и v2) — создание сессии и выполнение одной команды за запрос, без интерактивного ввода. Удобно для скриптов и автоматизации.

Дополнительно: **REST Bridge** позволяет отправлять команды в уже открытый WebSocket-терминал извне (по `sessionId`) и при необходимости получать результат выполнения.

---

## WebSocket: интерактивный терминал

### Подключение

- **URL:** `ws://host/ws/terminal` (или `wss://` при HTTPS).
- **Query-параметры:**
  - `serverId` (обязательный) — ID сервера из `inventory.json`.
  - `cols` — ширина в символах (по умолчанию 120).
  - `rows` — высота в строках (по умолчанию 30).

Пример:
```
ws://localhost:3000/ws/terminal?serverId=usa&cols=120&rows=30
```

Подключение идёт по SSH (ssh2) к серверу из inventory; используется PTY (`conn.shell()` с `term: 'xterm-256color'`). Креды берутся из `server.ssh.credentialId`.

### Сообщения: клиент → сервер

| type | Назначение |
|------|------------|
| `data` | Сырой ввод с клавиатуры. Поле `data` — строка (в т.ч. управляющие символы). Передаётся в PTY как есть. |
| `resize` | Изменить размер PTY. Поля `cols`, `rows` (числа). |
| `close` | Закрыть shell-поток (завершить сессию). |
| `command_log` | Записать выполненную команду в лог. Поле `command` — строка команды (без префикса `ai:`). Отправляется при нажатии Enter по детекции промпта в текущей строке. |
| `command_result` | Результат удалённой команды (REST Bridge). Поля: `commandId`, `status`, `stdout`, `stderr`, `exitCode`. |
| `ai_query` | AI-команда. Поле `prompt` — полная строка с промпта (включая `ai: ...`). Сервер очищает строку в shell, вызывает AI, подставляет и выполняет команду. |
| `skills_list` | Запросить список Skills (проект + удалённый сервер). |
| `skill_invoke` | Запустить Skill. Поля: `name`, `path`, `source`, `params`, `prompt`. |
| `skill_user_input` | Ответ пользователя на вопрос Skill (многошаговый сценарий). |
| `skill_cancel` | Отменить активный Skill. |
| `skill_get_content` | Получить содержимое SKILL.md для редактирования. |
| `skill_create` | Создать новый Skill (project или remote). |

### Сообщения: сервер → клиент

| type | Назначение |
|------|------------|
| `data` | Вывод stdout PTY (сырой текст, может содержать ANSI-коды). |
| `err` | Вывод stderr PTY. |
| `fatal` | Критическая ошибка (подключение, креды, shell). Поле `error`. |
| `session` | Идентификатор сессии для REST Bridge. Поле `sessionId` (UUID). Отправляется после успешного `shell()`. |
| `os_detected` | Определённая ОС удалённого хоста. Поле `os`: `linux` или `windows`. |
| `skills_list` | Список Skills. Поле `skills` — массив; при ошибке — `error`. |
| `skill_error` | Ошибка при вызове Skill. |
| `skill_step` | Шаг многошагового Skill. Поля `step`, `max`. |
| `skill_message` | Вопрос Skill пользователю. Поле `text`. |
| `skill_complete` | Skill завершён. Поле `text`. |
| `skill_content` | Содержимое SKILL.md (для редактора). Поля `content` или `error`. |
| `skill_create_result` | Результат создания Skill. Поля `success`, `error`. |
| `remote_command` | Команда от REST Bridge (для подтверждения/выполнения). Поля `commandId`, `command`, `requireConfirmation`. |

### Resize и закрытие

- После открытия соединения клиент может слать `resize` при изменении размера окна (например, по `ResizeObserver` или `window.resize`). Сервер вызывает `stream.setWindow(rows, cols, 0, 0)`.
- Закрытие: клиент может отправить `close` (завершение shell) или просто закрыть WebSocket. Сервер при закрытии потока/сокета закрывает SSH-соединение и удаляет сессию из REST Bridge.

### Session ID и REST Bridge

После успешного запуска shell сервер отправляет сообщение `{ type: 'session', sessionId: '<uuid>' }`. Этот `sessionId` используется REST API для отправки команд в этот же терминал:

- `GET /api/ws-terminal/sessions` — список активных WS-сессий (sessionId, serverId, serverName, connectedAt).
- `POST /api/ws-terminal/:sessionId/command` — отправить команду в терминал (см. ниже).
- `GET /api/ws-terminal/command/:commandId` — статус/результат команды.
- `DELETE /api/ws-terminal/command/:commandId` — отменить ожидающую команду.

На странице `/term.html` Session ID показывается в углу; по клику копируется в буфер.

---

## REST API терминала (v1 и v2)

Используется для «одна сессия — одна или несколько команд» без интерактивного ввода. Подходит для скриптов и тестов.

### v1

- **Создать сессию:** `POST /api/v1/terminal/sessions`  
  Body: `{ "serverId": "usa" }`.  
  Ответ: `201` + `{ "sessionId": "<uuid>" }`.
- **Выполнить команду:** `POST /api/v1/terminal/sessions/:sessionId/exec`  
  Body: `{ "command": "ls -la", "timeout": 30000 }` (timeout в мс, по умолчанию 30000).  
  Ответ: `200` + `{ "exitCode", "signal", "stdout", "stderr" }`.
- **Закрыть сессию:** `DELETE /api/v1/terminal/sessions/:sessionId`.  
  Ответ: `200` + `{ "message": "Session closed" }`.

При ошибках возвращаются `4xx`/`5xx` и `{ "error": "..." }`.

### v2

Тот же сценарий, ответы приведены к единому формату:

- Успех: `{ "success": true, "data": { ... } }`.
- Ошибка: `{ "success": false, "error": { "message": "..." } }`.

Эндпоинты:
- `POST /api/v2/terminal/sessions` — body `{ "serverId" }` → `data: { sessionId }`.
- `POST /api/v2/terminal/sessions/:sessionId/exec` — body `{ "command", "timeout" }` → `data: { exitCode, signal, stdout, stderr }`.
- `DELETE /api/v2/terminal/sessions/:sessionId` → `data: { message }`.

Сессии общие с v1 (хранятся в `server/terminal.js`). Таймаут неактивности сессии — 10 минут; фоновый интервал очистки — 1 минута.

---

## REST Bridge: команды в WebSocket-терминал

Позволяет отправить команду в уже открытый интерактивный терминал (например, в браузере) и опционально дождаться результата.

- **Список сессий:** `GET /api/ws-terminal/sessions`  
  Ответ: `{ "success": true, "data": [ { "sessionId", "serverId", "serverName", "connectedAt" } ] }`.

- **Отправить команду:** `POST /api/ws-terminal/:sessionId/command`  
  Body:
  - `command` (обязательный) — строка команды.
  - `requireConfirmation` (по умолчанию `false`) — показывать ли в браузере панель подтверждения перед выполнением.
  - `timeout` (мс, по умолчанию 60000) — для режима `wait=true`.
  - `wait` (по умолчанию `false`) — ждать ли завершения команды и возвращать результат в ответе.

  Если `wait === false`: ответ сразу `{ "success": true, "data": { "commandId", "status" } }`. Результат потом можно забрать по `GET /api/ws-terminal/command/:commandId` или клиент пришлёт `command_result` по WS.

  Если `wait === true`: запрос блокируется до выполнения команды (или таймаута), в ответе `data`: `commandId`, `status`, `stdout`, `stderr`, `exitCode`.

- **Статус/результат команды:** `GET /api/ws-terminal/command/:commandId`.  
  Ответ: `data`: `commandId`, `sessionId`, `command`, `status`, `result`, `createdAt`.

- **Отмена:** `DELETE /api/ws-terminal/command/:commandId` — снять ожидающую команду (и таймаут на стороне сервера).

Определение «команда выполнена» на клиенте делается по появлению промпта в выводе (regex `\w+@\w+[^$#>]*[\$#>]\s*$`). Тогда клиент отправляет `command_result` с собранным stdout/stderr.

---

## Логирование команд

Все вводы и выводы интерактивного терминала (WebSocket) записываются в один общий лог-файл для связности команд и AI-запросов.

### Файл и API

- **Файл:** `logs/terminal/terminal_log.json` (относительно корня проекта).  
  Формат: JSON-массив объектов (каждая запись — один объект).
- **Чтение через API:** `GET /api/logs?sessionId=<sessionId>` — вернуть все записи или только для указанной сессии.

### Типы записей

| type | Описание | Основные поля |
|------|----------|----------------|
| `stdin` | Выполненная команда (ввод пользователя или от AI). | `id`, `sessionId`, `timestamp`, `executed_command`, `serverId`, `serverName`, `serverHost`, `ai_query_id?`, `skill_name?`, `skill_step?` |
| `stdout` | Вывод команды (очищенный от ANSI). | `id`, `sessionId`, `timestamp`, `terminal_output`, `stdin_id?`, `serverId`, `serverName`, `serverHost` |
| `stderr` | Вывод stderr. | Аналогично stdout. |
| `ai_query` | Запрос к AI (префикс `ai:`). | `id`, `sessionId`, `timestamp`, `user_ai_query`, `serverId`, `serverName`, `serverHost` |
| `skill_invoke` | Запуск Skill. | `id`, `sessionId`, `timestamp`, `skill_name`, `skill_params`, `user_prompt`, `serverId`, ... |

Связи:
- У записи `stdin` может быть `ai_query_id` — ID записи `ai_query`, по которой сгенерирована команда.
- У записи `stdout` может быть `stdin_id` — ID записи `stdin` (выполненной команды), к которой относится вывод.

Определение «команда завершилась» на сервере делается по появлению промпта в stdout (regex промпта); тогда последний накопленный вывод пишется в лог и привязывается к последней `stdin` записи.

### UI логов

- В дашборде: при наведении на плитку/терминал доступна интерактивная панель с логами.
- Отдельные страницы: `/logs.html` (фильтр по сессии и типу), `/raw-logs.html` (сырой JSON).

---

## AI в терминале

### Префикс команд

По умолчанию префикс — `ai:` (настраивается в `.env`: `AI_COMMAND_PREFIX`). В интерфейсе префикс запрашивается через `GET /api/config` (поле `aiCommandPrefix`).

### Поведение

1. Пользователь вводит строку вида `ai: покажи большие файлы` и нажимает Enter.
2. Клиент по перехвату Enter (например, в `term.html` — `attachCustomKeyEventHandler`) определяет, что строка начинается с префикса, и отправляет на сервер `{ type: 'ai_query', prompt: "<полная строка с промпта>" }`.
3. Сервер в `ws.js`:
   - Стирает ввод в shell (backspace по длине строки).
   - Пишет в лог запись `ai_query`.
   - Опционально читает контекст с удалённого сервера: `./.kosmos-panel/kosmos-panel.md` или `~/.config/kosmos-panel/kosmos-panel.md` (по SSH), добавляет его в системный промпт.
   - Вызывает OpenAI-совместимый API (из `.env`: `AI_KOSMOS_MODEL_BASE_URL`, `AI_MODEL` и т.д.), получает одну shell-команду.
   - Выполняет её в том же PTY (`stream.write(command + '\r')`) и создаёт связанную запись `stdin` с `ai_query_id`.
4. Вывод команды попадает в лог как `stdout` с `stdin_id`.

Таймаут запроса к AI — 15 секунд. При ошибке в терминал выводится `[AI Error] ...`.

Подробнее про переменные окружения и системные промпты: [README_AI.md](README_AI.md).

---

## Tail логов (WebSocket)

Отдельный эндпоинт для просмотра лога файла в реальном времени.

- **URL:** `ws://host/ws/tail`.
- **Параметры:** `serverId`, `path` (путь к файлу на сервере), `lines` (сколько последних строк выдать сразу, по умолчанию 200).

Сервер подключается по SSH и выполняет `tail -n <lines> -F <path>`. Вся выдача пересылается клиенту сообщениями `{ type: 'data', data }` и `{ type: 'err', data }`. Логирование в `terminal_log.json` для tail тоже выполняется (типы stdout/stderr).

Команда собирается для Linux; для Windows потребовалась бы отдельная логика.

---

## Где открывается терминал в UI

- **Дашборд:** меню действий по плитке сервера → «Терминал» (встроенное overlay с xterm).
- **Плавающие окна:** из того же меню — терминал в отдельном перетаскиваемом окне.
- **Отдельная вкладка/окно:** пункт «Терминал в новой вкладке» или прямая ссылка `/term.html?serverId=usa` (для tail: `mode=tail&serverId=usa&path=/var/log/syslog`).

В overlay и в плавающих окнах используется тот же протокол WebSocket; в `/term.html` — полный набор: Session ID, REST Bridge, AI, Skills, кнопка перехода к логам (`/logs.html?sessionId=...`).

---

## Кратко про Skills

Skills — многошаговые сценарии для AI (несколько команд и/или вопросов пользователю). Описание формата SKILL.md, форматы ответов AI (`[CMD]`, `[MESSAGE]`, `[DONE]`), локальные (проект `/.kosmos-panel/skills/`) и удалённые (`~/.config/kosmos-panel/skills/`) — см. [README_AI.md](README_AI.md). В терминале Skills доступны через кнопку «Skills» и сообщения WS `skills_list`, `skill_invoke` и др.; часть сценариев также обслуживается REST API `/api/skills` (см. основной README и AGENTS.md).

---

## Файлы бэкенда

- **server/ws.js** — WebSocket-обработчики `/ws/terminal` и `/ws/tail`, логика AI-запросов, Skills, запись в `terminal_log.json`, REST Bridge (wsSessions, pendingCommands).
- **server/terminal.js** — REST API v1/v2 (сессии, exec, закрытие).
- **server/ws-utils.js** — общие функции для SSH (findServer, resolvePrivateKey).
- **server.js** — регистрация маршрутов REST Bridge (`/api/ws-terminal/...`) и `/api/logs`, `/api/config`.

Фронт: **web/app.js** (overlay, плавающие окна), **web/term.html** (отдельная страница с полным функционалом).
