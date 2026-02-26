# Логи в Kosmos Panel

Документ описывает, как в Kosmos Panel устроено логирование: какие типы логов существуют, где они хранятся, как формируется формат записей и через какие API их можно читать.

---

## 1. Общее устройство логирования

В системе используется **два основных уровня логирования**:

1. **Текстовые лог-файлы по подсистемам**  
   - Файлы формата `<category>-YYYY-MM-DD.log` в каталоге `logs/`.  
   - Пишутся через общий модуль [`server/logger.js`](../server/logger.js).  
   - Используются для backend‑диагностики (`server`, `api`, `ws`, `terminal`, `skills`, `skills-api`, `skill-ai` и т.п.).

2. **Структурированные JSON-логи**  
   - `logs/terminal/terminal_log.json` — события интерактивного терминала (stdin/stdout/stderr, ai:‑команды, привязка к SSH‑серверу).  
   - `data/skills_log.json` — события работы Skills (запуск, шаги, вывод команд, вопросы пользователю, завершение).  

Оба JSON‑лога хранятся как **один JSON‑массив объектов**, в который новые записи дописываются через последовательную очередь (Promise‑queue), чтобы избежать гонок при одновременной записи.

---

## 2. Базовый текстовый логгер (`server/logger.js`)

### 2.1. Каталог и имена файлов

Файл: [`server/logger.js`](../server/logger.js)

- Каталог:
  - `LOGS_DIR = path.join(__dirname, '..', 'logs')`
  - При загрузке модуля — создание каталога, если не существует:
    - `fs.mkdirSync(LOGS_DIR, { recursive: true })`
- Имя файла:
  - Функция `getLogFilePath(category = 'app')`:
    - Дата: `new Date().toISOString().split('T')[0]` → `YYYY-MM-DD`.
    - Путь: `logs/<category>-YYYY-MM-DD.log`.
  - Примеры:
    - `logs/server-2026-02-21.log`
    - `logs/api-2026-02-21.log`
    - `logs/ws-2026-02-21.log`
    - `logs/skills-2026-02-21.log`
    - `logs/skills-api-2026-02-21.log` и т.п.

### 2.2. Формат строки лога

Функция `formatMessage(level, category, message, meta?)` формирует строку вида:

```
[ISO_TIMESTAMP] [LEVEL] [CATEGORY] MESSAGE {JSON(meta)?}
```

Пример:

```text
[2026-02-21T12:18:34.846Z] [INFO] [server] UI: http://localhost:3000
```

Где:

- `timestamp` — `new Date().toISOString()`
- `level` — `INFO` / `WARN` / `ERROR` / `DEBUG`
- `category` — произвольный идентификатор подсистемы (строка)
- `meta` — опциональный объект, сериализуется через `JSON.stringify(meta)`

### 2.3. Запись в stdout/stderr и файл

Публичный API:

```js
logger.info(category, message, meta?)
logger.warn(category, message, meta?)
logger.error(category, message, meta?)
logger.debug(category, message, meta?)
```

Поведение:

- `info` / `warn`:
  - Форматируют запись.
  - Пишут в `process.stdout` (одна строка).
  - Дописывают ту же строку в соответствующий лог‑файл (`appendFileSync`).
- `error`:
  - Пишет в `process.stderr`.
  - Дописывает в файл.
- `debug`:
  - Логируется **только если** установлена переменная окружения `DEBUG`.
  - Иначе не пишет ни в консоль, ни в файл.

Запись в файл:

```js
fs.appendFileSync(getLogFilePath(category), content);
```

Обёрнута в `try/catch`; ошибка записи выводится через `console.error`, чтобы избежать рекурсивного логирования.

### 2.4. Основные категории

Типичные значения `category`:

| Категория | Где используется |
|-----------|------------------|
| `server` | Запуск/остановка HTTP‑сервера, ошибки прослушивания порта (`server.js`) |
| `config` | Загрузка/перезагрузка `config.json` (`server.js`) |
| `api` | Ошибки REST‑эндпоинтов (`/api/config`, `/api/logs`, `/api/skills-logs` и др.) |
| `ws` | WebSocket‑подключения терминала и tail (`/ws/terminal`, `/ws/tail`) в `server/ws.js` |
| `terminal`, `terminal-api` | Логика SSH‑терминала через REST и WS (`server/terminal.js`, `server/ws.js`) |
| `ai`, `skill-ai` | Вызовы внешнего AI и разбор ответов (`server/skill-ai.js`) |
| `skills`, `skills-api` | Инфраструктура Skills через WS и REST (`server/ws.js`, `server/skills.js`) |

