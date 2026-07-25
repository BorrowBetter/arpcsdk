# FDR Wholesale (ARPC DEX) — Working Notes

> **⬆️ NOW ON spec v2026.15.0 (2026-07-25) — read the bottom two sections first.** This `v2/`
> folder is a clean, self-contained rebuild targeting FDR's **v2 endpoints**. The most current
> state is in **"Spec v2026.15.0 migration (2026-07-25)"** at the very bottom (adds the retail
> lead-transfer endpoint, wires the program-summary-task DRA gate, and hits a new draft-date DRA
> blocker). Below that is the "v2 rebuild (2026-07-16)" section (spec 14.0 delta). The body below
> both is carried-over v1-era history (still accurate for the non-v2 endpoints).

> Onboarding doc for future sessions. Goal: eventually build an **SDK** for FDR's
> "ARPC Orchestrators API" (the DEX wholesale debt-resolution flow). Right now we're
> **smoke-testing the happy path** against live STG before writing any SDK code.
> **Current status: full happy path GREEN through UW submission** (hard-conditions cleared
> via a PATCH workaround). Phase 4 (disclosure email → banking → DRA/DocuSign → enrollment) is
> **mapped but NOT tested** — likely next wall is **UW *approval*** (submission ≠ approval).
> Waiting on FDR re: which post-UW steps are live in STG. **Webhook HMAC + STG secret received
> 2026-06-09/11** — but a receiver is **deferred by choice**: webhooks are supplementary, the SDK
> polls as source of truth (see Webhooks section).

---

## TL;DR — what's proven and where we stopped

`./smoke.sh` runs the whole chain against **live STG** and is re-runnable (fresh applicant each run):

| Phase | Step | Endpoint | Result |
|-------|------|----------|--------|
| auth  | token            | `POST {oauth}/v1/token`                  | ✅ 200 |
| 1     | eligibility      | `POST /v2/application/eligibility`       | ✅ 200 — mints `fdr_applicant_id` |
| 1     | register         | `POST /v1/applicant/register`            | ✅ 200 — `business_flow: BORROWB` |
| 2     | program (poll)   | `POST /v1/application/program`           | ✅ 200 — async, 202→…→200 |
| 3     | create lead      | `POST /v3/application`                   | ✅ 200 — eligible, lead created |
| 3     | GET lead         | `GET /v1/application/{id}`               | ✅ 200 — read condition/debt-account ids |
| 3     | PATCH conditions | `PATCH /v1/application/{id}`             | ✅ 200 — verify hard-conditions (workaround) |
| 3     | UW submission    | `POST /v1/application/uw-submission/{id}`| ✅ 200 — `message: success` |

**The conditions workaround (FDR-provided, now wired into `smoke.sh` steps 5b/5c).**
The synthetic test identity trips 3 **hard-conditions** that block UW:
`Address Mis-Match on CBR`, `Name Mis-Match on CBR` (canned CBR name/address ≠ submitted
PII), and `Unknown Creditor` (WACHOVIA tradeline not in their creditor DB). To clear them:
1. `GET /v1/application/{id}` after lead creation to read each condition's Salesforce `id`
   (app-level mismatches live in `application.conditions[]`; `Unknown Creditor` is nested in
   the relevant `debt_accounts[].conditions[]`).
2. `PATCH /v1/application/{id}` with those conditions set `verified_by_debt_consultant: true`
   (shape: `{ "conditions": [...], "debt_accounts": [ {"id", "conditions":[...]} ] }`).
3. UW submission then returns 200.
**Prod note (RESOLVED — not a concern):** the mismatch conditions are a *synthetic-data
artifact*. BorrowBetter uses **Spinwheel in prod** — the same pull this smoke test uses — so real
applicants submit PII that matches their real credit file → these conditions won't fire on the
normal path. The PATCH verify is a STG-test convenience, not a prod compliance issue. (Edge cases
— recent mover, name change, obscure creditor — can still raise conditions in prod, but that's
DC/exception territory.) FDR is also building a "clean" test template (no ETA yet).
**Implication:** the Spinwheel-pull path we've been testing *is* BorrowBetter's prod path — no
separate "partner-supplied credit data" mode to test. (Still TODO: exercise the real
`spinwheel-network-user` connect with our own token instead of the canned test token.)

**Contract changes verified 2026-06-12 against STG** (`smoke_v2.sh`, new spec `api-v20260612.json`):
- **`uw-submission` is body-optional now.** Sent an empty body `{}` → server still parsed through to
  the same late business gate (`ER40604`), confirming FDR's change to read the authoritative lead
  from CRM and ignore the request body. SDK can call it with no body.
- **PATCH condition-verify matches on `id` alone.** Minimal `PatchCondition` shape
  `{ id, verified_by_debt_consultant: true }` (dropping the old `type`/`name`/`condition_id`) → `200`
  and UW advanced *past* the conditions gate to the SSN gate — so the conditions cleared. The fields
  the old workaround sent were redundant.
- **⚠️ Test-data caveat:** the canonical identity (SSN `364754123`, tied to the canned Spinwheel
  token) is now an **active client**, so UW gates on `ER40604 "Active Client SSN Match"` instead of
  returning 200. A different SSN trips the 422 Spinwheel-create path, so we **can't get a green UW
  end-to-end until FDR delivers the clean test template** (still no ETA). The `ER40604` is expected,
  not a regression.

---

## Files in this folder

- `api-v2026.12.2.json` — **current spec, codegen-ready** (received 2026-07-01; v2026.12.2). **Point Orval here.**
  12.2 = doc/spec alignment only, no behavior change: `send-email` request body removed (no body expected),
  response fields standardized to snake_case (`is_program_refresh_required`, `is_uw_approved`, `x_correlation_id`).
  Prior files (`api-v2026.12.1.json`, `api-v20260612.json`) superseded and removed.
