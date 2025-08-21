const grid = document.getElementById('grid');
const tsEl = document.getElementById('ts');
const tooltip = document.getElementById('tooltip');

const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayClose = document.getElementById('overlay-close');
const terminalEl = document.getElementById('terminal');
const termInput = null;

overlayClose.onclick = () => closeOverlay();

// xterm.js
let xterm, fitAddon;
function ensureTerm() {
  if (xterm) return xterm;
  xterm = new window.Terminal({
    convertEol: true,
    cursorBlink: true,
    theme: { background: '#000000', foreground: '#00ff00' }
  });
  fitAddon = new window.FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.open(terminalEl);
  setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);
  window.addEventListener('resize', () => { try { fitAddon.fit(); } catch {} });
  return xterm;
}

function openOverlay(title) {
  overlayTitle.textContent = title;
  overlay.classList.remove('hidden');
  try { termInput.focus(); } catch {}
}
function closeOverlay() {
  overlay.classList.add('hidden');
  if (currentWs) {
    try { currentWs.close(); } catch {}
  }
  terminalEl.textContent = '';
}

async function fetchServers() {
  const res = await fetch('/api/servers');
  return res.json();
}

function render(servers) {
  grid.innerHTML = '';
  servers.forEach((s) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.onmouseenter = (e) => showTooltip(e, s);
    tile.onmouseleave = hideTooltip;
    tile.onclick = () => openActions(s);
    tile.innerHTML = `
      <div class="status ${s.color}"></div>
      <div class="name">${s.name}</div>
      <div class="env">${s.env}</div>
      ${s.services
        .map(
          (sv) => {
            const link = (sv.url && (sv.type === 'http' || sv.type === 'httpJson'))
              ? ` <a href="${sv.url}" target="_blank" class="svc-link" title="Открыть в новой вкладке" onclick="event.stopPropagation()">🔗</a>`
              : '';
            return `
              <div class="svc">
                <div class="dot ${sv.ok ? 'ok' : 'fail'}"></div>
                <div>${sv.name} <span style="opacity:.7">(${sv.type})</span>${link}</div>
              </div>
            `;
          }
        )
        .join('')}
    `;
    grid.appendChild(tile);
  });
}

function showTooltip(ev, server) {
  const lines = server.services
    .map((sv) => {
      const icon = sv.ok ? '✅' : '❌';
      const detail = (sv.detail || '').replace(/\s+/g, ' ').slice(0, 160);
      return `<div class="line">${icon} <b>${sv.name}</b> — ${detail}</div>`;
    })
    .join('');
  tooltip.innerHTML = `<div class="title">${server.name} — ${server.env}</div>${lines}`;
  tooltip.classList.remove('hidden');
  positionTooltip(ev);
}
function positionTooltip(ev) {
  const pad = 12;
  const rect = tooltip.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + rect.width > window.innerWidth) x = ev.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = ev.clientY - rect.height - pad;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}
function hideTooltip() {
  tooltip.classList.add('hidden');
}

function openActions(server) {
  const sshUrl = `ssh://${server.ssh.user}@${server.ssh.host}:${server.ssh.port || 22}`;
  const choice = prompt(
    [
      'Выберите действие:',
      '1. Открыть SSH-терминал (в панели)',
      '2. Tail лога (/var/log/syslog)',
      '3. Открыть SSH (внешний клиент)',
      '4. Скопировать команду SSH',
      '5. Открыть терминал в отдельном окне',
      '6. Открыть tail (/var/log/syslog) в отдельном окне',
      '7. Открыть терминал во всплывающем окне браузера'
    ].join('\n')
  );
  if (choice === '1') openTerminal(server);
  else if (choice === '2') openTail(server, '/var/log/syslog');
  else if (choice === '3') window.location.href = sshUrl;
  else if (choice === '4') copyText(`ssh ${server.ssh.user}@${server.ssh.host} -p ${server.ssh.port || 22}`);
  else if (choice === '5') openTerminalWindow(server, 'terminal');
  else if (choice === '6') openTerminalWindow(server, 'tail', '/var/log/syslog');
  else if (choice === '7') window.open(`/term.html?mode=terminal&serverId=${encodeURIComponent(server.id)}`, '_blank', 'width=900,height=600');
}

let currentWs = null;

