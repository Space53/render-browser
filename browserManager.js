const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

class BrowserManager {
    constructor() {
        this.browsers = new Map();
        this.autoScrollIntervals = new Map();
        this.clickers = new Map();
        this.isInitialized = false;
    }

    async initialize() {
        try {
            // Проверяем доступность Chromium
            const executablePath = await chromium.executablePath();
            console.log('Chromium path:', executablePath);
            
            this.isInitialized = true;
            console.log('Browser Manager ready');
        } catch (error) {
            console.error('Initialization error:', error);
            throw error;
        }
    }

    async createWindow(windowId, url) {
        try {
            console.log(`Launching browser for window: ${windowId}`);
            
            // Запускаем браузер с настройками для Render
            const browser = await puppeteer.launch({
                args: [
                    ...chromium.args,
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
                },
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
                ignoreHTTPSErrors: true
            });

            const page = await browser.newPage();

            // Убираем детекцию автоматизации
            await page.evaluateOnNewDocument(() => {
                // Переопределяем navigator.webdriver
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => false,
                });

                // Переопределяем chrome.runtime
                window.chrome = {
                    runtime: {}
                };

                // Переопределяем permissions
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                        Promise.resolve({ state: Notification.permission }) :
                        originalQuery(parameters)
                );

                // Переопределяем plugins
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });

                // Переопределяем languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });
            });

            // Устанавливаем user agent
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // Переходим по URL
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            console.log(`Browser window ${windowId} created and navigated to ${url}`);

            // Сохраняем браузер
            this.browsers.set(windowId, {
                browser,
                page,
                url,
                createdAt: new Date()
            });

            return { windowId, url };

        } catch (error) {
            console.error(`Error creating window ${windowId}:`, error);
            throw error;
        }
    }

    async navigate(windowId, url) {
        const browserData = this.browsers.get(windowId);
        
        if (!browserData) {
            throw new Error(`Window ${windowId} not found`);
        }

        try {
            console.log(`Navigating ${windowId} to ${url}`);
            
            await browserData.page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            browserData.url = url;
            console.log(`Navigation complete for ${windowId}`);

        } catch (error) {
            console.error(`Navigation error for ${windowId}:`, error);
            
            // Пробуем перезапустить браузер при ошибке
            try {
                await browserData.browser.close();
            } catch (e) {
                console.error('Error closing browser:', e);
            }
            
            this.browsers.delete(windowId);
            
            // Создаем новое окно
            await this.createWindow(windowId, url);
        }
    }

    async executeAction(windowId, action) {
        const browserData = this.browsers.get(windowId);
        
        if (!browserData) {
            throw new Error(`Window ${windowId} not found`);
        }

        const page = browserData.page;

        try {
            switch (action) {
                case 'click':
                    await page.evaluate(() => {
                        const elements = document.querySelectorAll('a, button, input[type="submit"], [onclick]');
                        if (elements.length > 0) {
                            const randomElement = elements[Math.floor(Math.random() * elements.length)];
                            randomElement.click();
                        }
                    });
                    console.log(`Click action executed on ${windowId}`);
                    break;

                case 'scroll-down':
                    await page.evaluate(() => {
                        window.scrollBy({
                            top: 300,
                            behavior: 'smooth'
                        });
                    });
                    console.log(`Scroll down on ${windowId}`);
                    break;

                case 'scroll-up':
                    await page.evaluate(() => {
                        window.scrollBy({
                            top: -300,
                            behavior: 'smooth'
                        });
                    });
                    console.log(`Scroll up on ${windowId}`);
                    break;

                case 'refresh':
                    await page.reload({
                        waitUntil: 'networkidle2',
                        timeout: 30000
                    });
                    console.log(`Page refreshed on ${windowId}`);
                    break;

                case 'scroll-to-bottom':
                    await page.evaluate(() => {
                        window.scrollTo({
                            top: document.body.scrollHeight,
                            behavior: 'smooth'
                        });
                    });
                    console.log(`Scrolled to bottom on ${windowId}`);
                    break;

                case 'scroll-to-top':
                    await page.evaluate(() => {
                        window.scrollTo({
                            top: 0,
                            behavior: 'smooth'
                        });
                    });
                    console.log(`Scrolled to top on ${windowId}`);
                    break;

                case 'hover':
                    await page.evaluate(() => {
                        const elements = document.querySelectorAll('a, button, [onmouseover]');
                        if (elements.length > 0) {
                            const randomElement = elements[Math.floor(Math.random() * elements.length)];
                            const event = new MouseEvent('mouseover', {
                                view: window,
                                bubbles: true,
                                cancelable: true
                            });
                            randomElement.dispatchEvent(event);
                        }
                    });
                    console.log(`Hover action executed on ${windowId}`);
                    break;

                case 'type':
                    await page.evaluate(() => {
                        const inputs = document.querySelectorAll('input[type="text"], input[type="search"], textarea');
                        if (inputs.length > 0) {
                            const randomInput = inputs[Math.floor(Math.random() * inputs.length)];
                            randomInput.focus();
                            randomInput.value = 'Hello World';
                            const event = new Event('input', { bubbles: true });
                            randomInput.dispatchEvent(event);
                        }
                    });
                    console.log(`Type action executed on ${windowId}`);
                    break;

                default:
                    throw new Error(`Unknown action: ${action}`);
            }

            return { success: true, action, windowId };

        } catch (error) {
            console.error(`Action execution error on ${windowId}:`, error);
            throw error;
        }
    }

    async getScreenshot(windowId) {
        const browserData = this.browsers.get(windowId);
        
        if (!browserData) {
            return null;
        }

        try {
            const screenshot = await browserData.page.screenshot({
                encoding: 'base64',
                type: 'jpeg',
                quality: 40
            });

            return `data:image/jpeg;base64,${screenshot}`;

        } catch (error) {
            console.error(`Screenshot error for ${windowId}:`, error);
            return null;
        }
    }

    async getAllScreenshots() {
        const screenshots = {};
        
        for (const [windowId] of this.browsers) {
            try {
                const screenshot = await this.getScreenshot(windowId);
                if (screenshot) {
                    screenshots[windowId] = screenshot;
                }
            } catch (error) {
                console.error(`Error getting screenshot for ${windowId}:`, error);
            }
        }
        
        return screenshots;
    }

    startAutoScroll(windowIds, screenshotCallback) {
        // Очищаем существующие интервалы
        this.stopAutoScroll();

        windowIds.forEach(windowId => {
            const browserData = this.browsers.get(windowId);
            if (!browserData) return;

            const interval = setInterval(async () => {
                try {
                    // Прокручиваем страницу
                    await browserData.page.evaluate(() => {
                        const scrollHeight = document.documentElement.scrollHeight;
                        const currentScroll = window.pageYOffset;
                        const windowHeight = window.innerHeight;

                        if (currentScroll + windowHeight >= scrollHeight - 10) {
                            // Достигли низа - скроллим вверх
                            window.scrollTo({
                                top: 0,
                                behavior: 'smooth'
                            });
                        } else {
                            // Скроллим вниз
                            window.scrollBy({
                                top: 200,
                                behavior: 'smooth'
                            });
                        }
                    });

                    // Делаем скриншот и отправляем
                    if (screenshotCallback) {
                        const screenshot = await this.getScreenshot(windowId);
                        if (screenshot) {
                            screenshotCallback(windowId, screenshot);
                        }
                    }

                } catch (error) {
                    console.error(`Auto-scroll error for ${windowId}:`, error);
                }
            }, 3000); // Каждые 3 секунды

            this.autoScrollIntervals.set(windowId, interval);
            console.log(`Auto-scroll started for ${windowId}`);
        });
    }

    stopAutoScroll() {
        for (const [windowId, interval] of this.autoScrollIntervals) {
            clearInterval(interval);
            console.log(`Auto-scroll stopped for ${windowId}`);
        }
        this.autoScrollIntervals.clear();
    }

    addClicker(windowIds, type, interval = 5000, screenshotCallback) {
        const clickerId = Date.now().toString();
        console.log(`Adding clicker ${clickerId} of type ${type}`);

        const timer = setInterval(async () => {
            for (const windowId of windowIds) {
                try {
                    const browserData = this.browsers.get(windowId);
                    if (!browserData) continue;

                    const page = browserData.page;

                    switch (type) {
                        case 'click':
                            await page.evaluate(() => {
                                const elements = document.querySelectorAll('a, button, [onclick]');
                                if (elements.length > 0) {
                                    const randomElement = elements[Math.floor(Math.random() * elements.length)];
                                    randomElement.click();
                                }
                            });
                            break;

                        case 'scroll':
                            await page.evaluate(() => {
                                window.scrollBy({
                                    top: 200,
                                    behavior: 'smooth'
                                });
                            });
                            break;

                        case 'refresh':
                            await page.reload({
                                waitUntil: 'networkidle2',
                                timeout: 30000
                            });
                            break;

                        case 'hover':
                            await page.evaluate(() => {
                                const elements = document.querySelectorAll('a, button, [onmouseover]');
                                if (elements.length > 0) {
                                    const randomElement = elements[Math.floor(Math.random() * elements.length)];
                                    const event = new MouseEvent('mouseover', {
                                        view: window,
                                        bubbles: true,
                                        cancelable: true
                                    });
                                    randomElement.dispatchEvent(event);
                                }
                            });
                            break;

                        case 'type':
                            await page.evaluate(() => {
                                const inputs = document.querySelectorAll('input[type="text"], textarea');
                                if (inputs.length > 0) {
                                    const randomInput = inputs[Math.floor(Math.random() * inputs.length)];
                                    randomInput.focus();
                                    randomInput.value = 'Hello';
                                    randomInput.dispatchEvent(new Event('input', { bubbles: true }));
                                }
                            });
                            break;
                    }

                    // Отправляем скриншот после действия
                    if (screenshotCallback) {
                        const screenshot = await this.getScreenshot(windowId);
                        if (screenshot) {
                            screenshotCallback(windowId, screenshot);
                        }
                    }

                } catch (error) {
                    console.error(`Clicker error for ${windowId}:`, error);
                }
            }
        }, interval);

        this.clickers.set(clickerId, {
            timer,
            type,
            windowIds,
            interval,
            createdAt: new Date()
        });

        return clickerId;
    }

    removeClicker(clickerId) {
        const clicker = this.clickers.get(clickerId);
        if (clicker) {
            clearInterval(clicker.timer);
            this.clickers.delete(clickerId);
            console.log(`Clicker ${clickerId} removed`);
            return true;
        }
        return false;
    }

    getStatus() {
        return {
            activeWindows: this.browsers.size,
            activeClickers: this.clickers.size,
            autoScrollActive: this.autoScrollIntervals.size > 0,
            isInitialized: this.isInitialized,
            clickersList: Array.from(this.clickers.entries()).map(([id, data]) => ({
                id,
                type: data.type,
                interval: data.interval,
                createdAt: data.createdAt
            })),
            windowsList: Array.from(this.browsers.entries()).map(([id, data]) => ({
                id,
                url: data.url,
                createdAt: data.createdAt
            }))
        };
    }

    async cleanup() {
        console.log('Cleaning up Browser Manager...');

        // Останавливаем автоскролл
        this.stopAutoScroll();

        // Удаляем все кликеры
        for (const [clickerId] of this.clickers) {
            this.removeClicker(clickerId);
        }

        // Закрываем все браузеры
        for (const [windowId, browserData] of this.browsers) {
            try {
                await browserData.browser.close();
                console.log(`Browser ${windowId} closed`);
            } catch (error) {
                console.error(`Error closing browser ${windowId}:`, error);
            }
        }

        this.browsers.clear();
        console.log('Browser Manager cleaned up');
    }
}

module.exports = BrowserManager;
