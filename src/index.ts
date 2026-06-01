import { whitelist } from "./whitelist";

export interface Env {
	apexo_notifications_relay: KVNamespace;
	GEMINI_API_KEY: string;
}

// ============================================================================
//  Authentication — SHA-256 hashed keys stored in KV
// ============================================================================

async function hashKey(key: string): Promise<string> {
	const msg = new TextEncoder().encode(key);
	const hash = await crypto.subtle.digest("SHA-256", msg);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function authenticate(
	server: string,
	key: string,
	kv: KVNamespace,
): Promise<true | string> {
	if (!server || !key) return "Missing 'x-server' or 'x-worker-key' headers.";

	const hashed = await hashKey(key);
	const raw = await kv.get(server);
	if (raw === null) return `Server "${server}" not found.`;

	let storedKey: string;
	try {
		storedKey = (JSON.parse(raw) as { key: string }).key;
	} catch {
		return "Invalid server data in KV.";
	}

	return storedKey === hashed ? true : "Authentication key does not match.";
}

// ============================================================================
//  Types
// ============================================================================

interface ReceiptItem {
	name: string;
	quantity: number;
	unitPrice: number;
	totalPrice: number;
}

interface ReceiptData {
	supplierName: string;
	orderDate: string;
	orderItems: ReceiptItem[];
	totalPrice: number;
}

interface ErrorResponse {
	error: string;
}

// Post-op notes (audio)
interface PostOpData {
	postOpNotes: string;
	prescriptions: string[];
	price: number;
	paid: number;
	teeth: Record<string, string>;
	teethExtraNotes: Record<string, string>;
	hasLabwork: boolean;
	labName: string;
	labworkNotes: string;
}

// ============================================================================
//  Gemini API
// ============================================================================

const GEMINI_UPLOAD = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_GENERATE =
	"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

function detectMimeType(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
	return "image/jpeg";
}

function buildPrompt(suppliers: string[]): string {
	const list = suppliers.map((s) => `"${s}"`).join(", ");
	return `Analyze this receipt image and extract the following fields.

Available suppliers: ${list}

Receipt structure rules:
- Header (store name, date) → then product line items (name + price) → then a grand TOTAL.
- The grand TOTAL is NOT a line item — do NOT include it in orderItems.
- Subtotals, tax lines, and running balances are NOT products. Skip them.
- Count actual product rows. 5 products = exactly 5 items in orderItems.
- Copy product names exactly, even if in Arabic or other scripts.
- If a name is truly unreadable, write "unreadable".
- All prices as numbers, not strings. totalPrice must match the receipt's grand total.`;
}

function buildResponseSchema() {
	return {
		type: "OBJECT",
		properties: {
			supplierName: { type: "STRING", description: "Best match from the supplied suppliers, or the store name on the receipt" },
			orderDate: { type: "STRING", description: "Date as YYYY-MM-DD; if only month/day, use most recent past date" },
			orderItems: {
				type: "ARRAY",
				description: "Product line items only — not totals, tax, or subtotals",
				items: {
					type: "OBJECT",
					properties: {
						name: { type: "STRING", description: "Product name as written" },
						quantity: { type: "NUMBER", description: "Quantity" },
						unitPrice: { type: "NUMBER", description: "Price per unit" },
						totalPrice: { type: "NUMBER", description: "Line total" },
					},
					required: ["name", "quantity", "unitPrice", "totalPrice"],
				},
			},
			totalPrice: { type: "NUMBER", description: "Grand total at the bottom of the receipt" },
		},
		required: ["supplierName", "orderDate", "orderItems", "totalPrice"],
	};
}

async function callGemini(
	imageBytes: Uint8Array,
	suppliers: string[],
	apiKey: string,
): Promise<ReceiptData> {
	const mimeType = detectMimeType(imageBytes);
	const ext = mimeType.split("/")[1];

	// 1. Upload to Gemini Files API
	const metadata = { file: { displayName: `receipt_${Date.now()}.${ext}` } };
	const formData = new FormData();
	formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
	formData.append("file", new Blob([imageBytes], { type: mimeType }));

	const uploadRes = await fetch(`${GEMINI_UPLOAD}?uploadType=multipart&key=${apiKey}`, {
		method: "POST",
		headers: { "X-Goog-Upload-Protocol": "multipart" },
		body: formData,
	});

	if (!uploadRes.ok) {
		throw new Error(`Gemini upload error ${uploadRes.status}: ${await uploadRes.text()}`);
	}

	const uploadData = (await uploadRes.json()) as { file?: { uri?: string } };
	const fileUri = uploadData.file?.uri;
	if (!fileUri) throw new Error("Gemini upload returned no file URI");

	// 2. Generate content (with retries on rate-limit / server errors)
	const payload = {
		contents: [{
			parts: [
				{ text: buildPrompt(suppliers) },
				{ fileData: { mimeType, fileUri } },
			],
		}],
		generationConfig: {
			responseMimeType: "application/json",
			responseSchema: buildResponseSchema(),
			temperature: 0.1,
			maxOutputTokens: 2048,
		},
	};

	let lastError: Error | null = null;

	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) {
			await new Promise((r) => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
		}

		const res = await fetch(`${GEMINI_GENERATE}?key=${apiKey}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (res.status === 429 || res.status >= 500) {
			lastError = new Error(`Gemini API error ${res.status}: ${await res.text()}`);
			continue;
		}

		if (!res.ok) {
			throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
		}

		const data = (await res.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		};
		const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) throw new Error("Gemini returned no content");

		return JSON.parse(text) as ReceiptData;
	}

	throw lastError ?? new Error("Gemini API failed after 3 retries.");
}

// ============================================================================
//  Gemini API — Audio (Post-Op Notes)
// ============================================================================

function detectAudioMimeType(bytes: Uint8Array, suppliedType?: string): string {
	if (suppliedType?.startsWith("audio/")) return suppliedType;
	// Detect by magic bytes
	if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";       // MP3
	if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "audio/wav"; // WAV/RIFF
	if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg"; // OGG
	if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "audio/flac";// FLAC
	return "audio/mp4"; // default for m4a and others
}

function buildPostOpPrompt(existing: Partial<PostOpData>): string {
	const ctx = Object.keys(existing).length
		? `\n\nExisting fields (use as context; the audio may add to or override these):\n${JSON.stringify(existing, null, 2)}`
		: "";
	return `You are a dental post-operation note extractor. Listen to this audio recording and extract the following fields.${ctx}

Output ONLY valid JSON (no markdown).

The response must have this shape:
{
  "postOpNotes": "free-form notes for anything that doesn't fit below",
  "prescriptions": ["medication name", "..."],
  "price": 0,
  "paid": 0,
  "teeth": {
    "11": "filling",
    "12": "extraction"
  },
  "teethExtraNotes": {
    "11": "additional info specific to tooth 11"
  },
  "hasLabwork": false,
  "labName": "",
  "labworkNotes": ""
}

Rules:
- postOpNotes: transcribe any free-form remarks, instructions, or observations.
- prescriptions: list each medication name mentioned. Empty array if none.
- price: the total fee charged (number). 0 if not mentioned.
- paid: the amount the patient paid (number). 0 if not mentioned.
- teeth: ISO FDI numbering (11-18, 21-28, 31-38, 41-48 as strings). Values must be one of: extraction, pulpotomy, filling, rCT, re-RCT, ortho, whitening, clean, implant, surgery, crown, veneer, overlay, temporary, bridge, abutment, pontic, other. Only include teeth explicitly mentioned.
- teethExtraNotes: same tooth keys as above, but only for teeth that have extra detail beyond the procedure name.
- hasLabwork: true if impression, scan, or lab work is mentioned.
- labName: the lab name if mentioned.
- labworkNotes: any notes about the lab work.
- If a field wasn't mentioned at all, use its default (empty string/array, 0, false).
- Merge with existing fields: if the audio adds new info, include it. If it contradicts, the audio takes precedence.`;
}

function buildPostOpSchema() {
	return {
		type: "OBJECT",
		properties: {
			postOpNotes: { type: "STRING", description: "Free-form notes from the audio" },
			prescriptions: {
				type: "ARRAY",
				description: "List of medication names prescribed",
				items: { type: "STRING" },
			},
			price: { type: "NUMBER", description: "Fee charged to the patient" },
			paid: { type: "NUMBER", description: "Amount the patient actually paid" },
			teeth: {
				type: "OBJECT",
				description: "ISO FDI tooth numbers → procedure name",
				properties: {},
			},
			teethExtraNotes: {
				type: "OBJECT",
				description: "ISO FDI tooth numbers → extra free-form notes (only for teeth in 'teeth' field)",
				properties: {},
			},
			hasLabwork: { type: "BOOLEAN", description: "Whether lab work is needed" },
			labName: { type: "STRING", description: "Lab name if applicable" },
			labworkNotes: { type: "STRING", description: "Notes about the lab work" },
		},
		required: ["postOpNotes", "prescriptions", "price", "paid", "teeth", "teethExtraNotes", "hasLabwork", "labName", "labworkNotes"],
	};
}

async function callGeminiAudio(
	audioBytes: Uint8Array,
	mimeType: string,
	existingFields: Partial<PostOpData>,
	apiKey: string,
): Promise<PostOpData> {
	const ext = mimeType.split("/")[1] || "mp3";

	// 1. Upload to Gemini Files API
	const metadata = { file: { displayName: `audio_${Date.now()}.${ext}` } };
	const formData = new FormData();
	formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
	formData.append("file", new Blob([audioBytes], { type: mimeType }));

	const uploadRes = await fetch(`${GEMINI_UPLOAD}?uploadType=multipart&key=${apiKey}`, {
		method: "POST",
		headers: { "X-Goog-Upload-Protocol": "multipart" },
		body: formData,
	});

	if (!uploadRes.ok) {
		throw new Error(`Gemini upload error ${uploadRes.status}: ${await uploadRes.text()}`);
	}

	const uploadData = (await uploadRes.json()) as { file?: { uri?: string } };
	const fileUri = uploadData.file?.uri;
	if (!fileUri) throw new Error("Gemini upload returned no file URI");

	// 2. Generate content
	const payload = {
		contents: [{
			parts: [
				{ text: buildPostOpPrompt(existingFields) },
				{ fileData: { mimeType, fileUri } },
			],
		}],
		generationConfig: {
			responseMimeType: "application/json",
			responseSchema: buildPostOpSchema(),
			temperature: 0.1,
			maxOutputTokens: 4096,
		},
	};

	let lastError: Error | null = null;

	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) {
			await new Promise((r) => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
		}

		const res = await fetch(`${GEMINI_GENERATE}?key=${apiKey}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (res.status === 429 || res.status >= 500) {
			lastError = new Error(`Gemini API error ${res.status}: ${await res.text()}`);
			continue;
		}

		if (!res.ok) {
			throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
		}

		const data = (await res.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		};
		const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) throw new Error("Gemini returned no content");

		return JSON.parse(text) as PostOpData;
	}

	throw lastError ?? new Error("Gemini API failed after 3 retries.");
}

