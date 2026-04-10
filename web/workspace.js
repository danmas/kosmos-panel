// ========== Workspace Super-Terminal ==========
// Layout: [Left Top: Logs] [Left Bottom: Skills] | [Right: Terminal Panes]

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

// ========== Pane Management ==========
let paneIdCounter = 0;
let activePane = null;
const panes = new Map();
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const promptRegex = /\w+@[\w\-\.]+[^$#>]*[\$#>]\s*$/;

function getTerminalTheme() {
    return window.themeManager ? window.themeManager.getTerminalTheme() : { background: '#000000', foreground: '#00ff00' };
}

// Update all terminal themes on change
window.addEventListener('theme-changed', () => {
    if (!window.themeManager) return;
    const theme = window.themeManager.getTerminalTheme();
    panes.forEach(p => { p.term.options.theme = theme; });
});

/**
 * Create a new terminal pane inside parentContainer.
 * Each pane gets its own xterm, FitAddon, WebSocket, sessionId.
 */
function createPane(parentContainer) {
    const id = 'pane-' + (++paneIdCounter);

    // DOM structure
    const container = document.createElement('div');
    container.className = 'ws-pane';
    container.dataset.paneId = id;

    const toolbar = document.createElement('div');
    toolbar.className = 'ws-pane-toolbar';

    const btnSplitV = document.createElement('button');
    btnSplitV.title = 'Split Vertical';
    btnSplitV.textContent = '\u2502';
    btnSplitV.onclick = (e) => { e.stopPropagation(); splitPane(id, 'vertical'); };

    const btnSplitH = document.createElement('button');
    btnSplitH.title = 'Split Horizontal';
    btnSplitH.textContent = '\u2500';
    btnSplitH.onclick = (e) => { e.stopPropagation(); splitPane(id, 'horizontal'); };

    const label = document.createElement('span');
    label.className = 'ws-pane-label';
    label.textContent = 'connecting...';

    const btnClose = document.createElement('button');
    btnClose.className = 'ws-pane-close';
    btnClose.title = 'Close Pane';
    btnClose.textContent = '\u00d7';
    btnClose.onclick = (e) => { e.stopPropagation(); closePane(id); };

    toolbar.appendChild(btnSplitV);
    toolbar.appendChild(btnSplitH);
    toolbar.appendChild(label);
    toolbar.appendChild(btnClose);

    const termDiv = document.createElement('div');
    termDiv.className = 'ws-pane-term';

    container.appendChild(toolbar);
    container.appendChild(termDiv);
    parentContainer.appendChild(container);

    // xterm + fit
    const term = new Terminal({ convertEol: true, cursorBlink: true, theme: getTerminalTheme() });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termDiv);
    setTimeout(() => { try { fit.fit(); } catch { } }, 0);

    // Pane state object
    const pane = {
        id,
        term,
        fit,
        ws: null,
        sessionId: null,
        container,
        termDiv,
        label,
        // Per-pane REST bridge state
        pendingRemoteCommand: null,
        remoteCommandBuffer: '',
        remoteCommandCollecting: false
    };

    // Activate on click
    container.addEventListener('mousedown', () => setActivePane(id));

    // WebSocket connection
    const wsUrl = `${wsProto}://${location.host}/ws/terminal?serverId=${encodeURIComponent(serverId)}&cols=120&rows=30`;
    const ws = new WebSocket(wsUrl);
    pane.ws = ws;

    term.writeln('[\u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435 \u043a SSH...]');

    ws.onopen = () => {
        term.writeln('[\u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0435 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u043e]');
        setTimeout(() => { try { fit.fit(); sendResizeForPane(pane); } catch { } }, 100);
    };

    ws.onclose = ev => {
        term.writeln(`\r\n[\u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0435 \u0437\u0430\u043a\u0440\u044b\u0442\u043e \u043a\u043e\u0434 ${ev.code}${ev.reason ? ' ' + ev.reason : ''}]`);
        label.textContent = 'disconnected';
        document.getElementById('wsReconnect').style.display = 'inline-block';
    };

    ws.onerror = () => term.writeln(`\r\n[\u043e\u0448\u0438\u0431\u043a\u0430 \u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u044f]`);

    ws.onmessage = ev => {
        try {
            const m = JSON.parse(ev.data);
            handlePaneWsMessage(pane, m);
        } catch (e) {
            console.error('[ws.onmessage] Error:', e);
        }
    };

    // Terminal input
    term.onData(d => {
        try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch { }
    });

    attachKeyHandler(pane);

    // ResizeObserver
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => {
            try { fit.fit(); sendResizeForPane(pane); } catch { }
        }).observe(termDiv);
    }

    panes.set(id, pane);
    return pane;
}

