// ============================================================================
//  Per-server rate limiting — KV-backed sliding window
// ============================================================================

const MAX_REQUESTS = 5; // per window
const WINDOW_SECONDS = 60; // 1 minute

interface RateLimitEntry {
    count: number;
    resetAt: number; // epoch ms
}

/**
 * Checks if the given server has exceeded its rate limit.
 * Returns `true` if allowed, or an error message string if blocked.
 *
 * Uses KV for storage — eventual consistency means bursts slightly above
 * the limit are possible, but this is acceptable for our use case.
 */
export async function checkRateLimit(
    server: string,
    kv: KVNamespace,
): Promise<true | string> {
    const now = Date.now();
    const key = `rate:${server}`;

    const raw = await kv.get(key);
    let entry: RateLimitEntry;

    if (raw) {
        entry = JSON.parse(raw) as RateLimitEntry;
        // Window expired — reset
        if (now >= entry.resetAt) {
            entry = { count: 1, resetAt: now + WINDOW_SECONDS * 1000 };
        } else if (entry.count >= MAX_REQUESTS) {
            const remaining = Math.ceil((entry.resetAt - now) / 1000);
            return `Rate limit exceeded. Try again in ${remaining}s.`;
        } else {
            entry.count++;
        }
    } else {
        entry = { count: 1, resetAt: now + WINDOW_SECONDS * 1000 };
    }

    // Write back — fire-and-forget to avoid adding latency
    kv.put(key, JSON.stringify(entry), {
        expirationTtl: WINDOW_SECONDS + 10,
    }).catch(() => { });

    return true;
}
