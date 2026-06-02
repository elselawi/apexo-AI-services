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

export async function authenticate(
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
