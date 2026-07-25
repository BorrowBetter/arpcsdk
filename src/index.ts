import { exchangeToken, type TokenResponse } from "./auth";
import { type ArpcConfig, configure } from "./config";
import * as flow from "./flow";
import { getARPCAchieveResolutionPartnerConnectAPI } from "./generated/arpc";

export type { TokenResponse } from "./auth";
export type { ArpcConfig } from "./config";
export type { Run, StepResult } from "./flow";
export { STEPS } from "./flow";
export type * from "./generated/model";

/**
 * ARPC SDK — a typed client + enrollment orchestration for FDR's ARPC DEX API
 * (Achieve Resolution Partner Connect, Digital Enrollment Experience).
 *
 * Two layers:
 * - **`sdk.api`** — the raw typed operations, one method per gateway endpoint
 *   (escape hatch for anything the orchestration doesn't cover).
 * - **Orchestration steps** (`sdk.eligibility`, `sdk.program`, …) — the DEX
 *   enrollment sequence as discrete, replayable steps over a mutable `Run`.
 *   They never throw on a gated non-2xx; each returns `{ ok, status, display,
 *   raw }` so the caller inspects the real gateway response.
 *
 * Token lifecycle is handled internally: call `authenticate()` once (the JWT is
 * stored and attached to every gateway call); re-call to refresh before the
 * 900s expiry.
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
 * const run = sdk.createRun();
 * await sdk.eligibility(run); // mints run.faid
 * await sdk.register(run);
 * await sdk.program(run);     // polls 202 → 200
 * // …lead → conditions → UW → bank → program-summary → readiness → DRA
 * ```
 */
export class ArpcSDK {
	/** Raw typed operations — one method per gateway endpoint. Escape hatch. */
	readonly api = getARPCAchieveResolutionPartnerConnectAPI();

	constructor(config: ArpcConfig) {
		configure(config);
	}

	/**
	 * Exchange OAuth client credentials for a bearer JWT and store it for
	 * subsequent gateway calls. Token TTL is ~900s — re-call to refresh.
	 */
	authenticate(): Promise<TokenResponse> {
		return exchangeToken();
	}

	/** Start a fresh enrollment run (mints a test SSN + pay date). */
	createRun(runId = "sdk"): flow.Run {
		return flow.newRun(runId);
	}

	// --- Orchestration steps (in flow order) --------------------------------
	/** Token exchange, as a step (mirrors `authenticate()` but returns a `StepResult`). */
	token = flow.stepToken;
	/** Eligibility Scout — stateless quote; mints `run.faid`. */
	eligibility = flow.stepEligibility;
	/** Register applicant (v2) — anchors identity, triggers the async credit fetch. */
	register = flow.stepRegister;
	/** Generate program — polls 202/`Retry-After` until 200. */
	program = flow.stepProgram;
	/** Create the wholesale lead (sync). */
	createLead = flow.stepCreateLead;
	/** Read the lead back to collect hard-condition ids. */
	getLead = flow.stepGetLead;
	/** Verify (clear) the hard-conditions that block UW. */
	patchConditions = flow.stepPatchConditions;
	/** Submit to underwriting (v2). */
	uwSubmission = flow.stepUwSubmission;
	/** Send the banking-disclosure email (only when UW didn't auto-send it). */
	sendEmail = flow.stepSendEmail;
	/** Update applicant bank details. */
	bankUpdate = flow.stepBankUpdate;
	/** Record the program-summary task — gates DRA generation. */
	programSummaryTask = flow.stepProgramSummaryTask;
	/** DRA readiness check. */
	readiness = flow.stepReadiness;
	/** Generate the Debt Resolution Agreement (DocuSign embedded signing URL). */
	generateDra = flow.stepGenerateDra;

	/**
	 * Retail handoff (drop-off path) — off the enrollment happy path. Transfers
	 * the lead to FDR's retail sales floor. No inactivation: the digital and
	 * retail leads both stay active; whichever enrolls first wins.
	 */
	leadTransfer = flow.stepLeadTransfer;
}
