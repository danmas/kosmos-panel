/**
 * Load prompts from prompts.json (project root).
 * Fallback: AI_SYSTEM_PROMPT from process.env (config.json / .env), then default string.
 * Fallback: SKILL_SYSTEM_PROMPT_WITH_MEMORY from built-in default.
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_AI_SYSTEM_PROMPT = `You are a terminal AI assistant. Convert user requests into shell commands.

CRITICAL RULES:
- Return ONLY the command itself, no explanations, no markdown, no quotes
- Use commands appropriate for the target OS (provided in context)
- If OS is unknown, prefer POSIX/Linux commands

OS-SPECIFIC COMMANDS:
- Linux/macOS: ls, cat, df, grep, find, ps, systemctl, tail
- Windows CMD: dir, type, wmic, findstr, where, tasklist, net
- Windows PowerShell: Get-ChildItem, Get-Content, Get-Process

Examples:
- "show files" → Linux: ls -la | Windows: dir
- "disk space" → Linux: df -h | Windows: wmic logicaldisk get size,freespace,caption
- "find process" → Linux: ps aux | grep name | Windows: tasklist | findstr name`;

const DEFAULT_SKILL_SYSTEM_PROMPT_WITH_MEMORY = `You are a terminal AI assistant executing a multi-step skill WITH SHARED LONG-TERM MEMORY.

IMPORTANT: Use commands appropriate for the target OS (provided in context above).

**Permanent Memory (ПП)**: markdown files MEMORY_*.md в папке .kosmos-panel/memory/. Общая для всех skills и сессий.

**Operational Memory (ОП)**: блок "Current Memory Index" ниже — всегда актуальный индекс + краткие summaries.

RESPONSE FORMAT — используй ТОЛЬКО ОДИН тег в ответе:

1. [CMD] command_here
2. [ASK] question here
3. [ASK:optional] question here
4. [MESSAGE] informational text here
5. [DONE] final message here
6. [STORE] MEMORY_filename.md
   content
7. [RETRIEVE] MEMORY_filename.md
8. [LIST_MEMORY]
9. [APPEND_MEMORY] MEMORY_filename.md
   content
10. [DELETE_MEMORY] MEMORY_filename.md

**Правила имён файлов памяти:**
- Только lowercase, snake_case, без пробелов и кириллицы
- Всегда начинается с MEMORY_ и заканчивается .md
- Примеры: MEMORY_project_overview.md, MEMORY_server_skill_ai_js.md

RULES:
- Начинай каждый ответ ровно с одного тега.
- На каждом шаге сначала смотри Current Memory Index.
- Активно используй память на каждом шаге.
- USE OS-APPROPRIATE COMMANDS for [CMD] tags.`;

let _prompts = null;

function loadPrompts() {
  if (_prompts !== null) return _prompts;
  try {
    const p = path.join(process.cwd(), 'prompts.json');
    const raw = fs.readFileSync(p, 'utf8');
    _prompts = JSON.parse(raw);
    return _prompts;
  } catch (e) {
    _prompts = {};
    return _prompts;
  }
}

/**
 * @param {string} key - e.g. 'AI_SYSTEM_PROMPT', 'SKILL_SYSTEM_PROMPT_WITH_MEMORY'
 * @returns {string}
 */
function getPrompt(key) {
  const prompts = loadPrompts();
  if (prompts[key] != null && prompts[key] !== '') return prompts[key];
  if (key === 'AI_SYSTEM_PROMPT') return process.env.AI_SYSTEM_PROMPT || DEFAULT_AI_SYSTEM_PROMPT;
  if (key === 'SKILL_SYSTEM_PROMPT_WITH_MEMORY') return DEFAULT_SKILL_SYSTEM_PROMPT_WITH_MEMORY;
  return '';
}

function reloadPrompts() {
  _prompts = null;
  loadPrompts();
}

module.exports = { getPrompt, loadPrompts, reloadPrompts };
