const express = require('express');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Хранилища
const browsers = new Map();
const frameBuffers = new Map();
const clients = new Map();
const autoScrolls = new Map();
const persistentWindows = new Set(); // Постоянные окна

// ==================== MJPEG СТРИМИНГ ====================
app.get('/stream/:windowId', (req, res) => {
    const windowId = req.params.windowId;
    
    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    
    if (!clients.has(windowId)) {
        clients.set(windowId, new Set());
    }
    clients.get(windowId).add(res);
    
    const buffer = frameBuffers.get(windowId);
    if (buffer) {
        try {
            res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
            res.write(buffer);
            res.write('\r\n');
        } catch(e) {}
    }
    
    req.on('close', () => {
        const cls = clients.get(windowId);
        if (cls) cls.delete(res);
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
            '--disable-web-security',
            '--disable-features=IsolateOrigins',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding'
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
}

// ==================== СОЗДАНИЕ ОКНА ====================
async function createWindow(windowId, url, isPersistent = true) {
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
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        browsers.set(windowId, { browser, page, url, autoScroll: false, isPersistent });
        
        if (isPersistent) {
            persistentWindows.add(windowId);
        }
        
        startFrameLoop(windowId, page);
        
        console.log(`✅ ${windowId} (${isPersistent ? 'persistent' : 'anonymous'}): ${url}`);
        return true;
    } catch (error) {
        console.error(`❌ ${windowId}:`, error.message);
        return false;
    }
}

// ==================== ЗАХВАТ КАДРОВ ====================
function startFrameLoop(windowId, page) {
    let capturing = false;
    
    const capture = async () => {
        if (!browsers.has(windowId)) return;
        if (capturing) return;
        
        capturing = true;
        
        try {
            const buffer = await page.screenshot({ 
                type: 'jpeg', 
                quality: 55,
                encoding: 'binary'
            });
            
            frameBuffers.set(windowId, buffer);
            
            const cls = clients.get(windowId);
            if (cls && cls.size > 0) {
                const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`;
                
                for (const client of cls) {
                    try {
                        client.write(header);
                        client.write(buffer);
                        client.write('\r\n');
                    } catch(e) {
                        cls.delete(client);
                    }
                }
            }
        } catch(e) {}
        
        capturing = false;
        setTimeout(() => capture(), 50);
    };
    
    capture();
}

// ==================== ВЗАИМОДЕЙСТВИЕ ====================
app.post('/api/interact', async (req, res) => {
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
            case 'scroll-up':
                await page.evaluate(() => window.scrollBy(0, -300));
                break;
            case 'scroll-down':
                await page.evaluate(() => window.scrollBy(0, 300));
                break;
            case 'scroll-top':
                await page.evaluate(() => window.scrollTo(0, 0));
                break;
            case 'scroll-bottom':
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                break;
            case 'type':
                // Кликаем в нужное место для фокуса
                await page.mouse.click(params.x, params.y);
                await new Promise(r => setTimeout(r, 50));
                
                // Выделяем всё и удаляем (Ctrl+A, Delete)
                await page.keyboard.down('Control');
                await page.keyboard.press('KeyA');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 30));
                
                // Вводим новый текст
                if (params.text) {
                    await page.keyboard.type(params.text, { delay: 20 });
                }
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
    } catch(error) {
        res.json({ success: false, error: error.message });
    }
});

// ==================== АВТОСКРОЛЛ ====================
app.post('/api/autoscroll', async (req, res) => {
    const { windowId, enabled } = req.body;
    const data = browsers.get(windowId);
    
    if (!data) return res.json({ success: false });
    
    if (enabled) {
        if (autoScrolls.has(windowId)) clearInterval(autoScrolls.get(windowId));
        
        const interval = setInterval(async () => {
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
            } catch(e) {}
        }, 3000);
        
        autoScrolls.set(windowId, interval);
        data.autoScroll = true;
    } else {
        if (autoScrolls.has(windowId)) {
            clearInterval(autoScrolls.get(windowId));
            autoScrolls.delete(windowId);
        }
        data.autoScroll = false;
    }
    
    res.json({ success: true, autoScroll: enabled });
});

// ==================== УПРАВЛЕНИЕ ОКНАМИ ====================
app.post('/api/create-window', async (req, res) => {
    const { windowId, url, persistent } = req.body;
    const isPersistent = persistent !== false;
    const success = await createWindow(windowId, url, isPersistent);
    res.json({ success, windowId, url, persistent: isPersistent });
});

app.post('/api/close-window', async (req, res) => {
    const { windowId } = req.body;
    
    if (autoScrolls.has(windowId)) {
        clearInterval(autoScrolls.get(windowId));
        autoScrolls.delete(windowId);
    }
    
    const data = browsers.get(windowId);
    if (data) {
        await data.browser.close().catch(() => {});
        browsers.delete(windowId);
    }
    
    persistentWindows.delete(windowId);
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    const windows = [];
    for (const [id, data] of browsers) {
        windows.push({ 
            windowId: id, 
            url: data.url,
            autoScroll: data.autoScroll || false,
            persistent: persistentWindows.has(id)
        });
    }
    res.json({ windows });
});

// ==================== ЗАПУСК ====================
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`🚀 Server: ${PORT}`);
    
    // Постоянные окна
    const defaults = [
        { id: 'main1', url: 'https://example.com', persistent: true },
        { id: 'main2', url: 'https://google.com', persistent: true },
        { id: 'main3', url: 'https://github.com', persistent: true }
    ];
    
    for (const win of defaults) {
        await createWindow(win.id, win.url, win.persistent);
        await new Promise(r => setTimeout(r, 2000));
    }
    
    console.log('✅ Ready');
});

process.on('SIGTERM', async () => {
    for (const [id, interval] of autoScrolls) clearInterval(interval);
    for (const [id, data] of browsers) {
        await data.browser.close().catch(() => {});
    }
    server.close();
    process.exit(0);
});
