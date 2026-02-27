# AI Skills в Kosmos Panel

Skills — это переиспользуемые prompt-инструкции для AI, которые позволяют автоматизировать типовые **многошаговые** задачи. Каждый skill представляет собой SKILL.md файл с инструкциями для AI.

## Ключевые возможности

- **Многошаговое выполнение** — skill может выполнять до 100 команд подряд
- **Интерактивность** — AI может запрашивать ввод от пользователя (например, commit message)
- **Контекст** — AI видит вывод каждой команды и принимает решения на основе результата
- **Два источника** — skills загружаются из локального проекта и удалённого сервера
- **Вложенные папки** — поддержка структуры каталогов (дерево)
- **Автоматическое определение ОС** — при подключении определяется тип ОС (`uname -s`), и в промпт добавляется информация о целевой системе (Linux/macOS/Windows), чтобы AI генерировал правильные команды
- **Долговременная память** — skills могут сохранять и извлекать данные между сессиями через файлы `MEMORY_*.md`

## Расположение skills

### 1. Сервер kosmos-panel (в репозитории):
```
/.kosmos-panel/skills/
├── win/
│   ├── git-quick-commit/
│   │   └── SKILL.md
│   ├── git-main-merge-dev/
│   │   └── SKILL.md
│   └── multi-repo-commit-dev/
│       └── SKILL.md
├── lin/
│   └── get_import_latest_dump/
│       └── SKILL.md
└── check-openssh-server/
    └── SKILL.md
```

### 2. Удалённый сервер (в домашней директории пользователя):
```
~/.config/kosmos-panel/skills/
├── git-quick-commit/
│   └── SKILL.md
├── docker-logs/
│   └── SKILL.md
└── find-large-files/
    └── SKILL.md
```

## Отображение в UI

Skills отображаются в виде дерева с отступами, повторяющего структуру каталогов:
- `Project: /.kosmos-panel/skills` — skills с сервера kosmos-panel
- `Remote: ~/.config/kosmos-panel/skills` — skills с удалённого сервера

Вложенные папки отображаются с соответствующими отступами (📁 для директорий).

## Формат SKILL.md

```markdown
---
name: git-quick-commit
description: Проверить незакоммиченные изменения и закоммитить
params:
  - name: message
    description: Сообщение коммита
    required: false
---
## What I do

Я выполняю следующие шаги:

1. Запускаю `git status --porcelain`
2. Если есть изменения, спрашиваю сообщение для коммита
3. Выполняю `git add .` и `git commit -m "<сообщение>"`

## When to use me

Используй для быстрого коммита всех изменений.
```

## Как вызвать skill

- Нажать кнопку **Skills** в терминале → выбрать skill → ввести параметры → Выполнить

## Как создать skill

- В диалоге Skills нажать кнопку **+** у нужной папки
- Ввести имя skill (латиница, без пробелов)
- Ввести содержимое SKILL.md (с frontmatter)
- Нажать **Сохранить**

Skills можно создавать как локально (Project), так и на удалённом сервере (Remote).

## Формирование первого промпта для Skill

Первый запрос к AI при запуске скилла формируется динамически в `server/skill-ai.js` → `buildSkillSystemPrompt()` и состоит из двух частей:

1. **System Message (Системная инструкция)**:
   - **Информация о целевой ОС**: в начало промпта автоматически добавляется блок с типом ОС и примерами команд:
     ```
     --- Target OS: Linux ---
     Use POSIX/GNU commands. Examples:
     - List files: ls -la
     - Read file: cat file
     ```
   - **Базовый промпт**: содержимое `SKILL_SYSTEM_PROMPT_WITH_MEMORY` из `prompts.json` (инструкции по форматам `[CMD]`, `[ASK]`, `[STORE]`, `[RETRIEVE]` и т.д.).
   - **Контекст сервера (RAG)**: если на удаленном сервере есть файлы `./.kosmos-panel/kosmos-panel.md` или `~/.config/kosmos-panel/kosmos-panel.md`, их содержимое добавляется в блок `--- System Context ---`.
   - **Активный скилл**: содержимое файла `SKILL.md` выбранного скилла добавляется в блок `--- Active Skill: Название ---`.
   - **Индекс памяти**: блок `--- Current Memory Index ---` с summary всех файлов памяти.