// ============================================================================
//  Request parsing
// ============================================================================

async function parseImage(request: Request): Promise<
	{ imageBytes: Uint8Array; suppliers: string[] | null } | ErrorResponse
> {
	const contentType = request.headers.get("Content-Type") || "";

	if (!contentType.includes("multipart/form-data")) {
		return { error: "Send the image as multipart/form-data." };
	}

	const form = await request.formData();

	let suppliers: string[] | null = null;
	const fs = form.get("suppliers");
	if (fs && typeof fs === "string") suppliers = fs.split(",").map((s) => s.trim()).filter(Boolean);

	const file = form.get("image") ?? form.get("file") ?? form.get("receipt");
	if (!file || !(file instanceof File)) {
		return { error: 'No image file found. Use "image", "file", or "receipt" field.' };
	}
	return { imageBytes: new Uint8Array(await file.arrayBuffer()), suppliers };
}

// ============================================================================
//  Audio parsing (post-op notes)
// ============================================================================

async function parseAudio(request: Request): Promise<
	{ audioBytes: Uint8Array; mimeType: string; existingFields: Partial<PostOpData> } | ErrorResponse
> {
	const contentType = request.headers.get("Content-Type") || "";

	if (!contentType.includes("multipart/form-data")) {
		return { error: "Send the audio as multipart/form-data." };
	}

	const form = await request.formData();

	// Parse pre-filled fields from a single JSON form field
	const existingFields: Partial<PostOpData> = {};
	const raw = form.get("existingFields");
	if (raw && typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as Partial<PostOpData>;
			Object.assign(existingFields, parsed);
		} catch {
			return { error: 'Invalid JSON in "existingFields" form field.' };
		}
	}

	// Parse audio file
	const file = form.get("audio") ?? form.get("file");
	if (!file || !(file instanceof File)) {
		return { error: 'No audio file found. Use "audio" or "file" field.' };
	}

	const audioBytes = new Uint8Array(await file.arrayBuffer());
	const mimeType = (file.type && file.type !== "application/octet-stream")
		? file.type
		: detectAudioMimeType(audioBytes);

	return { audioBytes, mimeType, existingFields };
}

