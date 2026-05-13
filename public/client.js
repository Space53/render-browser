// Подключение к серверу
const socket = io();

// Конфигурация
const WINDOWS = ['win1', 'win2', 'win3'];
let autoScrollActive = false;
let activeClickers = new Map();
let windowsReady = new Set();

// DOM элементы
const urlInput = document.getElementById('urlInput');
const btnNavigate = document.getElementById('btnNavigate');
const btnSync = document.getElementById('btnSync');
const btnStartScroll = document.getElementById('btnStartScroll');
const btnStopScroll = document.getElementById('btnStopScroll');
const btnAddClicker = document.getElementById('btnAddClicker');
const btnAddScroller = document.getElementById('btnAddScroller');
const btnAddRefresher = document.getElementById('btnAddRefresher');
const btnAddHover = document.getElementById('btnAddHover');
const btnAddTyper = document.getElementById('btnAddTyper');
const activeClickersContainer = document.getElementById('activeClickers');
const statusText = document.getElementById('statusText');
const windowsCount = document.getElementById('windowsCount');
const clickersCount = document.getElementById('clickersCount');
const autoScrollStatus = document.getElementById('autoScrollStatus');

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Initializing Real Browser...');
    
    // Создаем все окна браузера
    const initialUrl = urlInput.value || 'https://example.com';
    
    WINDOWS.forEach((windowId, index) => {
        setTimeout(() => {
            createBrowserWindow(windowId, initialUrl);
        }, index * 2000); // Задержка чтобы не перегружать сервер
    });
    
    // Запускаем периодическое обновление скриншотов
    setInterval(requestAllScreenshots, 5000);
    
    // Обновляем статус
    updateStatus();
});

// Обработчики событий кнопок
btnNavigate.addEventListener('click', () => {
    const url = formatUrl(urlInput.value);
    navigateAllWindows(url);
});

btnSync.addEventListener('click', () => {
    const url = formatUrl(urlInput.value);
    navigateAllWindows(url);
});

urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const url = formatUrl(urlInput.value);
        navigateAllWindows(url);
    }
});

btnStartScroll.addEventListener('click', startAutoScroll);
btnStopScroll.addEventListener('click', stopAutoScroll);

btnAddClicker.addEventListener('click', () => addClicker('click'));
btnAddScroller.addEventListener('click', () => addClicker('scroll'));
btnAddRefresher.addEventListener('click', () => addClicker('refresh'));
btnAddHover.addEventListener('click', () => addClicker('hover'));
btnAddTyper.addEventListener('click', () => addClicker('type'));

// WebSocket события
socket.on('connect', () => {
    console.log('✅ Connected to server');
    statusText.textContent = '🟢 Подключено к серверу';
});

socket.on('disconnect', () => {
    console.log('❌ Disconnected from server');
    statusText.textContent = '🔴 Соединение потеряно';
});

socket.on('window-created', (data) => {
    if (data.success) {
        console.log(`✅ Window ${data.windowId} created`);
        windowsReady.add(data.windowId);
        updateWindowsCount();
    } else {
        console.error(`❌ Failed to create window: ${data.error}`);
        showWindowError(data.windowId);
    }
});

socket.on('screenshot-update', (data) => {
    updateBrowserScreenshot(data.windowId, data.screenshot);
});

socket.on('navigate-complete', (data) => {
    if (data.success) {
        console.log(`✅ Navigation complete for ${data.windowId}`);
    } else {
        console.error(`❌ Navigation failed: ${data.error}`);
    }
});

socket.on('navigate-all-complete', (data) => {
    if (data.success) {
        statusText.textContent = '🟢 Навигация выполнена';
    }
});

socket.on('action-complete', (data) => {
    if (data.success) {
        console.log(`✅ Action ${data.action} completed on ${data.windowId}`);
    }
});

socket.on('auto-scroll-started', (data) => {
    if (data.success) {
        autoScrollActive = true;
        btnStartScroll.disabled = true;
        btnStopScroll.disabled = false;
        autoScrollStatus.textContent = 'Анти-кик: вкл';
        statusText.textContent = '🛡️ Анти-кик активирован';
    }
});

socket.on('auto-scroll-stopped', (data) => {
    if (data.success) {
        autoScrollActive = false;
        btnStartScroll.disabled = false;
        btnStopScroll.disabled = true;
        autoScrollStatus.textContent = 'Анти-кик: выкл';
        statusText.textContent = '🟢 Анти-кик остановлен';
    }
});