---

## 3. Структурированные логи терминала (`logs/terminal/terminal_log.json`)

### 3.1. Хранилище и очередь записи

Код: [`server/ws.js`](../server/ws.js), функции `appendToLog` и логика обработки `/ws/terminal`.

- Константа пути:

  ```js
  const LOG_FILE_PATH = path.join(__dirname, '..', 'logs', 'terminal', 'terminal_log.json');
  ```

- Алгоритм записи (`appendToLog(logEntry)`):
  1. Через `logQueue` (Promise‑цепочка) последовательно:
     - читает файл `terminal_log.json` (если есть),
     - парсит JSON в массив,
     - добавляет новый объект `logEntry`,
     - создаёт `logs/terminal/` при необходимости,
     - перезаписывает файл целиком (`JSON.stringify(logs, null, 2)`).
  2. Любые ошибки чтения/записи логируются через `logger.error('terminal', ...)`.

Таким образом, формат файла — **один JSON‑массив записей**, каждая запись — один объект события.

### 3.2. Структура записей и типы событий

Общие поля (для большинства типов):

| Поле | Описание |
|------|----------|
| `id` | UUID записи |
| `sessionId` | ID WebSocket‑терминала (используется REST‑мостом `/api/ws-terminal/...`) |
| `timestamp` | ISO‑время создания записи |
| `serverId`, `serverName`, `serverHost` | К какому серверу по SSH подключён терминал |

Типы событий (поле `type`):

| type | Описание | Дополнительные поля |
|------|----------|---------------------|
| `stdin` | Команда, выполненная в терминале | `executed_command`, опционально `ai_query_id`, `skill_name`, `skill_step` |
| `stdout` | Вывод команды (очищенный) | `terminal_output`, `stdin_id` |
| `stderr` | Вывод стандартного потока ошибок | Аналогично `stdout` |
| `ai_query` | Исходный запрос вида `ai: ...` | `user_ai_query` |
| `skill_invoke` | Запуск Skill из терминала (WS) | `skill_name`, `skill_params`, `user_prompt` |

### 3.3. Детекция завершения команды и очистка вывода

В `ws.js` для интерактивного терминала:

- stdout накапливается в `stdoutBuffer`.
- При каждом обновлении вызывается `checkForPromptAndFlush()`:
  - Используется regexp для промпта:

    ```js
    const promptRegex = /(\w+@[\w.-]+[^$#>]*[\$#>]\s*|[a-zA-Z]:\\[^>]*>\s*)$/m;
    ```

  - Если промпт найден:
    1. Всё, что **до промпта**, считается выводом команды (`commandOutput`).
    2. `commandOutput` очищается через `cleanOutputForAI(...)`:
       - удаление ANSI‑кодов,
       - удаление баннеров (Windows),
       - удаление промптов, дубликатов строк, пустых строк.
    3. Если вывод не является эхо `ai:`‑команды — создаётся запись `stdout`.
    4. После записи `stdout` — `stdin_id` сбрасывается.

Кроме логирования:

- Очищенный вывод **также отправляется подписчикам Skills** через `notifyOutputSubscribers(sessionId, cleanOutput)` (REST‑API / Skills интеграция).

### 3.4. API для чтения терминальных логов

Определено в [`server.js`](../server.js):

- **Эндпоинт:** `GET /api/logs`
- **Путь к файлу:** `path.join(__dirname, 'logs', 'terminal', 'terminal_log.json')`
- **Query‑параметр:**
  - `sessionId` (опционален) — фильтрация по полю `sessionId`.
- **Поведение:**
  - Если файл отсутствует (`ENOENT`) → возвращается пустой массив `[]`.
  - При ошибке чтения/парсинга:
    - Лог: `logger.error('api', 'Error reading or parsing log file', { error })`.
    - Ответ: HTTP 500 + `{ error: 'Failed to read or parse log file' }`.

---

## 4. Логи Skills (`data/skills_log.json`)

### 4.1. Хранилище и очереди записи

Код:

- REST Skills API: [`server/skills.js`](../server/skills.js)
- Skills через WebSocket‑терминал: [`server/ws.js`](../server/ws.js)

Обе части пишут в один и тот же файл:

```js
const SKILLS_LOG_PATH = path.join(__dirname, '..', 'data', 'skills_log.json');
```

Запись реализована через отдельную очередь `skillsLogQueue` (аналогично `logQueue` для терминала):

