const express = require('express');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Хранилище аккаунтов
const accounts = new Map();

function getAccount(accountId) {
    if (!accounts.has(accountId)) {
        accounts.set(accountId, {
            browsers: new Map(),      // windowId -> { browser, page, url, autoScroll }
            frameBuffers: new Map(),  // windowId -> Buffer
            clients: new Map(),       // windowId -> Set<response>
            autoScrolls: new Map(),   // windowId -> interval
            createdAt: Date.now()
        });
        console.log(`🆕 Account created: ${accountId}`);
    }
    return accounts.get(accountId);
}

// MJPEG стриминг
app.get('/stream/:accountId/:windowId', (req, res) => {
    const { accountId, windowId } = req.params;
    const account = getAccount(accountId);

    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'Pragma': 'no-cache'
    });

    if (!account.clients.has(windowId)) {
        account.clients.set(windowId, new Set());
    }
    account.clients.get(windowId).add(res);

    // Отправить последний кадр сразу при подключении
    const buffer = account.frameBuffers.get(windowId);
    if (buffer) {
        try {
            res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
            res.write(buffer);
            res.write('\r\n');
        } catch(e) {}
    }

    req.on('close', () => {
        const clients = account.clients.get(windowId);
        if (clients) clients.delete(res);
    });
});

// Запуск браузера с оптимизированными аргументами
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
            '--disable-site-isolation-trials'
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
}

// Создание нового окна (страницы)
async function createWindow(accountId, windowId, url) {
    const account = getAccount(accountId);

    try {
        // Закрываем существующее окно с таким же ID, если есть
        if (account.browsers.has(windowId)) {
            const old = account.browsers.get(windowId);
            await old.browser.close().catch(() => {});
            account.browsers.delete(windowId);
        }

        const browser = await launchBrowser();
        const page = await browser.newPage();

        // Маскировка WebDriver
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        account.browsers.set(windowId, { browser, page, url, autoScroll: false });

        startFrameLoop(accountId, windowId, page);

        console.log(`✅ [${accountId}] ${windowId}: ${url}`);
        return true;
    } catch (error) {
        console.error(`❌ [${accountId}] ${windowId}:`, error.message);
        return false;
    }
}

// Цикл захвата кадров с адаптивным интервалом (около 30 fps)
function startFrameLoop(accountId, windowId, page) {
    const account = getAccount(accountId);
    let capturing = false;
    const intervalMs = 33; // ~30 fps

    const capture = async () => {
        if (!account.browsers.has(windowId)) return;
        if (capturing) return;
        capturing = true;

        try {
            const buffer = await page.screenshot({
                type: 'jpeg',
                quality: 45,
                encoding: 'binary'
            });

            account.frameBuffers.set(windowId, buffer);

            const clients = account.clients.get(windowId);
            if (clients && clients.size > 0) {
                const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`;

                for (const client of clients) {
                    try {
                        client.write(header);
                        client.write(buffer);
                        client.write('\r\n');
                    } catch(e) {
                        clients.delete(client);
                    }
                }
            }
        } catch(e) {
            // Игнорируем ошибки скриншота (например, страница закрыта)
        }

        capturing = false;
        setTimeout(capture, intervalMs);
    };

    capture();
}

// Эндпоинт взаимодействия
app.post('/api/interact', async (req, res) => {
    const { accountId, windowId, action, params } = req.body;
    const account = getAccount(accountId);
    const data = account.browsers.get(windowId);

    if (!data) return res.json({ success: false, error: 'Window not found' });

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
                // Кликаем для фокуса, затем вводим текст
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
            case 'setViewport':
                if (params.width && params.height) {
                    await page.setViewport({ width: params.width, height: params.height });
                }
                break;
            case 'zoom':
                await page.evaluate(zoom => { document.body.style.zoom = zoom; }, params.zoom);
                break;
        }

        res.json({ success: true });
    } catch(error) {
        res.json({ success: false, error: error.message });
    }
});

// Автоскролл (анти-кик)
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
            } catch(e) {}
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

    res.json({ success: true, autoScroll: enabled });
});

// Управление окнами
app.post('/api/create-window', async (req, res) => {
    const { accountId, windowId, url } = req.body;
    const success = await createWindow(accountId, windowId, url);
    res.json({ success, windowId, url });
});

app.post('/api/close-window', async (req, res) => {
    const { accountId, windowId } = req.body;
    const account = getAccount(accountId);

    if (account.autoScrolls.has(windowId)) {
        clearInterval(account.autoScrolls.get(windowId));
        account.autoScrolls.delete(windowId);
    }

    const data = account.browsers.get(windowId);
    if (data) {
        await data.browser.close().catch(() => {});
        account.browsers.delete(windowId);
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
    } catch(e) {
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

app.post('/api/init-account', async (req, res) => {
    const { accountId } = req.body;
    const account = getAccount(accountId);

    // Если окон нет, создаём три окна по умолчанию
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
    console.log(`🚀 Live Browser Pro running on port ${PORT}`);
    console.log('👥 Multi-account system active (accounts never deleted)');
});

process.on('SIGTERM', async () => {
    console.log('🧹 Shutting down gracefully...');
    for (const [accountId, account] of accounts) {
        for (const [id, interval] of account.autoScrolls) clearInterval(interval);
        for (const [id, data] of account.browsers) {
            await data.browser.close().catch(() => {});
        }
    }
    server.close();
    process.exit(0);
});
