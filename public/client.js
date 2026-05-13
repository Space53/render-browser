// ==================== КОНФИГУРАЦИЯ ====================
const socket = io();
let currentView = 'grid'; // 'grid' | 'fullscreen'
let fullscreenWindowId = null;
let windows = {}; // { windowId: { url, title, autoScroll, visible } }
let activeClickers = [];

// ==================== DOM ЭЛЕМЕНТЫ ====================
const windowsGrid = document.getElementById('windowsGrid');
const windowsList = document.getElementById('windowsList');
const fullscreenView = document.getElementById('fullscreenView');
const fullscreenContent = document.getElementById('fullscreenContent');
const fullscreenTitle = document.getElementById('fullscreenTitle');
const fullscreenUrlInput = document.getElementById('fullscreenUrlInput');
const clickersList = document.getElementById('clickersList');
const clickerWindowSelect = document.getElementById('clickerWindowSelect');
const currentViewTitle = document.getElementById('currentViewTitle');

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Sync Browser Pro initialized');
    
    // Запрашиваем текущий статус
    socket.emit('request-all-screenshots');
    
    // Создаем окна по умолчанию
    const defaults = [
        { id: 'win1', url: 'https://example.com', title: 'Окно 1' },
        { id: 'win2', url: 'https://google.com', title: 'Окно 2' },
        { id: 'win3', url: 'https://github.com', title: 'Окно 3' }
    ];
    
    defaults.forEach((win, i) => {
        setTimeout(() => createOrShowWindow(win.id, win.url, win.title), i * 1500);
    });
});

// ==================== WEBSOCKET СОБЫТИЯ ====================
socket.on('init-status', (data) => {
    console.log('📊 Init status:', data);
    data.windows.forEach(w => {
        windows[w.windowId] = { ...w, visible: true };
    });
    renderAll();
});

socket.on('window-created', (data) => {
    if (data.success) {
        windows[data.windowId] = { 
            url: data.url, 
            title: `Окно ${data.windowId}`,
            autoScroll: false,
            visible: true 
        };
        updateScreenshot(data.windowId, data.screenshot);
        renderAll();
    }
});

socket.on('screenshot-stream', (data) => {
    updateScreenshot(data.windowId, data.screenshot);
});

socket.on('navigate-done', (data) => {
    if (data.success && windows[data.windowId]) {
        windows[data.windowId].url = data.url;
        updateScreenshot(data.windowId, data.screenshot);
        renderAll();
    }
});

socket.on('windows-status', (data) => {
    if (windows[data.windowId]) {
        windows[data.windowId].url = data.url || windows[data.windowId].url;
        windows[data.windowId].autoScroll = data.autoScroll;
    }
    renderAll();
});

socket.on('action-done', (data) => {
    if (data.success && data.screenshot) {
        updateScreenshot(data.windowId, data.screenshot);
    }
});

socket.on('clicker-added', (data) => {
    if (data.success) {
        activeClickers.push({ id: data.clickerId, windowId: data.windowId, type: data.type });
        renderClickers();
    }
});

socket.on('clicker-removed', (data) => {
    if (data.success) {
        activeClickers = activeClickers.filter(c => c.id !== data.clickerId);
        renderClickers();
    }
});

socket.on('clickers-status', (data) => {
    activeClickers = data;
    renderClickers();
});

// ==================== ФУНКЦИИ ОКОН ====================
function createOrShowWindow(windowId, url, title) {
    if (!windows[windowId]) {
        windows[windowId] = { url, title, autoScroll: false, visible: true };
    }
    
    socket.emit('create-window', { windowId, url });
    renderAll();
}

function navigateWindow(windowId) {
    const url = prompt('Введите URL:', windows[windowId]?.url || 'https://');
    if (url) {
        const formattedUrl = formatUrl(url);
        windows[windowId].url = formattedUrl;
        socket.emit('navigate', { windowId, url: formattedUrl });
        renderAll();
    }
}

function refreshWindow(windowId) {
    socket.emit('execute-action', { windowId, action: 'refresh' });
}

function toggleWindow(windowId) {
    if (windows[windowId]) {
        windows[windowId].visible = !windows[windowId].visible;
        renderAll();
    }
}

function toggleAutoScroll(windowId) {
    if (windows[windowId]) {
        const enabled = !windows[windowId].autoScroll;
        windows[windowId].autoScroll = enabled;
        socket.emit('toggle-auto-scroll', { windowId, enabled });
        renderAll();
    }
}

function openFullscreen(windowId) {
    fullscreenWindowId = windowId;
    fullscreenTitle.textContent = windows[windowId]?.title || windowId;
    fullscreenUrlInput.value = windows[windowId]?.url || '';
    windowsGrid.classList.add('hidden');
    fullscreenView.classList.remove('hidden');
    currentViewTitle.textContent = `📺 ${windows[windowId]?.title || windowId}`;
    
    // Переносим скриншот
    const cardContent = document.getElementById(`content-${windowId}`);
    if (cardContent) {
        fullscreenContent.innerHTML = cardContent.innerHTML;
    }
}

function exitFullscreen() {
    fullscreenWindowId = null;
    windowsGrid.classList.remove('hidden');
    fullscreenView.classList.add('hidden');
    currentViewTitle.textContent = 'Все окна';
}

function navigateFullscreen() {
    if (fullscreenWindowId) {
        const url = formatUrl(fullscreenUrlInput.value);
        windows[fullscreenWindowId].url = url;
        socket.emit('navigate', { windowId: fullscreenWindowId, url });
    }
}

