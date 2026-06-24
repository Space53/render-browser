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

// ===== КОНФИГУРАЦИЯ =====
const MAX_ACCOUNTS = 2;
const MAX_WINDOWS_PER_ACCOUNT = 3;

// ===== ХРАНИЛИЩЕ =====
const accounts = new Map();
const logs = [];
const MAX_LOGS = 500;

function addLog(level, msg, data) {
    const entry = {
        time: new Date().toISOString(),
        level,
        msg,
        data: data ? JSON.stringify(data).substring(0, 200) : ''
    };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
    console.log(`[${entry.time}] ${level.toUpperCase()}: ${msg}`);
}

function getAccount(accountId) {
    if (!accounts.has(accountId)) {
        if (accounts.size >= MAX_ACCOUNTS) {
            // Удаляем самый старый аккаунт
            const oldest = [...accounts.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
            if (oldest) {
                closeAccount(oldest[0]);
                accounts.delete(oldest[0]);
                addLog('info', `Removed old account: ${oldest[0]}`);
            }
        }
        
        accounts.set(accountId, {
            browser: null,
            windows: new Map(), // windowId -> { page, url, autoScroll }
            clients: new Map(), // windowId -> Set<ws>
            lastFrames: new Map(), // windowId -> Buffer
            autoScrolls: new Map(),
            createdAt: Date.now()
        });
        addLog('info', `Account created: ${accountId}`);
    }
    return accounts.get(accountId);
}

function closeAccount(accountId) {
    const acc = accounts.get(accountId);
    if (!acc) return;
    
    for (const [id, timer] of acc.autoScrolls) clearInterval(timer);
    for (const [id, win] of acc.windows) {
        win.page.close().catch(() => {});
    }
    acc.browser?.close().catch(() => {});
    addLog('info', `Account closed: ${accountId}`);
}

// ===== WebSocket =====
wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const accountId = url.searchParams.get('accountId') || '0';
    const windowId = url.searchParams.get('windowId');
    
    if (!windowId) { ws.close(); return; }
    
    const acc = getAccount(accountId);
    
    if (!acc.clients.has(windowId)) acc.clients.set(windowId, new Set());
    acc.clients.get(windowId).add(ws);
    
    addLog('info', `WS connect: ${accountId}/${windowId} (${acc.clients.get(windowId).size} viewers)`);
    
    // Сразу отправляем последний кадр
    const frame = acc.lastFrames.get(windowId);
    if (frame && ws.readyState === WebSocket.OPEN) {
        ws.send(frame, { binary: true });
    }
    
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);
            const win = acc.windows.get(windowId);
            if (!win || !win.page) return;
            
            const { page } = win;
            
            switch(msg.action) {
                case 'click':
                    await page.mouse.click(msg.x, msg.y);
                    break;
                case 'scroll':
                    await page.evaluate((y) => window.scrollBy(0, y), msg.y || 300);
                    break;
                case 'type':
                    await page.mouse.click(msg.x, msg.y);
                    await new Promise(r => setTimeout(r, 100));
                    await page.evaluate((text) => {
                        const el = document.activeElement;
                        if (el) {
                            if (el.isContentEditable) el.textContent = text;
                            else el.value = text;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }, msg.text || '');
                    addLog('info', `Text sent: ${msg.text?.substring(0, 30)}`);
                    break;
                case 'navigate':
                    try {
                        await page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
                        win.url = msg.url;
                    } catch(e) {
                        addLog('warn', `Navigation timeout: ${msg.url}`);
                    }
                    break;
                case 'refresh':
                    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 }); } catch(e) {}
                    break;
                case 'goBack':
                    try { await page.goBack({ timeout: 5000 }); win.url = page.url(); } catch(e) {}
                    break;
                case 'goForward':
                    try { await page.goForward({ timeout: 5000 }); win.url = page.url(); } catch(e) {}
                    break;
                case 'key':
                    await page.keyboard.press(msg.key);
                    break;
            }
        } catch(e) {
            // Игнорируем ошибки взаимодействия
        }
    });
    
    ws.on('close', () => {
        const cl = acc.clients.get(windowId);
        if (cl) {
            cl.delete(ws);
            addLog('info', `WS disconnect: ${accountId}/${windowId} (${cl.size} left)`);
        }
    });
});

// ===== Запуск браузера для аккаунта =====
async function getBrowser(accountId) {
    const acc = getAccount(accountId);
    
    if (acc.browser?.isConnected()) return acc.browser;
    
    addLog('info', `Launching browser for account: ${accountId}`);
    
    acc.browser = await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding'
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
    
    acc.browser.on('disconnected', () => {
        addLog('warn', `Browser disconnected for account: ${accountId}`);
        acc.browser = null;
    });
    
    return acc.browser;
}

