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

// ----- Хранилище аккаунтов -----
const accounts = new Map();

// ----- Буфер логов (последние 500 записей) -----
const logBuffer = [];
const MAX_LOGS = 500;

function addLog(level, message, data = null) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        data: data ? JSON.stringify(data) : undefined
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
    console.log(`[${level.toUpperCase()}] ${message}`, data || '');
}

function getAccount(accountId) {
    if (!accounts.has(accountId)) {
        accounts.set(accountId, {
            browsers: new Map(),
            clients: new Map(),      // windowId -> Set<WebSocket>
            autoScrolls: new Map(),
            createdAt: Date.now()
        });
        addLog('info', `Account ${accountId} created`);
    }
    return accounts.get(accountId);
}

// ----- WebSocket обработка -----
wss.on('connection', (ws, req) => {
    // URL вида /ws/:accountId/:windowId
    const urlParts = req.url.split('/').filter(p => p);
    if (urlParts.length < 3 || urlParts[0] !== 'ws') {
        ws.close();
        return;
    }
    const [, accountId, windowId] = urlParts;
    const account = getAccount(accountId);

    if (!account.clients.has(windowId)) {
        account.clients.set(windowId, new Set());
    }
    account.clients.get(windowId).add(ws);
    addLog('info', `WebSocket connected: ${accountId}/${windowId}`);

    // Отправляем последний кадр сразу
    const buffer = account.browsers.get(windowId)?.lastFrame;
    if (buffer) {
        ws.send(buffer, { binary: true });
    }

    ws.on('close', () => {
        const clients = account.clients.get(windowId);
        if (clients) clients.delete(ws);
        addLog('info', `WebSocket disconnected: ${accountId}/${windowId}`);
    });
});

