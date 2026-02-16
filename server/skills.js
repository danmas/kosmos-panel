/**
 * Skills REST API Module
 * Provides endpoints for managing skill sessions via REST API
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');
const { wsSessions } = require('./ws');
const {
  buildSkillSystemPrompt,
  buildInitialUserPrompt,
  callSkillAI,
  parseSkillResponse,
  getRemoteKnowledge
} = require('./skill-ai');

const router = express.Router();

const SKILLS_LOG_PATH = path.join(__dirname, '..', 'data', 'skills_log.json');
let skillsLogQueue = Promise.resolve();

// Функция логирования skills
function appendToSkillsLog(logEntry) {
  skillsLogQueue = skillsLogQueue.then(async () => {
    try {
      let logs = [];
      try {
        const data = await fs.readFile(SKILLS_LOG_PATH, 'utf8');
        logs = JSON.parse(data);
      } catch (readErr) {
        if (readErr.code !== 'ENOENT') {
          logger.error('skills-api', 'Error reading skills log file', { error: readErr.message });
        }
      }
      logs.push(logEntry);
      await fs.mkdir(path.dirname(SKILLS_LOG_PATH), { recursive: true });
      await fs.writeFile(SKILLS_LOG_PATH, JSON.stringify(logs, null, 2));
      logger.info('skills-api', 'Logged skill entry', { type: logEntry.type, step: logEntry.step, skill_name: logEntry.skill_name });
    } catch (writeErr) {
      logger.error('skills-api', 'Error writing to skills log file', { error: writeErr.message });
    }
  }).catch(err => {
    logger.error('skills-api', 'Error in skills log queue', { error: err.message });
  });
}

// In-memory storage for skill sessions
const skillSessions = {};
// Structure:
// {
//   skillSessionId: {
//     terminalSessionId,    // привязка к терминалу
//     serverId,             // для SSH доступа
//     skillName,            // название скила
//     skillDescription,     // описание
//     messages: [],         // история для AI context
//     step: 0,              // текущий шаг (max 100)
//     state: 'idle'|'waiting_cmd'|'waiting_user'|'done',
//     pendingCommand: null, // команда ожидающая выполнения
//     outputBuffer: [],     // последние 7 строк output
//     createdAt,
//     lastActivity
//   }
// }

// Output subscribers - called when terminal output is received
const outputSubscribers = {};
// { terminalSessionId: { skillSessionId: callback } }

/**
 * Subscribe to terminal output
 */
function subscribeToOutput(terminalSessionId, skillSessionId, callback) {
  if (!outputSubscribers[terminalSessionId]) {
    outputSubscribers[terminalSessionId] = {};
  }
  outputSubscribers[terminalSessionId][skillSessionId] = callback;
  logger.debug('skills-api', 'Subscribed to output', { terminalSessionId, skillSessionId });
}

/**
 * Unsubscribe from terminal output
 */
function unsubscribeFromOutput(terminalSessionId, skillSessionId) {
  if (outputSubscribers[terminalSessionId]) {
    delete outputSubscribers[terminalSessionId][skillSessionId];
    if (Object.keys(outputSubscribers[terminalSessionId]).length === 0) {
      delete outputSubscribers[terminalSessionId];
    }
  }
  logger.debug('skills-api', 'Unsubscribed from output', { terminalSessionId, skillSessionId });
}

/**
 * Notify output subscribers
 */
function notifyOutputSubscribers(terminalSessionId, output) {
  const subscribers = outputSubscribers[terminalSessionId];
  if (subscribers) {
    for (const [skillSessionId, callback] of Object.entries(subscribers)) {
      try {
        callback(output);
      } catch (e) {
        logger.error('skills-api', 'Error in output subscriber', { skillSessionId, error: e.message });
      }
    }
  }
}

// --- Skill loading functions ---

/**
 * Parse YAML frontmatter from SKILL.md
 */
function parseSkillFrontmatter(content, fallbackName = 'unknown') {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { name: fallbackName, description: '', params: [], content: content.trim() };
  }

  const frontmatter = match[1];
  const body = match[2].trim();

  const result = { name: fallbackName, description: '', params: [], content: body };

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  if (descMatch) result.description = descMatch[1].trim();

  const paramsMatch = frontmatter.match(/^params:\s*\n((?:\s+-[\s\S]*?(?=\n[^\s-]|$))+)/m);
  if (paramsMatch) {
    const paramsBlock = paramsMatch[1];
    const paramMatches = paramsBlock.matchAll(/^\s+-\s*name:\s*(\S+)/gm);
    for (const pm of paramMatches) {
      result.params.push({ name: pm[1] });
    }
  }

  return result;
}