- `api-1.json` — the original OpenAPI 3.0.1 spec (FDR API docs "Introduction" tab). v2026.11.0. Superseded; kept for history.
- `ARPC_DEX_FLOW_DIAGRAM.pdf` — sequence diagram, 6 steps (lanes: Partner UI → Partner Backend → DEX API Gateway → WIB → DocuSign → Retail Sales Floor). Treat as the most coherent source for ordering/states.
- `ARPC_DEX_WEBHOOK_EVENTS.md` — webhook event catalog (**12 types** as of 2026-06-11), payload, delivery/retry semantics. **Not exercised** (no receiver — deferred by choice, see Webhooks).
- `WEBHOOK_HMAC_AUTHENTICATION.md` — FDR's HMAC-SHA256 verification spec (headers, signing payload, replay window, 12-event enum). Received 2026-06-11.
- `.env.local` — STG test creds + base URLs (see below). Test creds, do not need rotation.
- `smoke.sh` — the happy-path smoke test (token → … → UW). Re-runnable.
- `smoke_v2.sh` — variant exercising the new contract (empty UW body + minimal PatchCondition shape). Used to verify `api-v20260612.json` on 2026-06-12.
- `src/` — **TypeScript SDK scaffold** (2026-06-13). Orval-generated ky client + typed smoke:
  `orval.config.ts` (codegen config) → `src/generated/` (typed client off `api-v2026.12.2.json`),
  `src/http/client.ts` (ky mutator: gateway base URL + bearer injection, returns `{status,data,headers}`, no-throw),
  `src/auth.ts` (token exchange on the OAuth host), `src/config.ts` (loads `.env.local`),
  `src/smoke.ts` (TS port of `smoke_v2.sh`). Run: `npm run gen` then `npm run smoke`. Full flow green
  through UW (same expected `ER40604`). **ky, not axios.**
- `SPEC_GAPS.md` — round-1 punch-list (against `api-1.json`).
- `SPEC_GAPS_2026.12.md` — round-2 punch-list (against `arpc-dex-spec.json`); the version we sent FDR.
- `SPEC_GAPS_V2_fdr-responses.md` — FDR's round-2 reply with inline responses to each item. **All 6 closed** (see SDK plan).
- `notes.md` — this file.

---

## Auth & environment

Two hosts (in `.env.local`):
- **OAuth**: `https://oauth.stg.ffngcp.com` — `POST /v1/token` ONLY
- **API Gateway**: `https://apis-gateway-v2.stg.fdrgcp.com` — everything else

Token exchange = OAuth2 client_credentials, **HTTP Basic** (`username:password` = client_id:client_secret), body `grant_type=client_credentials` (form-urlencoded). Creds in `.env.local` (`FDR_OAUTH_USERNAME` = `borrowbetter@seller.com`).

The returned JWT (Google securetoken, `iss: …/ffn-authentication-stg`) carries:
- `roles: ["arpc.all", "fdr-sales-uw-reference-data-service.all"]` (API + webhooks)
- `bsn: ["fdr"]`, `sub/email`: the seller account
- **`expires_in: 900`** (15 min) — ⚠️ spec example claims 3600; reality is 900.

Use as `Authorization: Bearer <token>` on all gateway calls.

---

## The DEX flow (4 phases / 6 diagram steps)

`fdr_applicant_id` is the through-line ("passport") across all systems.

1. **Phase 1 — Eligibility & Identity** — `POST /v2/application/eligibility` (stateless, no PII; **mints the `fdr_applicant_id`** + a `program_eligibility_token`) → `POST /v1/applicant/register` (writes PII to Achieve Salesforce, **triggers async credit fetch**).
2. **Phase 2 — Program Generation** — `POST /v1/application/program` in a **poll loop**; returns **202 (+`Retry-After`) while credit pending, 200 when ready**. Single endpoint for generate + refresh.
3. **Phase 3 — Lead Promotion** — `POST /v3/application` (sync lead create; **data authority shifts to Achieve/SUIP here**) → `POST /v1/application/uw-submission/{id}` → `POST /v1/application/send-email/{id}` (banking disclosure). Also `GET`/`PATCH /v1/application/{id}`.
4. **Phase 4 — Fulfillment** — `GET /v1/application/{id}/readiness` → `POST /v2/application/{id}/dra` (returns **DocuSign embedded signing URL**; successful signing auto-triggers enrollment).
5. **Enrollment activation** — purely **webhook-driven** (`DRA_UPDATE` → `WELCOME_CALL_UPDATE` → `CLIENT_UPDATE`).
6. **Drop-off → Retail handoff** — nightly batch (or explicit partner abandonment signal) hands unenrolled leads to the Retail Sales Floor, which does its own fresh credit pull. (Only in the diagram, not the spec.)

---

## Empirical findings NOT in the docs (the valuable part)

