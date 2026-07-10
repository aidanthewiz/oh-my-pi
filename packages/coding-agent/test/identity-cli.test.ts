import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runIdentityCommand } from "@oh-my-pi/pi-coding-agent/cli/identity-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CoreforgeIdentityProfile,
	CoreforgeIdentityStore,
} from "@oh-my-pi/pi-coding-agent/identity/coreforge-store";

// Exit-code and error-channel contract for `omp identity`. The recurring bug
// class here: an AWS failure after a successful (and persisted) Entra step
// must degrade to a labelled AWS error — signed-in state stays visible —
// never a generic sign-in error that hides it. Covers login and
// status --refresh symmetrically.

const TENANT_ID = "11111111-2222-4333-8444-555555555555";

function sampleProfile(): CoreforgeIdentityProfile {
	return {
		tenantId: TENANT_ID,
		objectId: "99999999-8888-4777-a666-555555555544",
		homeAccountId: `99999999-8888-4777-a666-555555555544.${TENANT_ID}`,
		username: "aartherton@coreforcetech.com",
		displayName: "Aidan Artherton",
		givenName: "Aidan",
		familyName: "Artherton",
		email: "aartherton@coreforcetech.com",
		authorityHost: "login.microsoftonline.com",
		authenticatedAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
	};
}

function identitySettings(): Settings {
	return Settings.isolated({
		"identity.entra.enabled": true,
		"identity.entra.tenantId": TENANT_ID,
		"identity.entra.clientId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		"identity.entra.authorityHost": "login.microsoftonline.com",
		"identity.aws.profile": "somacommercial",
		"identity.aws.region": "us-east-1",
	});
}

const tempDirs: string[] = [];

function signedInStore(): CoreforgeIdentityStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-identity-cli-"));
	tempDirs.push(dir);
	const store = new CoreforgeIdentityStore(path.join(dir, "agent.db"));
	store.setProfile(sampleProfile());
	store.setTokenCache("opaque-msal-cache");
	return store;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

interface RunResult {
	code: number;
	out: string;
	err: string;
}

async function run(
	action: "login" | "status" | "logout",
	flags: Record<string, boolean>,
	deps: {
		store: CoreforgeIdentityStore;
		awsFails?: boolean;
		entraFails?: boolean;
	},
): Promise<RunResult> {
	let out = "";
	let err = "";
	const entra = {
		login: async () => {
			if (deps.entraFails) throw new Error("entra down");
			return deps.store.getProfile() ?? sampleProfile();
		},
		refresh: async () => {
			if (deps.entraFails) throw new Error("entra down");
			return deps.store.getProfile() ?? sampleProfile();
		},
		logout: async () => deps.store.clear(),
	};
	const code = await runIdentityCommand(
		{ action, flags },
		{
			settings: identitySettings(),
			store: deps.store,
			writeOut: text => {
				out += text;
			},
			writeErr: text => {
				err += text;
			},
			createEntraIdentity: () => entra,
			ensureAwsSso: async () => {
				if (deps.awsFails) throw new Error("SSO portal timeout");
				return {
					profile: "somacommercial",
					region: "us-east-1",
					accountId: "891455110252",
					roleArn: "arn:test",
					validatedAt: Date.now(),
				};
			},
		},
	);
	return { code, out, err };
}

describe("identity login", () => {
	it("reports success and records AWS identity when both legs pass", async () => {
		const store = signedInStore();
		const result = await run("login", {}, { store });
		expect(result.code).toBe(0);
		expect(result.out).toContain("Welcome, Aidan");
		expect(store.getProfile()?.aws?.profile).toBe("somacommercial");
	});

	it("labels an AWS failure distinctly while still reporting Entra success", async () => {
		const store = signedInStore();
		const result = await run("login", {}, { store, awsFails: true });
		expect(result.code).toBe(1);
		expect(result.out).toContain("Welcome, Aidan");
		expect(result.err).toContain("AWS sign-in failed: SSO portal timeout");
		expect(result.err).not.toContain("sign-in error");
	});

	it("reports an Entra failure as a sign-in error", async () => {
		const store = signedInStore();
		const result = await run("login", {}, { store, entraFails: true });
		expect(result.code).toBe(1);
		expect(result.err).toContain("sign-in error: entra down");
	});
});

describe("identity status --refresh", () => {
	it("still prints the signed-in status when the AWS leg fails", async () => {
		const store = signedInStore();
		const result = await run("status", { refresh: true }, { store, awsFails: true });
		expect(result.code).toBe(1);
		expect(result.out).toContain("Signed in as Aidan Artherton");
		expect(result.err).toContain("AWS refresh failed: SSO portal timeout");
		expect(result.err).not.toContain("sign-in error");
	});

	it("returns 0 with AWS identity on a clean refresh", async () => {
		const store = signedInStore();
		const result = await run("status", { refresh: true }, { store });
		expect(result.code).toBe(0);
		expect(result.out).toContain("Signed in as Aidan Artherton");
		expect(result.out).toContain("AWS: somacommercial (891455110252)");
	});

	it("skips the AWS leg under --skip-aws even when it would fail", async () => {
		const store = signedInStore();
		const result = await run("status", { refresh: true, skipAws: true }, { store, awsFails: true });
		expect(result.code).toBe(0);
		expect(result.err).toBe("");
	});

	it("returns 1 without output when signed out", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-identity-cli-"));
		tempDirs.push(dir);
		const store = new CoreforgeIdentityStore(path.join(dir, "agent.db"));
		const result = await run("status", {}, { store });
		expect(result.code).toBe(1);
		expect(result.out).toBe("");
	});
});

describe("identity logout", () => {
	it("clears credentials even when the managed config resolve throws", async () => {
		const store = signedInStore();
		let out = "";
		let err = "";
		const code = await runIdentityCommand(
			{ action: "logout", flags: {} },
			{
				// Malformed managed overlay: present-but-invalid clientId throws on resolve.
				settings: Settings.isolated({
					"identity.entra.enabled": true,
					"identity.entra.tenantId": TENANT_ID,
					"identity.entra.clientId": "not-a-uuid",
					"identity.entra.authorityHost": "login.microsoftonline.com",
				}),
				store,
				writeOut: text => {
					out += text;
				},
				writeErr: text => {
					err += text;
				},
			},
		);
		expect(code).toBe(0);
		expect(store.getProfile()).toBeUndefined();
		expect(out).toContain("Signed out of Coreforge.");
		expect(err).toContain("sign-out cleanup");
	});

	it("clears credentials when the MSAL sign-out itself fails", async () => {
		const store = signedInStore();
		let out = "";
		const code = await runIdentityCommand(
			{ action: "logout", flags: { quiet: true } },
			{
				settings: identitySettings(),
				store,
				writeOut: text => {
					out += text;
				},
				writeErr: () => {},
				createEntraIdentity: () => ({
					login: async () => sampleProfile(),
					refresh: async () => sampleProfile(),
					logout: async () => {
						throw new Error("network down");
					},
				}),
			},
		);
		expect(code).toBe(0);
		expect(store.getProfile()).toBeUndefined();
		expect(out).toBe("");
	});
});
