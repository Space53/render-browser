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
    pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const browsers = new Map();
const streams = new Map();
const autoScrolls = new Map();
const clickers = new Map();

// ==================== ЗАПУСК БРАУЗЕРА ====================
async function launchBrowser() {
    return await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPErseErrors: true
    });
}

// ==================== СОЗДАНИЕ ОКНА ====================
async function createWindow(windowId, url) {
    try {
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
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.setViewport({ width: 1280, height: 720 });
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        browsers.set(windowId, { browser, page, url, createdAt: Date.now() });
        console.log(`✅ Window ${windowId} created: ${url}`);
        return true;
    } catch (error) {
        console.error(`❌ Create ${windowId}:`, error.message);
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
            quality: 50 
        });
        return `data:image/jpeg;base64,${buffer}`;
    } catch (e) {
        return null;
    }
}

// ==================== ПОЛУЧИТЬ РАЗМЕРЫ СТРАНИЦЫ ====================
async function getPageDimensions(windowId) {
    const data = browsers.get(windowId);
    if (!data) return null;
    try {
        return await data.page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            devicePixelRatio: window.devicePixelRatio
        }));
    } catch (e) {
        return null;
    }
}

// ==================== ВЫПОЛНИТЬ ДЕЙСТВИЕ ====================
async function executeAction(windowId, action, params = {}) {
    const data = browsers.get(windowId);
    if (!data) throw new Error('Window not found');
    
    const page = data.page;
    
    switch(action) {
        // ========== КЛИК МЫШИ ==========
        case 'click':
            await page.mouse.click(params.x, params.y);
            break;
            
        // ========== ДВОЙНОЙ КЛИК ==========
        case 'dblclick':
            await page.mouse.click(params.x, params.y, { clickCount: 2 });
            break;
            
        // ========== ПРАВЫЙ КЛИК ==========
        case 'rightclick':
            await page.mouse.click(params.x, params.y, { button: 'right' });
            break;
            
        // ========== ДВИЖЕНИЕ МЫШИ ==========
        case 'mousemove':
            await page.mouse.move(params.x, params.y);
            break;
            
        // ========== СКРОЛЛ ==========
        case 'scroll':
            await page.evaluate(({ x, y }) => {
                window.scrollBy(x, y);
            }, params);
            break;
            
        // ========== ВВОД ТЕКСТА ==========
        case 'type':
            // Сначала кликаем в точку для фокуса
            await page.mouse.click(params.x, params.y);
            await new Promise(r => setTimeout(r, 100));
            // Вводим текст
            await page.keyboard.type(params.text || '', { delay: 50 });
            break;
            
        // ========== НАЖАТИЕ КЛАВИШИ ==========
        case 'keypress':
            await page.keyboard.press(params.key);
            break;
            
        // ========== НАВИГАЦИЯ ==========
        case 'navigate':
            await page.goto(params.url, { waitUntil: 'networkidle2', timeout: 30000 });
            data.url = params.url;
            break;
            
        // ========== ОБНОВЛЕНИЕ ==========
        case 'refresh':
            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
            break;
            
        // ========== НАЗАД ==========
        case 'back':
            await page.goBack({ waitUntil: 'networkidle2', timeout: 10000 });
            break;
            
        // ========== ВПЕРЕД ==========
        case 'forward':
            await page.goForward({ waitUntil: 'networkidle2', timeout: 10000 });
            break;
            
        default:
            throw new Error(`Unknown action: ${action}`);
    }
    
    // Небольшая задержка для рендера
    await new Promise(r => setTimeout(r, 200));
    
    // Возвращаем новый скриншот
    return await takeScreenshot(windowId);
}

// ==================== СТРИМ ====================
function startStreaming(windowId) {
    stopStreaming(windowId);
    const interval = setInterval(async () => {
        const screenshot = await takeScreenshot(windowId);
        if (screenshot) {
            io.emit('screenshot', { 
                windowId, 
                screenshot, 
                timestamp: Date.now() 
            });
        }
    }, 800); // Каждые 800ms
    streams.set(windowId, interval);
}

