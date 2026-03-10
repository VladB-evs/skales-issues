'use server';

import { DATA_DIR } from '@/lib/paths';
import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';

// ─── Types ─────────────────────────────────────────────────────

export interface BrowserControlConfig {
    visionProvider: 'google' | 'openai' | 'anthropic' | 'openrouter';
    visionApiKey: string;
    visionModel: string;
    // Vision "Use for:" settings
    visionUseForChat?: boolean;
    visionUseForTelegram?: boolean;
    visionUseForWhatsApp?: boolean;
    visionUseForScreenshots?: boolean;
    visionUseForBrowser?: boolean;
    autoApproveNavigation: boolean;
    requireApprovalForLogin: boolean;
    requireApprovalForForms: boolean;
    requireApprovalForPurchases: boolean;
    requireApprovalForDownloads: boolean;
    maxSessionMinutes: number;
    installed?: boolean; // Tracks whether Chromium has been downloaded
}

export interface BrowserActionResult {
    success: boolean;
    description?: string;
    screenshotUrl?: string;
    screenshotFilePath?: string; // Absolute local path for sending as file (e.g., Telegram)
    url?: string;
    error?: string;
    requiresApproval?: boolean;
    approvalMessage?: string;
}

// ─── Constants ─────────────────────────────────────────────────

const CONFIG_FILE = path.join(DATA_DIR, 'browser-control.json');
// Screenshots are saved in workspace/browser-screenshots/ inside DATA_DIR (writable at runtime)
// and served via the /api/file?path=browser-screenshots/<file> route
const SCREENSHOTS_PUBLIC_DIR = path.join(DATA_DIR, 'workspace', 'browser-screenshots');
// Desktop screenshots are also saved here for user file access and Telegram sending
const SCREENSHOTS_WORKSPACE_DIR = path.join(DATA_DIR, 'workspace', 'screenshots');

// ─── Module-Level Session ──────────────────────────────────────
// Next.js server actions run in the same Node.js process, so module-level
// variables persist across calls within a single server lifecycle.
// Session is intentionally NOT persisted across restarts (per spec).

// eslint-disable-next-line prefer-const
let _browser: any = null;
// eslint-disable-next-line prefer-const
let _page: any = null;
let _sessionStartTime: number | null = null;

// ─── Config ────────────────────────────────────────────────────

const DEFAULT_CONFIG: BrowserControlConfig = {
    visionProvider: 'google',
    visionApiKey: '',
    visionModel: 'gemini-2.0-flash',
    visionUseForChat: false,
    visionUseForTelegram: false,
    visionUseForWhatsApp: false,
    visionUseForScreenshots: true,
    visionUseForBrowser: true,
    autoApproveNavigation: false,
    requireApprovalForLogin: true,
    requireApprovalForForms: true,
    requireApprovalForPurchases: true,
    requireApprovalForDownloads: true,
    maxSessionMinutes: 15,
    installed: false,
};

export async function getBrowserControlConfig(): Promise<BrowserControlConfig> {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
        }
    } catch { /* fallback to defaults */ }
    return { ...DEFAULT_CONFIG };
}

export async function saveBrowserControlConfig(config: Partial<BrowserControlConfig>): Promise<{ success: boolean; error?: string }> {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const current = await getBrowserControlConfig();
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...current, ...config }, null, 2));
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

// ─── Install Check / Install ────────────────────────────────────

export async function isBrowserControlInstalled(): Promise<boolean> {
    try {
        // Check both the config flag AND whether playwright module files actually exist on disk.
        // Using fs.existsSync avoids the webpack bundling issue of require.resolve.
        const playwrightDir = path.join(process.cwd(), 'node_modules', 'playwright');
        const playwrightCoreDir = path.join(process.cwd(), 'node_modules', 'playwright-core');
        const playwrightExists = fs.existsSync(playwrightDir) || fs.existsSync(playwrightCoreDir);
        if (!playwrightExists) return false;
        const cfg = await getBrowserControlConfig();
        return cfg.installed === true;
    } catch {
        return false;
    }
}

