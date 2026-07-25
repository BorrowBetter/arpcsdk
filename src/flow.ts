/**
 * Flow engine — the FDR DEX v2 enrollment sequence as discrete, replayable
 * steps over the Orval-generated client. One source of truth shared by the CLI
 * smoke (`smoke.ts`) and the web smoke UI (`server.ts`).
 *
 * Each step takes a mutable `Run` (holds the through-line state — faid, program,
 * conditions, …) and returns a `StepResult` with a UI-ready `display` map plus
 * the `raw` gateway response. The mutator never throws on non-2xx, so a gated
 * step (e.g. UW ER40301, DRA ER40501) returns `ok:false` with the real error
 * body rather than blowing up.
 */

import { exchangeToken } from "./auth";
import { getConfig } from "./config";
import { getARPCAchieveResolutionPartnerConnectAPI } from "./generated/arpc";
import type {
	DebtAccount,
	LeadCondition,
	LeadPatchRequest,
	PatchCondition,
} from "./generated/model";

const api = getARPCAchieveResolutionPartnerConnectAPI();

// ---------------------------------------------------------------------------
// Shared identity + helpers (ported from the CLI smoke)
// ---------------------------------------------------------------------------

export function nextPayDate(daysOut = 14): string {
	const d = new Date();
	d.setDate(d.getDate() + daysOut); // 14 days out -> inside the 33-day UW window
	return d.toISOString().slice(0, 10);
}

// Per FDR (2026-06-16): randomize the first 5 SSN digits, keep the static last 4
// (4123). The active-client match (ER40604) keys on the full SSN so a fresh
// first-5 dodges it; the Spinwheel pull matches on the last 4 so 4123 keeps us
// bound to the canned test identity.
export const randomTestSsn = (): string =>
	`${Math.floor(10000 + Math.random() * 90000)}4123`;

// Canonical Spinwheel test identity (phone/token are tied to the canned pull).
const ID = {
	firstName: "CORE",
	lastName: "SPINWHEEL",
	phone: "6629582324",
	evening: "6632129216",
	dob: "1990-04-13",
	networkToken: "4e0cccc0-22e0-422c-a54d-79db70e2d0af",
	// v2 register address is zip_code-only (the old zip/zip_code dual-send is gone).
	address: {
		line1: "123 MAIN STREET",
		city: "TEMPE",
		state: "AZ",
		zip_code: "85288",
		country: "US",
	},
	mailing: {
		line1: "123 MAIN STREET",
		city: "TEMPE",
		state: "AZ",
		zip_code: "85280",
		country: "US",
	},
};

// The OAuth identity doubles as the lead's seller_agent_email (a registered DRA
// agent). Read lazily — config isn't set until the SDK is constructed.
const sellerAgentEmail = (): string => getConfig().username;

const isHard = (c: LeadCondition): boolean => c?.type === "hard-condition";
const verify = (c: LeadCondition): PatchCondition => ({
	id: c?.id,
	verified_by_debt_consultant: true,
});

// ---------------------------------------------------------------------------
// Run state + result shape
// ---------------------------------------------------------------------------

export interface Run {
	runId: string;
	ssn: string;
	nextPay: string;
	email?: string;
	faid?: string;
	// program intermediates needed downstream
	cbr?: string;
	referenceId?: string;
	progDebtAccounts?: unknown[];
	// condition ids read at GET, cleared at PATCH
	hardAppConds?: LeadCondition[];
	hardDebtAccounts?: { id?: string; conditions: LeadCondition[] }[];
	// outcomes the UI branches on
	disclosureAutoSent?: boolean;
	dra?: { envelopeId?: string; signingUrl?: string };
	log: string[];
}

export interface StepResult {
	status: number;
	ok: boolean;
	display: Record<string, unknown>;
	raw: unknown;
}

export function newRun(runId: string): Run {
	return { runId, ssn: randomTestSsn(), nextPay: nextPayDate(), log: [] };
}