/** Handle WebSocket messages for a specific pane */
function handlePaneWsMessage(pane, m) {
    if (m.type === 'data' || m.type === 'err') {
        pane.term.write(m.data);

        // Collect output for skill (only for the pane that started the skill)
        if (skillDialogState.state === 'waiting_cmd' && skillDialogState.paneId === pane.id) {
            skillDialogState.outputBuffer.push(m.data);
            if (skillDialogState.outputBuffer.length > 100) {
                skillDialogState.outputBuffer.shift();
            }
        }

        if (pane.remoteCommandCollecting && pane.pendingRemoteCommand) {
            pane.remoteCommandBuffer += m.data;
            checkRemoteCommandCompletionForPane(pane);
        }
    }

    if (m.type === 'fatal') pane.term.writeln(`\r\n[FATAL] ${m.error}`);

    if (m.type === 'session' && m.sessionId) {
        pane.sessionId = m.sessionId;
        pane.label.textContent = `Session: ${m.sessionId.substring(0, 8)}`;
        // Update topbar indicator if this is active pane
        if (activePane && activePane.id === pane.id) {
            updateSessionIndicator();
        }
        // Load logs from the first pane that connects
        if (!logsSessionId) {
            logsSessionId = m.sessionId;
            loadLogs();
        }
    }

    if (m.type === 'remote_command') handleRemoteCommand(pane, m);

    if (m.type === 'cancel_command' && m.commandId) {
        if (pane.pendingRemoteCommand && pane.pendingRemoteCommand.commandId === m.commandId) {
            hideCommandConfirm();
            pane.pendingRemoteCommand = null;
            pane.remoteCommandCollecting = false;
            pane.remoteCommandBuffer = '';
        }
    }

    // Skills via WS (for list, create, content) — handled globally via any pane
    if (m.type === 'skills_list') handleSkillsList(m.skills || [], m.error);
    if (m.type === 'skill_error') {
        pane.term.writeln(`\r\n\x1b[1;31m[Skill Error] ${m.error}\x1b[0m`);
    }
    if (m.type === 'skill_create_result') handleSkillCreateResult(m.success, m.error);
    if (m.type === 'skill_content') handleSkillContent(m.content, m.error);
}

/** Attach keyboard handler to a pane's terminal */
function attachKeyHandler(pane) {
    pane.term.attachCustomKeyEventHandler((arg) => {
        if (arg.code === 'Enter' && arg.type === 'keydown') {
            const buffer = pane.term.buffer.active;
            for (let i = buffer.length - 1; i >= 0; i--) {
                const line = buffer.getLine(i).translateToString(true);
                const promptEndIndex = Math.max(line.lastIndexOf('$'), line.lastIndexOf('#'), line.lastIndexOf('>'));
                if (promptEndIndex !== -1) {
                    const commandPart = line.substring(promptEndIndex + 1).trim();
                    const cleanCommand = commandPart.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\b\u0007]/g, '').trim();

                    // skill:skip
                    if (cleanCommand === 'skill:skip') {
                        clearTerminalLine();
                        pane.term.writeln('\r\n\x1b[1;33m[Skill] \u041a\u043e\u043c\u0430\u043d\u0434\u0430 \u043f\u0440\u043e\u043f\u0443\u0449\u0435\u043d\u0430\x1b[0m');
                        skillSkipCommand();
                        return false;
                    }

                    // skill:cancel
                    if (cleanCommand === 'skill:cancel') {
                        clearTerminalLine();
                        pane.term.writeln('\r\n\x1b[1;31m[Skill] \u041e\u0442\u043c\u0435\u043d\u0451\u043d\x1b[0m');
                        skillCancel();
                        return false;
                    }

                    // Skill: command execution tracking
                    if (skillDialogState.state === 'waiting_cmd' && skillDialogState.paneId === pane.id) {
                        if (cleanCommand.length > 0) {
                            skillDialogState.commandMatched = true;
                            setTimeout(() => onSkillCommandExecuted(), 2000);
                        }
                    }

                    // Skill command check: skill: <name> <prompt>
                    const skillMatch = commandPart.match(/^skill\s*:\s*(\S+)(.*)$/i);
                    if (skillMatch) {
                        const skillName = skillMatch[1].trim();
                        const skillPrompt = (skillMatch[2] || '').trim();
                        clearTerminalLine();
                        launchSkillFromTerminal(skillName, skillPrompt);
                        return false;
                    }

                    // AI command check
                    const prefixText = aiCommandPrefix.slice(0, -1);
                    const prefixSep = aiCommandPrefix.slice(-1);
                    const commandRegex = new RegExp(`(${prefixText}\\s*${prefixSep})`);
                    const match = commandPart.match(commandRegex);

                    if (match) {
                        const aiPrompt = commandPart.substring(match.index + match[0].length).trim();
                        setTimeout(() => {
                            pane.term.writeln(`\r\n\x1b[1;33m[AI] \u0417\u0430\u043f\u0440\u043e\u0441: ${aiPrompt}\x1b[0m`);
                        }, 50);
                        pane.ws.send(JSON.stringify({ type: 'ai_query', prompt: line }));
                        return true;
                    } else if (cleanCommand) {
                        pane.ws.send(JSON.stringify({ type: 'command_log', command: cleanCommand }));
                    }
                    break;
                }
            }
        }
        return true;
    });
}

