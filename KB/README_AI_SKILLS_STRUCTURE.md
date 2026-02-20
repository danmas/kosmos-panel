# Структура запросов и ответов LLM для AI Skills

Документ описывает формат взаимодействия с LLM при выполнении многошаговых Skills.

---

## Обзор

Система использует **OpenAI-совместимый API** для отправки запросов к LLM. Каждый шаг skill формирует запрос с накопленной историей сообщений и получает структурированный ответ.

```
┌─────────────────────────────────────────────────────────────────┐
│                         LLM REQUEST                              │
├─────────────────────────────────────────────────────────────────┤
│  POST /v1/chat/completions                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ messages: [                                                │  │
│  │   { role: "system",    content: <System Prompt> },         │  │
│  │   { role: "user",      content: <User Message 1> },        │  │
│  │   { role: "assistant", content: <AI Response 1> },         │  │
│  │   { role: "user",      content: <User Message 2> },        │  │
│  │   ...                                                      │  │
│  │ ]                                                          │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         LLM RESPONSE                             │
├─────────────────────────────────────────────────────────────────┤
│  choices[0].message.content:                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ [CMD] | [ASK] | [ASK:optional] | [MESSAGE] | [DONE]        │  │
│  │ <content>                                                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. Структура HTTP-запроса к LLM

### Endpoint

```
POST {AI_KOSMOS_MODEL_BASE_URL}/chat/completions
```

По умолчанию: `http://localhost:3002/v1/chat/completions`

### Request Body

```json
{
  "model": "CHEAP",
  "messages": [ ... ],
  "temperature": 0.3,
  "max_tokens": 512
}
```

| Поле | Тип | Описание | Значение по умолчанию |
|------|-----|----------|----------------------|
| `model` | string | Идентификатор модели | `AI_MODEL` из config.json |
| `messages` | array | Массив сообщений (история диалога) | — |
| `temperature` | number | Творческость ответа (0.0–1.0) | `0.3` |
| `max_tokens` | number | Максимум токенов в ответе | `512` |

### Таймауты

- Таймаут HTTP-запроса: **30 секунд**
- Таймаут чтения remote knowledge: **5 секунд**
- Таймаут загрузки remote skill: **5 секунд**

---

## 2. Структура массива `messages`

Массив `messages` содержит всю историю диалога. Каждое сообщение имеет структуру:

```json
{
  "role": "system" | "user" | "assistant",
  "content": "<текст сообщения>"
}
```

### Роли сообщений

| Роль | Описание |
|------|----------|
| `system` | Системный промпт (инструкции для AI). Всегда первый в массиве. |
| `user` | Сообщение от пользователя или системы (запрос, вывод команды). |
| `assistant` | Ответ AI (предыдущие шаги). |

### Порядок сообщений при выполнении skill

```
messages[0]: system    → Системный промпт (неизменный на протяжении skill)
messages[1]: user      → Начальный запрос [Step 1 of 100]
messages[2]: assistant → Ответ AI (например, [CMD] git status)
messages[3]: user      → Вывод команды [Step 2 of 100]
messages[4]: assistant → Ответ AI (например, [ASK] Введи commit message)
messages[5]: user      → Ответ пользователя [Step 3 of 100]
...
```

---

## 3. System Message (Системный промпт)

Системный промпт формируется функцией `buildSkillSystemPrompt()` и состоит из трёх частей:

```
┌──────────────────────────────────────────────────────────────────┐
│                      SYSTEM MESSAGE                               │
├──────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ 1. БАЗОВЫЙ ПРОМПТ (SKILL_SYSTEM_PROMPT_WITH_ASK)           │  │
│  │    Инструкции по форматам ответов:                          │  │
│  │    [CMD], [ASK], [ASK:optional], [MESSAGE], [DONE]          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                              +                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ 2. КОНТЕКСТ СЕРВЕРА (опционально)                          │  │
│  │    --- System Context ---                                   │  │
│  │    <содержимое ai_system_promt.md с удалённого сервера>     │  │
│  └────────────────────────────────────────────────────────────┘  │
│                              +                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ 3. АКТИВНЫЙ SKILL                                          │  │
│  │    --- Active Skill: <название> ---                         │  │
│  │    <содержимое SKILL.md без frontmatter>                    │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 3.1. Базовый промпт

Хранится в `prompts.json` под ключом `SKILL_SYSTEM_PROMPT_WITH_ASK`:

```
You are a terminal AI assistant executing a multi-step skill.

RESPONSE FORMAT - Use EXACTLY ONE of these formats per response:

1. [CMD] command_here
   Execute this shell command. You will receive the command output.

2. [ASK] question here
   Ask the user a question and WAIT for their required response.
   Use this when you MUST have user input (commit message, confirmation, choice).
   Examples: "Введи сообщение коммита:", "Продолжить? (yes/no):"

