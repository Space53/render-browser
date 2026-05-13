const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const BrowserManager = require('./browserManager');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Статические файлы
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Инициализация менеджера браузеров
const browserManager = new BrowserManager();

// WebSocket соединение
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Создание окна браузера
    socket.on('create-window', async (data) => {
        try {
            const { windowId, url } = data;
            console.log(`Creating window ${windowId} with URL: ${url}`);
            
            const result = await browserManager.createWindow(windowId, url);
            
            socket.emit('window-created', {
                success: true,
                windowId: result.windowId
            });
            
            // Отправляем первый скриншот
            const screenshot = await browserManager.getScreenshot(windowId);
            socket.emit('screenshot-update', {
                windowId,
                screenshot
            });
            
        } catch (error) {
            console.error('Create window error:', error);
            socket.emit('window-created', {
                success: false,
                error: error.message
            });
        }
    });
    
    // Навигация
    socket.on('navigate', async (data) => {
        try {
            const { windowId, url } = data;
            console.log(`Navigating ${windowId} to ${url}`);
            
            await browserManager.navigate(windowId, url);
            
            // Отправляем обновленный скриншот
            const screenshot = await browserManager.getScreenshot(windowId);
            socket.emit('screenshot-update', {
                windowId,
                screenshot
            });
            
            socket.emit('navigate-complete', {
                success: true,
                windowId
            });
            
        } catch (error) {
            console.error('Navigate error:', error);
            socket.emit('navigate-complete', {
                success: false,
                error: error.message
            });
        }
    });
    
    // Навигация во всех окнах
    socket.on('navigate-all', async (data) => {
        try {
            const { url, windowIds } = data;
            console.log(`Navigating all windows to ${url}`);
            
            for (const windowId of windowIds) {
                await browserManager.navigate(windowId, url);
                
                const screenshot = await browserManager.getScreenshot(windowId);
                socket.emit('screenshot-update', {
                    windowId,
                    screenshot
                });
            }
            
            socket.emit('navigate-all-complete', {
                success: true
            });
            
        } catch (error) {
            console.error('Navigate all error:', error);
            socket.emit('navigate-all-complete', {
                success: false,
                error: error.message
            });
        }
    });
    
    // Выполнение действия
    socket.on('execute-action', async (data) => {
        try {
            const { windowId, action } = data;
            console.log(`Executing ${action} on ${windowId}`);
            
            await browserManager.executeAction(windowId, action);
            
            // Отправляем обновленный скриншот
            const screenshot = await browserManager.getScreenshot(windowId);
            socket.emit('screenshot-update', {
                windowId,
                screenshot
            });
            
            socket.emit('action-complete', {
                success: true,
                windowId,
                action
            });
            
        } catch (error) {
            console.error('Action error:', error);
            socket.emit('action-complete', {
                success: false,
                error: error.message
            });
        }
    });
    
    // Запуск автоскролла
    socket.on('start-auto-scroll', async (data) => {
        try {
            const { windowIds } = data;
            console.log('Starting auto-scroll for:', windowIds);
            
            // Очищаем старые интервалы
            browserManager.stopAutoScroll();
            
            // Запускаем новый автоскролл
            browserManager.startAutoScroll(windowIds, (windowId, screenshot) => {
                socket.emit('screenshot-update', {
                    windowId,
                    screenshot
                });
            });
            
            socket.emit('auto-scroll-started', { success: true });
            
        } catch (error) {
            console.error('Auto-scroll start error:', error);
            socket.emit('auto-scroll-started', {
                success: false,
                error: error.message
            });
        }
    });
    
    // Остановка автоскролла
    socket.on('stop-auto-scroll', async () => {
        try {
            console.log('Stopping auto-scroll');
            browserManager.stopAutoScroll();
            
            socket.emit('auto-scroll-stopped', { success: true });
            
        } catch (error) {
            console.error('Auto-scroll stop error:', error);
            socket.emit('auto-scroll-stopped', {
                success: false,
                error: error.message
            });
        }
    });
    
    // Добавление кликера
    socket.on('add-clicker', async (data) => {
        try {
            const { windowIds, type, interval } = data;
            console.log(`Adding clicker: ${type}`);
            
            const clickerId = browserManager.addClicker(
                windowIds, 
                type, 
                interval,
                (windowId, screenshot) => {
                    socket.emit('screenshot-update', {
                        windowId,
                        screenshot
                    });
                }
            );
            
            socket.emit('clicker-added', {
                success: true,
                clickerId,
                type
            });
            
        } catch (error) {
            console.error('Add clicker error:', error);
            socket.emit('clicker-added', {
                success: false,
                error: error.message
            });
        }
    });
    
    // Удаление кликера
    socket.on('remove-clicker', async (data) => {
        try {
            const { clickerId } = data;
            console.log(`Removing clicker: ${clickerId}`);
            
            browserManager.removeClicker(clickerId);
            
            socket.emit('clicker-removed', {
                success: true,
                clickerId
            });
            
        } catch (error) {
            console.error('Remove clicker error:', error);
            socket.emit('clicker-removed', {
                success: false,
                error: error.message
            });
        }
    });
    
    // Получение всех скриншотов
    socket.on('get-all-screenshots', async () => {
        try {
            const screenshots = await browserManager.getAllScreenshots();
            
            for (const [windowId, screenshot] of Object.entries(screenshots)) {
                socket.emit('screenshot-update', {
                    windowId,
                    screenshot
                });
            }
            
        } catch (error) {
            console.error('Get screenshots error:', error);
        }
    });
    
    // Статус
    socket.on('get-status', () => {
        const status = browserManager.getStatus();
        socket.emit('status-update', status);
    });
    
    // Отключение клиента
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// REST API для проверки работоспособности
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        chromium: true,
        puppeteer: true
    });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Health check: http://localhost:${PORT}/health`);
    
    // Инициализация браузерного менеджера
    try {
        await browserManager.initialize();
        console.log('✅ Browser Manager initialized successfully');
    } catch (error) {
        console.error('❌ Browser Manager initialization failed:', error);
    }
});

// Обработка завершения
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Cleaning up...');
    await browserManager.cleanup();
    server.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received. Cleaning up...');
    await browserManager.cleanup();
    server.close();
    process.exit(0);
});