function sendResizeForPane(pane) {
    if (pane.ws && pane.ws.readyState === WebSocket.OPEN) {
        pane.ws.send(JSON.stringify({ type: 'resize', cols: pane.term.cols, rows: pane.term.rows }));
    }
}

function setActivePane(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;
    if (activePane) activePane.container.classList.remove('active');
    activePane = pane;
    pane.container.classList.add('active');
    updateSessionIndicator();
}

/** Fit all panes (e.g. after window resize) */
function fitAllPanes() {
    panes.forEach(p => {
        try { p.fit.fit(); sendResizeForPane(p); } catch { }
    });
}

let globalResizeTimeout;
window.addEventListener('resize', () => {
    clearTimeout(globalResizeTimeout);
    globalResizeTimeout = setTimeout(fitAllPanes, 100);
});

// ========== Split / Close Logic ==========

function splitPane(paneId, direction) {
    const pane = panes.get(paneId);
    if (!pane) return;

    const parent = pane.container.parentNode;

    // Create split container
    const splitContainer = document.createElement('div');
    splitContainer.className = `ws-split ws-split-${direction}`;

    // Create drag handle
    const handle = document.createElement('div');
    handle.className = direction === 'vertical' ? 'ws-split-handle-v' : 'ws-split-handle-h';

    // Replace old pane with split container
    parent.replaceChild(splitContainer, pane.container);

    // Put old pane and handle and new pane into split
    pane.container.style.flex = '0 0 50%';
    splitContainer.appendChild(pane.container);
    splitContainer.appendChild(handle);

    // Create new pane
    const newPane = createPane(splitContainer);
    newPane.container.style.flex = '0 0 50%';

    // Setup drag handle
    setupSplitDrag(handle, direction, pane.container, newPane.container, splitContainer);

    // Fit both after DOM settles
    setTimeout(() => {
        try { pane.fit.fit(); sendResizeForPane(pane); } catch { }
        try { newPane.fit.fit(); sendResizeForPane(newPane); } catch { }
    }, 50);

    setActivePane(newPane.id);
}

function closePane(paneId) {
    if (panes.size <= 1) return; // Can't close the last pane

    const pane = panes.get(paneId);
    if (!pane) return;

    // Cleanup
    try { pane.ws.close(); } catch { }
    try { pane.term.dispose(); } catch { }
    panes.delete(paneId);

    const paneEl = pane.container;
    const splitContainer = paneEl.parentNode;

    if (splitContainer && splitContainer.classList.contains('ws-split')) {
        // Find the sibling (the other child that is not the handle and not this pane)
        let sibling = null;
        for (const child of splitContainer.children) {
            if (child !== paneEl && !child.classList.contains('ws-split-handle-v') && !child.classList.contains('ws-split-handle-h')) {
                sibling = child;
                break;
            }
        }

        if (sibling) {
            sibling.style.flex = '1';
            // Replace split container with sibling
            splitContainer.parentNode.replaceChild(sibling, splitContainer);
        }
    } else {
        paneEl.remove();
    }

    // Set active to first remaining pane
    if (activePane && activePane.id === paneId) {
        const first = panes.values().next().value;
        if (first) setActivePane(first.id);
    }

    // Fit remaining panes
    setTimeout(fitAllPanes, 50);
}

