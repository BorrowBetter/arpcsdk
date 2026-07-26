import ky from "ky";
import { resolveToken } from "../auth";
import { getConfig } from "../config";

// ---------------------------------------------------------------------------
// Orval custom mutator (ky-backed).
//
// Every generated operation calls `customInstance<T>(config, options)`. We
// route all calls to the API gateway, attach the bearer token via a
// beforeRequest hook (lazy auth — `resolveToken()` exchanges/refreshes as
// needed), and return a small { status, data, headers } wrapper WITHOUT
// throwing on non-2xx — the caller inspects status codes itself (202 +
// Retry-After on program, 400 on a UW/DRA gate, etc.).
// ---------------------------------------------------------------------------

// Shape Orval passes as the first arg (axios-style request config).
export interface RequestConfig {
	url: string;
	method: string;
	params?: Record<string, unknown>;
	data?: unknown;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	responseType?: string;
}

export interface HttpResponse<T> {
	status: number;
	data: T;
	headers: Headers;
}

export const customInstance = async <T>(
	request: RequestConfig,
	options?: Partial<RequestConfig>,
): Promise<HttpResponse<T>> => {
	const { url, method, params, data, signal } = { ...request, ...options };
	// Merge headers from both sides — a per-call override (e.g. an
	// x-correlation-id in `options.headers`) must not drop the operation's
	// Content-Type. The bearer token is layered on last, below.
	const headers = { ...request.headers, ...options?.headers };

	const target = new URL(url, getConfig().urls.gateway);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null)
				target.searchParams.set(key, String(value));
		}
	}

	const response = await ky(target, {
		method,
		headers,
		hooks: {
			// Lazy bearer injection: resolveToken() exchanges on the first call
			// and refreshes once the cached token goes stale. The OAuth exchange
			// itself runs on a bare ky.post (no hook), so there's no recursion.
			beforeRequest: [
				async (req) => {
					req.headers.set("Authorization", `Bearer ${await resolveToken()}`);
				},
			],
		},
		...(data !== undefined ? { json: data } : {}),
		signal,
		throwHttpErrors: false,
		retry: 0,
		// Some gateway calls (program generation in particular) can take well over ky's
		// 10s default to respond. Raise the per-request ceiling; the program poll loop
		// handles 202/Retry-After on top of this.
		timeout: 60_000,
	});

	const text = await response.text();
	let body: T;
	try {
		body = (text ? JSON.parse(text) : undefined) as T;
	} catch {
		// Non-JSON body (e.g. a gateway HTML error page on a transient 5xx). Don't throw —
		// hand back the raw text so callers can inspect status/body and retry as needed.
		body = text as unknown as T;
	}
	return { status: response.status, data: body, headers: response.headers };
};
