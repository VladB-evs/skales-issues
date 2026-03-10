// Skales — Created by Mario Simic — skales.app
import { NextResponse } from 'next/server';
import { unstable_noStore as noStore } from 'next/cache';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '@/lib/paths';
import { APP_NAME, APP_VERSION, AUTHOR, HOMEPAGE } from '@/lib/meta';

// Never cache this route — it reflects live process state.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ─── Helpers ──────────────────────────────────────────────────

/** Returns true if a process with the given PID is alive. */
function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0); // signal 0 = existence check, does not kill
        return true;
    } catch {
        return false;
    }
}

/** Read a lock file and check whether the recorded PID is still running. */
function checkLockFile(lockPath: string): boolean {
    try {
        if (!fs.existsSync(lockPath)) return false;
        const raw = fs.readFileSync(lockPath, 'utf-8').trim();
        const pid = parseInt(raw, 10);
        if (isNaN(pid) || pid <= 0) return false;
        return isPidAlive(pid);
    } catch {
        return false;
    }
}

// ─── GET /api/health ─────────────────────────────────────────
/**
 * Heartbeat endpoint polled by the React frontend every 5 seconds.
 * Returns the live running state of every background bot so the UI
 * always reflects the true backend state — never stale cached data.
 *
 * Response shape:
 * {
 *   timestamp: number,
 *   bots: {
 *     telegram:  { running: boolean },
 *     discord:   { running: boolean },
 *     whatsapp:  { running: boolean, state: string, isReady: boolean },
 *   }
 * }
 */
export async function GET() {
    noStore();

    // ── Telegram ────────────────────────────────────────────────
    const telegramRunning = checkLockFile(path.join(DATA_DIR, '.telegram-bot.lock'));

    // ── Discord ─────────────────────────────────────────────────
    const discordRunning = checkLockFile(path.join(DATA_DIR, '.discord-bot.lock'));

    // ── WhatsApp ────────────────────────────────────────────────
    // The WhatsApp bot writes its state to a JSON file; read that directly
    // so we don't need to make an HTTP call to the bot process itself.
    let whatsappState = 'idle';
    let whatsappReady = false;
    let whatsappRunning = false;
    try {
        const statusPath = path.join(DATA_DIR, 'integrations', 'whatsapp-status.json');
        if (fs.existsSync(statusPath)) {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
            whatsappState = status.state ?? 'idle';
            whatsappReady = status.state === 'ready' || status.isReady === true;
            // Consider the bot "running" for any non-idle, non-error state
            whatsappRunning = !['idle', 'disconnected', 'auth_failure', 'error'].includes(whatsappState) || whatsappReady;
        }
    } catch {
        // Status file unreadable — treat as idle
    }

    return NextResponse.json({
        app:       APP_NAME,
        version:   APP_VERSION,
        author:    AUTHOR,
        homepage:  HOMEPAGE,
        skales:    true,       // Discovery marker — lets network scan verify Skales instances
        timestamp: Date.now(),
        bots: {
            telegram: { running: telegramRunning },
            discord:  { running: discordRunning },
            whatsapp: { running: whatsappRunning, state: whatsappState, isReady: whatsappReady },
        },
    });
}
