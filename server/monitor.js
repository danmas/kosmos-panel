const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const { Client } = require('ssh2');
const { JSONPath } = require('jsonpath-plus');
const dotenv = require('dotenv');

const inventoryPath = path.join(process.cwd(), 'inventory.json');
if (!fs.existsSync(inventoryPath)) {
  throw new Error('inventory.json not found in project root');
}
function expandEnvPlaceholders(obj) {
  const usedVars = new Set();
  
  function processValue(value) {
    if (value == null) return value;
    
    if (typeof value === 'string') {
      // Поддержка ${VAR_NAME} синтаксиса
      let result = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => {
        usedVars.add(name);
        const envValue = process.env[name];
        if (envValue === undefined) {
          console.warn(`[Config] Переменная окружения ${name} не найдена`);
        }
        return envValue ?? '';
      });
      
      // Поддержка $VAR_NAME синтаксиса (без фигурных скобок)
      result = result.replace(/\$([A-Z0-9_]+)/gi, (_, name) => {
        usedVars.add(name);
        const envValue = process.env[name];
        if (envValue === undefined) {
          console.warn(`[Config] Переменная окружения ${name} не найдена`);
        }
        return envValue ?? '';
      });
      
      return result;
    }
    
    if (Array.isArray(value)) {
      return value.map(processValue);
    }
    
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = processValue(v);
      }
      return out;
    }
    
    return value;
  }
  
  const result = processValue(obj);
  
  if (usedVars.size > 0) {
    console.log(`[Config] Используемые переменные окружения: ${Array.from(usedVars).join(', ')}`);
  }
  
  return result;
}

const inventory = expandEnvPlaceholders(JSON.parse(fs.readFileSync(inventoryPath, 'utf8')));

// Cache private keys in memory
const credentialCache = new Map();
function getCredential(credentialId) {
  const cred = (inventory.credentials || []).find((c) => c.id === credentialId);
  if (!cred) throw new Error(`Credential not found: ${credentialId}`);
  if (!credentialCache.has(cred.id)) {
    let privateKey;
    try {
      if (cred.privateKeyPath) privateKey = fs.readFileSync(cred.privateKeyPath, 'utf8');
    } catch (e) {
      // ignore read errors here; auth may use agent/password
    }
    const useAgent = typeof cred.useAgent === 'string' ? ['1', 'true', 'yes', 'on'].includes(cred.useAgent.toLowerCase()) : !!cred.useAgent;
    credentialCache.set(cred.id, { ...cred, useAgent, privateKey });
  }
  return credentialCache.get(cred.id);
}

function reloadInventory() {
  // Перечитываем .env файл, чтобы подхватить изменения без перезапуска
  dotenv.config({ path: path.join(process.cwd(), '.env'), override: true });
  console.log('[Config] Переменные окружения из .env перезагружены.');

  const raw = fs.readFileSync(inventoryPath, 'utf8');
  const fresh = expandEnvPlaceholders(JSON.parse(raw));
  // mutate exported object in-place so other modules keep reference
  for (const k of Object.keys(inventory)) delete inventory[k];
  Object.assign(inventory, fresh);
  credentialCache.clear();
  return true;
}