// ============================================================================
//  Response helpers
// ============================================================================

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, HEAD, OPTIONS',
	'Access-Control-Max-Age': '86400',
	'Access-Control-Allow-Headers': 'x-server,x-worker-key,Content-Type,x-custom-metadata,Content-MD5,x-amz-meta-fileid,x-amz-meta-account_id,x-amz-meta-clientid,x-amz-meta-file_id,x-amz-meta-opportunity_id,x-amz-meta-client_id,x-amz-meta-webhook,authorization',
	'Access-Control-Allow-Credentials': 'true',
	'Allow': 'GET, POST, PUT, DELETE, HEAD, OPTIONS'
};


function json(data: unknown, status = 200): Response {
	(data as any)["version"] = "4.6.5";
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			...corsHeaders,
			"Content-Type": "application/json",
		},
	});
}

function error(msg: string, status: number): Response {
	return json({ error: msg } satisfies ErrorResponse, status);
}

// ============================================================================
//  Worker entry point
// ============================================================================

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method;
		const path = url.pathname;

		// CORS preflight
		if (method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		// Health / whitelist check
		if (method === "GET" && path === "/") {
			const server = request.headers.get("x-server");
			if (whitelist.includes(server ?? "") || whitelist.length === 0) {
				return json({ message: "ok" });
			}
			return error(`Server "${server}" is not whitelisted.`, 403);
		}

		// All other endpoints require POST
		if (method !== "POST") {
			return error("Only POST requests are accepted.", 405);
		}

		// Authenticate
		const server = request.headers.get("x-server");
		const key = request.headers.get("x-worker-key");
		const auth = await authenticate(server ?? "", key ?? "", env.apexo_notifications_relay);
		if (auth !== true) return error(auth, 401);

		// ---- Route: /expense ----
		if (path === "/expense" || path === "/") {
			const parsed = await parseImage(request);
			if ("error" in parsed) return error(parsed.error, 400);

			if (!parsed.suppliers || parsed.suppliers.length === 0) {
				return error('Missing "suppliers" form field.', 400);
			}

			try {
				const receipt = await callGemini(parsed.imageBytes, parsed.suppliers, env.GEMINI_API_KEY);
				return json(receipt);
			} catch (err) {
				return error(`Gemini error: ${err instanceof Error ? err.message : String(err)}`, 500);
			}
		}

		// ---- Route: /post-op-notes ----
		if (path === "/post-op-notes") {
			const parsed = await parseAudio(request);
			if ("error" in parsed) return error(parsed.error, 400);

			try {
				const notes = await callGeminiAudio(parsed.audioBytes, parsed.mimeType, parsed.existingFields, env.GEMINI_API_KEY);
				return json(notes);
			} catch (err) {
				return error(`Gemini error: ${err instanceof Error ? err.message : String(err)}`, 500);
			}
		}

		return error(`Unknown path: ${path}`, 404);
	},
} satisfies ExportedHandler<Env>;