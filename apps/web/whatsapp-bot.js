#!/usr/bin/env node
// ============================================================
// Skales WhatsApp Bot — Send-Only / Read & Write Gateway
// ============================================================
// Flow:
//   1. User clicks "Start WhatsApp" in Settings → spawns this process
//   2. QR code is generated → saved to whatsapp-status.json
//   3. User scans QR with WhatsApp on phone → session established
//   4. Session persists in .skales-data/integrations/whatsapp-session/
//   5. HTTP server on port 3009 accepts POST /send requests
//   6. Mode is read from whatsapp-mode.json:
//      - "sendOnly" (default): no message listener (privacy by design)
//      - "readWrite": incoming messages forwarded to /api/whatsapp/incoming
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const DATA_DIR = path.join(process.env.SKALES_DATA_DIR || path.join(os.homedir(), '.skales-data'), 'integrations');
const STATUS_FILE = path.join(DATA_DIR, 'whatsapp-status.json');
const MODE_FILE = path.join(DATA_DIR, 'whatsapp-mode.json');
const LOG_FILE = path.join(DATA_DIR, 'whatsapp-bot-error.log');
const BOT_PORT = 3009;
const NEXT_PORT = 3000; // Skales Next.js server

// ─── Mode Helper ─────────────────────────────────────────────

function getMode() {
    try {
        if (fs.existsSync(MODE_FILE)) {
            const data = JSON.parse(fs.readFileSync(MODE_FILE, 'utf-8'));
            return data.mode === 'readWrite' ? 'readWrite' : 'sendOnly';
        }
    } catch { }
    return 'sendOnly';
}

let currentMode = getMode();

// Forward an incoming message to the Next.js API for processing
async function forwardToSkales(msg) {
    try {
        const from = msg.from.replace(/@c\.us$/, '');
        const contact = await msg.getContact().catch(() => null);
        const senderName = contact?.pushname || contact?.name || from;
        const body = msg.body || '';

        if (!body.trim()) return; // skip empty messages

        log(`[ReadWrite] Incoming message from ${senderName} (${from}): "${body.slice(0, 60)}..."`);

        const payload = JSON.stringify({ message: body, from, senderName });
        const options = {
            hostname: '127.0.0.1',
            port: NEXT_PORT,
            path: '/api/whatsapp/incoming',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        };

        await new Promise((resolve, reject) => {
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => { log(`[ReadWrite] Skales replied (${res.statusCode})`); resolve(data); });
            });
            req.on('error', reject);
            req.setTimeout(190_000, () => { req.destroy(new Error('timeout')); });
            req.write(payload);
            req.end();
        });
    } catch (e) {
        logError('[ReadWrite] Failed to forward message to Skales', e);
    }
}

// ─── Logging ─────────────────────────────────────────────────

function log(msg) {
    const time = new Date().toLocaleTimeString('de-DE');
    console.log(`[${time}] ${msg}`);
}

function logError(msg, err) {
    const line = `[${new Date().toISOString()}] ${msg}${err ? ': ' + (err.stack || err.message || err) : ''}\n`;
    console.error(line.trim());
    try { fs.appendFileSync(LOG_FILE, line); } catch { }
}

// ─── Status File ─────────────────────────────────────────────

function ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function writeStatus(update) {
    try {
        ensureDirs();
        let current = {};
        try { current = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { }
        fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...current, ...update, updatedAt: Date.now() }, null, 2));
    } catch (e) {
        logError('Failed to write status', e);
    }
}

// ─── Chrome / Chromium Detection ─────────────────────────────
// whatsapp-web.js@1.26+ uses puppeteer-core which does NOT auto-download
// Chrome. We must find an installed browser ourselves.