// ----- Запуск браузера -----
async function launchBrowser() {
    addLog('info', 'Launching headless Chromium...');
    return await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox',
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

// ----- Создание окна -----
async function createWindow(accountId, windowId, url) {
    const account = getAccount(accountId);
    addLog('info', `Creating window ${accountId}/${windowId} -> ${url}`);

    try {
        if (account.browsers.has(windowId)) {
            const old = account.browsers.get(windowId);
            await old.browser.close().catch(() => {});
            account.browsers.delete(windowId);
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

        const windowData = {
            browser,
            page,
            url,
            autoScroll: false,
            customTitle: null,
            lastFrame: null
        };
        account.browsers.set(windowId, windowData);

        startFrameCapture(accountId, windowId, page);
        addLog('success', `Window created: ${accountId}/${windowId}`);
        return true;
    } catch (error) {
        addLog('error', `Failed to create window ${accountId}/${windowId}`, { error: error.message });
        return false;
    }
}

// ----- Захват и рассылка кадров через WebSocket (высокий FPS) -----
function startFrameCapture(accountId, windowId, page) {
    const account = getAccount(accountId);
    let capturing = false;
    const TARGET_FPS = 30;
    const INTERVAL = 1000 / TARGET_FPS;

    const capture = async () => {
        if (!account.browsers.has(windowId)) return;
        if (capturing) return;
        capturing = true;

        try {
            const buffer = await page.screenshot({ type: 'jpeg', quality: 40, encoding: 'binary' });
            const windowData = account.browsers.get(windowId);
            if (windowData) windowData.lastFrame = buffer;

            const clients = account.clients.get(windowId);
            if (clients && clients.size > 0) {
                for (const ws of clients) {
                    try {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(buffer, { binary: true });
                        }
                    } catch (e) {
                        clients.delete(ws);
                    }
                }
            }
        } catch (e) {
            // Игнорируем ошибки скриншота (например, страница закрыта)
        }
        capturing = false;
        setTimeout(() => capture(), INTERVAL);
    };
    capture();
}

// ----- API взаимодействия -----
app.post('/api/interact', async (req, res) => {
    const { accountId, windowId, action, params } = req.body;
    addLog('info', `Interact: ${action} on ${accountId}/${windowId}`, params);
    const account = getAccount(accountId);
    const data = account.browsers.get(windowId);
    if (!data) {
        addLog('error', `Window not found: ${windowId}`);
        return res.json({ success: false, error: 'Window not found' });
    }

    try {
        const page = data.page;
        switch (action) {
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
                await page.keyboard.down('Control');
                await page.keyboard.press('KeyA');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                await new Promise(r => setTimeout(r, 30));
                if (params.text) {
                    await page.keyboard.type(params.text, { delay: 20 });
                }
                break;
            case 'navigate':
                await page.goto(params.url, { waitUntil: 'networkidle2', timeout: 30000 });
                data.url = params.url;
                break;
            case 'refresh':
                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                break;
            case 'goBack':
                await page.goBack({ timeout: 10000 }).catch(() => {});
                data.url = page.url();
                break;
            case 'goForward':
                await page.goForward({ timeout: 10000 }).catch(() => {});
                data.url = page.url();
                break;
            case 'zoom':
                await page.evaluate(zoom => { document.body.style.zoom = zoom; }, params.zoom);
                break;
        }
        res.json({ success: true });
    } catch (error) {
        addLog('error', `Interaction failed: ${action}`, { error: error.message });
        res.json({ success: false, error: error.message });
    }
});

// ----- Автоскролл -----
app.post('/api/autoscroll', async (req, res) => {
    const { accountId, windowId, enabled, interval = 3000 } = req.body;
    const account = getAccount(accountId);
    const data = account.browsers.get(windowId);
    if (!data) return res.json({ success: false });

    if (enabled) {
        if (account.autoScrolls.has(windowId)) clearInterval(account.autoScrolls.get(windowId));
        const timer = setInterval(async () => {
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
        }, interval);
        account.autoScrolls.set(windowId, timer);
        data.autoScroll = true;
    } else {
        if (account.autoScrolls.has(windowId)) {
            clearInterval(account.autoScrolls.get(windowId));
            account.autoScrolls.delete(windowId);
        }
        data.autoScroll = false;
    }
    addLog('info', `Autoscroll ${enabled ? 'ON' : 'OFF'} for ${accountId}/${windowId}`);
    res.json({ success: true, autoScroll: enabled });
});

// ----- Управление окнами -----
app.post('/api/create-window', async (req, res) => {
    const { accountId, windowId, url } = req.body;
    const success = await createWindow(accountId, windowId, url);
    res.json({ success, windowId, url });
});

app.post('/api/close-window', async (req, res) => {
    const { accountId, windowId } = req.body;
    addLog('info', `Closing window ${accountId}/${windowId}`);
    const account = getAccount(accountId);
    if (account.autoScrolls.has(windowId)) {
        clearInterval(account.autoScrolls.get(windowId));
        account.autoScrolls.delete(windowId);
    }
    const data = account.browsers.get(windowId);
    if (data) {
        await data.browser.close().catch(() => {});
        account.browsers.delete(windowId);
        account.clients.get(windowId)?.forEach(ws => ws.close());
        account.clients.delete(windowId);
    }
    res.json({ success: true });
});

app.post('/api/rename-window', (req, res) => {
    const { accountId, windowId, title } = req.body;
    const account = getAccount(accountId);
    const data = account.browsers.get(windowId);
    if (data) {
        data.customTitle = title;
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Not found' });
    }
});

app.get('/api/screenshot/:accountId/:windowId', async (req, res) => {
    const { accountId, windowId } = req.params;
    const account = getAccount(accountId);
    const data = account.browsers.get(windowId);
    if (!data) return res.status(404).send('Not found');
    try {
        const buffer = await data.page.screenshot({ type: 'png' });
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Disposition': `attachment; filename="screenshot-${windowId}.png"`
        });
        res.end(buffer);
    } catch (e) {
        res.status(500).send('Screenshot failed');
    }
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
            title: data.customTitle || id
        });
    }
    res.json({ accountId, windows });
});

// ----- Логи -----
app.get('/api/logs', (req, res) => {
    res.json(logBuffer);
});

// ----- Инициализация аккаунта -----
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
            await new Promise(r => setTimeout(r, 1500));
        }
    }
    const windows = [];
    for (const [id, data] of account.browsers) {
        windows.push({ windowId: id, url: data.url, autoScroll: data.autoScroll, title: data.customTitle || id });
    }
    res.json({ success: true, accountId, windows });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    addLog('info', `Server listening on port ${PORT}`);
    console.log(`🚀 Live Browser Pro X running on port ${PORT}`);
});

process.on('SIGTERM', async () => {
    addLog('info', 'Shutting down...');
    for (const [accountId, account] of accounts) {
        for (const [id, interval] of account.autoScrolls) clearInterval(interval);
        for (const [id, data] of account.browsers) {
            await data.browser.close().catch(() => {});
        }
    }
    server.close();
    process.exit(0);
});