- **ID minting is at eligibility, not register.** The `fdr_applicant_id` from eligibility threads cleanly into register (it accepts it) and program. (Spec text ambiguously says register "generates" it; the diagram + reality say eligibility does.)
- **`register` → `salesforce_id` becomes `reference_id` downstream.** e.g. register returns `salesforce_id: 00QW4…`, which appears as `application.reference_id` in the program & lead responses. That's the Phase-3 handle.
- **`business_flow: BORROWB`** is derived from the OAuth identity (baked into the token), returned by register.
- **Async credit fetch is real and variable.** Program poll observed 4–7× `202` then `200`; usually ~12s but **once exceeded 24s** → loop hardened to **20 attempts honoring `Retry-After`**. Build the SDK's program call as a real retry loop.
- **"CORE SPINWHEEL" is a canned Spinwheel test identity** → returns a fixed **10-tradeline Equifax** report. `cbr_report_id` regenerates each run. Secured/education/auto/mortgage lines auto-excluded with `ineligible_reason`; eligible debt ≈ $20.5k at program stage.
- **`estimated_total_debt` differs by stage:** ~$20,537 at program vs **$29,999 at lead create** (29999 is also the canned figure in FDR's own spec examples). Not fully explained — flag for the SDK's expectations.
- **Lead create needs the full expense/income/hardship block** (not just debt accounts). Required-ish: all `*_expenses`, `own_or_rent`, hardship/goal categories, and applicant income fields (`monthly_income`, `other_monthly_income`, `pay_frequency`, `next_pay_date`, plus zeros for social_security/retirement/dividends/annuities/alimony/unemployment/self_employment_1099/child_support/other_government_assistance).
- **`/v3/application` applicant shape ≠ register applicant shape.** Lead uses `phone_number` / `social_security_number` / `current_address`; register uses `day_phone` / `ssn` / `physical_address`. The smoke builder mirrors the lead example's field names.
- **`next_pay_date` must be ≤ 33 days out and not past** (UW window). `smoke.sh` computes `date -v+14d`.
- **Negative disposable income blocks UW** unless you send `negative_cash_flow_grounds_for_exception`. Income here = 8000 + 9521 = 17,521; original smoke expenses (22,799) → negative → error. Fixed by using realistic (lower) expenses so disposable is positive.
- **UW gate (`ER40301`) returns two checks** (`uw_submission`, `dra`). UW submission gates on **`uw_submission`**; the `dra` check (draft dates/amount/type) is Phase-4 banking and is expected-empty here — it is NOT what's blocking UW.
- **Conditions observed on this identity:** soft — Business Debt Check, New Accts not on CBR, Summons & Legal, Secured Account Reminder; **hard (block UW)** — Address Mis-Match, Name Mis-Match, Unknown Creditor.
- **No dedup wall hit in STG:** register reuses canonical test phone `6629582324` / ssn `364754123` every run and still returns `created`. Email is made unique per run (`smoke-{faid}@…mailosaur.net`) to be safe.

## Doc-vs-reality discrepancies (keep in mind for the SDK)

- **zip field name — endpoints inconsistent (transitional; aligned in spec v2026.12.1).** Surfaced
  2026-06-13 porting the smoke to the typed client: `POST /v1/applicant/register` requires **`zip`**
  (400 `ER40001`), while `POST /v3/application` lead-create requires **`zip_code`** (400 `ER40307`,
  which cascades — no program attaches, so you also get spurious "monthly deposit/program length
  zero" + "Debt accounts missing"). FDR response 2026-06-15: backend-alignment ticket open; in the
  meantime spec v2026.12.1 types `RegisterApplicantAddress` with **both** `zip` and `zip_code`.
  **Resolution: keep sending both** (FDR's instruction); once register's backend is aligned they'll
  update the spec and we drop `zip`. `smoke.ts` sends both. Re-verified green on 2026-06-15.
- Token `expires_in`: docs 3600 → **actual 900**.
- Lead create status: spec says 200, diagram says 201 → **observed 200**.
- Phase numbering inconsistent across the 3 docs (spec tags "Phase 1 = identity anchoring"; webhook doc "Phase 2 = identity anchoring"). **Trust the diagram's step order.**
- Diagram shows a **422 "Call for Assistance"** path on credit/identity failure — **never triggered** in our runs (only 202/200). Unknown trigger.

---

## Webhooks (HMAC clarified 2026-06-11; receiver deliberately deferred)

Service `fdr-sales-uw-reference-data-service`, Kafka-sourced. **Dual-delivered** (WIB_MP + DIGITAL) HTTPS POST, 30s timeout, **exp backoff max 2 retries** → dead-letter `sales-uw-webhook-retry-events`. Flat envelope keyed by `fdr_applicant_id`; only event-relevant fields populated.

**Architectural decision (Roi, 2026-06-11): webhooks are SUPPLEMENTARY, never authoritative.** The
SDK polls as the source of truth and treats a webhook only as "poll sooner." Rationale: FDR's retry
policy **discards stale events** instead of redelivering (a retry re-evaluates current state; if a
newer event exists for that `fdr_applicant_id`, the old one is dropped) → a missed delivery can be
permanently lost. So we will **always poll/ping for safety** regardless. ⇒ **No receiver built yet,
by choice** (not blocked). When/if we add one it's pure optimization, and every state it surfaces
must have a poll fallback (map below).

**HMAC — now fully specified** (`WEBHOOK_HMAC_AUTHENTICATION.md`, in this folder):
- Headers: `X-FDR-Signature: sha256=<base64>`, `X-FDR-Timestamp` (ISO-8601 **ms** UTC), `X-FDR-Event-Type`, `X-FDR-Event-Id` (UUID → idempotency/dedupe key), `Content-Type: application/json`.
- Verify: `sig = "sha256=" + base64(HMAC-SHA256(key = base64_decode(secret), data = timestamp + "." + rawBody))`. **Raw bytes** — no re-serialize. Constant-time compare. **5-min** replay window. 401 on missing/stale/mismatch; 200 only after verify+process.
- Secret in `.env.local` → `FDR_WEBHOOK_SECRET_STG` (base64 32-byte, decodes clean). **Reference vector** (for confirming our verifier vs FDR's): signing payload `2026-06-09T10:30:00.123Z.{"event_type":"OPPORTUNITY_UPDATE","fdr_applicant_id":"APP-12345","status":"Underwriting","sub_status":"In Progress"}` → `sha256=iukive1hXWJ/6y3R5kTn2o0fdcnkzr0xtgTp1CYPEVQ=`.
- **Ordering guaranteed** per `fdr_applicant_id`; the same event may arrive >once (dedupe on event-id).

**12 event types** (was 9; HMAC doc added `NECA_UPDATE`, `BANKING_DISCLOSURE_SENT`, `BANK_VALIDATION_COMPLETED`). Event→poll fallback (what the SDK actually relies on):

| Event | Authoritative poll | Notes |
|-------|--------------------|-------|
| `CREDIT_REPORT_READY` | `POST /v1/application/program` (202→200 loop) | already how we detect it; webhook is redundant |
| `LEAD_CREATE` | `POST /v3/application` (sync, we create it) | known at call time |
| `LEAD_UPDATE` / `OPPORTUNITY_UPDATE` | `GET /v1/application/{id}` (`status`/`sub_status`) | also where the **UW-approval** transition should surface |
| `BANKING_DISCLOSURE_SENT` | we call `send-email/{id}` | known at call time; trigger-only payload |
| `DOCUMENT_UPLOAD` | ⚠️ **no valid poll** — `reports` is internal | FDR confirmed 2026-06-12 `/v1/application/reports` is internal, **do not build against it**. Our assumed fallback is dead → DOCUMENT_UPLOAD has no confirmed poll equiv. Re-open with FDR. |
| `BANK_VALIDATION_COMPLETED` | `GET /v1/application/{id}/readiness` checks (likely) | GIACT result; poll equiv **unconfirmed** |
| `DRA_UPDATE` | `…/readiness` (`is_uw_approved`,`checks`) + DRA-gen `envelopeId` | post-signing envelope status poll **unconfirmed** |
| `WELCOME_CALL_UPDATE` / `CLIENT_UPDATE` / `ATTORNEY_REVIEW_COMMENT` | `GET /v1/application/{id}` (`sub_status`?) | post-enrollment; CLIENT_UPDATE's draft/save fields may be **webhook-only** — poll equiv unconfirmed |
| `NECA_UPDATE` | — | undocumented payload **and** unknown poll source; flag to FDR |

**Takeaway:** through enrollment (program/lead/UW/readiness/DRA) polling fully covers us. The
post-enrollment client lifecycle (`CLIENT_UPDATE`, `WELCOME_CALL`, `ATTORNEY_REVIEW`,
`BANK_VALIDATION`, `NECA`) is where a webhook may carry data we can't obviously poll — confirm a
poll fallback with FDR *before* we ever depend on those states.

**E2E test path** (when we do wire a receiver): `register` with a valid applicant emits a minimal
`CREDIT_REPORT_READY` → hangs off `smoke.sh` step 3. Still needs FDR to **register our WIB_MP /
DIGITAL receiver URL(s)** + a publicly reachable endpoint (tunnel) before any delivery arrives.

---

## How to resume

1. `cd` here; creds already in `.env.local`. Needs `curl` + `python3` (macOS stock; uses BSD `date -v`).
2. Run `./smoke.sh` — idempotent, mints a fresh applicant; PATCH-verifies the 3 hard-conditions and ends with **UW submission 200** + a TRACE block (fdr_applicant_id + correlation ids). Stops before disclosure email / DRA.
3. Raw responses land in `/tmp/{elig,reg,prog,lead,lead_get,patch,uw}.json` (+ `*_req.json` for built payloads).
4. `smoke.sh` is the de-facto reference implementation of the call sequence — port it when building the SDK.

## FDR Q&A status (answered 2026-06-09)

ANSWERED:
1. ✅ **Clearing hard-conditions** — PATCH workaround (see above). Clean test template also coming (no ETA).
2. ✅ **UW gate scope** — gates only on `uw_submission`; `dra` is the gate for *agreement (DRA) generation* in Phase 4.
3. ✅ **422 "Call for Assistance"** — fires when **Spinwheel create-user fails** (e.g. wrong last-4 SSN or consent date). Maps to the register / spinwheel-network-user step.
4. ✅ **Token TTL** — 900s is intended (docs to be corrected from 3600).
5. ✅ **Lead create 200 vs 201** — docs to be corrected to 200.

ANSWERED (cont.):
6. ✅ **Webhook HMAC + secret** — received 2026-06-11 (`WEBHOOK_HMAC_AUTHENTICATION.md` + STG secret in `.env.local`). Scheme fully specified; reference vector computed. **Receiver deferred by choice** (webhooks supplementary — see Webhooks section).

OUTSTANDING:
- ⏳ **Register our WIB_MP / DIGITAL receiver URL(s)** with FDR — still needed before any live delivery (only relevant if/when we build the optional receiver).
- ❓ **`NECA_UPDATE`** — in the 12-event enum but undocumented (no payload fields, no poll source). Ask FDR what it carries / what it maps to.
- ❓ **Poll fallbacks for post-enrollment events** (`CLIENT_UPDATE` draft/save fields, `BANK_VALIDATION_COMPLETED`, `DRA` post-signing status) — confirm a GET surfaces these before depending on them.
- 🔄 **`estimated_total_debt` $20.5k (program) vs $29,999 (lead)** — FDR investigating; we sent them `fdr_applicant_id: 3567da46ee4ab89`, lead correlation `6ed715c7-187c-482d-b1f8-62fe64c8ff54`.
- ✅ **Post-UW live in STG?** — RESOLVED 2026-06-16. FDR cleared us past UW; disclosure email + bank-update + readiness all green, UW auto-approves. Only DRA generation blocks (ER40504 agent email). See "Phase 4 — TESTED" section.
- ✅ **Terminology** — RESOLVED 2026-06-12. FDR expanded both in the spec `info.description`:
  **DEX = Digital Enrollment Experience** (we'd guessed "Digital Experience"), ARPC = Achieve
  Resolution Partner Connect.

RESOLVED: production governance of self-verifying mismatch conditions — moot (Spinwheel prod path, real PII matches → won't fire; see Prod note above).

Comms note: FDR set up a **Slack channel** with their dev team for debugging — likely where future back-and-forth happens.

## Partner-facing comms — house style (for anything we hand FDR)

Applies to anything that leaves this folder for FDR: the `SPEC_GAPS_*` docs, Slack messages to
their dev team, emails. `SPEC_GAPS_2026.12.md` is the reference example of the tone we want.

- **Write like a person dashed it off, not like a report.** No "Headline:", no "big improvement!",
  no meta-framing ("two of these block, the rest are confirmations"). Open plainly ("Notes from
  going back through the spec…"), state findings, move on. A bit blunt is fine; breathless is not.
- **Emoji = status only, never decoration.** Use them so problems don't get lost in a list/table:
  ✅ done · ⚠️ partial/incomplete · 🔴 broken/blocking. Drop 👍/🎉 and emoji sprinkled mid-sentence.
  ⚠️ **`❌` renders as a plain monochrome X in Zed and a lot of editor fonts → use 🔴 instead.**
- **Don't expose internal constructs.** No `smoke.sh`, `/tmp/*.json`, `.env.local`, our file names,
  or internal codenames. Describe what we did in their terms: "ran the full flow against STG (token
  → eligibility → … → UW) on <date>", not "reproducible from `./smoke.sh`."
- **Do share what they can act on.** Concrete evidence travels well: HTTP status codes, error codes
  (`ER…`), `fdr_applicant_id`, and `x-correlation-id` values from a dated run so they can trace.
- **Keep the ask obvious.** Each open item ends with the concrete change (e.g. "point
  `CreateLeadRequest.applicant` at a `LeadApplicantInput`"), not just a complaint.

## Phase 4 — FULL FLOW GREEN through DRA generation (2026-06-16)

FDR cleared us past UW 2026-06-16 (bypass program-summary-video for now). `smoke.ts` runs the full
Phase 4 chain and **reaches a DocuSign envelope** — the entire programmatically-drivable flow is
green end-to-end (eligibility → … → UW → send-email → bank-update → readiness → DRA). What's left
is the human signing on the embedded URL, then webhook-driven enrollment (deferred receiver).
Results:

1. **Disclosure email** — `POST /v1/application/send-email/{id}`. ✅ **200** → `{status:"sent", id, ...}`.
   Spec v2026.12.2 removed the request body — `smoke.ts` calls `sendEmail(faid)` with no body arg.
2. **Bank update** — `PATCH /v1/application/bank-update/{id}` (this endpoint DOES exist now; the old
   "no dedicated endpoint" note is obsolete). ✅ **200** with the spec's GIACT test values:
   `{ banking_disclosure_validation:true, verification_code:"1010",
   bank_details:{ account_number:"0000000015", account_routing_number:"122105278" } }`.
3. **UW APPROVAL — RESOLVED: auto-approves in STG.** Right after UW submission, readiness returns
   `is_uw_approved: true`. No manual approval / webhook needed for test data. (Was the #1 open Q.)
4. **DRA readiness** — `GET /v1/application/{id}/readiness`. ✅ **200**;
   `is_uw_approved:true`, `is_program_refresh_required:false`, both gates
   (`uw_submission`, `dra`) `verified:true`, no errors. `smoke.ts` handles the refresh branch if needed.
5. **Generate DRA** — `POST /v2/application/{id}/dra` (`{ returning_url, applicant:{ signing_type:"url" } }`).
   ✅ **200** → returns `envelopeId` + an embedded DocuSign signing URL. The DRA looks up an *agent*
   by the lead's `seller_agent_email`. FDR configured our OAuth identity (borrowbetter@seller.com) as
   a registered agent 2026-06-17, so `SELLER_AGENT_EMAIL = config.oauthUsername` now (was temporarily
   qashwini@aiqseller.com 2026-06-16, before that `ER40504`). Re-verified 2026-06-17: envelope
   `b819220f-54dc-8159-8180-e73fc8621189`.
   - **⚠️ Open (unhappy path): no way to re-issue the embedded signing URL for an existing envelope.**
     The DocuSign URL token is ~5-min TTL + single-use (standard DocuSign). Re-calling DRA gen for an
     applicant that already has an envelope returns `400 ER40501 "Duplicate Envelope Request Error"`.
     So expiry / signer-abandons / resume can't be handled without a fresh applicant. Asked FDR for a
     regenerate-signing-URL path (repeat call returns fresh URL, or a separate recipient-view refresh
     endpoint, à la DocuSign createRecipientView). FDR: MVP focused on happy-path gen; open to it.
6. **Sign → enrollment** — webhook-driven (`DRA_UPDATE` → `WELCOME_CALL_UPDATE` → `CLIENT_UPDATE`).
   Can't observe without the (deliberately deferred) webhook receiver. [PDF Step 5]

Other client robustness fixes found while building Phase 4 (in `src/http/client.ts`): ky's 10s
default timeout → 60s (slow `program` calls); JSON-parse now falls back to raw text on non-JSON
bodies (transient gateway HTML error pages on `program` were crashing the parse).

## Next moves

- (a) **Phase 4 done through DRA envelope** (see "Phase 4 — FULL FLOW GREEN"). Post-UW is live, UW
  auto-approves in STG, and `smoke.ts` runs send-email → bank-update → readiness → DRA end-to-end.
  Remaining: (i) DRA embedded-URL regen for the unhappy path (expiry/abandon/resume) — asked FDR, they're
  open to it; (ii) actual signing + post-sign enrollment are webhook-driven (deferred receiver);
  (iii) bash `smoke_v2.sh` is several steps behind `smoke.ts` — extend it to Phase 4 or retire it.
- (b) Webhook receiver: **deferred by decision** (supplementary; SDK polls for safety). HMAC spec +
  secret are in hand if we ever want it as a latency optimization — would still need FDR to register
  our receiver URL. The SDK's authoritative path is the poll loop, not a delivery feed.
- (c) **SDK plan: Orval (OpenAPI → typed TS client). Spec is codegen-ready** as of
  `api-v2026.12.1.json` (received 2026-06-15). **Three** rounds of gaps sent to FDR eng, all closed:
  round 1 → `arpc-dex-spec.json` (v2026.12.0), round 2 → `api-v20260612.json`, round 3 →
  `api-v2026.12.1.json` (`SPEC_GAPS_round3.md`). Full surface typed; `DebtAccount` + lead-applicant
  shapes fixed; `/v1/token` + spinwheel re-added; spinwheel 401/500 now `GatewayErrorResponse` (no
  more `any`); `RegisterApplicantAddress` carries both `zip`/`zip_code`; version bumped to 2026.12.1.
  **Point Orval at `api-v2026.12.2.json`** (2026-07-01 doc-alignment update: send-email body removed,
  response fields snake_cased — no behavior change; `seller_agent_email` back to borrowbetter@seller.com).
  Client + smoke last full-green end-to-end (through DRA envelope) 2026-06-17. Only carryover is the
  transitional zip dual-send (see Doc-vs-reality), pending FDR's backend ticket.
- (d) Hand-write the **orchestration layer** on top of the generated client (codegen can't express it):
  token lifecycle (basic→bearer, 900s refresh, 2 hosts), the `program` poll loop (202/`Retry-After`),
  `fdr_applicant_id` threading, and the GET-lead→PATCH-conditions→UW sequence. `smoke.sh` is the blueprint.

---

## v2 rebuild (2026-07-16) — spec v2026.14.0

Clean rebuild in this `v2/` subfolder (parent `fdrsdk/` kept as archive). Same architecture as
before — Orval-generated ky client + hand-written orchestration in `src/smoke.ts`. Runtime
(`config.ts`/`auth.ts`/`http/client.ts`) ported verbatim; only `orval.config.ts` (retargeted to
`api-v2026.14.0.json`) and `smoke.ts` (v2 ops) changed.

**What 14.0 added (diffed 12.2 → 14.0):**
- **3 new ops:** `registerApplicantV2` (`POST /v2/applicant/register`), `uwSubmissionV2`
  (`POST /v2/application/uw-submission/{id}`), `createProgramSummaryTask`
  (`POST /v2/application/program-summary-task/{id}`). v1 register + v1 uw-submission are marked
  **deprecated, retired end of July 2026** (extension available on request).
- **Spec-wide error unification:** `GatewayErrorResponse`/`StandardErrorResponse`/
  `RegisterApplicantErrorResponse` removed; every op now types errors as **`ARPCErrorResponse`**
  (`{ status, error_code, error, errors[]?, message?, timestamp, x_correlation_id }`,
  `errors[]` = `FieldValidationError` for field-validation failures).
- **`/v1/token` dropped from the spec** — irrelevant; `auth.ts` hand-rolls token exchange against
  the OAuth host and never used the generated op.
- **Only `Applicant` changed** among shared models → eligibility, createLead, GET/PATCH, readiness,
  DRA all port verbatim. Renames: `day_phone`→`phone_number`, `secondary_phone`→
  `evening_phone_number`; `fdr_applicant_id` no longer required (mint-at-register when eligibility
  scout is skipped). `ssn` stays `ssn`; addresses stay `physical_address`/`mailing_address`.
- **zip dual-send retired.** v2 register address (`RegisterApplicantV2Address`) is **`zip_code`-only**
  — smoke drops the old transitional `zip`. **Confirmed on the run: registerV2 accepts zip_code-only
  (200), no ER40001.** The v1-era dual-send hack is dead on the v2 surface.
- **v2 UW auto-sends the disclosure email** on *full* approval; `UwSubmissionV2Response` adds
  `banking_disclosure_email_sent` (bool) + `banking_disclosure_email_message`. Smoke calls
  `send-email` only when `banking_disclosure_email_sent !== true`.

**Run 2026-07-16 (faid `863b6d23686eb5a`, lead `2182f49b-1d03-4527-ace5-d4376111c0be`):**
GREEN through readiness; only DRA gen blocked.
| Step | Result |
|------|--------|
| token / eligibility / **registerV2** / program(202×3→200) / createLead / GET / PATCH | ✅ 200 |
| **uwSubmissionV2** | ✅ 200 — `banking_disclosure_email_sent:false` ("Suppressed: conditional approval") |
| send-email (fired because auto-send suppressed) | ✅ 200 |
| bank-update | ✅ 200 |
| readiness | ✅ 200 — `is_uw_approved:true`, both checks verified |
| **generate DRA** | 🔴 **400 `ER40501`** |

- **`banking_disclosure_email_sent:false` here = "Suppressed: conditional approval"** (not a full
  UW approval), so the manual send-email path is what we exercised. Readiness still reports
  `is_uw_approved:true`. Worth confirming with FDR when the auto-send actually fires (full approval
  only) vs the conditional-approval suppression we hit — the two "approved" signals differ.
- **🔴 DRA blocker (FDR-side DocuSign config, not ours).** `ER40501`, DocuSign passthrough:
  *"Agreement sending is failed … INVALID_REQUEST_PARAMETER … Captive Recipients not supported with
  SMS Delivery."* We send `signing_type:'url'` (embedded/captive — the flow BB wants) and there is
  **no SMS/delivery knob** in `DraRequest`/`DraApplicantInput`; SMS delivery is configured on FDR's
  DocuSign recipient template. The identical call returned a 200 envelope on 2026-06-17
  (`b819220f-…`), so their STG DocuSign recipient config changed since. **Report to FDR** with
  `x_correlation_id 4d99d9ab-0756-4e66-a28d-9d1c2b13a93e`; ask them to drop SMS delivery on the
  captive/embedded recipient (or make it not conflict with `signing_type:'url'`).
  - Note: `ER40501` was previously "Duplicate Envelope Request Error" (re-gen on an existing
    envelope). Same code, different DocuSign message here — this is a fresh applicant, so it's the
    SMS-vs-captive conflict, not a duplicate.

**Open / carried:**
- `program-summary-task`: generated into the client but **not called** by the smoke. ⚠️ Its spec
  params (`id` path, `X-Arpc-Flow-Type` header) are **missing the required `schema` field** → Orval
  warns and types `id` as `unknown`. Real 14.0 spec bug to flag; harmless since we don't call it.
  Still need FDR to confirm where it slots in the sequence + whether it gates DRA.
- Cosmetic: v1 & v2 register share one `Applicant` schema carrying v2 field names, so the still-live
  v1 endpoint is typed with v2 names. Contained (only the two register ops ref `Applicant`).

### Update 2026-07-20 — DRA fix confirmed, full flow GREEN through DRA ✅

FDR pushed the DocuSign fix. Re-ran to DRA — **green end-to-end** (faid `e82b26g55a32b35`,
lead `efae4e9d-22a1-4f86-b931-7f817f609f73`, envelope `30a42323-3855-835e-8145-5a9d7173143d` +
embedded signing URL). The whole programmatically-drivable v2 flow now passes:
eligibility → registerV2 → program → lead → GET/PATCH → uwSubmissionV2 → send-email → bank-update
→ readiness (`is_uw_approved:true`, both gates verified) → DRA 200.

- **Banking-email behavior confirmed by FDR:** auto-send requires *full* UW approval; conditional
  approval requires hitting the disclosure-email endpoint manually. Matches what we saw — our test
  identity gets conditional approval ("Suppressed: conditional approval"), so the smoke's manual
  send-email path is correct/expected. FDR updating docs to be explicit after this week's release.
- **⚠️ Transient `ER40301` at UW submission.** One re-run gated with `400 ER40301 "UW readiness
  check failed"` at step 6, then a clean re-run passed with the identical sequence. Live-STG
  eventual consistency: the PATCH condition-verify hadn't propagated before uwSubmissionV2 fired.
  **Orchestration layer should retry UW on `ER40301`** (readiness-not-yet-propagated) rather than
  treat it as terminal. `ReadinessErrorResponse.error_details.checks[]` carries the per-gate detail
  (smoke's step-6 gated logging now dumps it).

---

## Spec v2026.15.0 migration (2026-07-25)

Retargeted Orval at `api-v2026.15.0.json` (14.0 removed). Regen was clean — **no more Orval
warning** on program-summary-task (the missing param schemas are fixed, see below). Only two source
files changed for the API surface: `orval.config.ts` (input target) and `src/flow.ts` (new steps);
runtime (`config`/`auth`/`http/client`) untouched.

**What 15.0 changed (diffed 14.0 → 15.0):**
- **v1 endpoints REMOVED from the spec** (were deprecated in 14.0): `POST /v1/applicant/register`
  and `POST /v1/application/uw-submission/{id}`, plus the `RegisterApplicantRequest` schema. We were
  already on v2 for both, so **zero runtime impact** — regen dropped `registerApplicant` /
  `uwSubmission` from `arpc.ts`, which also killed the cosmetic "v1 register typed with v2 field
  names" wart from the 14.0 notes (v1 register is simply gone now).
- **New endpoint: `POST /v1/application/lead-transfer` (`leadTransfer`)** — the Retail Transfer /
  drop-off path. New schemas `LeadTransferRequest` (only `fdr_applicant_id` required; optional PII +
  `mailing_address`/`tracking`/`consents`/`unsecured_debt`), `LeadTransferResponse`
  (`response: accepted|rejected`, `get_offers_url` for accepted, `response_reason` e.g.
  `DuplicateLead` + `response_details[]` for rejected), plus `Consents`, `Tracking`, `MailingAddress`.
- **program-summary-task schemas fixed.** `id` path is now typed `string` (was untyped → Orval
  `unknown`), and `X-Arpc-Flow-Type` (header, `DC`|`DEX`, defaults DEX when absent) now has a schema.
- **No shared-model changes** otherwise (`Applicant`, `LeadApplication`, `RegisterApplicantV2Request`
  all identical 14.0 → 15.0).

**FDR's 6 spec notes (2026-07-25), mapped:**
1. **Eligibility Scout still mints the `fdr_applicant_id` — confirmed.** `RegisterApplicantResponse`
   in 15.0 is still `{status, business_flow, salesforce_id}`, **no `fdr_applicant_id`**. FDR's
   "registerV2 returns the id → ES optional" fix is in-flight this sprint but NOT in the spec yet.
   **Keep `stepEligibility` first** until it lands.
2. **v1 register removed** — confirmed above; no-op for us.
3. **UW → conditional approval → must call send-email.** FDR: it'll be conditional "almost every
   time" for our leads. This is already our main path — the run again returned
   `banking_disclosure_email_sent:false` ("Suppressed: conditional approval") and we fired send-email.
   No code change; the `disclosureAutoSent` branch is correct.
4. **v1 UW removed** — confirmed; we're on `uwSubmissionV2`. No-op.
5. **Program Summary Task GATES DRA** — wired. New `stepProgramSummaryTask` runs between bank-update
   and readiness (added to `STEPS`, the CLI smoke, and both frontends). Sends timestamps + comments;
   omits `X-Arpc-Flow-Type` (defaults DEX) and `ws_psc_code` (DC-only). **⚠️ Returns `201 Created`,
   not 200** — the step accepts 200 **or** 201 (a bare `=== 200` would false-fail the UI/consumer
   flow). Observable on the record: `LeadApplication.program_summary_call_completed`. This closes the
   old "where does PST slot / does it gate DRA" open item.
6. **Retail Transfer** — wired as a **standalone** `lead-transfer.ts` CLI (mirrors `dra-url.ts`);
   `stepLeadTransfer` is exported from `flow.ts` but deliberately **kept out of the ordered `STEPS`
   happy-path** (it's a drop-off branch with a real side effect). **Not run against STG** (would
   create a live retail lead). Per FDR: **no inactivation** — the wholesale-digital lead and the
   retail lead both stay active; whichever enrolls first wins, and the loser later gets a
   duplicate / "already enrolled" error.
   - **How BorrowBetter intends to use it (product intent, Roi 2026-07-25):** it's our **recovery /
     fallback lever**. Two triggers: (a) **reactive** — if the digital flow hits any roadblock or the
     lead bounces (e.g. a gate we can't clear like the current DRA draft-date block, an abandon, a
     hard error), fire lead-transfer so **FDR's sales team calls the applicant and tries to recover**
     the enrollment by phone. (b) **proactive** — we may hit it **up front** so the applicant always
     has options: **phone vs. online checkout**. Because there's no inactivation, calling it early is
     safe — the digital path stays open in parallel, and whoever enrolls first wins (the other side
     just gets the dupe error). So the SDK should surface this as an explicit "hand off to
     retail / talk to someone" action, not just an error path.

**Run 2026-07-25 (clean single run: faid `356bdag84554789`, DRA correlation
`cdc903bb-4720-4b39-b43c-7262860c3fd4`):** GREEN through readiness; **DRA blocked one gate further
along than before.** `ER40303` reproduces on every run — consistent, not flaky.
| Step | Result |
|------|--------|
| token / eligibility / registerV2 / program(202×3→200) / lead / GET / PATCH | ✅ 200 |
| uwSubmissionV2 | ✅ 200 — conditional ("Suppressed: conditional approval") |
| send-email / bank-update | ✅ 200 |
| **program-summary-task** | ✅ **201** — `{status:"success","Task created successfully"}` |
| readiness | ✅ 200 — `is_uw_approved:true`, `uw_submission` gate verified; **`dra` gate NOT verified** |
| **generate DRA** | 🔴 **400 `ER40303` "DRA readiness check failed"** |

- **🔴 NEW DRA blocker — draft/program dates (FDR-side, can't fix from the client).** The `dra`
  readiness gate now rejects with: `firstDraftDate: First draft date cannot be empty` +
  `First Draft Date not compliant with CA 3 day rule`, `secondDraftDateMissing: Second draft date is
  required when draft type is split or bi-weekly`, `programStartDate: Program start date cannot be
  empty`, `estimatedProgramEndDate: Estimated program end date cannot be empty`. These date fields
  (`first_draft_date`, `program_start_date`, `estimated_program_end_date`, `draft_type`,
  `second_draft_date_bi_weekly`) exist **only on `LeadApplication` (a response shape)** — there is
  **no request field anywhere in the 15.0 spec** (`BankUpdateRequest`, `CreateLeadRequest`,
  `LeadPatchRequest`) to set them. So they're backend-derived; we can't populate them. This is
  **new since the 07-20 green run** (envelope `30a4…` went through with the identical inputs and no
  draft dates), so the 15.0 release (or STG data setup) tightened the `dra` gate.
  **Report to FDR** (correlation `cdc903bb-4720-4b39-b43c-7262860c3fd4`, faid `356bdag84554789`): how
  do draft/program dates get populated for the DRA gate — a request field we're missing, or
  backend-derived from the deposit schedule and just not set for our test lead? Also flag the
  **"CA 3 day rule"** despite our applicant's **AZ** address. **Message to FDR drafted 2026-07-25
  (pending send / their reply)** — reads as a reply in the spec-update Slack thread; leads with
  green-through-readiness, then the `ER40303` draft-date blocker + the 201-not-200 PST heads-up.
- Note: this is a *different* blocker than 14.0's `ER40501` (DocuSign SMS-vs-captive) — that gate is
  no longer hit. The DRA wall has moved forward: program-summary gate ✅ passes, DocuSign config ✅
  no longer conflicts, now stuck on draft-date readiness.
- Transient `504` on lead-create on one attempt, clean on immediate re-run — STG gateway flakiness,
  unrelated (the mutator hands back the raw body without throwing).

**Open / carried:**
- 🔴 **DRA draft-date readiness gate** (above) — the one thing blocking a green DRA. FDR question out.
- `lead-transfer` wired but **unexercised** — needs a deliberate test (it mutates state: creates a
  retail lead). Intended as our **recovery/fallback lever** (see note #6 above): reactive on
  roadblock/bounce → FDR sales calls to recover; and possibly proactive up front to give the
  applicant a **phone vs. online checkout** choice (safe to call early — no inactivation, both leads
  stay live). Build it into the SDK as an explicit "hand off to retail" action, not just an error
  path. Good candidate to actually fire against STG next (accepting it creates a real retail lead).
- ES-optional (registerV2-returns-faid) fix is in-flight at FDR — when it ships, `stepEligibility`
  becomes optional and we can register-first.
