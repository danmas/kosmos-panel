# Skills Floating Dialog Window

## Концепция

Создание нового floating окна для Skills, которое:
- Привязано к конкретной terminal session (sessionId)
- Отображает историю диалога с AI (MESSAGE, предложенные команды, output)
- Взаимодействует с терминалом через существующий REST API `/api/ws-terminal/:sessionId/command`
- Позволяет пользователю контролировать выполнение команд (Enter в терминале или `skill:skip`/`skill:cancel`)

---

## Часть 1: Backend - Новый REST API для Skills Manager

### 1.1 Новый файл `server/skills.js`

Создать модуль с endpoints:

```
POST /api/skills/start
  Body: { terminalSessionId, skillId, skillPath, skillSource, params?, prompt? }
  Response: { success, skillSessionId, initialMessage }

POST /api/skills/:skillSessionId/message  
  Body: { userMessage }
  Response: { success, aiResponse: { type: 'CMD'|'MESSAGE'|'DONE', content, command? } }

POST /api/skills/:skillSessionId/command-result
  Body: { stdout, stderr, exitCode, skipped: bool }
  Response: { success, aiResponse: { type, content, command? } }

GET /api/skills/:skillSessionId/output
  Response: { success, lastOutput: string (7 lines), fullHistory: [...] }

DELETE /api/skills/:skillSessionId
  Response: { success }
```

### 1.2 Skills Session Manager

В `server/skills.js` добавить in-memory storage:

```javascript
const skillSessions = {}; // { skillSessionId: { terminalSessionId, messages: [], step, state, outputBuffer } }
```

Логика:
- При старте создаётся сессия, отправляется первый запрос к AI
- AI отвечает в формате [CMD]/[MESSAGE]/[DONE]
- При [CMD] сервер буферизирует команду, ждёт результат от frontend
- При получении output (или skip) продолжает диалог с AI
- Хранит последние 7 строк output для отображения в окне Skills

### 1.3 Интеграция в `server.js`

Добавить:
```javascript
const skills = require('./server/skills');
app.use('/api/skills', skills.router);
```

---

## Часть 2: Frontend - Skills Dialog Window

### 2.1 HTML структура в `web/term.html`

Добавить после `.skills-popup` новый элемент:

```html
<!-- Skills Dialog Window (floating, draggable, resizable) -->
<div id="skillDialog" class="skill-dialog hidden">
  <div class="skill-dialog-header" id="skillDialogHeader">
    <span class="skill-dialog-title">Skill: <span id="skillDialogName">-</span></span>
    <button class="skill-dialog-close" onclick="closeSkillDialog()">×</button>
  </div>
  <div class="skill-dialog-body" id="skillDialogBody">
    <!-- Scrollable message history -->
  </div>
  <div class="skill-dialog-input">
    <div class="skill-quick-actions">
      <button onclick="sendSkillQuickReply('Да')">Да</button>
      <button onclick="sendSkillQuickReply('Нет')">Нет</button>
      <button onclick="sendSkillQuickReply('skill:skip')">Skip</button>
      <button onclick="sendSkillQuickReply('skill:cancel')">Cancel</button>
    </div>
    <input type="text" id="skillDialogInput" placeholder="Введите ответ...">
    <button onclick="sendSkillMessage()">Отправить</button>
  </div>
</div>
```

### 2.2 CSS стили в `web/term.html`

```css
.skill-dialog {
  position: absolute;
  top: 100px;
  left: 100px;
  width: 450px;
  height: 400px;
  min-width: 350px;
  min-height: 300px;
  background: linear-gradient(180deg, #1a2744 0%, #0e1322 100%);
  border: 2px solid #22c55e;
  border-radius: 8px;
  z-index: 1003;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7);
  resize: both;
  overflow: hidden;
}
.skill-dialog.hidden { display: none; }

/* Message types */
.skill-msg { padding: 8px 12px; margin: 4px 0; border-radius: 6px; }
.skill-msg-ai { background: #1e3a5f; border-left: 3px solid #4a9eff; }
.skill-msg-user { background: #2d4a3e; border-left: 3px solid #22c55e; }
.skill-msg-cmd { background: #3d2e1f; border-left: 3px solid #ffa500; }
.skill-msg-output { background: #1a1a2e; font-family: monospace; font-size: 12px; }
.skill-msg-thinking { color: #888; font-style: italic; }
```

### 2.3 JavaScript логика в `web/term.html`

