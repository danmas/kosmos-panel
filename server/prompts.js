/**
 * Load prompts from prompts.json (project root).
 * Fallback: AI_SYSTEM_PROMPT from process.env (config.json / .env), then default string.
 * Fallback: SKILL_SYSTEM_PROMPT_WITH_ASK from built-in default.
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_AI_SYSTEM_PROMPT = "You are a terminal AI assistant. Your task is to convert the user's request into a valid shell command, and return ONLY the shell command itself without any explanation.";

const DEFAULT_SKILL_SYSTEM_PROMPT_WITH_ASK = `You are a terminal AI assistant executing a multi-step skill.

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
- [DONE]: summarize what was accomplished`;

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
 * @param {string} key - e.g. 'AI_SYSTEM_PROMPT', 'SKILL_SYSTEM_PROMPT_WITH_ASK'
 * @returns {string}
 */
function getPrompt(key) {
  const prompts = loadPrompts();
  if (prompts[key] != null && prompts[key] !== '') return prompts[key];
  if (key === 'AI_SYSTEM_PROMPT') return process.env.AI_SYSTEM_PROMPT || DEFAULT_AI_SYSTEM_PROMPT;
  if (key === 'SKILL_SYSTEM_PROMPT_WITH_ASK') return DEFAULT_SKILL_SYSTEM_PROMPT_WITH_ASK;
  return '';
}

function reloadPrompts() {
  _prompts = null;
  loadPrompts();
}

module.exports = { getPrompt, loadPrompts, reloadPrompts };
