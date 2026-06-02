import { whitelist } from "./whitelist";
import type { Env } from "./types";
import { authenticate } from "./auth";
import { parseImage, parseAudio } from "./parser";
import { ReceiptScanner, PostOpTranscriber, DentalHistoryTranscriber } from "./gemini";

const receiptScanner = new ReceiptScanner();
const postOpTranscriber = new PostOpTranscriber();
const dentalHistoryTranscriber = new DentalHistoryTranscriber();
import { corsHeaders, json, error } from "./response";
import { checkRateLimit } from "./rate-limit";
import { sanitizePostOpFields } from "./sanitize";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { method } = request;
		const path = new URL(request.url).pathname;

		if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

		if (method === "GET" && path === "/") {
			const s = request.headers.get("x-server");
			return whitelist.includes(s ?? "") || whitelist.length === 0
				? json({ message: "ok" })
				: error(`Server "${s}" not whitelisted.`, 403);
		}

		if (method !== "POST") return error("Only POST accepted.", 405);

		// Auth
		const server = request.headers.get("x-server");
		const key = request.headers.get("x-worker-key");
		const auth = await authenticate(server ?? "", key ?? "", env.apexo_notifications_relay);
		if (auth !== true) return error(auth, 401);

		// Rate limit
		const rateCheck = await checkRateLimit(server ?? "unknown", env.apexo_notifications_relay);
		if (rateCheck !== true) return error(rateCheck, 429);

		try {
			if (path === "/expense" || path === "/") return handleExpense(request, env);
			if (path === "/post-op-notes") return handlePostOp(request, env);
			if (path === "/dental-history") return handleDentalHistory(request, env);
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