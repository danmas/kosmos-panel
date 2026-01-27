const grid = document.getElementById('grid');
const tsEl = document.getElementById('ts');
const tooltip = document.getElementById('tooltip');
let lastServerData = []; // Для хранения последних данных

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
  if (xterm) {
    xterm.dispose();
    xterm = null;
    fitAddon = null;
  }
  terminalEl.innerHTML = '';
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
    
    // Создаем HTML для плитки
    let servicesHTML = '';
    s.services.forEach(sv => {
      let links = '';
      if (sv.url && (sv.type === 'http' || sv.type === 'httpJson')) {
        links += ` <a href="${sv.url}" target="_blank" class="svc-link" title="Открыть в новой вкладке" onclick="event.stopPropagation()">🔗</a>`;
      }
      if (sv.hasLogs) {
        links += ` <a href="#" onclick="openSshLogs('${s.id}', '${sv.id}', '${sv.name}'); event.stopPropagation()" class="svc-link" title="Показать лог">📜</a>`;
      }
      servicesHTML += `
        <div class="svc" data-service-id="${sv.id}">
          <div class="dot ${sv.ok ? 'ok' : 'fail'}"></div>
          <div>${sv.name} <span style="opacity:.7">(${sv.type})</span>${links}</div>
        </div>
      `;
    });
    
    tile.innerHTML = `
      <div class="status ${s.color}"></div>
      <div class="tile-header">
        <div class="name">${s.name}</div>
        <button class="tile-actions-btn" data-server-id="${s.id}" title="Действия с сервером">⚡</button>
      </div>
      <div class="env">${s.env}</div>
      ${servicesHTML}
    `;
    
    // Обработчик кнопки действий
    const actionsBtn = tile.querySelector('.tile-actions-btn');
    actionsBtn.onclick = (e) => {
      e.stopPropagation();
      openActionsModal(s);
    };
    
    // Добавляем обработчики событий для каждого сервиса
    tile.querySelectorAll('.svc').forEach(svcEl => {
      const serviceId = svcEl.dataset.serviceId;
      const service = s.services.find(sv => sv.id === serviceId);
      
      svcEl.onmouseenter = (e) => {
        e.stopPropagation(); // Останавливаем всплытие, чтобы не сработал обработчик плитки
        showServiceTooltip(e, service);
      };
      
      svcEl.onmouseleave = (e) => {
        // Проверяем, не наведена ли мышь на другой сервис или на плитку
        const relatedTarget = e.relatedTarget;
        if (!relatedTarget || !tile.contains(relatedTarget)) {
          hideTooltip();
        }
      };
    });
    
    grid.appendChild(tile);
  });
}

function showTooltip(ev, server) {
  const lines = server.services
    .map((sv) => {
      const icon = sv.ok ? '✅' : '❌';
      const description = sv.description || sv.detail || '';
      const cleanDescription = description.replace(/\s+/g, ' ').slice(0, 160);
      return `<div class="line">${icon} <b>${sv.name}</b> — ${cleanDescription}</div>`;
    })
    .join('');
  tooltip.innerHTML = `<div class="title">${server.name} — ${server.env}</div>${lines}`;
  tooltip.classList.remove('hidden');
  positionTooltip(ev);
}

// Новая функция для показа подсказки для отдельного сервиса
function showServiceTooltip(ev, service) {
  if (!service) return;
  
  const icon = service.ok ? '✅' : '❌';
  const description = service.description || service.detail || '';
  const cleanDescription = description.replace(/\s+/g, ' ').slice(0, 160);
  
  tooltip.innerHTML = `
    <div class="title service-title">${service.name}</div>
    <div class="service-tooltip">
      <div class="service-status">${icon} ${service.ok ? 'Работает' : 'Не работает'}</div>
      <div class="service-type">Тип: ${service.type}</div>
      ${description ? `<div class="service-description">${cleanDescription}</div>` : ''}
      ${service.url ? `<div class="service-url">URL: ${service.url}</div>` : ''}
    </div>
  `;
  
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

function openSshLogs(serverId, serviceId, serviceName) {
  openOverlay(`Лог для ${serviceName}`);
  ensureTerm(); 
  xterm.clear();

  const server = lastServerData.find(s => s.id === serverId);
  const service = server ? Object.values(server.services).find(sv => sv.id === serviceId) : null;
  
  if (service && service.detail) {
    xterm.writeln(service.detail.replace(/\n/g, '\r\n'));
  } else {
    xterm.writeln(`\x1b[31m[Ошибка] Лог для этого сервиса не найден.\x1b[0m`);
  }
  
  setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);
}

