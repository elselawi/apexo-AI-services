// ============================================================================
//  Gemini Live API — WebSocket reverse proxy
// ============================================================================
//
//  Proxies the Gemini Live (BidiGenerateContent) WebSocket so that the
//  GEMINI_API_KEY never leaves the Worker.  The caller has already been
//  authenticated by the time this handler runs (see index.ts).
//
//  Wire protocol is transparent — all client→server and server→client
//  messages are relayed unchanged.  See:
//  https://ai.google.dev/gemini-api/docs/live
// ============================================================================

import type { Env } from "./types";

/** Gemini Live WebSocket base URL (without API key). */
const GEMINI_LIVE_WS_BASE =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/**
 * Handle an authenticated HTTP Upgrade request for `/gemini-live`.
 *
 * Opens a server-side WebSocket to Gemini and relays all messages
 * bidirectionally between the client and Gemini.
 */
export async function handleGeminiLiveProxy(
    _request: Request,
    env: Env,
): Promise<Response> {
    // ── Open WebSocket pair (client ↔ Worker) ───────────────────────────
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);

    serverWs.accept();

    // ── Open WebSocket to Gemini (API key injected server-side) ─────────
    const geminiUrl = `${GEMINI_LIVE_WS_BASE}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const geminiWs = new WebSocket(geminiUrl);

    // ── Relay: client → Gemini ──────────────────────────────────────────
    serverWs.addEventListener("message", (event: MessageEvent) => {
        if (geminiWs.readyState === WebSocket.READY_STATE_OPEN) {
            geminiWs.send(event.data);
        }
    });

    // ── Relay: Gemini → client ──────────────────────────────────────────
    geminiWs.addEventListener("message", (event: MessageEvent) => {
        if (serverWs.readyState === WebSocket.READY_STATE_OPEN) {
            serverWs.send(event.data);
        }
    });

    // ── Lifecycle: close propagation ────────────────────────────────────
    const cleanup = () => {
        try { geminiWs.close(); } catch { /* ignore */ }
    };

    serverWs.addEventListener("close", cleanup);
    serverWs.addEventListener("error", cleanup);

    geminiWs.addEventListener("close", () => {
        try { serverWs.close(); } catch { /* ignore */ }
    });

    geminiWs.addEventListener("error", () => {
        try { serverWs.close(1011, "Gemini WebSocket error"); } catch { /* ignore */ }
    });

    // ── Return 101 with the client-side WebSocket ───────────────────────
    return new Response(null, {
        status: 101,
        webSocket: clientWs,
    });
}
