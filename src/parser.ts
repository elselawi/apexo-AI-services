// ============================================================================
//  Request parsers — multipart/form-data → raw bytes
// ============================================================================

import type { ErrorResponse, PostOpData } from "./types";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_SUPPLIERS = 80;

export async function parseImage(
    request: Request,
): Promise<{ imageBytes: Uint8Array; mimeType: string; suppliers: string[] | null } | ErrorResponse> {
    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.includes("multipart/form-data")) {
        return { error: "Send the image as multipart/form-data." };
    }

    const form = await request.formData();

    let suppliers: string[] | null = null;
    const fs = form.get("suppliers");
    if (fs && typeof fs === "string") {
        suppliers = fs.split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_SUPPLIERS);
    }

    const file = form.get("image") ?? form.get("file") ?? form.get("receipt");
    if (!file || !(file instanceof File)) {
        return { error: 'No image file found. Use "image", "file", or "receipt" field.' };
    }

    if (file.size > MAX_FILE_SIZE) {
        return { error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB).` };
    }

    const imageBytes = new Uint8Array(await file.arrayBuffer());
    const mimeType =
        file.type && file.type !== "application/octet-stream"
            ? file.type
            : detectImageMime(imageBytes);

    return { imageBytes, mimeType, suppliers };
}

export async function parseAudio(
    request: Request,
): Promise<{
    audioBytes: Uint8Array;
    mimeType: string;
    existingFields: Partial<PostOpData>;
    lang?: string;
} | ErrorResponse> {
    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.includes("multipart/form-data")) {
        return { error: "Send the audio as multipart/form-data." };
    }

    const form = await request.formData();

    // Pre-filled fields as a single JSON string
    const existingFields: Partial<PostOpData> = {};
    const raw = form.get("existingFields");
    if (raw && typeof raw === "string") {
        try {
            Object.assign(existingFields, JSON.parse(raw) as Partial<PostOpData>);
        } catch {
            return { error: 'Invalid JSON in "existingFields" form field.' };
        }
    }

    // Optional output language
    let lang: string | undefined;
    const langField = form.get("lang");
    if (langField && typeof langField === "string" && langField.length === 2) {
        lang = langField.toLowerCase();
    }

    // Audio file
    const file = form.get("audio") ?? form.get("file");
    if (!file || !(file instanceof File)) {
        return { error: 'No audio file found. Use "audio" or "file" field.' };
    }

    if (file.size > MAX_FILE_SIZE) {
        return { error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB).` };
    }

    const audioBytes = new Uint8Array(await file.arrayBuffer());
    const mimeType =
        file.type && file.type !== "application/octet-stream"
            ? file.type
            : detectAudioMimeType(audioBytes);

    return { audioBytes, mimeType, existingFields, lang };
}

// ---- MIME detection ----

export function detectImageMime(bytes: Uint8Array): string {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
    return "image/jpeg";
}

function detectAudioMimeType(bytes: Uint8Array): string {
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "audio/wav";
    if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return "audio/ogg";
    if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return "audio/flac";
    return "audio/mp4";
}
