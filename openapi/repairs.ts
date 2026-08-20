/**
 * Local repairs to FDR's published ARPC spec.
 *
 * The vendored JSON stays byte-identical to what FDR shipped, so the next drop
 * diffs cleanly. Defects we've reported to them are patched here instead, at
 * codegen time, via orval's `input.override.transformer`.
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
import type {
	OpenAPIObject,
	ReferenceObject,
	SchemaObject,
} from "openapi3-ts/oas30";

/**
 * The spec version every repair below was validated against. A mismatch throws:
 * a spec bump should force a human to re-check each patch, since a guard can
 * only detect a defect disappearing, not one whose meaning quietly changed.
 */
const VERIFIED_AGAINST = "2026.16.1";

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

const isRef = (value: unknown): value is ReferenceObject =>
	typeof value === "object" && value !== null && "$ref" in value;

/** A named component schema, or undefined. For `applies()`, which must not throw. */
const schema = (
	spec: OpenAPIObject,
	name: string,
): SchemaObject | undefined => {
	const found = spec.components?.schemas?.[name];
	return found && !isRef(found) ? found : undefined;
};

// The accessors below are for `apply()`, which runs only after `applies()` has
// established the shape. They throw rather than returning undefined: a repair
// that quietly skipped itself is precisely what this file exists to prevent, so
// there is no soft path out of a failed precondition.

const mustSchemas = (spec: OpenAPIObject) => {
	const schemas = spec.components?.schemas;
	if (!schemas)
		throw new Error(
			"repair precondition failed: spec has no components.schemas",
		);
	return schemas;
};

const mustSchema = (spec: OpenAPIObject, name: string): SchemaObject => {
	const found = schema(spec, name);
	if (!found)
		throw new Error(
			`repair precondition failed: components.schemas.${name} is missing or a $ref`,
		);
	return found;
};

/** Does a POST operation's JSON response body point at this component schema? */
const responseRefs = (
	spec: OpenAPIObject,
	path: string,
	code: string,
	schemaName: string,
): boolean => {
	const response = spec.paths?.[path]?.post?.responses?.[code];
	const ref =
		response && !isRef(response)
			? response.content?.["application/json"]?.schema
			: undefined;
	return isRef(ref) && ref.$ref === `#/components/schemas/${schemaName}`;
};

/** Repoint a POST operation's JSON response body at a component schema. */
const repointResponse = (
	spec: OpenAPIObject,
	path: string,
	code: string,
	schemaName: string,
): void => {
	const response = spec.paths?.[path]?.post?.responses?.[code];
	const json =
		response && !isRef(response)
			? response.content?.["application/json"]
			: undefined;
	if (!json)
		throw new Error(
			`repair precondition failed: no JSON body on ${code} of POST ${path}`,
		);
	json.schema = { $ref: `#/components/schemas/${schemaName}` };
};

/** Marker appended to every patched schema so the divergence shows up in editor tooltips. */
const PATCHED =
	"\n\n⚠️ Patched locally by `openapi/repairs.ts` — this differs from FDR's published spec.";

// ---------------------------------------------------------------------------

const SELECT_PROGRAM_PATH = "/v1/application/program-selection";

const selectProgramErrors: Repair = {
	id: "select-program-error-responses",
	reason:
		"selectProgram's 401 and 500 point at ServerResponse, an empty `{type: object}` schema, where every other operation in the spec uses ARPCErrorResponse. Looks unintentional, and it generates a junk model. The 2026.16.1 changelog claims this was fixed; the shipped JSON still says ServerResponse, so it wasn't.",
	reported: "2026-08-08",
	// Both codes are rewritten, so both have to be proven — a guard that checked
	// only the 401 would keep firing after FDR fixed the 500 and would silently
	// overwrite their fix.
	applies(spec) {
		return ["401", "500"].every((code) =>
			responseRefs(spec, SELECT_PROGRAM_PATH, code, "ServerResponse"),
		);
	},
	apply(spec) {
		for (const code of ["401", "500"]) {
			repointResponse(spec, SELECT_PROGRAM_PATH, code, "ARPCErrorResponse");
		}
		// Only drop the schema once nothing points at it. FDR could start using
		// ServerResponse somewhere legitimate, and deleting a live schema would
		// break unrelated generated types.
		if (JSON.stringify(spec).includes("#/components/schemas/ServerResponse"))
			throw new Error(
				"repair precondition failed: ServerResponse is still referenced elsewhere in the spec — it is no longer dead, so this repair must not delete it",
			);
		delete mustSchemas(spec).ServerResponse;
	},
};

const programSelectionApplicantId: Repair = {
	id: "program-selection-applicant-id",
	reason:
		"2026.16.1 introduced ProgramSelectionApplicant (good — the request no longer $refs the full registration Applicant), but left its one property optional. fdr_applicant_id is the only thing the endpoint reads, and omitting it is a 400 (ER40001, `applicant.fdr_applicant_id is required` — FDR's own example). As shipped, `selectProgram({ applicant: {} })` type-checks.",
	reported: "2026-08-19",
	applies(spec) {
		const applicant = schema(spec, "ProgramSelectionApplicant");
		// Membership, not absence: SpringDoc can emit `required: []`, which leaves
		// the field just as optional but would read as "fixed" and break the build.
		return (
			!!applicant?.properties?.fdr_applicant_id &&
			!applicant.required?.includes("fdr_applicant_id")
		);
	},
	apply(spec) {
		const applicant = mustSchema(spec, "ProgramSelectionApplicant");
		// Append, don't replace: if FDR marks some other property required while
		// still omitting this one, `applies()` stays true and a replacing patch
		// would silently drop their requirement.
		applicant.required = [...(applicant.required ?? []), "fdr_applicant_id"];
		applicant.description = `${applicant.description ?? ""}${PATCHED}`;
	},
};

// ---------------------------------------------------------------------------

const REPAIRS: Repair[] = [selectProgramErrors, programSelectionApplicantId];

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

	console.log(`🔧 spec repairs: ${REPAIRS.map((r) => r.id).join(", ")}`);
	return repaired;
};