2. **User Message (Начальный запрос)**:
   - **Команда запуска**: текст `Execute skill: [Name]` или кастомный промпт пользователя.
   - **Параметры**: если переданы параметры скилла, они добавляются списком `Parameters: - key: value`.
   - **Маркер шага**: обязательный технический заголовок `[Step 1 of 100]`.

---

## Протокол ответов AI для skills (единый для WS и REST)

AI отвечает в одном из форматов (описание и парсинг в `server/skill-ai.js`):

**Основные команды:**
- `[CMD] команда` — выполнить shell-команду (для правильной ОС!), AI получит вывод
- `[ASK] вопрос` — задать вопрос и **ждать обязательного ответа** пользователя
- `[ASK:optional] вопрос` — задать вопрос, пользователь может пропустить (Enter)
- `[MESSAGE] текст` — показать информационное сообщение и **сразу продолжить** (без ожидания ввода)
- `[DONE] текст` — skill завершён, показать итоговое сообщение

**Команды работы с памятью:**
- `[STORE] MEMORY_filename.md\nсодержимое` — сохранить файл в долговременную память
- `[RETRIEVE] MEMORY_filename.md` — извлечь файл из памяти
- `[LIST_MEMORY]` — получить список всех файлов памяти
- `[APPEND_MEMORY] MEMORY_filename.md\nсодержимое` — дописать в конец файла
- `[DELETE_MEMORY] MEMORY_filename.md` — удалить файл памяти

## WS-сообщения

### Клиент → Сервер:
- `{type: "skills_list"}` — запросить список skills
- `{type: "skill_invoke", name, path, source, params, prompt}` — запустить skill
  - `name` — имя skill (из frontmatter)
  - `path` — относительный путь (например, `win/git-quick-commit` или `check-openssh-server`)
  - `source` — источник: `"project"` или `"remote"`
  - `params` — объект с параметрами
  - `prompt` — дополнительный промпт от пользователя
- `{type: "skill_user_input", text}` — ответ пользователя на вопрос AI
- `{type: "skill_cancel"}` — отменить активный skill
- `{type: "skill_create", source, path, name, content}` — создать новый skill
  - `source` — `"project"` или `"remote"`
  - `path` — относительный путь к папке (может быть пустым для корня)
  - `name` — имя нового skill (имя папки)
  - `content` — содержимое SKILL.md

### Сервер → Клиент:
- `{type: "skills_list", skills: [...]}` — список skills
  - Каждый skill содержит: `{id, name, description, params, path, source}`
- `{type: "skill_step", step, max}` — текущий шаг (1-100)
- `{type: "skill_create_result", success, error}` — результат создания skill
- `{type: "skill_message", text, required?}` — вопрос от AI (ждёт ввода; `required: false` для опционального)
- `{type: "skill_complete", text}` — skill завершён
- `{type: "skill_error", error}` — ошибка

## Технические детали

- **Определение ОС**: При подключении по SSH выполняется `uname -s`. Результат (`linux`, `darwin`, `windows`) кэшируется и добавляется в промпт через `buildSkillSystemPrompt(..., remoteOS)`
- Skills читаются с удалённого сервера через SSH при каждом вызове (remote); локальные — с диска проекта (project)
- Максимум 100 шагов (итераций) на один skill
- Таймаут на выполнение команды: 30 секунд (в REST API — на запрос к AI тоже 30 с)
- История сообщений сохраняется для контекста AI
- Единый системный промпт и парсинг ответов в `server/skill-ai.js` (используют и ws.js, и skills.js)
- Поддержка knowledge файлов с удалённого сервера (`./.kosmos-panel/kosmos-panel.md` или `~/.config/kosmos-panel/kosmos-panel.md`)
- **Долговременная память**: Файлы `MEMORY_*.md` хранятся в `.kosmos-panel/memory/` на сервере панели

