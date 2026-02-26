/**
 * Shared AI module for Skills
 * Provides common functions for building prompts, calling AI, and parsing responses
 */

const logger = require('./logger');
const { getPrompt } = require('./prompts');

/**
 * Build full system prompt for a skill
 * @param {string} skillContent - Content of the skill (SKILL.md)
 * @param {string} skillName - Name of the skill
 * @param {string} remoteKnowledge - Optional knowledge from ai_system_promt.md
 * @returns {string} Full system prompt
 */
function stripAnsi(str) {
  if (!str) return '';
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Очищает вывод терминала от лишнего мусора (баннеры, промпты, эхо)
 */
function cleanOutputForAI(rawOutput, lastCommand = null) {
  if (!rawOutput) return '(no output)';

  let clean = stripAnsi(rawOutput)
    // Удаляем OSC sequences (заголовок окна)
    .replace(/\x1b\][^\x07]*\x07/g, '')
    // Удаляем промпты Windows (C:\Path> ) и Linux (user@host:path$ )
    // Важно: regexp должен съедать промпт в начале ЛЮБОЙ строки (m)
    .replace(/^([a-zA-Z]:\\[^>]*>|[\w.-]+@[\w.-]+:[^$#>]*[\$#>])\s*/gm, '')
    // Удаляем Microsoft Windows banner
    .replace(/Microsoft Windows \[Version[^\]]*\][^\n]*\n/g, '')
    .replace(/\(c\) Microsoft Corporation[^\n]*\n/g, '')
    // Удаляем пустые строки и лишние пробелы (но сохраняем структуру)
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');

  // Если известно последнее эхо (команда), пытаемся её убрать из начала
  if (lastCommand && typeof lastCommand === 'string') {
    const trimmedCmd = lastCommand.trim();
    if (clean.startsWith(trimmedCmd)) {
      clean = clean.substring(trimmedCmd.length).trim();
    }
  }

  // Удаляем дубликаты строк (опционально, но помогает при эхо)
  const lines = clean.split('\n');
  const uniqueLines = [];
  const seen = new Set();
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      uniqueLines.push(line);
    }
  }
  clean = uniqueLines.join('\n').trim();

  return clean || '(no output)';
}
function buildSkillSystemPrompt(skillContent, skillName, remoteKnowledge = '') {
  let fullSystemPrompt = getPrompt('SKILL_SYSTEM_PROMPT_WITH_ASK');

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

  // Логируем запрос к AI (детально)
  logger.info('skill-ai', 'AI request', {
    url: aiServerUrl,
    model: aiModel,
    messagesCount: messages.length,
    temperature,
    maxTokens,
    systemPrompt: messages.find(m => m.role === 'system')?.content?.substring(0, 300),
    lastUserMessage: messages.filter(m => m.role === 'user').pop()?.content?.substring(0, 200),
    fullMessages: messages.map(m => ({
      role: m.role,
      contentLength: m.content?.length || 0,
      contentPreview: m.content?.substring(0, 150)
    }))
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

    // Логируем успешный ответ (детально)
    logger.info('skill-ai', 'AI response received', {
      duration: `${duration}ms`,
      contentLength: content.length,
      contentPreview: content.substring(0, 150),
      usage: result.usage,
      fullResponse: content,
      rawResult: {
        finishReason: result.choices?.[0]?.finish_reason,
        model: result.model
      }
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
 * Get remote knowledge from ai_system_promt.md via SSH
 * @param {Object} sshConn - SSH connection object
 * @param {string} remoteOS - 'linux' or 'windows'
 * @returns {Promise<string>} Knowledge content
 */
async function getRemoteKnowledge(sshConn, remoteOS) {
  return new Promise((resolve) => {
    const commandTimeout = setTimeout(() => resolve(''), 5000);
    let cmd;

    if (remoteOS === 'windows') {
      cmd = `powershell -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $p1 = Join-Path (Get-Location) '.kosmos-panel\\ai_system_promt.md'; $p2 = Join-Path $env:USERPROFILE '.config\\kosmos-panel\\ai_system_promt.md'; if (Test-Path $p1) { [System.IO.File]::ReadAllText($p1, [System.Text.Encoding]::UTF8) } elseif (Test-Path $p2) { [System.IO.File]::ReadAllText($p2, [System.Text.Encoding]::UTF8) }"`;
    } else {
      cmd = `cat ./.kosmos-panel/ai_system_promt.md 2>/dev/null || cat ~/.config/kosmos-panel/ai_system_promt.md 2>/dev/null`;
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
  get SKILL_SYSTEM_PROMPT() { return getPrompt('SKILL_SYSTEM_PROMPT_WITH_ASK'); },
  get SKILL_SYSTEM_PROMPT_WITH_ASK() { return getPrompt('SKILL_SYSTEM_PROMPT_WITH_ASK'); },
  buildSkillSystemPrompt,
  buildInitialUserPrompt,
  callSkillAI,
  parseSkillResponse,
  getRemoteKnowledge,
  cleanOutputForAI
};
