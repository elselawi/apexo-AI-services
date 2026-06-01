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
	(data as any)["version"] = "4.5.1";
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
		// CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: corsHeaders
			});
		}

		const server = request.headers.get("x-server");
		const key = request.headers.get("x-worker-key");

		if (request.method === "GET") {
			// checking if the server is whitelisted.
			const server = request.headers.get("x-server");
			if (whitelist.includes(server ?? "") || whitelist.length === 0) {
				return json({ message: "ok" });
			} else {
				return error(`Server "${server}" is not whitelisted.`, 403);
			}
		}

		if (request.method !== "POST") {
			return error("Only POST requests are accepted. Send an image of a receipt.", 405);
		}

		// Authenticate
		const auth = await authenticate(server ?? "", key ?? "", env.apexo_notifications_relay);
		if (auth !== true) return error(auth, 401);

		// Parse image & suppliers
		const parsed = await parseImage(request);
		if ("error" in parsed) return error(parsed.error, 400);

		if (!parsed.suppliers || parsed.suppliers.length === 0) {
			return error('Missing "suppliers". Pass as a form field.', 400);
		}

		// Call Gemini
		try {
			const receipt = await callGemini(parsed.imageBytes, parsed.suppliers, env.GEMINI_API_KEY);
			return json(receipt);
		} catch (err) {
			return error(`Gemini error: ${err instanceof Error ? err.message : String(err)}`, 500);
		}
	},
} satisfies ExportedHandler<Env>;