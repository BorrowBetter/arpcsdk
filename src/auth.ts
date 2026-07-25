import ky from "ky";
import { getConfig, type TokenCache } from "./config";

// Token lifecycle lives in the orchestration layer, not the generated client:
// the exchange targets the OAuth host (not the gateway), uses HTTP Basic, and is
// form-encoded. Authentication is lazy — `resolveToken()` runs from the ky
// beforeRequest hook on the first gateway call (and again once the token goes
// stale), so callers never manage the token by hand.
export interface TokenResponse {
	access_token: string;
	token_type?: string;
	expires_in?: number;
}

// Refresh this many ms before the server's stated expiry, so a token never
// lapses mid-flight. Applied once, when we compute the stored `expiresAt`.
const TOKEN_SKEW_MS = 30_000;
// FDR tokens are ~900s; fall back to that if the response omits expires_in.
const DEFAULT_TTL_S = 900;

/** Raw credentials → bearer JWT. No storage; `resolveToken()` owns that. */
export async function exchangeToken(): Promise<TokenResponse> {
	const { oauthUrl, username, password } = getConfig();
	const basic = Buffer.from(`${username}:${password}`).toString("base64");

	return ky
		.post(`${oauthUrl}/v1/token`, {
			headers: { Authorization: `Basic ${basic}` },
			body: new URLSearchParams({ grant_type: "client_credentials" }),
		})
		.json<TokenResponse>();
}

// Default store: in-memory, per-process. Used when config omits `cache`.
let memToken: string | null = null;
let memExpiresAt = 0;
const defaultCache: TokenCache = {
	async get() {
		return memToken && Date.now() < memExpiresAt ? memToken : null;
	},
	async set(token, expiresAt) {
		memToken = token;
		memExpiresAt = expiresAt.getTime();
	},
};

// Single-flight guard: a cold burst of concurrent gateway calls performs one
// exchange, not one per call.
let inflight: Promise<string> | null = null;

/**
 * Return a valid bearer token, exchanging + caching on a miss. Called by the
 * gateway beforeRequest hook; not part of the public surface.
 */
export function resolveToken(): Promise<string> {
	const store = getConfig().cache ?? defaultCache;
	if (inflight) return inflight;

	inflight = (async () => {
		const cached = await store.get();
		if (cached) return cached;
		const res = await exchangeToken();
		const ttl = (res.expires_in ?? DEFAULT_TTL_S) * 1000;
		await store.set(
			res.access_token,
			new Date(Date.now() + ttl - TOKEN_SKEW_MS),
		);
		return res.access_token;
	})().finally(() => {
		inflight = null;
	});
	return inflight;
}
