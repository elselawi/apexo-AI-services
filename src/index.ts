import type { Env } from "./types";
import { AuthManager } from "./auth";
import { parseImage, parseAudio } from "./parser";
import { ReceiptScanner, PostOpTranscriber, DentalHistoryTranscriber, ToTextTranscriber } from "./gemini";
import { handleGeminiLiveProxy } from "./live-ws";

const receiptScanner = new ReceiptScanner();
const postOpTranscriber = new PostOpTranscriber();
const dentalHistoryTranscriber = new DentalHistoryTranscriber();
const toTextTranscriber = new ToTextTranscriber();
import { corsHeaders, json, error } from "./response";
import { checkRateLimit } from "./rate-limit";
import { sanitizePostOpFields } from "./sanitize";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { method } = request;
		const path = new URL(request.url).pathname;

		if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

		// WebSocket upgrades are GET — let them through the POST-only gate
		const isGeminiLiveWs = method === "GET" && path === "/live-ws";
		if (method !== "POST" && !isGeminiLiveWs) return error("Only POST accepted.", 405);

		const auth = new AuthManager(env.apexo_notifications_relay);

		// ── POST /auth — issue a token (no bearer auth needed) ─────────────
		if (path === "/auth") {
			const server = request.headers.get("x-server");
			const key = request.headers.get("x-worker-key");
			const result = await auth.authenticateServer(server ?? "", key ?? "");
			if (result !== true) return error(result, 401);

			const tokenResult = await auth.createToken(server!);
			if ("error" in tokenResult) return error(tokenResult.error, 429);

			return json({
				token: tokenResult.token,
				expiresIn: 86400, // 24 hours in seconds
			});
		}

		// ── All other endpoints (including WebSocket) — validate bearer token
		const tokenAuth = await auth.authenticateRequest(request);
		if ("error" in tokenAuth) return error(tokenAuth.error, 401);

		const server = tokenAuth.server;

		// Rate limit (skip for WebSocket — it's a persistent connection)
		if (!isGeminiLiveWs) {
			const rateCheck = await checkRateLimit(server, env.apexo_notifications_relay);
			if (rateCheck !== true) return error(rateCheck, 429);
		}

		try {
			if (isGeminiLiveWs) return handleGeminiLiveProxy(request, env);
			if (path === "/expense") return handleExpense(request, env);
			if (path === "/post-op-notes") return handlePostOp(request, env);
			if (path === "/dental-history") return handleDentalHistory(request, env);
			if (path === "/to-text") return handleToText(request, env);
			return error(`Unknown path: ${path}`, 404);
		} catch (err) {
			return error(`Gemini error: ${err instanceof Error ? err.message : String(err)}`, 500);
		}
	},
} satisfies ExportedHandler<Env>;

async function handleExpense(request: Request, env: Env): Promise<Response> {
	const p = await parseImage(request);
	if ("error" in p) return error(p.error, 400);
	return json(await receiptScanner.process({ file: p.imageBytes, mimeType: p.mimeType, suppliers: p.suppliers, apiKey: env.GEMINI_API_KEY }));
}

async function handlePostOp(request: Request, env: Env): Promise<Response> {
	const p = await parseAudio(request);
	if ("error" in p) return error(p.error, 400);
	const fields = sanitizePostOpFields(p.existingFields);
	return json(await postOpTranscriber.process({ file: p.audioBytes, mimeType: p.mimeType, existingFields: fields, apiKey: env.GEMINI_API_KEY, lang: p.lang }));
}

async function handleDentalHistory(request: Request, env: Env): Promise<Response> {
	const p = await parseAudio(request);
	if ("error" in p) return error(p.error, 400);
	return json(await dentalHistoryTranscriber.process({ file: p.audioBytes, mimeType: p.mimeType, apiKey: env.GEMINI_API_KEY, lang: p.lang }));
}

async function handleToText(request: Request, env: Env): Promise<Response> {
	const p = await parseAudio(request);
	if ("error" in p) return error(p.error, 400);
	if (p.lang) toTextTranscriber.lang = p.lang;
	const result = await toTextTranscriber.process({ file: p.audioBytes, mimeType: p.mimeType, apiKey: env.GEMINI_API_KEY });
	return json({ text: result });
}