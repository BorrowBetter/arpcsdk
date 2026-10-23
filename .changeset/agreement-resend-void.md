---
"@borrowbetter/arpcsdk": minor
---

Add `resendAgreement()` and `voidAgreement()` for DRA envelopes

FDR serves `POST /v2/application/{id}/agreement/{envelopeId}/resend` and `PUT /v1/application/{id}/agreement/{envelopeId}/void`, but neither is in the published 2026.16.1 spec. Both are added at codegen time as spec repairs (`agreement-resend`, `agreement-void`) that fail the build once FDR ships them, so they retire the same way the existing repairs do.

Resend keeps the envelope and returns a fresh signing URL (`DraResponse`); void cancels it. New types: `AgreementResendRequest`, `AgreementVoidRequest`, `AgreementVoidResponse`, and `AgreementErrorResponse`, which is `ARPCErrorResponse` with `error_details: { envelope_id }`. Error shapes were confirmed against STG; the 200 shapes come from FDR's guide.

The smoke run now resends, voids and reissues after generating the DRA.