3. [ASK:optional] question here
   Ask the user an optional question. They can skip by pressing Enter.
   Example: "Хочешь добавить тег? (оставь пустым для пропуска):"

4. [MESSAGE] informational text here
   Show an informational message and CONTINUE immediately without waiting.
   Use for progress updates, status messages, warnings.
   Examples: "Обрабатываю папку 1 из 3...", "Проверяю ветку dev..."

5. [DONE] final message here
   The skill is complete. Show this final message to the user.

RULES:
- Always start your response with [CMD], [ASK], [ASK:optional], [MESSAGE], or [DONE]
- Only ONE format per response
- [CMD]: provide only the command, no explanations
- [ASK]: BLOCKS execution - user MUST respond (required input)
- [ASK:optional]: BLOCKS execution - user CAN respond or skip (optional input)
- [MESSAGE]: does NOT block - execution continues automatically (info only)
- [DONE]: summarize what was accomplished
```

### 3.2. Контекст сервера (Remote Knowledge)

Читается с удалённого сервера через SSH. Пути поиска:
1. `./.kosmos-panel/ai_system_promt.md` (текущая директория)
2. `~/.config/kosmos-panel/ai_system_promt.md` (домашняя директория)

Добавляется в промпт как:
```
--- System Context ---
<содержимое файла>
```

### 3.3. Активный Skill

Содержимое файла SKILL.md (без YAML frontmatter) добавляется как:
```
--- Active Skill: git-quick-commit ---
## What I do

Я выполняю следующие шаги:
1. Запускаю `git status --porcelain`
2. Если есть изменения, спрашиваю сообщение для коммита
...
```

---

## 4. User Messages (Сообщения пользователя)

В зависимости от контекста, user message формируется по-разному:

### 4.1. Начальный запрос (Step 1)

Формируется функцией `buildInitialUserPrompt()`:

```
Execute skill: <название skill>

Parameters:
- param1: value1
- param2: value2

[Step 1 of 100]
```

Или с кастомным промптом:
```
<пользовательский промпт>

Parameters:
- param1: value1

[Step 1 of 100]
```

### 4.2. После выполнения команды

```
Command output:
<очищенный вывод команды>

[Step N of 100]
```

Вывод очищается функцией `cleanOutputForAI()`:
- Удаляются ANSI escape-последовательности
- Удаляются промпты терминала (Windows/Linux)
- Удаляются баннеры Microsoft Windows
- Удаляются пустые строки и дубликаты

### 4.3. После пропуска команды

```
User skipped the command.

[Step N of 100]
```

### 4.4. После ответа пользователя на вопрос

```
User response: <ответ пользователя>

[Step N of 100]
```

### 4.5. После информационного сообщения (MESSAGE)

```
[Continue after informational message]

