/**
 * Shared AI module for Skills
 * Provides common functions for building prompts, calling AI, and parsing responses
 */

const logger = require('./logger');
const { getPrompt } = require('./prompts');
const fs = require('fs').promises;
const path = require('path');

const MEMORY_DIR = path.join(__dirname, '..', '.kosmos-panel', 'memory');

/**
 * Создаёт папку памяти, если её нет
 */
async function ensureMemoryDir() {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
}

/**
 * Загружает индекс + краткие summaries всех MEMORY_*.md
 */
async function loadMemoryIndex() {
  await ensureMemoryDir();
  const files = await fs.readdir(MEMORY_DIR);
  const memoryFiles = files.filter(f => f.startsWith('MEMORY_') && f.endsWith('.md'));
  const index = [];
  for (const file of memoryFiles) {
    const fullPath = path.join(MEMORY_DIR, file);
    const content = await fs.readFile(fullPath, 'utf8');
    const summary = content.split('\n')[0].substring(0, 150) || '(no summary)';
    index.push({
      file,
      summary: summary.trim()
    });
  }
  return index;
}

/**
 * Обработка новых тегов памяти
 */
async function handleMemoryAction(type, filename, content = '') {
  await ensureMemoryDir();
  const fullPath = path.join(MEMORY_DIR, filename);
  if (type === 'STORE') {
    await fs.writeFile(fullPath, content);
  } else if (type === 'APPEND_MEMORY') {
    const existing = await fs.readFile(fullPath, 'utf8').catch(() => '');
    await fs.writeFile(fullPath, existing + '\n' + content);
  } else if (type === 'RETRIEVE') {
    const content = await fs.readFile(fullPath, 'utf8').catch(() => 'NOT_FOUND');
    return content;
  } else if (type === 'LIST_MEMORY') {
    return await loadMemoryIndex();
  } else if (type === 'DELETE_MEMORY') {
    await fs.unlink(fullPath).catch(() => { });
  }
  return null;
}

/**
 * Build full system prompt for a skill
 * @param {string} skillContent - Content of the skill (SKILL.md)
 * @param {string} skillName - Name of the skill
 * @param {string} remoteKnowledge - Optional knowledge from kosmos-panel.md
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
async function buildSkillSystemPrompt(skillContent, skillName, remoteKnowledge = '', remoteOS = 'linux') {
  // Формируем информацию об ОС
  const osInfo = remoteOS === 'windows' 
    ? `--- Target OS: Windows ---
Use CMD/PowerShell commands. Examples:
- List files: dir | Get-ChildItem
- Read file: powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content 'file' -Encoding UTF8"
- Find text: findstr "pattern" file | Select-String -Pattern "pattern"
- Process list: tasklist | Get-Process`
    : remoteOS === 'darwin'
      ? `--- Target OS: macOS ---
Use POSIX/BSD commands. Examples:
- List files: ls -la
- Read file: cat file
- Find text: grep "pattern" file
- Process list: ps aux`
      : `--- Target OS: Linux ---
Use POSIX/GNU commands. Examples:
- List files: ls -la
- Read file: cat file
- Find text: grep "pattern" file
- Process list: ps aux`;

  let fullSystemPrompt = getPrompt('SKILL_SYSTEM_PROMPT_WITH_MEMORY');
  
  // Добавляем информацию об ОС в начало
  fullSystemPrompt = `${osInfo}\n\n${fullSystemPrompt}`;
  
  if (remoteKnowledge && remoteKnowledge.trim()) {
    fullSystemPrompt += `\n\n--- System Context ---\n${remoteKnowledge.trim()}`;
  }
  fullSystemPrompt += `\n\n--- Active Skill: ${skillName} ---\n${skillContent}`;

  // NEW MEMORY
  const index = await loadMemoryIndex();
  let indexText = '\n\n--- Current Memory Index ---\n';
  for (const item of index) {
    indexText += `${item.file}\n${item.summary}\n\n`;
  }
  fullSystemPrompt += indexText;

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
  // Старые теги (оставляем без изменений)
  const cmdMatch = content.match(/^\[CMD\]\s*(.+)$/im);
  const askOptionalMatch = content.match(/^\[ASK:optional\]\s*(.+)$/ims);
  const askMatch = content.match(/^\[ASK\]\s*(.+)$/ims);
  const msgMatch = content.match(/^\[MESSAGE\]\s*(.+)$/ims);
  const doneMatch = content.match(/^\[DONE\]\s*(.*)$/ims);

  if (cmdMatch) {
    let command = cmdMatch[1].trim();
    command = command.replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
    return {
      type: 'CMD',
      content: content,
      command: command
    };
  }
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
  // NEW MEMORY TAGS
  const storeMatch = content.match(/^\[STORE\]\s*MEMORY_(.+?)\.md\s*([\s\S]*)$/ims);
  const retrieveMatch = content.match(/^\[RETRIEVE\]\s*MEMORY_(.+?)\.md$/ims);
  const listMatch = content.match(/^\[LIST_MEMORY\]$/im);
  const appendMatch = content.match(/^\[APPEND_MEMORY\]\s*MEMORY_(.+?)\.md\s*([\s\S]*)$/ims);
  const deleteMatch = content.match(/^\[DELETE_MEMORY\]\s*MEMORY_(.+?)\.md$/ims);

  if (storeMatch) {
    return {
      type: 'STORE',
      filename: `MEMORY_${storeMatch[1]}.md`,
      content: storeMatch[2].trim()
    };
  }
  if (retrieveMatch) {
    return {
      type: 'RETRIEVE',
      filename: `MEMORY_${retrieveMatch[1]}.md`
    };
  }
  if (listMatch) {
    return {
      type: 'LIST_MEMORY'
    };
  }
  if (appendMatch) {
    return {
      type: 'APPEND_MEMORY',
      filename: `MEMORY_${appendMatch[1]}.md`,
      content: appendMatch[2].trim()
    };
  }
  if (deleteMatch) {
    return {
      type: 'DELETE_MEMORY',
      filename: `MEMORY_${deleteMatch[1]}.md`
    };
  }

  // NEW GET-FILE
  const getFileMatch = content.match(/^\[GET-FILE\]\s*(.+?)$/ims);

  if (getFileMatch) {
    return {
      type: 'GET-FILE',
      path: getFileMatch[1].trim()
    };
  }

  // Старый fallback для неизвестного формата
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
  get SKILL_SYSTEM_PROMPT() { return getPrompt('SKILL_SYSTEM_PROMPT_WITH_MEMORY'); },
  get SKILL_SYSTEM_PROMPT_WITH_MEMORY() { return getPrompt('SKILL_SYSTEM_PROMPT_WITH_MEMORY'); },
  buildSkillSystemPrompt, // теперь async
  buildInitialUserPrompt,
  callSkillAI,
  parseSkillResponse,
  getRemoteKnowledge,
  cleanOutputForAI,
  // NEW
  loadMemoryIndex,
  handleMemoryAction
};
