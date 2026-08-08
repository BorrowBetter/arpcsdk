---
"@borrowbetter/arpcsdk": minor
---

Upgrade to ARPC DEX spec **2026.16.0**, adding payment schedule selection.

**New:** `sdk.api.selectProgram()` (`POST /v1/application/program-selection`) commits an applicant to a payment schedule. Eligibility, program and lead applications now carry `payment_schedule_options[]` — three tiers (`Most Affordable` / `Best Value` / `Fastest`), each broken out into `regular`, `split` and `bi-weekly` schedules. New `PaymentScheduleOption` / `PaymentSchedule` / `ProgramSelectionRequest` types; `PaymentOption` gains `evaluation_type`.

**New:** `DRAFT_TYPE_LABEL`, `DRAFT_TYPE_CODE` and `draftTypeOf()`. You send a lowercase schedule code (`bi-weekly`) to `selectProgram`, but the lead reports a capitalised label (`Bi-Weekly`) back on `application.draft_type`, with nothing in the spec connecting them. `draftTypeOf(lead.application)` closes the round-trip. The maps are typed as `Record<>` over the generated enums, so a new draft type upstream fails compilation rather than slipping through.

**Structured readiness errors:** `ReadinessCheck` gains `error_details[]` with a stable `reason_code` enum and a dotted `field` path — prefer it over the free-text `errors[]`, which is kept for compat.

**Breaking (types):**

- `RegisterApplicantResponse` → **`RegisterApplicantV2Response`**, which adds `fdr_applicant_id` (generated server-side when the request omits it).
- Several previously-open string fields are now enums and may surface as type errors: `LeadApplicant.pay_frequency` and `.employment_status` (`Unemployed` → `Not Employed`), `CreateLeadRequest.hardship_category` / `.goal_category`, `LeadDebtAccount.responsibility`, `LeadApplication.status` / `.sub_status` / `.draft_type`.
- `RegisterApplicantV2Request.applicant` and its `address.zip_code` are now required.

**Spec repairs.** The vendored spec stays byte-identical to FDR's; defects we've reported to them are patched at codegen time by `openapi/repairs.ts`. Each repair asserts the defect still exists and fails `pnpm codegen` when it doesn't, so an upstream fix breaks the build instead of leaving a stale patch in place. Where the generated types therefore differ from FDR's published spec:

- `ProgramSelectionRequest.applicant` is `ProgramSelectionApplicant` (just `fdr_applicant_id`) rather than the full registration `Applicant`. **Calls don't need a cast.**
- `LeadApplicationDraftType` is `Bi-Weekly | Regular | Split` — the values the API actually returns. FDR documents `Monthly [Regular]` and `Twice Monthly [Split]`; confirmed against STG that neither exists.
- `ReadinessErrorResponse` and `ErrorDetails` stay exported. 2026.16.0 deleted them, but STG still returns that shape when UW hits a readiness gate, so the UW `400` points at it.
- `selectProgram`'s 401/500 use `ARPCErrorResponse`; the empty `ServerResponse` type is gone.

**Also:** `LeadDebtAccount` gains `tradeline_source` and `universal_id`; `Applicant.consent_date` is `date` rather than `date-time`; the optional `X-Arpc-Flow-Type` header is gone from every operation. The spec now documents `POST /v1/token`, but it's excluded from codegen — it targets the OAuth host with HTTP Basic, and `src/auth.ts` already owns the token lifecycle.

**Behaviour documented in the README**, all confirmed against live STG:

- UW submission **overwrites** the program selection with `Bi-Weekly` rather than clearing it — invisible if bi-weekly is what you selected. Re-select after UW, every time.
- `split` cannot reach a DRA: the gate fails on `secondDraftDateMissing` and no request field sets it. `bi-weekly` and `regular` both complete.
- `hardship_category`, `hardship_category_other` and `goal_category` are all required by underwriting despite being spec-optional — lead creation returns `200` without them and UW then fails with `ER40301`.
