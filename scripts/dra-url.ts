// Mint a fresh DRA (DocuSign) signing URL for an already-set-up applicant.
// Usage: npx tsx scripts/dra-url.ts <fdr_applicant_id>
// The embedded signing URL is short-lived (~5 min) and single-use.
import "dotenv-flow/config";
import { exchangeToken } from "../src/auth";
import { configFromEnv, configure } from "../src/config";
import { getARPCAchieveResolutionPartnerConnectAPI } from "../src/generated/arpc";

configure(configFromEnv());

const faid = process.argv[2];
if (!faid) throw new Error("usage: tsx scripts/dra-url.ts <fdr_applicant_id>");

const api = getARPCAchieveResolutionPartnerConnectAPI();
await exchangeToken();
const dra = await api.generateDra(faid, {
	returning_url: "https://www.example.net/callback/docusign",
	applicant: { signing_type: "url" },
});
console.log(`status ${dra.status}`);
if (dra.status === 200) {
	console.log(`envelopeId: ${dra.data.envelopeId}`);
	console.log(`\nsigning url:\n${dra.data.applicant?.url}`);
} else {
	console.log(JSON.stringify(dra.data, null, 2));
}
