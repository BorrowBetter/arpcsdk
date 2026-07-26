/**
 * Smoke test — drives the full FDR ARPC DEX enrollment sequence end-to-end
 * against live STG using the SDK's passthrough client (`sdk.api.*`). Doubles as
 * the reference implementation of the call order + the program poll loop.
 *
 * The SDK is agnostic; the canned STG test identity (CORE SPINWHEEL) + the fixed
 * financial data live HERE, in the fixture below. Run: `pnpm smoke` (needs STG
 * creds in `.env`).
 *
 * Sequence: eligibility → registerV2 → program(poll) → lead → GET →
 *   PATCH conditions → uwV2 → send-email(if not auto-sent) → bank →
 *   program-summary(gates DRA) → readiness → DRA.
 */
import "dotenv-flow/config";
import { ArpcSDK, isArpcEnvironment } from "../src";
import type {
	DebtAccount,
	LeadCondition,
	LeadPatchRequest,
	PatchCondition,
} from "../src/generated/model";

// Env plumbing is this script's business, not the SDK's — the library takes a
// config object and never reads process.env.
const need = (key: string): string => {
	const value = process.env[key];
	if (!value)
		throw new Error(`Missing required env var: ${key} (set it in .env)`);
	return value;
};

// Also the lead's seller_agent_email — see the fixture below.
const username = need("ARPC_OAUTH_USERNAME");

const environment = need("ARPC_ENVIRONMENT");
if (!isArpcEnvironment(environment))
	throw new Error(`Invalid ARPC_ENVIRONMENT: ${environment}`);

