const express = require('express');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Хранилище браузеров
const browsers = new Map();
const frameBuffers = new Map(); // windowId -> Buffer
const clients = new Map(); // windowId -> Set<response>

// ==================== MJPEG СТРИМИНГ ====================
app.get('/stream/:windowId', (req, res) => {
    const windowId = req.params.windowId;
    
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache',
        'Connection': 'close',
        'Pragma': 'no-cache'
    });
    
    // Добавляем клиента
    if (!clients.has(windowId)) {
        clients.set(windowId, new Set());
    }
    clients.get(windowId).add(res);
    
    // Отправляем последний кадр если есть
    const buffer = frameBuffers.get(windowId);
    if (buffer) {
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
        res.write(buffer);
        res.write('\r\n');
    }
    
    // Удаляем при отключении
    req.on('close', () => {
        const windowClients = clients.get(windowId);
        if (windowClients) {
            windowClients.delete(res);
        }
    });
});

// ==================== ЗАПУСК БРАУЗЕРА ====================
async function launchBrowser() {
    return await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security'
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
}

// ==================== СОЗДАНИЕ ОКНА ====================
async function createWindow(windowId, url) {
    try {
        if (browsers.has(windowId)) {
            await browsers.get(windowId).browser.close().catch(() => {});
        }
        
        const browser = await launchBrowser();
        const page = await browser.newPage();
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        browsers.set(windowId, { browser, page, url });
        
        // Запускаем захват кадров (30 FPS)
        startFrameCapture(windowId, page);
        
        console.log(`✅ Window ${windowId} created: ${url}`);
        return true;
    } catch (error) {
        console.error(`❌ Error:`, error.message);
        return false;
    }
}

// ==================== ЗАХВАТ КАДРОВ (30 FPS) ====================
async function startFrameCapture(windowId, page) {
    const capture = async () => {
        if (!browsers.has(windowId)) return;
        
        try {
            const buffer = await page.screenshot({ 
                type: 'jpeg', 
                quality: 60,
                encoding: 'binary'
            });
            
            frameBuffers.set(windowId, buffer);
            
            // Рассылаем всем подключенным клиентам
            const windowClients = clients.get(windowId);
            if (windowClients) {
                for (const client of windowClients) {
                    try {
                        client.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
                        client.write(buffer);
                        client.write('\r\n');
                    } catch (e) {
                        windowClients.delete(client);
                    }
                }
            }
        } catch (e) {
            // Игнорируем ошибки кадра
        }
        
        // Следующий кадр через ~33ms (30 FPS)
        setTimeout(() => capture(), 33);
    };
    
    capture();
}

// ==================== ВЗАИМОДЕЙСТВИЕ ====================
app.post('/api/interact', express.json(), async (req, res) => {
    const { windowId, action, params } = req.body;
    
    const data = browsers.get(windowId);
    if (!data) {
        return res.json({ success: false, error: 'Window not found' });
    }
    
    try {
        const page = data.page;
        
        switch(action) {
            case 'click':
                await page.mouse.click(params.x, params.y);
                break;
            case 'dblclick':
                await page.mouse.click(params.x, params.y, { clickCount: 2 });
                break;
            case 'scroll':
                await page.evaluate(({ x, y }) => window.scrollBy(x, y), params);
                break;
            case 'type':
                await page.mouse.click(params.x, params.y);
                await new Promise(r => setTimeout(r, 50));
                await page.keyboard.type(params.text || '', { delay: 30 });
                break;
            case 'keypress':
                await page.keyboard.press(params.key);
                break;
            case 'navigate':
                await page.goto(params.url, { waitUntil: 'networkidle2', timeout: 30000 });
                data.url = params.url;
                break;
            case 'refresh':
                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                break;
            case 'back':
                await page.goBack({ waitUntil: 'networkidle2' });
                break;
            case 'forward':
                await page.goForward({ waitUntil: 'networkidle2' });
                break;
        }
        
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// ==================== СОЗДАТЬ ОКНО ЧЕРЕЗ API ====================
app.post('/api/create-window', express.json(), async (req, res) => {
    const { windowId, url } = req.body;
    const success = await createWindow(windowId, url);
    res.json({ success, windowId, url });
});

// ==================== СТАТУС ====================
app.get('/api/status', (req, res) => {
    const windows = [];
    for (const [id, data] of browsers) {
        windows.push({ windowId: id, url: data.url });
    }
    res.json({ windows });
});

// ==================== ЗАПУСК ====================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`🚀 Server on port ${PORT}`);
    
    const defaults = [
        { id: 'win1', url: 'https://example.com' },
        { id: 'win2', url: 'https://google.com' },
        { id: 'win3', url: 'https://github.com' }
    ];
    
    for (const win of defaults) {
        await createWindow(win.id, win.url);
        await new Promise(r => setTimeout(r, 2000));
    }
    
    console.log('✅ All windows ready');
});

process.on('SIGTERM', async () => {
    for (const [id, data] of browsers) {
        await data.browser.close().catch(() => {});
    }
    server.close();
    process.exit(0);
});