Новые переменные:
```javascript
let skillDialog = { 
  sessionId: null,        // skill session ID
  terminalSessionId: null, // привязка к терминалу
  history: [],            // localStorage key
  pendingCommand: null    // команда ожидающая выполнения
};
```

Новые функции:

**Запуск скила:**
```javascript
async function startSkillDialog(skill) {
  // 1. Показать окно
  // 2. POST /api/skills/start { terminalSessionId: currentSessionId, skillId, ... }
  // 3. Показать initialMessage
  // 4. Если AI вернул [CMD] - показать "Предложена команда: X" + кнопки
}
```

**Обработка команды:**
```javascript
async function executeSkillCommand() {
  // 1. Вставить команду в терминал input (не выполнять!)
  // 2. Показать "Ожидание выполнения команды..."
}
```

**Отслеживание выполнения:**
```javascript
// Модифицировать term.attachCustomKeyEventHandler для Enter:
// Если pendingCommand != null и введённая команда совпадает:
//   - POST /api/skills/:sessionId/command-result { stdout, skipped: false }
//   - Продолжить диалог
// Если пользователь ввёл skill:skip:
//   - POST /api/skills/:sessionId/command-result { skipped: true }
// Если skill:cancel:
//   - DELETE /api/skills/:sessionId
```

**Получение output:**
```javascript
async function fetchSkillOutput() {
  // GET /api/skills/:sessionId/output
  // Показать последние 7 строк в окне
}
```

---

## Часть 3: Изменения в существующем коде

### 3.1 Модификация выбора скила в `term.html`

Изменить обработчик клика на `.skill-item`:
```javascript
// БЫЛО: ws.send({ type: 'skill_invoke', ... })
// СТАНЕТ: startSkillDialog(skill)
```

### 3.2 Интеграция с терминалом

В `term.html` добавить логику в `term.attachCustomKeyEventHandler`:
- Детектировать `skill:skip` и `skill:cancel`
- При совпадении команды с `skillDialog.pendingCommand` - уведомить Skills Manager

### 3.3 Буферизация output на сервере

В `server/skills.js`:
- Подключиться к `wsSessions[terminalSessionId]` 
- Слушать output через существующий WebSocket
- Буферизировать последние 7 строк

---

## Часть 4: История скилов (localStorage)

### 4.1 Структура хранения

```javascript
// localStorage key: 'kosmos_skill_history'
{
  sessions: [
    {
      id: 'skill-session-uuid',
      skillName: 'git-release',
      terminalSessionId: '...',
      startedAt: '2026-02-13T...',
      status: 'completed' | 'cancelled' | 'in_progress',
      messages: [...]
    }
  ]
}
```

### 4.2 UI для истории

Добавить кнопку "История" в header skill-dialog, показывающую список прошлых сессий.

---

## Порядок реализации

1. **Backend: REST API** (`server/skills.js`)
   - Создать модуль с endpoints
   - Интегрировать в server.js

2. **Frontend: HTML/CSS** 
   - Добавить skill-dialog в term.html
   - Стилизация окна

3. **Frontend: JavaScript**
   - startSkillDialog()
   - Обработка [CMD]/[MESSAGE]/[DONE]
   - Интеграция с терминалом (вставка команды)

4. **Отслеживание команд**
   - Модификация Enter handler
   - Детекция skill:skip/skill:cancel

5. **Буферизация output**
   - Серверная логика сбора output

6. **История**
   - localStorage
   - UI просмотра

---

## Файлы для создания/изменения

| Файл | Действие |
|------|----------|
| `server/skills.js` | Создать (новый REST API) |
| `server.js` | Изменить (подключить skills router) |
| `web/term.html` | Изменить (HTML + CSS + JS для skill-dialog) |

---

## Открытые вопросы для уточнения

1. **Вставка команды в терминал**: Технически xterm.js не имеет API для "вставки в input line без выполнения". Варианты:
   - **A**: Эмулировать ввод посимвольно (`term.paste(command)`)
   - **B**: Показать команду только в окне Skills с кнопкой "Скопировать" + инструкция вставить вручную

2. **Определение что команда выполнена**: Как узнать что именно предложенная команда была выполнена?
   - **A**: Сравнивать текст в терминале перед Enter с pendingCommand
   - **B**: Пользователь явно нажимает "Выполнено" в окне Skills после выполнения

Рекомендация: Вариант A для обоих вопросов (более естественный UX).