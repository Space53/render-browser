let windows = {};
let windowOrder = [];
let activeInputTarget = null;

// ==================== ЗАГРУЗКА ====================
async function init() {
    // Получаем статус
    const statusRes = await fetch('/api/status');
    const status = await statusRes.json();
    
    status.windows.forEach(w => {
        windows[w.windowId] = { url: w.url };
        if (!windowOrder.includes(w.windowId)) {
            windowOrder.push(w.windowId);
        }
    });
    
    renderAll();
}

// ==================== ОТРИСОВКА ====================
function renderAll() {
    const grid = document.getElementById('browsersGrid');
    const count = windowOrder.length;
    
    document.getElementById('windowsCount').textContent = `Окна: ${count}`;
    
    grid.className = 'browsers-grid';
    if (count <= 1) grid.classList.add('cols-1');
    else if (count === 2) grid.classList.add('cols-2');
    else grid.classList.add('cols-3');
    
    let html = '';
    windowOrder.forEach(id => {
        const win = windows[id] || { url: '' };
        html += `
            <div class="browser-card" id="card-${id}">
                <div class="browser-card-header">
                    <span>🖥️ ${id}</span>
                    <span class="browser-url">${win.url || ''}</span>
                    <button class="btn" onclick="navigatePrompt('${id}')" style="padding:2px 6px;font-size:10px;">🔗</button>
                </div>
                <div class="browser-stream" id="stream-${id}">
                    <img src="/stream/${id}" alt="Live" />
                    <div class="interaction-layer" id="layer-${id}"></div>
                </div>
            </div>
        `;
    });
    
    grid.innerHTML = html || '<div class="loading-screen"><p>Нет окон</p></div>';
    
    // Настраиваем взаимодействие для каждого окна
    windowOrder.forEach(id => {
        setTimeout(() => setupInteraction(id), 500);
    });
}

// ==================== ВЗАИМОДЕЙСТВИЕ ====================
function setupInteraction(windowId) {
    const layer = document.getElementById(`layer-${windowId}`);
    if (!layer) return;
    
    let lastTap = 0;
    
    // Обработка касаний/кликов
    layer.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const rect = layer.getBoundingClientRect();
        const scaleX = 1280 / rect.width;
        const scaleY = 720 / rect.height;
        
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        
        const now = Date.now();
        
        if (now - lastTap < 300) {
            // Двойной тап = ввод текста
            activeInputTarget = { windowId, x, y };
            showMobileKeyboard();
        } else {
            // Одинарный тап = клик
            sendInteract(windowId, 'click', { x, y });
        }
        
        lastTap = now;
        showTouchIndicator(e.clientX, e.clientY);
    });
    
    // Долгое нажатие = правый клик (обновление)
    let longPressTimer;
    layer.addEventListener('pointerdown', (e) => {
        longPressTimer = setTimeout(() => {
            sendInteract(windowId, 'refresh', {});
        }, 800);
    });
    
    layer.addEventListener('pointerup', () => {
        clearTimeout(longPressTimer);
    });
    layer.addEventListener('pointerleave', () => {
        clearTimeout(longPressTimer);
    });
    
    // Скролл
    layer.addEventListener('wheel', (e) => {
        e.preventDefault();
        sendInteract(windowId, 'scroll', { x: 0, y: e.deltaY > 0 ? 300 : -300 });
    }, { passive: false });
    
    // Свайп на телефоне
    let touchStartY = 0;
    layer.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
    }, { passive: true });
    
    layer.addEventListener('touchend', (e) => {
        const diff = touchStartY - e.changedTouches[0].clientY;
        if (Math.abs(diff) > 50) {
            sendInteract(windowId, 'scroll', { x: 0, y: diff > 0 ? 400 : -400 });
        }
    });
}

// ==================== ОТПРАВКА ДЕЙСТВИЯ ====================
async function sendInteract(windowId, action, params = {}) {
    try {
        await fetch('/api/interact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowId, action, params })
        });
    } catch (e) {
        console.error('Interact error:', e);
    }
}

// ==================== ВИЗУАЛЬНЫЕ ЭФФЕКТЫ ====================
function showTouchIndicator(x, y) {
    const el = document.createElement('div');
    el.className = 'touch-indicator';
    el.style.left = (x - 15) + 'px';
    el.style.top = (y - 15) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 400);
}

// ==================== МОБИЛЬНАЯ КЛАВИАТУРА ====================
function showMobileKeyboard() {
    document.getElementById('mobileKeyboard').classList.remove('hidden');
    document.getElementById('mobileInput').focus();
}

function hideMobileKeyboard() {
    document.getElementById('mobileKeyboard').classList.add('hidden');
    document.getElementById('mobileInput').value = '';
    activeInputTarget = null;
}

function sendMobileText() {
    const text = document.getElementById('mobileInput').value;
    if (!text || !activeInputTarget) return;
    
    sendInteract(activeInputTarget.windowId, 'type', {
        x: activeInputTarget.x,
        y: activeInputTarget.y,
        text: text
    });
    
    hideMobileKeyboard();
}

// ==================== УПРАВЛЕНИЕ ====================
async function createNewWindow() {
    const id = `win${windowOrder.length + 1}`;
    const url = prompt('URL:', 'https://example.com') || 'https://example.com';
    
    const res = await fetch('/api/create-window', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: id, url })
    });
    
    const data = await res.json();
    if (data.success) {
        windows[id] = { url };
        windowOrder.push(id);
        renderAll();
    }
}

async function navigatePrompt(windowId) {
    const url = prompt('URL:', windows[windowId]?.url || 'https://');
    if (url) {
        windows[windowId].url = url;
        await sendInteract(windowId, 'navigate', { url });
        renderAll();
    }
}

// ==================== ГОРЯЧИЕ КЛАВИШИ ====================
document.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;
    if (windowOrder.length === 0) return;
    
    const lastWindow = windowOrder[windowOrder.length - 1];
    
    if (e.key === 'F5') {
        e.preventDefault();
        sendInteract(lastWindow, 'refresh', {});
    } else if (e.key.length === 1 || ['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        sendInteract(lastWindow, 'keypress', { key: e.key });
    }
});

// Старт
init();
console.log('🚀 Live Browser Ready - 30 FPS Streaming');