// ===== Создание окна =====
async function createWindow(accountId, windowId, url) {
    const acc = getAccount(accountId);
    
    // Проверяем лимит
    if (acc.windows.size >= MAX_WINDOWS_PER_ACCOUNT) {
        addLog('warn', `Max windows (${MAX_WINDOWS_PER_ACCOUNT}) reached for account: ${accountId}`);
        return false;
    }
    
    // Закрываем существующее окно с таким же ID
    if (acc.windows.has(windowId)) {
        const old = acc.windows.get(windowId);
        await old.page.close().catch(() => {});
        acc.windows.delete(windowId);
        clearInterval(acc.autoScrolls.get(windowId));
        acc.autoScrolls.delete(windowId);
    }
    
    try {
        const browser = await getBrowser(accountId);
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0');
        await page.setViewport({ width: 1280, height: 720 });
        
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
        } catch(e) {
            addLog('warn', `Navigation timeout: ${url}`);
        }
        
        acc.windows.set(windowId, { page, url, autoScroll: false });
        
        // Запускаем захват кадров
        startCapture(accountId, windowId, page);
        
        addLog('success', `Window created: ${accountId}/${windowId} -> ${url}`);
        return true;
    } catch(e) {
        addLog('error', `Failed to create window: ${e.message}`);
        return false;
    }
}

// ===== Захват кадров =====
function startCapture(accountId, windowId, page) {
    const acc = getAccount(accountId);
    let capturing = false;
    
    const capture = async () => {
        if (!acc.windows.has(windowId) || capturing) {
            setTimeout(capture, 50);
            return;
        }
        
        capturing = true;
        
        try {
            const buffer = await page.screenshot({
                type: 'jpeg',
                quality: 25,
                encoding: 'binary'
            });
            
            acc.lastFrames.set(windowId, buffer);
            
            // Отправка всем клиентам
            const cl = acc.clients.get(windowId);
            if (cl && cl.size > 0) {
                for (const ws of cl) {
                    if (ws.readyState === WebSocket.OPEN) {
                        try { ws.send(buffer, { binary: true }); } catch(e) { cl.delete(ws); }
                    }
                }
            }
        } catch(e) {
            // Пропускаем кадр при ошибке
        }
        
        capturing = false;
        setTimeout(capture, 50); // ~20 FPS
    };
    
    capture();
}

// ===== API =====
app.get('/api/status/:accountId', (req, res) => {
    const acc = getAccount(req.params.accountId);
    const windows = [];
    
    for (const [id, win] of acc.windows) {
        windows.push({
            windowId: id,
            url: win.url,
            autoScroll: win.autoScroll || false
        });
    }
    
    res.json({ accountId: req.params.accountId, windows });
});

app.get('/api/logs', (req, res) => {
    res.json(logs);
});

app.post('/api/logs/clear', (req, res) => {
    logs.length = 0;
    res.json({ success: true });
});

app.post('/api/window/create', async (req, res) => {
    const { accountId, windowId, url } = req.body;
    const success = await createWindow(accountId, windowId, url);
    res.json({ success });
});

app.post('/api/window/close', async (req, res) => {
    const { accountId, windowId } = req.body;
    const acc = getAccount(accountId);
    
    const win = acc.windows.get(windowId);
    if (win) {
        await win.page.close().catch(() => {});
        acc.windows.delete(windowId);
        
        clearInterval(acc.autoScrolls.get(windowId));
        acc.autoScrolls.delete(windowId);
        
        // Закрываем WebSocket клиентов
        const cl = acc.clients.get(windowId);
        if (cl) {
            cl.forEach(ws => ws.close());
            acc.clients.delete(windowId);
        }
        
        acc.lastFrames.delete(windowId);
    }
    
    res.json({ success: true });
});

app.post('/api/autoscroll', async (req, res) => {
    const { accountId, windowId, enabled } = req.body;
    const acc = getAccount(accountId);
    const win = acc.windows.get(windowId);
    if (!win) return res.json({ success: false });
    
    if (enabled) {
        if (acc.autoScrolls.has(windowId)) clearInterval(acc.autoScrolls.get(windowId));
        
        const timer = setInterval(async () => {
            try {
                await win.page.evaluate(() => {
                    if (window.pageYOffset + window.innerHeight >= document.documentElement.scrollHeight - 10) {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    } else {
                        window.scrollBy({ top: 200, behavior: 'smooth' });
                    }
                });
            } catch(e) {}
        }, 3000);
        
        acc.autoScrolls.set(windowId, timer);
        win.autoScroll = true;
    } else {
        clearInterval(acc.autoScrolls.get(windowId));
        acc.autoScrolls.delete(windowId);
        win.autoScroll = false;
    }
    
    res.json({ success: true });
});

app.post('/api/init-account', async (req, res) => {
    const { accountId } = req.body;
    const acc = getAccount(accountId);
    
    if (acc.windows.size === 0) {
        const defaults = [
            { id: 'main1', url: 'https://example.com' },
            { id: 'main2', url: 'https://google.com' },
            { id: 'main3', url: 'https://render-browser-h8fc.onrender.com/?id=1' }
        ];
        
        for (const win of defaults) {
            await createWindow(accountId, win.id, win.url);
            await new Promise(r => setTimeout(r, 1500));
        }
    }
    
    const windows = [];
    for (const [id, win] of acc.windows) {
        windows.push({ windowId: id, url: win.url, autoScroll: win.autoScroll });
    }
    
    res.json({ success: true, accountId, windows });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    addLog('success', `Server running on port ${PORT}`);
    console.log(`http://localhost:${PORT}`);
});

process.on('SIGTERM', async () => {
    for (const [id, acc] of accounts) {
        closeAccount(id);
    }
    server.close();
    process.exit(0);
});
