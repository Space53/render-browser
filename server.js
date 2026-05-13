const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const browsers = new Map();
const autoScrollIntervals = new Map();
const clickers = new Map();

async function launchBrowser() {
    return await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true
    });
}

async function createBrowserWindow(windowId, url) {
    try {
        const browser = await launchBrowser();
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        browsers.set(windowId, { browser, page, url });
        return { success: true, windowId };
    } catch (error) {
        console.error('Create window error:', error.message);
        throw error;
    }
}

async function getScreenshot(windowId) {
    const data = browsers.get(windowId);
    if (!data) return null;
    try {
        const screenshot = await data.page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 40 });
        return `data:image/jpeg;base64,${screenshot}`;
    } catch (e) {
        return null;
    }
}

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    
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
    
    socket.on('navigate-all', async (data) => {
        try {
            const { url, windowIds } = data;
            for (const windowId of windowIds) {
                const d = browsers.get(windowId);
                if (!d) {
                    await createBrowserWindow(windowId, url);
                } else {
                    await d.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                    d.url = url;
                }
                const screenshot = await getScreenshot(windowId);
                socket.emit('screenshot-update', { windowId, screenshot });
            }
            socket.emit('navigate-all-complete', { success: true });
        } catch (error) {
            socket.emit('navigate-all-complete', { success: false, error: error.message });
        }
    });
    
    socket.on('execute-action', async (data) => {
        try {
            const { windowId, action } = data;
            const d = browsers.get(windowId);
            if (!d) return;
            
            if (action === 'refresh') {
                await d.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
            } else if (action === 'scroll-down') {
                await d.page.evaluate(() => window.scrollBy(0, 300));
            } else if (action === 'click') {
                await d.page.evaluate(() => {
                    const el = document.querySelectorAll('a, button');
                    if (el.length) el[Math.floor(Math.random() * el.length)].click();
                });
            }
            
            const screenshot = await getScreenshot(windowId);
            socket.emit('screenshot-update', { windowId, screenshot });
            socket.emit('action-complete', { success: true });
        } catch (error) {
            socket.emit('action-complete', { success: false, error: error.message });
        }
    });
    
    socket.on('start-auto-scroll', async (data) => {
        for (const [id, interval] of autoScrollIntervals) clearInterval(interval);
        autoScrollIntervals.clear();
        
        for (const windowId of data.windowIds) {
            const interval = setInterval(async () => {
                const d = browsers.get(windowId);
                if (!d) return;
                try {
                    await d.page.evaluate(() => {
                        const h = document.documentElement.scrollHeight;
                        const s = window.pageYOffset;
                        if (s + window.innerHeight >= h - 10) {
                            window.scrollTo(0, 0);
                        } else {
                            window.scrollBy(0, 200);
                        }
                    });
                    const screenshot = await getScreenshot(windowId);
                    if (screenshot) socket.emit('screenshot-update', { windowId, screenshot });
                } catch (e) {}
            }, 3000);
            autoScrollIntervals.set(windowId, interval);
        }
        socket.emit('auto-scroll-started', { success: true });
    });
    
    socket.on('stop-auto-scroll', () => {
        for (const [id, interval] of autoScrollIntervals) clearInterval(interval);
        autoScrollIntervals.clear();
        socket.emit('auto-scroll-stopped', { success: true });
    });
    
    socket.on('add-clicker', async (data) => {
        const { windowIds, type, interval } = data;
        const clickerId = Date.now().toString();
        
        const timer = setInterval(async () => {
            for (const windowId of windowIds) {
                const d = browsers.get(windowId);
                if (!d) continue;
                try {
                    switch(type) {
                        case 'click':
                            await d.page.evaluate(() => {
                                const el = document.querySelectorAll('a, button');
                                if (el.length) el[Math.floor(Math.random() * el.length)].click();
                            });
                            break;
                        case 'scroll':
                            await d.page.evaluate(() => window.scrollBy(0, 200));
                            break;
                        case 'refresh':
                            await d.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                            break;
                    }
                    const screenshot = await getScreenshot(windowId);
                    if (screenshot) socket.emit('screenshot-update', { windowId, screenshot });
                } catch (e) {}
            }
        }, interval || 5000);
        
        clickers.set(clickerId, { timer, type });
        socket.emit('clicker-added', { success: true, clickerId, type });
    });
    
    socket.on('remove-clicker', (data) => {
        const clicker = clickers.get(data.clickerId);
        if (clicker) {
            clearInterval(clicker.timer);
            clickers.delete(data.clickerId);
        }
        socket.emit('clicker-removed', { success: true });
    });
    
    socket.on('get-all-screenshots', async () => {
        for (const [windowId] of browsers) {
            const screenshot = await getScreenshot(windowId);
            if (screenshot) socket.emit('screenshot-update', { windowId, screenshot });
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));

process.on('SIGTERM', async () => {
    for (const [id, interval] of autoScrollIntervals) clearInterval(interval);
    for (const [id, clicker] of clickers) clearInterval(clicker.timer);
    for (const [id, data] of browsers) await data.browser.close();
    server.close();
    process.exit(0);
});
