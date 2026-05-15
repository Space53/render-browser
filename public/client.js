let currentAccountId = '0';
let windows = {};
let windowOrder = [];
let activeWindowId = null;
let wsConnections = {}; // windowId -> WebSocket
let canvasContexts = {}; // windowId -> CanvasRenderingContext2D
let fps = { frames: 0, lastTime: Date.now() };
let activeInput = null;
let sidebarVisible = false;

// ----- Инициализация -----
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
    const res = await fetch(`/api/status/${currentAccountId}`);
    const data = await res.json();
    windows = {};
    windowOrder = [];
    data.windows.forEach(w => {
        windows[w.windowId] = {
            url: w.url,
            autoScroll: w.autoScroll || false,
            title: w.title || w.windowId,
            visible: true
        };
        windowOrder.push(w.windowId);
    });
    renderGrid();
    renderSidebar();
    connectAllWebSockets();
    if (!activeWindowId && windowOrder.length) setActiveWindow(windowOrder[0]);
}

// ----- WebSocket подключение и отображение кадров -----
function connectAllWebSockets() {
    windowOrder.forEach(id => {
        if (!wsConnections[id] || wsConnections[id].readyState > 1) {
            connectWebSocket(id);
        }
    });
}

function connectWebSocket(windowId) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/${currentAccountId}/${windowId}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        console.log(`WS connected: ${windowId}`);
        wsConnections[windowId] = ws;
    };

    ws.onmessage = (event) => {
        const arrayBuffer = event.data;
        const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
        const ctx = canvasContexts[windowId];
        if (ctx) {
            createImageBitmap(blob).then(bitmap => {
                const canvas = ctx.canvas;
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(bitmap, 0, 0);
                fps.frames++;
            }).catch(() => {});
        }
    };

    ws.onerror = () => console.error(`WS error: ${windowId}`);
    ws.onclose = () => {
        console.log(`WS closed: ${windowId}`);
        delete wsConnections[windowId];
        // Переподключение через 2 секунды
        setTimeout(() => {
            if (windows[windowId]) connectWebSocket(windowId);
        }, 2000);
    };
}

// ----- Рендеринг -----
function renderGrid() {
    const grid = document.getElementById('browsersGrid');
    const visible = windowOrder.filter(id => windows[id]?.visible !== false);
    const count = visible.length;
    grid.className = 'browsers-grid';
    if (count <= 1) grid.classList.add('cols-1');
    else if (count === 2) grid.classList.add('cols-2');
    else grid.classList.add('cols-3');

    grid.innerHTML = windowOrder.map(id => {
        const win = windows[id] || { visible: true, title: id, url: '' };
        const hiddenClass = !win.visible ? 'hidden-card' : '';
        const activeClass = id === activeWindowId ? 'active' : '';
        return `
            <div class="browser-card ${hiddenClass} ${activeClass}" data-window-id="${id}" id="card-${id}">
                <div class="browser-card-header">
                    <span class="browser-title">${win.title}</span>
                    <span class="browser-url">${win.url}</span>
                    <div class="browser-actions">
                        <button class="icon-btn" data-action="navigate" data-id="${id}">🔗</button>
                        <button class="icon-btn" data-action="toggleVisible" data-id="${id}">👁️</button>
                        <button class="icon-btn" data-action="close" data-id="${id}" style="color:#e94560;">✕</button>
                    </div>
                </div>
                <div class="browser-stream" id="stream-${id}">
                    <canvas></canvas>
                    <div class="interaction-layer" id="layer-${id}"></div>
                </div>
            </div>`;
    }).join('');

    // Привязка canvas
    windowOrder.forEach(id => {
        const canvas = document.querySelector(`#stream-${id} canvas`);
        if (canvas) {
            canvasContexts[id] = canvas.getContext('2d');
        }
        setupInteraction(id);
    });

    // Обработчики для кнопок в заголовках
    document.querySelectorAll('.browser-actions [data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            if (action === 'navigate') navigateWindow(id);
            else if (action === 'toggleVisible') toggleVisible(id);
            else if (action === 'close') closeWindow(id);
        });
    });

    // Клик по карточке делает окно активным
    document.querySelectorAll('.browser-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.dataset.windowId;
            if (id) setActiveWindow(id);
        });
    });
}

