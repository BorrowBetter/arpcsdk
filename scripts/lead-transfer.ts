// Transfer an already-registered applicant to FDR's retail sales floor — the
// drop-off / handoff path (spec v2026.15.0, POST /v1/application/lead-transfer).
// Per FDR (2026-07-25): no inactivation — the wholesale-digital lead and the new
// retail lead both stay active; whichever enrolls first wins, and the loser later
// gets a duplicate / "already enrolled" error. Routing is by fdr_applicant_id;
// the other fields are standardized lead data.
// Usage: npx tsx scripts/lead-transfer.ts <fdr_applicant_id>
import "dotenv-flow/config";
import { exchangeToken } from "../src/auth";
import { configFromEnv, configure } from "../src/config";
import { getARPCAchieveResolutionPartnerConnectAPI } from "../src/generated/arpc";

configure(configFromEnv());

const faid = process.argv[2];
if (!faid)
	throw new Error("usage: tsx scripts/lead-transfer.ts <fdr_applicant_id>");

const api = getARPCAchieveResolutionPartnerConnectAPI();
await exchangeToken();
const res = await api.leadTransfer({
	fdr_applicant_id: faid,
	first_name: "CORE",
	last_name: "SPINWHEEL",
	phone_number: "6629582324",
	unsecured_debt: 30000,
	mailing_address: { city: "TEMPE", state: "AZ", zip_code: "85280" },
});
console.log(`status ${res.status}`);
console.log(`response: ${res.data.response ?? "—"}`);
if (res.data.get_offers_url)
	console.log(`get_offers_url: ${res.data.get_offers_url}`);
if (res.data.response_reason)
	console.log(`reject reason: ${res.data.response_reason}`);
console.log(`\n${JSON.stringify(res.data, null, 2)}`);
