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

1. Получить текущий путь и проверить .gitignore
   [CMD] pwd
   [CMD] cat .gitignore 2>/dev/null || echo 'no .gitignore'

2. Обойти папки (приоритет README, KB, server, web; игнорировать всё из .gitignore)

3. Для каждого важного файла:
   - [CMD] cat файл
   - [STORE] MEMORY_file_summary_путь_к_файлу.md
     Первый абзац — краткий summary (1-2 предложения)
     Остальное — ключевые моменты

4. Создать общие заметки:
   - [STORE] MEMORY_project_overview.md
   - [STORE] MEMORY_folder_structure.md

5. [DONE] Проект изучен, обновлено X заметок.

## When to use me

- После git pull
- Когда нужно обновить знания о проекте
- Перед новыми задачами

## Important

- Всегда используй [MESSAGE] перед важными командами.
- Перезаписывай заметки, если файл изменился.
- Используй .gitignore для игнора.

Удачного изучения!
