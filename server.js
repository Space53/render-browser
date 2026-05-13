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

// ==================== ХРАНИЛИЩА ====================
const browsers = new Map();
const streams = new Map(); // windowId -> interval
const autoScrolls = new Map();
const clickers = new Map();

// ==================== ЗАПУСК БРАУЗЕРА ====================
async function launchBrowser() {
    console.log('🚀 Launching browser...');
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

// ==================== СОЗДАНИЕ ОКНА ====================
async function createWindow(windowId, url) {
    console.log(`📝 Creating window: ${windowId} -> ${url}`);
    
    try {
        // Закрываем старый если есть
        if (browsers.has(windowId)) {
            await browsers.get(windowId).browser.close().catch(() => {});
            browsers.delete(windowId);
        }
        
        const browser = await launchBrowser();
        const page = await browser.newPage();
        
        // Анти-детект
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
        
        console.log(`🌐 Navigating ${windowId} to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        browsers.set(windowId, { browser, page, url, createdAt: Date.now() });
        
        console.log(`✅ Window ${windowId} created successfully`);
        return true;
        
    } catch (error) {
        console.error(`❌ Failed to create ${windowId}:`, error.message);
        return false;
    }
}

// ==================== СКРИНШОТ ====================
async function takeScreenshot(windowId) {
    const data = browsers.get(windowId);
    if (!data) return null;
    
    try {
        const buffer = await data.page.screenshot({ 
            encoding: 'base64', 
            type: 'jpeg', 
            quality: 40 
        });
        return `data:image/jpeg;base64,${buffer}`;
    } catch (e) {
        return null;
    }
}

// ==================== СТРИМ СКРИНШОТОВ ====================
function startStreaming(windowId) {
    stopStreaming(windowId);
    
    console.log(`📡 Starting stream for ${windowId}`);
    
    const interval = setInterval(async () => {
        const screenshot = await takeScreenshot(windowId);
        if (screenshot) {
            io.emit('screenshot', { windowId, screenshot, timestamp: Date.now() });
        }
    }, 500); // Каждые 500ms для реального времени
    
    streams.set(windowId, interval);
}

function stopStreaming(windowId) {
    if (streams.has(windowId)) {
        clearInterval(streams.get(windowId));
        streams.delete(windowId);
        console.log(`📡 Stopped stream for ${windowId}`);
    }
}

// ==================== АВТОСКРОЛЛ ====================
function startAutoScroll(windowId) {
    stopAutoScroll(windowId);
    
    console.log(`🔄 Starting auto-scroll for ${windowId}`);
    
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

// ==================== КЛИКЕР ====================
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

// ==================== WEBSOCKET ====================
io.on('connection', async (socket) => {
    console.log('🔵 Client connected:', socket.id);
    
    // Отправляем статус всех окон
    const status = [];
    for (const [id, data] of browsers) {
        status.push({
            windowId: id,
            url: data.url,
            autoScroll: autoScrolls.has(id),
            clickers: Array.from(clickers.entries())
                .filter(([_, c]) => c.windowId === id)
                .map(([cid, c]) => ({ id: cid, type: c.type }))
        });
    }
    socket.emit('status', { windows: status });
    
    // Сразу начинаем стримить все существующие окна
    for (const [id] of browsers) {
        startStreaming(id);
        const screenshot = await takeScreenshot(id);
        if (screenshot) {
            socket.emit('screenshot', { windowId: id, screenshot, timestamp: Date.now() });
        }
    }
    
    // ========== СОЗДАТЬ ОКНО ==========
    socket.on('create-window', async ({ windowId, url }) => {
        console.log(`📝 Create window: ${windowId} -> ${url}`);
        
        const success = await createWindow(windowId, url);
        
        if (success) {
            startStreaming(windowId);
            const screenshot = await takeScreenshot(windowId);
            
            io.emit('window-created', { 
                success: true, 
                windowId, 
                url,
                screenshot,
                timestamp: Date.now()
            });
        } else {
            socket.emit('window-created', { 
                success: false, 
                windowId,
                error: 'Failed to create browser window'
            });
        }
    });
    
    // ========== НАВИГАЦИЯ ==========
    socket.on('navigate', async ({ windowId, url }) => {
        console.log(`🧭 Navigate: ${windowId} -> ${url}`);
        
        let data = browsers.get(windowId);
        
        if (!data) {
            const success = await createWindow(windowId, url);
            if (success) {
                startStreaming(windowId);
                data = browsers.get(windowId);
            } else {
                socket.emit('navigate-result', { 
                    success: false, 
                    windowId, 
                    error: 'Failed to create window' 
                });
                return;
            }
        }
        
        try {
            await data.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            data.url = url;
            
            const screenshot = await takeScreenshot(windowId);
            io.emit('navigate-result', { 
                success: true, 
                windowId, 
                url,
                screenshot 
            });
        } catch (e) {
            socket.emit('navigate-result', { 
                success: false, 
                windowId, 
                error: e.message 
            });
        }
    });
    
    // ========== ДЕЙСТВИЕ ==========
    socket.on('action', async ({ windowId, action }) => {
        console.log(`⚡ Action: ${action} on ${windowId}`);
        
        const data = browsers.get(windowId);
        if (!data) {
            socket.emit('action-result', { 
                success: false, 
                windowId, 
                error: 'Window not found' 
            });
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
                            inp.value = 'Hello World';
                            inp.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    });
                    break;
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
            
            const screenshot = await takeScreenshot(windowId);
            io.emit('action-result', { 
                success: true, 
                windowId, 
                action,
                screenshot 
            });
            
        } catch (e) {
            socket.emit('action-result', { 
                success: false, 
                windowId, 
                error: e.message 
            });
        }
    });
    
    // ========== АВТОСКРОЛЛ ==========
    socket.on('toggle-autoscroll', ({ windowId, enabled }) => {
        if (enabled) {
            startAutoScroll(windowId);
        } else {
            stopAutoScroll(windowId);
        }
        
        io.emit('autoscroll-changed', { 
            windowId, 
            enabled,
            timestamp: Date.now()
        });
    });
    
    // ========== КЛИКЕР ==========
    socket.on('add-clicker', ({ windowId, type, interval }) => {
        const clickerId = addClicker(windowId, type, interval);
        
        io.emit('clicker-added', {
            success: true,
            clickerId,
            windowId,
            type,
            interval,
            timestamp: Date.now()
        });
    });
    
    socket.on('remove-clicker', ({ clickerId }) => {
        const removed = removeClicker(clickerId);
        
        io.emit('clicker-removed', {
            success: removed,
            clickerId,
            timestamp: Date.now()
        });
    });
    
    // ========== ОТКЛЮЧЕНИЕ ==========
    socket.on('disconnect', () => {
        console.log('🔴 Client disconnected:', socket.id);
        // НЕ останавливаем стримы - браузеры продолжают работать
    });
});

// ==================== ЗАПУСК СЕРВЕРА ====================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`\n🚀 Server started on port ${PORT}`);
    console.log('=' .repeat(50));
    
    // Автосоздание 3 окон при старте
    const defaultWindows = [
        { id: 'win1', url: 'https://example.com' },
        { id: 'win2', url: 'https://google.com' },
        { id: 'win3', url: 'https://github.com' }
    ];
    
    for (const win of defaultWindows) {
        console.log(`\n📦 Creating default window: ${win.id}`);
        const success = await createWindow(win.id, win.url);
        if (success) {
            startStreaming(win.id);
            console.log(`✅ ${win.id} ready and streaming`);
        }
        // Задержка между созданиями
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('✅ All windows created and streaming');
    console.log(`🌐 Open http://localhost:${PORT} to view\n`);
});

// ==================== ОЧИСТКА ====================
process.on('SIGTERM', async () => {
    console.log('🧹 Shutting down...');
    
    for (const [id, interval] of streams) clearInterval(interval);
    for (const [id, interval] of autoScrolls) clearInterval(interval);
    for (const [id, data] of clickers) clearInterval(data.timer);
    
    for (const [id, data] of browsers) {
        await data.browser.close().catch(() => {});
    }
    
    server.close();
    process.exit(0);
});            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
}

// ==================== СОЗДАНИЕ ОКНА ====================
async function createBrowserWindow(windowId, url) {
    try {
        console.log(`🟢 Creating window ${windowId} -> ${url}`);
        
        const browser = await launchBrowser();
        const page = await browser.newPage();
        
        // Анти-детект
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        browsers.set(windowId, { 
            browser, 
            page, 
            url,
            createdAt: Date.now()
        });
        
        console.log(`✅ Window ${windowId} created`);
        return true;
        
    } catch (error) {
        console.error(`❌ Window ${windowId} error:`, error.message);
        return false;
    }
}

// ==================== СКРИНШОТ ====================
async function getScreenshot(windowId) {
    const data = browsers.get(windowId);
    if (!data) return null;
    
    try {
        const screenshot = await data.page.screenshot({ 
            encoding: 'base64', 
            type: 'jpeg', 
            quality: 35 
        });
        return `data:image/jpeg;base64,${screenshot}`;
    } catch (e) {
        return null;
    }
}

// ==================== СТРИМ СКРИНШОТОВ ====================
function startScreenshotStream(windowId, socket) {
    // Очищаем старый интервал
    if (screenshotIntervals.has(windowId)) {
        clearInterval(screenshotIntervals.get(windowId));
    }
    
    // Создаем новый интервал (каждые 500ms для моментальной синхронизации)
    const interval = setInterval(async () => {
        const screenshot = await getScreenshot(windowId);
        if (screenshot) {
            socket.emit('screenshot-stream', { windowId, screenshot });
        }
    }, 500);
    
    screenshotIntervals.set(windowId, interval);
}

function stopScreenshotStream(windowId) {
    if (screenshotIntervals.has(windowId)) {
        clearInterval(screenshotIntervals.get(windowId));
        screenshotIntervals.delete(windowId);
    }
}

// ==================== АВТОСКРОЛЛ ====================
function startAutoScroll(windowId, socket) {
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
        } catch (e) {
            console.error(`Auto-scroll ${windowId}:`, e.message);
        }
    }, 3000);
    
    autoScrollIntervals.set(windowId, interval);
}

