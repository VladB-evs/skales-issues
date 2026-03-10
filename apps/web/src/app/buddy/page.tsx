'use client';

/**
 * /buddy — Skales Desktop Buddy (v5.0.0)
 *
 * Renders inside a frameless, transparent Electron BrowserWindow (300×400).
 * The AppShell is bypassed for this route (see app-shell.tsx).
 *
 * FSM:
 *   INTRO  → random intro clip once → IDLE
 *   IDLE   → random idle clip looping; timer 30–60 s → ACTION
 *   ACTION → random action clip once (shuffle bag, no repeats) → IDLE
 *
 * VIDEO DOUBLE-BUFFER:
 *   Two <video> elements are stacked at the same position.
 *   The inactive slot loads the next clip silently.
 *   On 'canplay' we opacity-swap them (CSS transition 0.12 s).
 *   This eliminates the blank-frame flash that key-based remounting causes.
 *
 * CHAT:
 *   Clicking the gecko opens a persistent input pill (stays open until
 *   the user clicks the gecko again or the window loses focus).
 *   Responses come from /api/buddy-chat and are saved to the active session.
 *   If the reply was truncated an "Open Chat →" link reveals the full answer.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Asset manifests ──────────────────────────────────────────────────────────

const INTROS: string[] = ['elevator.webm', 'intro.webm', 'paper.webm', 'spawn.webm'];

const IDLES: string[] = ['stand.webm', 'still.webm', 'stillstand.webm'];

const ACTIONS: string[] = [
    'breathing.webm', 'bubblegum.webm', 'dumbell.webm',   'fly.webm',
    'joyspinning.webm', 'screentap.webm', 'sleep.webm',   'smartphone.webm',
    'sneeze.webm',    'spinning.webm',   'stamp.webm',    'stepcheck.webm',
    'stillstamp.webm','stretch.webm',    'sunglasses.webm','tired.webm',
];

function asset(folder: 'intro' | 'idle' | 'action', file: string): string {
    return `/mascot/${folder}/${file}`;
}
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffled<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function nextDelay(): number { return (30 + Math.random() * 30) * 1_000; }

type FSM = 'intro' | 'idle' | 'action';

// ─── Component ────────────────────────────────────────────────────────────────

export default function BuddyPage() {

    // ── Double-buffer: two video slots, only opacity managed by React ──────────
    // Everything else (src, loop, load, play) is driven directly on the DOM
    // element so React never interrupts an in-progress load.
    const vidA       = useRef<HTMLVideoElement>(null);
    const vidB       = useRef<HTMLVideoElement>(null);
    const activeSlot = useRef<'a' | 'b'>('a');       // which slot is visible
    const [opA, setOpA] = useState(1);                // CSS opacity of slot A
    const [opB, setOpB] = useState(0);                // CSS opacity of slot B

    // ── FSM ───────────────────────────────────────────────────────────────────
    const fsm         = useRef<FSM>('intro');
    const actionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const bag         = useRef<string[]>([]);

    // ── Chat ──────────────────────────────────────────────────────────────────
    const [spotOpen,   setSpotOpen]   = useState(false);
    const [query,      setQuery]      = useState('');
    const [thinking,   setThinking]   = useState(false);
    const [bubble,      setBubble]      = useState<string | null>(null);
    const [bubbleLong,  setBubbleLong]  = useState(false);   // true → show "Open Chat"
    const [bubbleIsError, setBubbleIsError] = useState(false); // true → friendly error style
    const inputRef    = useRef<HTMLInputElement>(null);
    const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Helpers ───────────────────────────────────────────────────────────────
    const clearAction = () => {
        if (actionTimer.current) { clearTimeout(actionTimer.current); actionTimer.current = null; }
    };
    const clearBubble = () => {
        if (bubbleTimer.current) { clearTimeout(bubbleTimer.current); bubbleTimer.current = null; }
    };
    const nextAction = (): string => {
        if (bag.current.length === 0) bag.current = shuffled(ACTIONS);
        return bag.current.pop()!;
    };

    // ── Double-buffer play ────────────────────────────────────────────────────
    // Loads `url` into the INACTIVE video slot. The moment the browser has
    // decoded the first frame ('canplay'), we do an opacity swap so the new
    // clip appears instantly with no visible gap.

    const play = useCallback((url: string, shouldLoop: boolean, retries = 3): void => {
        const isAActive = activeSlot.current === 'a';
        const nextVid   = isAActive ? vidB.current : vidA.current;
        if (!nextVid) return;

        // Abort any previous half-loaded canplay listener on this slot
        // by cloning the element reference technique — instead, we simply
        // overwrite: assigning a new src triggers a natural abort.
        nextVid.loop = shouldLoop;
        nextVid.src  = url;
        nextVid.load();

        const onCanPlay = () => {
            nextVid.removeEventListener('canplay', onCanPlay);
            nextVid.removeEventListener('error', onError);

            // Swap opacity only AFTER the first frame is truly composited on the GPU.
            // This is the critical fix for the 100-200ms black-frame flicker:
            //   • requestVideoFrameCallback (rVFC) — Chromium/Electron 86+ — fires
            //     exactly when a decoded frame has been presented to the compositor.
            //     This is the most reliable guarantee that the frame is visible.
            //   • Fallback: double-rAF (guarantees two paint cycles, which is usually
            //     enough, but rVFC is strictly better).
            const doSwap = () => {
                activeSlot.current = isAActive ? 'b' : 'a';
                if (isAActive) { setOpA(0); setOpB(1); }
                else            { setOpA(1); setOpB(0); }
            };

            nextVid.play().catch(() => {/* muted autoplay always works */}).finally(() => {
                if (typeof (nextVid as any).requestVideoFrameCallback === 'function') {
                    // rVFC: fires after the first painted frame — zero blank-frame risk
                    (nextVid as any).requestVideoFrameCallback(doSwap);
                } else {
                    // Fallback: two rAFs ensure the GPU compositor has rendered
                    requestAnimationFrame(() => requestAnimationFrame(doSwap));
                }
            });
        };
        // Retry on network errors (e.g. ERR_NETWORK_CHANGED during hot-reload)
        const onError = () => {
            nextVid.removeEventListener('canplay', onCanPlay);
            nextVid.removeEventListener('error', onError);
            if (retries > 0) {
                setTimeout(() => play(url, shouldLoop, retries - 1), 1500);
            }
        };
        nextVid.addEventListener('canplay', onCanPlay);
        nextVid.addEventListener('error', onError);
    }, []);

    // ── FSM: Idle (Phase 2 + 3) ───────────────────────────────────────────────
    const goIdle = useCallback(() => {
        clearAction();
        fsm.current = 'idle';
        play(asset('idle', pick(IDLES)), true);
        actionTimer.current = setTimeout(() => {
            clearAction();
            fsm.current = 'action';
            play(asset('action', nextAction()), false);
        }, nextDelay());
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [play]);

    // ── FSM: onEnded — drives intro→idle and action→idle ─────────────────────
    const onEnded = useCallback(() => {
        if (fsm.current === 'intro' || fsm.current === 'action') goIdle();
    }, [goIdle]);

    // ── Boot: Phase 1 — seed slot A directly (no inactive-swap on first load) ─
    useEffect(() => {
        fsm.current = 'intro';
        const vid = vidA.current;
        if (!vid) return;
        const url = asset('intro', pick(INTROS));
        let retries = 4;

        const tryLoad = () => {
            vid.loop = false;
            vid.src  = url;
            vid.load();
            vid.play().catch(() => {});
        };
        // Retry on network errors (e.g. ERR_NETWORK_CHANGED during hot-reload)
        const onError = () => {
            if (retries-- > 0) setTimeout(tryLoad, 1500);
        };
        vid.addEventListener('error', onError);
        tryLoad();

        return () => {
            vid.removeEventListener('error', onError);
            clearAction(); clearBubble();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Focus input on open ───────────────────────────────────────────────────
    useEffect(() => {
        if (spotOpen) setTimeout(() => inputRef.current?.focus(), 80);
    }, [spotOpen]);

    // ── Close on window blur (user switches to another app) ──────────────────
    useEffect(() => {
        const onBlur = () => { if (!thinking) { setSpotOpen(false); setQuery(''); } };
        window.addEventListener('blur', onBlur);
        return () => window.removeEventListener('blur', onBlur);
    }, [thinking]);

    // ── Notification polling (task/cron completions) ──────────────────────────
    // Polls /api/buddy-notifications every 5 s. Shows notifications in the
    // bubble only when no AI response is already displayed. Uses a micro-queue
    // so back-to-back notifications don't overwrite each other.
    const notifQueue = useRef<string[]>([]);
    const showBubble = (text: string, ms = 8000) => {
        clearBubble();
        setBubble(text);
        setBubbleLong(false);
        setBubbleIsError(false);
        bubbleTimer.current = setTimeout(() => { setBubble(null); setBubbleIsError(false); }, ms);
    };
    useEffect(() => {
        const tryFlush = () => {
            if (notifQueue.current.length === 0 || bubble) return;
            const next = notifQueue.current.shift()!;
            showBubble(next, 8000);
        };
        const poll = async () => {
            try {
                const res = await fetch('/api/buddy-notifications');
                if (!res.ok) return;
                const data = await res.json() as { notifications: { text: string }[] };
                for (const n of data.notifications) notifQueue.current.push(n.text);
                tryFlush();
            } catch { /* ignore network errors */ }
        };
        const id = setInterval(poll, 5000);
        return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bubble]);

    // ── Mascot click — toggle input ───────────────────────────────────────────
    const handleMascotClick = () => {
        if (thinking) return;
        if (spotOpen) { setSpotOpen(false); setQuery(''); return; }
        clearBubble(); setBubble(null); setBubbleLong(false); setBubbleIsError(false);
        setSpotOpen(true);
    };

    // ── Submit to /api/buddy-chat ─────────────────────────────────────────────
    const submit = async () => {
        const text = query.trim();
        if (!text || thinking) return;
        setThinking(true);
        setQuery('');
        // Input stays visible — disabled until response arrives

        try {
            const res  = await fetch('/api/buddy-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
            });
            const data = await res.json().catch(() => ({}));

            let reply: string;
            if (res.ok) {
                reply = (data.content ?? '').trim() || 'No response.';
            } else {
                reply = `Error ${res.status}: ${data.error ?? 'unknown'}`;
            }

            const wasLong = reply.length > 110;
            if (wasLong) reply = reply.slice(0, 107) + '…';

            setBubble(reply);
            setBubbleLong(wasLong);
            clearBubble();
            bubbleTimer.current = setTimeout(() => { setBubble(null); setBubbleLong(false); }, 18_000);
        } catch (err: any) {
            setBubble('Oops.. could you take a look?');
            setBubbleLong(true);
            setBubbleIsError(true);
            clearBubble();
            bubbleTimer.current = setTimeout(() => { setBubble(null); setBubbleIsError(false); }, 15_000);
        } finally {
            setThinking(false);
            setTimeout(() => inputRef.current?.focus(), 60);
        }
    };

    const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter')  void submit();
        if (e.key === 'Escape') { setSpotOpen(false); setQuery(''); }
    };

    // Open the main Skales window and navigate to /chat
    const openChat = () => (window as any).skales?.send('open-chat');

    // ── Shared video style ─────────────────────────────────────────────────────
    const videoStyle = {
        position:        'absolute',
        bottom:          0,
        right:           0,
        width:           '150px',
        height:          'auto',
        cursor:          'pointer',
        transition:      'opacity 0.04s linear',      // near-instant swap; rVFC ensures frame is ready before swap fires
        WebkitAppRegion: 'no-drag',
        // GPU compositor layer — opacity swap happens entirely on GPU, zero CPU repaint
        willChange:      'opacity',
        transform:       'translateZ(0)',
    } as React.CSSProperties;

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <div style={{
            width:           '100%',   // NOT 100vw — avoids scrollbar-width shift in Electron
            height:          '100%',
            background:      'transparent',
            position:        'fixed',  // fixed pins to viewport without scrollbar influence
            top:             0,
            left:            0,
            right:           0,
            bottom:          0,
            overflow:        'hidden',
            userSelect:      'none',
            WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}>

            {/* ── Speech Bubble ────────────────────────────────────────────── */}
            {bubble && (
                <div
                    aria-live="polite"
                    onClick={() => { clearBubble(); setBubble(null); setBubbleLong(false); setBubbleIsError(false); }}
                    style={{
                        position:             'absolute',
                        bottom:               '248px',   // above input pill
                        right:                '5px',
                        width:                '190px',
                        background:           bubbleIsError ? 'rgba(20,8,8,0.92)' : 'rgba(10,10,10,0.92)',
                        backdropFilter:       'blur(14px)',
                        WebkitBackdropFilter: 'blur(14px)',
                        border:               bubbleIsError ? '1px solid rgba(248,113,113,0.45)' : '1px solid rgba(132,204,22,0.35)',
                        borderRadius:         '14px',
                        padding:              '10px 13px',
                        fontSize:             '12px',
                        lineHeight:           1.5,
                        color:                '#f0f0f0',
                        cursor:               'pointer',
                        zIndex:               10,
                    }}
                >
                    {bubble}

                    {/* "Open Chat" when the response was truncated */}
                    {bubbleLong && (
                        <button
                            onClick={e => { e.stopPropagation(); openChat(); }}
                            style={{
                                display:        'block',
                                marginTop:      '6px',
                                background:     'none',
                                border:         'none',
                                padding:        0,
                                color:          '#84cc16',
                                fontSize:       '11px',
                                cursor:         'pointer',
                                textDecoration: 'underline',
                                fontWeight:     600,
                            }}
                            aria-label="Open Skales Chat"
                        >
                            Open Chat →
                        </button>
                    )}

                    {/* Bubble tail — points down toward the gecko */}
                    <div style={{
                        position:     'absolute',
                        bottom:       '-7px',
                        right:        '70px',
                        width:        0,
                        height:       0,
                        borderLeft:   '7px solid transparent',
                        borderRight:  '7px solid transparent',
                        borderTop:    '7px solid rgba(10,10,10,0.92)',
                    }} />
                </div>
            )}

            {/* ── Input pill ───────────────────────────────────────────────── */}
            {/* Always in DOM — CSS-only show/hide prevents reflow jump when appearing */}
            <div style={{
                position:             'absolute',
                bottom:               '195px',   // just above gecko's head
                right:                '5px',
                width:                '180px',
                background:           'rgba(10,10,10,0.88)',
                backdropFilter:       'blur(22px)',
                WebkitBackdropFilter: 'blur(22px)',
                border:               '1px solid rgba(132,204,22,0.5)',
                borderRadius:         '14px',
                padding:              '9px 12px',
                display:              'flex',
                alignItems:           'center',
                gap:                  '8px',
                zIndex:               20,
                // CSS-only visibility — no DOM insertion/removal = no layout shift
                opacity:          spotOpen ? 1 : 0,
                pointerEvents:    spotOpen ? 'auto' : 'none',
                transform:        spotOpen ? 'translateY(0)' : 'translateY(4px)',
                transition:       'opacity 0.15s ease, transform 0.15s ease',
            } as React.CSSProperties}>
                {/* Spinner while thinking, gecko emoji while idle */}
                {thinking ? (
                    <div style={{
                        width:           14,
                        height:          14,
                        border:          '2px solid #84cc16',
                        borderTopColor:  'transparent',
                        borderRadius:    '50%',
                        animation:       'spin 0.7s linear infinite',
                        flexShrink:      0,
                    }} />
                ) : (
                    <span style={{ fontSize: 14, flexShrink: 0 }}>🦎</span>
                )}

                <input
                    ref={inputRef}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={handleKey}
                    placeholder="Question or command…"
                    disabled={thinking || !spotOpen}
                    aria-label="Ask Skales — type your question or command"
                    style={{
                        flex:        1,
                        minWidth:    0,         // allows flex shrink below content width → no text overflow
                        background:  'transparent',
                        border:      'none',
                        outline:     'none',
                        color:       '#f0f0f0',
                        fontSize:    '12px',
                        caretColor:  '#84cc16',
                        opacity:     thinking ? 0.5 : 1,
                        transition:  'opacity 0.15s',
                    }}
                />
            </div>

            {/* ── Mascot video — slot A ─────────────────────────────────────── */}
            {/* Both slots share the same position/size; opacity drives visibility */}
            <video
                ref={vidA}
                muted
                playsInline
                onEnded={onEnded}
                onClick={handleMascotClick}
                style={{ ...videoStyle, opacity: opA }}
                aria-hidden="true"
            />

            {/* ── Mascot video — slot B ─────────────────────────────────────── */}
            <video
                ref={vidB}
                muted
                playsInline
                onEnded={onEnded}
                onClick={handleMascotClick}
                style={{ ...videoStyle, opacity: opB }}
                aria-hidden="true"
            />

            {/* ── Global keyframes ─────────────────────────────────────────── */}
            <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
                *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
                html, body { background: transparent !important; overflow: hidden; }
            `}</style>
        </div>
    );
}
