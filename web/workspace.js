// ========== Workspace Super-Terminal ==========
// Layout: [Left Top: Logs] [Left Bottom: Skills] | [Right: Terminal]

const params = new URLSearchParams(location.search);
const serverId = params.get('serverId');
const LAYOUT_KEY = 'kosmos_workspace_layout';

// ========== Layout persistence ==========
function loadLayout() {
    try {
        const data = localStorage.getItem(LAYOUT_KEY);
        return data ? JSON.parse(data) : { leftWidth: 30, topHeight: 50 };
    } catch { return { leftWidth: 30, topHeight: 50 }; }
}

function saveLayout(layout) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { }
}

const layout = loadLayout();

// ========== Apply initial layout ==========
const wsLeft = document.getElementById('wsLeft');
const wsLeftTop = document.getElementById('wsLeftTop');
wsLeft.style.width = layout.leftWidth + '%';
wsLeftTop.style.height = layout.topHeight + '%';

// ========== Terminal Setup ==========
const termDiv = document.getElementById('wsTerm');
const initialTheme = window.themeManager ? window.themeManager.getTerminalTheme() : { background: '#000000', foreground: '#00ff00' };
const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    theme: initialTheme
});

// Update terminal theme on change
window.addEventListener('theme-changed', () => {
    if (term && window.themeManager) {
        term.options.theme = window.themeManager.getTerminalTheme();
    }
});
const fitAddon = new window.FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(termDiv);
setTimeout(() => { try { fitAddon.fit(); } catch { } }, 0);

// ========== Resize handling ==========
function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
}

let resizeTimeout;
function handleResize() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        try { fitAddon.fit(); sendResize(); } catch { }
    }, 100);
}

window.addEventListener('resize', handleResize);
if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(handleResize).observe(termDiv);
}

// ========== WebSocket Connection ==========
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${wsProto}://${location.host}/ws/terminal?serverId=${encodeURIComponent(serverId)}&cols=120&rows=30`;
const ws = new WebSocket(wsUrl);

term.writeln('[подключение к SSH...]');

// ========== REST Bridge Variables ==========
let currentSessionId = null;
let pendingRemoteCommand = null;
let remoteCommandBuffer = '';
let remoteCommandCollecting = false;
const promptRegex = /\w+@[\w\-\.]+[^$#>]*[\$#>]\s*$/;

// ========== AI Config ==========
let aiCommandPrefix = 'ai:';
fetch('/api/config')
    .then(res => res.json())
    .then(config => { if (config.aiCommandPrefix) aiCommandPrefix = config.aiCommandPrefix; })
    .catch(() => { });

// ========== Server name ==========
fetch('/api/servers')
    .then(r => r.json())
    .then(data => {
        const srv = (data.servers || []).find(s => s.id === serverId);
        if (srv) document.getElementById('wsServerName').textContent = srv.name;
    })
    .catch(() => { });

// ========== WebSocket handlers ==========
ws.onopen = () => {
    term.writeln('[соединение установлено]');
    setTimeout(() => { try { fitAddon.fit(); } catch { } sendResize(); }, 100);
};

ws.onclose = ev => {
    term.writeln(`\r\n[соединение закрыто код ${ev.code}${ev.reason ? ' ' + ev.reason : ''}]`);
    document.getElementById('wsReconnect').style.display = 'inline-block';
};

ws.onerror = () => term.writeln(`\r\n[ошибка соединения]`);

ws.onmessage = ev => {
    try {
        const m = JSON.parse(ev.data);

        if (m.type === 'data' || m.type === 'err') {
            term.write(m.data);

            // Collect output for skill
            if (skillDialogState.state === 'waiting_cmd') {
                skillDialogState.outputBuffer.push(m.data);
                if (skillDialogState.outputBuffer.length > 100) {
                    skillDialogState.outputBuffer.shift();
                }
            }

            if (remoteCommandCollecting && pendingRemoteCommand) {
                remoteCommandBuffer += m.data;
                checkRemoteCommandCompletion();
            }
        }

        if (m.type === 'fatal') term.writeln(`\r\n[FATAL] ${m.error}`);

        if (m.type === 'session' && m.sessionId) {
            currentSessionId = m.sessionId;
            updateSessionIndicator();
        }

        if (m.type === 'remote_command') handleRemoteCommand(m);

        if (m.type === 'cancel_command' && m.commandId) {
            if (pendingRemoteCommand && pendingRemoteCommand.commandId === m.commandId) {
                hideCommandConfirm();
                pendingRemoteCommand = null;
                remoteCommandCollecting = false;
                remoteCommandBuffer = '';
            }
        }

        // Skills via WS (for list, create, content)
        if (m.type === 'skills_list') handleSkillsList(m.skills || [], m.error);
        if (m.type === 'skill_error') {
            term.writeln(`\r\n\x1b[1;31m[Skill Error] ${m.error}\x1b[0m`);
        }
        if (m.type === 'skill_create_result') handleSkillCreateResult(m.success, m.error);
        if (m.type === 'skill_content') handleSkillContent(m.content, m.error);

    } catch (e) {
        console.error('[ws.onmessage] Error:', e);
    }
};

// ========== Terminal Input ==========
term.onData(d => {
    try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch { }
});

term.attachCustomKeyEventHandler((arg) => {
    if (arg.code === 'Enter' && arg.type === 'keydown') {
        const buffer = term.buffer.active;
        for (let i = buffer.length - 1; i >= 0; i--) {
            const line = buffer.getLine(i).translateToString(true);
            const promptEndIndex = Math.max(line.lastIndexOf('$'), line.lastIndexOf('#'), line.lastIndexOf('>'));
            if (promptEndIndex !== -1) {
                const commandPart = line.substring(promptEndIndex + 1).trim();
                const cleanCommand = commandPart.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\b\u0007]/g, '').trim();

                // skill:skip
                if (cleanCommand === 'skill:skip') {
                    clearTerminalLine();
                    term.writeln('\r\n\x1b[1;33m[Skill] Команда пропущена\x1b[0m');
                    skillSkipCommand();
                    return false;
                }

                // skill:cancel
                if (cleanCommand === 'skill:cancel') {
                    clearTerminalLine();
                    term.writeln('\r\n\x1b[1;31m[Skill] Отменён\x1b[0m');
                    skillCancel();
                    return false;
                }

                // Skill: если скилл ждёт выполнения команды, любой непустой Enter
                // считает текущую команду результатом шага (даже если пользователь её изменил)
                if (skillDialogState.state === 'waiting_cmd') {
                    if (cleanCommand.length > 0) {
                        skillDialogState.commandMatched = true;
                        // даём чуть больше времени на сбор вывода
                        setTimeout(() => onSkillCommandExecuted(), 2000);
                    }
                }

                // AI command check
                const prefixText = aiCommandPrefix.slice(0, -1);
                const prefixSep = aiCommandPrefix.slice(-1);
                const commandRegex = new RegExp(`(${prefixText}\\s*${prefixSep})`);
                const match = commandPart.match(commandRegex);

                if (match) {
                    const aiPrompt = commandPart.substring(match.index + match[0].length).trim();
                    setTimeout(() => {
                        term.writeln(`\r\n\x1b[1;33m[AI] Запрос: ${aiPrompt}\x1b[0m`);
                    }, 50);
                    ws.send(JSON.stringify({ type: 'ai_query', prompt: line }));
                    return true;
                } else if (cleanCommand) {
                    ws.send(JSON.stringify({ type: 'command_log', command: cleanCommand }));
                }
                break;
            }
        }
    }
    return true;
});