// ========== Split Drag Handle ==========

function setupSplitDrag(handle, direction, firstEl, secondEl, splitContainer) {
    let dragging = false;
    let startPos = 0;
    let containerSize = 0;
    let startFirstPx = 0;
    const handleSize = direction === 'vertical' ? 5 : 5; // handle width/height in px

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        handle.classList.add('active');
        document.body.classList.add('ws-split-dragging');

        const containerRect = splitContainer.getBoundingClientRect();
        const firstRect = firstEl.getBoundingClientRect();

        if (direction === 'vertical') {
            startPos = e.clientX;
            containerSize = containerRect.width - handleSize;
            startFirstPx = firstRect.width;
        } else {
            startPos = e.clientY;
            containerSize = containerRect.height - handleSize;
            startFirstPx = firstRect.height;
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const delta = direction === 'vertical' ? e.clientX - startPos : e.clientY - startPos;
        let newFirstPx = startFirstPx + delta;

        // Clamp: min 15% of available space
        const minPx = containerSize * 0.15;
        newFirstPx = Math.max(minPx, Math.min(containerSize - minPx, newFirstPx));
        const newSecondPx = containerSize - newFirstPx;

        firstEl.style.flex = `0 0 ${newFirstPx}px`;
        secondEl.style.flex = `0 0 ${newSecondPx}px`;
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('active');
        document.body.classList.remove('ws-split-dragging');
        // Fit all panes after drag
        setTimeout(fitAllPanes, 50);
    });
}

// ========== Backward-compatible accessors ==========
// Many functions below use `term`, `ws`, `currentSessionId` globally.
// These now proxy to activePane.
Object.defineProperty(window, '_activeTermCompat', {
    get() { return activePane; }
});

// Convenience getters used by skill/remote-command code
function getActiveTerm() { return activePane ? activePane.term : null; }
function getActiveWs() { return activePane ? activePane.ws : null; }
function getActiveSessionId() { return activePane ? activePane.sessionId : null; }

// For log loading — track first connected session
let logsSessionId = null;

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

// (Old WS handlers and terminal input removed — now inside createPane/attachKeyHandler)

// ========== UI Handlers ==========
document.getElementById('wsClose').onclick = () => {
    panes.forEach(p => { try { p.ws.close(); } catch { } });
    window.close();
};
document.getElementById('wsFit').onclick = () => fitAllPanes();
document.getElementById('wsReconnect').onclick = () => location.reload();
document.getElementById('wsSplitV').onclick = () => { if (activePane) splitPane(activePane.id, 'vertical'); };
document.getElementById('wsSplitH').onclick = () => { if (activePane) splitPane(activePane.id, 'horizontal'); };

// ========== Session Indicator ==========
function updateSessionIndicator() {
    const el = document.getElementById('wsSessionId');
    const sid = getActiveSessionId();
    if (el && sid) {
        el.textContent = `Session: ${sid.substring(0, 8)}...`;
        el.title = `Session ID: ${sid}\nКликните для копирования`;
        el.onclick = () => {
            navigator.clipboard.writeText(sid).then(() => {
                const orig = el.textContent;
                el.textContent = '✓ Скопировано!';
                setTimeout(() => { el.textContent = orig; }, 1500);
            });
        };
    }
}

// ========== Remote Command Handling ==========
function handleRemoteCommand(pane, msg) {
    pane.term.writeln(`\r\n\x1b[1;45;97m ⚡ REST API COMMAND ⚡ \x1b[0m`);
    pane.term.writeln(`\x1b[1;35mCommand:\x1b[0m \x1b[1;33m${msg.command}\x1b[0m`);
    pane.pendingRemoteCommand = { commandId: msg.commandId, command: msg.command, requireConfirmation: msg.requireConfirmation };
    setActivePane(pane.id); // bring this pane to focus
    if (msg.requireConfirmation) showCommandConfirm(msg.command);
    else executeRemoteCommand(msg.command);
}

function showCommandConfirm(command) {
    document.getElementById('wsCommandConfirmText').textContent = command;
    document.getElementById('wsCommandConfirm').classList.remove('hidden');
    if (activePane) activePane.term.writeln('\r\n\x1b[1;33m[REST API] Ожидается подтверждение...\x1b[0m');
}

function hideCommandConfirm() {
    document.getElementById('wsCommandConfirm').classList.add('hidden');
}

