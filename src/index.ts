import { type ArpcConfig, configure } from "./config";
import { getARPCAchieveResolutionPartnerConnectAPI } from "./generated/arpc";

export type {
	ArpcAuth,
	ArpcConfig,
	ArpcEndpoint,
	ArpcEnvironment,
	ArpcUrls,
	TokenCache,
} from "./config";
export { ARPC_ENDPOINTS, isArpcEnvironment } from "./config";
export type * from "./generated/model";
export type { HttpResponse } from "./http/client";

/**
 * ARPC SDK — a typed, agnostic client for FDR's ARPC DEX API (Achieve
 * Resolution Partner Connect, Digital Enrollment Experience).
 *
 * Thin by design: it owns the two-host routing (both derived from
 * `environment`), the OAuth token lifecycle, and bearer injection, and exposes
 * the full endpoint surface as typed operations on `sdk.api`. It does not
 * orchestrate the enrollment sequence — the caller
 * assembles payloads and threads the `fdr_applicant_id` between calls. See
 * `scripts/smoke.ts` for a full end-to-end reference sequence (incl. the program
 * poll loop).
 *
 * Auth is lazy: the first `api` call exchanges credentials for a bearer JWT and
 * caches it (~900s TTL), then re-exchanges shortly before it expires. There's no
 * explicit login step. Supply `auth.cache` to persist the token across restarts
 * or share it across workers; otherwise it's held in-process.
 *
 * Operations never throw on a non-2xx: each returns `{ status, data, headers }`,
 * so a business gate (e.g. a UW/DRA readiness failure) comes back as a normal
 * response you inspect via `status`/`data`. Only transport errors throw.
 *
 * Note: config and the default token cache are process-global — construct one
 * `ArpcSDK` per process. A second instance reconfigures the first; instances are
 * not isolated (single-tenant by design).
 *
 * @example
 * ```typescript
 * const sdk = new ArpcSDK({
 *   environment: "stg",
 *   auth: {
 *     username: "borrowbetter@seller.com",
 *     password: process.env.ARPC_OAUTH_PASSWORD!,
 *   },
 * });
 *
 * // The first call authenticates automatically and caches the token.
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
}
