// ============================================================================
//  Authentication — server key (SHA-256) + bearer token auth
// ============================================================================

import type { TokenData } from "./types";

const TOKEN_TTL_SECONDS = 86400; // 24 hours
const MAX_TOKENS_PER_SERVER = 20;
const TOKEN_BYTES = 32; // 256-bit random token

// ============================================================================
//  AuthManager — wraps all KV-backed auth operations
// ============================================================================

export class AuthManager {
    constructor(private readonly kv: KVNamespace) { }

    // ── Server key authentication (used by /auth) ────────────────────────

    async authenticateServer(server: string, key: string): Promise<true | string> {
        if (!server || !key) return "Missing 'x-server' or 'x-worker-key' headers.";

        const hashed = await AuthManager.hashKey(key);
        const raw = await this.kv.get(server);
        if (raw === null) return `Server "${server}" not found.`;

        let storedKey: string;
        try {
            storedKey = (JSON.parse(raw) as { key: string }).key;
        } catch {
            return "Invalid server data in KV.";
        }

        return storedKey === hashed ? true : "Authentication key does not match.";
    }

    // ── Token creation (used by /auth after key auth) ────────────────────

    async createToken(server: string): Promise<{ token: string } | { error: string }> {
        const [tokens, hasPruned] = await this.pruneServerTokens(server);

        if (hasPruned) {
            await this.kv
                .put(AuthManager.serverTokensKey(server), JSON.stringify(tokens), {
                    expirationTtl: TOKEN_TTL_SECONDS,
                })
                .catch(() => { });
        }

        if (tokens.length >= MAX_TOKENS_PER_SERVER) {
            return { error: `Maximum ${MAX_TOKENS_PER_SERVER} active tokens per server reached.` };
        }

        const token = AuthManager.generateToken();
        const expiresAt = Date.now() + TOKEN_TTL_SECONDS * 1000;
        const td: TokenData = { server, expiresAt };

        await this.kv.put(AuthManager.tokenKey(token), JSON.stringify(td), {
            expirationTtl: TOKEN_TTL_SECONDS,
        });

        tokens.push(token);
        await this.kv.put(AuthManager.serverTokensKey(server), JSON.stringify(tokens), {
            expirationTtl: TOKEN_TTL_SECONDS,
        });

        return { token };
    }

    // ── Bearer token extraction + validation (used by data endpoints) ────

    async authenticateRequest(request: Request): Promise<{ server: string } | { error: string }> {
        const authHeader = request.headers.get("Authorization");
        if (!authHeader) return { error: "Missing Authorization header." };

        const parts = authHeader.split(" ");
        if (parts.length !== 2 || parts[0] !== "Bearer") {
            return { error: "Authorization header must be 'Bearer <token>'." };
        }

        const token = parts[1];
        if (!token) return { error: "Token is empty." };

        return this.validateToken(token);
    }

    // ── Private static helpers ──────────────────────────────────────────

    private static tokenKey(token: string) {
        return `token:${token}`;
    }

    private static serverTokensKey(server: string) {
        return `tokens:${server}`;
    }

    private static async hashKey(key: string): Promise<string> {
        const msg = new TextEncoder().encode(key);
        const hash = await crypto.subtle.digest("SHA-256", msg);
        return Array.from(new Uint8Array(hash))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    private static generateToken(): string {
        const buf = new Uint8Array(TOKEN_BYTES);
        crypto.getRandomValues(buf);
        return Array.from(buf)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    // ── Private instance methods ────────────────────────────────────────

    private async validateToken(token: string): Promise<{ server: string } | { error: string }> {
        const raw = await this.kv.get(AuthManager.tokenKey(token));
        if (!raw) return { error: "Invalid or expired token." };

        let td: TokenData;
        try {
            td = JSON.parse(raw) as TokenData;
        } catch {
            return { error: "Invalid token data." };
        }

        if (td.expiresAt <= Date.now()) {
            await this.kv.delete(AuthManager.tokenKey(token)).catch(() => { });
            await this.removeTokenFromServerList(token, td.server);
            return { error: "Token has expired." };
        }

        return { server: td.server };
    }

    private async removeTokenFromServerList(token: string, server: string): Promise<void> {
        try {
            const raw = await this.kv.get(AuthManager.serverTokensKey(server));
            if (!raw) return;
            const list = JSON.parse(raw) as string[];
            const idx = list.indexOf(token);
            if (idx === -1) return;
            list.splice(idx, 1);
            const ttl = list.length > 0 ? TOKEN_TTL_SECONDS : undefined;
            await this.kv.put(
                AuthManager.serverTokensKey(server),
                JSON.stringify(list),
                ttl ? { expirationTtl: ttl } : undefined,
            );
        } catch {
            // best-effort
        }
    }

    private async pruneServerTokens(server: string): Promise<[string[], boolean]> {
        const raw = await this.kv.get(AuthManager.serverTokensKey(server));
        if (!raw) return [[], false];

        const all = JSON.parse(raw) as string[];
        const valid: string[] = [];
        let hasPruned = false;

        for (const t of all) {
            const data = await this.kv.get(AuthManager.tokenKey(t));
            if (data) {
                const td = JSON.parse(data) as TokenData;
                if (td.expiresAt > Date.now()) {
                    valid.push(t);
                } else {
                    hasPruned = true;
                }
            } else {
                hasPruned = true;
            }
        }

        return [valid, hasPruned];
    }
}