function openTerminal(server) {
  openOverlay(`${server.name} — терминал`);
  terminalEl.innerHTML = '';
  ensureTerm(); xterm.clear();
  // fit после рендера
  setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);
  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${window.location.host}/ws/terminal?serverId=${encodeURIComponent(server.id)}&cols=120&rows=30`;
  const ws = new WebSocket(wsUrl);
  currentWs = ws;
  xterm.writeln('[подключение к SSH...]');
  ws.onopen = () => {
    xterm.writeln('[соединение установлено]');
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'fatal') {
        xterm.writeln(`\r\n[FATAL] ${msg.error}`);
        return;
      }
      if (msg.type === 'data' || msg.type === 'err') {
        xterm.write(msg.data);
      }
    } catch {}
  };
  ws.onclose = (ev) => {
    xterm.writeln(`\r\n[соединение закрыто${ev.code ? ' код ' + ev.code : ''}]`);
  };

  xterm.onData((data) => {
    // Для интерактивности, всегда отправляем данные на сервер
    try { ws.send(JSON.stringify({ type: 'data', data })); } catch {}
  });

  xterm.attachCustomKeyEventHandler((arg) => {
    if (arg.code === 'Enter' && arg.type === 'keydown') {
      const buffer = xterm.buffer.active;
      const commandLine = buffer.getLine(buffer.cursorY).translateToString(true).trim();

      if (commandLine.startsWith('ai:')) {
        ws.send(JSON.stringify({ type: 'ai_query', prompt: commandLine }));
        return false; // Блокируем отправку Enter через onData
      } else if (commandLine) {
        ws.send(JSON.stringify({ type: 'command_log', command: commandLine }));
      }
    }
    return true; // Разрешаем все остальные клавиши
  });
}

function openTail(server, path) {
  openOverlay(`${server.name} — tail ${path}`);
  terminalEl.innerHTML = '';
  ensureTerm(); xterm.clear();
  setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);
  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${window.location.host}/ws/tail?serverId=${encodeURIComponent(server.id)}&path=${encodeURIComponent(path)}&lines=200`;
  const ws = new WebSocket(wsUrl);
  currentWs = ws;
  xterm.writeln(`[tail ${path}]`);
  ws.onopen = () => { xterm.writeln('[соединение установлено]'); };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'data' || msg.type === 'err') {
        xterm.write(msg.data);
      }
    } catch {}
  };
  ws.onclose = (ev) => { xterm.writeln(`\r\n[соединение закрыто${ev.code ? ' код ' + ev.code : ''}]`); };
}

// Drag overlay
(function enableDrag() {
  const header = document.querySelector('.overlay-top');
  const panel = document.querySelector('.overlay-content');
  let dragging = false; let startX = 0; let startY = 0; let startLeft = 0; let startTop = 0;
  header.addEventListener('mousedown', (e) => {
    dragging = true; startX = e.clientX; startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    // Позиционируем абсолюто, чтобы двигать
    panel.style.position = 'fixed';
    startLeft = rect.left; startTop = rect.top;
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX; const dy = e.clientY - startY;
    panel.style.left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + dx)) + 'px';
    panel.style.top = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startTop + dy)) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });
})();

