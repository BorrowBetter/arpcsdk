import ky from "ky";
import { getConfig } from "../config";

// ---------------------------------------------------------------------------
// Orval custom mutator (ky-backed).
//
// Every generated operation calls `customInstance<T>(config, options)`. We
// route all calls to the API gateway, inject the bearer token, and return a
// small { status, data, headers } wrapper WITHOUT throwing on non-2xx — the
// flow steps inspect status codes themselves (202 + Retry-After on program,
// 400 on a UW/DRA gate, etc.) and surface them as `ok:false`.
// ---------------------------------------------------------------------------

let bearerToken: string | null = null;
export function setBearerToken(token: string | null): void {
	bearerToken = token;
}

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
	const { url, method, params, data, headers, signal } = {
		...request,
		...options,
	};

	const target = new URL(url, getConfig().gatewayUrl);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null)
				target.searchParams.set(key, String(value));
		}
	}

	const response = await ky(target, {
		method,
		headers: {
			...headers,
			...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
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
