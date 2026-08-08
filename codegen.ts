import { defineConfig } from "orval";
import { repairSpec } from "./openapi/repairs";

/**
 * Codegen config — generates a typed client from FDR's ARPC DEX spec
 * (v2026.16.0). Output (`src/generated/`) is gitignored and regenerated on
 * build (`pnpm codegen` runs before `tsup`). To update, drop the new spec
 * JSON in `openapi/` and bump the `input.target` below.
 *
 * All calls route through the custom ky mutator in `src/http/client.ts`, which
 * sets the gateway base URL and injects the bearer token.
 *
 * The generated types intentionally diverge from FDR's published spec in a few
 * places — see `openapi/repairs.ts` for the list and the reasoning.
 *
 * Usage:
 *   pnpm codegen   # regenerate the client
 */
export default defineConfig({
	arpc: {
		input: {
			target: "./openapi/api-v2026.16.0.json",
			// The spec documents `POST /v1/token`, but it targets the OAuth host with
			// HTTP Basic and a form-encoded body. Every generated op runs through the
			// ky mutator, which routes to the gateway and sends JSON — so a generated
			// token op would always be wrong. `src/auth.ts` owns that exchange.
			filters: { mode: "exclude", tags: ["Authentication"] },
			// Patches FDR-side spec defects at codegen time. Each repair asserts the
			// defect still exists and throws when it doesn't, so a fix upstream breaks
			// the build instead of leaving a dead patch behind.
			override: { transformer: repairSpec },
		},
		output: {
			mode: "single",
			target: "./src/generated/arpc.ts",
			schemas: "./src/generated/model",
			// 'axios' is Orval's name for the config-object mutator contract
			// (customInstance({ url, method, data, ... })) — NOT a runtime dep. axios is
			// not installed; the mutator in src/http/client.ts is ky. Don't switch to
			// 'fetch' without rewriting the mutator (it changes the call signature).
			client: "axios",
			clean: true,
			override: {
				mutator: { path: "./src/http/client.ts", name: "customInstance" },
			},
		},
	},
});
