# @borrowbetter/arpcsdk

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
