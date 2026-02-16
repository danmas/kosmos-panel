/**
 * Shared AI module for Skills
 * Provides common functions for building prompts, calling AI, and parsing responses
 */

const logger = require('./logger');

// Специальный системный промпт для multi-step skills
const SKILL_SYSTEM_PROMPT = `You are a terminal AI assistant executing a multi-step skill.

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

/**
 * Build full system prompt for a skill
 * @param {string} skillContent - Content of the skill (SKILL.md)
 * @param {string} skillName - Name of the skill
 * @param {string} remoteKnowledge - Optional knowledge from kosmos-panel.md
 * @returns {string} Full system prompt
 */
function buildSkillSystemPrompt(skillContent, skillName, remoteKnowledge = '') {
  let fullSystemPrompt = SKILL_SYSTEM_PROMPT;
  
  if (remoteKnowledge && remoteKnowledge.trim()) {
    fullSystemPrompt += `\n\n--- System Context ---\n${remoteKnowledge.trim()}`;
  }
  
  fullSystemPrompt += `\n\n--- Active Skill: ${skillName} ---\n${skillContent}`;
  
  return fullSystemPrompt;
}

/**
 * Build initial user prompt for a skill
 * @param {string} skillName - Name of the skill
 * @param {Object} params - Skill parameters
 * @param {string} userPrompt - User provided prompt
 * @param {number} step - Current step number
 * @param {number} maxSteps - Maximum steps
 * @returns {string} Initial user prompt
 */
function buildInitialUserPrompt(skillName, params = {}, userPrompt = '', step = 1, maxSteps = 100) {
  let firstUserPrompt = userPrompt || `Execute skill: ${skillName}`;
  
  if (Object.keys(params).length > 0) {
    firstUserPrompt += `\n\nParameters:\n${Object.entries(params).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
  }
  
  firstUserPrompt += `\n\n[Step ${step} of ${maxSteps}]`;
  
  return firstUserPrompt;
}

/**
 * Call AI API with messages
 * @param {Array} messages - Array of messages {role, content}
 * @param {Object} options - Options {aiServerUrl, aiModel, timeout, temperature, maxTokens}
 * @returns {Promise<string>} AI response content
 */
