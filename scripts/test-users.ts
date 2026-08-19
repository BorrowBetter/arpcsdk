/**
 * Canned STG test identities the smoke run enrolls.
 *
 * Only what actually varies per identity lives here — name, phone, DOB, SSN
 * last-4, address and network token. Each entry is bound to a canned Spinwheel
 * credit pull in STG: those fields are what tie the applicant to it, so they
 * travel together as one fixture and are not independently editable. Everything
 * else the flow sends (evening phone, mailing address, inbox domain) is shared
 * test data and lives in `smoke.ts`.
 *
 * These identities exist in STG only. Nothing here is safe to run against PRD.
 */

/** A postal address in the shape both register-v2 and the lead expect. */
export interface TestAddress {
	line1: string;
	city: string;
	state: string;
	/** v2 register address is zip_code-only (the old zip/zip_code dual-send is gone). */
	zip_code: string;
	country: string;
}

export interface TestUser {
	/** Registry key — also what a run reports so a trace is attributable. */
	id: string;
	firstName: string;
	lastName: string;
	phone: string;
	dob: string;
	/**
	 * Static SSN last-4. Per FDR (2026-06-16): randomize the first 5 digits, keep
	 * the last 4. The active-client match (ER40604) keys on the full SSN so a
	 * fresh first-5 dodges it; the Spinwheel pull matches on the last 4, so this
	 * value is what keeps the run bound to the canned identity.
	 */
	ssnLast4: string;
	address: TestAddress;
	/** Spinwheel network token for this identity's canned credit pull. */
	networkToken: string;
}

export const TEST_USERS: Readonly<Record<string, TestUser>> = {
	"core-spinwheel": {
		id: "core-spinwheel",
		firstName: "CORE",
		lastName: "SPINWHEEL",
		phone: "6629582324",
		dob: "1990-04-13",
		ssnLast4: "4123",
		address: {
			line1: "123 MAIN STREET",
			city: "TEMPE",
			state: "AZ",
			zip_code: "85288",
			country: "US",
		},
		networkToken: "4e0cccc0-22e0-422c-a54d-79db70e2d0af",
	},
};

/** Who a run enrolls when it doesn't say. */
export const DEFAULT_TEST_USER = "core-spinwheel";

export const resolveTestUser = (id: string = DEFAULT_TEST_USER): TestUser => {
	const user = TEST_USERS[id];
	if (!user)
		throw new Error(
			`Unknown test user: ${id} (known: ${Object.keys(TEST_USERS).join(", ")})`,
		);
	return user;
};

/** Fresh random first-5 + the identity's static last-4 — see `ssnLast4`. */
export const newSsn = (user: TestUser): string =>
	`${Math.floor(10000 + Math.random() * 90000)}${user.ssnLast4}`;
