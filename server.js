const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8,
    pingTimeout: 120000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Хранилища
const browsers = new Map();
const streams = new Map();
const autoScrolls = new Map();
const clickers = new Map();

// Запуск браузера
async function launchBrowser() {
    return await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--window-size=1280,720'
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
}

// Создание окна
async function createWindow(windowId, url) {
    try {
        if (browsers.has(windowId)) {
            await browsers.get(windowId).browser.close().catch(() => {});
            browsers.delete(windowId);
        }
        
        const browser = await launchBrowser();
        const page = await browser.newPage();
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        browsers.set(windowId, { browser, page, url, createdAt: Date.now() });
        return true;
    } catch (error) {
        console.error(`Create window error: ${error.message}`);
        return false;
    }
}

// Скриншот
async function takeScreenshot(windowId) {
    const data = browsers.get(windowId);
    if (!data) return null;
    try {
        const buffer = await data.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 40 });
        return `data:image/jpeg;base64,${buffer}`;
    } catch (e) {
        return null;
    }
}

// Стрим скриншотов
function startStreaming(windowId) {
    stopStreaming(windowId);
    const interval = setInterval(async () => {
        const screenshot = await takeScreenshot(windowId);
        if (screenshot) {
            io.emit('screenshot', { windowId, screenshot, timestamp: Date.now() });
        }
    }, 500);
    streams.set(windowId, interval);
}

function stopStreaming(windowId) {
    if (streams.has(windowId)) {
        clearInterval(streams.get(windowId));
        streams.delete(windowId);
    }
}

// Автоскролл
function startAutoScroll(windowId) {
    stopAutoScroll(windowId);
    const interval = setInterval(async () => {
        const data = browsers.get(windowId);
        if (!data) return;
        try {
            await data.page.evaluate(() => {
                const h = document.documentElement.scrollHeight;
                const s = window.pageYOffset;
                if (s + window.innerHeight >= h - 10) {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                } else {
                    window.scrollBy({ top: 200, behavior: 'smooth' });
                }
            });
        } catch (e) {}
    }, 3000);
    autoScrolls.set(windowId, interval);
}

function stopAutoScroll(windowId) {
    if (autoScrolls.has(windowId)) {
        clearInterval(autoScrolls.get(windowId));
        autoScrolls.delete(windowId);
    }
}

// Кликер
function addClicker(windowId, type, intervalMs = 5000) {
    const id = `${windowId}_${Date.now()}`;
    const timer = setInterval(async () => {
        const data = browsers.get(windowId);
        if (!data) return;
        try {
            switch(type) {
                case 'click':
                    await data.page.evaluate(() => {
                        const els = document.querySelectorAll('a, button, [onclick]');
                        if (els.length) els[Math.floor(Math.random() * els.length)].click();
                    });
                    break;
                case 'scroll':
                    await data.page.evaluate(() => window.scrollBy(0, 200));
                    break;
                case 'refresh':
                    await data.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    break;
            }
        } catch (e) {}
    }, intervalMs);
    clickers.set(id, { timer, type, windowId });
    return id;
}

function removeClicker(id) {
    if (clickers.has(id)) {
        clearInterval(clickers.get(id).timer);
        clickers.delete(id);
        return true;
    }
    return false;
}