async function callSkillAI(messages, options = {}) {
  const {
    aiServerUrl = `${process.env.AI_KOSMOS_MODEL_BASE_URL || 'http://localhost:3002/v1'}/chat/completions`,
    aiModel = process.env.AI_MODEL || 'CHEAP',
    timeout = 30000,
    temperature = 0.3,
    maxTokens = 512
  } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Подготовка запроса
  const requestBody = {
    model: aiModel,
    messages,
    temperature,
    max_tokens: maxTokens
  };
  
  // Логируем запрос к AI
  logger.info('skill-ai', 'AI request', {
    url: aiServerUrl,
    model: aiModel,
    messagesCount: messages.length,
    lastUserMessage: messages.filter(m => m.role === 'user').pop()?.content?.substring(0, 100),
    temperature,
    maxTokens
  });

  try {
    const startTime = Date.now();
    const response = await fetch(aiServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    if (!content) {
      logger.error('skill-ai', 'Invalid AI response', { error: result.error?.message, result });
      throw new Error(result.error?.message || 'Invalid AI response');
    }

    // Логируем успешный ответ
    logger.info('skill-ai', 'AI response received', {
      duration: `${duration}ms`,
      contentLength: content.length,
      contentPreview: content.substring(0, 150),
      usage: result.usage
    });

    return content;
  } catch (e) {
    clearTimeout(timeoutId);
    logger.error('skill-ai', 'AI request failed', { 
      error: e.message, 
      timeout: e.name === 'AbortError',
      url: aiServerUrl 
    });
    if (e.name === 'AbortError') {
      throw new Error('AI request timed out');
    }
    throw e;
  }
}

/**
 * Parse AI response to extract type and content
 * @param {string} aiContent - Raw AI response
 * @returns {Object} { type: 'CMD'|'ASK'|'MESSAGE'|'DONE'|'UNKNOWN', content: string, ... }
 */
function parseSkillResponse(aiContent) {
  const content = aiContent.trim();
  
  // Парсим формат ответа
  const cmdMatch = content.match(/^\[CMD\]\s*(.+)$/im);
  const askOptionalMatch = content.match(/^\[ASK:optional\]\s*(.+)$/ims);
  const askMatch = content.match(/^\[ASK\]\s*(.+)$/ims);
  const msgMatch = content.match(/^\[MESSAGE\]\s*(.+)$/ims);
  const doneMatch = content.match(/^\[DONE\]\s*(.*)$/ims);

  if (cmdMatch) {
    let command = cmdMatch[1].trim();
    // Удаляем markdown code blocks если есть
    command = command.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
    return {
      type: 'CMD',
      content: content,
      command: command
    };
  }
  
  // Проверяем [ASK:optional] ПЕРЕД [ASK] (более специфичный паттерн)
  if (askOptionalMatch) {
    return {
      type: 'ASK',
      content: content,
      question: askOptionalMatch[1].trim(),
      required: false
    };
  }
  
  if (askMatch) {
    return {
      type: 'ASK',
      content: content,
      question: askMatch[1].trim(),
      required: true
    };
  }
  
  if (msgMatch) {
    return {
      type: 'MESSAGE',
      content: content,
      message: msgMatch[1].trim()
    };
  }
  
  if (doneMatch) {
    return {
      type: 'DONE',
      content: content,
      message: doneMatch[1].trim() || 'Skill completed'
    };
  }
  
  // Неизвестный формат - пробуем выполнить как команду
  logger.warn('skill-ai', 'Unknown response format, treating as command', { content: content.substring(0, 100) });
  let command = content.split('\n')[0].trim();
  command = command.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
  
  if (command) {
    return {
      type: 'CMD',
      content: `[CMD] ${command}`,
      command: command
    };
  }
  
  return {
    type: 'UNKNOWN',
    content: content,
    error: 'Empty or invalid AI response'
  };
}

/**
 * Get remote knowledge from kosmos-panel.md via SSH
 * @param {Object} sshConn - SSH connection object
 * @param {string} remoteOS - 'linux' or 'windows'
 * @returns {Promise<string>} Knowledge content
 */
async function getRemoteKnowledge(sshConn, remoteOS) {
  return new Promise((resolve) => {
    const commandTimeout = setTimeout(() => resolve(''), 5000);
    let cmd;
    
    if (remoteOS === 'windows') {
      cmd = `powershell -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p1 = Join-Path (Get-Location) '.kosmos-panel\\kosmos-panel.md'; $p2 = Join-Path $env:USERPROFILE '.config\\kosmos-panel\\kosmos-panel.md'; if (Test-Path $p1) { [System.IO.File]::ReadAllText($p1, [System.Text.Encoding]::UTF8) } elseif (Test-Path $p2) { [System.IO.File]::ReadAllText($p2, [System.Text.Encoding]::UTF8) }"`;
    } else {
      cmd = `cat ./.kosmos-panel/kosmos-panel.md 2>/dev/null || cat ~/.config/kosmos-panel/kosmos-panel.md 2>/dev/null`;
    }
    
    let content = '';
    sshConn.exec(cmd, (err, execStream) => {
      if (err) {
        clearTimeout(commandTimeout);
        return resolve('');
      }
      execStream.on('data', (data) => { content += data.toString(); });
      execStream.on('close', () => {
        clearTimeout(commandTimeout);
        resolve(content.trim() || '');
      });
    });
  });
}

module.exports = {
  SKILL_SYSTEM_PROMPT,
  buildSkillSystemPrompt,
  buildInitialUserPrompt,
  callSkillAI,
  parseSkillResponse,
  getRemoteKnowledge
};
