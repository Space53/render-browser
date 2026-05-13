const socket = io();
let windows = {};
let windowOrder = [];
let contextMenuWindowId = null;
let inputTarget = null;

// ==================== DOM ====================
const browsersGrid = document.getElementById('browsersGrid');
const connectionStatus = document.getElementById('connectionStatus');
const windowsCount = document.getElementById('windowsCount');
const contextMenu = document.getElementById('contextMenu');
const inputOverlay = document.getElementById('inputOverlay');
const textInput = document.getElementById('textInput');

// ==================== WEBSOCKET ====================
socket.on('connect', () => {
    connectionStatus.textContent = '🟢 Подключено';
    connectionStatus.className = 'status-badge connected';
});

socket.on('disconnect', () => {
    connectionStatus.textContent = '🔴 Отключено';
    connectionStatus.className = 'status-badge disconnected';
});

socket.on('screenshot', ({ windowId, screenshot, dimensions }) => {
    updateScreenshot(windowId, screenshot);
    if (dimensions && windows[windowId]) {
        windows[windowId].dimensions = dimensions;
    }
});

socket.on('status', ({ windows: serverWindows }) => {
    serverWindows.forEach(w => {
        windows[w.windowId] = {
            url: w.url,
            autoScroll: w.autoScroll || false,
            dimensions: w.dimensions
        };
        if (!windowOrder.includes(w.windowId)) {
            windowOrder.push(w.windowId);
        }
    });
    renderAll();
});

socket.on('window-created', ({ success, windowId, url, screenshot, dimensions }) => {
    if (success) {
        windows[windowId] = { url, autoScroll: false, dimensions };
        if (!windowOrder.includes(windowId)) windowOrder.push(windowId);
        if (screenshot) updateScreenshot(windowId, screenshot);
        renderAll();
    }
});

socket.on('interact-result', ({ success, windowId, screenshot, dimensions }) => {
    if (success && screenshot) {
        updateScreenshot(windowId, screenshot);
        if (dimensions && windows[windowId]) {
            windows[windowId].dimensions = dimensions;
        }
    }
});

socket.on('autoscroll-changed', ({ windowId, enabled }) => {
    if (windows[windowId]) {
        windows[windowId].autoScroll = enabled;
        renderAll();
    }
});

// ==================== ИНТЕРАКТИВНЫЕ ФУНКЦИИ ====================
function updateScreenshot(windowId, screenshot) {
    const contentEl = document.getElementById(`content-${windowId}`);
    if (contentEl && screenshot) {
        contentEl.innerHTML = `
            <img src="${screenshot}" alt="${windowId}" />
            <div class="click-overlay" id="overlay-${windowId}"></div>
        `;
        
        // Добавляем обработчики на оверлей
        const overlay = document.getElementById(`overlay-${windowId}`);
        if (overlay) {
            setupInteraction(overlay, windowId);
        }
    }
}