// Multi-window terminals
let winCounter = 0;
function openTerminalWindow(server, mode, arg) {
  const id = 'win-' + (++winCounter);
  const win = document.createElement('div'); win.className = 'win'; win.id = id;
  win.innerHTML = `
    <div class="win-header"><div class="win-title"></div><button class="win-close">×</button></div>
    <div class="win-body"><div class="terminal"></div><div class="terminal-input"><input placeholder="введите команду и Enter" /></div></div>
  `;
  document.body.appendChild(win);
  const titleEl = win.querySelector('.win-title');
  const closeBtn = win.querySelector('.win-close');
  const termDiv = win.querySelector('.terminal');
  const input = win.querySelector('input');

  // drag
  (function dragWin() {
    const header = win.querySelector('.win-header');
    let dragging = false, sx=0, sy=0, sl=0, st=0;
    header.addEventListener('mousedown', (e) => { dragging = true; sx=e.clientX; sy=e.clientY; const r = win.getBoundingClientRect(); sl=r.left; st=r.top; document.body.style.userSelect='none'; });
    window.addEventListener('mousemove', (e) => { if(!dragging) return; const dx=e.clientX-sx, dy=e.clientY-sy; win.style.left=Math.max(0,Math.min(window.innerWidth-win.offsetWidth, sl+dx))+'px'; win.style.top=Math.max(0,Math.min(window.innerHeight-win.offsetHeight, st+dy))+'px'; });
    window.addEventListener('mouseup', ()=>{ dragging=false; document.body.style.userSelect=''; });
  })();

  // xterm per window
  const term = new window.Terminal({ convertEol:true, cursorBlink:true, theme:{ background:'#000000', foreground:'#00ff00' } });
  const fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open(termDiv); setTimeout(() => { try { fit.fit(); } catch {} }, 0);

  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = mode === 'tail'
    ? `${wsProto}://${window.location.host}/ws/tail?serverId=${encodeURIComponent(server.id)}&path=${encodeURIComponent(arg)}&lines=200`
    : `${wsProto}://${window.location.host}/ws/terminal?serverId=${encodeURIComponent(server.id)}&cols=120&rows=30`;
  const ws = new WebSocket(wsUrl);
  term.writeln(mode === 'tail' ? `[tail ${arg}]` : '[подключение к SSH...]');
  ws.onopen = () => term.writeln('[соединение установлено]');
  ws.onmessage = (ev) => { try { const msg = JSON.parse(ev.data); if (msg.type==='data'||msg.type==='err') term.write(msg.data); if (msg.type==='fatal') term.writeln(`\r\n[FATAL] ${msg.error}`); } catch {} };
  ws.onclose = (ev) => term.writeln(`\r\n[соединение закрыто${ev.code ? ' код ' + ev.code : ''}]`);
  closeBtn.onclick = () => { try { ws.close(); } catch {}; win.remove(); };

  if (mode === 'terminal') {
    term.onData((d) => { try { ws.send(JSON.stringify({ type:'data', data:d })); } catch {} });

    term.attachCustomKeyEventHandler((arg) => {
      if (arg.code === 'Enter' && arg.type === 'keydown') {
        const buffer = term.buffer.active;
        const commandLine = buffer.getLine(buffer.cursorY).translateToString(true).trim();
        
        if (commandLine.startsWith('ai:')) {
          ws.send(JSON.stringify({ type: 'ai_query', prompt: commandLine }));
          return false; // Блокируем отправку Enter через onData
        } else if (commandLine) {
          ws.send(JSON.stringify({ type: 'command_log', command: commandLine }));
        }
      }
      return true; // Разрешаем все остальные клавиши
    });
  }

  titleEl.textContent = mode === 'tail' ? `${server.name} — tail ${arg}` : `${server.name} — терминал (${id})`;
}

// AI Search functionality
const aiSearchInput = document.getElementById('ai-search-input');
const aiSearchBtn = document.getElementById('ai-search-btn');

function showAIResponse(query, response) {
  openOverlay(`AI Помощник: ${query.slice(0, 50)}...`);
  terminalEl.innerHTML = '';
  ensureTerm(); 
  xterm.clear();
  
  xterm.writeln(`\x1b[36m[Запрос]\x1b[0m ${query}\n`);
  xterm.writeln(`\x1b[32m[Ответ AI]\x1b[0m`);
  
  // Разбиваем ответ на строки для корректного отображения
  const lines = response.split('\n');
  lines.forEach(line => {
    xterm.writeln(line);
  });
  
  setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);
}

async function sendAIQuery(query) {
  try {
    aiSearchBtn.textContent = '⏳';
    aiSearchBtn.disabled = true;
    
    const response = await fetch('/api/ai-help', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    
    const result = await response.json();
    
    if (result.success) {
      showAIResponse(query, result.response);
    } else {
      showAIResponse(query, `Ошибка: ${result.error}`);
    }
  } catch (error) {
    showAIResponse(query, `Ошибка соединения: ${error.message}`);
  } finally {
    aiSearchBtn.textContent = '🔍';
    aiSearchBtn.disabled = false;
    aiSearchInput.value = '';
  }
}

aiSearchBtn.onclick = () => {
  const query = aiSearchInput.value.trim();
  if (query) sendAIQuery(query);
};

aiSearchInput.onkeydown = (e) => {
  if (e.key === 'Enter') {
    const query = aiSearchInput.value.trim();
    if (query) sendAIQuery(query);
  }
};

async function loop() {
  try {
    const data = await fetchServers();
    tsEl.innerText = new Date(data.ts || Date.now()).toLocaleTimeString();
    render(data.servers || []);
  } catch (e) {
    tsEl.innerText = 'Ошибка загрузки';
  } finally {
    setTimeout(loop, 5000);
  }
}

loop();