/**
 * Get project skill by path
 */
async function getProjectSkill(skillPath) {
  const projectRoot = path.resolve(__dirname, '..');
  const skillsRoot = path.join(projectRoot, '.kosmos-panel', 'skills');
  const relPath = (skillPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const filePath = path.join(skillsRoot, ...relPath.split('/'), 'SKILL.md');
  
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    return null;
  }
  
  const fallbackName = relPath.split('/').filter(Boolean).pop() || 'unknown';
  return parseSkillFrontmatter(content, fallbackName);
}

/**
 * Get remote skill via SSH
 */
function getRemoteSkill(sshConn, skillName, remoteOS = 'linux', skillPath = null) {
  return new Promise((resolve) => {
    const relPath = (skillPath || skillName || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    let cmd;

    if (remoteOS === 'windows') {
      const winRel = relPath.replace(/\//g, '\\');
      cmd = `powershell -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Content (Join-Path $env:USERPROFILE '.config/kosmos-panel/skills\\${winRel}\\SKILL.md') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue"`;
    } else {
      const fullPath = `~/.config/kosmos-panel/skills/${relPath}/SKILL.md`;
      cmd = `cat ${fullPath} 2>/dev/null`;
    }

    const commandTimeout = setTimeout(() => {
      logger.warn('skills-api', 'Remote skill command timed out', { skillName });
      resolve(null);
    }, 5000);

    let content = '';
    sshConn.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(commandTimeout);
        logger.error('skills-api', 'Error executing remote skill command', { skillName, error: err.message });
        return resolve(null);
      }
      stream.on('data', (data) => { content += data.toString(); });
      stream.on('close', () => {
        clearTimeout(commandTimeout);
        
        if (!content.trim()) {
          logger.debug('skills-api', 'Skill not found', { skillName });
          return resolve(null);
        }

        const parsed = parseSkillFrontmatter(content, skillName);
        logger.info('skills-api', 'Successfully loaded skill', { skillName, bytes: content.length });
        resolve(parsed);
      });
    });
  });
}

// --- REST API Endpoints ---

/**
 * POST /api/skills/start
 * Start a new skill session
 */
