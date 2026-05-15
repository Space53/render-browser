let currentAccountId = '0';
let windows = {};
let windowOrder = [];
let activeWindowId = null;
let activeInput = null;
let fpsCounter = { frames: 0, lastTime: Date.now() };

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    currentAccountId = params.get('id') || '0';
    document.getElementById('currentAccountId').textContent = currentAccountId;
    document.getElementById('accountIdInput').value = currentAccountId;

    initApp();
    bindEvents();
    startFpsMeter();
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
    updateToolbarForActive();
}

// UI рендеринг
function renderGrid() {
    const grid = document.getElementById('browsersGrid');
    const visible = windowOrder.filter(id => windows[id]?.visible !== false);
    const count = visible.length;
    grid.className = 'browsers-grid';
    if (count === 1) grid.classList.add('cols-1');
    else if (count === 2) grid.classList.add('cols-2');
    else grid.classList.add('cols-3');

    let html = '';
    windowOrder.forEach(id => {
        const win = windows[id] || { url: '', autoScroll: false, title: id, visible: true };
        html += `
            <div class="browser-card ${win.visible === false ? 'hidden-card' : ''} ${id === activeWindowId ? 'active-window' : ''}" id="card-${id}" data-window-id="${id}">
                <div class="browser-card-header">
                    <span class="browser-title">${win.title}</span>
                    <span class="browser-url">${win.url}</span>
                    <div class="browser-actions">
                        <button class="icon-btn" onclick="event.stopPropagation(); navigateWindow('${id}')" title="Перейти">🔗</button>
                        <button class="icon-btn" onclick="event.stopPropagation(); refreshWindow('${id}')" title="Обновить">↻</button>
                        <button class="icon-btn ${win.autoScroll ? 'active' : ''}" onclick="event.stopPropagation(); toggleAutoScroll('${id}')" title="Анти-кик">🛡️</button>
                        <button class="icon-btn" onclick="event.stopPropagation(); closeWindow('${id}')" title="Закрыть" style="color:#e94560;">✕</button>
                    </div>
                </div>
                <div class="browser-stream" id="stream-${id}">
                    ${win.visible !== false ? `
                        <img src="/stream/${currentAccountId}/${id}" onload="onFrameLoad()" onerror="this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'" alt="Live" />
                        <div class="interaction-layer" id="layer-${id}"></div>
                    ` : '<div style="color:#888;text-align:center;padding-top:40%;">Скрыто 👁️</div>'}
                </div>
            </div>
        `;
    });

    grid.innerHTML = html || '<div class="loading-center"><p>Нет окон</p></div>';

    // Настройка взаимодействия для видимых слоёв
    windowOrder.forEach(id => {
        if (windows[id]?.visible !== false) {
            setupInteraction(id);
        }
    });

    // Авто-выбор первого окна как активного, если нет активного
    if (!activeWindowId && windowOrder.length > 0) {
        setActiveWindow(windowOrder[0]);
    }
}

function renderSidebar() {
    const windowList = document.getElementById('windowList');
    windowList.innerHTML = windowOrder.map(id => `
        <div class="list-item" data-window-id="${id}" onclick="setActiveWindow('${id}')">
            <span class="title">${windows[id]?.title || id}</span>
            <span class="actions">
                <button class="icon-btn" onclick="event.stopPropagation(); closeWindow('${id}')" style="font-size:14px;">✕</button>
            </span>
        </div>
    `).join('');

    // Закладки из localStorage
    const bookmarks = JSON.parse(localStorage.getItem('lb_bookmarks') || '[]');
    const bookList = document.getElementById('bookmarkList');
    bookList.innerHTML = bookmarks.map((b, idx) => `
        <div class="list-item" onclick="navigateToUrl('${b.url}')">
            <span class="title">${b.title || b.url}</span>
            <span class="actions">
                <button class="icon-btn" onclick="event.stopPropagation(); deleteBookmark(${idx})" style="font-size:14px;">🗑️</button>
            </span>
        </div>
    `).join('');
}