function setupInteraction(overlay, windowId) {
    let lastClickTime = 0;
    
    // ========== КЛИК ==========
    overlay.addEventListener('click', (e) => {
        const rect = overlay.getBoundingClientRect();
        const img = overlay.parentElement.querySelector('img');
        const imgRect = img.getBoundingClientRect();
        
        // Вычисляем координаты относительно картинки
        const scaleX = 1280 / imgRect.width;
        const scaleY = 720 / imgRect.height;
        
        const x = (e.clientX - imgRect.left) * scaleX;
        const y = (e.clientY - imgRect.top) * scaleY;
        
        // Проверяем на двойной клик
        const now = Date.now();
        if (now - lastClickTime < 300) {
            // Двойной клик
            socket.emit('interact', {
                windowId,
                action: 'dblclick',
                params: { x, y }
            });
            showClickIndicator(e.clientX, e.clientY, 'blue');
        } else {
            // Одинарный клик
            socket.emit('interact', {
                windowId,
                action: 'click',
                params: { x, y }
            });
            showClickIndicator(e.clientX, e.clientY, '#6c5ce7');
        }
        lastClickTime = now;
        
        hideContextMenu();
    });
    
    // ========== ПРАВЫЙ КЛИК (КОНТЕКСТНОЕ МЕНЮ) ==========
    overlay.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        contextMenuWindowId = windowId;
        showContextMenu(e.clientX, e.clientY);
    });
    
    // ========== СКРОЛЛ ==========
    overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        socket.emit('interact', {
            windowId,
            action: 'scroll',
            params: { x: 0, y: e.deltaY > 0 ? 200 : -200 }
        });
    });
    
    // ========== ДВИЖЕНИЕ МЫШИ (для ховер-эффектов) ==========
    let moveTimeout;
    overlay.addEventListener('mousemove', (e) => {
        clearTimeout(moveTimeout);
        moveTimeout = setTimeout(() => {
            const img = overlay.parentElement.querySelector('img');
            const imgRect = img.getBoundingClientRect();
            const scaleX = 1280 / imgRect.width;
            const scaleY = 720 / imgRect.height;
            
            socket.emit('interact', {
                windowId,
                action: 'mousemove',
                params: {
                    x: (e.clientX - imgRect.left) * scaleX,
                    y: (e.clientY - imgRect.top) * scaleY
                }
            });
        }, 100);
    });
    
    // ========== ВВОД ТЕКСТА (ДВОЙНОЙ КЛИК + КЛАВИАТУРА) ==========
    overlay.addEventListener('dblclick', (e) => {
        const img = overlay.parentElement.querySelector('img');
        const imgRect = img.getBoundingClientRect();
        const scaleX = 1280 / imgRect.width;
        const scaleY = 720 / imgRect.height;
        
        inputTarget = {
            windowId,
            x: (e.clientX - imgRect.left) * scaleX,
            y: (e.clientY - imgRect.top) * scaleY
        };
        
        showInputOverlay();
    });
}

// ==================== ВИЗУАЛЬНЫЕ ЭФФЕКТЫ ====================
function showClickIndicator(x, y, color) {
    const indicator = document.createElement('div');
    indicator.className = 'click-indicator';
    indicator.style.left = x + 'px';
    indicator.style.top = y + 'px';
    indicator.style.borderColor = color;
    document.body.appendChild(indicator);
    
    setTimeout(() => indicator.remove(), 500);
}

function showContextMenu(x, y) {
    contextMenu.classList.remove('hidden');
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
}

function hideContextMenu() {
    contextMenu.classList.add('hidden');
}

function showInputOverlay() {
    inputOverlay.classList.remove('hidden');
    textInput.value = '';
    textInput.focus();
}

function hideInput() {
    inputOverlay.classList.add('hidden');
    inputTarget = null;
}

function sendText() {
    const text = textInput.value;
    if (!text || !inputTarget) return;
    
    socket.emit('interact', {
        windowId: inputTarget.windowId,
        action: 'type',
        params: {
            x: inputTarget.x,
            y: inputTarget.y,
            text: text
        }
    });
    
    hideInput();
}

// Обработка Enter в поле ввода
document.addEventListener('DOMContentLoaded', () => {
    textInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendText();
        }
    });
    
    // Глобальный клик для скрытия меню
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.context-menu')) {
            hideContextMenu();
        }
    });
    
    // Глобальные клавиши
    document.addEventListener('keydown', (e) => {
        // Если фокус на поле ввода - не обрабатываем
        if (document.activeElement.tagName === 'INPUT') return;
        
        // Отправляем нажатия клавиш в последнее активное окно
        if (windowOrder.length > 0 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const lastWindow = windowOrder[windowOrder.length - 1];
            if (e.key.length === 1 || ['Enter', 'Backspace', 'Delete', 'Tab', 'Escape'].includes(e.key)) {
                socket.emit('interact', {
                    windowId: lastWindow,
                    action: 'keypress',
                    params: { key: e.key }
                });
            }
        }
    });
});