function executeRemoteCommand(command) {
    if (!activePane) return;
    activePane.remoteCommandBuffer = '';
    activePane.remoteCommandCollecting = true;
    activePane.term.writeln(`\r\n\x1b[1;36m[REST API] Выполняется: ${command}\x1b[0m`);
    try { activePane.ws.send(JSON.stringify({ type: 'data', data: command + '\r' })); }
    catch (e) { sendCommandResult('error', '', 'Failed: ' + e.message, null); }
}

function checkRemoteCommandCompletion() {
    if (!activePane) return;
    checkRemoteCommandCompletionForPane(activePane);
}

function checkRemoteCommandCompletionForPane(pane) {
    const cleanBuffer = pane.remoteCommandBuffer.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    if (promptRegex.test(cleanBuffer)) {
        const lines = cleanBuffer.split('\n');
        let outputLines = [];
        for (let i = lines.length - 1; i >= 0; i--) {
            if (promptRegex.test(lines[i])) { outputLines = lines.slice(0, i); break; }
        }
        if (outputLines.length > 0) outputLines = outputLines.slice(1);
        sendCommandResultForPane(pane, 'completed', outputLines.join('\n').trim(), '', 0);
        pane.remoteCommandCollecting = false;
        pane.remoteCommandBuffer = '';
        pane.pendingRemoteCommand = null;
    }
}

function sendCommandResult(status, stdout, stderr, exitCode) {
    if (!activePane || !activePane.pendingRemoteCommand) return;
    sendCommandResultForPane(activePane, status, stdout, stderr, exitCode);
}

function sendCommandResultForPane(pane, status, stdout, stderr, exitCode) {
    if (!pane.pendingRemoteCommand) return;
    try { pane.ws.send(JSON.stringify({ type: 'command_result', commandId: pane.pendingRemoteCommand.commandId, status, stdout, stderr, exitCode })); } catch { }
}

document.getElementById('wsConfirmYes').onclick = () => { if (activePane && activePane.pendingRemoteCommand) { hideCommandConfirm(); executeRemoteCommand(activePane.pendingRemoteCommand.command); } };
document.getElementById('wsConfirmNo').onclick = () => {
    if (activePane && activePane.pendingRemoteCommand) {
        activePane.term.writeln('\r\n\x1b[1;31m[REST API] Команда отклонена\x1b[0m');
        sendCommandResult('rejected', '', 'Rejected by user', null);
        hideCommandConfirm();
        activePane.pendingRemoteCommand = null;
    }
};
document.getElementById('wsConfirmSkip').onclick = () => { if (activePane && activePane.pendingRemoteCommand) { hideCommandConfirm(); executeRemoteCommand(activePane.pendingRemoteCommand.command); } };

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
            fitAllPanes();
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
            fitAllPanes();
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
    if (!logsSessionId) return;
    try {
        const apiUrl = logTab === 'skills' ? '/api/skills-logs' : '/api/logs';
        const url = `${apiUrl}?sessionId=${encodeURIComponent(logsSessionId)}&t=${Date.now()}`;
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

// Request skills on load — will be sent once first pane connects
function requestSkillsList() {
    const ws = getActiveWs();
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'skills_list' }));
    }
}

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
    useModal: false, // false = panel, true = popup window
    paneId: null // tracks which pane the skill was launched from
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
    const ws = getActiveWs();
    if (ws) ws.send(JSON.stringify({ type: 'skills_list' }));
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

