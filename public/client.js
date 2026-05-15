let currentAccountId = '0';
let windows = {};
let windowOrder = [];
let activeWindowId = null;
let wsConnections = {};
let canvasContexts = {};
let fps = { frames: 0, lastTime: Date.now() };
let activeInput = null;

document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    currentAccountId = params.get('id') || '0';
    document.getElementById('currentAccountId').textContent = currentAccountId;
    document.getElementById('accountIdInput').value = currentAccountId;
    initApp();
    bindEvents();
    setInterval(updateFps, 1000);
});

async function initApp() {
    await fetch('/api/init-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId })
    });
    await refreshStatus();
}

async function refreshStatus() {
    try {
        const res = await fetch(`/api/status/${currentAccountId}`);
        const data = await res.json();
        windows = {};
        windowOrder = [];
        data.windows.forEach(w => {
            windows[w.windowId] = {
                url: w.url,
                autoScroll: w.autoScroll,
                title: w.title,
                visible: !w.hidden
            };
            windowOrder.push(w.windowId);
        });
        document.getElementById('hiddenCount').textContent =
            data.hiddenCount > 0 ? `👻 Скрыто: ${data.hiddenCount}` : '';
        renderGrid();
        renderSidebar();
        connectAllWebSockets();
        if (!activeWindowId || !windows[activeWindowId]) {
            const firstVisible = windowOrder.find(id => windows[id]?.visible);
            if (firstVisible) setActiveWindow(firstVisible);
        }
    } catch (e) {
        console.error('Status refresh failed:', e);
    }
}

function connectAllWebSockets() {
    windowOrder.forEach(id => {
        if (!wsConnections[id] || wsConnections[id].readyState > 1) {
            connectWebSocket(id);
        }
    });
}

