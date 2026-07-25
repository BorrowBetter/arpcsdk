import ky from "ky";
import { getConfig } from "./config";
import { setBearerToken } from "./http/client";

// Token exchange lives in the orchestration layer, not the generated client:
// it targets the OAuth host (not the gateway), uses HTTP Basic, and is
// form-encoded. We store the resulting JWT for the mutator to attach.
export interface TokenResponse {
	access_token: string;
	token_type?: string;
	expires_in?: number;
}

export async function exchangeToken(): Promise<TokenResponse> {
	const { oauthUrl, username, password } = getConfig();
	const basic = Buffer.from(`${username}:${password}`).toString("base64");

	const token = await ky
		.post(`${oauthUrl}/v1/token`, {
			headers: { Authorization: `Basic ${basic}` },
			body: new URLSearchParams({ grant_type: "client_credentials" }),
		})
		.json<TokenResponse>();

	setBearerToken(token.access_token);
	return token;
}
