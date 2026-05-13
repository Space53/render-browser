let windows = {}; // { windowId: { url, autoScroll, visible } }
let windowOrder = [];
let activeInput = null;

// FPS счетчик
let frameCount = 0;
let lastFpsTime = Date.now();
let currentFPS = 0;

setInterval(() => {
    const now = Date.now();
    const elapsed = (now - lastFpsTime) / 1000;
    currentFPS = Math.round(frameCount / elapsed);
    frameCount = 0;
    lastFpsTime = now;
    
    const el = document.getElementById('fpsCounter');
    if (el) {
        el.textContent = `⚡ ${currentFPS} FPS`;
        el.style.background = currentFPS > 15 ? 'var(--green)' : 
                              currentFPS > 8 ? '#fdcb6e' : 'var(--red)';
    }
}, 1000);

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
async function init() {
    const res = await fetch('/api/status');
    const data = await res.json();
    
    data.windows.forEach(w => {
        windows[w.windowId] = { 
            url: w.url, 
            autoScroll: w.autoScroll || false,
            visible: true 
        };
        if (!windowOrder.includes(w.windowId)) {
            windowOrder.push(w.windowId);
        }
    });
    
    renderAll();
}

// ==================== ОТРИСОВКА ====================
function renderAll() {
    const grid = document.getElementById('browsersGrid');
    const visibleWindows = windowOrder.filter(id => windows[id]?.visible !== false);
    const count = visibleWindows.length;
    
    document.getElementById('windowsCount').textContent = `Окна: ${count}`;
    
    grid.className = 'browsers-grid';
    if (count <= 1) grid.classList.add('cols-1');
    else if (count === 2) grid.classList.add('cols-2');
    else grid.classList.add('cols-3');
    
    let html = '';
    windowOrder.forEach(id => {
        const win = windows[id] || { url: '', autoScroll: false, visible: true };
        
        html += `
            <div class="browser-card ${win.visible === false ? 'hidden-card' : ''}" id="card-${id}">
                <div class="browser-card-header">
                    <span class="browser-title">🖥️ ${id}</span>
                    <span class="browser-url">${win.url || ''}</span>
                    <div class="browser-actions">
                        <button class="btn-sm" onclick="navigatePrompt('${id}')" title="URL">🔗</button>
                        <button class="btn-sm" onclick="refreshWindow('${id}')" title="Обновить">🔄</button>
                        <button class="btn-sm" onclick="scrollWindow('${id}')" title="Скролл">👇</button>
                        <button class="btn-sm ${win.autoScroll ? 'autoscroll-active' : ''}" 
                                onclick="toggleAutoScroll('${id}')" title="Анти-кик">🛡️</button>
                        <button class="btn-sm" onclick="toggleVisible('${id}')" title="Скрыть">👁️</button>
                        <button class="btn-sm" onclick="closeWindow('${id}')" title="Закрыть" style="color:#e94560;">✕</button>
                    </div>
                </div>
                <div class="browser-stream" id="stream-${id}">
                    ${win.visible !== false ? `
                        <img src="/stream/${id}" onload="frameCount++" alt="Live" />
                        <div class="interaction-layer" id="layer-${id}"></div>
                    ` : '<div style="color:#888;text-align:center;padding-top:40%;">Скрыто</div>'}
                </div>
            </div>
        `;
    });
    
    grid.innerHTML = html || '<div class="loading-center"><p>Нет окон</p></div>';
    
    // Настройка взаимодействия
    windowOrder.forEach(id => {
        if (windows[id]?.visible !== false) {
            setTimeout(() => setupInteraction(id), 300);
        }
    });
}

// ==================== ВЗАИМОДЕЙСТВИЕ ====================
function setupInteraction(windowId) {
    const layer = document.getElementById(`layer-${windowId}`);
    if (!layer) return;
    
    // Очищаем старые обработчики
    const newLayer = layer.cloneNode(true);
    layer.parentNode.replaceChild(newLayer, layer);
    
    let lastTap = 0;
    let longPressTimer;
    
    // Клик/тап
    newLayer.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const rect = newLayer.getBoundingClientRect();
        const scaleX = 1280 / rect.width;
        const scaleY = 720 / rect.height;
        const x = Math.round((e.clientX - rect.left) * scaleX);
        const y = Math.round((e.clientY - rect.top) * scaleY);
        
        const now = Date.now();
        
        // Долгое нажатие = обновление
        longPressTimer = setTimeout(() => {
            sendInteract(windowId, 'refresh', {});
        }, 800);
        
        if (now - lastTap < 300) {
            // Двойной тап = ввод текста
            clearTimeout(longPressTimer);
            activeInput = { windowId, x, y };
            showKeyboard();
        } else {
            // Одинарный тап = клик
            sendInteract(windowId, 'click', { x, y });
        }
        
        lastTap = now;
        showIndicator(e.clientX, e.clientY);
    });
    
    newLayer.addEventListener('pointerup', () => clearTimeout(longPressTimer));
    newLayer.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
    
    // Скролл колесом
    newLayer.addEventListener('wheel', (e) => {
        e.preventDefault();
        sendInteract(windowId, 'scroll', { x: 0, y: e.deltaY > 0 ? 300 : -300 });
    }, { passive: false });
    
    // Свайп на телефоне
    let touchStartY = 0;
    newLayer.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
    }, { passive: true });
    
    newLayer.addEventListener('touchend', (e) => {
        const diff = touchStartY - e.changedTouches[0].clientY;
        if (Math.abs(diff) > 40) {
            sendInteract(windowId, 'scroll', { x: 0, y: diff > 0 ? 400 : -400 });
        }
    });
}