// ========== UI Handlers ==========
document.getElementById('wsClose').onclick = () => { try { ws.close(); } catch { } window.close(); };
document.getElementById('wsFit').onclick = () => { try { fitAddon.fit(); sendResize(); } catch { } };
document.getElementById('wsReconnect').onclick = () => location.reload();

// ========== Session Indicator ==========
function updateSessionIndicator() {
    const el = document.getElementById('wsSessionId');
    if (el && currentSessionId) {
        el.textContent = `Session: ${currentSessionId.substring(0, 8)}...`;
        el.title = `Session ID: ${currentSessionId}\nКликните для копирования`;
        el.onclick = () => {
            navigator.clipboard.writeText(currentSessionId).then(() => {
                const orig = el.textContent;
                el.textContent = '✓ Скопировано!';
                setTimeout(() => { el.textContent = orig; }, 1500);
            });
        };
        term.writeln(`\x1b[90m[Session ID: ${currentSessionId}]\x1b[0m`);
        // Start loading logs
        loadLogs();
    }
}

// ========== Remote Command Handling ==========
function handleRemoteCommand(msg) {
    term.writeln(`\r\n\x1b[1;45;97m ⚡ REST API COMMAND ⚡ \x1b[0m`);
    term.writeln(`\x1b[1;35mCommand:\x1b[0m \x1b[1;33m${msg.command}\x1b[0m`);
    pendingRemoteCommand = { commandId: msg.commandId, command: msg.command, requireConfirmation: msg.requireConfirmation };
    if (msg.requireConfirmation) showCommandConfirm(msg.command);
    else executeRemoteCommand(msg.command);
}

function showCommandConfirm(command) {
    document.getElementById('wsCommandConfirmText').textContent = command;
    document.getElementById('wsCommandConfirm').classList.remove('hidden');
    term.writeln('\r\n\x1b[1;33m[REST API] Ожидается подтверждение...\x1b[0m');
}

function hideCommandConfirm() {
    document.getElementById('wsCommandConfirm').classList.add('hidden');
}

function executeRemoteCommand(command) {
    remoteCommandBuffer = '';
    remoteCommandCollecting = true;
    term.writeln(`\r\n\x1b[1;36m[REST API] Выполняется: ${command}\x1b[0m`);
    try { ws.send(JSON.stringify({ type: 'data', data: command + '\r' })); }
    catch (e) { sendCommandResult('error', '', 'Failed: ' + e.message, null); }
}

function checkRemoteCommandCompletion() {
    const cleanBuffer = remoteCommandBuffer.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    if (promptRegex.test(cleanBuffer)) {
        const lines = cleanBuffer.split('\n');
        let outputLines = [];
        for (let i = lines.length - 1; i >= 0; i--) {
            if (promptRegex.test(lines[i])) { outputLines = lines.slice(0, i); break; }
        }
        if (outputLines.length > 0) outputLines = outputLines.slice(1);
        sendCommandResult('completed', outputLines.join('\n').trim(), '', 0);
        remoteCommandCollecting = false;
        remoteCommandBuffer = '';
        pendingRemoteCommand = null;
    }
}

function sendCommandResult(status, stdout, stderr, exitCode) {
    if (!pendingRemoteCommand) return;
    try { ws.send(JSON.stringify({ type: 'command_result', commandId: pendingRemoteCommand.commandId, status, stdout, stderr, exitCode })); } catch { }
}

document.getElementById('wsConfirmYes').onclick = () => { if (pendingRemoteCommand) { hideCommandConfirm(); executeRemoteCommand(pendingRemoteCommand.command); } };
document.getElementById('wsConfirmNo').onclick = () => {
    if (pendingRemoteCommand) {
        term.writeln('\r\n\x1b[1;31m[REST API] Команда отклонена\x1b[0m');
        sendCommandResult('rejected', '', 'Rejected by user', null);
        hideCommandConfirm();
        pendingRemoteCommand = null;
    }
};
document.getElementById('wsConfirmSkip').onclick = () => { if (pendingRemoteCommand) { hideCommandConfirm(); executeRemoteCommand(pendingRemoteCommand.command); } };