const need = <T>(v: T | undefined | null, msg: string): T => {
	if (v === undefined || v === null) throw new Error(msg);
	return v;
};

// ---------------------------------------------------------------------------
// Steps — one per gateway round-trip, in flow order
// ---------------------------------------------------------------------------

export async function stepToken(run: Run): Promise<StepResult> {
	const token = await exchangeToken();
	run.log.push(`token acquired (len ${token.access_token.length})`);
	// Never hand the raw JWT to the browser — return meta only.
	return {
		status: 200,
		ok: true,
		display: {
			token_length: token.access_token.length,
			expires_in: token.expires_in,
			token_type: token.token_type ?? "bearer",
		},
		raw: {
			expires_in: token.expires_in,
			token_type: token.token_type,
			access_token: "«withheld»",
		},
	};
}

export async function stepEligibility(run: Run): Promise<StepResult> {
	const elig = await api.checkEligibility({
		pull_credit_report: false,
		applicant: { current_address: { state: "AZ" } },
		debt_accounts: [
			{
				source: "added-by-dc",
				reference_id: "a04a5000002zLrCAAU",
				estimated_debt: 15000,
				current_monthly_payment: 200,
				creditor_name: "Chase",
				account_type: "credit-card",
				account_condition: "unknown",
			},
		],
	});
	const faid = elig.data.application?.applicant?.fdr_applicant_id;
	if (!faid)
		throw new Error(
			`no fdr_applicant_id from eligibility: ${JSON.stringify(elig.data)}`,
		);
	run.faid = faid;
	run.email = `smoke-${faid}@ljnoft7r.mailosaur.net`;
	return {
		status: elig.status,
		ok: elig.status === 200,
		display: { fdr_applicant_id: faid, email: run.email },
		raw: elig.data,
	};
}

export async function stepRegister(run: Run): Promise<StepResult> {
	const faid = need(
		run.faid,
		"register: run has no fdr_applicant_id (run eligibility first)",
	);
	const reg = await api.registerApplicantV2({
		seller_agent_email: sellerAgentEmail(),
		applicant: {
			first_name: ID.firstName,
			last_name: ID.lastName,
			email: run.email!,
			phone_number: ID.phone,
			evening_phone_number: ID.evening,
			date_of_birth: ID.dob,
			ssn: run.ssn,
			fdr_applicant_id: faid,
			consent_date: "2024-10-14",
			network_token: ID.networkToken,
			physical_address: ID.address,
			mailing_address: ID.mailing,
		},
	});
	const d = reg.data as {
		status?: string;
		salesforce_id?: string;
		business_flow?: string;
	};
	return {
		status: reg.status,
		ok: reg.status === 200,
		display: {
			status: d.status,
			salesforce_id: d.salesforce_id,
			business_flow: d.business_flow,
		},
		raw: reg.data,
	};
}

export async function stepProgram(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "program: run has no fdr_applicant_id");
	const attempts: string[] = [];
	let res = await api.generateProgramV1({
		fdr_applicant_id: faid,
		is_final_retry: false,
	});
	for (let attempt = 1; attempt <= 40; attempt++) {
		const retryAfter = res.headers.get("retry-after");
		attempts.push(
			`attempt ${attempt}: ${res.status}${retryAfter ? ` (retry-after ${retryAfter}s)` : ""}`,
		);
		if (res.status === 200) break;
		await new Promise((r) =>
			setTimeout(r, (retryAfter ? Number(retryAfter) : 3) * 1000),
		);
		res = await api.generateProgramV1({
			fdr_applicant_id: faid,
			is_final_retry: false,
		});
	}
	run.log.push(...attempts);
	if (res.status !== 200) {
		return {
			status: res.status,
			ok: false,
			display: { attempts, note: "program did not become ready" },
			raw: res.data,
		};
	}
	const app = res.data.application;
	run.cbr = app?.cbr_report_id ?? undefined;
	run.referenceId = app?.reference_id ?? faid;
	run.progDebtAccounts = app?.debt_accounts ?? [];
	const options = (app?.payment_options ?? []).map(
		(o) =>
			o && {
				monthly_deposit: o.monthly_deposit,
				program_length: o.program_length,
				program_cost: o.program_cost,
			},
	);
	return {
		status: 200,
		ok: true,
		display: {
			polls: attempts.length,
			cbr_report_id: run.cbr,
			debt_accounts: run.progDebtAccounts.length,
			estimated_total_debt: app?.estimated_total_debt,
			monthly_deposit: app?.monthly_deposit,
			estimated_program_length: app?.estimated_program_length,
			payment_options: options,
		},
		raw: res.data,
	};
}

