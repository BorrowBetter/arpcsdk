/**
 * SDK configuration.
 *
 * The library never reads the environment itself — a consumer constructs
 * `new ArpcSDK(config)`, which calls `configure()`. Where that config comes
 * from (env vars, a secrets manager, a config service) is the caller's business.
 */
/**
 * Bearer-token store. The SDK authenticates lazily on the first gateway call:
 * it asks `get()` for a still-valid token and, on `null`, exchanges credentials
 * and hands the fresh token to `set()`. Owning expiry is the cache's job —
 * `get()` returns `null` once the token is stale (or near-stale). The default
 * store is in-memory and per-process; supply one to persist across restarts or
 * share across workers.
 */
export interface TokenCache {
	/** Return a valid bearer token, or `null` if absent/expired. */
	get(): Promise<string | null>;
	/** Persist a freshly exchanged token. `expiresAt` already includes the SDK's refresh skew. */
	set(token: string, expiresAt: Date): Promise<void>;
}

/** FDR deployment target. Selects both hosts — see `ARPC_ENDPOINTS`. */
export type ArpcEnvironment = "dev" | "stg" | "prd";

/**
 * Per-environment hosts. The two differ by domain, not just subdomain: the
 * OAuth host is `ffngcp.com`, the gateway is `fdrgcp.com`.
 */
export const ARPC_ENDPOINTS: Record<
	ArpcEnvironment,
	{ oauth: string; gateway: string }
> = {
	dev: {
		oauth: "https://oauth.dev.ffngcp.com",
		gateway: "https://apis-gateway-v2.dev.fdrgcp.com",
	},
	stg: {
		oauth: "https://oauth.stg.ffngcp.com",
		gateway: "https://apis-gateway-v2.stg.fdrgcp.com",
	},
	prd: {
		oauth: "https://oauth.prd.ffngcp.com",
		gateway: "https://apis-gateway-v2.prd.fdrgcp.com",
	},
};

/**
 * Narrow a raw string to an `ArpcEnvironment`. Useful when the value arrives
 * untyped — an env var, a JSON config file, a request payload.
 */
export function isArpcEnvironment(value: string): value is ArpcEnvironment {
	// Own keys only — `in` would also match inherited members like `toString`.
	return Object.keys(ARPC_ENDPOINTS).includes(value);
}

export interface ArpcAuth {
	/**
	 * OAuth client_id (HTTP Basic username). Also used as the lead's
	 * `seller_agent_email` — the OAuth identity is a registered DRA agent.
	 */
	username: string;
	/** OAuth client_secret (HTTP Basic password). */
	password: string;
	/** Bearer-token store. Defaults to an in-memory, per-process cache. */
	cache?: TokenCache;
}

/**
 * Escape hatch — per-host overrides of the `environment` defaults. Omit a key
 * (or leave it `undefined`) to keep that environment's host.
 */
export interface ArpcUrls {
	/** OAuth host — token exchange only (`POST /v1/token`). */
	oauth?: string;
	/** API gateway host — every non-auth call. */
	gateway?: string;
}

export interface ArpcConfig {
	/** Selects the FDR environment. Drives both hosts. */
	environment: ArpcEnvironment;
	auth: ArpcAuth;
	urls?: ArpcUrls;
}

/** Config as the internals consume it — hosts resolved to concrete strings. */
export interface ResolvedArpcConfig extends ArpcConfig {
	urls: Required<ArpcUrls>;
}

let current: ResolvedArpcConfig | null = null;

/**
 * Fold the environment defaults together with any caller overrides. The guard
 * looks unreachable given the types, but `environment` routinely arrives from
 * somewhere untyped (an env var, a JSON config, a JS caller) — catch it here
 * rather than letting `undefined` reach a request URL.
 */
function resolveUrls(config: ArpcConfig): Required<ArpcUrls> {
	if (!isArpcEnvironment(config.environment)) {
		throw new Error(
			`Unknown environment: ${config.environment} (expected one of ${Object.keys(ARPC_ENDPOINTS).join(", ")})`,
		);
	}
	const defaults = ARPC_ENDPOINTS[config.environment];
	return {
		oauth: config.urls?.oauth ?? defaults.oauth,
		gateway: config.urls?.gateway ?? defaults.gateway,
	};
}

/** Set the active config, resolving hosts once. Called by the `ArpcSDK` constructor. */
export function configure(config: ArpcConfig): void {
	current = { ...config, urls: resolveUrls(config) };
}

/** Read the active config. Throws if the SDK hasn't been constructed yet. */
export function getConfig(): ResolvedArpcConfig {
	if (!current) {
		throw new Error(
			"ArpcSDK is not configured — construct `new ArpcSDK(config)` before making calls",
		);
	}
	return current;
}
