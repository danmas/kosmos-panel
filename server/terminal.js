const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');
const { inventory } = require('./monitor');
const { resolvePrivateKey, findServer } = require('./ws-utils');
const logger = require('./logger');

const sessions = {};
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 минут

// Функция для очистки старых сессий
setInterval(() => {
  const now = Date.now();
  for (const sessionId in sessions) {
    if (now - sessions[sessionId].lastUsed > SESSION_TIMEOUT) {
      logger.info('terminal-api', 'Closing stale session', { sessionId });
      sessions[sessionId].conn.end();
      delete sessions[sessionId];
    }
  }
}, 60 * 1000); // Проверять каждую минуту

async function createSession(req, res) {
  const { serverId } = req.body;
  if (!serverId) {
    return res.status(400).json({ error: 'serverId is required' });
  }

  const server = findServer(serverId);
  if (!server) {
    return res.status(404).json({ error: 'Server not found' });
  }

  let key, passphrase, password, useAgent;
  try {
    const r = resolvePrivateKey(server.ssh.credentialId);
    key = r.key; passphrase = r.passphrase; password = r.password; useAgent = r.useAgent;
  } catch (e) {
    return res.status(500).json({ error: 'Credential error: ' + e.message });
  }

  const conn = new Client();
  const sessionId = uuidv4();

  conn.on('ready', () => {
    sessions[sessionId] = { conn, lastUsed: Date.now(), serverId };
    res.status(201).json({ sessionId });
  }).on('error', (err) => {
    logger.error('terminal-api', 'SSH connection error', { serverId, error: err.message });
    res.status(500).json({ error: 'SSH connection failed: ' + err.message });
  }).connect((() => {
      const base = { host: server.ssh.host, port: Number(server.ssh.port) || 22, username: server.ssh.user };
      const auth = { ...base };
      const agentSock = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      if (useAgent) auth.agent = agentSock;
      if (key) auth.privateKey = key;
      if (passphrase) auth.passphrase = passphrase;
      if (password) auth.password = password;
      return auth;
    })());
}

function executeCommand(req, res) {
    const { sessionId } = req.params;
    const { command, timeout = 30000 } = req.body; // Таймаут по умолчанию 30 секунд
  
    if (!command) {
      return res.status(400).json({ error: 'command is required' });
    }
  
    const session = sessions[sessionId];
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }
  
    session.lastUsed = Date.now();
    const { conn } = session;
  
    let stdout = '';
    let stderr = '';
    let timer;
  
    const execOptions = {};
  
    conn.exec(command, execOptions, (err, stream) => {
      if (err) {
        logger.error('terminal-api', 'SSH exec error', { sessionId, error: err.message });
        return res.status(500).json({ error: 'Failed to execute command: ' + err.message });
      }
  
      const cleanup = () => {
        clearTimeout(timer);
      };
  
      timer = setTimeout(() => {
        stream.close();
        cleanup();
        logger.error('terminal-api', 'Command timed out', { sessionId });
        res.status(500).json({ 
            error: 'Command execution timed out',
            stdout,
            stderr
        });
      }, timeout);
  
      stream.on('data', (data) => {
        stdout += data.toString('utf8');
      });
  
      stream.stderr.on('data', (data) => {
        stderr += data.toString('utf8');
      });
  
      stream.on('close', (code, signal) => {
        cleanup();
        res.json({
          exitCode: code,
          signal,
          stdout,
          stderr,
        });
      });
    });
}

function closeSession(req, res) {
  const { sessionId } = req.params;
  const session = sessions[sessionId];

  if (session) {
    logger.info('terminal-api', 'Closing session', { sessionId });
    session.conn.end();
    delete sessions[sessionId];
    res.status(200).json({ message: 'Session closed' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
}

// --- V2 API with standardized JSON response ---

const sendSuccess = (res, data, statusCode = 200) => {
  res.status(statusCode).json({ success: true, data });
};

const sendError = (res, message, statusCode = 500) => {
  res.status(statusCode).json({ success: false, error: { message } });
};

async function createSessionV2(req, res) {
    const { serverId } = req.body;
    if (!serverId) {
      return sendError(res, 'serverId is required', 400);
    }
  
    const server = findServer(serverId);
    if (!server) {
      return sendError(res, 'Server not found', 404);
    }
  
    let key, passphrase, password, useAgent;
    try {
      const r = resolvePrivateKey(server.ssh.credentialId);
      key = r.key; passphrase = r.passphrase; password = r.password; useAgent = r.useAgent;
    } catch (e) {
      return sendError(res, 'Credential error: ' + e.message, 500);
    }
  
    const conn = new Client();
    const sessionId = uuidv4();
  
    conn.on('ready', () => {
      sessions[sessionId] = { conn, lastUsed: Date.now(), serverId };
      sendSuccess(res, { sessionId }, 201);
    }).on('error', (err) => {
      logger.error('terminal-api', 'SSH connection error (v2)', { serverId, error: err.message });
      sendError(res, 'SSH connection failed: ' + err.message, 500);
    }).connect((() => {
        const base = { host: server.ssh.host, port: Number(server.ssh.port) || 22, username: server.ssh.user };
        const auth = { ...base };
        const agentSock = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
        if (useAgent) auth.agent = agentSock;
        if (key) auth.privateKey = key;
        if (passphrase) auth.passphrase = passphrase;
        if (password) auth.password = password;
        return auth;
      })());
}

function executeCommandV2(req, res) {
    const { sessionId } = req.params;
    const { command, timeout = 30000 } = req.body;
  
    if (!command) {
      return sendError(res, 'command is required', 400);
    }
  
    const session = sessions[sessionId];
    if (!session) {
      return sendError(res, 'Session not found or expired', 404);
    }
  
    session.lastUsed = Date.now();
    const { conn } = session;
  
    let stdout = '';
    let stderr = '';
    let timer;
  
    conn.exec(command, {}, (err, stream) => {
      if (err) {
        logger.error('terminal-api', 'SSH exec error (v2)', { sessionId, error: err.message });
        return sendError(res, 'Failed to execute command: ' + err.message, 500);
      }
  
      const cleanup = () => clearTimeout(timer);
  
      timer = setTimeout(() => {
        stream.close();
        cleanup();
        logger.error('terminal-api', 'Command timed out (v2)', { sessionId });
        sendError(res, 'Command execution timed out', 500);
      }, timeout);
  
      stream.on('data', (data) => { stdout += data.toString('utf8'); });
      stream.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
  
      stream.on('close', (code, signal) => {
        cleanup();
        sendSuccess(res, { exitCode: code, signal, stdout, stderr });
      });
    });
}

function closeSessionV2(req, res) {
    const { sessionId } = req.params;
    const session = sessions[sessionId];
  
    if (session) {
      logger.info('terminal-api', 'Closing session (v2)', { sessionId });
      session.conn.end();
      delete sessions[sessionId];
      sendSuccess(res, { message: 'Session closed' });
    } else {
      sendError(res, 'Session not found', 404);
    }
}

module.exports = {
  createSession,
  executeCommand,
  closeSession,
  createSessionV2,
  executeCommandV2,
  closeSessionV2,
};