// ========== Modal Resize functionality ==========
(function setupModalResize() {
    const modal = document.getElementById('wsSkillDialogModal');
    const handles = modal.querySelectorAll('.ws-resize-handle');
    let isResizing = false;
    let resizeDir = '';
    let startX, startY, startW, startH, startLeft, startTop;
    const minW = 320, minH = 250;

    handles.forEach(handle => {
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            e.stopPropagation();
            isResizing = true;
            resizeDir = handle.dataset.resize;
            const rect = modal.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startW = rect.width;
            startH = rect.height;
            startLeft = rect.left;
            startTop = rect.top;
            modal.style.transform = 'none';
            modal.style.left = startLeft + 'px';
            modal.style.top = startTop + 'px';
            document.body.style.userSelect = 'none';
        });
    });

    document.addEventListener('mousemove', e => {
        if (!isResizing) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;

        // East
        if (resizeDir.includes('e')) {
            newW = Math.max(minW, startW + dx);
        }
        // West
        if (resizeDir.includes('w')) {
            const w = Math.max(minW, startW - dx);
            if (w !== startW) {
                newLeft = startLeft + (startW - w);
                newW = w;
            }
        }
        // South
        if (resizeDir.includes('s')) {
            newH = Math.max(minH, startH + dy);
        }
        // North
        if (resizeDir === 'n' || resizeDir === 'ne' || resizeDir === 'nw') {
            const h = Math.max(minH, startH - dy);
            if (h !== startH) {
                newTop = startTop + (startH - h);
                newH = h;
            }
        }

        modal.style.width = newW + 'px';
        modal.style.height = newH + 'px';
        modal.style.left = newLeft + 'px';
        modal.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
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
    skillDialogState.paneId = null;
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

/**
 * Launch skill from terminal command: skill: <name> <prompt>
 * Finds skill by name (case-insensitive, matches last segment of path)
 */
function launchSkillFromTerminal(skillName, prompt) {
    // Find skill by name (case-insensitive match on last path segment or skill name)
    const normalizedName = skillName.toLowerCase();
    const foundSkill = availableSkills.find(s => {
        const sName = (s.name || '').toLowerCase();
        const sPath = (s.path || '').toLowerCase();
        const lastSegment = sPath.split('/').filter(Boolean).pop() || '';
        return sName === normalizedName || lastSegment === normalizedName || sPath === normalizedName;
    });

    if (!foundSkill) {
        const t = getActiveTerm();
        if (t) {
            t.writeln(`\r\n\x1b[1;31m[Skill] Ошибка: скилл "${skillName}" не найден\x1b[0m`);
            t.writeln(`\x1b[90mДоступные скиллы: ${availableSkills.map(s => s.name || s.path).join(', ') || '(нет)'}\x1b[0m`);
        }
        return;
    }

    const t = getActiveTerm();
    if (t) t.writeln(`\r\n\x1b[1;36m[Skill] Запуск: ${foundSkill.name || skillName}\x1b[0m`);

    // Set prompt into the params input (used by startSkillDialog)
    const input = document.getElementById('wsSkillParamsInput');
    if (input) input.value = prompt || '';

    // Use panel mode by default
    skillDialogState.useModal = false;
    startSkillDialog(foundSkill);
}

async function startSkillDialog(skill) {
    const sid = getActiveSessionId();
    if (!sid) {
        const t = getActiveTerm();
        if (t) t.writeln('\r\n\x1b[1;31m[Ошибка] Session ID ещё не получен\x1b[0m');
        return;
    }

    resetSkillDialogState();
    skillDialogState.terminalSessionId = sid;
    skillDialogState.skillName = skill.name;
    skillDialogState.startedAt = new Date().toISOString();
    skillDialogState.paneId = activePane ? activePane.id : null;
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
                terminalSessionId: sid,
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
    const t = getActiveTerm();
    if (t) { t.paste(command); t.focus(); }
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
    const ws = getActiveWs();
    if (ws) ws.send(JSON.stringify({ type: 'skills_list' }));
}

function normalizeCommand(cmd) {
    return (cmd || '').trim().replace(/\s+/g, ' ');
}

function clearTerminalLine() {
    const ws = getActiveWs();
    if (ws) ws.send(JSON.stringify({ type: 'data', data: '\x15' })); // Ctrl+U
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

    const ws = getActiveWs();
    if (ws) ws.send(JSON.stringify({ type: 'skill_get_content', source: source, path: skillPath }));
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
    const ws = getActiveWs();
    if (ws) ws.send(JSON.stringify(msg));

    document.getElementById('wsSkillCreateSave').disabled = true;
    document.getElementById('wsSkillCreateSave').textContent = 'Сохранение...';
}

function handleSkillCreateResult(success, error) {
    const saveBtn = document.getElementById('wsSkillCreateSave');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Сохранить';

    if (success) {
        closeCreateSkillDialog();
        const ws = getActiveWs();
        if (ws) ws.send(JSON.stringify({ type: 'skills_list' }));
        const t = getActiveTerm();
        if (t) t.writeln(`\r\n\x1b[1;32m[Skills] Skill успешно сохранён\x1b[0m`);
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
    panes.forEach(p => { try { p.ws.close(); } catch { } });
});

// ========== Initial Pane Creation ==========
(function init() {
    const wsRight = document.getElementById('wsRight');
    const initialPane = createPane(wsRight);
    setActivePane(initialPane.id);
    // Request skills once pane connects
    initialPane.ws.addEventListener('open', () => {
        setTimeout(requestSkillsList, 300);
    }, { once: true });
})();