// Взаимодействие с окнами
function setupInteraction(windowId) {
    const layer = document.getElementById(`layer-${windowId}`);
    if (!layer) return;

    // Удаляем старые обработчики клонированием
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

        const now = Date.now();
        longPressTimer = setTimeout(() => {
            // Долгое нажатие → обновить страницу
            refreshWindow(windowId);
        }, 800);

        if (now - lastTap < 300) {
            // Двойное нажатие → ввод текста
            clearTimeout(longPressTimer);
            activeInput = { windowId, x, y };
            showMobileKeyboard();
        } else {
            // Одиночное нажатие → клик
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
}

function setActiveWindow(id) {
    activeWindowId = id;
    // Обновляем подсветку карточки
    document.querySelectorAll('.browser-card').forEach(card => card.classList.remove('active-window'));
    const card = document.getElementById(`card-${id}`);
    if (card) card.classList.add('active-window');
    updateToolbarForActive();
}

function updateToolbarForActive() {
    const toolbar = document.getElementById('toolbar');
    if (!activeWindowId) {
        toolbar.style.opacity = '0.5';
        return;
    }
    toolbar.style.opacity = '1';
}

// API вызовы
async function sendInteract(windowId, action, params = {}) {
    await fetch('/api/interact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId, action, params })
    });
}

async function createWindow(url = 'https://example.com') {
    const id = `win_${Date.now()}`;
    const formatted = url.startsWith('http') ? url : 'https://' + url;
    await fetch('/api/create-window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId: id, url: formatted })
    });
    await refreshStatus();
}

async function closeWindow(id) {
    if (!confirm(`Закрыть окно ${windows[id]?.title || id}?`)) return;
    await fetch('/api/close-window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId: id })
    });
    if (activeWindowId === id) activeWindowId = null;
    await refreshStatus();
}

async function toggleAutoScroll(id) {
    const enabled = !windows[id]?.autoScroll;
    windows[id].autoScroll = enabled;
    await fetch('/api/autoscroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: currentAccountId, windowId: id, enabled })
    });
    renderGrid();
}

async function navigateWindow(id) {
    const url = prompt('Введите URL:', windows[id]?.url || 'https://');
    if (url) {
        const formatted = url.startsWith('http') ? url : 'https://' + url;
        windows[id].url = formatted;
        await sendInteract(id, 'navigate', { url: formatted });
        await refreshStatus();
    }
}

async function refreshWindow(id) { await sendInteract(id, 'refresh'); }

async function goBack() {
    if (activeWindowId) {
        await sendInteract(activeWindowId, 'goBack');
        await refreshStatus();
    }
}
async function goForward() {
    if (activeWindowId) {
        await sendInteract(activeWindowId, 'goForward');
        await refreshStatus();
    }
}

// Работа с текстом
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
    const text = document.getElementById('mobileInput').value;
    if (!activeInput) return;
    await sendInteract(activeInput.windowId, 'type', { x: activeInput.x, y: activeInput.y, text });
    hideMobileKeyboard();
}

// Закладки
function addBookmark() {
    if (!activeWindowId) return;
    const url = windows[activeWindowId]?.url;
    if (!url) return;
    const title = windows[activeWindowId]?.title || url;
    const bookmarks = JSON.parse(localStorage.getItem('lb_bookmarks') || '[]');
    bookmarks.push({ url, title });
    localStorage.setItem('lb_bookmarks', JSON.stringify(bookmarks));
    renderSidebar();
}
function deleteBookmark(index) {
    const bookmarks = JSON.parse(localStorage.getItem('lb_bookmarks') || '[]');
    bookmarks.splice(index, 1);
    localStorage.setItem('lb_bookmarks', JSON.stringify(bookmarks));
    renderSidebar();
}

// Скриншот
async function takeScreenshot() {
    if (!activeWindowId) return;
    window.open(`/api/screenshot/${currentAccountId}/${activeWindowId}`, '_blank');
}