export async function installBrowserControl(): Promise<{ success: boolean; output?: string; error?: string }> {
    // Step 1: npm install playwright  (installs the npm package into node_modules)
    // Step 2: npx playwright install chromium  (downloads the Chromium browser binary)
    // These MUST be two separate calls — chaining with && is unreliable on Windows.

    const runCommand = (cmd: string, args: string[]): Promise<{ code: number; output: string }> =>
        new Promise((resolve) => {
            let out = '';
            const proc = spawn(cmd, args, {
                cwd: process.cwd(),
                shell: process.platform === 'win32',
                env: { ...process.env },
            });
            proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
            proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
            proc.on('close', (code: number | null) => resolve({ code: code ?? 1, output: out }));
            proc.on('error', (e: Error) => resolve({ code: 1, output: e.message }));
        });

    // ── Command 1: install npm package ───────────────────────────
    const step1 = await runCommand('npm', ['install', 'playwright']);
    if (step1.code !== 0) {
        return { success: false, output: step1.output, error: `npm install playwright failed (exit ${step1.code})` };
    }

    // ── Command 2: download Chromium binary ──────────────────────
    const step2 = await runCommand('npx', ['playwright', 'install', 'chromium']);
    if (step2.code !== 0) {
        return { success: false, output: step1.output + '\n' + step2.output, error: `playwright install chromium failed (exit ${step2.code})` };
    }

    // Both steps succeeded — mark installed
    await saveBrowserControlConfig({ installed: true });
    return { success: true, output: step1.output + '\n' + step2.output };
}

// ─── Vision LLM Helper ─────────────────────────────────────────
// Makes direct fetch calls to the configured vision provider.
// Kept self-contained to avoid circular imports with orchestrator.ts.