## Реализация

- `server/skill-ai.js` — общий модуль: системный промпт, `buildSkillSystemPrompt()`, `parseSkillResponse()`, `callSkillAI()`, `getRemoteKnowledge()`
- Backend WebSocket: `server/ws.js`
  - `getProjectSkills()`, `getRemoteSkills()`, `getProjectSkill()`, `getRemoteSkill()` — загрузка списка и контента skills
  - использует `buildSkillSystemPrompt`, `parseSkillResponse`, `getRemoteKnowledge` из `skill-ai.js`
  - `activeSkill` state, `processSkillResponse()` по единому протоколу, хук в `checkForPromptAndFlush()`
- Backend REST API: `server/skills.js` — `POST /api/skills/start`, `/:id/message`, `/:id/continue` и др.; использует `skill-ai.js`
- Frontend:
  - `web/term.html` — standalone-терминал с плавающим окном Skills
  - `web/workspace.html` + `web/workspace.js` — Workspace-режим (терминал + логи + Skills в левой панели)
  - Оба клиента используют одинаковую модель поведения Enter и обработки выводов для Skills

## Поведение Enter для шагов Skills

Когда AI возвращает шаг `[CMD]`:

- Клиент (`term.html` или `workspace.js`) переводит сессию Skills в состояние `waiting_cmd` и:
  - показывает в UI блок **«Предложена команда»** с текстом команды;
  - вставляет команду в терминал через `term.paste(...)` и ждёт нажатия Enter.
- При **любом непустом Enter в состоянии `waiting_cmd`**:
  - текущая строка терминала (после промпта) считается **результирующей командой шага**, даже если пользователь **изменил** предложенную команду;
  - клиент начинает собирать вывод команды:
    - в браузере — в `skillDialogState.outputBuffer` (все чанки `data/err` за время выполнения);
    - на сервере — через `subscribeToOutput(...)` в `server/skills.js` (последние 7 строк `session.outputBuffer`);
  - через небольшой таймаут (сейчас ~2 секунды, чтобы дождаться вывода) клиент вызывает:
    - `GET /api/skills/:skillSessionId/output` (фоллбек, если локальный буфер пуст);
    - `POST /api/skills/:skillSessionId/command-result` с полем `stdout`, собранным из:
      - локального буфера браузера **или**
      - серверного `session.outputBuffer` (если локальный буфер пуст).
- После `command-result`:
  - REST-слой формирует для AI сообщение вида  
    `Command output:\n<очищенный вывод>\n\n[Step N of M]`;
  - вызывает `callSkillAI(...)`, парсит ответ через `parseSkillResponse(...)` и возвращает следующий шаг (`CMD` / `ASK` / `MESSAGE` / `DONE`) в браузер.

Важно:

- **Сравнения текста команды больше нет** — результат шага всегда основан на фактическом выводе той команды, которая реально была запущена пользователем в терминале в состоянии `waiting_cmd`. Это позволяет:
  - править команду, добавлять флаги, менять путь и т.п.;
  - запускать вообще другую команду, если так удобнее, а Skill просто продолжит с её выводом.
- Специальные команды:
  - `skill:skip` — пропуск шага без выполнения команды:
    - не отправляется в shell, строка очищается (`Ctrl+U`);
    - клиент сразу шлёт `POST /api/skills/:id/command-result { skipped: true }`;
  - `skill:cancel` — полная отмена Skills-сессии:
    - не отправляется в shell;
    - клиент вызывает `DELETE /api/skills/:id`, переводит состояние в `done` и сохраняет сессию в историю с `status: cancelled`.
- В standalone-терминале (`term.html`) дополнительно есть кнопка **«Я выполнил команду»**:
  - это запасной ручной путь: если Enter не был перехвачен (нестандартный случай), пользователь может нажать кнопку, и клиент соберёт вывод из буферов и вызовет `command-result` явно.

## Последнее обновление

2026-01-26