const sdk = new ArpcSDK({
	environment,
	auth: { username, password: need("ARPC_OAUTH_PASSWORD") },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(`\n\x1b[1m=== ${s} ===\x1b[0m`);
const show = (status: number, data: unknown) =>
	console.log(`status ${status}`, JSON.stringify(data, null, 2));

// Per FDR (2026-06-16): randomize the first 5 SSN digits, keep the static last 4
// (4123). The active-client match (ER40604) keys on the full SSN so a fresh
// first-5 dodges it; the Spinwheel pull matches on the last 4 so 4123 keeps us
// bound to the canned test identity.
const randomTestSsn = (): string =>
	`${Math.floor(10000 + Math.random() * 90000)}4123`;

const nextPayDate = (daysOut = 14): string => {
	const d = new Date();
	d.setDate(d.getDate() + daysOut); // inside the 33-day UW window
	return d.toISOString().slice(0, 10);
};

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

const isHard = (c: LeadCondition): boolean => c?.type === "hard-condition";
const verify = (c: LeadCondition): PatchCondition => ({
	id: c?.id,
	verified_by_debt_consultant: true,
});

async function main(): Promise<void> {
	const ssn = randomTestSsn();
	const nextPay = nextPayDate();
	// The OAuth identity doubles as the lead's seller_agent_email (a registered DRA agent).
	const sellerAgentEmail = username;
	console.log(`test ssn: ${ssn} (random first-5 + static 4123)`);

	// Auth is lazy — the first api call below exchanges credentials automatically.
	say("1. Eligibility (mint applicant id)");
	const elig = await sdk.api.checkEligibility({
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
	const email = `smoke-${faid}@ljnoft7r.mailosaur.net`;
	show(elig.status, { fdr_applicant_id: faid, email });

	say("2. Register applicant (v2)");
	const reg = await sdk.api.registerApplicantV2({
		seller_agent_email: sellerAgentEmail,
		applicant: {
			first_name: ID.firstName,
			last_name: ID.lastName,
			email,
			phone_number: ID.phone,
			evening_phone_number: ID.evening,
			date_of_birth: ID.dob,
			ssn,
			fdr_applicant_id: faid,
			consent_date: "2024-10-14",
			network_token: ID.networkToken,
			physical_address: ID.address,
			mailing_address: ID.mailing,
		},
	});
	show(reg.status, reg.data);

	say("3. Program generation (poll until ready)");
	let prog = await sdk.api.generateProgramV1({
		fdr_applicant_id: faid,
		is_final_retry: false,
	});
	for (let attempt = 1; attempt <= 40 && prog.status !== 200; attempt++) {
		const retryAfter = prog.headers.get("retry-after");
		console.log(
			`  attempt ${attempt}: ${prog.status}${retryAfter ? ` (retry-after ${retryAfter}s)` : ""}`,
		);
		await sleep((retryAfter ? Number(retryAfter) : 3) * 1000);
		prog = await sdk.api.generateProgramV1({
			fdr_applicant_id: faid,
			is_final_retry: false,
		});
	}
	if (prog.status !== 200) throw new Error("program not ready after polling");
	const papp = prog.data.application;
	const cbr = papp?.cbr_report_id ?? undefined;
	const referenceId = papp?.reference_id ?? faid;
	const progDebtAccounts = papp?.debt_accounts ?? [];
	show(prog.status, {
		debt_accounts: progDebtAccounts.length,
		estimated_total_debt: papp?.estimated_total_debt,
		monthly_deposit: papp?.monthly_deposit,
		payment_options: papp?.payment_options,
	});

	say("4. Create lead");
	const lead = await sdk.api.createLeadSync({
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
		reference_id: referenceId,
		seller_agent_email: sellerAgentEmail,
		pull_credit_report: true,
		debt_accounts: progDebtAccounts as unknown as DebtAccount[],
		applicant: {
			first_name: ID.firstName,
			last_name: ID.lastName,
			phone_number: ID.phone,
			evening_phone_number: ID.evening,
			social_security_number: ssn,
			email,
			date_of_birth: ID.dob,
			current_address: ID.address,
			mailing_address: ID.mailing,
			fdr_applicant_id: faid,
			id: faid,
			cbr_report_id: cbr,
			credit_pull_source: "spinwheel",
			pay_frequency: "Weekly",
			monthly_income: 8000,
			other_monthly_income: 9521,
			other_income_description: "smoke",
			next_pay_date: nextPay,
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
	if (lead.status !== 200) {
		show(lead.status, lead.data);
		throw new Error("lead create failed");
	}
	show(lead.status, {
		lead_id: lead.data.id,
		status: lead.data.application?.status,
		conditions: (lead.data.application?.conditions ?? []).map((c) => c?.name),
	});

	say("4b. GET lead → read hard-conditions");
	const got = await sdk.api.readLead(faid);
	const gapp = got.data.application;
	const hardAppConds = (gapp?.conditions ?? []).filter(isHard);
	const hardDebtAccounts = (gapp?.debt_accounts ?? [])
		.map((d) => ({ id: d.id, conditions: (d.conditions ?? []).filter(isHard) }))
		.filter((d) => d.conditions.length > 0);
	show(got.status, {
		hard_app_conditions: hardAppConds.map((c) => c?.name),
		hard_debt_account_conditions: hardDebtAccounts.map((d) =>
			d.conditions.map((c) => c?.name),
		),
	});

	say("4c. PATCH verify hard-conditions");
	const patchBody: LeadPatchRequest = {};
	if (hardAppConds.length) patchBody.conditions = hardAppConds.map(verify);
	if (hardDebtAccounts.length) {
		patchBody.debt_accounts = hardDebtAccounts.map((d) => ({
			id: d.id,
			conditions: d.conditions.map(verify),
		}));
	}
	const patched = await sdk.api.patchLead(faid, patchBody);
	show(patched.status, {
		verified_app_conditions: patchBody.conditions?.length ?? 0,
	});

	say("5. UW submission (v2)");
	const uw = await sdk.api.uwSubmissionV2(faid);
	const disclosureAutoSent =
		uw.status === 200 && uw.data.banking_disclosure_email_sent === true;
	show(uw.status, uw.data);
	if (uw.status !== 200) throw new Error("UW submission not accepted");

	say("6. Banking disclosure email");
	if (disclosureAutoSent) {
		console.log(
			"UW auto-sent the disclosure on full approval — skipping manual send-email",
		);
	} else {
		const em = await sdk.api.sendEmail(faid);
		show(em.status, em.data);
	}

	say("7. Bank update");
	const bank = await sdk.api.updateApplicationBankDetails(faid, {
		banking_disclosure_validation: true,
		verification_code: "1010",
		bank_details: {
			account_number: "0000000015",
			account_routing_number: "122105278",
		},
	});
	show(bank.status, { status: bank.status });

	say("8. Program summary task (gates DRA)");
	const end = new Date();
	const start = new Date(end.getTime() - 15 * 60_000);
	const psr = await sdk.api.createProgramSummaryTask(faid, {
		start_time: start.toISOString(),
		end_time: end.toISOString(),
		date_time: end.toISOString(),
		comments: "Program summary reviewed with applicant (smoke run).",
	});
	show(psr.status, psr.data); // 201 Created on success

	say("9. DRA readiness");
	const rd = await sdk.api.getApplicationReadiness(faid);
	show(rd.status, {
		is_uw_approved: rd.data.is_uw_approved,
		checks: rd.data.checks,
	});

	say("10. Generate DRA (DocuSign URL signing)");
	const dra = await sdk.api.generateDra(faid, {
		returning_url: "https://www.example.net/callback/docusign",
		applicant: { signing_type: "url" },
	});
	show(dra.status, dra.data);

	say("TRACE");
	console.log(`fdr_applicant_id : ${faid}`);
	if (dra.status === 200) {
		console.log(`DRA envelopeId   : ${dra.data.envelopeId}`);
		say("✅ DONE — full enrollment flow green through DRA generation");
	} else {
		say("❌ INCOMPLETE — flow did not reach a DRA envelope");
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
