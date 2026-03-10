/**
 * dashboard-notify.ts
 *
 * Pushes a proactive message into the Dashboard Chat when the app window is open.
 * Works identically to buddy-notify.ts but targets a separate queue file that
 * the Chat page polls instead of the Buddy widget.
 *
 * Storage: ~/.skales-data/dashboard-queue.json  (array of { text, ts })
 * The GET /api/dashboard-notifications endpoint drains this file atomically.
 */

import fs   from 'fs';
import path from 'path';
import { DATA_DIR } from '@/lib/paths';

const QUEUE_FILE = path.join(DATA_DIR, 'dashboard-queue.json');
const MAX_QUEUE  = 20;

export interface DashboardNotification {
    text: string;
    ts:   number;
}

function readQueue(): DashboardNotification[] {
    try {
        if (!fs.existsSync(QUEUE_FILE)) return [];
        return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')) as DashboardNotification[];
    } catch {
        return [];
    }
}

function writeQueue(queue: DashboardNotification[]): void {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
    } catch { /* non-fatal */ }
}

/**
 * Push a proactive message to the Dashboard Chat queue.
 * The Chat page polls /api/dashboard-notifications every 5s and
 * renders any pending items as assistant messages.
 */
export function pushDashboardMessage(text: string): void {
    const queue = readQueue();
    queue.push({ text: text.slice(0, 500), ts: Date.now() });
    writeQueue(queue.slice(-MAX_QUEUE));
}

/**
 * Drain all pending dashboard notifications (returns + clears the queue).
 * Called exclusively by GET /api/dashboard-notifications.
 */
export function drainDashboardMessages(): DashboardNotification[] {
    const queue = readQueue();
    if (queue.length === 0) return [];
    writeQueue([]);
    return queue;
}
