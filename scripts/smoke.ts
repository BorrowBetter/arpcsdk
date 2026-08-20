/**
 * Smoke test — drives the full FDR ARPC DEX enrollment sequence end-to-end
 * against live STG using the SDK's passthrough client (`sdk.api.*`). Doubles as
 * the reference implementation of the call order + the program poll loop.
 *
 * The SDK is agnostic; the canned STG test identities live in
 * `scripts/test-users.ts` and the shared test data (financials, mailing
 * address, inbox) lives HERE. Run: `pnpm smoke [test-user-id]
 * [--force-hard-conditions]` (needs STG creds in `.env`); the id defaults to
 * `DEFAULT_TEST_USER`.
 *
 * Sequence: eligibility → registerV2 → program(poll) → pick schedule → lead →
 *   GET → PATCH conditions → select-program → uwV2 → select-program again →
 *   send-email(if not auto-sent) → bank → program-summary(gates DRA) →
 *   readiness → DRA.
 */
import "dotenv-flow/config";
import { ArpcSDK, DRAFT_TYPE_LABEL, draftTypeOf } from "../src";
import type {
	DebtAccount,
	LeadApplication,
	LeadCondition,
	LeadPatchRequest,
	PatchCondition,
	PaymentSchedule,
	PaymentScheduleOption,
} from "../src/generated/model";
import { newSsn, resolveTestUser } from "./test-users";

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

