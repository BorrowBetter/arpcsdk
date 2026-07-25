import { exchangeToken, type TokenResponse } from "./auth";
import { type ArpcConfig, configure } from "./config";
import { getARPCAchieveResolutionPartnerConnectAPI } from "./generated/arpc";

export type { TokenResponse } from "./auth";
export type { ArpcConfig } from "./config";
export type * from "./generated/model";
export type { HttpResponse } from "./http/client";

/**
 * ARPC SDK — a typed, agnostic client for FDR's ARPC DEX API (Achieve
 * Resolution Partner Connect, Digital Enrollment Experience).
 *
 * Thin by design: it owns the two-host routing, the OAuth token lifecycle, and
 * bearer injection, and exposes the full endpoint surface as typed operations
 * on `sdk.api`. It does not orchestrate the enrollment sequence — the caller
 * assembles payloads and threads the `fdr_applicant_id` between calls. See
 * `scripts/smoke.ts` for a full end-to-end reference sequence (incl. the program
 * poll loop).
 *
 * Operations never throw on a non-2xx: each returns `{ status, data, headers }`,
 * so a business gate (e.g. a UW/DRA readiness failure) comes back as a normal
 * response you inspect via `status`/`data`. Only transport errors throw.
 *
 * Note: config and the bearer token are process-global — construct one `ArpcSDK`
 * per process. A second instance reconfigures the first; instances are not
 * isolated (single-tenant by design).
 *
 * @example
 * ```typescript
 * const sdk = new ArpcSDK({
 *   oauthUrl: "https://oauth.stg.ffngcp.com",
 *   gatewayUrl: "https://apis-gateway-v2.stg.fdrgcp.com",
 *   username: "borrowbetter@seller.com",
 *   password: process.env.FDR_OAUTH_PASSWORD!,
 * });
 *
 * await sdk.authenticate();
 * const elig = await sdk.api.checkEligibility({ ... });
 * const faid = elig.data.application?.applicant?.fdr_applicant_id;
 * ```
 */
export class ArpcSDK {
	/** The full typed endpoint surface — one method per gateway operation. */
	readonly api = getARPCAchieveResolutionPartnerConnectAPI();

	constructor(config: ArpcConfig) {
		configure(config);
	}

	/**
	 * Exchange OAuth client credentials for a bearer JWT and store it for
	 * subsequent `api` calls. Token TTL is ~900s — re-call to refresh.
	 */
	authenticate(): Promise<TokenResponse> {
		return exchangeToken();
	}
}
