/**
 * Health-check сервер для мониторинга Hermes Gateway (Linux)
 * Kosmos Panel мониторит его через httpJson проверки
 */
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');

const PORT = process.env.HEALTH_PORT || 3100;
const GATEWAY_LOG = process.env.HERMES_LOG || '/root/.hermes/logs/gateway.log';
const LOG_STALE_MINUTES = 5; // лог считается свежим, если обновлялся в последние N минут

// Кэш статусов (обновляется каждые 30 секунд)
let cache = {
  ts: 0,
  gateways: {},
  error: null
};

function execPromise(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', error: err });
    });
  });
}

function checkLogFreshness(logPath, maxAgeMinutes) {
  try {
    if (!fs.existsSync(logPath)) return { fresh: false, reason: 'no log file' };
    const stat = fs.statSync(logPath);
    const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
    return {
      fresh: ageMinutes < maxAgeMinutes,
      ageMin: Math.round(ageMinutes * 10) / 10,
      mtime: stat.mtime.toISOString()
    };
  } catch (e) {
    return { fresh: false, reason: e.message };
  }
}

async function checkProcesses() {
  const gateways = {};
  const logCheck = checkLogFreshness(GATEWAY_LOG, LOG_STALE_MINUTES);

  // 1. Основной gateway — systemd hermes-gateway.service
  try {
    const r = await execPromise('systemctl --user is-active hermes-gateway');
    const active = r.stdout.trim() === 'active';

    // Дополнительно: PID процесса
    const pidR = await execPromise("pgrep -f 'hermes_cli.main gateway' | head -1");
    const pid = pidR.stdout.trim();

    gateways['main'] = {
      name: '🤖 Hermes Gateway (systemd)',
      alive: active,
      systemd: active ? 'active' : r.stdout.trim() || 'inactive',
      pid: pid || null,
      log: logCheck,
      detail: active
        ? (logCheck.fresh ? 'OK' : 'running but log stale')
        : 'not active'
    };
  } catch (e) {
    gateways['main'] = {
      name: '🤖 Hermes Gateway (systemd)',
      alive: false,
      error: e.message,
      log: logCheck,
      detail: 'check failed'
    };
  }

  // 2. Проверка PM2 gateway (если есть — расширяемо)
  // На этой машине gateway через systemd, но можно добавить PM2 проверки позже

  cache = { ts: Date.now(), gateways, error: null };
}

// HTTP сервер
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET / — HTML status page
  if (url.pathname === '/') {
    const allAlive = Object.values(cache.gateways).every(g => g.alive);
    const color = allAlive ? 'green' : 'red';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head><title>Hermes Gateway Health</title>
<meta http-equiv="refresh" content="10">
<style>body{font-family:sans-serif;background:#111;color:#eee;padding:20px}
h1{color:${color === 'green' ? '#4ade80' : '#f87171'}}
.ok{color:#4ade80}.fail{color:#f87171}
pre{background:#1a1a1a;padding:10px;border-radius:6px}
</style></head><body>
<h1>${allAlive ? '✅ All Gateways Online' : '❌ Some Gateways Down'}</h1>
<p>Last checked: ${new Date(cache.ts).toLocaleString()}</p>
<pre>${JSON.stringify(cache.gateways, null, 2)}</pre>
</body></html>`);
    return;
  }

  // GET /health — JSON health check
  if (url.pathname === '/health') {
    const allAlive = Object.values(cache.gateways).every(g => g.alive);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: allAlive,
      healthy: allAlive,
      ts: new Date().toISOString(),
      gateways: cache.gateways
    }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Health server listening on http://127.0.0.1:${PORT}`);
  checkProcesses();
  setInterval(checkProcesses, 30000);
});