// ========== Drag Handles ==========
(function setupDrag() {
    const dragV = document.getElementById('wsDragV');
    const dragH = document.getElementById('wsDragH');
    const wsLayout = document.querySelector('.ws-layout');

    // Vertical drag (left width)
    let vDragging = false;
    dragV.addEventListener('mousedown', e => {
        vDragging = true;
        dragV.classList.add('active');
        document.body.classList.add('ws-dragging');
        e.preventDefault();
    });

    // Horizontal drag (top height within left)
    let hDragging = false;
    dragH.addEventListener('mousedown', e => {
        hDragging = true;
        dragH.classList.add('active');
        document.body.classList.add('ws-dragging-h');
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (vDragging) {
            const rect = wsLayout.getBoundingClientRect();
            const pct = ((e.clientX - rect.left) / rect.width) * 100;
            const clamped = Math.max(15, Math.min(60, pct));
            wsLeft.style.width = clamped + '%';
            layout.leftWidth = clamped;
            handleResize();
        }
        if (hDragging) {
            const rect = wsLeft.getBoundingClientRect();
            const pct = ((e.clientY - rect.top) / rect.height) * 100;
            const clamped = Math.max(15, Math.min(85, pct));
            wsLeftTop.style.height = clamped + '%';
            layout.topHeight = clamped;
        }
    });

    document.addEventListener('mouseup', () => {
        if (vDragging || hDragging) {
            vDragging = false;
            hDragging = false;
            dragV.classList.remove('active');
            dragH.classList.remove('active');
            document.body.classList.remove('ws-dragging');
            document.body.classList.remove('ws-dragging-h');
            saveLayout(layout);
            handleResize();
        }
    });
})();

// ========== Logs Panel ==========
let logTab = 'terminal'; // 'terminal' | 'skills'
let allLogs = [];
let logFilter = 'all';
let logsInterval = null;

function stripAnsi(str) {
    return (str || '').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Log tabs
document.querySelectorAll('#logTabs .ws-tab').forEach(tab => {
    tab.onclick = () => {
        const t = tab.dataset.tab;
        if (t === logTab) return;
        document.querySelectorAll('#logTabs .ws-tab').forEach(x => x.classList.remove('active'));
        tab.classList.add('active');
        logTab = t;
        document.getElementById('terminalFilters').classList.toggle('hidden', t !== 'terminal');
        document.getElementById('skillsFilters').classList.toggle('hidden', t !== 'skills');
        logFilter = 'all';
        // Reset active filter buttons
        document.querySelectorAll('.ws-filter-btn').forEach(b => b.classList.remove('active'));
        const containerId = t === 'terminal' ? 'terminalFilters' : 'skillsFilters';
        document.querySelector(`#${containerId} .ws-filter-btn[data-type="all"]`).classList.add('active');
        allLogs = [];
        loadLogs();
    };
});

// Filter buttons
document.querySelectorAll('.ws-filter-btn').forEach(btn => {
    btn.onclick = () => {
        const container = btn.closest('.ws-filters');
        container.querySelectorAll('.ws-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        logFilter = btn.dataset.type;
        renderLogs();
    };
});

async function loadLogs() {
    if (!currentSessionId) return;
    try {
        const apiUrl = logTab === 'skills' ? '/api/skills-logs' : '/api/logs';
        const url = `${apiUrl}?sessionId=${encodeURIComponent(currentSessionId)}&t=${Date.now()}`;
        const resp = await fetch(url);
        const logs = await resp.json();
        if (logs.length !== allLogs.length) {
            allLogs = logs;
            renderLogs();
        }
    } catch (e) {
        console.error('Log load error:', e);
    }
}

function getFilteredLogs() {
    if (logFilter === 'all') return allLogs;
    return allLogs.filter(l => l.type === logFilter);
}

function renderLogs() {
    const el = document.getElementById('logsContent');
    const logs = getFilteredLogs();
    if (logs.length === 0) {
        el.innerHTML = '<div class="ws-empty">Нет логов</div>';
        return;
    }
    el.innerHTML = logs.map(log => logTab === 'skills' ? renderSkillLog(log) : renderTerminalLog(log)).join('');
    el.scrollTop = el.scrollHeight;
}

function renderTerminalLog(log) {
    let typeLabel, content, className;
    switch (log.type) {
        case 'ai_query': typeLabel = '🤖 AI'; content = log.user_ai_query || ''; className = 'log-ai-query'; break;
        case 'stdin': typeLabel = '⚡ Cmd'; content = log.executed_command || ''; className = 'log-stdin'; break;
        case 'stdout': typeLabel = '📤 Out'; content = stripAnsi(log.terminal_output || ''); className = 'log-stdout'; break;
        case 'stderr': typeLabel = '🔥 Err'; content = stripAnsi(log.terminal_output || ''); className = 'log-stderr'; break;
        default: return '';
    }
    content = escapeHtml(content);
    const ts = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('ru-RU') : '';
    return `<div class="ws-log-entry ${className}">
    <div class="ws-log-type">${typeLabel}<span class="ws-log-timestamp">${ts}</span></div>
    <pre class="ws-log-content">${content}</pre>
  </div>`;
}

function renderSkillLog(log) {
    let typeLabel, content, className;
    switch (log.type) {
        case 'skill_start': typeLabel = '✨ Start'; content = `${log.skill_name}\n${JSON.stringify(log.skill_params, null, 2)}`; className = 'log-skill-start'; break;
        case 'skill_command': typeLabel = '🐚 Cmd'; content = log.command || ''; className = 'log-skill-command'; break;
        case 'skill_command_output': typeLabel = '📤 Output'; content = log.command_output_cleaned || log.command_output || ''; className = 'log-skill-command-output'; break;
        case 'skill_message': typeLabel = 'ℹ️ Info'; content = log.message || ''; className = 'log-skill-message'; break;
        case 'skill_user_input': typeLabel = '💬 User'; content = log.user_input || ''; className = 'log-skill-user-input'; break;
        case 'skill_ask': typeLabel = '❓ Ask'; content = log.question || ''; className = 'log-skill-ask'; break;
        case 'skill_complete': typeLabel = '✅ Done'; content = log.final_message || 'Completed'; className = 'log-skill-complete'; break;
        default: return '';
    }
    content = escapeHtml(content);
    const ts = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('ru-RU') : '';
    return `<div class="ws-log-entry ${className}">
    <div class="ws-log-type">${typeLabel}<span class="ws-log-timestamp">${ts}</span></div>
    <pre class="ws-log-content">${content}</pre>
  </div>`;
}

// Auto-refresh logs
logsInterval = setInterval(loadLogs, 3000);

// ========== Skills Panel ==========
let availableSkills = [];
let selectedSkill = null;
let collapsedFolders = new Set();

// Request skills on load
setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'skills_list' }));
    } else {
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ type: 'skills_list' }));
        }, { once: true });
    }
}, 500);

