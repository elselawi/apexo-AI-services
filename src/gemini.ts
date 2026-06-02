// ============================================================================
//  Gemini API — upload, prompts, schemas, and calls
// ============================================================================

import type { ReceiptData, PostOpData, DentalHistoryData, GeminiPayload, SchemaType, ProcessParams, ScannerProcessParams, PostOpProcessParams, DentalHistoryProcessParams, } from "./types";

// ---- Abstract base ----

abstract class GeminiProcess {
    protected readonly UPLOAD = "https://generativelanguage.googleapis.com/upload/v1beta/files";
    protected readonly GENERATE = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
    protected readonly ALL_TEETH = [
        "11", "12", "13", "14", "15", "16", "17", "18",
        "21", "22", "23", "24", "25", "26", "27", "28",
        "31", "32", "33", "34", "35", "36", "37", "38",
        "41", "42", "43", "44", "45", "46", "47", "48",
    ];

    /** Every subclass must implement a prompt builder. */
    protected abstract prompt(): string;

    /** Every subclass must implement a response schema builder. */
    protected abstract schema(): SchemaType;

    /** Every subclass must implement the processing entry point. */
    abstract process(processParams: ProcessParams): Promise<unknown>;

    protected async upload(bytes: Uint8Array, mimeType: string, displayName: string, apiKey: string): Promise<string> {
        const fd = new FormData();
        fd.append("metadata", new Blob([JSON.stringify({ file: { displayName } })], { type: "application/json" }));
        fd.append("file", new Blob([bytes], { type: mimeType }));

        const res = await fetch(`${this.UPLOAD}?uploadType=multipart&key=${apiKey}`, {
            method: "POST",
            headers: { "X-Goog-Upload-Protocol": "multipart" },
            body: fd,
        });
        if (!res.ok) throw new Error(`Gemini upload error ${res.status}: ${await res.text()}`);

        const data = (await res.json()) as { file?: { uri?: string } };
        const uri = data.file?.uri;
        if (!uri) throw new Error("Gemini upload returned no file URI");
        return uri;
    }

