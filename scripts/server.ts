/**
 * Web smoke UI backend — a zero-dependency Node HTTP server that drives the
 * shared flow engine (src/flow.ts) against live STG, one step per request.
 *
 * State lives server-side in an in-memory run store keyed by runId; the browser
 * only ever sees display summaries + raw gateway responses (never the JWT or
 * .env creds). This is a local dev tool — `pnpm ui`, open the printed URL.
 */
import "dotenv-flow/config";
import { configFromEnv, configure } from "../src/config";

configure(configFromEnv());

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	newRun,
	type Run,
	STEPS,
	type StepKey,
	type StepResult,
} from "../src/flow";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "..", "public");
const PORT = Number(process.env.PORT ?? 5178);

const runs = new Map<string, Run>();
let seq = 0;

const STEP_BY_KEY = new Map(STEPS.map((s) => [s.key, s]));

function json(
	res: import("node:http").ServerResponse,
	status: number,
	body: unknown,
) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	res.end(payload);
}

async function readBody(
	req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return {};
	}
}

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
};

async function serveStatic(
	res: import("node:http").ServerResponse,
	urlPath: string,
) {
	const rel =
		urlPath === "/"
			? "index.html"
			: urlPath === "/checkout"
				? "checkout.html"
				: urlPath.replace(/^\/+/, "");
	// keep the read inside PUBLIC
	const filePath = join(PUBLIC, rel);
	if (!filePath.startsWith(PUBLIC))
		return json(res, 403, { error: "forbidden" });
	try {
		const buf = await readFile(filePath);
		const ext = rel.slice(rel.lastIndexOf("."));
		res.writeHead(200, {
			"content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
		});
		res.end(buf);
	} catch {
		json(res, 404, { error: "not found" });
	}
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
	const path = url.pathname;

	try {
		// ---- API -----------------------------------------------------------
		if (req.method === "POST" && path === "/api/start") {
			const runId = `run-${++seq}`;
			const run = newRun(runId);
			runs.set(runId, run);
			return json(res, 200, {
				runId,
				ssn: run.ssn,
				nextPay: run.nextPay,
				steps: STEPS.map((s) => ({ key: s.key, label: s.label })),
			});
		}

		if (req.method === "POST" && path.startsWith("/api/step/")) {
			const key = path.slice("/api/step/".length) as StepKey;
			const step = STEP_BY_KEY.get(key);
			if (!step) return json(res, 404, { error: `unknown step: ${key}` });
			const body = await readBody(req);
			const run = runs.get(String(body.runId));
			if (!run)
				return json(res, 400, {
					error: "unknown or expired runId — start a new run",
				});

			const started = Date.now();
			try {
				const result: StepResult = await step.run(run);
				return json(res, 200, {
					key,
					...result,
					ms: Date.now() - started,
					faid: run.faid ?? null,
					disclosureAutoSent: run.disclosureAutoSent ?? null,
				});
			} catch (err) {
				// A real transport/validation throw (not a gated non-2xx, which the
				// steps return as ok:false). Surface the actual message.
				return json(res, 200, {
					key,
					status: 0,
					ok: false,
					threw: true,
					display: { error: err instanceof Error ? err.message : String(err) },
					raw: null,
					ms: Date.now() - started,
				});
			}
		}

		// ---- static --------------------------------------------------------
		if (req.method === "GET") return serveStatic(res, path);

		json(res, 405, { error: "method not allowed" });
	} catch (err) {
		json(res, 500, { error: err instanceof Error ? err.message : String(err) });
	}
});

server.listen(PORT, () => {
	console.log(
		`\n  arpcsdk smoke UI  →  http://localhost:${PORT}\n  (drives live STG; each step is a real gateway call)\n`,
	);
});
