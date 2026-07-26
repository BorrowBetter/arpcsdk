# @borrowbetter/arpcsdk

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