// ========== Utility Functions ==========
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    // Показываем уведомление
    const notification = document.createElement('div');
    notification.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#22c55e;color:#fff;padding:12px 20px;border-radius:8px;z-index:9999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
    notification.textContent = '✓ Скопировано в буфер обмена';
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
    alert('Не удалось скопировать: ' + text);
  });
}

// ========== Actions Modal ==========
const actionsModal = document.getElementById('actionsModal');
const actionsModalTitle = document.getElementById('actionsModalTitle');
const actionsModalBody = document.getElementById('actionsModalBody');
const actionsModalClose = document.getElementById('actionsModalClose');

let currentActionServer = null;

const serverActions = [
  { id: 'terminal-panel', icon: '🖥️', label: 'SSH-терминал (в панели)', shortcut: '1' },
  { id: 'terminal-popup', icon: '🌐', label: 'Терминал в браузере (REST API)', shortcut: '7' },
  { id: 'terminal-window', icon: '📺', label: 'Терминал в отдельном окне', shortcut: '5' },
  { id: 'divider1' },
  { id: 'tail-panel', icon: '📜', label: 'Tail лога (/var/log/syslog)', shortcut: '2' },
  { id: 'tail-window', icon: '📋', label: 'Tail в отдельном окне', shortcut: '6' },
  { id: 'divider2' },
  { id: 'ssh-external', icon: '🔗', label: 'Открыть SSH (внешний клиент)', shortcut: '3' },
  { id: 'ssh-copy', icon: '📎', label: 'Скопировать команду SSH', shortcut: '4' },
];

function openActionsModal(server) {
  currentActionServer = server;
  actionsModalTitle.textContent = server.name;
  
  actionsModalBody.innerHTML = serverActions.map(action => {
    if (action.id.startsWith('divider')) {
      return '<div class="actions-modal-divider"></div>';
    }
    return `
      <button class="actions-modal-item" data-action="${action.id}">
        <span class="icon">${action.icon}</span>
        <span class="label">${action.label}</span>
        <span class="shortcut">${action.shortcut}</span>
      </button>
    `;
  }).join('');
  
  // Привязываем обработчики
  actionsModalBody.querySelectorAll('.actions-modal-item').forEach(btn => {
    btn.onclick = () => handleServerAction(btn.dataset.action);
  });
  
  actionsModal.classList.add('visible');
}

function closeActionsModal() {
  actionsModal.classList.remove('visible');
  currentActionServer = null;
}

function handleServerAction(actionId) {
  if (!currentActionServer) return;
  const server = currentActionServer;
  closeActionsModal();
  
  switch (actionId) {
    case 'terminal-panel':
      openTerminal(server);
      break;
    case 'terminal-popup':
      window.open(`/term.html?mode=terminal&serverId=${encodeURIComponent(server.id)}`, '_blank', 'width=900,height=600');
      break;
    case 'terminal-window':
      openTerminalWindow(server, 'terminal');
      break;
    case 'tail-panel':
      openTail(server, '/var/log/syslog');
      break;
    case 'tail-window':
      openTerminalWindow(server, 'tail', '/var/log/syslog');
      break;
    case 'ssh-external':
      window.location.href = `ssh://${server.ssh.user}@${server.ssh.host}:${server.ssh.port || 22}`;
      break;
    case 'ssh-copy':
      copyText(`ssh ${server.ssh.user}@${server.ssh.host} -p ${server.ssh.port || 22}`);
      break;
  }
}

actionsModalClose.onclick = closeActionsModal;
actionsModal.onclick = (e) => {
  if (e.target === actionsModal) closeActionsModal();
};

// Клавиатурные сокращения для модала
document.addEventListener('keydown', (e) => {
  if (!actionsModal.classList.contains('visible')) return;
  
  if (e.key === 'Escape') {
    closeActionsModal();
    return;
  }
  
  // Цифровые сокращения
  const shortcutMap = {
    '1': 'terminal-panel',
    '2': 'tail-panel',
    '3': 'ssh-external',
    '4': 'ssh-copy',
    '5': 'terminal-window',
    '6': 'tail-window',
    '7': 'terminal-popup',
  };
  
  if (shortcutMap[e.key]) {
    handleServerAction(shortcutMap[e.key]);
  }
});