function renderSidebar() {
    const windowList = document.getElementById('windowList');
    windowList.innerHTML = windowOrder.map(id => {
        const win = windows[id] || {};
        return `<div class="list-item" data-id="${id}">
            <span class="title">${win.title || id}</span>
            <button class="icon-btn" data-close="${id}" style="font-size:14px;">✕</button>
        </div>`;
    }).join('');

    document.querySelectorAll('#windowList .list-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') setActiveWindow(item.dataset.id);
        });
    });
    document.querySelectorAll('[data-close]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeWindow(btn.dataset.close);
        });
    });

    // Закладки
    const bookmarks = JSON.parse(localStorage.getItem('lb_bookmarks') || '[]');
    document.getElementById('bookmarkList').innerHTML = bookmarks.map((b, i) => `
        <div class="list-item" data-url="${b.url}">
            <span class="title">${b.title || b.url}</span>
            <button class="icon-btn" data-del-bookmark="${i}" style="font-size:14px;">🗑️</button>
        </div>
    `).join('');
    document.querySelectorAll('[data-url]').forEach(el => {
        el.addEventListener('click', () => navigateToUrl(el.dataset.url));
    });
    document.querySelectorAll('[data-del-bookmark]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.delBookmark);
            const bookmarks = JSON.parse(localStorage.getItem('lb_bookmarks') || '[]');
            bookmarks.splice(idx, 1);
            localStorage.setItem('lb_bookmarks', JSON.stringify(bookmarks));
            renderSidebar();
        });
    });
}

// ----- Взаимодействие -----
function setupInteraction(windowId) {
    const layer = document.getElementById(`layer-${windowId}`);
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
            showMobileKeyboard();
        } else {
            sendInteract(windowId, 'click', { x, y });
        }
        lastTap = now;
        showTouchIndicator(e.clientX, e.clientY);
    });

    newLayer.addEventListener('pointerup', () => clearTimeout(longPressTimer));
    newLayer.addEventListener('pointerleave', () => clearTimeout(longPressTimer));

    newLayer.addEventListener('wheel', (e) => {
        e.preventDefault();
        sendInteract(windowId, 'scroll', { x: 0, y: e.deltaY > 0 ? 300 : -300 });
    }, { passive: false });

    // Свайп влево для скрытия окна (мобильные)
    let touchStartX = 0;
    newLayer.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; });
    newLayer.addEventListener('touchend', (e) => {
        const deltaX = e.changedTouches[0].clientX - touchStartX;
        if (deltaX < -80) toggleVisible(windowId);
    });
}

function setActiveWindow(id) {
    activeWindowId = id;
    document.querySelectorAll('.browser-card').forEach(c => c.classList.remove('active'));
    const card = document.getElementById(`card-${id}`);
    if (card) card.classList.add('active');
}

// ----- API -----
async function sendInteract(windowId, action, params = {}) {
    await fetch('/api/interact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId, action, params })
    });
}

async function createWindow(url) {
    const id = `win_${Date.now()}`;
    await fetch('/api/create-window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId: id, url })
    });
    await refreshStatus();
}

async function closeWindow(id) {
    if (!confirm('Закрыть окно?')) return;
    await fetch('/api/close-window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId: id })
    });
    if (activeWindowId === id) activeWindowId = null;
    await refreshStatus();
}

function toggleVisible(id) {
    windows[id].visible = !windows[id].visible;
    renderGrid();
    if (!windows[id].visible && activeWindowId === id) {
        activeWindowId = windowOrder.find(i => windows[i]?.visible) || null;
    }
}

async function navigateWindow(id) {
    const url = prompt('URL:', windows[id]?.url || 'https://');
    if (url) {
        const formatted = url.startsWith('http') ? url : 'https://' + url;
        windows[id].url = formatted;
        await sendInteract(id, 'navigate', { url: formatted });
        await refreshStatus();
    }
}

async function refreshWindow(id) { await sendInteract(id, 'refresh'); }