// WebSocket
io.on('connection', async (socket) => {
    console.log('Client connected:', socket.id);
    
    // Отправляем статус
    const status = [];
    for (const [id, data] of browsers) {
        status.push({
            windowId: id,
            url: data.url,
            autoScroll: autoScrolls.has(id)
        });
    }
    socket.emit('status', { windows: status });
    
    // Стримим существующие окна
    for (const [id] of browsers) {
        startStreaming(id);
        const screenshot = await takeScreenshot(id);
        if (screenshot) {
            socket.emit('screenshot', { windowId: id, screenshot, timestamp: Date.now() });
        }
    }
    
    // Создать окно
    socket.on('create-window', async ({ windowId, url }) => {
        const success = await createWindow(windowId, url);
        if (success) {
            startStreaming(windowId);
            const screenshot = await takeScreenshot(windowId);
            io.emit('window-created', { success: true, windowId, url, screenshot });
        } else {
            socket.emit('window-created', { success: false, windowId, error: 'Failed to create' });
        }
    });
    
    // Навигация
    socket.on('navigate', async ({ windowId, url }) => {
        let data = browsers.get(windowId);
        if (!data) {
            const success = await createWindow(windowId, url);
            if (success) {
                startStreaming(windowId);
                data = browsers.get(windowId);
            } else {
                socket.emit('navigate-result', { success: false, windowId, error: 'Failed' });
                return;
            }
        }
        try {
            await data.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            data.url = url;
            const screenshot = await takeScreenshot(windowId);
            io.emit('navigate-result', { success: true, windowId, url, screenshot });
        } catch (e) {
            socket.emit('navigate-result', { success: false, windowId, error: e.message });
        }
    });
    
    // Действие
    socket.on('action', async ({ windowId, action }) => {
        const data = browsers.get(windowId);
        if (!data) {
            socket.emit('action-result', { success: false, windowId, error: 'Not found' });
            return;
        }
        try {
            switch(action) {
                case 'refresh':
                    await data.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    break;
                case 'scroll-down':
                    await data.page.evaluate(() => window.scrollBy(0, 300));
                    break;
                case 'scroll-up':
                    await data.page.evaluate(() => window.scrollBy(0, -300));
                    break;
                case 'scroll-top':
                    await data.page.evaluate(() => window.scrollTo(0, 0));
                    break;
                case 'scroll-bottom':
                    await data.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                    break;
                case 'click':
                    await data.page.evaluate(() => {
                        const els = document.querySelectorAll('a, button, [onclick]');
                        if (els.length) els[Math.floor(Math.random() * els.length)].click();
                    });
                    break;
                case 'type':
                    await data.page.evaluate(() => {
                        const inputs = document.querySelectorAll('input[type="text"], textarea');
                        if (inputs.length) {
                            const inp = inputs[Math.floor(Math.random() * inputs.length)];
                            inp.focus();
                            inp.value = 'Hello';
                            inp.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    });
                    break;
            }
            const screenshot = await takeScreenshot(windowId);
            io.emit('action-result', { success: true, windowId, action, screenshot });
        } catch (e) {
            socket.emit('action-result', { success: false, windowId, error: e.message });
        }
    });
    
    // Автоскролл
    socket.on('toggle-autoscroll', ({ windowId, enabled }) => {
        if (enabled) startAutoScroll(windowId);
        else stopAutoScroll(windowId);
        io.emit('autoscroll-changed', { windowId, enabled });
    });
    
    // Кликер
    socket.on('add-clicker', ({ windowId, type, interval }) => {
        const clickerId = addClicker(windowId, type, interval);
        io.emit('clicker-added', { success: true, clickerId, windowId, type, interval });
    });
    
    socket.on('remove-clicker', ({ clickerId }) => {
        const removed = removeClicker(clickerId);
        io.emit('clicker-removed', { success: removed, clickerId });
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', windows: browsers.size });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    
    // Создаем окна по умолчанию
    const defaults = [
        { id: 'win1', url: 'https://example.com' },
        { id: 'win2', url: 'https://google.com' },
        { id: 'win3', url: 'https://github.com' }
    ];
    
    for (const win of defaults) {
        const success = await createWindow(win.id, win.url);
        if (success) {
            startStreaming(win.id);
            console.log(`Window ${win.id} ready`);
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    
    console.log('All windows created');
});

// Очистка
process.on('SIGTERM', async () => {
    for (const [id, interval] of streams) clearInterval(interval);
    for (const [id, interval] of autoScrolls) clearInterval(interval);
    for (const [id, data] of clickers) clearInterval(data.timer);
    for (const [id, data] of browsers) await data.browser.close().catch(() => {});
    server.close();
    process.exit(0);
});
