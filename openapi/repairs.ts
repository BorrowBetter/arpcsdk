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
const VERIFIED_AGAINST = "2026.21.0";

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

/** Marker appended to every patched schema so the divergence shows up in editor tooltips. */
const PATCHED =
	"\n\n⚠️ Patched locally by `openapi/repairs.ts` — this differs from FDR's published spec.";

const ADDED =
	"\n\n⚠️ Added locally by `openapi/repairs.ts` — FDR serves this, but their published spec doesn't document it.";

/** Register new component schemas, refusing to clobber one FDR has since shipped. */
const addSchemas = (
	spec: OpenAPIObject,
	added: Record<string, SchemaObject>,
): void => {
	const schemas = mustSchemas(spec);
	for (const [name, value] of Object.entries(added)) {
		if (schemas[name])
			throw new Error(
				`repair precondition failed: components.schemas.${name} already exists — FDR may have shipped it`,
			);
		schemas[name] = value;
	}
};

// Placeholder names vary across FDR's own paths (`{applicantId}` on DRA,
// `{fdrApplicantId}` elsewhere), so an upstream copy of an added route may not
// match ours character for character.
const hasPath = (spec: OpenAPIObject, path: string): boolean => {
	const shape = (p: string) => p.replace(/\{[^}]+\}/g, "{}");
	return Object.keys(spec.paths ?? {}).some((p) => shape(p) === shape(path));
};

const jsonBody = (schemaName: string) => ({
	"application/json": {
		schema: { $ref: `#/components/schemas/${schemaName}` },
	},
});

const errorResponses = (overrides: Record<string, string> = {}) =>
	Object.fromEntries(
		["400", "401", "403", "404", "500"].map((code) => [
			code,
			{
				description: `HTTP ${code}`,
				content: jsonBody(overrides[code] ?? "ARPCErrorResponse"),
			},
		]),
	);

const agreementPathParams = [
	{
		name: "fdrApplicantId",
		in: "path" as const,
		description: "The unique FDR applicant ID",
		required: true,
		schema: { type: "string" as const },
	},
	{
		name: "envelopeId",
		in: "path" as const,
		description: "DocuSign envelope ID, as returned by `generateDra`",
		required: true,
		schema: { type: "string" as const },
	},
];

// ---------------------------------------------------------------------------

/** Every `{ $ref, type: "null" }` object in the spec — see `nullableRefs`. */
const nullableRefSites = (spec: OpenAPIObject): Record<string, unknown>[] => {
	const sites: Record<string, unknown>[] = [];
	const walk = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return;
		const obj = node as Record<string, unknown>;
		if (typeof obj.$ref === "string" && obj.type === "null") sites.push(obj);
		for (const child of Object.values(obj)) walk(child);
	};
	walk(spec);
	return sites;
};

