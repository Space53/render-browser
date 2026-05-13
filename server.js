const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Хранилище браузеров
const browsers = new Map();
const autoScrollIntervals = new Map();
const clickers = new Map();

// Запуск браузера
async function launchBrowser() {
    return await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--window-size=1280,720'
        ],
        defaultViewport: {
            width: 1280,
            height: 720
        }
    });
}

// Создание окна браузера
async function createBrowserWindow(windowId, url) {
    try {
        console.log(`Creating window ${windowId} for ${url}`);
        
        const browser = await launchBrowser();
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        
        browsers.set(windowId, { browser, page, url });
        console.log(`Window ${windowId} created successfully`);
        
        return { success: true, windowId };
        
    } catch (error) {
        console.error(`Error creating window ${windowId}:`, error.message);
        throw error;
    }
}

// Получение скриншота
async function getScreenshot(windowId) {
    const data = browsers.get(windowId);
    if (!data) return null;
    
    try {
        const screenshot = await data.page.screenshot({
            encoding: 'base64',
            type: 'jpeg',
            quality: 40
        });
        return `data:image/jpeg;base64,${screenshot}`;
    } catch (error) {
        console.error(`Screenshot error ${windowId}:`, error.message);
        return null;
    }
}

// WebSocket обработчики
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Создание окна
    socket.on('create-window', async (data) => {
        try {
            const { windowId, url } = data;
            await createBrowserWindow(windowId, url);
            
            const screenshot = await getScreenshot(windowId);
            socket.emit('screenshot-update', { windowId, screenshot });
            socket.emit('window-created', { success: true, windowId });
            
        } catch (error) {
            socket.emit('window-created', { success: false, error: error.message });
        }
    });
    
    // Навигация во всех окнах
    socket.on('navigate-all', async (data) => {
        try {
            const { url, windowIds } = data;
            
            for (const windowId of windowIds) {
                const browserData = browsers.get(windowId);
                if (!browserData) {
                    await createBrowserWindow(windowId, url);
                } else {
                    await browserData.page.goto(url, {
                        waitUntil: 'networkidle2',
                        timeout: 30000
                    });
                    browserData.url = url;
                }
                
                const screenshot = await getScreenshot(windowId);
                socket.emit('screenshot-update', { windowId, screenshot });
            }
            
            socket.emit('navigate-all-complete', { success: true });
            
        } catch (error) {
            socket.emit('navigate-all-complete', { success: false, error: error.message });
        }
    });
    
    // Выполнение действия
    socket.on('execute-action', async (data) => {
        try {
            const { windowId, action } = data;
            const browserData = browsers.get(windowId);
            if (!browserData) return;
            
            const page = browserData.page;
            
            switch(action) {
                case 'refresh':
                    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    break;
                case 'scroll-down':
                    await page.evaluate(() => window.scrollBy(0, 300));
                    break;
                case 'click':
                    await page.evaluate(() => {
                        const el = document.querySelectorAll('a, button');
                        if (el.length) el[Math.floor(Math.random() * el.length)].click();
                    });
                    break;
            }
            
            const screenshot = await getScreenshot(windowId);
            socket.emit('screenshot-update', { windowId, screenshot });
            socket.emit('action-complete', { success: true, windowId, action });
            
        } catch (error) {
            socket.emit('action-complete', { success: false, error: error.message });
        }
    });
    
    // Автоскролл
    socket.on('start-auto-scroll', async (data) => {
        try {
            const { windowIds } = data;
            
            // Очищаем старые
            for (const [id, interval] of autoScrollIntervals) {
                clearInterval(interval);
            }
            autoScrollIntervals.clear();
            
            // Запускаем новые
            for (const windowId of windowIds) {
                const interval = setInterval(async () => {
                    const browserData = browsers.get(windowId);
                    if (!browserData) return;
                    
                    try {
                        await browserData.page.evaluate(() => {
                            const h = document.documentElement.scrollHeight;
                            const s = window.pageYOffset;
                            if (s + window.innerHeight >= h - 10) {
                                window.scrollTo(0, 0);
                            } else {
                                window.scrollBy(0, 200);
                            }
                        });
                        
                        const screenshot = await getScreenshot(windowId);
                        if (screenshot) {
                            socket.emit('screenshot-update', { windowId, screenshot });
                        }
                    } catch (e) {
                        console.error(`Auto-scroll error ${windowId}:`, e.message);
                    }
                }, 3000);
                
                autoScrollIntervals.set(windowId, interval);
            }
            
            socket.emit('auto-scroll-started', { success: true });
            
        } catch (error) {
            socket.emit('auto-scroll-started', { success: false, error: error.message });
        }
    });
    
    // Остановка автоскролла
    socket.on('stop-auto-scroll', () => {
        for (const [id, interval] of autoScrollIntervals) {
            clearInterval(interval);
        }
        autoScrollIntervals.clear();
        socket.emit('auto-scroll-stopped', { success: true });
    });
    
    // Добавление кликера
    socket.on('add-clicker', async (data) => {
        try {
            const { windowIds, type, interval } = data;
            const clickerId = Date.now().toString();
            
            const timer = setInterval(async () => {
                for (const windowId of windowIds) {
                    const browserData = browsers.get(windowId);
                    if (!browserData) continue;
                    
                    try {
                        switch(type) {
                            case 'click':
                                await browserData.page.evaluate(() => {
                                    const el = document.querySelectorAll('a, button');
                                    if (el.length) el[Math.floor(Math.random() * el.length)].click();
                                });
                                break;
                            case 'scroll':
                                await browserData.page.evaluate(() => window.scrollBy(0, 200));
                                break;
                            case 'refresh':
                                await browserData.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                                break;
                            case 'hover':
                                await browserData.page.evaluate(() => {
                                    const el = document.querySelectorAll('a, button');
                                    if (el.length) {
                                        const e = el[Math.floor(Math.random() * el.length)];
                                        e.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                                    }
                                });
                                break;
                            case 'type':
                                await browserData.page.evaluate(() => {
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
                        
                        const screenshot = await getScreenshot(windowId);
                        if (screenshot) {
                            socket.emit('screenshot-update', { windowId, screenshot });
                        }
                    } catch (e) {
                        console.error(`Clicker error:`, e.message);
                    }
                }
            }, interval || 5000);
            
            clickers.set(clickerId, { timer, type, windowIds });
            socket.emit('clicker-added', { success: true, clickerId, type });
            
        } catch (error) {
            socket.emit('clicker-added', { success: false, error: error.message });
        }
    });
    
    // Удаление кликера
    socket.on('remove-clicker', (data) => {
        const { clickerId } = data;
        const clicker = clickers.get(clickerId);
        if (clicker) {
            clearInterval(clicker.timer);
            clickers.delete(clickerId);
        }
        socket.emit('clicker-removed', { success: true, clickerId });
    });
    
    // Получение всех скриншотов
    socket.on('get-all-screenshots', async () => {
        for (const [windowId] of browsers) {
            const screenshot = await getScreenshot(windowId);
            if (screenshot) {
                socket.emit('screenshot-update', { windowId, screenshot });
            }
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Очистка при завершении
process.on('SIGTERM', async () => {
    console.log('Cleaning up...');
    for (const [id, interval] of autoScrollIntervals) {
        clearInterval(interval);
    }
    for (const [id, clicker] of clickers) {
        clearInterval(clicker.timer);
    }
    for (const [id, data] of browsers) {
        await data.browser.close();
    }
    server.close();
    process.exit(0);
});