window.toggleFolder = function (el) {
    const folderItem = el.closest('[data-folder-id]');
    const folderId = folderItem.dataset.folderId;
    const id = 'children-' + folderId.replace(/[^a-z0-9]/gi, '_');
    const childrenEl = document.getElementById(id);
    if (!childrenEl) return;
    const iconEl = folderItem.querySelector('.folder-icon');
    if (childrenEl.classList.contains('hidden')) {
        childrenEl.classList.remove('hidden');
        if (iconEl) iconEl.textContent = '📂';
        collapsedFolders.delete(folderId);
    } else {
        childrenEl.classList.add('hidden');
        if (iconEl) iconEl.textContent = '📁';
        collapsedFolders.add(folderId);
    }
};

function handleSkillsList(skills, error) {
    availableSkills = skills.map(s => ({
        ...s,
        id: s.id || `${s.source || 'remote'}:${s.path || s.name}`
    }));
    const panel = document.getElementById('skillsPanel');

    if (error) {
        panel.innerHTML = `<div class="ws-skills-empty">Ошибка: ${escapeHtml(error)}</div>`;
        return;
    }

    if (skills.length === 0) {
        panel.innerHTML = `<div class="ws-skills-empty">Нет доступных skills.<br><small style="color:#666">Проверьте /.kosmos-panel/skills/ или ~/.config/kosmos-panel/skills/</small></div>`;
        return;
    }

    // Build tree
    const rootMap = new Map();
    const ensureRoot = (source) => {
        if (rootMap.has(source)) return rootMap.get(source);
        const label = source === 'project' ? 'Project' : 'Remote';
        const node = { type: 'dir', name: label, children: [], root: true, source, path: '' };
        rootMap.set(source, node);
        return node;
    };

    for (const skill of availableSkills) {
        const root = ensureRoot(skill.source || 'remote');
        const rawPath = (skill.path || skill.name || '').replace(/^\/+|\/+$/g, '');
        const parts = rawPath ? rawPath.split('/') : [skill.name || 'skill'];
        let current = root;
        let currentPath = '';
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLeaf = i === parts.length - 1;
            currentPath = currentPath ? currentPath + '/' + part : part;
            if (isLeaf) {
                current.children.push({ type: 'skill', name: part, skill });
            } else {
                let next = current.children.find(c => c.type === 'dir' && c.name === part);
                if (!next) {
                    next = { type: 'dir', name: part, children: [], source: skill.source || 'remote', path: currentPath };
                    current.children.push(next);
                }
                current = next;
            }
        }
    }

    const renderNodes = (nodes, depth = 0) => {
        return nodes.map(node => {
            if (node.type === 'dir') {
                const cls = node.root ? 'ws-skill-dir ws-skill-root' : 'ws-skill-dir';
                const folderId = `${node.source}:${node.path || node.name}`;
                const isCollapsed = collapsedFolders.has(folderId);
                const childrenId = 'children-' + folderId.replace(/[^a-z0-9]/gi, '_');
                return `
          <div class="${cls}" style="margin-left:${depth * 8}px" data-folder-id="${folderId}">
            <div class="skill-dir-info" onclick="toggleFolder(this)" style="cursor:pointer;flex:1">
              <span class="folder-icon">${isCollapsed ? '📁' : '📂'}</span>
              <span>${escapeHtml(node.name)}</span>
            </div>
          </div>
          <div id="${childrenId}" class="${isCollapsed ? 'hidden' : ''}">
            ${renderNodes(node.children, depth + 1)}
          </div>`;
            }
            const skill = node.skill;
            return `
        <div class="ws-skill-item" data-skill="${skill.id}" style="margin-left:${depth * 8}px">
          <button class="ws-skill-edit-btn" data-skill-id="${skill.id}" data-source="${skill.source}" data-path="${skill.path || ''}" title="Редактировать">✎</button>
          <div class="ws-skill-name">${escapeHtml(node.name)}</div>
          <div class="ws-skill-desc">${escapeHtml(skill.description || 'Без описания')}</div>
        </div>`;
        }).join('');
    };

    const roots = Array.from(rootMap.values());
    panel.innerHTML = `<div class="ws-skills-list">${renderNodes(roots, 0)}</div>`;

    // Attach click handlers
    panel.querySelectorAll('.ws-skill-item').forEach(item => {
        item.onclick = () => selectSkill(item.dataset.skill);
    });
    panel.querySelectorAll('.ws-skill-edit-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            openEditSkillDialog(btn.dataset.skillId, btn.dataset.source, btn.dataset.path);
        };
    });
}

function selectSkill(skillId) {
    selectedSkill = availableSkills.find(s => s.id === skillId);
    if (!selectedSkill) return;

    const form = document.getElementById('wsSkillParamsForm');
    document.getElementById('wsSkillParamsName').textContent = selectedSkill.name || skillId;
    const input = document.getElementById('wsSkillParamsInput');
    input.value = '';

    let placeholder = 'Дополнительные инструкции (опционально)';
    if (selectedSkill.params && selectedSkill.params.length > 0) {
        const pTexts = selectedSkill.params.map(p => p.description ? `${p.name} (${p.description})` : p.name);
        placeholder = `Параметры: ${pTexts.join(', ')}`;
    }
    input.placeholder = placeholder;

    form.classList.remove('hidden');
    input.focus();
}

// Two buttons for launching skill
document.getElementById('wsSkillExecuteBtn').onclick = () => executeSelectedSkill(false); // panel mode
document.getElementById('wsSkillExecutePopupBtn').onclick = () => executeSelectedSkill(true); // popup mode

function executeSelectedSkill(usePopup = false) {
    if (!selectedSkill) return;
    skillDialogState.useModal = usePopup;
    startSkillDialog(selectedSkill);
}

