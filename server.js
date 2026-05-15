const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Хранилище
const accounts = new Map();
const logBuffer = [];
const MAX_LOGS = 1000;
let browserQueue = [];
let activeBrowsers = 0;
const MAX_BROWSERS = 2;

function addLog(level, message, data = null) {
    const entry = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        level,
        message,
        data: data ? JSON.stringify(data).substring(0, 200) : null
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
    
    // Цветной вывод в консоль
    const colors = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', success: '\x1b[32m', fps: '\x1b[35m' };
    const color = colors[level] || '\x1b[0m';
    console.log(`${color}[${entry.iso}] ${level.toUpperCase()}: ${message}\x1b[0m`, data || '');
}

function getAccount(accountId) {
    if (!accounts.has(accountId)) {
        accounts.set(accountId, {
            browsers: new Map(),
            clients: new Map(),
            autoScrolls: new Map(),
            fpsCounters: new Map(),
            hiddenWindows: new Set(),
            createdAt: Date.now()
        });
        addLog('info', `✅ Account ${accountId} created`);
    }
    return accounts.get(accountId);
}

// WebSocket обработка
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const accountId = url.searchParams.get('accountId');
    const windowId = url.searchParams.get('windowId');
    
    if (!accountId || !windowId) {
        ws.close();
        return;
    }
    
    const account = getAccount(accountId);
    
    if (!account.clients.has(windowId)) {
        account.clients.set(windowId, new Set());
    }
    account.clients.get(windowId).add(ws);
    
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    addLog('info', `🔌 WS connect: ${accountId}/${windowId} (total: ${account.clients.get(windowId).size})`);
    
    // Отправка последнего кадра
    const windowData = account.browsers.get(windowId);
    if (windowData?.lastFrame && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(windowData.lastFrame, { binary: true });
        } catch(e) {}
    }
    
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'interact' && windowData?.page) {
                await handleInteraction(windowData.page, msg.action, msg.params);
            }
        } catch(e) {}
    });
    
    ws.on('close', () => {
        const clients = account.clients.get(windowId);
        if (clients) {
            clients.delete(ws);
            addLog('info', `🔌 WS disconnect: ${accountId}/${windowId} (${clients.size} left)`);
        }
    });
});

// Ping/Pong для поддержания соединений
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Запуск браузера с ограничением
async function launchBrowser() {
    if (activeBrowsers >= MAX_BROWSERS) {
        addLog('warn', `⏳ Browser queue: ${browserQueue.length + 1} waiting`);
        await new Promise(resolve => browserQueue.push(resolve));
    }
    
    activeBrowsers++;
    addLog('info', `🌐 Launching browser (${activeBrowsers}/${MAX_BROWSERS})`);
    
    try {
        const browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--disable-features=IsolateOrigins'
            ],
            defaultViewport: { width: 1280, height: 720 },
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
            timeout: 60000
        });
        
        return browser;
    } catch(e) {
        activeBrowsers--;
        processQueue();
        throw e;
    }
}

function processQueue() {
    if (browserQueue.length > 0) {
        const next = browserQueue.shift();
        next();
    }
}

async function closeBrowser(browser) {
    try {
        await browser.close();
    } catch(e) {}
    activeBrowsers--;
    processQueue();
}