router.post('/start', async (req, res) => {
  const { terminalSessionId, skillId, skillPath, skillSource, params = {}, prompt = '' } = req.body;

  if (!terminalSessionId) {
    return res.status(400).json({ success: false, error: 'terminalSessionId is required' });
  }

  const wsSession = wsSessions[terminalSessionId];
  if (!wsSession) {
    return res.status(404).json({ success: false, error: 'Terminal session not found' });
  }

  try {
    // Get SSH connection and remote OS
    const { conn, getOS, serverId, serverName } = wsSession;
    if (!conn) {
      return res.status(400).json({ success: false, error: 'No SSH connection available' });
    }
    
    const remoteOS = getOS ? getOS() : 'linux';

    // Load skill content
    const skillName = skillPath || skillId;
    let skill;
    
    if (skillSource === 'project') {
      skill = await getProjectSkill(skillPath);
    } else {
      skill = await getRemoteSkill(conn, skillName, remoteOS, skillPath);
    }

    if (!skill) {
      return res.status(404).json({ success: false, error: `Skill "${skillName}" not found` });
    }

    // Get remote knowledge
    const remoteKnowledge = await getRemoteKnowledge(conn, remoteOS);

    // Build prompts
    const activeSkillName = skill.name || skillName || skillPath || 'skill';
    const systemPrompt = buildSkillSystemPrompt(skill.content, activeSkillName, remoteKnowledge);
    const userPrompt = buildInitialUserPrompt(activeSkillName, params, prompt, 1, 100);

    // Create skill session
    const skillSessionId = uuidv4();
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // Логируем запуск skill
    appendToSkillsLog({
      id: uuidv4(),
      skill_log_id: skillSessionId,
      session_id: terminalSessionId,
      timestamp: new Date().toISOString(),
      type: 'skill_start',
      skill_name: activeSkillName,
      skill_description: skill.description || '',
      skill_params: params,
      user_prompt: prompt,
      step: 1,
      max_steps: 100,
      serverId,
      serverName
    });

    // Call AI
    const aiContent = await callSkillAI(messages);
    const parsed = parseSkillResponse(aiContent);

    // Add assistant message to history
    messages.push({ role: 'assistant', content: parsed.content });

    // Логируем ответ AI
    if (parsed.type === 'CMD') {
      appendToSkillsLog({
        id: uuidv4(),
        skill_log_id: skillSessionId,
        session_id: terminalSessionId,
        timestamp: new Date().toISOString(),
        type: 'skill_command',
        skill_name: activeSkillName,
        step: 1,
        command: parsed.command,
        ai_response: parsed.content,
        serverId,
        serverName
      });
    } else if (parsed.type === 'MESSAGE') {
      appendToSkillsLog({
        id: uuidv4(),
        skill_log_id: skillSessionId,
        session_id: terminalSessionId,
        timestamp: new Date().toISOString(),
        type: 'skill_message',
        skill_name: activeSkillName,
        step: 1,
        message: parsed.message,
        ai_response: parsed.content,
        serverId,
        serverName
      });
    } else if (parsed.type === 'DONE') {
      appendToSkillsLog({
        id: uuidv4(),
        skill_log_id: skillSessionId,
        session_id: terminalSessionId,
        timestamp: new Date().toISOString(),
        type: 'skill_complete',
        skill_name: activeSkillName,
        step: 1,
        final_message: parsed.message,
        ai_response: parsed.content,
        serverId,
        serverName
      });
    }

    // Determine state based on AI response
    let state = 'idle';
    if (parsed.type === 'CMD') {
      state = 'waiting_cmd';
    } else if (parsed.type === 'MESSAGE') {
      state = 'waiting_user';
    } else if (parsed.type === 'DONE') {
      state = 'done';
    }

    // Store session
    skillSessions[skillSessionId] = {
      terminalSessionId,
      serverId,
      serverName,
      skillName: activeSkillName,
      skillDescription: skill.description || '',
      messages,
      step: 1,
      maxSteps: 100,
      state,
      pendingCommand: parsed.type === 'CMD' ? parsed.command : null,
      outputBuffer: [],
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    };

    // Subscribe to output if waiting for command
    if (state === 'waiting_cmd') {
      subscribeToOutput(terminalSessionId, skillSessionId, (output) => {
        const session = skillSessions[skillSessionId];
        if (session) {
          // Store last 7 lines
          const lines = output.split('\n').filter(l => l.trim());
          session.outputBuffer = lines.slice(-7);
        }
      });
    }

    logger.info('skills-api', 'Skill session started', { 
      skillSessionId, 
      terminalSessionId, 
      skillName: activeSkillName,
      state 
    });

    res.json({
      success: true,
      data: {
        skillSessionId,
        skillName: activeSkillName,
        skillDescription: skill.description || '',
        aiResponse: {
          type: parsed.type,
          content: parsed.type === 'MESSAGE' ? parsed.message : 
                   parsed.type === 'DONE' ? parsed.message : 
                   parsed.content,
          command: parsed.command || null
        }
      }
    });

  } catch (e) {
    logger.error('skills-api', 'Error starting skill', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/skills/:skillSessionId/message
 * Send user message to skill
 */
router.post('/:skillSessionId/message', async (req, res) => {
  const { skillSessionId } = req.params;
  const { userMessage } = req.body;

  const session = skillSessions[skillSessionId];
  if (!session) {
    return res.status(404).json({ success: false, error: 'Skill session not found' });
  }

  if (session.state !== 'waiting_user') {
    return res.status(400).json({ success: false, error: 'Skill is not waiting for user input' });
  }

  try {
    // Increment step
    session.step++;
    if (session.step > session.maxSteps) {
      session.state = 'done';
      return res.json({
        success: true,
        data: {
          aiResponse: {
            type: 'DONE',
            content: 'Maximum steps reached',
            command: null
          }
        }
      });
    }

    // Add user message and call AI
    const userContent = `User response: ${userMessage}\n\n[Step ${session.step} of ${session.maxSteps}]`;
    session.messages.push({ role: 'user', content: userContent });

    // Логируем ответ пользователя
    appendToSkillsLog({
      id: uuidv4(),
      skill_log_id: skillSessionId,
      session_id: session.terminalSessionId,
      timestamp: new Date().toISOString(),
      type: 'skill_user_input',
      skill_name: session.skillName,
      step: session.step,
      user_input: userMessage,
      serverId: session.serverId,
      serverName: session.serverName
    });

    const aiContent = await callSkillAI(session.messages);
    const parsed = parseSkillResponse(aiContent);

    // Add assistant message
    session.messages.push({ role: 'assistant', content: parsed.content });

    // Логируем ответ AI (message endpoint)
    if (parsed.type === 'CMD') {
      appendToSkillsLog({
        id: uuidv4(),
        skill_log_id: skillSessionId,
        session_id: session.terminalSessionId,
        timestamp: new Date().toISOString(),
        type: 'skill_command',
        skill_name: session.skillName,
        step: session.step,
        command: parsed.command,
        ai_response: parsed.content,
        serverId: session.serverId,
        serverName: session.serverName
      });
    } else if (parsed.type === 'MESSAGE') {
      appendToSkillsLog({
        id: uuidv4(),
        skill_log_id: skillSessionId,
        session_id: session.terminalSessionId,
        timestamp: new Date().toISOString(),
        type: 'skill_message',
        skill_name: session.skillName,
        step: session.step,
        message: parsed.message,
        ai_response: parsed.content,
        serverId: session.serverId,
        serverName: session.serverName
      });
    } else if (parsed.type === 'DONE') {
      appendToSkillsLog({
        id: uuidv4(),
        skill_log_id: skillSessionId,
        session_id: session.terminalSessionId,
        timestamp: new Date().toISOString(),
        type: 'skill_complete',
        skill_name: session.skillName,
        step: session.step,
        final_message: parsed.message,
        ai_response: parsed.content,
        serverId: session.serverId,
        serverName: session.serverName
      });
    }

    // Update state
    if (parsed.type === 'CMD') {
      session.state = 'waiting_cmd';
      session.pendingCommand = parsed.command;
      subscribeToOutput(session.terminalSessionId, skillSessionId, (output) => {
        const lines = output.split('\n').filter(l => l.trim());
        session.outputBuffer = lines.slice(-7);
      });
    } else if (parsed.type === 'MESSAGE') {
      session.state = 'waiting_user';
    } else if (parsed.type === 'DONE') {
      session.state = 'done';
      unsubscribeFromOutput(session.terminalSessionId, skillSessionId);
    }

    session.lastActivity = new Date().toISOString();

    res.json({
      success: true,
      data: {
        step: session.step,
        aiResponse: {
          type: parsed.type,
          content: parsed.type === 'MESSAGE' ? parsed.message : 
                   parsed.type === 'DONE' ? parsed.message : 
                   parsed.content,
          command: parsed.command || null
        }
      }
    });

  } catch (e) {
    logger.error('skills-api', 'Error processing message', { skillSessionId, error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/skills/:skillSessionId/command-result
 * Report command execution result
 */
router.post('/:skillSessionId/command-result', async (req, res) => {
  const { skillSessionId } = req.params;
  const { stdout, stderr, exitCode, skipped = false } = req.body;

  const session = skillSessions[skillSessionId];
  if (!session) {
    return res.status(404).json({ success: false, error: 'Skill session not found' });
  }

  if (session.state !== 'waiting_cmd') {
    return res.status(400).json({ success: false, error: 'Skill is not waiting for command result' });
  }

  try {
    // Unsubscribe from output
    unsubscribeFromOutput(session.terminalSessionId, skillSessionId);

    // Increment step
    session.step++;
    if (session.step > session.maxSteps) {
      session.state = 'done';
      session.pendingCommand = null;
      return res.json({
        success: true,
        data: {
          aiResponse: {
            type: 'DONE',
            content: 'Maximum steps reached',
            command: null
          }
        }
      });
    }

    // Build user message with command output
    let userContent;
    if (skipped) {
      userContent = `User skipped the command.\n\n[Step ${session.step} of ${session.maxSteps}]`;
    } else {
      // Use buffered output or provided stdout
      const output = stdout || session.outputBuffer.join('\n') || '(no output)';
      userContent = `Command output:\n${output}\n\n[Step ${session.step} of ${session.maxSteps}]`;
    }

    session.messages.push({ role: 'user', content: userContent });
    session.pendingCommand = null;
    session.outputBuffer = [];

    // Call AI
    const aiContent = await callSkillAI(session.messages);
    const parsed = parseSkillResponse(aiContent);

    // Add assistant message
    session.messages.push({ role: 'assistant', content: parsed.content });

    // Логируем ответ AI (command-result endpoint)
    if (parsed.type === 'CMD') {
      appendToSkillsLog({
        id: uuidv4(),
        skill_log_id: skillSessionId,
        session_id: session.terminalSessionId,
        timestamp: new Date().toISOString(),
        type: 'skill_command',
        skill_name: session.skillName,
        step: session.step,
        command: parsed.command,
        ai_response: parsed.content,
        serverId: session.serverId,
        serverName: session.serverName
      });
    } else if (parsed.type === 'MESSAGE') {
      appendToSkillsLog({
        id: uuidv4(),
        skill_log_id: skillSessionId,
        session_id: session.terminalSessionId,
        timestamp: new Date().toISOString(),
        type: 'skill_message',
        skill_name: session.skillName,
        step: session.step,
        message: parsed.message,
        ai_response: parsed.content,
        serverId: session.serverId,
        serverName: session.serverName
      });
    } else if (parsed.type === 'DONE') {
      appendToSkillsLog({
        id: uuidv4(),
        skill_log_id: skillSessionId,
        session_id: session.terminalSessionId,
        timestamp: new Date().toISOString(),
        type: 'skill_complete',
        skill_name: session.skillName,
        step: session.step,
        final_message: parsed.message,
        ai_response: parsed.content,
        serverId: session.serverId,
        serverName: session.serverName
      });
    }

    // Update state
    if (parsed.type === 'CMD') {
      session.state = 'waiting_cmd';
      session.pendingCommand = parsed.command;
      subscribeToOutput(session.terminalSessionId, skillSessionId, (output) => {
        const lines = output.split('\n').filter(l => l.trim());
        session.outputBuffer = lines.slice(-7);
      });
    } else if (parsed.type === 'MESSAGE') {
      session.state = 'waiting_user';
    } else if (parsed.type === 'DONE') {
      session.state = 'done';
    }

    session.lastActivity = new Date().toISOString();

    res.json({
      success: true,
      data: {
        step: session.step,
        aiResponse: {
          type: parsed.type,
          content: parsed.type === 'MESSAGE' ? parsed.message : 
                   parsed.type === 'DONE' ? parsed.message : 
                   parsed.content,
          command: parsed.command || null
        }
      }
    });

  } catch (e) {
    logger.error('skills-api', 'Error processing command result', { skillSessionId, error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/skills/:skillSessionId/output
 * Get last terminal output for skill
 */
router.get('/:skillSessionId/output', (req, res) => {
  const { skillSessionId } = req.params;

  const session = skillSessions[skillSessionId];
  if (!session) {
    return res.status(404).json({ success: false, error: 'Skill session not found' });
  }

  res.json({
    success: true,
    data: {
      lastOutput: session.outputBuffer.join('\n'),
      state: session.state,
      step: session.step
    }
  });
});

/**
 * GET /api/skills/:skillSessionId
 * Get skill session info
 */
router.get('/:skillSessionId', (req, res) => {
  const { skillSessionId } = req.params;

  const session = skillSessions[skillSessionId];
  if (!session) {
    return res.status(404).json({ success: false, error: 'Skill session not found' });
  }

  res.json({
    success: true,
    data: {
      skillSessionId,
      skillName: session.skillName,
      skillDescription: session.skillDescription,
      state: session.state,
      step: session.step,
      maxSteps: session.maxSteps,
      pendingCommand: session.pendingCommand,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity
    }
  });
});

/**
 * DELETE /api/skills/:skillSessionId
 * Cancel and delete skill session
 */
router.delete('/:skillSessionId', (req, res) => {
  const { skillSessionId } = req.params;

  const session = skillSessions[skillSessionId];
  if (!session) {
    return res.status(404).json({ success: false, error: 'Skill session not found' });
  }

  // Unsubscribe from output
  unsubscribeFromOutput(session.terminalSessionId, skillSessionId);

  // Delete session
  delete skillSessions[skillSessionId];

  logger.info('skills-api', 'Skill session cancelled', { skillSessionId });

  res.json({
    success: true,
    data: { message: 'Skill session cancelled' }
  });
});

// Cleanup old sessions periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes

  for (const [skillSessionId, session] of Object.entries(skillSessions)) {
    const lastActivity = new Date(session.lastActivity).getTime();
    if (now - lastActivity > maxAge) {
      unsubscribeFromOutput(session.terminalSessionId, skillSessionId);
      delete skillSessions[skillSessionId];
      logger.info('skills-api', 'Cleaned up stale skill session', { skillSessionId });
    }
  }
}, 5 * 60 * 1000);

module.exports = router;

// Export for ws.js integration
module.exports.notifyOutputSubscribers = notifyOutputSubscribers;
module.exports.skillSessions = skillSessions;
