const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Постоянное хранилище логов в файл
const LOG_FILE = path.join(__dirname, 'logs.json');
let logBuffer = [];
const MAX_LOGS = 1000;

// Загружаем старые логи при старте
try {
    if (fs.existsSync(LOG_FILE)) {
        const data = fs.readFileSync(LOG_FILE, 'utf8');
        logBuffer = JSON.parse(data);
        console.log(`📋 Loaded ${logBuffer.length} old logs`);
    }
} catch(e) {}

function saveLogs() {
    try {
        fs.writeFileSync(LOG_FILE, JSON.stringify(logBuffer.slice(-500), null, 2));
    } catch(e) {}
}

function addLog(level, message, data = null) {
    const entry = {
        timestamp: Date.now(),
        iso: new Date().toISOString(),
        level,
        message,
        data: data ? JSON.stringify(data).substring(0, 500) : null
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
    
    // Сохраняем каждые 10 записей
    if (logBuffer.length % 10 === 0) saveLogs();
    
    const colors = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', success: '\x1b[32m', fps: '\x1b[35m', perf: '\x1b[32m' };
    const color = colors[level] || '\x1b[0m';
    console.log(`${color}[${entry.iso}] ${level.toUpperCase()}: ${message}\x1b[0m`, data || '');
}

// Сохраняем логи при выходе
process.on('SIGTERM', () => {
    saveLogs();
    console.log('📋 Logs saved to file');
});

const accounts = new Map();

function getAccount(accountId) {
    if (!accounts.has(accountId)) {
        accounts.set(accountId, {
            browsers: new Map(),
            clients: new Map(),
            autoScrolls: new Map(),
            hiddenWindows: new Set(),
            fpsStats: new Map(), // windowId -> { timestamps: [], qualities: [], fps: [] }
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
    
    if (!accountId || !windowId) { ws.close(); return; }
    
    const account = getAccount(accountId);
    if (!account.clients.has(windowId)) account.clients.set(windowId, new Set());
    account.clients.get(windowId).add(ws);
    
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    addLog('info', `🔌 WS: ${accountId}/${windowId} (${account.clients.get(windowId).size} viewers)`);
    
    const windowData = account.browsers.get(windowId);
    if (windowData?.lastFrame && ws.readyState === WebSocket.OPEN) {
        try { ws.send(windowData.lastFrame, { binary: true }); } catch(e) {}
    }
    
    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'interact' && windowData?.page) {
                await handleInteraction(windowData, msg.action, msg.params);
            }
        } catch(e) {
            addLog('error', `WS message error: ${e.message}`);
        }
    });
    
    ws.on('close', () => {
        const clients = account.clients.get(windowId);
        if (clients) clients.delete(ws);
        addLog('info', `🔌 WS closed: ${accountId}/${windowId} (${clients?.size || 0} left)`);
    });
});

setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

async function launchBrowser() {
    addLog('info', '🌐 Launching Chromium...');
    const startTime = Date.now();
    
    const browser = await puppeteer.launch({
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--disable-features=IsolateOrigins',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding'
        ],
        defaultViewport: { width: 1280, height: 720 },
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
    
    const launchTime = Date.now() - startTime;
    addLog('perf', `⏱️ Browser launched in ${launchTime}ms`);
    return browser;
}

async function createWindow(accountId, windowId, url) {
    const account = getAccount(accountId);
    addLog('info', `🆕 Creating window ${accountId}/${windowId} → ${url}`);
    const startTime = Date.now();
    
    try {
        if (account.browsers.has(windowId)) {
            const old = account.browsers.get(windowId);
            await old.browser.close().catch(() => {});
            account.browsers.delete(windowId);
        }
        
        const browser = await launchBrowser();
        const page = await browser.newPage();
        
        // Отслеживаем загрузку страницы для FPS анализа
        page.on('domcontentloaded', () => {
            addLog('perf', `📄 DOM ready: ${windowId}`);
        });
        
        page.on('load', () => {
            addLog('perf', `✅ Page loaded: ${windowId}`);
        });
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            window.chrome = { runtime: {} };
        });
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0');
        await page.setViewport({ width: 1280, height: 720 });
        
        // Пробуем загрузить с таймаутом
        const navStart = Date.now();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
            const navTime = Date.now() - navStart;
            addLog('perf', `⏱️ Navigation: ${navTime}ms to ${url}`);
        } catch(e) {
            addLog('warn', `⚠️ Navigation timeout for ${url}, loading blank`);
            await page.goto('about:blank').catch(() => {});
        }
        
        const windowData = { 
            browser, 
            page, 
            url, 
            autoScroll: false, 
            customTitle: null, 
            lastFrame: null,
            quality: 40, // Начальное качество JPEG
            lastFpsLog: Date.now(),
            frameCount: 0,
            navigating: false // Флаг навигации для избежания ошибок
        };
        
        account.browsers.set(windowId, windowData);
        startFrameCapture(accountId, windowId, page);
        
        const totalTime = Date.now() - startTime;
        addLog('success', `✅ Window created in ${totalTime}ms: ${accountId}/${windowId}`);
        return true;
    } catch(error) {
        addLog('error', `❌ Failed: ${accountId}/${windowId}`, { error: error.message });
        return false;
    }
}