const nullableRefs: Repair = {
	id: "nullable-refs",
	reason:
		'2026.21.0 moved to OpenAPI 3.1, and SpringDoc encodes a nullable reference as `{ $ref, type: "null" }`. Under 3.1 that is an intersection (the referenced object AND null — unsatisfiable), and orval drops the sibling, so e.g. `ARPCErrorResponse.error_details` and `LeadApplication.bank_details` generate as non-null. Rewritten to `anyOf: [{ $ref }, { type: "null" }]`, which generates `T | null`.',
	reported: "not yet",
	// A sweep, not a list of sites: any survivor still needs the rewrite, and the
	// guard fires only once FDR emits none at all.
	applies(spec) {
		return nullableRefSites(spec).length > 0;
	},
	apply(spec) {
		for (const site of nullableRefSites(spec)) {
			const { $ref, type, description, ...rest } = site;
			if (Object.keys(rest).length > 0)
				throw new Error(
					`repair precondition failed: nullable $ref to ${$ref} carries unexpected keys (${Object.keys(rest).join(", ")})`,
				);
			delete site.$ref;
			delete site.type;
			site.anyOf = [{ $ref }, { type }];
			site.description = `${description ?? ""}${PATCHED}`;
		}
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

// Resend and void are live on the gateway but absent from every published spec
// through 2026.21.0; FDR documents them only in a prose guide. The 200 shapes
// come from that guide; the error shapes were confirmed against STG, which
// disagrees with the guide's example (a string `status` and an epoch
// `timestamp`; the wire sends neither).

const RESEND_PATH =
	"/v2/application/{fdrApplicantId}/agreement/{envelopeId}/resend";
const VOID_PATH =
	"/v1/application/{fdrApplicantId}/agreement/{envelopeId}/void";

const agreementResend: Repair = {
	id: "agreement-resend",
	reason: `POST ${RESEND_PATH} — re-issues a signing URL (or email) for an existing DRA envelope without voiding it — is served by the gateway but missing from the spec.`,
	reported: "not yet — sourced from FDR's resend/void guide (2026-10-22)",
	applies(spec) {
		return !hasPath(spec, RESEND_PATH);
	},
	apply(spec) {
		addSchemas(spec, {
			AgreementResendApplicant: {
				type: "object",
				required: ["signing_type"],
				properties: {
					signing_type: {
						type: "string",
						enum: ["url", "email"],
						description:
							"`url` returns a fresh embedded signing URL; `email` triggers DocuSign's email flow and returns no URL.",
					},
				},
				description: `Applicant resend preferences${ADDED}`,
			},
			AgreementResendRequest: {
				type: "object",
				required: ["applicant"],
				properties: {
					applicant: {
						$ref: "#/components/schemas/AgreementResendApplicant",
					},
				},
				description: `Request body to resend an existing DRA envelope${ADDED}`,
			},
		});
		spec.paths[RESEND_PATH] = {
			post: {
				tags: ["Phase 4: Fulfillment and Enrollment"],
				summary: "Resend a DRA envelope",
				description: `Keeps the envelope active and returns a fresh embedded signing URL (\`signing_type: "url"\`) or re-sends the signing email (\`"email"\`). Use this, not void, to get another URL for a still-correct agreement. A CA envelope is preview-only while paused (Day 0) and signable after the Day-3 auto-unpause.${ADDED}`,
				operationId: "resendAgreement",
				parameters: agreementPathParams,
				requestBody: {
					required: true,
					content: jsonBody("AgreementResendRequest"),
				},
				responses: {
					"200": {
						description: "Envelope re-issued",
						content: jsonBody("DraResponse"),
					},
					...errorResponses(),
				},
			},
		};
	},
};

const agreementVoid: Repair = {
	id: "agreement-void",
	reason: `PUT ${VOID_PATH} — cancels a DRA envelope so it can no longer be signed — is served by the gateway but missing from the spec.`,
	reported: "not yet — sourced from FDR's resend/void guide (2026-10-22)",
	applies(spec) {
		return !hasPath(spec, VOID_PATH);
	},
	apply(spec) {
		// A copy with `error_details` swapped, not an allOf — an intersection would
		// keep the readiness fields typed on an error that never carries them.
		const base = mustSchema(spec, "ARPCErrorResponse");
		addSchemas(spec, {
			AgreementVoidRequest: {
				type: "object",
				required: ["voiding_reason"],
				properties: {
					voiding_reason: {
						type: "string",
						description: "Business reason for the void",
						example: "Envelope has expired.",
					},
				},
				description: `Request body to void a DRA envelope${ADDED}`,
			},
			AgreementVoidResponse: {
				type: "object",
				properties: {
					status: { type: "string", example: "voided" },
					envelopeId: { type: "string" },
					statusDateTime: {
						type: "string",
						description:
							"Zone-less local timestamp, e.g. `2026-09-03T19:59:37.272043773`",
					},
					xCorrelationId: { type: "string" },
				},
				description: `Void confirmation. Note the camelCase keys, unlike the rest of the API.${ADDED}`,
			},
			AgreementErrorDetails: {
				type: "object",
				properties: { envelope_id: { type: "string" } },
				description: `Error context for agreement lifecycle failures${ADDED}`,
			},
			AgreementErrorResponse: {
				...base,
				properties: {
					...base.properties,
					error_details: {
						$ref: "#/components/schemas/AgreementErrorDetails",
					},
				},
				description: `ARPCErrorResponse whose \`error_details\` carries the envelope rather than readiness checks. ER40501 covers both an unknown envelope and one already voided, completed or declined — terminal, don't retry.${ADDED}`,
			},
		});
		spec.paths[VOID_PATH] = {
			put: {
				tags: ["Phase 4: Fulfillment and Enrollment"],
				summary: "Void a DRA envelope",
				description: `Ends the envelope so it can no longer be signed. Use only when the agreement must be cancelled or replaced — never just to get another signing URL (resend does that).${ADDED}`,
				operationId: "voidAgreement",
				parameters: agreementPathParams,
				requestBody: {
					required: true,
					content: jsonBody("AgreementVoidRequest"),
				},
				responses: {
					"200": {
						description: "Envelope voided",
						content: jsonBody("AgreementVoidResponse"),
					},
					...errorResponses({ "400": "AgreementErrorResponse" }),
				},
			},
		};
	},
};

// ---------------------------------------------------------------------------

const REPAIRS: Repair[] = [
	nullableRefs,
	programSelectionApplicantId,
	agreementResend,
	agreementVoid,
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