socket.on('clicker-added', (data) => {
    if (data.success) {
        addClickerBadge(data.clickerId, data.type);
        updateClickersCount();
    }
});

socket.on('clicker-removed', (data) => {
    if (data.success) {
        removeClickerBadge(data.clickerId);
        updateClickersCount();
    }
});

// Функции для работы с браузером
async function createBrowserWindow(windowId, url) {
    console.log(`Creating browser window: ${windowId}`);
    
    const contentDiv = document.getElementById(`content-${windowId}`);
    contentDiv.innerHTML = `
        <div class="loading">
            <div class="loading-spinner"></div>
            <p>Запуск браузера...</p>
        </div>
    `;
    
    socket.emit('create-window', {
        windowId: windowId,
        url: formatUrl(url)
    });
}

async function navigateAllWindows(url) {
    url = formatUrl(url);
    urlInput.value = url;
    
    console.log(`Navigating all windows to: ${url}`);
    
    WINDOWS.forEach(windowId => {
        const contentDiv = document.getElementById(`content-${windowId}`);
        contentDiv.innerHTML = `
            <div class="loading">
                <div class="loading-spinner"></div>
                <p>Загрузка ${url}...</p>
            </div>
        `;
    });
    
    socket.emit('navigate-all', {
        url: url,
        windowIds: WINDOWS
    });
}

async function refreshWindow(windowId) {
    console.log(`Refreshing window: ${windowId}`);
    
    socket.emit('execute-action', {
        windowId: windowId,
        action: 'refresh'
    });
}

async function scrollWindow(windowId) {
    console.log(`Scrolling window: ${windowId}`);
    
    socket.emit('execute-action', {
        windowId: windowId,
        action: 'scroll-down'
    });
}

async function startAutoScroll() {
    console.log('Starting auto-scroll');
    
    socket.emit('start-auto-scroll', {
        windowIds: WINDOWS
    });
}

async function stopAutoScroll() {
    console.log('Stopping auto-scroll');
    
    socket.emit('stop-auto-scroll');
}

async function addClicker(type) {
    console.log(`Adding clicker: ${type}`);
    
    socket.emit('add-clicker', {
        windowIds: WINDOWS,
        type: type,
        interval: 5000
    });
}

async function removeClicker(clickerId) {
    console.log(`Removing clicker: ${clickerId}`);
    
    socket.emit('remove-clicker', {
        clickerId: clickerId
    });
}

// Функции обновления UI
function updateBrowserScreenshot(windowId, screenshot) {
    const contentDiv = document.getElementById(`content-${windowId}`);
    
    if (contentDiv && screenshot) {
        contentDiv.innerHTML = `
            <img src="${screenshot}" alt="Browser ${windowId}" />
        `;
        windowsReady.add(windowId);
        updateWindowsCount();
    }
}

function showWindowError(windowId) {
    const contentDiv = document.getElementById(`content-${windowId}`);
    
    if (contentDiv) {
        contentDiv.innerHTML = `
            <div class="loading">
                <p style="color: #e94560;">❌ Ошибка загрузки окна</p>
                <button class="btn btn-danger" onclick="createBrowserWindow('${windowId}', urlInput.value)">
                    Повторить
                </button>
            </div>
        `;
    }
}

function addClickerBadge(clickerId, type) {
    const badge = document.createElement('span');
    badge.className = 'clicker-badge';
    badge.id = `clicker-${clickerId}`;
    
    const icons = {
        click: '🖱️',
        scroll: '👆',
        refresh: '🔄',
        hover: '👆',
        type: '⌨️'
    };
    
    badge.innerHTML = `
        ${icons[type] || '🔧'} ${type}
        <span class="remove-clicker" onclick="removeClicker('${clickerId}')">×</span>
    `;
    
    activeClickersContainer.appendChild(badge);
    activeClickers.set(clickerId, type);
}

function removeClickerBadge(clickerId) {
    const badge = document.getElementById(`clicker-${clickerId}`);
    if (badge) {
        badge.remove();
    }
    activeClickers.delete(clickerId);
}

function updateWindowsCount() {
    windowsCount.textContent = `Окна: ${windowsReady.size}/${WINDOWS.length}`;
}

function updateClickersCount() {
    clickersCount.textContent = `Кликеры: ${activeClickers.size}`;
}

function updateStatus() {
    updateWindowsCount();
    updateClickersCount();
    
    setInterval(() => {
        socket.emit('get-status');
    }, 10000);
}

async function requestAllScreenshots() {
    socket.emit('get-all-screenshots');
}

// Вспомогательные функции
function formatUrl(url) {
    url = url.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    return url;
}