// Pinned to STG deliberately, NOT read from the environment. This script drives
// a real enrollment end-to-end against a canned Spinwheel test identity, which
// only exists in STG — pointing it at PRD would create live applicant records.
const sdk = new ArpcSDK({
	environment: "stg",
	auth: { username, password: need("ARPC_OAUTH_PASSWORD") },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(`\n\x1b[1m=== ${s} ===\x1b[0m`);
const show = (status: number, data: unknown) =>
	console.log(`status ${status}`, JSON.stringify(data, null, 2));

// Shared across every test user: none of these are tied to the canned Spinwheel
// pull the way the identity fields in `test-users.ts` are.
const EVENING_PHONE = "6632129216";
// Mailosaur inbox — the banking disclosure email lands here. Unique per
// applicant so concurrent runs don't share a mailbox.
const MAILOSAUR_DOMAIN = "ljnoft7r.mailosaur.net";
// Deliberately a different zip from the physical address, so the flow exercises
// mailing ≠ physical.
const MAILING_ADDRESS = {
	line1: "123 MAIN STREET",
	city: "TEMPE",
	state: "AZ",
	zip_code: "85280",
	country: "US",
};

const nextPayDate = (daysOut = 14): string => {
	const d = new Date();
	d.setDate(d.getDate() + daysOut); // inside the 33-day UW window
	return d.toISOString().slice(0, 10);
};

// Which tier + draft frequency this run enrolls into. `regular` on purpose:
// UW's overwrite (see selectSchedule) lands on Bi-Weekly, so choosing bi-weekly
// here would mask it and 5b would report "intact" without having tested
// anything. `regular` makes every run exercise the overwrite AND the re-select
// that works around it. `split` is the third option; as of 2026.16.1 it can
// reach a DRA, but only with an extra PATCH setting `second_draft_date_split`
// between UW and DRA — a branch this script doesn't drive yet.
const CHOICE = {
	evaluation_type: "Best Value",
	draft_type: "regular",
} as const;

// The request takes the lowercase schedule code, the lead reports the Salesforce
// label — see DRAFT_TYPE_LABEL in the SDK for why the two differ.
const EXPECTED_DRAFT_TYPE = DRAFT_TYPE_LABEL[CHOICE.draft_type];

const isHard = (c: LeadCondition): boolean => c?.type === "hard-condition";
const verify = (c: LeadCondition): PatchCondition => ({
	id: c?.id,
	verified_by_debt_consultant: true,
});

const showTiers = (options: PaymentScheduleOption[] | null | undefined) => {
	for (const tier of (options ?? []).filter((o) => o !== null)) {
		const schedules = (tier.schedules ?? [])
			.map((s) => `${s.draft_type} $${s.estimated_monthly_payment}/mo`)
			.join(", ");
		console.log(
			`  ${tier.evaluation_type}: ${tier.program_length}mo, $${tier.program_cost} — ${schedules}`,
		);
	}
};

/** Resolve CHOICE against the tiers the program actually offered. */
const pickSchedule = (
	options: PaymentScheduleOption[] | null | undefined,
): PaymentSchedule => {
	const tiers = (options ?? []).filter((o) => o !== null);
	const tier = tiers.find((o) => o.evaluation_type === CHOICE.evaluation_type);
	if (!tier)
		throw new Error(
			`no "${CHOICE.evaluation_type}" tier in payment_schedule_options (offered: ${tiers.map((o) => o.evaluation_type).join(", ") || "none"})`,
		);
	const schedule = (tier.schedules ?? []).find(
		(s) => s.draft_type === CHOICE.draft_type,
	);
	if (!schedule)
		throw new Error(
			`no "${CHOICE.draft_type}" schedule in the ${CHOICE.evaluation_type} tier (offered: ${(tier.schedules ?? []).map((s) => s.draft_type).join(", ") || "none"})`,
		);
	return schedule;
};

/** The three program fields the selection is supposed to move. */
const programState = (app: LeadApplication | undefined) => ({
	draft_type: app?.draft_type,
	draft_amount: app?.draft_amount,
	monthly_deposit: app?.monthly_deposit,
});

// Runs twice — once before UW and once after. UW submission rewrites the
// selection to Bi-Weekly (observed on both `regular` and `split`, 2026-08-08),
// so the post-UW call is the one that has to stick. Note this is invisible when
// CHOICE is bi-weekly: the reset lands on the value we asked for.
const selectSchedule = async (
	faid: string,
	schedule: PaymentSchedule,
): Promise<LeadApplication | undefined> => {
	const res = await sdk.api.selectProgram({
		applicant: { fdr_applicant_id: faid },
		draft_type: schedule.draft_type,
		estimated_monthly_payment: schedule.estimated_monthly_payment,
	});
	if (res.status !== 200) {
		show(res.status, res.data);
		throw new Error("program selection failed");
	}
	const app = res.data.application;
	console.log(JSON.stringify(programState(app)));
	// Compare in the vocabulary we selected in — draftTypeOf() maps the lead's
	// label back to a schedule code, which is the round-trip consumers depend on.
	if (draftTypeOf(app) !== CHOICE.draft_type)
		throw new Error(
			`selection did not take: expected draft_type ${EXPECTED_DRAFT_TYPE}, got ${app?.draft_type ?? "none"}`,
		);
	return app;
};

async function main(
	userId?: string,
	forceHardConditions = false,
): Promise<void> {
	const user = resolveTestUser(userId);
	console.log(`test user: ${user.id}`);
	const ssn = newSsn(user);
	const nextPay = nextPayDate();
	// The OAuth identity doubles as the lead's seller_agent_email (a registered DRA agent).
	const sellerAgentEmail = username;
	console.log(`test ssn: ${ssn} (random first-5 + static ${user.ssnLast4})`);

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
	const email = `smoke-${faid}@${MAILOSAUR_DOMAIN}`;
	show(elig.status, { fdr_applicant_id: faid, email });

	say("2. Register applicant (v2)");
	const reg = await sdk.api.registerApplicantV2({
		seller_agent_email: sellerAgentEmail,
		applicant: {
			first_name: user.firstName,
			last_name: user.lastName,
			email,
			phone_number: user.phone,
			evening_phone_number: EVENING_PHONE,
			date_of_birth: user.dob,
			ssn,
			fdr_applicant_id: faid,
			consent_date: "2024-10-14",
			network_token: user.networkToken,
			physical_address: user.address,
			mailing_address: MAILING_ADDRESS,
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

	// Quote-time tiers. Shown for the record, NOT selected from — createLeadSync
	// submits the income/expense picture and FDR recalculates the program, so the
	// lead's own payment_schedule_options are the ones the selection must key off.
	say("3b. Payment schedules offered at program time (pre-lead)");
	showTiers(papp?.payment_schedule_options);

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
		hardship_category: "Divorce",
		hardship_category_other: "smoke hardship",
		goal_category: "Get out of Debt",
		goal_category_other: "smoke goal",
		reference_id: referenceId,
		seller_agent_email: sellerAgentEmail,
		pull_credit_report: true,
		debt_accounts: progDebtAccounts as unknown as DebtAccount[],
		applicant: {
			first_name: user.firstName,
			last_name: user.lastName,
			phone_number: user.phone,
			evening_phone_number: EVENING_PHONE,
			social_security_number: ssn,
			email,
			date_of_birth: user.dob,
			current_address: user.address,
			mailing_address: MAILING_ADDRESS,
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

	// Clearing hard-conditions from here is a test-only shortcut — a debt
	// consultant does it in a real enrollment. Off unless --force-hard-conditions
	// is passed; without it any outstanding condition gates UW below
	// (ER40301 / CONDITION_NOT_VERIFIED), which is the honest run.
	if (forceHardConditions) {
		say("4c. PATCH verify hard-conditions (--force-hard-conditions)");
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
	} else {
		say("4c. Verify hard-conditions — skipped");
		console.log(
			`${hardAppConds.length} app + ${hardDebtAccounts.length} debt-account hard-conditions left unverified (pass --force-hard-conditions to verify them)`,
		);
	}

	say("4d. Select program schedule (pre-UW)");
	showTiers(gapp?.payment_schedule_options);
	const schedule = pickSchedule(gapp?.payment_schedule_options);
	console.log(
		`chose ${CHOICE.evaluation_type} / ${schedule.draft_type} — $${schedule.estimated_monthly_payment}/mo (draft $${schedule.draft_deposit})`,
	);
	await selectSchedule(faid, schedule);

	say("5. UW submission (v2)");
	const uw = await sdk.api.uwSubmissionV2(faid);
	const disclosureAutoSent =
		uw.status === 200 && uw.data.banking_disclosure_email_sent === true;
	show(uw.status, uw.data);
	if (uw.status !== 200) throw new Error("UW submission not accepted");

	say("5b. Did the selection survive UW?");
	// Re-read the lead rather than reading uw.data.application — the UW response
	// carries a thin projection (identity + status, no program fields; typed as
	// UwSubmissionV2Application since 2026.16.1), so it can't distinguish
	// "reset" from "not included in this payload".
	const postUw = await sdk.api.readLead(faid);
	console.log(JSON.stringify(programState(postUw.data.application)));
	const survived = draftTypeOf(postUw.data.application) === CHOICE.draft_type;
	console.log(
		survived
			? `selection intact (${EXPECTED_DRAFT_TYPE})`
			: `⚠️  UW overwrote it — expected ${EXPECTED_DRAFT_TYPE}, got ${postUw.data.application?.draft_type ?? "none"} (re-selecting below)`,
	);

	say("5c. Re-select program schedule (post-UW)");
	await selectSchedule(faid, schedule);

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

// Positional arg picks the identity: `pnpm smoke core-spinwheel`. Undefined
// (no arg) falls through to DEFAULT_TEST_USER; an unknown id fails inside main,
// before any call goes out, with the list of known ones.
const argv = process.argv.slice(2);
main(
	argv.find((a) => !a.startsWith("--")),
	argv.includes("--force-hard-conditions"),
).catch((err) => {
	console.error(err);
	process.exit(1);
});