// ==================== МАССОВЫЕ ДЕЙСТВИЯ ====================
function refreshAll() {
    Object.keys(windows).forEach(id => refreshWindow(id));
}

function startAllAutoScroll() {
    Object.keys(windows).forEach(id => {
        windows[id].autoScroll = true;
        socket.emit('toggle-auto-scroll', { windowId: id, enabled: true });
    });
    renderAll();
}

function stopAllAutoScroll() {
    Object.keys(windows).forEach(id => {
        windows[id].autoScroll = false;
        socket.emit('toggle-auto-scroll', { windowId: id, enabled: false });
    });
    renderAll();
}

function addNewWindow() {
    const id = `win${Object.keys(windows).length + 1}`;
    const url = prompt('Введите URL для нового окна:', 'https://example.com');
    if (url) {
        createOrShowWindow(id, formatUrl(url), `Окно ${Object.keys(windows).length + 1}`);
    }
}

// ==================== КЛИКЕРЫ ====================
function addClickerToWindow() {
    const type = document.getElementById('clickerTypeSelect').value;
    const windowId = document.getElementById('clickerWindowSelect').value;
    const interval = parseInt(document.getElementById('clickerInterval').value) || 5000;
    
    socket.emit('add-clicker', { windowId, type, interval });
}

function removeClicker(clickerId) {
    socket.emit('remove-clicker', { clickerId });
}

// ==================== ОТРИСОВКА ====================
function updateScreenshot(windowId, screenshot) {
    if (!screenshot) return;
    
    // Обновляем в сетке
    const contentEl = document.getElementById(`content-${windowId}`);
    if (contentEl) {
        contentEl.innerHTML = `<img src="${screenshot}" alt="${windowId}" />`;
    }
    
    // Обновляем в фулскрине если активно
    if (fullscreenWindowId === windowId) {
        fullscreenContent.innerHTML = `<img src="${screenshot}" alt="${windowId}" />`;
    }
}

function renderAll() {
    renderGrid();
    renderSidebar();
    renderClickers();
    updateGridLayout();
}

function renderGrid() {
    const windowIds = Object.keys(windows);
    let html = '';
    
    windowIds.forEach(id => {
        const win = windows[id];
        if (!win.visible) return;
        
        html += `
            <div class="window-card" id="card-${id}">
                <div class="window-card-header">
                    <span class="window-card-title">${win.title || id}</span>
                    <span class="window-card-url">${win.url || ''}</span>
                    <div class="window-card-actions">
                        <button class="btn-icon" onclick="navigateWindow('${id}')" title="Навигация">🔗</button>
                        <button class="btn-icon" onclick="refreshWindow('${id}')" title="Обновить">🔄</button>
                        <button class="btn-icon" onclick="toggleAutoScroll('${id}')" title="Анти-кик" style="color:${win.autoScroll ? '#00b894' : ''}">🛡️</button>
                        <button class="btn-icon" onclick="openFullscreen('${id}')" title="На весь экран">⛶</button>
                        <button class="btn-icon" onclick="toggleWindow('${id}')" title="Скрыть">👁️</button>
                    </div>
                </div>
                <div class="window-card-content" id="content-${id}">
                    <div class="loading">Загрузка...</div>
                </div>
            </div>
        `;
    });
    
    windowsGrid.innerHTML = html || '<div style="text-align:center;padding:50px;color:#888;">Нет активных окон</div>';
}

function renderSidebar() {
    let html = '';
    
    Object.entries(windows).forEach(([id, win]) => {
        html += `
            <div class="window-item ${win.visible ? 'active' : ''}" onclick="toggleWindow('${id}')">
                <div>
                    <div class="window-item-title">${win.title || id}</div>
                    <div class="window-item-url">${win.url || ''}</div>
                </div>
                <div class="window-item-status ${win.visible ? 'active' : 'inactive'}"></div>
            </div>
        `;
    });
    
    windowsList.innerHTML = html;
    
    // Обновляем селект для кликеров
    clickerWindowSelect.innerHTML = Object.keys(windows).map(id => 
        `<option value="${id}">${windows[id].title || id}</option>`
    ).join('');
}

function renderClickers() {
    clickersList.innerHTML = activeClickers.map(c => `
        <div class="clicker-item">
            <span>${getClickerIcon(c.type)} ${c.type} → ${c.windowId}</span>
            <button class="btn-icon" onclick="removeClicker('${c.id}')">✕</button>
        </div>
    `).join('') || '<div style="color:#888;text-align:center;padding:20px;">Нет активных кликеров</div>';
}

function updateGridLayout() {
    const visibleCount = Object.values(windows).filter(w => w.visible).length;
    windowsGrid.className = 'windows-grid';
    
    if (visibleCount <= 1) windowsGrid.classList.add('grid-1');
    else if (visibleCount === 2) windowsGrid.classList.add('grid-2');
    else if (visibleCount === 3) windowsGrid.classList.add('grid-3');
    else windowsGrid.classList.add('grid-4');
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('collapsed');
}

// ==================== ВСПОМОГАТЕЛЬНЫЕ ====================
function formatUrl(url) {
    url = url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    return url;
}

function getClickerIcon(type) {
    const icons = { click: '🖱️', scroll: '👆', refresh: '🔄', hover: '👉', type: '⌨️' };
    return icons[type] || '🔧';
}

// Периодический запрос скриншотов (каждые 2 секунды)
setInterval(() => {
    socket.emit('request-all-screenshots');
}, 2000);
