const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');
const { inventory } = require('./monitor');
const { resolvePrivateKey, findServer } = require('./ws-utils');

const sessions = {};
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 минут

// Функция для очистки старых сессий
setInterval(() => {
  const now = Date.now();
  for (const sessionId in sessions) {
    if (now - sessions[sessionId].lastUsed > SESSION_TIMEOUT) {
      console.log(`[terminal-api] Closing stale session ${sessionId}`);
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
    console.error(`[terminal-api] SSH connection error for server ${serverId}:`, err);
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
        console.error(`[terminal-api] SSH exec error for session ${sessionId}:`, err);
        return res.status(500).json({ error: 'Failed to execute command: ' + err.message });
      }
  
      const cleanup = () => {
        clearTimeout(timer);
      };
  
      timer = setTimeout(() => {
        stream.close();
        cleanup();
        console.error(`[terminal-api] Command timed out for session ${sessionId}`);
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
    console.log(`[terminal-api] Closing session ${sessionId}`);
    session.conn.end();
    delete sessions[sessionId];
    res.status(200).json({ message: 'Session closed' });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
}

module.exports = {
  createSession,
  executeCommand,
  closeSession,
};
