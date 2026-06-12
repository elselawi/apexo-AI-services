// ============================================================================
// Gemini Live API — WebSocket reverse proxy (full server-side setup)
// ============================================================================
//
// The Worker owns the entire Gemini session configuration. When the
// upstream WebSocket opens, it sends a server-configured
// BidiGenerateContentSetup, then forwards setupComplete to the client.
// All subsequent messages (audio chunks, tool responses) pass through
// bidirectionally without inspection.
//
// Change provider, model, system prompt — anything — by editing the
// SETUP_JSON below or loading it from env/KV. No app update needed.
// ============================================================================

import type { Env } from "./types";

const GEMINI_LIVE_WS_BASE =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const DEFAULT_MODEL = "models/gemini-3.1-flash-live-preview";

function buildSetup(model: string): object {
    return {
        setup: {
            model,
            generation_config: {
                response_modalities: ["AUDIO"],
            },
            system_instruction: {
                parts: [
                    {
                        text:
                            "You are a speech-to-text engine. " +
                            "Transcribe the user's speech verbatim into text. " +
                            "Do NOT speak or generate audio — remain completely silent. " +
                            "Output the transcription only via the text channel. " +
                            "Support all languages automatically.",
                    },
                ],
            },
            input_audio_transcription: {},
        },
    };
}

export async function handleGeminiLiveProxy(
    _request: Request,
    env: Env,
): Promise<Response> {
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);
    serverWs.accept();

    const geminiUrl = `${GEMINI_LIVE_WS_BASE}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const geminiWs = new WebSocket(geminiUrl);

    const model = DEFAULT_MODEL;

    // Buffer client→Gemini messages until the upstream is ready
    const pending: string[] = [];

    // ── Once upstream opens, send our server-configured setup ───────────
    geminiWs.addEventListener("open", () => {
        geminiWs.send(JSON.stringify(buildSetup(model)));
        // Flush any early client messages (audio chunks that arrived before
        // Gemini was ready — they'll be processed after setupComplete)
        for (const msg of pending) geminiWs.send(msg);
        pending.length = 0;
    });

    // ── Relay: Gemini → client (including setupComplete) ────────────────
    geminiWs.addEventListener("message", (event: MessageEvent) => {
        if (serverWs.readyState === WebSocket.READY_STATE_OPEN) {
            serverWs.send(event.data);
        }
    });

    // ── Relay: client → Gemini (audio chunks, tool responses, etc.) ─────
    serverWs.addEventListener("message", (event: MessageEvent) => {
        if (geminiWs.readyState === WebSocket.READY_STATE_OPEN) {
            geminiWs.send(event.data);
        } else {
            pending.push(event.data as string);
        }
    });

    // ── Lifecycle ───────────────────────────────────────────────────────
    const cleanup = () => {
        try {
            geminiWs.close();
        } catch {
            /* ignore */
        }
    };
    serverWs.addEventListener("close", cleanup);
    serverWs.addEventListener("error", cleanup);
    geminiWs.addEventListener("close", () => {
        try {
            serverWs.close();
        } catch {
            /* ignore */
        }
    });
    geminiWs.addEventListener("error", () => {
        try {
            serverWs.close(1011, "Gemini WebSocket error");
        } catch {
            /* ignore */
        }
    });

    return new Response(null, { status: 101, webSocket: clientWs });
}