// Legacy function - redirect to modal
function openActions(server) {
  openActionsModal(server);
}

let currentWs = null;

function openTerminal(server) {
  openOverlay(`${server.name} — терминал`);
  terminalEl.innerHTML = '';
  ensureTerm(); xterm.clear();
  setTimeout(() => { try { fitAddon.fit(); } catch {} }, 0);
  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${window.location.host}/ws/terminal?serverId=${encodeURIComponent(server.id)}&cols=120&rows=30`;
  const ws = new WebSocket(wsUrl);
  currentWs = ws;
  xterm.writeln('[подключение к SSH...]');
  ws.onopen = () => xterm.writeln('[соединение установлено]');
  ws.onclose = (ev) => xterm.writeln(`\r\n[соединение закрыто${ev.code ? ' код ' + ev.code : ''}]`);
  
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'fatal') { xterm.writeln(`\r\n[FATAL] ${msg.error}`); return; }
      if (msg.type === 'data' || msg.type === 'err') { xterm.write(msg.data); }
      if (msg.type === 'skills_list') {
        if (msg.skills && msg.skills.length > 0) {
          xterm.writeln('\r\n\x1b[1;36m=== Доступные Skills ===\x1b[0m');
          msg.skills.forEach(s => xterm.writeln(`  \x1b[32m${s.name}\x1b[0m - ${s.description || 'Без описания'}`));
          xterm.writeln('\x1b[90mВызов: кнопка Skills или skill_invoke\x1b[0m\r\n');
        } else {
          xterm.writeln('\r\n\x1b[33mНет доступных skills.\x1b[0m');
          xterm.writeln('\x1b[90mСоздайте ~/.config/kosmos-panel/skills/<name>/SKILL.md\x1b[0m\r\n');
        }
      }
      if (msg.type === 'skill_error') { xterm.writeln(`\r\n\x1b[1;31m[Skill Error] ${msg.error}\x1b[0m`); }
    } catch {}
  };

  // Простая передача данных на сервер
  xterm.onData((d) => { 
    try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch {} 
  });

  // Логирование команд
  xterm.attachCustomKeyEventHandler((arg) => {
    if (arg.code === 'Enter' && arg.type === 'keydown') {
      const buffer = xterm.buffer.active;
      const line = buffer.getLine(buffer.cursorY).translateToString(true).trim();
      const promptEnd = Math.max(line.lastIndexOf('$'), line.lastIndexOf('#'), line.lastIndexOf('>'));
      if (promptEnd !== -1) {
        const cmd = line.substring(promptEnd + 1).trim();
        if (cmd && !cmd.startsWith('ai:') && !cmd.startsWith('ai :')) {
          ws.send(JSON.stringify({ type: 'command_log', command: cmd }));
        }
      }
    }
    return true;
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

// Skills helper function
function parseSkillParamsSimple(str) {
  const params = {};
  if (!str) return params;
  
  // Парсим --key value или --key "value with spaces"
  const regex = /--(\w+)\s+(?:"([^"]+)"|(\S+))/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    params[match[1]] = match[2] || match[3];
  }
  
  // Если нет --key формата, весь текст как message
  if (Object.keys(params).length === 0 && str) {
    params.message = str;
  }
  
  return params;
}

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
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'data' || msg.type === 'err') term.write(msg.data);
        if (msg.type === 'fatal') term.writeln(`\r\n[FATAL] ${msg.error}`);
        if (msg.type === 'skills_list') {
          if (msg.skills && msg.skills.length > 0) {
            term.writeln('\r\n\x1b[1;36m=== Доступные Skills ===\x1b[0m');
            msg.skills.forEach(s => term.writeln(`  \x1b[32m${s.name}\x1b[0m - ${s.description || 'Без описания'}`));
            term.writeln('\r\n');
          } else {
            term.writeln('\r\n\x1b[33mНет доступных skills.\x1b[0m\r\n');
          }
        }
        if (msg.type === 'skill_error') term.writeln(`\r\n\x1b[1;31m[Skill Error] ${msg.error}\x1b[0m`);
      } catch {}
    };
    
    // Простая передача данных
    term.onData((d) => { 
      try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch {} 
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
    lastServerData = data.servers || [];
    render(lastServerData);
  } catch (e) {
    tsEl.innerText = 'Ошибка загрузки';
  } finally {
    setTimeout(loop, 5000);
  }
}

loop();


