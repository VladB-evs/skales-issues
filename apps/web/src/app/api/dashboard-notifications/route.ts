/**
 * GET /api/dashboard-notifications
 *
 * Returns and atomically clears all pending Dashboard Chat messages
 * that were pushed via pushDashboardMessage() (Friend Mode "Dashboard" channel).
 * The Chat page polls this endpoint every 5s when the window is open.
 *
 * POST /api/dashboard-notifications
 * Manually push a message (used by buddy-notifications route for routing).
 */

import { NextRequest, NextResponse } from 'next/server';
import { drainDashboardMessages, pushDashboardMessage } from '@/lib/dashboard-notify';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
    try {
        const messages = drainDashboardMessages();
        return NextResponse.json({ success: true, messages });
    } catch (err: any) {
        return NextResponse.json({ success: false, messages: [], error: err?.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const { text } = await req.json();
        if (!text?.trim()) {
            return NextResponse.json({ success: false, error: 'Missing text' }, { status: 400 });
        }
        pushDashboardMessage(text.trim());
        return NextResponse.json({ success: true });
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err?.message }, { status: 500 });
    }
}