export async function stepCreateLead(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "lead: run has no fdr_applicant_id");
	const lead = await api.createLeadSync({
		other_debt_payments: 150,
		utilities: 250,
		food_expenses: 400,
		transportation_expenses: 300,
		rent_or_mortgage_monthly: 1500,
		own_or_rent: "Rent",
		other_expenses_describe: 0,
		child_care: 0,
		out_of_pocket_medical_costs: 0,
		personal_care_house_hold_and_miscellaneous: 0,
		government_student_loans_non_deferred: 0,
		private_student_loans_non_deferred: 0,
		legal_and_court_ordered_expenses: 0,
		medical_debt: 0,
		business_debt: 0,
		food_justification: "smoke",
		housing_justification: "smoke",
		transportation_justification: "smoke",
		income_justification: "smoke",
		other_expenses_description: "smoke",
		other_debt_expenses_description: "smoke",
		income_expenses_comments: "smoke",
		hardship_category: "Divorced",
		hardship_category_other: "smoke hardship",
		goal_category: "Be Debt Free",
		goal_category_other: "smoke goal",
		reference_id: run.referenceId ?? faid,
		seller_agent_email: sellerAgentEmail(),
		pull_credit_report: true,
		debt_accounts: (run.progDebtAccounts ?? []) as unknown as DebtAccount[],
		applicant: {
			first_name: ID.firstName,
			last_name: ID.lastName,
			phone_number: ID.phone,
			evening_phone_number: ID.evening,
			social_security_number: run.ssn,
			email: run.email!,
			date_of_birth: ID.dob,
			current_address: ID.address,
			mailing_address: ID.mailing,
			fdr_applicant_id: faid,
			id: faid,
			cbr_report_id: run.cbr,
			credit_pull_source: "spinwheel",
			pay_frequency: "Weekly",
			monthly_income: 8000,
			other_monthly_income: 9521,
			other_income_description: "smoke",
			next_pay_date: run.nextPay,
			social_security: 0,
			retirement: 0,
			dividends: 0,
			annuities: 0,
			alimony: 0,
			unemployment: 0,
			self_employment_1099_income: 0,
			child_support: 0,
			other_government_assistance: 0,
		},
	});
	const app = lead.data.application;
	return {
		status: lead.status,
		ok: lead.status === 200,
		display: {
			lead_id: lead.data.id,
			status: app?.status,
			eligible: app?.eligible,
			estimated_total_debt: app?.estimated_total_debt,
			monthly_deposit: app?.monthly_deposit,
			estimated_program_length: app?.estimated_program_length,
			fee_total: app?.fee_total,
			conditions: (app?.conditions ?? []).map((c) => c?.name),
		},
		raw: lead.data,
	};
}

export async function stepGetLead(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "get-lead: run has no fdr_applicant_id");
	const got = await api.readLead(faid);
	const app = got.data.application;
	const hardAppConds = (app?.conditions ?? []).filter(isHard);
	const hardDebtAccounts = (app?.debt_accounts ?? [])
		.map((d) => ({ id: d.id, conditions: (d.conditions ?? []).filter(isHard) }))
		.filter((d) => d.conditions.length > 0);
	run.hardAppConds = hardAppConds;
	run.hardDebtAccounts = hardDebtAccounts;
	return {
		status: got.status,
		ok: got.status === 200,
		display: {
			hard_app_conditions: hardAppConds.map((c) => c?.name),
			hard_debt_account_conditions: hardDebtAccounts.map((d) => ({
				id: d.id,
				conditions: d.conditions.map((c) => c?.name),
			})),
		},
		raw: got.data,
	};
}