function parseSkillParams(str) {
    const params = {};
    if (!str) return params;
    const regex = /--(\w+)\s+(?:"([^"]+)"|(\S+))/g;
    let match;
    while ((match = regex.exec(str)) !== null) {
        params[match[1]] = match[2] || match[3];
    }
    if (Object.keys(params).length === 0 && str) {
        params.message = str;
    }
    return params;
}

// Execute skill button
document.getElementById('wsSkillParamsInput').onkeydown = e => {
    if (e.key === 'Enter') executeSelectedSkill(false);
    else if (e.key === 'Escape') {
        document.getElementById('wsSkillParamsForm').classList.add('hidden');
        selectedSkill = null;
    }
};

// ========== Skill Dialog (Modal Window) ==========
const skillDialogState = {
    sessionId: null,
    terminalSessionId: null,
    skillName: '',
    pendingCommand: null,
    commandMatched: false,
    state: 'idle', // 'idle' | 'waiting_cmd' | 'waiting_user' | 'done'
    messages: [],
    startedAt: null,
    outputBuffer: [],
    useModal: false // false = panel, true = popup window
};

function showSkillDialogModal() {
    const modal = document.getElementById('wsSkillDialogModal');
    modal.classList.remove('hidden');
    document.getElementById('wsSkillDialogModalBody').innerHTML = '';
    // Position at right side
    modal.style.transform = 'translateY(-50%)';
    modal.style.top = '50%';
    modal.style.right = '20px';
    modal.style.left = 'auto';
}

function hideSkillDialogModal() {
    document.getElementById('wsSkillDialogModal').classList.add('hidden');
}

function showSkillDialogView() {
    const form = document.getElementById('wsSkillParamsForm');
    form.classList.add('hidden');

    if (skillDialogState.useModal) {
        // Popup window mode
        showSkillDialogModal();
    } else {
        // Embedded panel mode
        showSkillDialogPanel();
    }
}

function showSkillDialogPanel() {
    const panel = document.getElementById('skillsPanel');
    panel.innerHTML = `
    <div class="ws-skill-dialog">
      <div class="ws-skill-dialog-header">
        <div class="ws-skill-dialog-title">Skill: <span id="wsSkillDialogName">-</span></div>
        <button class="ws-skill-dialog-popup-btn" id="wsSkillDialogPopupBtn" title="Открыть в окне">↗</button>
        <button class="ws-skill-dialog-close" id="wsSkillDialogClose" title="Закрыть">×</button>
      </div>
      <div class="ws-skill-dialog-body" id="wsSkillDialogBody"></div>
      <div class="ws-skill-dialog-footer">
        <div class="ws-skill-quick-actions" id="wsSkillQuickActions">
          <button onclick="sendSkillQuickReply('Да')">Да</button>
          <button onclick="sendSkillQuickReply('Нет')">Нет</button>
          <button onclick="skillSkipCommand()">Skip</button>
          <button onclick="skillCancel()">Cancel</button>
        </div>
        <div class="ws-skill-dialog-input-row" id="wsSkillInputRow">
          <input type="text" id="wsSkillDialogInput" placeholder="Введите ответ...">
          <button onclick="sendSkillMessage()">▶</button>
        </div>
      </div>
    </div>`;

    // Event handlers for panel
    document.getElementById('wsSkillDialogClose').onclick = closeSkillDialog;
    document.getElementById('wsSkillDialogPopupBtn').onclick = switchToPopupMode;
    document.getElementById('wsSkillDialogInput').onkeydown = e => {
        if (e.key === 'Enter') sendSkillMessage();
        else if (e.key === 'Escape') closeSkillDialog();
    };
}

function switchToPopupMode() {
    skillDialogState.useModal = true;
    showSkillDialogModal();
    document.getElementById('wsSkillDialogModalName').textContent = skillDialogState.skillName;
    // Restore messages to modal
    const body = document.getElementById('wsSkillDialogModalBody');
    body.innerHTML = '';
    skillDialogState.messages.forEach(msg => {
        addSkillMessageToElement(body, msg.type, msg.content);
    });
    body.scrollTop = body.scrollHeight;
    updateSkillDialogFooter(skillDialogState.state);
    // Clear panel
    backToSkillsListSilent();
}

function backToSkillsListSilent() {
    ws.send(JSON.stringify({ type: 'skills_list' }));
}

// Modal event handlers
document.getElementById('wsSkillDialogModalClose').onclick = closeSkillDialog;
// Note: overlay click does NOT close the dialog to prevent accidental closure
document.getElementById('wsSkillDialogMinimize').onclick = () => {
    // Hide modal but keep skill running (can re-open from panel)
    hideSkillDialogModal();
    // Show indicator in the panel
    const panel = document.getElementById('skillsPanel');
    panel.innerHTML = `
    <div class="ws-skill-minimized">
      <div class="ws-skill-minimized-info">
        <span class="ws-skill-minimized-icon">✨</span>
        <span>Skill: <strong>${escapeHtml(skillDialogState.skillName)}</strong></span>
        <span class="ws-skill-minimized-status">Выполняется...</span>
      </div>
      <button class="ws-skill-maximized-btn" onclick="restoreSkillModal()">□ Развернуть</button>
    </div>`;
};

window.restoreSkillModal = function () {
    showSkillDialogModal();
    // Restore messages to modal body
    const body = document.getElementById('wsSkillDialogModalBody');
    body.innerHTML = '';
    skillDialogState.messages.forEach(msg => {
        addSkillMessageToElement(body, msg.type, msg.content);
    });
    body.scrollTop = body.scrollHeight;
};

// Handle Enter key in modal textarea
document.getElementById('wsSkillDialogModalInput').onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendSkillMessageModal();
    } else if (e.key === 'Escape') {
        closeSkillDialog();
    }
};

