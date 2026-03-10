/**
 * POST /api/buddy-chat
 *
 * REST wrapper around processMessage() for the Desktop Buddy window.
 * Unlike /api/chat (which doesn't exist as a route — it's a server action),
 * this is a genuine Next.js API route that the Electron buddy window can fetch.
 *
 * Request body:  { message: string }
 * Response:      { content: string }       on success
 *                { error:   string }       on failure (HTTP 4xx/5xx)
 *
 * Side effects:
 *   • Appends user + assistant messages to the currently active chat session
 *     so buddy conversations appear in the main Skales chat history.
 */

import { NextResponse }                  from 'next/server';
import { unstable_noStore as noStore }   from 'next/cache';

import {
    processMessage,
    getActiveSessionId,
    loadSession,
} from '@/actions/chat';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

// ─── Buddy widget mode instruction ───────────────────────────────────────────
// Capabilities are injected by processMessage() via capabilities.json, but the
// buddy route does NOT run agentExecute — it only returns LLM text.
//
// CRITICAL HONESTY RULE: The LLM must never pretend to execute tools here.
// Any tool call would be silently dropped. The user must be directed to the
// main chat for any action that requires file operations, screenshots, etc.
const BUDDY_WIDGET_SUFFIX =
    '## Desktop Buddy widget mode — IMPORTANT CONSTRAINTS\n' +
    'You are responding inside a small overlay widget (≈190px wide).\n' +
    'Keep ALL answers to 1-3 sentences maximum.\n\n' +
    '### Tool execution is NOT available in this widget.\n' +
    'This widget cannot run file operations, create documents, take screenshots, ' +
    'send emails, execute commands, or call ANY tools. If the user asks you to ' +
    'do something that requires a tool (write a file, create a doc, take a ' +
    'screenshot, send email, etc.), you MUST respond HONESTLY:\n' +
    '"I can only do that in the main chat — Open Chat for the full answer."\n' +
    'NEVER claim to have created, saved, sent, or executed anything. ' +
    'NEVER fabricate a result. If it needs a tool, redirect to the main chat.\n\n' +
    'For questions, answers, and conversation: respond normally in 1-3 sentences.\n' +
    'If the topic needs more detail, end with "Open Chat for the full answer."';

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: Request) {
    noStore();

    let message: string;
    try {
        const body = await req.json() as { message?: string };
        message = (body.message ?? '').trim();
        if (!message) {
            return NextResponse.json({ error: 'message is required' }, { status: 400 });
        }
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    try {
        // ── Get active session so buddy messages appear in the main chat UI ───
        const sessionId = (await getActiveSessionId()) ?? undefined;

        // Load a short context window from the active session (last 10 plain messages).
        // CRITICAL: strip ALL tool-role messages and assistant messages that issued
        // tool_calls — they require tool_call_id + a paired tool result to be valid.
        // Sending orphaned tool messages causes API 400 "Message has tool role, but
        // there was no previous assistant message with a tool call".
        let history: { role: string; content: string }[] = [];
        if (sessionId) {
            const session = await loadSession(sessionId);
            if (session?.messages) {
                history = session.messages
                    .filter((m: any) => {
                        if (m.role !== 'user' && m.role !== 'assistant') return false;
                        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
                        return true;
                    })
                    .slice(-10)
                    .map((m: any) => ({
                        role:    m.role as 'user' | 'assistant',
                        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                    }));
            }
        }

        // ── Call the AI via the same processMessage pipeline ──────────────────
        // processMessage already injects capabilities from capabilities.json.
        // The buddy suffix only adds the widget brevity instruction.
        const result = await processMessage(message, history as any, {
            sessionId,
            systemPromptSuffix: BUDDY_WIDGET_SUFFIX,
            msgSource: 'buddy', // Tag messages so the chat polling can identify them
        });

        if (!result.success) {
            console.error('[Skales Buddy] processMessage failed:', result.error);
            return NextResponse.json(
                { error: result.error ?? 'AI provider error' },
                { status: 502 }
            );
        }

        const content = ('response' in result ? result.response : undefined) ?? '';
        return NextResponse.json({ content });

    } catch (err: any) {
        console.error('[Skales Buddy] /api/buddy-chat error:', err?.message ?? err);
        return NextResponse.json(
            { error: err?.message ?? 'Internal server error' },
            { status: 500 }
        );
    }
}
