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
const VERIFIED_AGAINST = "2026.16.0";

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

const mustProperties = (spec: OpenAPIObject, name: string) => {
	const properties = schema(spec, name)?.properties;
	if (!properties)
		throw new Error(
			`repair precondition failed: components.schemas.${name} is missing, a $ref, or has no properties`,
		);
	return properties;
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

/** Same members, order-insensitive. */
const sameValues = (a: readonly unknown[], b: readonly unknown[]): boolean =>
	a.length === b.length && a.every((value) => b.includes(value));

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

const programSelectionApplicant: Repair = {
	id: "program-selection-applicant",
	reason:
		"ProgramSelectionRequest.applicant $refs the full registration Applicant (10 required fields incl. ssn, network_token, physical_address), but the endpoint keys off fdr_applicant_id alone — FDR's own request example sends nothing else. As shipped, a generated client can't call it without a cast, and the type implies we should re-send PII on a schedule-selection call.",
	reported: "2026-08-08",
	applies(spec) {
		const applicant = schema(spec, "ProgramSelectionRequest")?.properties
			?.applicant;
		return (
			isRef(applicant) && applicant.$ref === "#/components/schemas/Applicant"
		);
	},
	apply(spec) {
		mustSchemas(spec).ProgramSelectionApplicant = {
			type: "object",
			required: ["fdr_applicant_id"],
			description: `Applicant reference for a program selection — the id is all this endpoint uses.${PATCHED}`,
			properties: {
				fdr_applicant_id: {
					type: "string",
					description:
						"FDR applicant ID — the applicant's passport across all systems.",
					example: "285b4549a62g7d3",
				},
			},
		};
		mustProperties(spec, "ProgramSelectionRequest").applicant = {
			$ref: "#/components/schemas/ProgramSelectionApplicant",
		};
	},
};

const readinessErrorEnvelope: Repair = {
	id: "readiness-error-envelope",
	reason:
		"2026.16.0 deleted ErrorDetails and ReadinessErrorResponse, but STG still returns exactly that shape when UW submission hits a readiness gate (400 ER40301, body carries error_details.checks[]). The spec now points that response at ARPCErrorResponse, which has no error_details object — so the payload carrying the readiness breakdown is untypeable.",
	reported: "2026-08-08",
	applies(spec) {
		const schemas = spec.components?.schemas ?? {};
		return (
			!("ErrorDetails" in schemas) && !("ReadinessErrorResponse" in schemas)
		);
	},
	apply(spec) {
		const schemas = mustSchemas(spec);
		schemas.ErrorDetails = {
			type: "object",
			description: `Readiness check breakdown returned inside a gated error response.${PATCHED}`,
			properties: {
				checks: {
					type: "array",
					description: "Per-gate check results",
					items: { $ref: "#/components/schemas/ReadinessCheck" },
				},
				is_program_refresh_required: {
					type: "boolean",
					description:
						"Whether a program refresh is required before re-submission",
					example: false,
				},
				is_uw_approved: {
					type: "boolean",
					description: "Whether the application is currently UW-approved",
					example: false,
				},
				message: {
					type: "string",
					description: "Human-readable summary of the gate failure",
					example: "Application needs to be approved by Underwriter",
				},
			},
		};
		schemas.ReadinessErrorResponse = {
			type: "object",
			description: `Error body returned when a readiness gate blocks UW submission. Observed live as a 400 with error_code ER40301.${PATCHED}`,
			properties: {
				status: { type: "integer", format: "int32", example: 400 },
				error: {
					type: "string",
					description: "Short error message",
					example: "UW readiness check failed",
				},
				error_code: {
					type: "string",
					description: "Error classification code",
					example: "ER40301",
				},
				timestamp: {
					type: "string",
					description: "UTC timestamp of the error",
					example: "2026-08-08T14:56:20.933058286Z",
				},
				x_correlation_id: {
					type: "string",
					description: "Correlation ID for distributed tracing",
					example: "0ebfccae-3a9f-495b-bc86-97e064372227",
				},
				error_details: { $ref: "#/components/schemas/ErrorDetails" },
			},
		};

		repointResponse(
			spec,
			"/v2/application/uw-submission/{fdrApplicantId}",
			"400",
			"ReadinessErrorResponse",
		);
	},
};

/** What FDR documents for `LeadApplication.draft_type` — two of these don't exist. */
const SPEC_DRAFT_TYPES = [
	"Bi-Weekly",
	"Monthly [Regular]",
	"Twice Monthly [Split]",
];
/** What the API actually returns, confirmed against STG. */
const LIVE_DRAFT_TYPES = ["Bi-Weekly", "Regular", "Split"];

const leadDraftTypeValues: Repair = {
	id: "lead-draft-type-values",
	reason:
		"LeadApplication.draft_type declares ['Bi-Weekly', 'Monthly [Regular]', 'Twice Monthly [Split]'], but STG returns 'Bi-Weekly', 'Regular' and 'Split'. Two of the three documented values do not exist — verified end-to-end against STG on 2026-08-08 by selecting each draft type in turn and reading the value back.",
	reported: "2026-08-08",
	// The whole enum is replaced, so the whole enum is what has to be proven —
	// checking only for the bad value would let a fourth member FDR added get
	// silently flattened away.
	applies(spec) {
		const draftType = schema(spec, "LeadApplication")?.properties?.draft_type;
		return (
			!isRef(draftType) &&
			Array.isArray(draftType?.enum) &&
			sameValues(draftType.enum, SPEC_DRAFT_TYPES)
		);
	},
	apply(spec) {
		const draftType = mustProperties(spec, "LeadApplication").draft_type;
		if (!draftType || isRef(draftType))
			throw new Error(
				"repair precondition failed: LeadApplication.draft_type is missing or a $ref",
			);
		draftType.enum = [...LIVE_DRAFT_TYPES];
		draftType.description = `Draft frequency type, as reported by the lead.${PATCHED}`;
	},
};

const SELECT_PROGRAM_PATH = "/v1/application/program-selection";

const selectProgramErrors: Repair = {
	id: "select-program-error-responses",
	reason:
		"selectProgram's 401 and 500 point at ServerResponse, an empty `{type: object}` schema, where every other operation in the spec uses ARPCErrorResponse. Looks unintentional, and it generates a junk model.",
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

// ---------------------------------------------------------------------------

const REPAIRS: Repair[] = [
	programSelectionApplicant,
	readinessErrorEnvelope,
	leadDraftTypeValues,
	selectProgramErrors,
];

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
