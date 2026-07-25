# @borrowbetter/arpcsdk

TypeScript SDK for FDR's **ARPC DEX** API — Achieve Resolution Partner Connect, Digital Enrollment Experience. Wraps the wholesale debt-resolution enrollment flow with a typed client (generated from FDR's OpenAPI spec) plus a hand-written orchestration layer for the multi-step sequence: token lifecycle, the async program poll, condition clearing, the program-summary DRA gate, and DocuSign signing.

## Installation

```bash
npm install @borrowbetter/arpcsdk
```

## Requirements

- Node.js >= 18
- FDR ARPC OAuth client credentials (provided by your FDR integration contact)

## Quick start

```typescript
import { ArpcSDK } from "@borrowbetter/arpcsdk";

const sdk = new ArpcSDK({
  oauthUrl: "https://oauth.stg.ffngcp.com",
  gatewayUrl: "https://apis-gateway-v2.stg.fdrgcp.com",
  username: "borrowbetter@seller.com",   // OAuth client_id (also the seller_agent_email)
  password: process.env.FDR_OAUTH_PASSWORD!,
});

await sdk.authenticate();          // exchange credentials → bearer JWT (~900s TTL)

const run = sdk.createRun();       // fresh enrollment run
await sdk.eligibility(run);        // mints run.faid
await sdk.register(run);           // anchors identity, triggers async credit fetch
await sdk.program(run);            // polls 202/Retry-After → 200
await sdk.createLead(run);
await sdk.getLead(run);            // read hard-condition ids
await sdk.patchConditions(run);    // clear them
await sdk.uwSubmission(run);
if (!run.disclosureAutoSent) await sdk.sendEmail(run);
await sdk.bankUpdate(run);
await sdk.programSummaryTask(run); // gates DRA generation
await sdk.readiness(run);
const dra = await sdk.generateDra(run);
console.log(dra.display.signing_url); // DocuSign embedded signing URL
```

Every step returns a `StepResult` — `{ ok, status, display, raw }`. Steps never throw on a gated non-2xx (e.g. a UW readiness gate); inspect `ok`/`status`/`raw` instead. Escape hatch: `sdk.api.*` exposes the raw typed operations, one method per gateway endpoint.

## The enrollment flow

`fdr_applicant_id` is the through-line across every call.

| Step | Endpoint |
|------|----------|
| `authenticate` | `POST {oauth}/v1/token` |
| `eligibility` | `POST /v2/application/eligibility` (mints the applicant id) |
| `register` | `POST /v2/applicant/register` |
| `program` | `POST /v1/application/program` (202 → … → 200 poll) |
| `createLead` | `POST /v3/application` |
| `getLead` / `patchConditions` | `GET` / `PATCH /v1/application/{id}` |
| `uwSubmission` | `POST /v2/application/uw-submission/{id}` |
| `sendEmail` | `POST /v1/application/send-email/{id}` (only if UW didn't auto-send) |
| `bankUpdate` | `PATCH /v1/application/bank-update/{id}` |
| `programSummaryTask` | `POST /v2/application/program-summary-task/{id}` — **gates DRA** |
| `readiness` | `GET /v1/application/{id}/readiness` |
| `generateDra` | `POST /v2/application/{id}/dra` (DocuSign embedded signing URL) |

`leadTransfer` (`POST /v1/application/lead-transfer`) is a separate retail-handoff path, off the enrollment happy path — no inactivation, so the digital and retail leads both stay active and whichever enrolls first wins.

## Development

```bash
cp .env.example .env   # fill in STG credentials
npm install
npm run codegen        # regenerate the typed client from the OpenAPI spec
npm run smoke          # drive the full flow against live STG (prints each step)
npm run ui             # web smoke UI — dev endpoint view + a consumer checkout mock
npm run typecheck
npm run build          # codegen + tsup → dist/ (esm + cjs + d.ts)
```

The typed client (`src/generated/`) is generated from the committed spec (`api-v2026.15.0.json`) and is not checked in — `npm run codegen` (run automatically by `build`) reproduces it. To move to a newer spec, drop the JSON in the project root and update `input.target` in `codegen.ts`.

## Releasing

```bash
./publish.sh <npm-otp> [patch|minor|major]
```

Requires a clean tree on `main` and an npm login. Typechecks, builds, bumps the version, tags, pushes, and publishes `@borrowbetter/arpcsdk`.