export async function stepPatchConditions(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "patch: run has no fdr_applicant_id");
	const hardAppConds = run.hardAppConds ?? [];
	const hardDebtAccounts = run.hardDebtAccounts ?? [];
	const patchBody: LeadPatchRequest = {};
	if (hardAppConds.length) patchBody.conditions = hardAppConds.map(verify);
	if (hardDebtAccounts.length) {
		patchBody.debt_accounts = hardDebtAccounts.map((d) => ({
			id: d.id,
			conditions: d.conditions.map(verify),
		}));
	}
	const patched = await api.patchLead(faid, patchBody);
	const debtCondCount = (patchBody.debt_accounts ?? []).reduce(
		(n, d) => n + (d.conditions?.length ?? 0),
		0,
	);
	return {
		status: patched.status,
		ok: patched.status === 200,
		display: {
			verified_app_conditions: patchBody.conditions?.length ?? 0,
			verified_debt_conditions: debtCondCount,
		},
		raw: patched.data,
	};
}

export async function stepUwSubmission(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "uw: run has no fdr_applicant_id");
	const uw = await api.uwSubmissionV2(faid);
	if (uw.status === 200) {
		run.disclosureAutoSent = uw.data.banking_disclosure_email_sent === true;
		return {
			status: 200,
			ok: true,
			display: {
				message: uw.data.message,
				application_status: uw.data.application?.status,
				banking_disclosure_email_sent: uw.data.banking_disclosure_email_sent,
				banking_disclosure_email_message:
					uw.data.banking_disclosure_email_message,
			},
			raw: uw.data,
		};
	}
	const err = uw.data as unknown as {
		error?: string;
		error_code?: string;
		x_correlation_id?: string;
		error_details?: { checks?: unknown };
	};
	return {
		status: uw.status,
		ok: false,
		display: {
			error_code: err.error_code,
			error: err.error,
			x_correlation_id: err.x_correlation_id,
			checks: err.error_details?.checks,
		},
		raw: uw.data,
	};
}

export async function stepSendEmail(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "send-email: run has no fdr_applicant_id");
	const res = await api.sendEmail(faid);
	return {
		status: res.status,
		ok: res.status === 200,
		display: { ...(res.data as object) },
		raw: res.data,
	};
}

export async function stepBankUpdate(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "bank-update: run has no fdr_applicant_id");
	const res = await api.updateApplicationBankDetails(faid, {
		banking_disclosure_validation: true,
		verification_code: "1010",
		bank_details: {
			account_number: "0000000015",
			account_routing_number: "122105278",
		},
	});
	return {
		status: res.status,
		ok: res.status === 200,
		display: { status: res.status },
		raw: res.data,
	};
}

// Program Summary Recording task. Per FDR (spec v2026.15.0): this GATES DRA
// generation — the `dra` readiness gate won't clear until the program summary
// call is recorded (surfaces as `LeadApplication.program_summary_call_completed`).
// So it runs after bank-update and before readiness/DRA. We're DEX, so we omit
// the `X-Arpc-Flow-Type` header (the service defaults to DEX) and `ws_psc_code`
// (honoured only for DC flows). Timestamps stand in for a recorded agent call.
export async function stepProgramSummaryTask(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "program-summary: run has no fdr_applicant_id");
	const end = new Date();
	const start = new Date(end.getTime() - 15 * 60_000); // ~15-min recorded call
	const res = await api.createProgramSummaryTask(faid, {
		start_time: start.toISOString(),
		end_time: end.toISOString(),
		date_time: end.toISOString(),
		comments: "Program summary reviewed with applicant (smoke run).",
	});
	const d = res.data as { status?: string; message?: string; id?: string };
	// Task creation returns 201 Created (not 200) on success — accept both so the
	// UI/consumer flow don't misread a successful recording as a gate.
	return {
		status: res.status,
		ok: res.status === 200 || res.status === 201,
		display: { status: d.status, message: d.message, id: d.id },
		raw: res.data,
	};
}

