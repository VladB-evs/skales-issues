/**
 * approval-store.ts
 *
 * Persistent store for tool-call approvals awaiting user confirmation.
 * Used by the Telegram integration to bridge the async gap between:
 *   1. Skales detecting a tool needs approval → sends inline keyboard
 *   2. User tapping Approve/Deny in Telegram → resumes agent loop
 *
 * Storage: ~/.skales-data/pending-approvals/{id}.json
 */

import fs   from 'fs';
import path from 'path';
import { DATA_DIR } from '@/lib/paths';

const APPROVALS_DIR  = path.join(DATA_DIR, 'pending-approvals');
const MAX_AGE_MS     = 30 * 60 * 1000;  // 30 minutes — stale approvals auto-expire

export interface PendingApproval {
    id:              string;
    sessionId:       string;
    toolCalls:       any[];           // raw tool calls awaiting approval
    descriptions:    string[];        // human-readable per-tool descriptions
    createdAt:       number;
    telegramChatId:  string;
    telegramToken:   string;
    source:          'telegram' | 'buddy';
}

function ensureDir(): void {
    if (!fs.existsSync(APPROVALS_DIR)) {
        fs.mkdirSync(APPROVALS_DIR, { recursive: true });
    }
}

export function saveApproval(approval: PendingApproval): void {
    ensureDir();
    const file = path.join(APPROVALS_DIR, `${approval.id}.json`);
    fs.writeFileSync(file, JSON.stringify(approval, null, 2), 'utf-8');
}

export function loadApproval(id: string): PendingApproval | null {
    const file = path.join(APPROVALS_DIR, `${id}.json`);
    try {
        if (!fs.existsSync(file)) return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as PendingApproval;
        // Expire stale approvals
        if (Date.now() - data.createdAt > MAX_AGE_MS) {
            fs.unlinkSync(file);
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

export function deleteApproval(id: string): void {
    const file = path.join(APPROVALS_DIR, `${id}.json`);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* non-fatal */ }
}

/** Purge all expired approval files (called lazily on writes). */
export function purgeExpired(): void {
    ensureDir();
    try {
        for (const f of fs.readdirSync(APPROVALS_DIR)) {
            if (!f.endsWith('.json')) continue;
            const file = path.join(APPROVALS_DIR, f);
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
                if (Date.now() - (data.createdAt ?? 0) > MAX_AGE_MS) fs.unlinkSync(file);
            } catch { /* skip */ }
        }
    } catch { /* non-fatal */ }
}