    protected async generate<T>(payload: GeminiPayload, apiKey: string): Promise<T> {
        let lastError: Error | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, Math.pow(2, attempt - 1) * 1000));

            const res = await fetch(`${this.GENERATE}?key=${apiKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`Gemini API error ${res.status}: ${await res.text()}`);
                continue;
            }
            if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);

            const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error("Gemini returned no content");

            return JSON.parse(text) as T;
        }
        throw lastError ?? new Error("Gemini API failed after 3 retries.");
    }

    protected toothProps(enumValues?: string[]): Record<string, { type: string; enum?: string[] }> {
        const props: Record<string, { type: string; enum?: string[] }> = {};
        for (const t of this.ALL_TEETH) props[t] = enumValues ? { type: "STRING", enum: enumValues } : { type: "STRING" };
        return props;
    }
}







// ============================================================================
//  Receipt Scanner
// ============================================================================

export class ReceiptScanner extends GeminiProcess {

    suppliers: string[] = [];

    async process({ file, mimeType, suppliers, apiKey }: ScannerProcessParams): Promise<ReceiptData> {
        this.suppliers = suppliers ?? [];

        const ext = mimeType.split("/")[1];

        const fileUri = await this.upload(file, mimeType, `receipt_${Date.now()}.${ext}`, apiKey);
        return await this.generate<ReceiptData>(
            {
                contents: [{ parts: [{ text: this.prompt() }, { fileData: { mimeType, fileUri } }] }],
                generationConfig: { responseMimeType: "application/json", responseSchema: this.schema(), temperature: 0.1, maxOutputTokens: 2048 },
            },
            apiKey);
    }

    protected prompt(): string {
        const supplierHint = this.suppliers.length
            ? `Available suppliers to match against: ${this.suppliers.map((s) => `"${s}"`).join(", ")}`
            : "Use whatever store name is printed on the receipt.";
        return `Analyze this receipt image and extract the following fields.

${supplierHint}

Receipt structure rules:
- Header (store name, date) → then product line items (name + price) → then a grand TOTAL.
- The grand TOTAL is NOT a line item — do NOT include it in orderItems.
- Subtotals, tax lines, and running balances are NOT products. Skip them.
- Count actual product rows. 5 products = exactly 5 items in orderItems.
- Copy product names exactly, even if in Arabic or other scripts.
- If a name is truly unreadable, write "unreadable".
- All prices as numbers, not strings. totalPrice must match the receipt's grand total.`;
    }

    protected schema() {
        const supplierDesc = this.suppliers.length
            ? `Best match from: ${this.suppliers.map((s) => `"${s}"`).join(", ")}`
            : "The store name printed on the receipt";
        return {
            type: "OBJECT",
            properties: {
                supplierName: { type: "STRING", description: supplierDesc },
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
}

// ============================================================================
//  Post-Op Transcriber
// ============================================================================



export class PostOpTranscriber extends GeminiProcess {

    POSTOP_PROCEDURES = [
        "extraction", "pulpotomy", "filling", "rCT", "re-RCT", "ortho", "whitening", "clean",
        "implant", "surgery", "crown", "veneer", "overlay", "temporary", "bridge", "abutment", "pontic", "other",
    ];

    existingFields: Partial<PostOpData> = {};
    lang: string | undefined = undefined;

    async process({ file, mimeType, existingFields, apiKey, lang }: PostOpProcessParams): Promise<PostOpData> {
        this.existingFields = existingFields;
        this.lang = lang;
        const ext = mimeType.split("/")[1] || "mp3";

        const fileUri = await this.upload(file, mimeType, `audio_${Date.now()}.${ext}`, apiKey);
        return await this.generate<PostOpData>(
            {
                contents: [{ parts: [{ text: this.prompt() }, { fileData: { mimeType, fileUri } }] }],
                generationConfig: { responseMimeType: "application/json", responseSchema: this.schema(), temperature: 0.1, maxOutputTokens: 4096 },
            },
            apiKey);
    }

    protected prompt(): string {
        const ctx = Object.keys(this.existingFields).length
            ? `\n\nExisting fields (use as context; the audio may add to or override these):\n${JSON.stringify(this.existingFields, null, 2)}`
            : "";
        const langNote = this.lang
            ? `\n\nTRANSLATION: Translate "postOpNotes", "teethExtraNotes", and "labworkNotes" to "${this.lang}". Do NOT translate medication names, tooth numbers, or procedure names.`
            : "";
        return `You are a dental post-operation note extractor. Listen to this audio recording and extract the following fields.${ctx}${langNote}

Output ONLY valid JSON (no markdown).

{
  "postOpNotes": "clear, rephrased summary of any remarks, instructions, or observations",
  "prescriptions": ["medication name"],
  "price": 0,
  "paid": 0,
  "teeth": { "11": "filling", "21": "extraction" },
  "teethExtraNotes": { "11": "mesial decay noted" },
  "hasLabwork": false,
  "labName": "",
  "labworkNotes": ""
}

RULES:
- postOpNotes: Rephrase free-form remarks into a clear, concise, well-structured paragraph. Remove filler words, fix grammar, but preserve ALL clinical information.
- prescriptions: every medication name mentioned. Empty array if none.
- price: total fee charged (number). 0 if not mentioned.
- paid: amount patient actually paid (number). 0 if not mentioned.
- teeth: THIS IS CRITICAL — you MUST fill this. Listen carefully for ANY tooth mentioned. ISO FDI notation (11-18 upper right, 21-28 upper left, 31-38 lower left, 41-48 lower right). Values: ${this.POSTOP_PROCEDURES.join(", ")}. Convert descriptions: "upper left six" = 26, "lower right one" = 41.
- teethExtraNotes: same keys as teeth, extra detail beyond the procedure name.
- hasLabwork: true ONLY if impression, scan, or lab is explicitly mentioned.
- labName / labworkNotes: lab info if mentioned.
- Defaults: empty string/array for missing, 0 for numbers, false for booleans.
- Merger: audio adds new info, overrides conflicting existing fields.`;
    }

    protected schema() {
        return {
            type: "OBJECT",
            properties: {
                postOpNotes: { type: "STRING", description: "Rephrased, clear summary of the audio notes" },
                prescriptions: { type: "ARRAY", description: "List of medication names", items: { type: "STRING" } },
                price: { type: "NUMBER", description: "Fee charged" },
                paid: { type: "NUMBER", description: "Amount paid" },
                teeth: { type: "OBJECT", description: "ISO FDI tooth numbers → procedure. Fill if teeth discussed.", properties: this.toothProps(this.POSTOP_PROCEDURES) },
                teethExtraNotes: { type: "OBJECT", description: "Same keys as teeth; free-form notes", properties: this.toothProps() },
                hasLabwork: { type: "BOOLEAN", description: "True if impression, scan, or lab mentioned" },
                labName: { type: "STRING", description: "Lab name" },
                labworkNotes: { type: "STRING", description: "Lab notes" },
            },
            required: ["postOpNotes", "prescriptions", "price", "paid", "teeth", "teethExtraNotes", "hasLabwork", "labName", "labworkNotes"],
        };
    }
}

// ============================================================================
//  Dental History Transcriber
// ============================================================================


export class DentalHistoryTranscriber extends GeminiProcess {

    DENTAL_CONDITIONS = [
        "missing", "filling", "caries", "rCT", "fractured", "mobility", "recession", "rroot",
        "implant", "rprimary", "malposition", "crown", "veneer", "overlay", "impacted", "bridge", "abutment", "pontic", "other",
    ];

    lang: string | undefined = undefined;

    async process({ file, mimeType, apiKey, lang }: DentalHistoryProcessParams): Promise<DentalHistoryData> {
        this.lang = lang;
        const ext = mimeType.split("/")[1] || "mp3";

        const fileUri = await this.upload(file, mimeType, `dental_${Date.now()}.${ext}`, apiKey);
        return await this.generate<DentalHistoryData>(
            {
                contents: [{ parts: [{ text: this.prompt() }, { fileData: { mimeType, fileUri } }] }],
                generationConfig: { responseMimeType: "application/json", responseSchema: this.schema(), temperature: 0.1, maxOutputTokens: 4096 },
            },
            apiKey);
    }

    protected prompt(): string {
        const langNote = this.lang
            ? `\n\nTRANSLATION: Translate "teethExtraNotes" values to "${this.lang}". Do NOT translate tooth numbers or condition names.`
            : "";
        return `You are a dental history extractor. Listen to this audio recording and extract tooth conditions.${langNote}

Output ONLY valid JSON (no markdown).

{
  "teeth": { "11": "filling", "21": "caries" },
  "teethExtraNotes": { "11": "mesial decay, patient reports sensitivity" }
}

RULES:
- teeth: ISO FDI notation (11-18, 21-28, 31-38, 41-48 as strings). Values: ${this.DENTAL_CONDITIONS.join(", ")}. Listen for EVERY tooth mentioned. Convert: upper right 1-8 = 11-18, upper left 1-8 = 21-28, lower left 1-8 = 31-38, lower right 1-8 = 41-48.
- teethExtraNotes: same keys as teeth; free-form detail beyond condition name. Rephrase into clear text.
- Empty object {} if nothing found.`;
    }

    protected schema() {
        return {
            type: "OBJECT",
            properties: {
                teeth: { type: "OBJECT", description: "ISO FDI tooth numbers → dental condition", properties: this.toothProps(this.DENTAL_CONDITIONS) },
                teethExtraNotes: { type: "OBJECT", description: "Same keys as teeth; free-form notes", properties: this.toothProps() },
            },
            required: ["teeth", "teethExtraNotes"],
        };
    }
}
