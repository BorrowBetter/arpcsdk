---
"@borrowbetter/arpcsdk": minor
---

Lazy, cacheable OAuth token lifecycle.

**BREAKING:** `sdk.authenticate()` is removed. Authentication now happens lazily on the first `api` call via a ky `beforeRequest` hook — the SDK exchanges credentials, caches the bearer JWT, and refreshes it automatically ~30s before expiry. Delete any `await sdk.authenticate()` calls; the first operation handles it.

**New:** an optional `cache?: TokenCache` on `ArpcConfig` to control where the token lives — persist it across restarts or share one token across workers instead of the default in-memory, per-process store. The cache owns expiry (`get()` returns `null` when stale); the SDK single-flights the exchange so a cold burst does one `/v1/token` call.
