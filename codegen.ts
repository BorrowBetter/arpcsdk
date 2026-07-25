import { defineConfig } from "orval";

/**
 * Codegen config — generates a typed client from FDR's ARPC DEX spec
 * (v2026.15.0). Output (`src/generated/`) is gitignored and regenerated on
 * build (`pnpm codegen` runs before `tsup`). To update, drop the new spec
 * JSON in `openapi/` and bump the `input.target` below.
 *
 * All calls route through the custom ky mutator in `src/http/client.ts`, which
 * sets the gateway base URL and injects the bearer token.
 *
 * Usage:
 *   pnpm codegen   # regenerate the client
 */
export default defineConfig({
	arpc: {
		input: { target: "./openapi/api-v2026.15.0.json" },
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