[Step N of 100]
```

---

## 5. Assistant Messages (Ответы AI)

AI всегда отвечает в одном из пяти форматов. Парсинг выполняется функцией `parseSkillResponse()`.

### 5.1. Формат `[CMD]` — Выполнить команду

```
[CMD] git status --porcelain
```

**Результат парсинга:**
```json
{
  "type": "CMD",
  "content": "[CMD] git status --porcelain",
  "command": "git status --porcelain"
}
```

**Поведение:** Система переходит в состояние `waiting_cmd`, ожидая выполнения команды.

### 5.2. Формат `[ASK]` — Обязательный вопрос

```
[ASK] Введи сообщение коммита:
```

**Результат парсинга:**
```json
{
  "type": "ASK",
  "content": "[ASK] Введи сообщение коммита:",
  "question": "Введи сообщение коммита:",
  "required": true
}
```

**Поведение:** Система переходит в состояние `waiting_user`, блокируя выполнение до ответа.

### 5.3. Формат `[ASK:optional]` — Опциональный вопрос

```
[ASK:optional] Хочешь добавить тег? (оставь пустым для пропуска):
```

**Результат парсинга:**
```json
{
  "type": "ASK",
  "content": "[ASK:optional] Хочешь добавить тег?...",
  "question": "Хочешь добавить тег? (оставь пустым для пропуска):",
  "required": false
}
```

**Поведение:** Система переходит в состояние `waiting_user`, но пользователь может пропустить (Enter).

### 5.4. Формат `[MESSAGE]` — Информационное сообщение

```
[MESSAGE] Обрабатываю папку 1 из 3...
```

**Результат парсинга:**
```json
{
  "type": "MESSAGE",
  "content": "[MESSAGE] Обрабатываю папку 1 из 3...",
  "message": "Обрабатываю папку 1 из 3..."
}
```

**Поведение:** Сообщение отображается, выполнение продолжается автоматически (состояние `idle`).

### 5.5. Формат `[DONE]` — Завершение skill

```
[DONE] Коммит успешно создан: abc1234
```

**Результат парсинга:**
```json
{
  "type": "DONE",
  "content": "[DONE] Коммит успешно создан: abc1234",
  "message": "Коммит успешно создан: abc1234"
}
```

**Поведение:** Skill завершается, состояние переходит в `done`.

### 5.6. Неизвестный формат

Если AI не использовал стандартный формат, первая строка ответа трактуется как команда:

```json
{
  "type": "CMD",
  "content": "[CMD] <первая строка>",
  "command": "<первая строка>"
}
```

---

## 6. Полный пример диалога

### Запуск skill `git-quick-commit`

**Шаг 1: Начальный запрос**

```json
{
  "model": "CHEAP",
  "messages": [
    {
      "role": "system",
      "content": "You are a terminal AI assistant...\n\n--- Active Skill: git-quick-commit ---\n## What I do\n..."
    },
    {
      "role": "user",
      "content": "Execute skill: git-quick-commit\n\n[Step 1 of 100]"
    }
  ],
  "temperature": 0.3,
  "max_tokens": 512
}
```

**Ответ AI:**
```
[CMD] git status --porcelain
```

---

**Шаг 2: После выполнения команды**

```json
{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "Execute skill: git-quick-commit\n\n[Step 1 of 100]" },
    { "role": "assistant", "content": "[CMD] git status --porcelain" },
    { "role": "user", "content": "Command output:\n M server/skills.js\n?? new-file.txt\n\n[Step 2 of 100]" }
  ]
}
```

**Ответ AI:**
```
[ASK] Введи сообщение коммита:
```

---

**Шаг 3: После ответа пользователя**

```json
{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "Execute skill: git-quick-commit\n\n[Step 1 of 100]" },
    { "role": "assistant", "content": "[CMD] git status --porcelain" },
    { "role": "user", "content": "Command output:\n M server/skills.js\n\n[Step 2 of 100]" },
    { "role": "assistant", "content": "[ASK] Введи сообщение коммита:" },
    { "role": "user", "content": "User response: fix: update skills API\n\n[Step 3 of 100]" }
  ]
}
```

**Ответ AI:**
```
[CMD] git add . && git commit -m "fix: update skills API"
```

---

**Шаг 4: Завершение**

```json
{
  "messages": [
    ...
    { "role": "assistant", "content": "[CMD] git add . && git commit -m \"fix: update skills API\"" },
    { "role": "user", "content": "Command output:\n[main abc1234] fix: update skills API\n 1 file changed, 5 insertions(+)\n\n[Step 4 of 100]" }
  ]
}
```

**Ответ AI:**
```
[DONE] Коммит успешно создан: abc1234. Изменён 1 файл.
```

---

## 7. Диаграмма состояний Skill-сессии

```
                    ┌─────────┐
                    │  START  │
                    └────┬────┘
                         │
                         ▼
                    ┌─────────┐
         ┌─────────│  idle   │◄────────────────┐
         │         └────┬────┘                 │
         │              │                      │
         │    AI returns [CMD]        AI returns [MESSAGE]
         │              │                      │
         │              ▼                      │
         │    ┌──────────────────┐             │
         │    │   waiting_cmd    │─────────────┘
         │    └────────┬─────────┘     (auto-continue)
         │             │
         │    Command executed
         │             │
         │             ▼
         │    ┌──────────────────┐
         │    │   AI processes   │
         │    │   output         │
         │    └────────┬─────────┘
         │             │
         │    ┌────────┼────────┐
         │    │        │        │
         │   [CMD]   [ASK]   [DONE]
         │    │        │        │
         │    ▼        ▼        ▼
         │ waiting_  waiting_  ┌──────┐
         │   cmd      user     │ done │
         │    │        │       └──────┘
         │    │        │
         │    │   User responds
         │    │        │
         │    └────────┴───────►  AI processes
         │                              │
         └──────────────────────────────┘
```

---

## 8. Реализация в коде

| Модуль | Функция | Описание |
|--------|---------|----------|
| `server/skill-ai.js` | `buildSkillSystemPrompt()` | Собирает системный промпт из 3 частей |
| `server/skill-ai.js` | `buildInitialUserPrompt()` | Формирует первый user message |
| `server/skill-ai.js` | `callSkillAI()` | Выполняет HTTP-запрос к LLM |
| `server/skill-ai.js` | `parseSkillResponse()` | Парсит ответ AI в структуру |
| `server/skill-ai.js` | `cleanOutputForAI()` | Очищает вывод терминала от мусора |
| `server/skill-ai.js` | `getRemoteKnowledge()` | Читает ai_system_promt.md по SSH |
| `server/skills.js` | REST API endpoints | Управление skill-сессиями |
| `server/ws.js` | WebSocket handlers | Real-time взаимодействие |

---

## Связанные документы

- [README_AI_SKILLS.md](./README_AI_SKILLS.md) — Общее описание AI Skills
- [README_AI.md](./README_AI.md) — Обзор AI-функциональности
- [README_AI_promt.md](./README_AI_promt.md) — Тексты системных промптов

---

**Последнее обновление:** 2026-02-20