function stopStreaming(windowId) {
    if (streams.has(windowId)) {
        clearInterval(streams.get(windowId));
        streams.delete(windowId);
    }
}

// ==================== АВТОСКРОЛЛ ====================
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

// ==================== WEBSOCKET ====================
io.on('connection', async (socket) => {
    console.log('🔵 Connected:', socket.id);
    
    // Отправляем статус
    const status = [];
    for (const [id, data] of browsers) {
        const dims = await getPageDimensions(id);
        status.push({
            windowId: id,
            url: data.url,
            autoScroll: autoScrolls.has(id),
            dimensions: dims
        });
    }
    socket.emit('status', { windows: status });
    
    // Стримим существующие
    for (const [id] of browsers) {
        startStreaming(id);
        const screenshot = await takeScreenshot(id);
        const dims = await getPageDimensions(id);
        if (screenshot) {
            socket.emit('screenshot', { 
                windowId: id, 
                screenshot, 
                dimensions: dims,
                timestamp: Date.now() 
            });
        }
    }
    
    // ========== СОЗДАТЬ ОКНО ==========
    socket.on('create-window', async ({ windowId, url }) => {
        const success = await createWindow(windowId, url);
        if (success) {
            startStreaming(windowId);
            const screenshot = await takeScreenshot(windowId);
            const dims = await getPageDimensions(windowId);
            io.emit('window-created', { 
                success: true, 
                windowId, 
                url, 
                screenshot,
                dimensions: dims
            });
        } else {
            socket.emit('window-created', { 
                success: false, 
                windowId, 
                error: 'Failed to create' 
            });
        }
    });
    
    // ========== ВЫПОЛНИТЬ ДЕЙСТВИЕ (КЛИК, СКРОЛЛ, ВВОД) ==========
    socket.on('interact', async ({ windowId, action, params }) => {
        console.log(`🖱️ Interact ${windowId}: ${action}`, params);
        
        try {
            const screenshot = await executeAction(windowId, action, params);
            const dims = await getPageDimensions(windowId);
            
            socket.emit('interact-result', {
                success: true,
                windowId,
                action,
                screenshot,
                dimensions: dims
            });
            
            // Также отправляем всем (для синхронизации)
            io.emit('screenshot', {
                windowId,
                screenshot,
                dimensions: dims,
                timestamp: Date.now()
            });
            
        } catch (error) {
            socket.emit('interact-result', {
                success: false,
                windowId,
                action,
                error: error.message
            });
        }
    });
    
    // ========== АВТОСКРОЛЛ ==========
    socket.on('toggle-autoscroll', ({ windowId, enabled }) => {
        if (enabled) startAutoScroll(windowId);
        else stopAutoScroll(windowId);
        io.emit('autoscroll-changed', { windowId, enabled });
    });
    
    // ========== ОТКЛЮЧЕНИЕ ==========
    socket.on('disconnect', () => {
        console.log('🔴 Disconnected:', socket.id);
    });
});

// ==================== ЗАПУСК ====================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`\n🚀 Server on port ${PORT}\n`);
    
    const defaults = [
        { id: 'win1', url: 'https://example.com' },
        { id: 'win2', url: 'https://google.com' },
        { id: 'win3', url: 'https://github.com' }
    ];
    
    for (const win of defaults) {
        const success = await createWindow(win.id, win.url);
        if (success) startStreaming(win.id);
        await new Promise(r => setTimeout(r, 2000));
    }
    
    console.log('\n✅ All windows ready!\n');
});

// ==================== ОЧИСТКА ====================
process.on('SIGTERM', async () => {
    for (const [id, interval] of streams) clearInterval(interval);
    for (const [id, interval] of autoScrolls) clearInterval(interval);
    for (const [id, data] of browsers) {
        await data.browser.close().catch(() => {});
    }
    server.close();
    process.exit(0);
});