// Создание окна
async function createWindow(accountId, windowId, url) {
    const account = getAccount(accountId);
    addLog('info', `🆕 Creating ${accountId}/${windowId} → ${url}`);
    
    try {
        if (account.browsers.has(windowId)) {
            const old = account.browsers.get(windowId);
            await closeBrowser(old.browser);
            account.browsers.delete(windowId);
        }
        
        const browser = await launchBrowser();
        const page = await browser.newPage();
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0');
        await page.setViewport({ width: 1280, height: 720 });
        
        // Навигация с повторными попытками
        let navSuccess = false;
        for (let i = 0; i < 3; i++) {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                navSuccess = true;
                break;
            } catch(e) {
                addLog('warn', `⏳ Retry ${i+1} for ${url}`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        
        if (!navSuccess) {
            await page.goto('about:blank');
            url = 'about:blank';
        }
        
        const windowData = {
            browser,
            page,
            url,
            autoScroll: false,
            customTitle: null,
            lastFrame: null,
            fpsCount: 0,
            lastFpsTime: Date.now()
        };
        
        account.browsers.set(windowId, windowData);
        startFrameCapture(accountId, windowId, page);
        
        addLog('success', `✅ Created: ${accountId}/${windowId}`);
        return true;
    } catch(error) {
        addLog('error', `❌ Failed: ${accountId}/${windowId}`, { error: error.message });
        return false;
    }
}

// Захват кадров - оптимизированный для 60 FPS
function startFrameCapture(accountId, windowId, page) {
    const account = getAccount(accountId);
    let frameCount = 0;
    let lastLog = Date.now();
    
    const capture = async () => {
        const windowData = account.browsers.get(windowId);
        if (!windowData) return;
        
        const start = Date.now();
        
        try {
            const buffer = await page.screenshot({ 
                type: 'jpeg', 
                quality: 35,
                encoding: 'binary'
            });
            
            windowData.lastFrame = buffer;
            frameCount++;
            
            // Отправка всем клиентам
            const clients = account.clients.get(windowId);
            if (clients && clients.size > 0) {
                for (const ws of clients) {
                    if (ws.readyState === WebSocket.OPEN) {
                        try {
                            ws.send(buffer, { binary: true });
                        } catch(e) {
                            clients.delete(ws);
                        }
                    }
                }
            }
            
            // Логирование FPS каждые 5 секунд
            const now = Date.now();
            if (now - lastLog > 5000) {
                const fps = Math.round(frameCount / ((now - lastLog) / 1000));
                if (fps > 0) {
                    addLog('fps', `📊 ${accountId}/${windowId}: ${fps} FPS (${clients?.size || 0} viewers)`);
                }
                frameCount = 0;
                lastLog = now;
            }
            
        } catch(e) {
            // Игнорируем ошибки захвата
        }
        
        // Динамический интервал для достижения 60 FPS
        const elapsed = Date.now() - start;
        const delay = Math.max(1, 16 - elapsed); // Цель: 60 FPS (16ms)
        setTimeout(() => capture(), delay);
    };
    
    capture();
}

// Обработка взаимодействий
async function handleInteraction(page, action, params) {
    try {
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
                await new Promise(r => setTimeout(r, 30));
                await page.keyboard.down('Control');
                await page.keyboard.press('KeyA');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                if (params.text) {
                    await page.keyboard.type(params.text, { delay: 10 });
                }
                break;
            case 'navigate':
                await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                break;
            case 'refresh':
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                break;
            case 'goBack':
                await page.goBack({ timeout: 5000 }).catch(() => {});
                break;
            case 'goForward':
                await page.goForward({ timeout: 5000 }).catch(() => {});
                break;
        }
    } catch(e) {
        addLog('error', `Interaction failed: ${action}`, { error: e.message });
    }
}

// API Endpoints
app.post('/api/interact', async (req, res) => {
    const { accountId, windowId, action, params } = req.body;
    const account = getAccount(accountId);
    const windowData = account.browsers.get(windowId);
    
    if (!windowData) {
        return res.json({ success: false, error: 'Window not found' });
    }
    
    addLog('info', `🖱️ ${action}: ${accountId}/${windowId}`, params);
    await handleInteraction(windowData.page, action, params);
    res.json({ success: true });
});

app.post('/api/autoscroll', async (req, res) => {
    const { accountId, windowId, enabled } = req.body;
    const account = getAccount(accountId);
    const windowData = account.browsers.get(windowId);
    if (!windowData) return res.json({ success: false });
    
    if (enabled) {
        if (account.autoScrolls.has(windowId)) clearInterval(account.autoScrolls.get(windowId));
        const timer = setInterval(async () => {
            try {
                await windowData.page.evaluate(() => {
                    if (window.pageYOffset + window.innerHeight >= document.documentElement.scrollHeight - 10) {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    } else {
                        window.scrollBy({ top: 150, behavior: 'smooth' });
                    }
                });
            } catch(e) {}
        }, 2000);
        account.autoScrolls.set(windowId, timer);
        windowData.autoScroll = true;
    } else {
        if (account.autoScrolls.has(windowId)) {
            clearInterval(account.autoScrolls.get(windowId));
            account.autoScrolls.delete(windowId);
        }
        windowData.autoScroll = false;
    }
    
    res.json({ success: true, autoScroll: enabled });
});

app.post('/api/window/create', async (req, res) => {
    const { accountId, windowId, url } = req.body;
    const success = await createWindow(accountId, windowId, url);
    res.json({ success });
});

app.post('/api/window/close', async (req, res) => {
    const { accountId, windowId } = req.body;
    const account = getAccount(accountId);
    
    if (account.autoScrolls.has(windowId)) {
        clearInterval(account.autoScrolls.get(windowId));
        account.autoScrolls.delete(windowId);
    }
    
    const windowData = account.browsers.get(windowId);
    if (windowData) {
        await closeBrowser(windowData.browser);
        account.browsers.delete(windowId);
        account.clients.get(windowId)?.forEach(ws => ws.close());
        account.clients.delete(windowId);
        account.hiddenWindows.delete(windowId);
    }
    
    addLog('info', `🗑️ Closed: ${accountId}/${windowId}`);
    res.json({ success: true });
});

app.post('/api/window/toggle-visibility', (req, res) => {
    const { accountId, windowId } = req.body;
    const account = getAccount(accountId);
    
    if (account.hiddenWindows.has(windowId)) {
        account.hiddenWindows.delete(windowId);
    } else {
        account.hiddenWindows.add(windowId);
    }
    
    res.json({ success: true, hidden: account.hiddenWindows.has(windowId) });
});

app.get('/api/status/:accountId', (req, res) => {
    const { accountId } = req.params;
    const account = getAccount(accountId);
    
    const windows = [];
    for (const [id, data] of account.browsers) {
        windows.push({
            windowId: id,
            url: data.url,
            autoScroll: data.autoScroll || false,
            title: data.customTitle || id,
            hidden: account.hiddenWindows.has(id)
        });
    }
    
    res.json({ 
        accountId, 
        windows,
        hiddenCount: account.hiddenWindows.size,
        totalWindows: account.browsers.size
    });
});

app.get('/api/logs', (req, res) => {
    res.json(logBuffer);
});

app.post('/api/logs/clear', (req, res) => {
    logBuffer.length = 0;
    addLog('info', '🗑️ Logs cleared');
    res.json({ success: true });
});

app.post('/api/init-account', async (req, res) => {
    const { accountId } = req.body;
    const account = getAccount(accountId);
    
    if (account.browsers.size === 0) {
        const defaults = [
            { id: 'main1', url: 'https://example.com' },
            { id: 'main2', url: 'https://google.com' },
            { id: 'main3', url: 'https://github.com' }
        ];
        
        for (const win of defaults) {
            await createWindow(accountId, win.id, win.url);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    
    const windows = [];
    for (const [id, data] of account.browsers) {
        windows.push({
            windowId: id,
            url: data.url,
            autoScroll: data.autoScroll,
            title: data.customTitle || id,
            hidden: account.hiddenWindows.has(id)
        });
    }
    
    res.json({ success: true, accountId, windows });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    addLog('success', `🚀 Server running on port ${PORT}`);
});

process.on('SIGTERM', async () => {
    addLog('warn', '🧹 Shutting down...');
    for (const [accountId, account] of accounts) {
        for (const [id, interval] of account.autoScrolls) clearInterval(interval);
        for (const [id, data] of account.browsers) {
            await closeBrowser(data.browser);
        }
    }
    server.close();
    process.exit(0);
});