function sshExec({ ssh, command, timeoutMs = 5000 }) {
  const cred = getCredential(ssh.credentialId);
  const serverInfo = `${ssh.user}@${ssh.host}:${ssh.port || 22}`;

  return new Promise((resolve, reject) => {
    // console.log(`[SSH] Попытка подключения к ${serverInfo} для команды: "${command}"`);

    const conn = new Client();
    let timer;

    conn
      .on('ready', () => {
        // console.log(`[SSH] Успешное подключение к ${serverInfo}`);
        conn.exec(command, { pty: false }, (err, stream) => {
          if (err) {
            // console.error(`[SSH] Ошибка выполнения команды на ${serverInfo}:`, err.message);
            clearTimeout(timer);
            conn.end();
            return reject(new Error(`SSH exec error: ${err.message}`));
          }

          // console.log(`[SSH] Команда "${command}" выполняется на ${serverInfo}`);
          let stdout = '';
          let stderr = '';

          stream
            .on('close', (code, signal) => {
              clearTimeout(timer);
              conn.end();

              const result = { code, signal, stdout: stdout.trim(), stderr: stderr.trim() };
              // console.log(`[SSH] Команда завершена на ${serverInfo}, код: ${code}, сигнал: ${signal}`);

              if (stderr) {
                // console.warn(`[SSH] Stderr на ${serverInfo}: ${stderr}`);
              }

              resolve(result);
            })
            .on('data', (d) => {
              stdout += d.toString();
            })
            .stderr.on('data', (d) => {
              stderr += d.toString();
            });
        });
      })
      .on('error', (e) => {
        // console.error(`[SSH] Ошибка подключения к ${serverInfo}:`, {
        //   message: e.message,
        //   code: e.code,
        //   level: e.level,
        //   description: e.description,
        //   stack: e.stack
        // });
        clearTimeout(timer);
        reject(new Error(`SSH connection error: ${e.message}`));
      })
      .on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
        // console.log(`[SSH] Keyboard-interactive auth для ${serverInfo}`);
        finish([]);
      })
      .on('tcp connection', () => {
        // console.log(`[SSH] TCP соединение установлено с ${serverInfo}`);
      })
      .on('handshake', (negotiated) => {
        // console.log(`[SSH] SSH handshake завершен для ${serverInfo}`);
      })
      .connect((() => {
        const base = { host: ssh.host, port: Number(ssh.port) || 22, username: ssh.user };
        const agentSock = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
        const auth = { ...base };

        // Логируем параметры аутентификации (без чувствительных данных)
        // console.log(`[SSH] Параметры подключения к ${serverInfo}:`, {
        //   host: ssh.host,
        //   port: ssh.port || 22,
        //   username: ssh.user,
        //   hasPrivateKey: !!cred.privateKey,
        //   hasPassphrase: !!cred.passphrase,
        //   hasPassword: !!cred.password,
        //   useAgent: cred.useAgent,
        //   agentSock: agentSock ? 'configured' : 'not configured',
        //   timeoutMs: timeoutMs
        // });

        if (cred.useAgent) auth.agent = agentSock;
        if (cred.privateKey) auth.privateKey = cred.privateKey;
        if (cred.passphrase) auth.passphrase = cred.passphrase;
        if (cred.password) auth.password = cred.password;

        return auth;
      })());

    timer = setTimeout(() => {
      // console.error(`[SSH] Таймаут подключения к ${serverInfo} после ${timeoutMs}мс`);
      try { conn.end(); } catch {}
      reject(new Error(`SSH timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

// HTTP fetch (Node 18+)
let fetchFn = global.fetch;
async function ensureFetch() {
  if (!fetchFn) fetchFn = (await import('undici')).fetch;
}

async function checkHttp(svc) {
  await ensureFetch();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), svc.timeoutMs || 3000);
  try {
    const res = await fetchFn(svc.url, { signal: controller.signal });
    const statusOk = svc.expectStatus ? res.status === svc.expectStatus : res.ok;
    let detail = `HTTP ${res.status}`;
    if (svc.expectTextIncludes) {
      const text = await res.text();
      if (!text.includes(svc.expectTextIncludes)) return { ok: false, detail: `${detail}, not includes "${svc.expectTextIncludes}"` };
      detail = `${detail}, includes`;
    }
    return { ok: !!statusOk, detail };
  } catch (e) {
    return { ok: false, detail: `HTTP error: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

async function checkHttpJson(svc) {
  await ensureFetch();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), svc.timeoutMs || 3000);
  try {
    const res = await fetchFn(svc.url, { signal: controller.signal, headers: { 'accept': 'application/json' } });
    const json = await res.json().catch(() => ({}));
    const results = {};
    let allOk = true;
    for (const rule of svc.rules || []) {
      const matches = JSONPath({ path: rule.path, json });
      let ok = false;
      if (rule.equals !== undefined) ok = matches.some((v) => v === rule.equals);
      else if (rule.includes !== undefined) ok = matches.some((v) => String(v).includes(String(rule.includes)));
      else if (rule.exists) ok = matches.length > 0;
      results[rule.name || rule.path] = ok;
      if (!ok) allOk = false;
    }
    return { ok: allOk, detail: `JSON rules: ${Object.values(results).filter(Boolean).length}/${(svc.rules || []).length} ok` };
  } catch (e) {
    return { ok: false, detail: `HTTP JSON error: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

function checkTcp(svc) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeoutMs = svc.timeoutMs || 2000;
    let done = false;
    function finish(ok, detail) {
      if (done) return; done = true;
      try { socket.destroy(); } catch {}
      resolve({ ok, detail });
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, `TCP ${svc.host}:${svc.port} ok`));
    socket.once('timeout', () => finish(false, 'TCP timeout'));
    socket.once('error', (e) => finish(false, `TCP error: ${e.code || e.message}`));
    socket.connect(svc.port, svc.host);
  });
}

function checkTls(svc) {
  return new Promise((resolve) => {
    const timeoutMs = svc.timeoutMs || 3000;
    const socket = tls.connect({ host: svc.host, port: svc.port || 443, servername: svc.servername || svc.host, rejectUnauthorized: false });
    let timer = setTimeout(() => { try { socket.destroy(); } catch {}; resolve({ ok: false, detail: 'TLS timeout' }); }, timeoutMs);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      try { socket.end(); } catch {}
      clearTimeout(timer);
      if (!cert || !cert.valid_to) return resolve({ ok: false, detail: 'no cert' });
      const expires = new Date(cert.valid_to).getTime();
      const daysLeft = Math.floor((expires - Date.now()) / 86400000);
      const minDays = svc.minDaysLeft || 7;
      const ok = daysLeft >= minDays;
      resolve({ ok, detail: `TLS expires in ${daysLeft}d` });
    });
    socket.once('error', (e) => { clearTimeout(timer); resolve({ ok: false, detail: `TLS error: ${e.message}` }); });
  });
}

async function checkSystemd(server, svc) {
  try {
    // console.log(`[Monitor] Проверка systemd сервиса ${svc.service} на сервере ${server.name}`);
    const { stdout } = await sshExec({ ssh: server.ssh, command: `systemctl is-active ${svc.service} || echo inactive`, timeoutMs: svc.timeoutMs || 3000 });
    const ok = stdout.trim() === 'active';
    // console.log(`[Monitor] Systemd сервис ${svc.service} на ${server.name}: ${ok ? 'OK' : 'FAIL'} (${stdout.trim()})`);
    return { ok, detail: `systemd: ${stdout.trim()}` };
  } catch (error) {
    // console.error(`[Monitor] Ошибка проверки systemd ${svc.service} на ${server.name}:`, error.message);
    return { ok: false, detail: `systemd error: ${error.message}` };
  }
}

async function checkSshCommand(server, svc) {
  try {
    // console.log(`[Monitor] Проверка SSH команды "${svc.command}" на сервере ${server.name}`);
    const { stdout, stderr } = await sshExec({ ssh: server.ssh, command: svc.command, timeoutMs: svc.timeoutMs || 4000 });
    const out = (stdout + '\n' + stderr).trim();
    const ok = svc.okPattern ? new RegExp(svc.okPattern, 'i').test(out) : true;
    // console.log(`[Monitor] SSH команда "${svc.command}" на ${server.name}: ${ok ? 'OK' : 'FAIL'} (pattern: "${svc.okPattern || 'none'}")`);
    return { ok, detail: out.slice(0, 256) || '(no output)' };
  } catch (error) {
    // console.error(`[Monitor] Ошибка выполнения SSH команды "${svc.command}" на ${server.name}:`, error.message);
    return { ok: false, detail: `ssh command error: ${error.message}` };
  }
}

async function checkDockerContainer(server, svc) {
  const name = svc.container || svc.name;
  const timeoutMs = svc.timeoutMs || 8000; // give docker more time by default

  try {
    // console.log(`[Monitor] Проверка Docker контейнера "${name}" на сервере ${server.name}`);

    async function runOnce() {
      // 1) Try fast path via `docker inspect` (more direct than `ps`)
      let res;
      try {
        res = await sshExec({ ssh: server.ssh, command: `/usr/bin/docker inspect --type container --format '{{.State.Status}}' ${name}`, timeoutMs });
        const status = (res.stdout || '').trim().toLowerCase();
        if (res.code === 0 && status) {
          const ok = status === 'running';
          return { ok, detail: `inspect: ${status}` };
        }
      } catch (e) {
        // fall through to ps on errors (including timeout handled by caller)
        throw e;
      }

      // 2) Fallback to `docker ps` exact name match
      const fmt = "{{.Names}}|{{.Status}}";
      const cmd = `/usr/bin/docker ps --format '${fmt}' --filter status=running --filter name=^${name}$`;
      const { stdout, stderr } = await sshExec({ ssh: server.ssh, command: cmd, timeoutMs });
      const line = (stdout || '').trim();
      const ok = line.toLowerCase().includes('up');
      const detail = line || (stderr.trim() || 'not found');
      return { ok, detail: detail.slice(0, 256) };
    }

    // Retry once on SSH timeout
    try {
      const result = await runOnce();
      // console.log(`[Monitor] Docker контейнер "${name}" на ${server.name}: ${result.ok ? 'OK' : 'FAIL'} (${result.detail})`);
      return result;
    } catch (e) {
      if (String(e && e.message || '').includes('timeout')) {
        try {
          const result = await runOnce();
          // console.log(`[Monitor] Docker контейнер "${name}" на ${server.name} после повторной попытки: ${result.ok ? 'OK' : 'FAIL'} (${result.detail})`);
          return result;
        } catch (e2) {
          // console.error(`[Monitor] Ошибка проверки Docker контейнера "${name}" на ${server.name} после повторной попытки:`, e2.message);
          return { ok: false, detail: `check error after retry: ${e2.message}` };
        }
      }
      // console.error(`[Monitor] Ошибка проверки Docker контейнера "${name}" на ${server.name}:`, e.message);
      return { ok: false, detail: `check error: ${e.message}` };
    }
  } catch (error) {
    // console.error(`[Monitor] Критическая ошибка проверки Docker контейнера "${name}" на ${server.name}:`, error.message);
    return { ok: false, detail: `docker check error: ${error.message}` };
  }
}

async function runServiceCheck(server, svc) {
  try {
    if (svc.type === 'http') return await checkHttp(svc);
    if (svc.type === 'httpJson') return await checkHttpJson(svc);
    if (svc.type === 'tcp') return await checkTcp(svc);
    if (svc.type === 'tls') return await checkTls(svc);
    if (svc.type === 'systemd') return await checkSystemd(server, svc);
    if (svc.type === 'sshCommand') return await checkSshCommand(server, svc);
    if (svc.type === 'dockerContainer') return await checkDockerContainer(server, svc);
    return { ok: false, detail: `unknown service type: ${svc.type}` };
  } catch (e) {
    return { ok: false, detail: `check error: ${e.message}` };
  }
}

const lastSnapshot = { ts: 0, servers: {} };

async function pollOnce() {
  const results = {};
  const servers = inventory.servers || [];
  await Promise.all(
    servers.map(async (server) => {
      const perServices = {};
      await Promise.all((server.services || []).map(async (svc) => {
        const res = await runServiceCheck(server, svc);
        const serviceData = { name: svc.name, type: svc.type, ok: res.ok, detail: res.detail };
        // Pass url to frontend for applicable service types
        if (svc.url && (svc.type === 'http' || svc.type === 'httpJson')) {
          serviceData.url = svc.url;
        }
        perServices[svc.id] = serviceData;
      }));
      const oks = Object.values(perServices).map((s) => s.ok);
      const color = oks.length === 0 ? 'gray' : oks.every(Boolean) ? 'green' : oks.some(Boolean) ? 'yellow' : 'red';
      results[server.id] = { id: server.id, name: server.name, env: server.env, ssh: server.ssh, color, services: perServices };
    })
  );
  lastSnapshot.ts = Date.now();
  lastSnapshot.servers = results;
}

function startScheduler() {
  const intervalSec = (inventory.poll && inventory.poll.intervalSec) || 15;
  pollOnce().catch(() => {});
  setInterval(() => {
    pollOnce().catch(() => {});
  }, intervalSec * 1000);
  // watch inventory for changes and hot-reload
  try {
    fs.watchFile(inventoryPath, { interval: 1000 }, async (curr, prev) => {
      if (curr.mtimeMs && prev.mtimeMs && curr.mtimeMs === prev.mtimeMs) return;
      try {
        reloadInventory();
        await pollOnce();
      } catch {}
    });
  } catch {}
}

function getSnapshot() {
  return { ts: lastSnapshot.ts, servers: lastSnapshot.servers };
}

module.exports = { startScheduler, getSnapshot, inventory, sshExec, reloadInventory };