export async function stepReadiness(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "readiness: run has no fdr_applicant_id");
	const r = await api.getApplicationReadiness(faid);
	return {
		status: r.status,
		ok: r.status === 200,
		display: {
			is_uw_approved: r.data.is_uw_approved,
			is_program_refresh_required: r.data.is_program_refresh_required,
			checks: r.data.checks,
		},
		raw: r.data,
	};
}

export async function stepGenerateDra(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "dra: run has no fdr_applicant_id");
	const dra = await api.generateDra(faid, {
		returning_url: "https://www.example.net/callback/docusign",
		applicant: { signing_type: "url" },
	});
	if (dra.status === 200) {
		run.dra = {
			envelopeId: dra.data.envelopeId,
			signingUrl: dra.data.applicant?.url,
		};
		return {
			status: 200,
			ok: true,
			display: {
				envelopeId: dra.data.envelopeId,
				signing_url: dra.data.applicant?.url,
			},
			raw: dra.data,
		};
	}
	return {
		status: dra.status,
		ok: false,
		display: { ...(dra.data as object) },
		raw: dra.data,
	};
}

// Retail handoff (drop-off path) — deliberately NOT part of the enrollment
// happy path, so it's excluded from the ordered STEPS registry below. Transfers
// the lead to FDR's retail sales floor. Per FDR (2026-07-25): no inactivation —
// both the wholesale-digital lead and the new retail lead stay active; whichever
// enrolls first wins, and the loser later gets a duplicate / "already enrolled"
// error. Response is accepted | rejected (+ `get_offers_url` for accepted,
// `response_reason` e.g. "DuplicateLead" for rejected).
export async function stepLeadTransfer(run: Run): Promise<StepResult> {
	const faid = need(run.faid, "lead-transfer: run has no fdr_applicant_id");
	const res = await api.leadTransfer({
		fdr_applicant_id: faid,
		email: run.email,
		phone_number: ID.phone,
		first_name: ID.firstName,
		last_name: ID.lastName,
		date_of_birth: ID.dob,
		social_security_number: run.ssn,
		unsecured_debt: 30000,
		mailing_address: {
			line1: ID.mailing.line1,
			city: ID.mailing.city,
			state: ID.mailing.state,
			zip_code: ID.mailing.zip_code,
		},
	});
	const d = res.data;
	return {
		status: res.status,
		ok: res.status === 200,
		display: {
			response: d.response,
			get_offers_url: d.get_offers_url,
			response_reason: d.response_reason,
			response_details: d.response_details,
		},
		raw: res.data,
	};
}

// Ordered registry the UI + CLI drive. `auto` steps that FDR auto-handles
// (send-email only when the disclosure wasn't auto-sent) are flagged so callers
// can branch.
export const STEPS = [
	{ key: "token", label: "Token exchange", run: stepToken },
	{
		key: "eligibility",
		label: "Eligibility (mint applicant id)",
		run: stepEligibility,
	},
	{ key: "register", label: "Register applicant (v2)", run: stepRegister },
	{ key: "program", label: "Generate program (poll)", run: stepProgram },
	{ key: "lead", label: "Create lead", run: stepCreateLead },
	{ key: "getLead", label: "Read lead (conditions)", run: stepGetLead },
	{ key: "patch", label: "Verify hard-conditions", run: stepPatchConditions },
	{ key: "uw", label: "UW submission (v2)", run: stepUwSubmission },
	{ key: "email", label: "Banking disclosure email", run: stepSendEmail },
	{ key: "bank", label: "Bank update", run: stepBankUpdate },
	{
		key: "psr",
		label: "Program summary task (gates DRA)",
		run: stepProgramSummaryTask,
	},
	{ key: "readiness", label: "DRA readiness", run: stepReadiness },
	{ key: "dra", label: "Generate DRA (DocuSign)", run: stepGenerateDra },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];
