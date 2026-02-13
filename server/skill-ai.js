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

2. [MESSAGE] your message here
   Show this message to the user and wait for their response.
   Use this to ask questions or request input (like commit messages).

3. [DONE] final message here
   The skill is complete. Show this final message to the user.

RULES:
- Always start your response with [CMD], [MESSAGE], or [DONE]
- Only ONE format per response
- For [CMD]: provide only the command, no explanations
- For [MESSAGE]: ask clear, specific questions
- For [DONE]: summarize what was accomplished`;

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

  try {
    const response = await fetch(aiServerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: aiModel,
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(result.error?.message || 'Invalid AI response');
    }

    return content;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error('AI request timed out');
    }
    throw e;
  }
}

/**
 * Parse AI response to extract type and content
 * @param {string} aiContent - Raw AI response
 * @returns {Object} { type: 'CMD'|'MESSAGE'|'DONE'|'UNKNOWN', content: string, command?: string }
 */
function parseSkillResponse(aiContent) {
  const content = aiContent.trim();
  
  // Парсим формат ответа
  const cmdMatch = content.match(/^\[CMD\]\s*(.+)$/im);
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
      cmd = `powershell -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p1 = './.kosmos-panel/kosmos-panel.md'; $p2 = Join-Path $env:USERPROFILE '.config/kosmos-panel/kosmos-panel.md'; if (Test-Path $p1) { Get-Content $p1 -Raw -Encoding UTF8 } elseif (Test-Path $p2) { Get-Content $p2 -Raw -Encoding UTF8 }"`;
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
