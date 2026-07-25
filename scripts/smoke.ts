/**
 * CLI smoke — drives the shared flow engine (src/flow.ts) through the full FDR
 * ARPC DEX enrollment sequence against live STG and prints each step's result.
 * The web smoke UI (scripts/server.ts) drives the exact same engine, so CLI and
 * UI stay in lockstep.
 *
 * Flow: token → eligibility → registerV2 → program(poll) → lead → GET → PATCH →
 *       uwSubmissionV2 → send-email(only if not auto-sent) → bank → program-summary →
 *       readiness → DRA.
 */
import "dotenv-flow/config";
import { configFromEnv, configure } from "../src/config";

configure(configFromEnv());

import {
	newRun,
	type Run,
	type StepResult,
	stepBankUpdate,
	stepCreateLead,
	stepEligibility,
	stepGenerateDra,
	stepGetLead,
	stepPatchConditions,
	stepProgram,
	stepProgramSummaryTask,
	stepReadiness,
	stepRegister,
	stepSendEmail,
	stepToken,
	stepUwSubmission,
} from "../src/flow";

const say = (s: string) => console.log(`\n\x1b[1m=== ${s} ===\x1b[0m`);
const show = (r: StepResult) =>
	console.log(`status ${r.status}`, JSON.stringify(r.display, null, 2));

async function main(): Promise<void> {
	const run: Run = newRun("cli");
	console.log(`test ssn: ${run.ssn} (random first-5 + static 4123)`);

	say("1. Token exchange");
	show(await stepToken(run));

	say("2. Eligibility");
	show(await stepEligibility(run));

	say("3. Register applicant (v2)");
	show(await stepRegister(run));

	say("4. Program generation (poll until ready)");
	const program = await stepProgram(run);
	show(program);
	if (!program.ok) throw new Error("program not ready after polling");

	say("5. Create lead");
	const lead = await stepCreateLead(run);
	show(lead);
	if (!lead.ok) throw new Error("lead create failed");

	say("5b. GET lead (read conditions)");
	show(await stepGetLead(run));

	say("5c. PATCH verify hard-conditions");
	show(await stepPatchConditions(run));

	say("6. UW submission (v2)");
	const uw = await stepUwSubmission(run);
	show(uw);

	let envelopeId: string | undefined;
	if (!uw.ok) {
		console.log("\n(skipping Phase 4 — UW submission was not accepted)");
	} else {
		say("7. Banking disclosure email");
		if (run.disclosureAutoSent) {
			console.log(
				"server auto-sent the disclosure email on UW approval — skipping manual send-email",
			);
		} else {
			show(await stepSendEmail(run));
		}

		say("8. Bank update");
		show(await stepBankUpdate(run));

		say("9. Program summary task (gates DRA)");
		show(await stepProgramSummaryTask(run));

		say("10. DRA readiness");
		show(await stepReadiness(run));

		say("11. Generate DRA (DocuSign URL signing)");
		const dra = await stepGenerateDra(run);
		show(dra);
		if (dra.ok) envelopeId = run.dra?.envelopeId;
	}

	say("TRACE (for FDR)");
	console.log(`fdr_applicant_id : ${run.faid}`);
	if (envelopeId) console.log(`DRA envelopeId   : ${envelopeId}`);

	if (!envelopeId) {
		say("❌ INCOMPLETE — flow did not reach a DRA envelope");
		process.exit(1);
	}
	say("✅ DONE — full enrollment flow green through DRA generation");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