// ----- Логи -----
async function showLogs() {
    document.getElementById('logsModal').classList.remove('hidden');
    const container = document.getElementById('logContainer');
    container.innerHTML = 'Загрузка...';
    const res = await fetch('/api/logs');
    const logs = await res.json();
    container.innerHTML = logs.map(l =>
        `[${l.timestamp}] ${l.level.toUpperCase()}: ${l.message}${l.data ? ' | ' + l.data : ''}`
    ).join('\n');
    container.scrollTop = container.scrollHeight;
}

// ----- FPS -----
function updateFps() {
    const now = Date.now();
    const elapsed = (now - fps.lastTime) / 1000;
    const currentFps = Math.round(fps.frames / elapsed);
    fps.frames = 0;
    fps.lastTime = now;
    const el = document.getElementById('fpsCounter');
    if (el) {
        el.textContent = `${currentFps} FPS`;
        el.style.background = currentFps > 20 ? 'var(--green)' : currentFps > 10 ? 'var(--warning)' : 'var(--red)';
    }
}

// ----- Мобильная клавиатура -----
function showMobileKeyboard() {
    document.getElementById('mobileKeyboard').classList.remove('hidden');
    document.getElementById('mobileInput').focus();
}
function hideMobileKeyboard() {
    document.getElementById('mobileKeyboard').classList.add('hidden');
    document.getElementById('mobileInput').value = '';
    activeInput = null;
}
async function sendMobileText() {
    if (!activeInput) return;
    const text = document.getElementById('mobileInput').value;
    await sendInteract(activeInput.windowId, 'type', { x: activeInput.x, y: activeInput.y, text });
    hideMobileKeyboard();
}

// ----- События интерфейса -----
function bindEvents() {
    document.getElementById('btnSidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('visible');
    });
    document.getElementById('closeSidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('visible');
    });
    document.getElementById('btnAddWindowSidebar').addEventListener('click', () => {
        createWindow('https://example.com');
    });

    // Инструменты
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
        const enabled = !windows[activeWindowId].autoScroll;
        await fetch('/api/autoscroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId: currentAccountId, windowId: activeWindowId, enabled })
        });
        windows[activeWindowId].autoScroll = enabled;
        renderGrid();
    });
    document.getElementById('btnType').addEventListener('click', () => {
        if (activeWindowId) {
            activeInput = { windowId: activeWindowId, x: 640, y: 360 };
            showMobileKeyboard();
        }
    });
    document.getElementById('btnScreenshot').addEventListener('click', () => {
        if (activeWindowId) window.open(`/api/screenshot/${currentAccountId}/${activeWindowId}`, '_blank');
    });
    document.getElementById('btnClose').addEventListener('click', () => {
        if (activeWindowId) closeWindow(activeWindowId);
    });

    // Настройки
    document.getElementById('btnSettings').addEventListener('click', () => {
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
            // Закрываем все вебсокеты
            Object.values(wsConnections).forEach(ws => ws.close());
            wsConnections = {};
            canvasContexts = {};
            initApp();
        }
    });
    document.getElementById('accountBadge').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('hidden');
    });

    // Логи
    document.getElementById('btnShowLogs').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.add('hidden');
        showLogs();
    });
    document.getElementById('btnCloseLogs').addEventListener('click', () => {
        document.getElementById('logsModal').classList.add('hidden');
    });

    // Мобильная клавиатура
    document.getElementById('btnSendMobile').addEventListener('click', sendMobileText);
    document.getElementById('btnHideKeyboard').addEventListener('click', hideMobileKeyboard);
}

function showTouchIndicator(x, y) {
    const el = document.createElement('div');
    el.className = 'touch-indicator';
    el.style.left = (x - 10) + 'px';
    el.style.top = (y - 10) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 300);
}

// Горячие клавиши
document.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
    if (!activeWindowId) return;
    if (e.key === 'F5') { e.preventDefault(); refreshWindow(activeWindowId); }
    if (e.key === 'Backspace') { e.preventDefault(); sendInteract(activeWindowId, 'goBack').then(refreshStatus); }
});
