# @borrowbetter/arpcsdk

## 0.5.0

### Minor Changes

- [#6](https://github.com/BorrowBetter/arpcsdk/pull/6) [`21e97fa`](https://github.com/BorrowBetter/arpcsdk/commit/21e97fad0bb066af48ee743d79c1fa009d71cb34) Thanks [@rkingon](https://github.com/rkingon)! - ARPC spec 2026.16.1 — three of the four spec repairs retired

  FDR's 16.1 drop fixes most of what we reported against 16.0. The repair guards
  fired on the version bump, as designed, and the patches came out:

  - `LeadApplication.draft_type` now enumerates `Bi-Weekly` / `Regular` / `Split`
    upstream, so `lead-draft-type-values` is gone. `DRAFT_TYPE_LABEL`,
    `DRAFT_TYPE_CODE` and `draftTypeOf()` stay — the request still takes lowercase
    codes and the response still reports capitalised labels.
  - `ProgramSelectionRequest.applicant` now `$ref`s a real `ProgramSelectionApplicant`
    schema instead of the full registration `Applicant`, retiring
    `program-selection-applicant`.
  - Readiness failures are typeable upstream: `ARPCErrorResponse.error_details` is
    a typed `ErrorDetails` (`checks[]`, `is_program_refresh_required`,
    `is_uw_approved`, `message`), and the UW readiness failure is documented as a
    `400` with the `422` repurposed to a generic `ER42200`. `readiness-error-envelope`
    is gone with it.

  New types: `UwSubmissionV2Application` / `UwSubmissionV2Applicant` (the thin
  projection the UW response actually returns), `ProgramSelectionApplicant`, and
  FDR's own `ErrorDetails`.

  **Breaking for anyone importing `ReadinessErrorResponse`** — that type was ours,
  synthesised by the retired repair. Readiness detail now lives on
  `ARPCErrorResponse.error_details`.

  Two repairs remain, both on program-selection:

  - `select-program-error-responses` — 401/500 still `$ref` `ServerResponse`, an
    empty `{type: object}`. The 16.1 changelog claims this was fixed; the shipped
    JSON says otherwise.
  - `program-selection-applicant-id` (new) — the new `ProgramSelectionApplicant`
    leaves its only property optional, so `selectProgram({ applicant: {} })`
    type-checks and 400s at runtime.

  Also: `split` can reach a DRA now. 16.1 adds `LeadPatchRequest.second_draft_date_split`,
  to be set after UW submission and before generating the DRA — documented in the
  README gotchas, not yet driven by the smoke run.

## 0.4.0

### Minor Changes

- [#4](https://github.com/BorrowBetter/arpcsdk/pull/4) [`6ffb047`](https://github.com/BorrowBetter/arpcsdk/commit/6ffb0479f64a885ae45efa1f72dd215401fdfaa4) Thanks [@rkingon](https://github.com/rkingon)! - Upgrade to ARPC DEX spec **2026.16.0**, adding payment schedule selection.

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

## 0.3.0

### Minor Changes

- [#3](https://github.com/BorrowBetter/arpcsdk/pull/3) [`5d36997`](https://github.com/BorrowBetter/arpcsdk/commit/5d3699745e9a8b32354d9bbdb002247c9468349d) Thanks [@rkingon](https://github.com/rkingon)! - **Breaking:** restructure `ArpcConfig` around a required `environment`.

  Hosts are now derived rather than passed. `new ArpcSDK()` takes `environment: "dev" | "stg" | "prd"`, and credentials move under a nested `auth` object:

  ```typescript
  // before
  new ArpcSDK({
    oauthUrl: "https://oauth.stg.ffngcp.com",
    gatewayUrl: "https://apis-gateway-v2.stg.fdrgcp.com",
    username,
    password,
    cache,
  });

  // after
  new ArpcSDK({
    environment: "stg",
    auth: { username, password, cache },
  });
  ```

  - `oauthUrl` / `gatewayUrl` are replaced by optional per-host overrides under `urls: { oauth?, gateway? }`. Omitted keys fall back to the environment's host.
  - `cache` moves from the top level to `auth.cache`.
  - **Removed `configFromEnv()`.** The SDK no longer reads environment variables at all — build the config object however you like and pass it in. If you relied on this helper, read the vars yourself at your composition root.
  - New exports: the frozen `ARPC_ENDPOINTS` table, the `isArpcEnvironment()` type guard, and the `ArpcEnvironment` / `ArpcAuth` / `ArpcUrls` / `ArpcEndpoint` types.

## 0.2.0

### Minor Changes

- [#1](https://github.com/BorrowBetter/arpcsdk/pull/1) [`190203e`](https://github.com/BorrowBetter/arpcsdk/commit/190203e5a69b463e6a2cf904f176065a42b56fb5) Thanks [@rkingon](https://github.com/rkingon)! - Lazy, cacheable OAuth token lifecycle.

  **BREAKING:** `sdk.authenticate()` is removed. Authentication now happens lazily on the first `api` call via a ky `beforeRequest` hook — the SDK exchanges credentials, caches the bearer JWT, and refreshes it automatically ~30s before expiry. Delete any `await sdk.authenticate()` calls; the first operation handles it.

  **New:** an optional `cache?: TokenCache` on `ArpcConfig` to control where the token lives — persist it across restarts or share one token across workers instead of the default in-memory, per-process store. The cache owns expiry (`get()` returns `null` when stale); the SDK single-flights the exchange so a cold burst does one `/v1/token` call.

## 0.1.1

### Patch Changes

- [`94c1d4e`](https://github.com/BorrowBetter/arpcsdk/commit/94c1d4e5f8d9d1bdeb45301b90cfb5a9636b8a73) Thanks [@rkingon](https://github.com/rkingon)! - Move releases to CI/CD: Changesets + GitHub Actions (`ci.yml`, `release.yml`) replace the manual `publish.sh` script. Publishing to npm now happens automatically on merge to `main` via OIDC trusted publishing.

## 0.1.0

### Minor Changes

- Initial release. Typed, agnostic client for FDR's ARPC DEX API (Achieve
  Resolution Partner Connect, Digital Enrollment Experience): OAuth token
  lifecycle, two-host routing, bearer injection, and the full endpoint surface
  as typed `sdk.api.*` operations generated from spec v2026.15.0.