// Оптимизированный захват кадров с анализом FPS
function startFrameCapture(accountId, windowId, page) {
    const account = getAccount(accountId);
    let capturing = false;
    
    // Инициализируем статистику
    if (!account.fpsStats.has(windowId)) {
        account.fpsStats.set(windowId, {
            timestamps: [],
            fps: [],
            qualities: [],
            domSizes: []
        });
    }
    const stats = account.fpsStats.get(windowId);
    
    const capture = async () => {
        const windowData = account.browsers.get(windowId);
        if (!windowData || capturing) {
            setTimeout(() => capture(), 16);
            return;
        }
        
        capturing = true;
        const captureStart = Date.now();
        
        try {
            // Адаптивное качество на основе нагрузки
            const currentQuality = windowData.quality;
            
            // Измеряем размер DOM (влияет на скорость скриншота)
            let domSize = 0;
            try {
                domSize = await page.evaluate(() => document.documentElement.innerHTML.length);
            } catch(e) {}
            
            // Скриншот
            const buffer = await page.screenshot({ 
                type: 'jpeg', 
                quality: currentQuality,
                encoding: 'binary'
            });
            
            const captureTime = Date.now() - captureStart;
            
            windowData.lastFrame = buffer;
            windowData.frameCount++;
            
            // Отправка клиентам
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
            
            // Анализ FPS каждые 3 секунды
            const now = Date.now();
            if (now - windowData.lastFpsLog > 3000) {
                const elapsed = (now - windowData.lastFpsLog) / 1000;
                const currentFps = Math.round(windowData.frameCount / elapsed);
                windowData.frameCount = 0;
                windowData.lastFpsLog = now;
                
                // Сохраняем статистику
                stats.timestamps.push(now);
                stats.fps.push(currentFps);
                stats.qualities.push(currentQuality);
                stats.domSizes.push(domSize);
                
                // Ограничиваем размер статистики
                if (stats.timestamps.length > 100) {
                    stats.timestamps.shift();
                    stats.fps.shift();
                    stats.qualities.shift();
                    stats.domSizes.shift();
                }
                
                // Логируем FPS с анализом
                const avgFps = stats.fps.length > 3 ? 
                    Math.round(stats.fps.slice(-5).reduce((a,b) => a+b, 0) / Math.min(5, stats.fps.length)) : 
                    currentFps;
                
                const viewers = clients?.size || 0;
                const domKB = Math.round(domSize / 1024);
                
                addLog('fps', `📊 ${windowId}: ${currentFps} FPS | avg: ${avgFps} | q: ${currentQuality}% | DOM: ${domKB}KB | 👥 ${viewers} | time: ${captureTime}ms`);
                
                // Авто-оптимизация качества
                if (currentFps < 5 && currentQuality > 20) {
                    windowData.quality = Math.max(15, currentQuality - 5);
                    addLog('perf', `🔧 Lowered quality to ${windowData.quality}% for ${windowId} (low FPS: ${currentFps})`);
                } else if (currentFps > 40 && currentQuality < 60) {
                    windowData.quality = Math.min(60, currentQuality + 5);
                    addLog('perf', `🔧 Increased quality to ${windowData.quality}% for ${windowId} (high FPS: ${currentFps})`);
                }
                
                // Анализируем что дает высокий FPS
                if (currentFps > 40) {
                    addLog('perf', `🚀 HIGH FPS DETECTED! Window: ${windowId}, DOM: ${domKB}KB, Quality: ${currentQuality}%, Viewers: ${viewers}`);
                }
            }
            
        } catch(e) {
            // Пропускаем кадр при ошибке
        }
        
        capturing = false;
        
        // Динамическая задержка для плавности
        const elapsed = Date.now() - captureStart;
        const delay = Math.max(1, 32 - elapsed);
        setTimeout(() => capture(), delay);
    };
    
    capture();
}