// ========== Modal Drag functionality ==========
(function setupModalDrag() {
    const modal = document.getElementById('wsSkillDialogModal');
    const header = document.getElementById('wsSkillDialogModalHeader');
    let isDragging = false;
    let offsetX = 0, offsetY = 0;

    header.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        const rect = modal.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        modal.style.transform = 'none';
        modal.style.left = rect.left + 'px';
        modal.style.top = rect.top + 'px';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
        if (!isDragging) return;
        let newX = e.clientX - offsetX;
        let newY = e.clientY - offsetY;
        // Keep within viewport
        newX = Math.max(0, Math.min(window.innerWidth - 100, newX));
        newY = Math.max(0, Math.min(window.innerHeight - 50, newY));
        modal.style.left = newX + 'px';
        modal.style.top = newY + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            document.body.style.userSelect = '';
        }
    });
})();

function addSkillMessageToElement(container, type, content) {
    const msg = document.createElement('div');
    msg.className = `ws-skill-msg ws-skill-msg-${type}`;

    if (type === 'cmd') {
        msg.innerHTML = `Предложена команда:<code>${escapeHtml(content)}</code>`;
    } else if (type === 'output') {
        msg.textContent = content;
    } else {
        msg.innerHTML = escapeHtml(content).replace(/\n/g, '<br>');
    }

    container.appendChild(msg);
    return msg;
}

function resetSkillDialogState() {
    skillDialogState.sessionId = null;
    skillDialogState.pendingCommand = null;
    skillDialogState.commandMatched = false;
    skillDialogState.state = 'idle';
    skillDialogState.messages = [];
    skillDialogState.outputBuffer = [];
}

function addSkillMessage(type, content) {
    // Add to the appropriate container based on mode
    const modalBody = document.getElementById('wsSkillDialogModalBody');
    const panelBody = document.getElementById('wsSkillDialogBody');
    const body = skillDialogState.useModal ? modalBody : panelBody;
    
    if (body) {
        addSkillMessageToElement(body, type, content);
        body.scrollTop = body.scrollHeight;
    }
    skillDialogState.messages.push({ type, content, timestamp: new Date().toISOString() });
}

async function startSkillDialog(skill) {
    if (!currentSessionId) {
        term.writeln('\r\n\x1b[1;31m[Ошибка] Session ID ещё не получен\x1b[0m');
        return;
    }

    resetSkillDialogState();
    skillDialogState.terminalSessionId = currentSessionId;
    skillDialogState.skillName = skill.name;
    skillDialogState.startedAt = new Date().toISOString();
    // useModal is already set by executeSelectedSkill

    showSkillDialogView();
    
    // Set skill name in the appropriate element
    if (skillDialogState.useModal) {
        document.getElementById('wsSkillDialogModalName').textContent = skill.name;
    } else {
        const nameEl = document.getElementById('wsSkillDialogName');
        if (nameEl) nameEl.textContent = skill.name;
    }
    
    addSkillMessage('system', 'Запуск skill...');

    const userInput = document.getElementById('wsSkillParamsInput')?.value?.trim() || '';
    const params = parseSkillParams(userInput);

    try {
        const resp = await fetch('/api/skills/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                terminalSessionId: currentSessionId,
                skillId: skill.id,
                skillPath: skill.path,
                skillSource: skill.source,
                params,
                prompt: userInput
            })
        });

        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to start skill');

        skillDialogState.sessionId = data.data.skillSessionId;
        handleSkillAIResponse(data.data.aiResponse);
    } catch (e) {
        addSkillMessage('error', `Ошибка: ${e.message}`);
        skillDialogState.state = 'done';
    }
}

function handleSkillAIResponse(aiResponse) {
    if (!aiResponse) return;
    const { type, content, command } = aiResponse;

    if (type === 'CMD') {
        skillDialogState.state = 'waiting_cmd';
        skillDialogState.pendingCommand = command;
        addSkillMessage('cmd', command);
        addSkillMessage('system', 'Нажмите Enter для выполнения или отредактируйте команду');
        insertCommandToTerminal(command);
        updateSkillDialogFooter('waiting_cmd');
    } else if (type === 'ASK') {
        skillDialogState.state = 'waiting_user';
        skillDialogState.pendingCommand = null;
        const isOptional = aiResponse.required === false;
        const questionText = aiResponse.question || content;
        addSkillMessage('ask', questionText + (isOptional ? ' (опционально)' : ''));
        updateSkillDialogFooter('waiting_user');
        const inputId = skillDialogState.useModal ? 'wsSkillDialogModalInput' : 'wsSkillDialogInput';
        const input = document.getElementById(inputId);
        if (input) { input.placeholder = isOptional ? 'Введите ответ или Enter для пропуска...' : 'Введите ответ...'; input.focus(); }
    } else if (type === 'MESSAGE') {
        skillDialogState.state = 'idle';
        skillDialogState.pendingCommand = null;
        addSkillMessage('ai', content);
        updateSkillDialogFooter('idle');
        setTimeout(() => continueSkillAfterMessage(), 500);
    } else if (type === 'DONE') {
        skillDialogState.state = 'done';
        skillDialogState.pendingCommand = null;
        addSkillMessage('done', content);
        updateSkillDialogFooter('done');
        saveSkillToHistory('completed');
    }
}

function updateSkillDialogFooter(state) {
    // Update modal footer
    const qaModal = document.getElementById('wsSkillDialogModalQuickActions');
    const irModal = document.getElementById('wsSkillDialogModalInputRow');
    // Update panel footer
    const qaPanel = document.getElementById('wsSkillQuickActions');
    const irPanel = document.getElementById('wsSkillInputRow');
    
    const qa = skillDialogState.useModal ? qaModal : qaPanel;
    const ir = skillDialogState.useModal ? irModal : irPanel;
    if (!qa || !ir) return;

    if (state === 'waiting_cmd') {
        qa.style.display = 'flex';
        ir.style.display = 'none';
    } else if (state === 'waiting_user') {
        qa.style.display = 'flex';
        ir.style.display = 'flex';
        const inputId = skillDialogState.useModal ? 'wsSkillDialogModalInput' : 'wsSkillDialogInput';
        const input = document.getElementById(inputId);
        if (input) input.focus();
    } else if (state === 'idle') {
        qa.style.display = 'none';
        ir.style.display = 'none';
    } else if (state === 'done') {
        qa.style.display = 'none';
        ir.style.display = 'none';
    }
}

function insertCommandToTerminal(command) {
    term.paste(command);
    term.focus();
}

