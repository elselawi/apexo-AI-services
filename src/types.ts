// ============================================================================
//  Shared types
// ============================================================================

export interface Env {
    apexo_notifications_relay: KVNamespace;
    GEMINI_API_KEY: string;
}

export interface ReceiptItem {
    name: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
}

export interface ReceiptData {
    supplierName: string;
    orderDate: string;
    orderItems: ReceiptItem[];
    totalPrice: number;
}

export interface PostOpData {
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

export interface DentalHistoryData {
    teeth: Record<string, string>;
    teethExtraNotes: Record<string, string>;
}

export interface ErrorResponse {
    error: string;
}

export interface GeminiPayload {
    contents: Array<{
        parts: Array<
            { text: string } | { fileData: { mimeType: string; fileUri: string } }
        >;
    }>;
    generationConfig: {
        responseMimeType: string;
        responseSchema: SchemaType;
        temperature: number;
        maxOutputTokens: number;
    };
}

export interface SchemaType {
    type: string;
    description?: string;
    properties?: Record<string, SchemaType>;
    required?: string[];
    items?: SchemaType;
    enum?: string[];
}

export interface ProcessParams {
    file: Uint8Array;
    apiKey: string;
    mimeType: string;
}

export interface PostOpProcessParams extends ProcessParams {
    existingFields: Partial<PostOpData>;
    lang?: string;
}

export interface DentalHistoryProcessParams extends ProcessParams {
    lang?: string;
}

export interface ScannerProcessParams extends ProcessParams {
    suppliers?: string[] | null;
}

// ============================================================================
//  Token auth types
// ============================================================================

export interface TokenData {
    server: string;
    expiresAt: number; // epoch ms
}