1. Чтение и парсинг существующего массива.
2. Добавление новых объектов.
3. Создание каталога `data/` при необходимости.
4. Перезапись `skills_log.json` целиком (pretty‑printed JSON).

При ошибках чтения/записи — лог через `logger.error('skills' | 'skills-api', ...)`.

### 4.2. Группировка по `skill_log_id`

Каждый запуск Skill (один сценарий с несколькими шагами) имеет **групповой идентификатор**:

- Поле: `skill_log_id` (UUID).
- Для REST `/api/skills/...`:
  - `skill_log_id` = `skillSessionId` (ID сессии Skills на backend).
- Для Skills в WebSocket‑терминале (`ws.js`):
  - `skill_log_id` генерируется один раз при `skill_invoke` и сохраняется в `activeSkill.skillLogId`.

Все записи, относящиеся к одному запуску Skill, можно собрать по `skill_log_id`.

### 4.3. Типы событий и поля

Общие поля:

| Поле | Описание |
|------|----------|
| `id` | UUID записи |
| `skill_log_id` | ID сценария Skill (группировочный ключ) |
| `session_id` | ID терминальной сессии (WS или REST) |
| `timestamp` | ISO‑время |
| `skill_name` | Имя Skill (из `SKILL.md` или из пути) |
| `serverId`, `serverName` | Сервер, на котором выполняется Skill |
| `step` | Номер шага (1..maxSteps) |

Типы событий:

| type | Описание | Дополнительные поля |
|------|----------|---------------------|
| `skill_start` | Запуск Skill | `skill_description`, `skill_params`, `user_prompt`, `ai_system_prompt`, `ai_messages_count`, `max_steps` |
| `skill_command` | AI вернул команду `[CMD]` | `command`, `ai_response`, опционально `ai_full_response`, `ai_messages_history`, `user_content_sent_to_ai` |
| `skill_ask` | AI запросил информацию `[ASK]` | `question`, `required`, `ai_response`, опционально `ai_full_response`, `ai_messages_history` |
| `skill_message` | Информационное сообщение `[MESSAGE]` | `message`, `ai_response` |
| `skill_user_input` | Ответ пользователя на вопрос Skill | `user_input` |
| `skill_command_output` | Вывод команды, выполненной Skill | `command_output_raw`, `command_output_cleaned`, `output_source` |
| `skill_complete` | Завершение сценария | `final_message`, `ai_response`, опционально `ai_full_response` |

WebSocket‑ветка (`server/ws.js`) пишет события аналогичных типов, обычно с чуть менее подробным контекстом, но с тем же `skill_log_id`.

### 4.4. API для чтения логов Skills

- **Эндпоинт:** `GET /api/skills-logs` (см. [`server.js`](../server.js))
- **Путь к файлу:** `path.join(__dirname, 'data', 'skills_log.json')`
- **Query‑параметры:**
  - `sessionId` — фильтровать по `log.session_id`.
  - `skillLogId` — фильтровать по `log.skill_log_id`.
- **Поведение:**
  - Если файл отсутствует → возвращается `[]`.
  - При ошибке чтения/парсинга:
    - Логируется `logger.error('api', 'Error reading or parsing skills log file', { error })`.
    - Ответ: HTTP 500 + `{ error: 'Failed to read or parse skills log file' }`.

---

## 5. Практическое использование

### 5.1. Где посмотреть текстовые логи по датам

Каталог `logs/`, либо конкретные файлы по подсистемам:

- `server-YYYY-MM-DD.log`
- `api-YYYY-MM-DD.log`
- `ws-YYYY-MM-DD.log`
- `terminal-YYYY-MM-DD.log`
- `skills-YYYY-MM-DD.log`
- `skills-api-YYYY-MM-DD.log`

### 5.2. Как отследить полную цепочку "ai: → команда → вывод"

1. Найти запись `ai_query` по `user_ai_query` и `sessionId` в `terminal_log.json`.
2. По её `id` найти запись `stdin` с `ai_query_id`.
3. По `stdin.id` найти `stdout`/`stderr` с `stdin_id`.

### 5.3. Как собрать историю одного Skill

1. В `skills_log.json` найти все записи с нужным `skill_log_id`.
2. Отфильтровать по `type` (`skill_start` → ... → `skill_complete`).
3. Смотреть поля `step`, `skill_command_output`, `skill_user_input`, `ai_full_response` при необходимости.

---

## Связанные документы

- [README_terminal.md](./README_terminal.md) — общее описание терминала (WS/REST).
- [README_AI_SKILLS.md](./README_AI_SKILLS.md) — описание формата SKILL.md и протокола AI.
