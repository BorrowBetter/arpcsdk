---
"@borrowbetter/arpcsdk": minor
---

**Breaking:** restructure `ArpcConfig` around a required `environment`.

Hosts are now derived rather than passed. `new ArpcSDK()` takes `environment: "dev" | "stg" | "prd"`, and credentials move under a nested `auth` object:

```typescript
// before
new ArpcSDK({
  oauthUrl: "https://oauth.stg.ffngcp.com",
  gatewayUrl: "https://apis-gateway-v2.stg.fdrgcp.com",
  username, password, cache,
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
- New exports: `ARPC_ENDPOINTS`, the `isArpcEnvironment()` type guard, and the `ArpcEnvironment` / `ArpcAuth` / `ArpcUrls` types.