// Исправленная обработка взаимодействий
async function handleInteraction(windowData, action, params) {
    const { page } = windowData;
    
    try {
        // Проверяем что страница не в процессе навигации
        if (windowData.navigating && action !== 'navigate') {
            addLog('warn', `⏳ Waiting for navigation to complete...`);
            await new Promise(r => setTimeout(r, 1000));
            windowData.navigating = false;
        }
        
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
                // Проверяем что контекст выполнения существует
                try {
                    await page.evaluate(() => document.readyState);
                } catch(e) {
                    addLog('warn', '⚠️ Page context lost, skipping type');
                    return;
                }
                
                // Кликаем на поле
                await page.mouse.click(params.x, params.y);
                await new Promise(r => setTimeout(r, 150));
                
                // Пробуем очистить через клавиатуру
                try {
                    await page.keyboard.down('Control');
                    await page.keyboard.press('KeyA');
                    await page.keyboard.up('Control');
                    await page.keyboard.press('Backspace');
                    await new Promise(r => setTimeout(r, 50));
                } catch(e) {
                    // Если не получилось - пробуем через evaluate
                }
                
                // Вставляем текст через JavaScript (надежнее)
                if (params.text && params.text.length > 0) {
                    await page.evaluate((text) => {
                        const el = document.activeElement || document.querySelector('input, textarea, [contenteditable="true"]');
                        if (el) {
                            if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
                                el.textContent = text;
                            } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                                el.value = text;
                            }
                            // Триггерим события
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('keyup', { bubbles: true }));
                        }
                    }, params.text);
                    
                    addLog('info', `📝 Text inserted: ${params.text.substring(0, 30)}...`);
                }
                break;
                
            case 'paste':
                try {
                    await page.evaluate(() => document.readyState);
                } catch(e) {
                    addLog('warn', '⚠️ Page context lost, skipping paste');
                    return;
                }
                
                await page.mouse.click(params.x, params.y);
                await new Promise(r => setTimeout(r, 100));
                
                if (params.text) {
                    await page.evaluate((text) => {
                        const el = document.activeElement || document.querySelector('input, textarea, [contenteditable="true"]');
                        if (el) {
                            if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
                                el.textContent = text;
                            } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                                el.value = text;
                            }
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }, params.text);
                    
                    addLog('info', `📋 Text pasted: ${params.text.substring(0, 30)}...`);
                }
                break;
                
            case 'keyPress':
                await page.keyboard.press(params.key);
                break;
                
            case 'navigate':
                windowData.navigating = true;
                try {
                    await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
                    windowData.url = params.url;
                    addLog('info', `🧭 Navigated to: ${params.url}`);
                } catch(e) {
                    addLog('warn', `⚠️ Navigation timeout: ${params.url}`);
                }
                windowData.navigating = false;
                break;
                
            case 'refresh':
                try {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
                } catch(e) {}
                break;
                
            case 'goBack':
                try {
                    await page.goBack({ timeout: 5000 });
                    windowData.url = page.url();
                } catch(e) {}
                break;
                
            case 'goForward':
                try {
                    await page.goForward({ timeout: 5000 });
                    windowData.url = page.url();
                } catch(e) {}
                break;
        }
    } catch(e) {
        addLog('error', `❌ Interaction failed: ${action}`, { error: e.message.substring(0, 200) });
    }
}

// API эндпоинты
app.post('/api/interact', async (req, res) => {
    const { accountId, windowId, action, params } = req.body;
    const account = getAccount(accountId);
    const windowData = account.browsers.get(windowId);
    if (!windowData) {
        return res.json({ success: false, error: 'Window not found' });
    }
    await handleInteraction(windowData, action, params);
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
    res.json({ success: true });
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
        await windowData.browser.close().catch(() => {});
        account.browsers.delete(windowId);
        account.clients.get(windowId)?.forEach(ws => ws.close());
        account.clients.delete(windowId);
        account.hiddenWindows.delete(windowId);
        account.fpsStats.delete(windowId);
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
    res.json({ success: true });
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
            hidden: account.hiddenWindows.has(id),
            quality: data.quality
        });
    }
    res.json({ accountId, windows, hiddenCount: account.hiddenWindows.size });
});

// Эндпоинт для получения FPS статистики
app.get('/api/fps-stats/:accountId/:windowId', (req, res) => {
    const { accountId, windowId } = req.params;
    const account = getAccount(accountId);
    const stats = account.fpsStats.get(windowId);
    if (!stats) return res.json({ error: 'No stats' });
    res.json(stats);
});

app.get('/api/logs', (req, res) => {
    // Возвращаем последние 200 записей для скорости
    res.json(logBuffer.slice(-200));
});

app.get('/api/logs/all', (req, res) => {
    res.json(logBuffer);
});

app.post('/api/logs/clear', (req, res) => {
    logBuffer = [];
    saveLogs();
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
            windowId: id, url: data.url, autoScroll: data.autoScroll,
            title: data.customTitle || id, hidden: account.hiddenWindows.has(id),
            quality: data.quality
        });
    }
    res.json({ success: true, accountId, windows });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    addLog('success', `🚀 Live Browser Pro running on port ${PORT}`);
    console.log(`🌐 http://localhost:${PORT}`);
});

// Сохраняем логи при выходе
process.on('SIGTERM', async () => {
    addLog('warn', '🧹 Shutting down...');
    saveLogs();
    for (const [accountId, account] of accounts) {
        for (const [id, interval] of account.autoScrolls) clearInterval(interval);
        for (const [id, data] of account.browsers) {
            await data.browser.close().catch(() => {});
        }
    }
    server.close();
    process.exit(0);
});

// Сохраняем логи периодически
setInterval(() => {
    saveLogs();
}, 30000);
