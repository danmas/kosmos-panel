---
name: study-project
description: Изучить проект, заполнить Постоянную Память заметками MEMORY_*.md
params:
  - name: path
    description: Путь к папке для изучения (по умолчанию .)
    required: false
---
## What I do

Я изучаю проект и заполняю Постоянную Память заметками MEMORY_*.md.

**Шаги (строго в порядке):**

1. Получить структуру проекта:
   [CMD] find . -type f -name "*.md" -o -name "*.js" -o -name "*.json" | head -50
   или для Windows:
   [CMD] dir /s /b *.md *.js *.json | findstr /v node_modules

2. Прочитать ключевые файлы через [GET-FILE] (предпочитай вместо cat):
   [GET-FILE] README.md
   [GET-FILE] package.json
   [GET-FILE] server/skills.js
   
3. Для каждого важного файла создать заметку:
   [STORE] MEMORY_server_skills_js.md
   Summary: REST API для skill sessions...
   
   Key points:
   - endpoint /start создаёт сессию
   - ...

4. Создать общие заметки:
   [STORE] MEMORY_project_overview.md
   [STORE] MEMORY_folder_structure.md

5. [DONE] Проект изучен, обновлено X заметок.

## Когда использовать [GET-FILE] vs [CMD]

- **[GET-FILE]** — для чтения файлов проекта (чистый текст, без shell-мусора)
- **[CMD]** — для листинга, поиска, git-команд

## When to use me

- После git pull
- Когда нужно обновить знания о проекте
- Перед новыми задачами

## Important

- Используй [GET-FILE] вместо cat для чтения файлов.
- Используй [MESSAGE] для информирования о прогрессе.
- Перезаписывай заметки, если файл изменился.
- Игнорируй node_modules, .git, build.
