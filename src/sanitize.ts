// ============================================================================
//  Input sanitization for post-op notes
// ============================================================================

import type { PostOpData } from "./types";

const VALID_TEETH = new Set([
    "11", "12", "13", "14", "15", "16", "17", "18",
    "21", "22", "23", "24", "25", "26", "27", "28",
    "31", "32", "33", "34", "35", "36", "37", "38",
    "41", "42", "43", "44", "45", "46", "47", "48",
]);

const VALID_PROCEDURES = new Set([
    "extraction", "pulpotomy", "filling", "rCT", "re-RCT", "ortho", "whitening", "clean",
    "implant", "surgery", "crown", "veneer", "overlay", "temporary", "bridge", "abutment", "pontic", "other",
]);

const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_LENGTH = 50;

/** Strip HTML tags and truncate long strings. */
function cleanString(value: unknown, maxLen = MAX_STRING_LENGTH): string {
    if (typeof value !== "string") return "";
    return value.replace(/<[^>]*>/g, "").trim().slice(0, maxLen);
}

/**
 * Sanitize the pre-filled fields before passing them to Gemini.
 * Ensures only valid tooth numbers, procedures, and reasonable lengths.
 */
export function sanitizePostOpFields(fields: Partial<PostOpData>): Partial<PostOpData> {
    const sanitized: Partial<PostOpData> = {};

    if (fields.postOpNotes !== undefined) {
        sanitized.postOpNotes = cleanString(fields.postOpNotes);
    }

    if (fields.prescriptions !== undefined) {
        const arr = Array.isArray(fields.prescriptions) ? fields.prescriptions : [];
        sanitized.prescriptions = arr.slice(0, MAX_ARRAY_LENGTH).map((p) => cleanString(p, 200));
    }

    if (fields.price !== undefined) {
        const n = Number(fields.price);
        sanitized.price = isNaN(n) || n < 0 ? 0 : Math.round(n * 100) / 100;
    }

    if (fields.paid !== undefined) {
        const n = Number(fields.paid);
        sanitized.paid = isNaN(n) || n < 0 ? 0 : Math.round(n * 100) / 100;
    }

    if (fields.teeth !== undefined && typeof fields.teeth === "object" && fields.teeth !== null) {
        const teeth: Record<string, string> = {};
        for (const [tooth, procedure] of Object.entries(fields.teeth as Record<string, unknown>)) {
            if (!VALID_TEETH.has(tooth)) continue;
            const proc = cleanString(procedure, 50).toLowerCase();
            if (!VALID_PROCEDURES.has(proc)) continue;
            teeth[tooth] = proc;
        }
        sanitized.teeth = teeth;
    }

    if (fields.teethExtraNotes !== undefined && typeof fields.teethExtraNotes === "object" && fields.teethExtraNotes !== null) {
        const notes: Record<string, string> = {};
        for (const [tooth, note] of Object.entries(fields.teethExtraNotes as Record<string, unknown>)) {
            if (!VALID_TEETH.has(tooth)) continue;
            notes[tooth] = cleanString(note);
        }
        // Only keep notes for teeth that exist in sanitized teeth
        if (sanitized.teeth) {
            for (const tooth of Object.keys(notes)) {
                if (!(tooth in sanitized.teeth)) delete notes[tooth];
            }
        }
        sanitized.teethExtraNotes = notes;
    }

    if (fields.hasLabwork !== undefined) {
        sanitized.hasLabwork = Boolean(fields.hasLabwork);
    }

    if (fields.labName !== undefined) {
        sanitized.labName = cleanString(fields.labName, 200);
    }

    if (fields.labworkNotes !== undefined) {
        sanitized.labworkNotes = cleanString(fields.labworkNotes);
    }

    return sanitized;
}
