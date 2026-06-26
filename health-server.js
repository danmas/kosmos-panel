/**
 * Health-check сервер для мониторинга Hermes Gateway
 * Kosmos Panel мониторит его через httpJson проверки
 */
const http = require('http');
const { exec } = require('child_process');

const PORT = process.env.HEALTH_PORT || 3100;

// Кэш статусов (обновляется каждые 30 секунд)
let cache = {
  ts: 0,
  gateways: {},
  error: null
};

const GATEWAY_PORT_MAP = {};
const HERMES_HOME = process.env.USERPROFILE + '\\AppData\\Local\\hermes';

async function checkProcesses() {
  const gateways = {};

  // 1. Carl-DB (из планировщика) — проверка процесса + свежести лога
  try {
    const procResult = await execPromise(
      `powershell -Command "Get-Process hermes -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`
    );
    const logResult = await execPromise(
      `powershell -Command "$t=(Get-Item '${HERMES_HOME}\\logs\\gateway.log' -ErrorAction SilentlyContinue).LastWriteTime; if($t -and ($t -gt (Get-Date).AddMinutes(-5))){'FRESH'}else{'STALE'}"`
    );
    const hasProcess = procResult.stdout.trim().length > 0;
    const logFresh = logResult.stdout.trim() === 'FRESH';
    gateways['default'] = {
      name: '🤖 HA-Work Gateway (default)',
      alive: hasProcess && logFresh,
      process: hasProcess ? 'running' : 'stopped',
      log: logFresh ? 'fresh' : 'stale',
      detail: hasProcess && logFresh ? 'OK' : (hasProcess ? 'log stale' : 'no process')
    };
  } catch (e) {
    gateways['default'] = { name: '🤖 HA-Work Gateway (default)', alive: false, error: e.message };
  }

  // 2-3. PM2 gateway — парсим jlist напрямую через Node.js (без PowerShell)
  try {
    const pm2Result = await execPromise('pm2 jlist');
    const apps = JSON.parse(pm2Result.stdout || '[]');

    const pm2Gateways = [
      { id: 'carl-db', name: 'Carl-DB Gateway', pm2Name: 'hermes-carl-db-gateway' },
      { id: 'pilot-work', name: 'Hermes Pilot-Work Gateway', pm2Name: 'hermes-pilot-work-gateway' },
      { id: 'projects-ex', name: 'Hermes Projects-Ex Gateway', pm2Name: 'hermes-projects-ex-gateway' }
    ];

    for (const gw of pm2Gateways) {
      const app = apps.find(a => a.name === gw.pm2Name);
      const status = app?.pm2_env?.status || 'stopped';
      gateways[gw.id] = {
        name: gw.name,
        alive: status === 'online',
        pm2_status: status,
        detail: status === 'online' ? 'OK' : status
      };
    }
  } catch (e) {
    // fallback если pm2 недоступен
    if (!gateways['carl-db']) gateways['carl-db'] = { name: 'Carl-DB Gateway', alive: false, error: e.message };
    if (!gateways['pilot-work']) gateways['pilot-work'] = { name: 'Hermes Pilot-Work Gateway', alive: false, error: e.message };
    if (!gateways['projects-ex']) gateways['projects-ex'] = { name: 'Hermes Projects-Ex Gateway', alive: false, error: e.message };
  }

  cache = { ts: Date.now(), gateways, error: null };
}

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', error: err });
    });
  });
}

// HTTP сервер
const server = http.createServer((req, res) => {
  // CORS
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

  // GET /health — JSON health check (основной endpoint для Kosmos Panel)
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

  // 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Health server listening on http://127.0.0.1:${PORT}`);
  // Первичная проверка
  checkProcesses();
  // Проверка каждые 30 секунд
  setInterval(checkProcesses, 30000);
});
