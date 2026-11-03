/**
 * Local repairs to FDR's published ARPC spec.
 *
 * The vendored JSON stays byte-identical to what FDR shipped, so the next drop
 * diffs cleanly. Spec defects are patched here instead, at
 * codegen time, via orval's `input.override.transformer` — including live
 * endpoints the spec omits, whose guard is simply "the path is still absent".
 *
 * The point of this file is that repairs **expire loudly**. Every repair
 * declares `applies()` — a check that the defect is still present — and the
 * runner throws if it isn't. When FDR ships a fix, `pnpm codegen` fails and
 * tells you to delete the repair, rather than silently carrying a patch that
 * no longer does anything (or worse, one that now does the wrong thing).
 *
 * Guard discipline: assert the minimum that makes the patch correct, nothing
 * more. Fingerprinting unrelated details causes false build breaks on every
 * upstream edit; asserting too little lets a stale patch apply silently.
 *
 * Adding a repair? Give it a `reason` a stranger can act on, and make sure
 * `applies()` would return false the moment FDR does the obvious fix.
 */
import type { OpenAPIObject } from "openapi3-ts/oas30";

/**
 * The spec version every repair below was validated against. A mismatch throws:
 * a spec bump should force a human to re-check each patch, since a guard can
 * only detect a defect disappearing, not one whose meaning quietly changed.
 */
const VERIFIED_AGAINST = "2026.22.0";

interface Repair {
	/** Stable id, logged on every codegen run. */
	id: string;
	/** What FDR ships and why we diverge. Printed when the guard fires. */
	reason: string;
	/** When this was raised with FDR. */
	reported: string;
	/** Is the defect still present? `false` means it's fixed — delete the repair. */
	applies(spec: OpenAPIObject): boolean;
	apply(spec: OpenAPIObject): void;
}

const REPAIRS: Repair[] = [];

/** orval `input.override.transformer` — see `codegen.ts`. */
export const repairSpec = (spec: OpenAPIObject): OpenAPIObject => {
	if (spec.info?.version !== VERIFIED_AGAINST) {
		throw new Error(
			[
				`Spec version is ${spec.info?.version}, but the repairs in openapi/repairs.ts were validated against ${VERIFIED_AGAINST}.`,
				"Re-check each repair against the new spec, then bump VERIFIED_AGAINST:",
				...REPAIRS.map((r) => `  · ${r.id} — ${r.reason}`),
			].join("\n"),
		);
	}

	// Clone so a repair can't leak a mutation back into anything else holding
	// the parsed spec, and so the vendored document stays inspectable as-shipped.
	const repaired = structuredClone(spec);

	for (const repair of REPAIRS) {
		if (!repair.applies(repaired)) {
			throw new Error(
				[
					`Spec repair "${repair.id}" no longer applies — FDR may have fixed it.`,
					`  ${repair.reason}`,
					`  Reported ${repair.reported}.`,
					"Verify against the current spec, then delete this repair from openapi/repairs.ts.",
				].join("\n"),
			);
		}
		repair.apply(repaired);
	}

	console.log(
		`🔧 spec repairs: ${REPAIRS.map((r) => r.id).join(", ") || "none"}`,
	);
	return repaired;
};