function stopAutoScroll(windowId) {
    if (autoScrollIntervals.has(windowId)) {
        clearInterval(autoScrollIntervals.get(windowId));
        autoScrollIntervals.delete(windowId);
    }
}

// ==================== КЛИКЕР ====================
function addClicker(windowId, type, interval = 5000) {
    const clickerId = `${windowId}_${Date.now()}`;
    
    const timer = setInterval(async () => {
        const data = browsers.get(windowId);
        if (!data) return;
        
        try {
            switch(type) {
                case 'click':
                    await data.page.evaluate(() => {
                        const el = document.querySelectorAll('a, button, [onclick]');
                        if (el.length) {
                            const random = el[Math.floor(Math.random() * el.length)];
                            random.click();
                        }
                    });
                    break;
                case 'scroll':
                    await data.page.evaluate(() => window.scrollBy(0, 200));
                    break;
                case 'refresh':
                    await data.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    break;
                case 'hover':
                    await data.page.evaluate(() => {
                        const el = document.querySelectorAll('a, button');
                        if (el.length) {
                            const random = el[Math.floor(Math.random() * el.length)];
                            random.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                        }
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
        } catch (e) {
            console.error(`Clicker ${clickerId}:`, e.message);
        }
    }, interval);
    
    clickers.set(clickerId, { timer, type, windowId });
    return clickerId;
}

function removeClicker(clickerId) {
    const clicker = clickers.get(clickerId);
    if (clicker) {
        clearInterval(clicker.timer);
        clickers.delete(clickerId);
        return true;
    }
    return false;
}

// ==================== WEBSOCKET ====================
io.on('connection', (socket) => {
    console.log('🔵 Client connected:', socket.id);
    
    // Отправляем текущий статус всех окон
    const status = [];
    for (const [windowId, data] of browsers) {
        status.push({
            windowId,
            url: data.url,
            createdAt: data.createdAt,
            autoScroll: autoScrollIntervals.has(windowId)
        });
    }
    socket.emit('init-status', { windows: status, clickers: Array.from(clickers.keys()) });
    
    // ==================== СОЗДАТЬ ОКНО ====================
    socket.on('create-window', async ({ windowId, url }) => {
        console.log(`📝 Create window request: ${windowId} -> ${url}`);
        
        const success = await createBrowserWindow(windowId, url);
        
        if (success) {
            // Запускаем стрим скриншотов
            startScreenshotStream(windowId, socket);
            
            // Отправляем первый скриншот
            const screenshot = await getScreenshot(windowId);
            socket.emit('window-created', { 
                success: true, 
                windowId, 
                url,
                screenshot 
            });
            
            // Отправляем обновленный статус всем
            io.emit('windows-status', {
                windowId,
                url,
                autoScroll: false
            });
        } else {
            socket.emit('window-created', { 
                success: false, 
                windowId, 
                error: 'Failed to create window' 
            });
        }
    });
    
    // ==================== НАВИГАЦИЯ ====================
    socket.on('navigate', async ({ windowId, url }) => {
        console.log(`🧭 Navigate ${windowId} -> ${url}`);
        
        const data = browsers.get(windowId);
        if (!data) {
            // Если окна нет - создаем
            const success = await createBrowserWindow(windowId, url);
            if (success) {
                startScreenshotStream(windowId, socket);
            }
        } else {
            try {
                await data.page.goto(url, { 
                    waitUntil: 'networkidle2', 
                    timeout: 30000 
                });
                data.url = url;
            } catch (e) {
                console.error(`Navigate error ${windowId}:`, e.message);
            }
        }
        
        const screenshot = await getScreenshot(windowId);
        socket.emit('navigate-done', { 
            success: true, 
            windowId, 
            url,
            screenshot 
        });
        
        // Обновляем статус для всех
        io.emit('windows-status', {
            windowId,
            url,
            autoScroll: autoScrollIntervals.has(windowId)
        });
    });
    
    // ==================== ДЕЙСТВИЕ ====================
    socket.on('execute-action', async ({ windowId, action }) => {
        console.log(`⚡ Action ${action} on ${windowId}`);
        
        const data = browsers.get(windowId);
        if (!data) return;
        
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
                        const el = document.querySelectorAll('a, button');
                        if (el.length) el[Math.floor(Math.random() * el.length)].click();
                    });
                    break;
            }
            
            const screenshot = await getScreenshot(windowId);
            socket.emit('action-done', { 
                success: true, 
                windowId, 
                action,
                screenshot 
            });
            
        } catch (e) {
            socket.emit('action-done', { 
                success: false, 
                windowId, 
                action,
                error: e.message 
            });
        }
    });
    
    // ==================== АВТОСКРОЛЛ ====================
    socket.on('toggle-auto-scroll', async ({ windowId, enabled }) => {
        console.log(`🔄 Auto-scroll ${windowId}: ${enabled}`);
        
        if (enabled) {
            startAutoScroll(windowId, socket);
        } else {
            stopAutoScroll(windowId);
        }
        
        io.emit('windows-status', {
            windowId,
            url: browsers.get(windowId)?.url,
            autoScroll: enabled
        });
    });
    
    // ==================== КЛИКЕР ====================
    socket.on('add-clicker', ({ windowId, type, interval }) => {
        const clickerId = addClicker(windowId, type, interval);
        socket.emit('clicker-added', { success: true, clickerId, windowId, type });
        io.emit('clickers-status', Array.from(clickers.entries()).map(([id, c]) => ({
            id, type: c.type, windowId: c.windowId
        })));
    });
    
    socket.on('remove-clicker', ({ clickerId }) => {
        const removed = removeClicker(clickerId);
        socket.emit('clicker-removed', { success: removed, clickerId });
        io.emit('clickers-status', Array.from(clickers.entries()).map(([id, c]) => ({
            id, type: c.type, windowId: c.windowId
        })));
    });
    
    // ==================== ЗАПРОС СКРИНШОТА ====================
    socket.on('request-screenshot', async ({ windowId }) => {
        const screenshot = await getScreenshot(windowId);
        if (screenshot) {
            socket.emit('screenshot-stream', { windowId, screenshot });
        }
    });
    
    // ==================== ЗАПРОС ВСЕХ СКРИНШОТОВ ====================
    socket.on('request-all-screenshots', async () => {
        for (const [windowId] of browsers) {
            const screenshot = await getScreenshot(windowId);
            if (screenshot) {
                socket.emit('screenshot-stream', { windowId, screenshot });
            }
        }
    });
    
    // ==================== ОТКЛЮЧЕНИЕ ====================
    socket.on('disconnect', () => {
        console.log('🔴 Client disconnected:', socket.id);
    });
});

// ==================== ИНИЦИАЛИЗАЦИЯ СЕРВЕРА ====================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('📦 Pre-creating default windows...');
    
    // Предсоздаем окна с задержкой
    for (const [windowId, config] of Object.entries(DEFAULT_WINDOWS)) {
        setTimeout(async () => {
            await createBrowserWindow(windowId, config.url);
        }, Object.keys(DEFAULT_WINDOWS).indexOf(windowId) * 2000);
    }
});

// ==================== ОЧИСТКА ====================
process.on('SIGTERM', async () => {
    console.log('🧹 Cleaning up...');
    
    for (const [id, interval] of autoScrollIntervals) clearInterval(interval);
    for (const [id, interval] of screenshotIntervals) clearInterval(interval);
    for (const [id, clicker] of clickers) clearInterval(clicker.timer);
    
    for (const [id, data] of browsers) {
        await data.browser.close().catch(() => {});
    }
    
    server.close();
    process.exit(0);
});
