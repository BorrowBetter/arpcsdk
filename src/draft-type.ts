import type {
	LeadApplication,
	LeadApplicationDraftType,
	ProgramSelectionRequestDraftType,
} from "./generated/model";

/**
 * FDR's API speaks two vocabularies for the same value. You *send* a lowercase
 * schedule code (`bi-weekly`) to `selectProgram`; the lead *reports* a
 * capitalised label (`Bi-Weekly`) back on `application.draft_type`. Nothing in
 * the spec connects them, and the mismatch is silent — comparing what you sent
 * against what came back always looks like a failure.
 *
 * The labels below were confirmed against live STG by selecting each draft type
 * in turn, not read off the spec: FDR documents `Monthly [Regular]` and
 * `Twice Monthly [Split]`, and the API returns neither (see the
 * `lead-draft-type-values` repair in `openapi/repairs.ts`).
 *
 * Scope is narrow: `LeadApplication.draft_type` is the only label-valued site
 * in the whole spec. `PaymentSchedule` and `ProgramSelectionRequest` are both
 * already lowercase, and `LeadPatchRequest` has no `draft_type` at all, so
 * `selectProgram` is the only write path.
 *
 * These maps are annotated as `Record<>` over the generated enums on purpose:
 * if FDR ever adds a fourth draft type, codegen widens the enum and these fail
 * to compile until someone fills in the new key. The mapping keeps itself
 * honest without any bespoke assertion.
 */

/** Schedule code → the label the lead reports back. */
export const DRAFT_TYPE_LABEL: Record<
	ProgramSelectionRequestDraftType,
	LeadApplicationDraftType
> = {
	regular: "Regular",
	split: "Split",
	"bi-weekly": "Bi-Weekly",
};

/** Lead-reported label → the schedule code `selectProgram` accepts. */
export const DRAFT_TYPE_CODE: Record<
	LeadApplicationDraftType,
	ProgramSelectionRequestDraftType
> = {
	Regular: "regular",
	Split: "split",
	"Bi-Weekly": "bi-weekly",
};

/**
 * Read a lead's current draft type as a value you can hand straight back to
 * `selectProgram` — closing the round-trip FDR's two vocabularies leave open.
 *
 * Returns `undefined` when the lead has no selection yet, and also when the
 * label isn't one we know: the server can start returning a new picklist value
 * before we've regenerated against a newer spec, and guessing would be worse
 * than admitting we don't recognise it.
 */
export const draftTypeOf = (
	application: LeadApplication | undefined | null,
): ProgramSelectionRequestDraftType | undefined => {
	const label = application?.draft_type;
	return label ? DRAFT_TYPE_CODE[label] : undefined;
};