function findChrome() {
    const os = process.platform;

    // 1. Try the puppeteer package (full, not -core) if installed alongside us.
    //    This is the most reliable path as it comes with a bundled Chromium.
    try {
        const puppeteer = require('puppeteer');
        const ep = typeof puppeteer.executablePath === 'function'
            ? puppeteer.executablePath()
            : puppeteer.executablePath;
        if (ep && fs.existsSync(ep)) {
            log(`Chrome found via puppeteer: ${ep}`);
            return ep;
        }
    } catch { /* puppeteer (full) not installed — fall through to system Chrome */ }

    // 2. Try well-known system Chrome / Chromium / Edge locations
    const candidates = [];

    if (os === 'win32') {
        const pf  = process.env.PROGRAMFILES        || 'C:\\Program Files';
        const pf86= process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const la  = process.env.LOCALAPPDATA         || '';
        candidates.push(
            `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
            `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
            `${la}\\Google\\Chrome\\Application\\chrome.exe`,
            `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
            `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        );
    } else if (os === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        );
    } else {
        // Linux
        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/brave-browser',
        );
    }

    const found = candidates.find(p => { try { return p && fs.existsSync(p); } catch { return false; } });
    if (found) log(`Chrome found at: ${found}`);
    return found || null;
}

// ─── WhatsApp Client ─────────────────────────────────────────

let client = null;
let isReady = false;