// ==================== ОТПРАВКА ДЕЙСТВИЙ ====================
async function sendInteract(windowId, action, params = {}) {
    try {
        await fetch('/api/interact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowId, action, params })
        });
    } catch(e) {
        console.error('Error:', e);
    }
}

// ==================== ФУНКЦИИ УПРАВЛЕНИЯ ====================
async function createNewWindow() {
    const id = `win${Date.now()}`;
    const url = prompt('URL:', 'https://example.com') || 'https://example.com';
    
    const res = await fetch('/api/create-window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: id, url })
    });
    
    const data = await res.json();
    if (data.success) {
        windows[id] = { url, autoScroll: false, visible: true };
        windowOrder.push(id);
        renderAll();
    }
}

function navigatePrompt(windowId) {
    const url = prompt('Новый URL:', windows[windowId]?.url || 'https://');
    if (url) {
        const formatted = url.startsWith('http') ? url : 'https://' + url;
        windows[windowId].url = formatted;
        sendInteract(windowId, 'navigate', { url: formatted });
        renderAll();
    }
}

function refreshWindow(windowId) {
    sendInteract(windowId, 'refresh', {});
}

function scrollWindow(windowId) {
    sendInteract(windowId, 'scroll-down', {});
}

async function toggleAutoScroll(windowId) {
    const enabled = !windows[windowId]?.autoScroll;
    if (windows[windowId]) windows[windowId].autoScroll = enabled;
    
    await fetch('/api/autoscroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId, enabled })
    });
    
    renderAll();
}

function toggleVisible(windowId) {
    if (windows[windowId]) {
        windows[windowId].visible = windows[windowId].visible === false ? true : false;
        renderAll();
    }
}

async function closeWindow(windowId) {
    if (!confirm(`Закрыть ${windowId}?`)) return;
    
    await fetch('/api/close-window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId })
    });
    
    delete windows[windowId];
    windowOrder = windowOrder.filter(id => id !== windowId);
    renderAll();
}

async function startAllAutoScroll() {
    for (const id of windowOrder) {
        windows[id].autoScroll = true;
        await fetch('/api/autoscroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowId: id, enabled: true })
        });
    }
    renderAll();
}

async function stopAllAutoScroll() {
    for (const id of windowOrder) {
        windows[id].autoScroll = false;
        await fetch('/api/autoscroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowId: id, enabled: false })
        });
    }
    renderAll();
}

function refreshAll() {
    windowOrder.forEach(id => refreshWindow(id));
}

// ==================== КЛАВИАТУРА ====================
function showKeyboard() {
    document.getElementById('mobileKeyboard').classList.remove('hidden');
    document.getElementById('mobileInput').focus();
}

function hideKeyboard() {
    document.getElementById('mobileKeyboard').classList.add('hidden');
    document.getElementById('mobileInput').value = '';
    activeInput = null;
}

function sendMobileText() {
    const text = document.getElementById('mobileInput').value;
    if (!text || !activeInput) return;
    
    sendInteract(activeInput.windowId, 'type', {
        x: activeInput.x,
        y: activeInput.y,
        text: text
    });
    
    hideKeyboard();
}

// ==================== ИНДИКАТОР ====================
function showIndicator(x, y) {
    const el = document.createElement('div');
    el.className = 'touch-indicator';
    el.style.left = (x - 12) + 'px';
    el.style.top = (y - 12) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 350);
}

// ==================== ГОРЯЧИЕ КЛАВИШИ ====================
document.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;
    if (windowOrder.length === 0) return;
    
    const last = windowOrder[windowOrder.length - 1];
    
    if (e.key === 'F5') {
        e.preventDefault();
        refreshWindow(last);
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const scrollMap = {
            ArrowUp: 'scroll-up',
            ArrowDown: 'scroll-down',
            ArrowLeft: 'scroll-up',
            ArrowRight: 'scroll-down'
        };
        sendInteract(last, scrollMap[e.key], {});
    }
});

// Старт
init();
