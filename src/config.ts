/**
 * SDK configuration.
 *
 * The library never reads the environment itself — a consumer constructs
 * `new ArpcSDK(config)`, which calls `configure()`. The `configFromEnv()` helper
 * is a convenience for the dev scripts (smoke / server), which load `.env` via
 * dotenv-flow and pass the result in.
 */
export interface ArpcConfig {
	/** OAuth host — token exchange only (`POST /v1/token`). */
	oauthUrl: string;
	/** API gateway host — every non-auth call. */
	gatewayUrl: string;
	/**
	 * OAuth client_id (HTTP Basic username). Also used as the lead's
	 * `seller_agent_email` — the OAuth identity is a registered DRA agent.
	 */
	username: string;
	/** OAuth client_secret (HTTP Basic password). */
	password: string;
}

let current: ArpcConfig | null = null;

/** Set the active config. Called by the `ArpcSDK` constructor. */
export function configure(config: ArpcConfig): void {
	current = config;
}

/** Read the active config. Throws if the SDK hasn't been constructed yet. */
export function getConfig(): ArpcConfig {
	if (!current) {
		throw new Error(
			"ArpcSDK is not configured — construct `new ArpcSDK(config)` before making calls",
		);
	}
	return current;
}

/**
 * Build a config from environment variables. Not used by the library itself —
 * only the dev scripts call this after loading `.env`.
 */
export function configFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): ArpcConfig {
	const need = (key: string): string => {
		const value = env[key];
		if (!value)
			throw new Error(`Missing required env var: ${key} (set it in .env)`);
		return value;
	};
	return {
		oauthUrl: need("FDR_OAUTH_URL"),
		gatewayUrl: need("FDR_API_GATEWAY_URL"),
		username: need("FDR_OAUTH_USERNAME"),
		password: need("FDR_OAUTH_PASSWORD"),
	};
}