async function callVisionLLM(screenshotBase64: string, prompt: string, cfg: BrowserControlConfig): Promise<string> {
    if (!cfg.visionApiKey) return 'No vision API key configured — cannot analyze screenshot.';

    try {
        if (cfg.visionProvider === 'google') {
            const model = cfg.visionModel || 'gemini-2.0-flash';
            const resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cfg.visionApiKey}`,
                {
                    method: 'POST',
                    signal: AbortSignal.timeout(30_000),
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            role: 'user',
                            parts: [
                                { inlineData: { data: screenshotBase64, mimeType: 'image/png' } },
                                { text: prompt },
                            ],
                        }],
                        generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
                    }),
                }
            );
            if (!resp.ok) throw new Error(`Google Vision API error: ${resp.status}`);
            const data = await resp.json();
            return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No vision response.';
        }

        if (cfg.visionProvider === 'openai' || cfg.visionProvider === 'openrouter') {
            const baseUrl = cfg.visionProvider === 'openai'
                ? 'https://api.openai.com/v1'
                : 'https://openrouter.ai/api/v1';
            const resp = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                signal: AbortSignal.timeout(30_000),
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cfg.visionApiKey}`,
                },
                body: JSON.stringify({
                    model: cfg.visionModel || 'gpt-4o',
                    max_tokens: 1024,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}` } },
                            { type: 'text', text: prompt },
                        ],
                    }],
                }),
            });
            if (!resp.ok) throw new Error(`Vision API error: ${resp.status}`);
            const data = await resp.json();
            return data.choices?.[0]?.message?.content || 'No vision response.';
        }

        if (cfg.visionProvider === 'anthropic') {
            const resp = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                signal: AbortSignal.timeout(30_000),
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': cfg.visionApiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: cfg.visionModel || 'claude-sonnet-4-20250514',
                    max_tokens: 1024,
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 } },
                            { type: 'text', text: prompt },
                        ],
                    }],
                }),
            });
            if (!resp.ok) throw new Error(`Anthropic Vision error: ${resp.status}`);
            const data = await resp.json();
            return data.content?.[0]?.text || 'No vision response.';
        }

        return 'Unsupported vision provider.';
    } catch (e: any) {
        return `Vision analysis failed: ${e.message}`;
    }
}

/**
 * Public helper: analyze any image (given as a data-URI or raw base64) using
 * the configured Vision Provider. Used by Telegram and WhatsApp routes when
 * the main LLM is not vision-capable or when visionUseForTelegram is enabled.
 *
 * @param dataUri  The image as a data-URI (data:image/jpeg;base64,...) or raw base64 string
 * @param prompt   The analysis prompt (defaults to a comprehensive description request)
 * @returns        A plain-text description of the image contents
 */
export async function analyzeImageWithVisionProvider(
    dataUri: string,
    prompt?: string,
): Promise<{ success: boolean; description?: string; error?: string }> {
    try {
        const cfg = await getBrowserControlConfig();
        if (!cfg.visionApiKey) {
            return { success: false, error: 'Vision Provider not configured (no API key).' };
        }

        // Strip data-URI prefix to get raw base64
        const base64 = dataUri.startsWith('data:')
            ? dataUri.replace(/^data:[^;]+;base64,/, '')
            : dataUri;

        const analysisPrompt = prompt ??
            'Describe this image in detail. Include: what is shown, any text visible, ' +
            'colors, people, objects, scene, mood, and any other relevant details. ' +
            'Be thorough but concise.';

        const description = await callVisionLLM(base64, analysisPrompt, cfg);
        return { success: true, description };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

// ─── Screenshot Helper ──────────────────────────────────────────

async function captureScreenshot(): Promise<{ base64: string; publicUrl: string }> {
    if (!_page) throw new Error('No active browser session');

    if (!fs.existsSync(SCREENSHOTS_PUBLIC_DIR)) {
        fs.mkdirSync(SCREENSHOTS_PUBLIC_DIR, { recursive: true });
    }

    const filename = `browser-${Date.now()}.png`;
    const filePath = path.join(SCREENSHOTS_PUBLIC_DIR, filename);

    await _page.screenshot({ path: filePath, fullPage: false });
    const base64 = fs.readFileSync(filePath).toString('base64');

    // Keep only the last 15 screenshots (clean up older ones)
    try {
        const allFiles = fs.readdirSync(SCREENSHOTS_PUBLIC_DIR)
            .filter(f => f.startsWith('browser-') && f.endsWith('.png'))
            .sort();
        if (allFiles.length > 15) {
            allFiles.slice(0, allFiles.length - 15).forEach(f => {
                try { fs.unlinkSync(path.join(SCREENSHOTS_PUBLIC_DIR, f)); } catch { /* ignore */ }
            });
        }
    } catch { /* ignore cleanup errors */ }

    return { base64, publicUrl: `/api/file?path=browser-screenshots/${filename}` };
}

// ─── Session Status ─────────────────────────────────────────────

export async function getBrowserStatus(): Promise<{ active: boolean; url?: string; sessionDurationMs?: number }> {
    if (!_page || !_browser) return { active: false };
    try {
        const url = _page.url();
        const durationMs = _sessionStartTime ? Date.now() - _sessionStartTime : 0;
        return { active: true, url, sessionDurationMs: durationMs };
    } catch {
        return { active: false };
    }
}

// ─── Browser Tools ──────────────────────────────────────────────

/**
 * Open a URL in headless Chromium.
 * Takes a screenshot and returns a vision description of the page.
 */
export async function browserOpen(url: string): Promise<BrowserActionResult> {
    // ── BLACKLIST CHECK ──────────────────────────────────────────────────────
    // browser_open must respect the same domain blocklist as fetch_web_page.
    try {
        const { checkDomainBlocked } = await import('./blacklist');
        const blocked = await checkDomainBlocked(url);
        if (blocked.blocked) {
            return {
                success: false,
                error: `🚫 Access to **${blocked.domain}** is blocked by the security blacklist. This domain is restricted for safety reasons.`,
            };
        }
    } catch { /* non-fatal — continue if blacklist check itself errors */ }
    // ─────────────────────────────────────────────────────────────────────────

    try {
        // Lazy-require playwright so it's only loaded when actually needed
        // (webpackIgnore prevents Next.js bundler from trying to bundle it)
        const { chromium } = require(/* webpackIgnore: true */ 'playwright');

        // Close any existing session first
        if (_browser) {
            try { await _browser.close(); } catch { /* ignore */ }
            _browser = null;
            _page = null;
            _sessionStartTime = null;
        }

        _browser = await chromium.launch({ headless: true });
        _page = await _browser.newPage();
        _sessionStartTime = Date.now();

        await _page.setViewportSize({ width: 1280, height: 800 });
        await _page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

        // ── Auto-dismiss cookie/consent banners ─────────────────────────────
        // Try common DOM selectors first (fast, no Vision API call needed).
        // Covers YouTube, Google, GDPR banners, Cookiebot, OneTrust, etc.
        try {
            await _page.waitForTimeout(1200); // Let JS-rendered banners appear
            const consentSelectors = [
                // YouTube / Google consent
                'button[aria-label*="Accept"]',
                'button[aria-label*="Reject"]',
                'tp-yt-paper-button#reject-all-button',
                'button#accept-button',
                'button.yt-spec-button-shape-next[aria-label*="Accept"]',
                // Generic GDPR / cookie banners
                'button[id*="accept"]',
                'button[class*="accept"]',
                'button[data-testid*="accept"]',
                'button[id*="cookie-accept"]',
                'button[class*="cookie-accept"]',
                // OneTrust
                '#onetrust-accept-btn-handler',
                // Cookiebot
                '#CybotCookiebotDialogBodyButtonAccept',
                // Common text-based (case-insensitive attribute selectors not supported — use evaluate)
            ];
            for (const sel of consentSelectors) {
                try {
                    const btn = _page.locator(sel).first();
                    const visible = await btn.isVisible({ timeout: 300 }).catch(() => false);
                    if (visible) {
                        await btn.click({ timeout: 2000 });
                        await _page.waitForTimeout(800);
                        break;
                    }
                } catch { /* selector not found — try next */ }
            }

            // Fallback: look for buttons/links whose text contains accept/agree/ok
            await _page.evaluate(() => {
                const keywords = ['accept all', 'accept', 'agree', 'i agree', 'got it', 'ok', 'zustimmen', 'akzeptieren', 'alle akzeptieren'];
                const els = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]'));
                for (const el of els) {
                    const text = (el as HTMLElement).innerText?.toLowerCase().trim();
                    if (keywords.some(k => text === k || text.startsWith(k))) {
                        (el as HTMLElement).click();
                        break;
                    }
                }
            });
            await _page.waitForTimeout(600);
        } catch { /* consent dismissal is best-effort — never block page open */ }

        const screenshot = await captureScreenshot();
        const cfg = await getBrowserControlConfig();

        const description = await callVisionLLM(
            screenshot.base64,
            'Briefly describe this webpage: what site is it, what is currently shown, and list the main visible buttons, links, or input fields.',
            cfg
        );

        return {
            success: true,
            url: _page.url(),
            description,
            screenshotUrl: screenshot.publicUrl,
        };
    } catch (e: any) {
        _browser = null;
        _page = null;
        _sessionStartTime = null;
        // Give a clear, actionable error when playwright isn't actually installed
        if (e.code === 'MODULE_NOT_FOUND' || e.message?.includes('playwright')) {
            return {
                success: false,
                error: 'Playwright is not installed. Go to Settings → Browser Control and click "Install Chromium" to set it up.',
            };
        }
        return { success: false, error: e.message };
    }
}

/**
 * Click an element by text description.
 * Sends the screenshot to the Vision LLM to locate the element's coordinates.
 */
export async function browserClick(elementDescription: string): Promise<BrowserActionResult> {
    try {
        if (!_page) return { success: false, error: 'No active browser session. Call browser_open first.' };

        const screenshot = await captureScreenshot();
        const cfg = await getBrowserControlConfig();

        // Ask Vision LLM for coordinates
        const coordRaw = await callVisionLLM(
            screenshot.base64,
            `Locate the element described as: "${elementDescription}". ` +
            `Return ONLY a compact JSON object like {"x":123,"y":456} with the pixel coordinates of its center. ` +
            `If not visible, return {"x":-1,"y":-1}.`,
            cfg
        );

        let x = -1, y = -1;
        try {
            const match = coordRaw.match(/\{\s*"x"\s*:\s*(-?\d+)\s*,\s*"y"\s*:\s*(-?\d+)\s*\}/);
            if (match) { x = parseInt(match[1]); y = parseInt(match[2]); }
        } catch { /* keep x=-1,y=-1 */ }

        if (x < 0 || y < 0) {
            return {
                success: false,
                error: `Element not found on page: "${elementDescription}". Use browser_screenshot to see the current page state.`,
                screenshotUrl: screenshot.publicUrl,
            };
        }

        await _page.mouse.click(x, y);
        await _page.waitForTimeout(1200);

        const afterShot = await captureScreenshot();
        const description = await callVisionLLM(
            afterShot.base64,
            'Describe what happened after the click. What changed or loaded on the page?',
            cfg
        );

        return { success: true, url: _page.url(), description, screenshotUrl: afterShot.publicUrl };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

/**
 * Type text into the currently focused field.
 */
export async function browserType(text: string): Promise<BrowserActionResult> {
    try {
        if (!_page) return { success: false, error: 'No active browser session. Call browser_open first.' };

        await _page.keyboard.type(text, { delay: 25 });
        await _page.waitForTimeout(500);

        const screenshot = await captureScreenshot();
        return {
            success: true,
            url: _page.url(),
            description: `Typed: "${text}"`,
            screenshotUrl: screenshot.publicUrl,
        };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

/**
 * Press a key (e.g. "Enter", "Tab", "Escape", "ArrowDown").
 */
export async function browserKey(key: string): Promise<BrowserActionResult> {
    try {
        if (!_page) return { success: false, error: 'No active browser session. Call browser_open first.' };

        await _page.keyboard.press(key);
        await _page.waitForTimeout(800);

        const screenshot = await captureScreenshot();
        const cfg = await getBrowserControlConfig();
        const description = await callVisionLLM(
            screenshot.base64,
            `Key "${key}" was pressed. What does the page look like now?`,
            cfg
        );

        return { success: true, url: _page.url(), description, screenshotUrl: screenshot.publicUrl };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

/**
 * Scroll the page up or down.
 * amount: number of scroll "steps" (each step = ~300px). Defaults to 3.
 */
export async function browserScroll(direction: 'up' | 'down', amount?: number): Promise<BrowserActionResult> {
    try {
        if (!_page) return { success: false, error: 'No active browser session. Call browser_open first.' };

        const pixels = (amount || 3) * 300;
        await _page.mouse.wheel(0, direction === 'down' ? pixels : -pixels);
        await _page.waitForTimeout(600);

        const screenshot = await captureScreenshot();
        return {
            success: true,
            url: _page.url(),
            description: `Scrolled ${direction}`,
            screenshotUrl: screenshot.publicUrl,
        };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

/**
 * Take a screenshot of the current page state and analyze it with Vision LLM.
 */
export async function browserScreenshot(): Promise<BrowserActionResult> {
    try {
        if (!_page) return { success: false, error: 'No active browser session. Call browser_open first.' };

        const screenshot = await captureScreenshot();
        const cfg = await getBrowserControlConfig();
        const description = await callVisionLLM(
            screenshot.base64,
            'Describe in detail what you see on this webpage. List visible text, buttons, input fields, images, and the overall state of the page.',
            cfg
        );

        return {
            success: true,
            url: _page.url(),
            description,
            screenshotUrl: screenshot.publicUrl,
        };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

/**
 * Take a screenshot of the user's full desktop (not the browser — the actual screen).
 * Uses `screencapture` on macOS and PowerShell on Windows.
 * The screenshot is analyzed by the Vision LLM and shown in chat.
 */
export async function screenshotDesktop(): Promise<BrowserActionResult> {
    if (!fs.existsSync(SCREENSHOTS_PUBLIC_DIR)) {
        fs.mkdirSync(SCREENSHOTS_PUBLIC_DIR, { recursive: true });
    }
    if (!fs.existsSync(SCREENSHOTS_WORKSPACE_DIR)) {
        fs.mkdirSync(SCREENSHOTS_WORKSPACE_DIR, { recursive: true });
    }

    const filename = `desktop-${Date.now()}.png`;
    const filePath = path.join(SCREENSHOTS_PUBLIC_DIR, filename);
    const workspacePath = path.join(SCREENSHOTS_WORKSPACE_DIR, filename);
    const publicUrl = `/api/file?path=browser-screenshots/${filename}`;

    try {
        if (process.platform === 'darwin') {
            // macOS: screencapture -x (silent, no shutter sound)
            execFileSync('screencapture', ['-x', filePath], { timeout: 10_000 });
        } else {
            // Windows: PowerShell — capture primary screen via System.Windows.Forms
            // Pass path as a variable to avoid quoting issues with special chars
            const psScript = [
                'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
                '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
                '$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);',
                '$g=[System.Drawing.Graphics]::FromImage($bmp);',
                '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);',
                `$bmp.Save($env:SKALES_SS_PATH);`,
                '$g.Dispose();$bmp.Dispose()',
            ].join(' ');
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
                timeout: 15_000,
                env: { ...process.env, SKALES_SS_PATH: filePath },
            });
        }

        if (!fs.existsSync(filePath)) {
            return { success: false, error: 'Screenshot file was not created. The capture command may have failed silently.' };
        }

        const base64 = fs.readFileSync(filePath).toString('base64');
        const cfg = await getBrowserControlConfig();

        const description = await callVisionLLM(
            base64,
            'Describe in detail what is currently shown on the user\'s desktop screen. Include: which applications are open and visible, active window content, any dialogs, menus, notifications, the taskbar/dock, clock, and anything else visible on screen.',
            cfg
        );

        // Copy to workspace folder for user file access & Telegram sending
        try {
            fs.copyFileSync(filePath, workspacePath);
        } catch { /* non-fatal — workspace copy failure shouldn't break screenshot */ }

        // Keep only the last 5 desktop screenshots in public/
        try {
            const allFiles = fs.readdirSync(SCREENSHOTS_PUBLIC_DIR)
                .filter(f => f.startsWith('desktop-') && f.endsWith('.png'))
                .sort();
            if (allFiles.length > 5) {
                allFiles.slice(0, allFiles.length - 5).forEach(f => {
                    try { fs.unlinkSync(path.join(SCREENSHOTS_PUBLIC_DIR, f)); } catch { /* ignore */ }
                });
            }
        } catch { /* ignore cleanup errors */ }

        return {
            success: true,
            description,
            screenshotUrl: publicUrl,
            screenshotFilePath: fs.existsSync(workspacePath) ? workspacePath : filePath,
        };
    } catch (e: any) {
        return { success: false, error: `Desktop screenshot failed: ${e.message}` };
    }
}

/**
 * Close the browser session and clean up.
 */
export async function browserClose(): Promise<BrowserActionResult> {
    try {
        if (_browser) {
            await _browser.close();
        }
    } catch { /* ignore close errors */ } finally {
        _browser = null;
        _page = null;
        _sessionStartTime = null;

        // Clean up all session screenshots
        try {
            if (fs.existsSync(SCREENSHOTS_PUBLIC_DIR)) {
                const files = fs.readdirSync(SCREENSHOTS_PUBLIC_DIR)
                    .filter(f => f.startsWith('browser-') && f.endsWith('.png'));
                files.forEach(f => {
                    try { fs.unlinkSync(path.join(SCREENSHOTS_PUBLIC_DIR, f)); } catch { /* ignore */ }
                });
            }
        } catch { /* ignore */ }
    }
    return { success: true, description: 'Browser session closed and screenshots cleaned up.' };
}