async function sendSkillMessage() {
    const inputId = skillDialogState.useModal ? 'wsSkillDialogModalInput' : 'wsSkillDialogInput';
    const input = document.getElementById(inputId);
    const text = input?.value?.trim();
    if (!text || skillDialogState.state !== 'waiting_user') return;

    addSkillMessage('user', text);
    input.value = '';

    try {
        const resp = await fetch(`/api/skills/${skillDialogState.sessionId}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userMessage: text })
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to send message');
        handleSkillAIResponse(data.data.aiResponse);
    } catch (e) { addSkillMessage('error', `Ошибка: ${e.message}`); }
}

async function sendSkillMessageModal() {
    await sendSkillMessage();
}

window.sendSkillQuickReplyModal = function (text) {
    const input = document.getElementById('wsSkillDialogModalInput');
    if (input) input.value = text;
    sendSkillMessage();
};

window.sendSkillQuickReply = function (text) {
    const input = document.getElementById('wsSkillDialogInput');
    if (input) input.value = text;
    sendSkillMessage();
};

async function continueSkillAfterMessage() {
    if (!skillDialogState.sessionId || skillDialogState.state !== 'idle') return;
    try {
        const resp = await fetch(`/api/skills/${skillDialogState.sessionId}/continue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to continue skill');
        handleSkillAIResponse(data.data.aiResponse);
    } catch (e) { addSkillMessage('error', `Ошибка: ${e.message}`); }
}

window.skillSkipCommand = async function () {
    if (!skillDialogState.sessionId || skillDialogState.state !== 'waiting_cmd') return;
    addSkillMessage('system', 'Команда пропущена');
    skillDialogState.pendingCommand = null;
    const db = document.getElementById('wsSkillCommandDoneBtn');
    if (db) db.classList.add('hidden');

    try {
        const resp = await fetch(`/api/skills/${skillDialogState.sessionId}/command-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skipped: true })
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to skip command');
        handleSkillAIResponse(data.data.aiResponse);
    } catch (e) { addSkillMessage('error', `Ошибка: ${e.message}`); }
};

window.skillCancel = async function () {
    if (!skillDialogState.sessionId) {
        backToSkillsList();
        return;
    }
    try { await fetch(`/api/skills/${skillDialogState.sessionId}`, { method: 'DELETE' }); } catch { }
    addSkillMessage('system', 'Skill отменён');
    skillDialogState.state = 'done';
    saveSkillToHistory('cancelled');
    updateSkillDialogFooter('done');
};

window.skillCommandDone = async function () {
    if (!skillDialogState.sessionId || skillDialogState.state !== 'waiting_cmd') return;
    addSkillMessage('system', 'Команда выполнена (изменённая)');
    skillDialogState.pendingCommand = null;
    const db = document.getElementById('wsSkillCommandDoneBtn');
    if (db) db.classList.add('hidden');

    const collectedOutput = skillDialogState.outputBuffer.join('');
    const cleanOutput = stripAnsi(collectedOutput).trim();
    skillDialogState.outputBuffer = [];

    if (cleanOutput) addSkillMessage('output', cleanOutput);

    try {
        const outputResp = await fetch(`/api/skills/${skillDialogState.sessionId}/output`);
        const outputData = await outputResp.json();
        if (outputData.success && outputData.data.lastOutput && !cleanOutput) {
            addSkillMessage('output', outputData.data.lastOutput);
        }

        const resp = await fetch(`/api/skills/${skillDialogState.sessionId}/command-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skipped: false, stdout: cleanOutput || outputData.data.lastOutput || '' })
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to report command result');
        handleSkillAIResponse(data.data.aiResponse);
    } catch (e) { addSkillMessage('error', `Ошибка: ${e.message}`); }
};