function connectWebSocket(windowId) {
    if (wsConnections[windowId]?.readyState === WebSocket.OPEN) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws?accountId=${currentAccountId}&windowId=${windowId}`;
    try {
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => { wsConnections[windowId] = ws; };
        ws.onmessage = (event) => {
            const ctx = canvasContexts[windowId];
            if (!ctx) return;
            const blob = new Blob([event.data], { type: 'image/jpeg' });
            createImageBitmap(blob).then(bitmap => {
                const canvas = ctx.canvas;
                if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                }
                ctx.drawImage(bitmap, 0, 0);
                bitmap.close();
                fps.frames++;
            }).catch(() => {});
        };
        ws.onclose = () => {
            delete wsConnections[windowId];
            setTimeout(() => { if (windows[windowId]) connectWebSocket(windowId); }, 2000);
        };
        ws.onerror = () => { ws.close(); };
    } catch (e) {}
}

function renderGrid() {
    const grid = document.getElementById('browsersGrid');
    const visibleWindows = windowOrder.filter(id => windows[id]?.visible);
    const count = visibleWindows.length;
    grid.className = 'browsers-grid';
    if (count <= 1) grid.classList.add('cols-1');
    else if (count === 2) grid.classList.add('cols-2');
    else grid.classList.add('cols-3');

    grid.innerHTML = windowOrder.map(id => {
        const win = windows[id];
        if (!win) return '';
        const activeClass = id === activeWindowId ? 'active' : '';
        const hiddenClass = !win.visible ? 'hidden' : '';
        return `
            <div class="browser-card ${hiddenClass} ${activeClass}" data-window-id="${id}">
                <div class="browser-card-header">
                    <span class="browser-title">${win.title}</span>
                    <span class="browser-url">${win.url?.substring(0, 25) || ''}</span>
                    <div class="browser-actions">
                        <button class="icon-btn" data-action="navigate" data-id="${id}" title="Перейти" style="font-size:0.7rem;width:26px;height:26px;">🔗</button>
                        <button class="icon-btn" data-action="toggle" data-id="${id}" title="Скрыть/Показать" style="font-size:0.7rem;width:26px;height:26px;">👁️</button>
                        <button class="icon-btn" data-action="close" data-id="${id}" title="Закрыть" style="font-size:0.7rem;width:26px;height:26px;color:#e94560;">✕</button>
                    </div>
                </div>
                <div class="browser-stream">
                    <canvas></canvas>
                    <div class="interaction-layer" data-layer-id="${id}"></div>
                </div>
            </div>
        `;
    }).join('');

    windowOrder.forEach(id => {
        const canvas = document.querySelector(`[data-window-id="${id}"] canvas`);
        if (canvas) canvasContexts[id] = canvas.getContext('2d', { alpha: false });
        setupInteraction(id);
    });

    document.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            if (action === 'navigate') navigateWindow(id);
            else if (action === 'toggle') toggleVisibility(id);
            else if (action === 'close') closeWindow(id);
        });
    });

    document.querySelectorAll('.browser-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.dataset.windowId;
            if (id) setActiveWindow(id);
        });
    });
}

function renderSidebar() {
    const windowList = document.getElementById('windowList');
    const hiddenList = document.getElementById('hiddenList');
    const visible = windowOrder.filter(id => windows[id]?.visible);
    const hidden = windowOrder.filter(id => !windows[id]?.visible);

    windowList.innerHTML = visible.map(id => `
        <div class="list-item" data-id="${id}">
            <span class="title">${windows[id]?.title || id}</span>
            <button class="icon-btn" data-close="${id}" style="font-size:0.6rem;width:24px;height:24px;">✕</button>
        </div>
    `).join('') || '<p style="color:var(--muted);font-size:0.75rem;">Нет окон</p>';

    hiddenList.innerHTML = hidden.map(id => `
        <div class="list-item hidden-window" data-id="${id}">
            <span class="title">👻 ${windows[id]?.title || id}</span>
            <button class="icon-btn" data-show="${id}" style="font-size:0.6rem;width:24px;height:24px;">👁️</button>
        </div>
    `).join('') || '<p style="color:var(--muted);font-size:0.75rem;">Нет скрытых</p>';

    document.querySelectorAll('#windowList .list-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') setActiveWindow(item.dataset.id);
        });
    });
    document.querySelectorAll('#hiddenList .list-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') {
                toggleVisibility(item.dataset.id);
                setActiveWindow(item.dataset.id);
            }
        });
    });
    document.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeWindow(btn.dataset.close);
        });
    });
    document.querySelectorAll('[data-show]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleVisibility(btn.dataset.show);
        });
    });
}

function setupInteraction(windowId) {
    const layer = document.querySelector(`[data-layer-id="${windowId}"]`);
    if (!layer) return;
    const newLayer = layer.cloneNode(true);
    layer.parentNode.replaceChild(newLayer, layer);
    let lastTap = 0;
    let longPressTimer;

    newLayer.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        setActiveWindow(windowId);
        const rect = newLayer.getBoundingClientRect();
        const scaleX = 1280 / rect.width;
        const scaleY = 720 / rect.height;
        const x = Math.round((e.clientX - rect.left) * scaleX);
        const y = Math.round((e.clientY - rect.top) * scaleY);

        longPressTimer = setTimeout(() => refreshWindow(windowId), 800);
        const now = Date.now();
        if (now - lastTap < 300) {
            clearTimeout(longPressTimer);
            activeInput = { windowId, x, y };
            showKeyboard();
        } else {
            sendInteractDirect(windowId, 'click', { x, y });
        }
        lastTap = now;
        showTouchIndicator(e.clientX, e.clientY);
    });

    newLayer.addEventListener('pointerup', () => clearTimeout(longPressTimer));
    newLayer.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
    newLayer.addEventListener('wheel', (e) => {
        e.preventDefault();
        sendInteractDirect(windowId, 'scroll', { x: 0, y: e.deltaY > 0 ? 300 : -300 });
    }, { passive: false });

    let touchStartX = 0;
    newLayer.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; });
    newLayer.addEventListener('touchend', (e) => {
        if (e.changedTouches[0].clientX - touchStartX < -80) toggleVisibility(windowId);
    });
}

function setActiveWindow(id) {
    activeWindowId = id;
    document.querySelectorAll('.browser-card').forEach(c => c.classList.remove('active'));
    document.querySelector(`[data-window-id="${id}"]`)?.classList.add('active');
}

async function sendInteract(windowId, action, params = {}) {
    try {
        await fetch('/api/interact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId: currentAccountId, windowId, action, params })
        });
    } catch (e) {}
}

function sendInteractDirect(windowId, action, params = {}) {
    const ws = wsConnections[windowId];
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'interact', action, params }));
    }
    sendInteract(windowId, action, params);
}

async function toggleVisibility(windowId) {
    await fetch('/api/window/toggle-visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId })
    });
    await refreshStatus();
}

async function closeWindow(windowId) {
    if (!confirm('Закрыть окно?')) return;
    await fetch('/api/window/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId })
    });
    if (activeWindowId === windowId) activeWindowId = null;
    await refreshStatus();
}

async function navigateWindow(windowId) {
    const url = prompt('URL:', windows[windowId]?.url || 'https://');
    if (url) {
        const formatted = url.startsWith('http') ? url : 'https://' + url;
        windows[windowId].url = formatted;
        await sendInteract(windowId, 'navigate', { url: formatted });
        await refreshStatus();
    }
}

async function refreshWindow(windowId) {
    await sendInteract(windowId, 'refresh');
}

async function showAllWindows() {
    for (const id of windowOrder) {
        if (!windows[id]?.visible) await toggleVisibility(id);
    }
}

// Виртуальная клавиатура
function showKeyboard() {
    const keyboard = document.getElementById('virtualKeyboard');
    keyboard.classList.remove('hidden');
    document.getElementById('keyboardInput').value = '';
    document.getElementById('keyboardInput').focus();
}

function hideKeyboard() {
    document.getElementById('virtualKeyboard').classList.add('hidden');
    document.getElementById('keyboardInput').value = '';
    activeInput = null;
}

async function pasteFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            document.getElementById('keyboardInput').value = text;
        }
    } catch (e) {
        alert('Не удалось вставить из буфера обмена. Вставьте текст вручную.');
    }
}

async function sendText(clearFirst = true) {
    if (!activeInput) return;
    const text = document.getElementById('keyboardInput').value;
    const action = clearFirst ? 'type' : 'paste';
    await sendInteract(activeInput.windowId, action, {
        x: activeInput.x,
        y: activeInput.y,
        text: text
    });
    hideKeyboard();
}

async function sendKeyPress(key) {
    if (!activeInput) return;
    await sendInteract(activeInput.windowId, 'keyPress', { key });
}

// Логи
async function showLogs() {
    document.getElementById('logsModal').classList.remove('hidden');
    const container = document.getElementById('logContainer');
    try {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        container.innerHTML = logs.map(l => {
            const color = { error: '#e94560', warn: '#fdcb6e', info: '#6c5ce7', success: '#00b894' }[l.level] || '#e0e0e0';
            return `<div style="color:${color}">[${l.iso}] ${l.level.toUpperCase()}: ${l.message}${l.data ? '\n  ' + l.data : ''}</div>`;
        }).join('\n');
        container.scrollTop = container.scrollHeight;
    } catch (e) {
        container.innerHTML = 'Ошибка загрузки логов';
    }
}

async function copyLogs() {
    const text = document.getElementById('logContainer').innerText;
    await navigator.clipboard.writeText(text);
    alert('Логи скопированы!');
}

async function clearLogs() {
    await fetch('/api/logs/clear', { method: 'POST' });
    await showLogs();
}

function updateFps() {
    const now = Date.now();
    const elapsed = (now - fps.lastTime) / 1000;
    const currentFps = Math.round(fps.frames / elapsed);
    fps.frames = 0;
    fps.lastTime = now;
    const el = document.getElementById('fpsCounter');
    if (el) {
        el.textContent = `${currentFps} FPS`;
        el.style.background = currentFps > 15 ? 'var(--green)' : currentFps > 8 ? '#fdcb6e' : 'var(--red)';
    }
}

function showTouchIndicator(x, y) {
    const el = document.createElement('div');
    el.className = 'touch-indicator';
    el.style.left = (x - 10) + 'px';
    el.style.top = (y - 10) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 300);
}

function bindEvents() {
    // Сайдбар
    document.getElementById('btnSidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('visible');
    });
    document.getElementById('closeSidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('visible');
    });
    document.getElementById('btnAddWindow').addEventListener('click', createWindow);
    document.getElementById('btnShowAll').addEventListener('click', showAllWindows);

    // URL бар
    document.getElementById('btnGo').addEventListener('click', () => {
        const url = document.getElementById('urlInput').value.trim();
        if (url && activeWindowId) {
            const formatted = url.startsWith('http') ? url : 'https://' + url;
            windows[activeWindowId].url = formatted;
            sendInteract(activeWindowId, 'navigate', { url: formatted });
            refreshStatus();
        } else if (url) {
            createWindow(url);
        }
    });
    document.getElementById('urlInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const url = e.target.value.trim();
            if (url && activeWindowId) {
                const formatted = url.startsWith('http') ? url : 'https://' + url;
                sendInteract(activeWindowId, 'navigate', { url: formatted });
                refreshStatus();
            } else if (url) {
                createWindow(url);
            }
        }
    });

    // Тулбар
    document.getElementById('btnBack').addEventListener('click', () => {
        if (activeWindowId) sendInteract(activeWindowId, 'goBack').then(refreshStatus);
    });
    document.getElementById('btnForward').addEventListener('click', () => {
        if (activeWindowId) sendInteract(activeWindowId, 'goForward').then(refreshStatus);
    });
    document.getElementById('btnRefresh').addEventListener('click', () => {
        if (activeWindowId) refreshWindow(activeWindowId);
    });
    document.getElementById('btnScroll').addEventListener('click', () => {
        if (activeWindowId) sendInteract(activeWindowId, 'scroll', { x: 0, y: 300 });
    });
    document.getElementById('btnAutoScroll').addEventListener('click', async () => {
        if (!activeWindowId) return;
        const enabled = !windows[activeWindowId]?.autoScroll;
        await fetch('/api/autoscroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId: currentAccountId, windowId: activeWindowId, enabled })
        });
        windows[activeWindowId].autoScroll = enabled;
    });
    document.getElementById('btnType').addEventListener('click', () => {
        if (activeWindowId) {
            activeInput = { windowId: activeWindowId, x: 640, y: 360 };
            showKeyboard();
        }
    });
    document.getElementById('btnScreenshot').addEventListener('click', () => {
        if (activeWindowId) window.open(`/api/screenshot/${currentAccountId}/${activeWindowId}`, '_blank');
    });
    document.getElementById('btnClose').addEventListener('click', () => {
        if (activeWindowId) closeWindow(activeWindowId);
    });

    // Клавиатура
    document.getElementById('btnPasteClipboard').addEventListener('click', pasteFromClipboard);
    document.getElementById('btnKeyboardClose').addEventListener('click', hideKeyboard);
    document.getElementById('btnSendText').addEventListener('click', () => sendText(false));
    document.getElementById('btnClearAndType').addEventListener('click', () => sendText(true));
    document.querySelectorAll('.key-btn').forEach(btn => {
        btn.addEventListener('click', () => sendKeyPress(btn.dataset.key));
    });

    // Настройки
    document.getElementById('btnSettings').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('hidden');
        document.getElementById('accountIdInput').value = currentAccountId;
    });
    document.getElementById('accountBadge').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('hidden');
    });
    document.getElementById('btnCloseSettings').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.add('hidden');
    });
    document.getElementById('btnChangeAccount').addEventListener('click', () => {
        const newId = document.getElementById('accountIdInput').value || '0';
        if (newId !== currentAccountId) {
            currentAccountId = newId;
            document.getElementById('currentAccountId').textContent = currentAccountId;
            history.pushState({}, '', `?id=${currentAccountId}`);
            document.getElementById('settingsModal').classList.add('hidden');
            Object.values(wsConnections).forEach(ws => ws.close());
            wsConnections = {};
            canvasContexts = {};
            initApp();
        }
    });

    // Логи
    document.getElementById('btnShowLogs').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.add('hidden');
        showLogs();
    });
    document.getElementById('btnCloseLogs').addEventListener('click', () => {
        document.getElementById('logsModal').classList.add('hidden');
    });
    document.getElementById('btnCopyLogs').addEventListener('click', copyLogs);
    document.getElementById('btnClearLogs').addEventListener('click', clearLogs);

    // Закрытие модалок
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    });
}

async function createWindow(url = 'https://example.com') {
    const id = `win_${Date.now()}`;
    await fetch('/api/window/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId: id, url })
    });
    await refreshStatus();
}

// Горячие клавиши
document.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
    if (!activeWindowId) return;
    if (e.key === 'F5') { e.preventDefault(); refreshWindow(activeWindowId); }
    if (e.key === 'Backspace') { e.preventDefault(); sendInteract(activeWindowId, 'goBack').then(refreshStatus); }
    if (e.key === 'F2') {
        e.preventDefault();
        activeInput = { windowId: activeWindowId, x: 640, y: 360 };
        showKeyboard();
    }
});