// Верхняя панель URL
function navigateToUrl(url) {
    if (!activeWindowId) {
        createWindow(url);
    } else {
        const formatted = url.startsWith('http') ? url : 'https://' + url;
        windows[activeWindowId].url = formatted;
        sendInteract(activeWindowId, 'navigate', { url: formatted });
        refreshStatus();
    }
}

// Обработчики событий
function bindEvents() {
    // Боковая панель
    document.getElementById('menuToggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('visible');
    });
    document.getElementById('closeSidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('visible');
    });
    document.getElementById('btnAddWindowSidebar').addEventListener('click', () => {
        const url = document.getElementById('urlInput').value || 'https://example.com';
        createWindow(url);
    });

    // URL бар
    document.getElementById('btnGo').addEventListener('click', () => {
        const url = document.getElementById('urlInput').value.trim();
        if (url) navigateToUrl(url);
    });
    document.getElementById('urlInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const url = e.target.value.trim();
            if (url) navigateToUrl(url);
        }
    });
    document.getElementById('btnBookmark').addEventListener('click', addBookmark);

    // Инструменты
    document.getElementById('btnBack').addEventListener('click', goBack);
    document.getElementById('btnForward').addEventListener('click', goForward);
    document.getElementById('btnRefresh').addEventListener('click', () => {
        if (activeWindowId) refreshWindow(activeWindowId);
    });
    document.getElementById('btnScroll').addEventListener('click', () => {
        if (activeWindowId) sendInteract(activeWindowId, 'scroll', { x: 0, y: 300 });
    });
    document.getElementById('btnAutoScroll').addEventListener('click', () => {
        if (activeWindowId) toggleAutoScroll(activeWindowId);
    });
    document.getElementById('btnType').addEventListener('click', () => {
        if (activeWindowId) {
            activeInput = { windowId: activeWindowId, x: 640, y: 360 };
            showMobileKeyboard();
        }
    });
    document.getElementById('btnScreenshot').addEventListener('click', takeScreenshot);
    document.getElementById('btnClose').addEventListener('click', () => {
        if (activeWindowId) closeWindow(activeWindowId);
    });

    // Настройки
    document.getElementById('btnSettings').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('hidden');
        document.getElementById('accountIdInput').value = currentAccountId;
    });
    document.getElementById('btnCloseSettings').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.add('hidden');
    });
    document.getElementById('accountBadge').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('hidden');
    });
    document.getElementById('btnChangeAccount').addEventListener('click', () => {
        const newId = document.getElementById('accountIdInput').value || '0';
        if (newId !== currentAccountId) {
            currentAccountId = newId;
            document.getElementById('currentAccountId').textContent = currentAccountId;
            window.history.pushState({}, '', `?id=${currentAccountId}`);
            document.getElementById('settingsModal').classList.add('hidden');
            initApp();
        }
    });

    // Мобильная клавиатура
    document.getElementById('btnSendMobile').addEventListener('click', sendMobileText);
    document.getElementById('btnHideKeyboard').addEventListener('click', hideMobileKeyboard);

    // Закрытие модалок по клику на фон
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.add('hidden');
        });
    });
}

// FPS счётчик
function onFrameLoad() {
    fpsCounter.frames++;
}
function startFpsMeter() {
    setInterval(() => {
        const now = Date.now();
        const elapsed = (now - fpsCounter.lastTime) / 1000;
        const fps = Math.round(fpsCounter.frames / elapsed);
        fpsCounter.frames = 0;
        fpsCounter.lastTime = now;

        const el = document.getElementById('fpsCounter');
        if (el) {
            el.textContent = `⚡ ${fps} FPS`;
            el.style.background = fps > 20 ? 'var(--green)' : fps > 10 ? 'var(--warning)' : 'var(--red)';
        }
    }, 1000);
}

// Индикатор касания
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
    switch(e.key) {
        case 'F5': e.preventDefault(); refreshWindow(activeWindowId); break;
        case 'Backspace': e.preventDefault(); goBack(); break;
        case 'F2': e.preventDefault();
            activeInput = { windowId: activeWindowId, x: 640, y: 360 };
            showMobileKeyboard();
            break;
    }
});