async function initClient() {
    try {
        const { Client, LocalAuth } = require('whatsapp-web.js');
        const QRCode = require('qrcode');

        log('Initializing WhatsApp client...');
        writeStatus({ state: 'initializing', qrCode: null, botPort: BOT_PORT, pid: process.pid });

        // ── Kill stale Chrome/Chromium processes from previous bot runs ──
        // These accumulate when the bot is stopped without a graceful shutdown.
        try {
            if (process.platform === 'win32') {
                // Only kill Chrome instances that were launched headlessly by Puppeteer
                // (they have --headless in their command line)
                const { execSync: ex } = require('child_process');
                ex(
                    `powershell -WindowStyle Hidden -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'chrome*' -or $_.Name -like 'chromium*') -and $_.CommandLine -like '*--headless*' -and $_.CommandLine -like '*--no-sandbox*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
                    { stdio: 'pipe', windowsHide: true }
                );
            }
            // On macOS/Linux pkill handles it, but Chrome orphans are rarer there
        } catch { /* non-fatal */ }

        // ── Chrome detection ────────────────────────────────
        const chromePath = findChrome();
        if (!chromePath) {
            const msg = process.platform === 'win32'
                ? 'Chrome not found. Please install Google Chrome from https://www.google.com/chrome/ and restart the WhatsApp bot.'
                : process.platform === 'darwin'
                ? 'Chrome not found. Please install Google Chrome from https://www.google.com/chrome/ and restart the WhatsApp bot.'
                : 'Chrome/Chromium not found. Install with: sudo apt install chromium-browser (or install Google Chrome).';
            logError('Chrome detection failed', new Error(msg));
            writeStatus({ state: 'error', error: msg, errorType: 'chrome_not_found' });
            return;
        }

        const sessionPath = path.join(DATA_DIR, 'whatsapp-session');

        // Set user agent based on actual OS so the linked device label matches
        const isWin = process.platform === 'win32';
        const isMac = process.platform === 'darwin';
        const userAgent = isWin
            ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            : isMac
                ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

        client = new Client({
            authStrategy: new LocalAuth({
                dataPath: sessionPath,
                clientId: 'skales-bot',
            }),
            puppeteer: {
                headless: true,
                executablePath: chromePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    `--user-agent=${userAgent}`,
                ],
            },
        });

        // QR Code Event — only fired when no saved session
        client.on('qr', async (qr) => {
            log('QR code received — waiting for scan...');
            try {
                const qrDataUrl = await QRCode.toDataURL(qr, {
                    width: 280,
                    margin: 2,
                    color: { dark: '#000000', light: '#ffffff' },
                });
                writeStatus({ state: 'qr', qrCode: qrDataUrl, phoneNumber: null, pushName: null });
            } catch (e) {
                logError('Failed to generate QR image', e);
            }
        });

        // Loading screen during auth restore
        client.on('loading_screen', (percent) => {
            log(`Loading: ${percent}%`);
            writeStatus({ state: 'loading', loadingPercent: percent });
        });

        // Successfully authenticated (QR scanned or session restored)
        client.on('authenticated', () => {
            log('Authenticated!');
            writeStatus({ state: 'authenticated', qrCode: null });
        });

        // Auth failure
        client.on('auth_failure', (msg) => {
            logError('Authentication failed', new Error(msg));
            writeStatus({ state: 'auth_failure', qrCode: null, error: msg });
            isReady = false;
        });

        // Fully ready
        client.on('ready', () => {
            isReady = true;
            const info = client.info;
            const phoneNumber = info?.wid?.user || null;
            const pushName = info?.pushname || null;
            log(`Ready! Logged in as ${pushName} (+${phoneNumber})`);
            writeStatus({
                state: 'ready',
                qrCode: null,
                phoneNumber,
                pushName,
                readyAt: Date.now(),
            });
        });

        // Disconnected
        client.on('disconnected', (reason) => {
            isReady = false;
            log(`Disconnected: ${reason}`);
            writeStatus({ state: 'disconnected', qrCode: null, phoneNumber: null, pushName: null, disconnectReason: reason });
        });

        // Message listener — only active in readWrite mode
        // Re-checks currentMode on every message so hot-reload works without restart
        client.on('message', async (msg) => {
            if (msg.isGroupMsg) return;   // ignore group messages
            if (msg.fromMe) return;       // ignore messages sent by us
            if (currentMode !== 'readWrite') return; // respect mode setting
            await forwardToSkales(msg);
        });

        client.initialize();
        log('Client initializing — please wait...');

    } catch (e) {
        logError('Failed to initialize WhatsApp client', e);
        writeStatus({ state: 'error', error: e.message });
        // If the package isn't installed, write a helpful error to the status file
        if (e.code === 'MODULE_NOT_FOUND') {
            const missing = e.message.includes('whatsapp-web.js') ? 'whatsapp-web.js'
                          : e.message.includes('qrcode')          ? 'qrcode'
                          : e.message.match(/Cannot find module '([^']+)'/)?.[1] || 'unknown';
            const helpMsg = `Missing npm package: "${missing}". Please run install.bat (Windows) or install.sh (macOS) again to reinstall all dependencies, then restart Skales.`;
            writeStatus({ state: 'error', error: helpMsg, errorType: 'module_not_found' });
        }
    }
}

// ─── HTTP Server (Send API) ───────────────────────────────────

const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    // GET /status — Return current status
    if (req.method === 'GET' && req.url === '/status') {
        try {
            const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
            res.writeHead(200);
            res.end(JSON.stringify({ ...status, isReady }));
        } catch {
            res.writeHead(200);
            res.end(JSON.stringify({ state: 'initializing', isReady: false }));
        }
        return;
    }

    // POST /send — Send a WhatsApp message
    if (req.method === 'POST' && req.url === '/send') {
        if (!isReady || !client) {
            res.writeHead(503);
            return res.end(JSON.stringify({ success: false, error: 'WhatsApp not ready yet. Please scan the QR code first.' }));
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { to, message } = JSON.parse(body);
                if (!to || !message) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: 'Missing required fields: to, message' }));
                }

                // Format phone: remove all non-digits
                const phone = to.replace(/[^0-9]/g, '');
                if (!phone || phone.length < 7) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: 'Invalid phone number' }));
                }

                const chatId = `${phone}@c.us`;
                log(`Sending message to ${chatId}...`);
                await client.sendMessage(chatId, message);
                log(`Message sent to ${chatId}`);
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, to: chatId }));
            } catch (e) {
                logError('Failed to send message', e);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // POST /sendMedia — Send a WhatsApp media message
    if (req.method === 'POST' && req.url === '/sendMedia') {
        if (!isReady || !client) {
            res.writeHead(503);
            return res.end(JSON.stringify({ success: false, error: 'WhatsApp not ready yet. Please scan the QR code first.' }));
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { to, filePath, caption } = JSON.parse(body);
                if (!to || !filePath) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: 'Missing required fields: to, filePath' }));
                }

                if (!fs.existsSync(filePath)) {
                    res.writeHead(404);
                    return res.end(JSON.stringify({ error: 'File not found: ' + filePath }));
                }

                const { MessageMedia } = require('whatsapp-web.js');
                const media = MessageMedia.fromFilePath(filePath);

                // Format phone: remove all non-digits
                const phone = to.replace(/[^0-9]/g, '');
                if (!phone || phone.length < 7) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: 'Invalid phone number' }));
                }

                const chatId = `${phone}@c.us`;
                log(`Sending media to ${chatId}: ${filePath}`);
                await client.sendMessage(chatId, media, { caption: caption || '' });
                log(`Media sent to ${chatId}`);
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, to: chatId }));
            } catch (e) {
                logError('Failed to send media', e);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // POST /reload-mode — Hot-reload the mode setting without restarting
    if (req.method === 'POST' && req.url === '/reload-mode') {
        const prev = currentMode;
        currentMode = getMode();
        log(`Mode reloaded: ${prev} → ${currentMode}`);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, mode: currentMode }));
        return;
    }

    // POST /logout — Disconnect and clear session
    if (req.method === 'POST' && req.url === '/logout') {
        try {
            if (client) {
                await client.logout().catch(() => { });
            }
            isReady = false;
            writeStatus({ state: 'disconnected', qrCode: null, phoneNumber: null, pushName: null });

            // Delete session folder
            const sessionPath = path.join(DATA_DIR, 'whatsapp-session');
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                log('Session deleted.');
            }

            res.writeHead(200);
            res.end(JSON.stringify({ success: true }));
        } catch (e) {
            logError('Logout error', e);
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // POST /stop — Graceful shutdown
    if (req.method === 'POST' && req.url === '/stop') {
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        log('Stop requested — shutting down...');
        writeStatus({ state: 'disconnected', botPort: null, pid: null });
        setTimeout(() => process.exit(0), 500);
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        logError(`Port ${BOT_PORT} already in use — killing old process and retrying...`, null);
        log(`⚠️ Port ${BOT_PORT} in use — attempting to free it...`);

        // Kill the process using this port, then retry after a short delay
        const { execSync } = require('child_process');
        try {
            if (process.platform === 'win32') {
                // Windows: find PID using port 3009 and kill it (windowsHide suppresses CMD flash)
                const result = execSync(`netstat -ano | findstr :${BOT_PORT}`, { encoding: 'utf8', windowsHide: true });
                const lines = result.trim().split('\n');
                for (const line of lines) {
                    if (line.includes('LISTENING')) {
                        const pid = line.trim().split(/\s+/).pop();
                        if (pid && pid !== String(process.pid)) {
                            try { execSync(`taskkill /F /PID ${pid}`, { windowsHide: true }); } catch { }
                        }
                    }
                }
            } else {
                // macOS/Linux: use lsof to find and kill process on port
                execSync(`lsof -ti :${BOT_PORT} | xargs kill -9 2>/dev/null || true`);
            }
        } catch (killErr) {
            log(`Could not auto-kill old process: ${killErr.message}`);
        }

        // Retry binding after 1.5s
        setTimeout(() => {
            log(`Retrying HTTP server on port ${BOT_PORT}...`);
            server.listen(BOT_PORT, '127.0.0.1', () => {
                log(`HTTP server running on http://127.0.0.1:${BOT_PORT} (after recovery)`);
                initClient();
            });
        }, 1500);
    }
});

// ─── Startup ─────────────────────────────────────────────────

ensureDirs();
log('Skales WhatsApp Bot starting...');

// Start HTTP server FIRST, then init WhatsApp client.
// This ensures the server is ready to serve QR polling requests before Puppeteer fires the QR event.
server.listen(BOT_PORT, '127.0.0.1', () => {
    log(`HTTP server running on http://127.0.0.1:${BOT_PORT}`);
    initClient();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    log('Shutting down...');
    writeStatus({ state: 'disconnected', botPort: null, pid: null });
    try { if (client) await client.destroy(); } catch { }
    process.exit(0);
});
process.on('SIGTERM', async () => {
    writeStatus({ state: 'disconnected', botPort: null, pid: null });
    try { if (client) await client.destroy(); } catch { }
    process.exit(0);
});