async function onSkillCommandExecuted() {
    if (!skillDialogState.sessionId || skillDialogState.state !== 'waiting_cmd') return;
    if (!skillDialogState.commandMatched) return;

    skillDialogState.commandMatched = false;
    addSkillMessage('system', 'Команда выполнена');
    skillDialogState.pendingCommand = null;

    await new Promise(r => setTimeout(r, 500));

    const collectedOutput = skillDialogState.outputBuffer.join('');
    const cleanOutput = stripAnsi(collectedOutput).trim();
    skillDialogState.outputBuffer = [];

    if (cleanOutput) addSkillMessage('output', cleanOutput);

    try {
        const outputResp = await fetch(`/api/skills/${skillDialogState.sessionId}/output`);
        const outputData = await outputResp.json();
        if (outputData.success && outputData.data.lastOutput && !cleanOutput) {
            addSkillMessage('output', outputData.data.lastOutput);
        }

        const resp = await fetch(`/api/skills/${skillDialogState.sessionId}/command-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skipped: false, stdout: cleanOutput || outputData.data.lastOutput || '' })
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed to report command result');
        handleSkillAIResponse(data.data.aiResponse);
    } catch (e) { addSkillMessage('error', `Ошибка: ${e.message}`); }
}

function closeSkillDialog() {
    if (skillDialogState.sessionId && skillDialogState.state !== 'done') {
        skillCancel();
    }
    if (skillDialogState.useModal) {
        hideSkillDialogModal();
    }
    backToSkillsList();
}

function backToSkillsList() {
    resetSkillDialogState();
    selectedSkill = null;
    // Re-render skills list
    ws.send(JSON.stringify({ type: 'skills_list' }));
}

function normalizeCommand(cmd) {
    return (cmd || '').trim().replace(/\s+/g, ' ');
}

function clearTerminalLine() {
    ws.send(JSON.stringify({ type: 'data', data: '\x15' })); // Ctrl+U
}

// ========== Skill History ==========
const SKILL_HISTORY_KEY = 'kosmos_skill_history';

function loadSkillHistory() {
    try { return JSON.parse(localStorage.getItem(SKILL_HISTORY_KEY)) || { sessions: [] }; }
    catch { return { sessions: [] }; }
}

function saveSkillToHistory(status) {
    try {
        const history = loadSkillHistory();
        const truncated = skillDialogState.messages.map(m => ({
            ...m, content: m.content && m.content.length > 500 ? m.content.substring(0, 500) + '...' : m.content
        }));
        const session = {
            id: skillDialogState.sessionId,
            skillName: skillDialogState.skillName,
            terminalSessionId: skillDialogState.terminalSessionId,
            startedAt: skillDialogState.startedAt,
            status,
            messages: truncated
        };
        history.sessions = history.sessions.filter(s => s.id !== session.id);
        history.sessions.unshift(session);
        if (history.sessions.length > 20) history.sessions = history.sessions.slice(0, 20);
        localStorage.setItem(SKILL_HISTORY_KEY, JSON.stringify(history));
    } catch { }
}

// ========== Skill Create/Edit Dialog ==========
let createSkillSource = 'remote';
let createSkillPath = '';
let editMode = false;
let editSkillOriginalName = '';

function openEditSkillDialog(skillId, source, skillPath) {
    editMode = true;
    createSkillSource = source || 'remote';
    createSkillPath = skillPath || '';
    const pathParts = (skillPath || '').split('/').filter(Boolean);
    const skillName = pathParts.pop() || '';
    editSkillOriginalName = skillName;
    createSkillPath = pathParts.join('/');

    const basePath = source === 'project' ? '/.kosmos-panel/skills' : '~/.config/kosmos-panel/skills';
    const fullPath = skillPath ? `${basePath}/${skillPath}` : `${basePath}/${skillName}`;

    document.getElementById('wsSkillCreatePath').textContent = `Путь: ${fullPath}/SKILL.md`;
    document.getElementById('wsSkillCreateName').value = skillName;
    document.getElementById('wsSkillCreateName').disabled = true;
    document.getElementById('wsSkillCreateContent').value = 'Загрузка...';
    document.getElementById('wsSkillCreateError').classList.add('hidden');
    document.getElementById('wsSkillCreateTitle').textContent = 'Редактировать Skill';
    document.getElementById('wsSkillCreateSave').textContent = 'Сохранить';

    document.getElementById('wsSkillCreateOverlay').classList.remove('hidden');
    document.getElementById('wsSkillCreateDialog').classList.remove('hidden');

    ws.send(JSON.stringify({ type: 'skill_get_content', source: source, path: skillPath }));
}

function handleSkillContent(content, error) {
    if (error) {
        document.getElementById('wsSkillCreateContent').value = '';
        document.getElementById('wsSkillCreateError').textContent = error;
        document.getElementById('wsSkillCreateError').classList.remove('hidden');
    } else {
        document.getElementById('wsSkillCreateContent').value = content || '';
        document.getElementById('wsSkillCreateError').classList.add('hidden');
        document.getElementById('wsSkillCreateContent').focus();
    }
}

function closeCreateSkillDialog() {
    document.getElementById('wsSkillCreateOverlay').classList.add('hidden');
    document.getElementById('wsSkillCreateDialog').classList.add('hidden');
    document.getElementById('wsSkillCreateName').disabled = false;
    editMode = false;
    editSkillOriginalName = '';
}

function validateSkillName(name) {
    if (!name) return 'Имя не может быть пустым';
    if (!/^[a-z0-9_-]+$/i.test(name)) return 'Имя может содержать только латинские буквы, цифры, дефис и подчёркивание';
    if (name.length > 50) return 'Имя слишком длинное (макс. 50 символов)';
    if (editMode) return null;
    const fullPath = createSkillPath ? `${createSkillPath}/${name}` : name;
    const existingSkill = availableSkills.find(s =>
        s.source === createSkillSource && (s.path === fullPath || s.path === name)
    );
    if (existingSkill) return `Skill с именем "${name}" уже существует в этой папке`;
    return null;
}

function saveNewSkill() {
    const nameInput = document.getElementById('wsSkillCreateName');
    const contentInput = document.getElementById('wsSkillCreateContent');
    const errorEl = document.getElementById('wsSkillCreateError');

    const name = nameInput.value.trim();
    const content = contentInput.value;

    const nameError = validateSkillName(name);
    if (nameError) {
        errorEl.textContent = nameError;
        errorEl.classList.remove('hidden');
        nameInput.focus();
        return;
    }
    if (!content.trim()) {
        errorEl.textContent = 'Содержимое skill не может быть пустым';
        errorEl.classList.remove('hidden');
        contentInput.focus();
        return;
    }

    errorEl.classList.add('hidden');

    const msg = {
        type: 'skill_create',
        source: createSkillSource,
        path: createSkillPath,
        name: name,
        content: content
    };
    ws.send(JSON.stringify(msg));

    document.getElementById('wsSkillCreateSave').disabled = true;
    document.getElementById('wsSkillCreateSave').textContent = 'Сохранение...';
}

function handleSkillCreateResult(success, error) {
    const saveBtn = document.getElementById('wsSkillCreateSave');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Сохранить';

    if (success) {
        closeCreateSkillDialog();
        ws.send(JSON.stringify({ type: 'skills_list' }));
        term.writeln(`\r\n\x1b[1;32m[Skills] Skill успешно сохранён\x1b[0m`);
    } else {
        const errorEl = document.getElementById('wsSkillCreateError');
        errorEl.textContent = error || 'Ошибка при сохранении skill';
        errorEl.classList.remove('hidden');
    }
}

// Skill create/edit dialog event handlers
document.getElementById('wsSkillCreateClose').onclick = closeCreateSkillDialog;
document.getElementById('wsSkillCreateCancel').onclick = closeCreateSkillDialog;
document.getElementById('wsSkillCreateOverlay').onclick = closeCreateSkillDialog;
document.getElementById('wsSkillCreateSave').onclick = saveNewSkill;
document.getElementById('wsSkillCreateName').onkeydown = (e) => {
    if (e.key === 'Escape') closeCreateSkillDialog();
};
document.getElementById('wsSkillCreateContent').onkeydown = (e) => {
    if (e.key === 'Escape') closeCreateSkillDialog();
};

// ========== Cleanup ==========
window.addEventListener('beforeunload', () => {
    clearInterval(logsInterval);
    try { ws.close(); } catch { }
});