// ==================== КОНТЕКСТНОЕ МЕНЮ ====================
function contextAction(action) {
    if (!contextMenuWindowId) return;
    
    switch(action) {
        case 'navigate':
            const url = prompt('Введите URL:');
            if (url) {
                socket.emit('interact', {
                    windowId: contextMenuWindowId,
                    action: 'navigate',
                    params: { url: formatUrl(url) }
                });
            }
            break;
        case 'refresh':
            socket.emit('interact', {
                windowId: contextMenuWindowId,
                action: 'refresh',
                params: {}
            });
            break;
        case 'back':
            socket.emit('interact', {
                windowId: contextMenuWindowId,
                action: 'back',
                params: {}
            });
            break;
        case 'forward':
            socket.emit('interact', {
                windowId: contextMenuWindowId,
                action: 'forward',
                params: {}
            });
            break;
        case 'scroll-top':
            socket.emit('interact', {
                windowId: contextMenuWindowId,
                action: 'scroll',
                params: { x: 0, y: -99999 }
            });
            break;
        case 'scroll-bottom':
            socket.emit('interact', {
                windowId: contextMenuWindowId,
                action: 'scroll',
                params: { x: 0, y: 99999 }
            });
            break;
    }
    
    hideContextMenu();
}

// ==================== ОТРИСОВКА ====================
function renderAll() {
    const count = windowOrder.length;
    windowsCount.textContent = `Окна: ${count}`;
    
    browsersGrid.className = 'browsers-grid';
    if (count <= 1) browsersGrid.classList.add('cols-1');
    else if (count === 2) browsersGrid.classList.add('cols-2');
    else if (count === 3) browsersGrid.classList.add('cols-3');
    else browsersGrid.classList.add('cols-4');
    
    let html = '';
    windowOrder.forEach(id => {
        const win = windows[id] || { url: 'Загрузка...', autoScroll: false };
        html += `
            <div class="browser-card" id="card-${id}">
                <div class="browser-card-header">
                    <span class="browser-title">🖥️ ${id}</span>
                    <span class="browser-url">${win.url || ''}</span>
                    <div class="browser-actions">
                        <button class="btn-xs" onclick="navigatePrompt('${id}')">🔗</button>
                        <button class="btn-xs" onclick="refreshWindow('${id}')">🔄</button>
                        <button class="btn-xs ${win.autoScroll ? 'active' : ''}" 
                                onclick="toggleAutoScroll('${id}')">🛡️</button>
                    </div>
                </div>
                <div class="browser-content" id="content-${id}">
                    <div class="loading-screen">
                        <div class="spinner" style="width:25px;height:25px;"></div>
                        <p style="font-size:11px;">Загрузка...</p>
                    </div>
                </div>
            </div>
        `;
    });
    
    browsersGrid.innerHTML = html || '<div class="loading-screen"><p>Нет окон</p></div>';
}

// ==================== ФУНКЦИИ УПРАВЛЕНИЯ ====================
function createNewWindow() {
    const id = `win${Object.keys(windows).length + 1}`;
    const url = prompt('URL:', 'https://example.com');
    if (url) socket.emit('create-window', { windowId: id, url: formatUrl(url) });
}

function navigatePrompt(windowId) {
    const url = prompt('URL:', windows[windowId]?.url || 'https://');
    if (url) {
        socket.emit('interact', {
            windowId,
            action: 'navigate',
            params: { url: formatUrl(url) }
        });
    }
}

function refreshWindow(windowId) {
    socket.emit('interact', { windowId, action: 'refresh', params: {} });
}

function toggleAutoScroll(windowId) {
    const enabled = !windows[windowId]?.autoScroll;
    if (windows[windowId]) windows[windowId].autoScroll = enabled;
    socket.emit('toggle-autoscroll', { windowId, enabled });
    renderAll();
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

function formatUrl(url) {
    url = url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    return url;
}

console.log('🖱️ Interactive Browser Ready - Click, scroll, type on websites!');
