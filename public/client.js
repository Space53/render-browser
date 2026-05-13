const socket = io();
let windows = {};
let windowOrder = [];

// ==================== DOM ====================
const browsersGrid = document.getElementById('browsersGrid');
const connectionStatus = document.getElementById('connectionStatus');
const windowsCount = document.getElementById('windowsCount');

// ==================== WEBSOCKET ====================
socket.on('connect', () => {
    console.log('✅ Connected to server');
    connectionStatus.textContent = '🟢 Подключено';
    connectionStatus.className = 'status-badge connected';
});

socket.on('disconnect', () => {
    console.log('❌ Disconnected');
    connectionStatus.textContent = '🔴 Отключено';
    connectionStatus.className = 'status-badge disconnected';
});

// Получение скриншота в реальном времени
socket.on('screenshot', ({ windowId, screenshot, timestamp }) => {
    updateScreenshot(windowId, screenshot);
});

// Статус всех окон при подключении
socket.on('status', ({ windows: serverWindows }) => {
    console.log('📊 Received status:', serverWindows);
    
    serverWindows.forEach(w => {
        windows[w.windowId] = {
            url: w.url,
            autoScroll: w.autoScroll || false,
            clickers: w.clickers || []
        };
        if (!windowOrder.includes(w.windowId)) {
            windowOrder.push(w.windowId);
        }
    });
    
    renderAll();
});

// Окно создано
socket.on('window-created', ({ success, windowId, url, screenshot, error }) => {
    if (success) {
        console.log(`✅ Window created: ${windowId}`);
        windows[windowId] = { url, autoScroll: false, clickers: [] };
        if (!windowOrder.includes(windowId)) {
            windowOrder.push(windowId);
        }
        if (screenshot) updateScreenshot(windowId, screenshot);
        renderAll();
    } else {
        alert(`Ошибка создания окна ${windowId}: ${error}`);
    }
});

// Результат навигации
socket.on('navigate-result', ({ success, windowId, url, screenshot }) => {
    if (success && windows[windowId]) {
        windows[windowId].url = url;
        if (screenshot) updateScreenshot(windowId, screenshot);
        renderAll();
    }
});

// Результат действия
socket.on('action-result', ({ success, windowId, screenshot }) => {
    if (success && screenshot) {
        updateScreenshot(windowId, screenshot);
    }
});

// Изменение автоскролла
socket.on('autoscroll-changed', ({ windowId, enabled }) => {
    if (windows[windowId]) {
        windows[windowId].autoScroll = enabled;
        renderAll();
    }
});

// Кликер добавлен
socket.on('clicker-added', ({ success, clickerId, windowId, type }) => {
    if (success && windows[windowId]) {
        if (!windows[windowId].clickers) windows[windowId].clickers = [];
        windows[windowId].clickers.push({ id: clickerId, type });
        renderAll();
    }
});

// Кликер удален
socket.on('clicker-removed', ({ success, clickerId }) => {
    if (success) {
        Object.values(windows).forEach(w => {
            if (w.clickers) {
                w.clickers = w.clickers.filter(c => c.id !== clickerId);
            }
        });
        renderAll();
    }
});

// ==================== ФУНКЦИИ ====================
function updateScreenshot(windowId, screenshot) {
    const contentEl = document.getElementById(`content-${windowId}`);
    if (contentEl && screenshot) {
        contentEl.innerHTML = `<img src="${screenshot}" alt="${windowId}" loading="lazy" />`;
    }
}

function createNewWindow() {
    const id = `win${Object.keys(windows).length + 1}`;
    const url = prompt('Введите URL:', 'https://example.com');
    if (url) {
        const formattedUrl = formatUrl(url);
        socket.emit('create-window', { windowId: id, url: formattedUrl });
    }
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
    socket.emit('action', { windowId, action: 'refresh' });
}

function scrollWindow(windowId) {
    socket.emit('action', { windowId, action: 'scroll-down' });
}

function clickWindow(windowId) {
    socket.emit('action', { windowId, action: 'click' });
}

function toggleAutoScroll(windowId) {
    const enabled = !windows[windowId]?.autoScroll;
    if (windows[windowId]) windows[windowId].autoScroll = enabled;
    socket.emit('toggle-autoscroll', { windowId, enabled });
    renderAll();
}

function toggleFullscreen(windowId) {
    const card = document.getElementById(`card-${windowId}`);
    if (card) {
        card.classList.toggle('fullscreen');
    }
}

function startAllAutoScroll() {
    windowOrder.forEach(id => {
        if (windows[id]) windows[id].autoScroll = true;
        socket.emit('toggle-autoscroll', { windowId: id, enabled: true });
    });
    renderAll();
}

function stopAllAutoScroll() {
    windowOrder.forEach(id => {
        if (windows[id]) windows[id].autoScroll = false;
        socket.emit('toggle-autoscroll', { windowId: id, enabled: false });
    });
    renderAll();
}

function refreshAll() {
    windowOrder.forEach(id => refreshWindow(id));
}

// ==================== ОТРИСОВКА ====================
function renderAll() {
    const count = windowOrder.length;
    
    // Обновляем счетчик
    windowsCount.textContent = `Окна: ${count}`;
    
    // Обновляем сетку
    browsersGrid.className = 'browsers-grid';
    if (count <= 1) browsersGrid.classList.add('cols-1');
    else if (count === 2) browsersGrid.classList.add('cols-2');
    else if (count === 3) browsersGrid.classList.add('cols-3');
    else browsersGrid.classList.add('cols-4');
    
    // Рендерим карточки
    let html = '';
    
    windowOrder.forEach(id => {
        const win = windows[id] || { url: 'Загрузка...', autoScroll: false, clickers: [] };
        
        html += `
            <div class="browser-card" id="card-${id}">
                <div class="browser-card-header">
                    <span class="browser-title">🖥️ ${id}</span>
                    <span class="browser-url">${win.url || ''}</span>
                    <div class="browser-actions">
                        <button class="btn-sm btn-sm-nav" onclick="navigateWindow('${id}')">🔗 URL</button>
                        <button class="btn-sm btn-sm-refresh" onclick="refreshWindow('${id}')">🔄</button>
                        <button class="btn-sm btn-sm-scroll" onclick="scrollWindow('${id}')">👇</button>
                        <button class="btn-sm" onclick="clickWindow('${id}')">🖱️</button>
                        <button class="btn-sm btn-sm-autoscroll ${win.autoScroll ? 'active' : ''}" 
                                onclick="toggleAutoScroll('${id}')">
                            🛡️ ${win.autoScroll ? 'ON' : 'OFF'}
                        </button>
                        <button class="btn-sm btn-sm-fullscreen" onclick="toggleFullscreen('${id}')">⛶</button>
                    </div>
                </div>
                <div class="browser-content" id="content-${id}" ondblclick="toggleFullscreen('${id}')">
                    <div class="loading">
                        <div class="spinner" style="width:30px;height:30px;"></div>
                        <p style="font-size:12px;">Загрузка браузера...</p>
                    </div>
                </div>
            </div>
        `;
    });
    
    browsersGrid.innerHTML = html || '<div class="loading-screen"><p>Нет активных окон</p></div>';
}

// ==================== УТИЛИТЫ ====================
function formatUrl(url) {
    url = url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    return url;
}

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
console.log('🚀 Sync Browser Pro Client Ready');
console.log('Ожидание создания окон сервером...');
