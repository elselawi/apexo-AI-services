// ============================================================================
//  Response helpers
// ============================================================================

import type { ErrorResponse } from "./types";

export const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, HEAD, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Headers":
        "x-server,x-worker-key,Content-Type,x-custom-metadata,Content-MD5,x-amz-meta-fileid,x-amz-meta-account_id,x-amz-meta-clientid,x-amz-meta-file_id,x-amz-meta-opportunity_id,x-amz-meta-client_id,x-amz-meta-webhook,authorization",
    "Access-Control-Allow-Credentials": "true",
    Allow: "GET, POST, PUT, DELETE, HEAD, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify({ ...(data as Record<string, unknown>), _v: "5.0.0" }, null, 2), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

export function error(msg: string, status: number): Response {
    return json({ error: msg } satisfies ErrorResponse, status);
}
