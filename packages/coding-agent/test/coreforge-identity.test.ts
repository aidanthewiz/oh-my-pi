import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AWS_MODEL_AUTH_MODE_ENV,
	AWS_MODEL_PROFILE_ENV,
	AWS_MODEL_REGION_ENV,
	MANAGED_AWS_MODEL_AUTH_MODE,
} from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ensureCoreforgeAwsSso } from "@oh-my-pi/pi-coding-agent/identity/aws-sso";
import {
	type CoreforgeIdentityProfile,
	CoreforgeIdentityStore,
	coreforgeIdentityFirstName,
} from "@oh-my-pi/pi-coding-agent/identity/coreforge-store";
import { validateCoreforgeEntraConfig } from "@oh-my-pi/pi-coding-agent/identity/entra";
import {
	applyCoreforgeIdentityProviderDefaults,
	resolveCoreforgeEntraConfig,
} from "@oh-my-pi/pi-coding-agent/identity/runtime";

const TENANT_ID = "11111111-2222-4333-8444-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function sampleProfile(overrides: Partial<CoreforgeIdentityProfile> = {}): CoreforgeIdentityProfile {
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
		...overrides,
	};
}

function identitySettings(values: Record<string, unknown> = {}): Settings {
	return Settings.isolated({
		"identity.entra.enabled": true,
		"identity.entra.tenantId": TENANT_ID,
		"identity.entra.clientId": CLIENT_ID,
		"identity.entra.authorityHost": "login.microsoftonline.com",
		"identity.aws.profile": "somacommercial",
		"identity.aws.region": "us-east-1",
		"identity.claude.workspaceId": "wrkspc_test",
		"identity.claude.baseUrl": "https://aws-external-anthropic.us-east-1.api.aws",
		...values,
	});
}
const tempDirs: string[] = [];

function tempDbPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-identity-"));
	tempDirs.push(dir);
	return path.join(dir, "agent.db");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("CoreforgeIdentityStore", () => {
	it("persists profile and MSAL cache across store instances", () => {
		const dbPath = tempDbPath();
		const first = new CoreforgeIdentityStore(dbPath);
		first.setProfile(sampleProfile());
		first.setTokenCache('{"Account":{}}');
		first.close();

		const second = new CoreforgeIdentityStore(dbPath);
		try {
			expect(second.getProfile()?.email).toBe("aartherton@coreforcetech.com");
			expect(second.hasTokenCache()).toBe(true);
			expect(second.getTokenCache()).toBe('{"Account":{}}');
		} finally {
			second.close();
		}
	});

	it("rejects malformed persisted profiles instead of returning partial identity", () => {
		const dbPath = tempDbPath();
		const store = new CoreforgeIdentityStore(dbPath);
		try {
			store.setTokenCache("x");
			// Simulate corruption written by an older/broken build.
			store.setProfile(sampleProfile());
			const db = new Database(dbPath);
			db.run(`UPDATE coreforge_identity SET profile_json = '{"email":"only@partial"}'`);
			db.close();
			expect(store.getProfile()).toBeUndefined();
		} finally {
			store.close();
		}
	});

	it("attaches AWS identity to the signed-in profile", () => {
		const store = new CoreforgeIdentityStore(tempDbPath());
		try {
			store.setProfile(sampleProfile());
			const updated = store.setAwsIdentity({
				profile: "somacommercial",
				region: "us-east-1",
				accountId: "891455110252",
				roleArn: "arn:aws:sts::891455110252:assumed-role/AdministratorAccess/aidan",
				validatedAt: 1_700_000_100_000,
			});
			expect(updated.aws?.accountId).toBe("891455110252");
			expect(store.getProfile()?.aws?.profile).toBe("somacommercial");
		} finally {
			store.close();
		}
	});

	it("derives the greeting first name from givenName, then displayName", () => {
		expect(coreforgeIdentityFirstName(sampleProfile())).toBe("Aidan");
		expect(coreforgeIdentityFirstName(sampleProfile({ givenName: undefined }))).toBe("Aidan");
		expect(coreforgeIdentityFirstName(undefined)).toBeUndefined();
	});
});

describe("validateCoreforgeEntraConfig", () => {
	it("accepts commercial and GCC High authority hosts only", () => {
		expect(
			validateCoreforgeEntraConfig({
				tenantId: TENANT_ID,
				clientId: CLIENT_ID,
				authorityHost: "LOGIN.MICROSOFTONLINE.US",
			}).authorityHost,
		).toBe("login.microsoftonline.us");
		expect(() =>
			validateCoreforgeEntraConfig({ tenantId: TENANT_ID, clientId: CLIENT_ID, authorityHost: "evil.example.com" }),
		).toThrow("authority host");
		expect(() =>
			validateCoreforgeEntraConfig({
				tenantId: "not-a-uuid",
				clientId: CLIENT_ID,
				authorityHost: "login.microsoftonline.com",
			}),
		).toThrow("tenant ID");
	});
});

describe("resolveCoreforgeEntraConfig", () => {
	it("stays dormant while enabled but unprovisioned (no tenant/client IDs)", () => {
		const settings = identitySettings({
			"identity.entra.tenantId": undefined,
			"identity.entra.clientId": undefined,
		});
		expect(resolveCoreforgeEntraConfig(settings)).toBeUndefined();
	});

	it("resolves once real IDs are present and rejects malformed ones", () => {
		expect(resolveCoreforgeEntraConfig(identitySettings())?.clientId).toBe(CLIENT_ID);
		expect(() => resolveCoreforgeEntraConfig(identitySettings({ "identity.entra.clientId": "nope" }))).toThrow(
			"client ID",
		);
	});

	it("returns undefined when identity is disabled", () => {
		expect(resolveCoreforgeEntraConfig(identitySettings({ "identity.entra.enabled": false }))).toBeUndefined();
	});
});

describe("applyCoreforgeIdentityProviderDefaults", () => {
	it("force-injects managed AWS + Claude values for a signed-in identity", () => {
		const settings = identitySettings();
		const env: Record<string, string | undefined> = {};
		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => sampleProfile());
		expect(result.entraProvisioned).toBe(true);
		expect(result.identityAvailable).toBe(true);
		expect(env.AWS_PROFILE).toBeUndefined();
		expect(env.AWS_REGION).toBeUndefined();
		expect(env[AWS_MODEL_AUTH_MODE_ENV]).toBe(MANAGED_AWS_MODEL_AUTH_MODE);
		expect(env[AWS_MODEL_PROFILE_ENV]).toBe("somacommercial");
		expect(env[AWS_MODEL_REGION_ENV]).toBe("us-east-1");
		expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe("wrkspc_test");
		expect(env.ANTHROPIC_BASE_URL).toBe("https://aws-external-anthropic.us-east-1.api.aws");
	});

	it("prefers the identity's adopted AWS profile name over the settings constant", () => {
		const settings = identitySettings();
		const env: Record<string, string | undefined> = {};
		const profile = sampleProfile({
			aws: {
				profile: "my-own-name",
				region: "us-east-1",
				accountId: "891455110252",
				roleArn: "arn:test",
				validatedAt: Date.now(),
			},
		});
		applyCoreforgeIdentityProviderDefaults(settings, env, () => profile);
		expect(env.AWS_PROFILE).toBeUndefined();
		expect(env[AWS_MODEL_PROFILE_ENV]).toBe("my-own-name");
	});

	it("clears ambient model-auth envs while preserving the operational AWS chain", () => {
		const settings = identitySettings();
		const env: Record<string, string | undefined> = {
			ANTHROPIC_API_KEY: "sk-ant-stale",
			ANTHROPIC_WORKSPACE_ID: "ws-stale",
			ANTHROPIC_BASE_URL: "https://aws-external-anthropic.us-east-1.api.aws",
			OPENAI_API_KEY: "sk-openai-stale",
			OPENAI_AWS_API_KEY: "bedrock-stale",
			AWS_BEARER_TOKEN_BEDROCK: "bearer-stale",
			AWS_ACCESS_KEY_ID: "AKIASTALE",
			AWS_SECRET_ACCESS_KEY: "secretstale",
			AWS_PROFILE: "user-profile",
			AWS_CONFIG_FILE: "/home/dev/.aws/other-config",
			AWS_SHARED_CREDENTIALS_FILE: "/home/dev/.aws/other-creds",
			PERPLEXITY_API_KEY: "pplx-keep",
		};
		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => sampleProfile());

		expect(env[AWS_MODEL_AUTH_MODE_ENV]).toBe(MANAGED_AWS_MODEL_AUTH_MODE);
		expect(env[AWS_MODEL_PROFILE_ENV]).toBe("somacommercial");
		expect(env[AWS_MODEL_REGION_ENV]).toBe("us-east-1");
		expect(env.ANTHROPIC_BASE_URL).toBe("https://aws-external-anthropic.us-east-1.api.aws");
		expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe("wrkspc_test");
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_WORKSPACE_ID).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.OPENAI_AWS_API_KEY).toBeUndefined();
		expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
		expect(result.clearedKeys).toContain("OPENAI_API_KEY");

		expect(env.AWS_PROFILE).toBe("user-profile");
		expect(env.AWS_ACCESS_KEY_ID).toBe("AKIASTALE");
		expect(env.AWS_SECRET_ACCESS_KEY).toBe("secretstale");
		expect(env.AWS_CONFIG_FILE).toBe("/home/dev/.aws/other-config");
		expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe("/home/dev/.aws/other-creds");
		expect(result.clearedKeys).not.toContain("AWS_ACCESS_KEY_ID");
		expect(env.PERPLEXITY_API_KEY).toBe("pplx-keep");
	});

	it("blocks ambient model auth before sign-in without changing operational AWS credentials", () => {
		const settings = identitySettings();
		const env: Record<string, string | undefined> = {
			ANTHROPIC_API_KEY: "sk-ant-stale",
			ANTHROPIC_WORKSPACE_ID: "ws-stale",
			ANTHROPIC_BASE_URL: "https://aws-external-anthropic.us-east-1.api.aws",
			AWS_PROFILE: "user-profile",
			GITHUB_TOKEN: "ghp-keep",
		};
		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => undefined);
		expect(result.entraProvisioned).toBe(true);
		expect(result.identityAvailable).toBe(false);
		expect(result.appliedKeys).toEqual([AWS_MODEL_AUTH_MODE_ENV]);
		expect(env[AWS_MODEL_AUTH_MODE_ENV]).toBe(MANAGED_AWS_MODEL_AUTH_MODE);
		expect(env[AWS_MODEL_PROFILE_ENV]).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
		expect(env.AWS_PROFILE).toBe("user-profile");
		expect(env.GITHUB_TOKEN).toBe("ghp-keep");
	});

	it("is a no-op that leaves ambient envs untouched when Entra is unprovisioned", () => {
		const settings = identitySettings({
			"identity.entra.tenantId": undefined,
			"identity.entra.clientId": undefined,
		});
		const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-keep", AWS_PROFILE: "keep" };
		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => sampleProfile());
		expect(result.entraProvisioned).toBe(false);
		expect(result.clearedKeys).toEqual([]);
		expect(result.appliedKeys).toEqual([]);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-keep");
		expect(env.AWS_PROFILE).toBe("keep");
	});

	it("is a no-op when Entra is disabled entirely", () => {
		const settings = identitySettings({ "identity.entra.enabled": false });
		const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-keep" };
		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => sampleProfile());
		expect(result.entraProvisioned).toBe(false);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-keep");
	});

	it("still blocks ambient model auth when a signed-in identity hits a malformed managed value", () => {
		const settings = identitySettings({ "identity.claude.baseUrl": "https://not-the-gateway.example.com" });
		const env: Record<string, string | undefined> = {
			ANTHROPIC_API_KEY: "sk-stale",
			AWS_PROFILE: "user-profile",
			OPENAI_AWS_API_KEY: "bedrock-stale",
		};
		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => sampleProfile());
		expect(result.entraProvisioned).toBe(true);
		expect(result.appliedKeys).toEqual([AWS_MODEL_AUTH_MODE_ENV]);
		expect(env[AWS_MODEL_AUTH_MODE_ENV]).toBe(MANAGED_AWS_MODEL_AUTH_MODE);
		expect(env[AWS_MODEL_PROFILE_ENV]).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.OPENAI_AWS_API_KEY).toBeUndefined();
		expect(env.AWS_PROFILE).toBe("user-profile");
		expect(result.configError).toContain("Invalid managed Claude Platform on AWS URL");
	});
});

describe("ensureCoreforgeAwsSso", () => {
	it("returns the validated identity without login when credentials are fresh", async () => {
		const commands: string[][] = [];
		const identity = await ensureCoreforgeAwsSso({ profile: "somacommercial", region: "us-east-1" }, () => {}, {
			findAws: () => "/usr/local/bin/aws",
			now: () => 1_700_000_200_000,
			run: async command => {
				commands.push(command);
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						Account: "891455110252",
						Arn: "arn:aws:sts::891455110252:assumed-role/AdministratorAccess/aidan",
						UserId: "AROAX:aidan",
					}),
					stderr: "",
				};
			},
		});
		expect(identity.accountId).toBe("891455110252");
		expect(identity.validatedAt).toBe(1_700_000_200_000);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("get-caller-identity");
	});

	it("runs aws sso login once when the cached session is expired", async () => {
		const commands: string[][] = [];
		let identityCalls = 0;
		const identity = await ensureCoreforgeAwsSso({ profile: "somacommercial", region: "us-east-1" }, () => {}, {
			findAws: () => "/usr/local/bin/aws",
			run: async command => {
				commands.push(command);
				if (command.includes("get-caller-identity")) {
					identityCalls += 1;
					if (identityCalls === 1) return { exitCode: 255, stdout: "", stderr: "token expired" };
					return {
						exitCode: 0,
						stdout: JSON.stringify({
							Account: "891455110252",
							Arn: "arn:aws:sts::891455110252:assumed-role/x/y",
						}),
						stderr: "",
					};
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		expect(identity.roleArn).toContain("assumed-role");
		expect(commands.some(command => command.includes("sso") && command.includes("login"))).toBe(true);
		expect(identityCalls).toBe(2);
	});

	it("accepts an adopted profile name with spaces (argv-safe, never a shell string)", async () => {
		const identity = await ensureCoreforgeAwsSso({ profile: "my work profile", region: "us-east-1" }, () => {}, {
			findAws: () => "/usr/local/bin/aws",
			run: async command => {
				// The profile travels as ONE argv element, unsplit.
				expect(command).toContain("my work profile");
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						Account: "891455110252",
						Arn: "arn:aws:sts::891455110252:assumed-role/X/y",
					}),
					stderr: "",
				};
			},
		});
		expect(identity.profile).toBe("my work profile");
	});

	it("rejects flag-injection and control-character profile names before spawning anything", async () => {
		const neverRun = async () => {
			throw new Error("must not run");
		};
		await expect(
			ensureCoreforgeAwsSso({ profile: "--profile-injection", region: "us-east-1" }, () => {}, {
				findAws: () => "/usr/local/bin/aws",
				run: neverRun,
			}),
		).rejects.toThrow("Unsafe AWS profile name");
		await expect(
			ensureCoreforgeAwsSso({ profile: "bad\nprofile", region: "us-east-1" }, () => {}, {
				findAws: () => "/usr/local/bin/aws",
				run: neverRun,
			}),
		).rejects.toThrow("Unsafe AWS profile name");
		await expect(
			ensureCoreforgeAwsSso({ profile: "somacommercial", region: "US EAST" }, () => {}, {
				findAws: () => "/usr/local/bin/aws",
				run: neverRun,
			}),
		).rejects.toThrow("Invalid managed AWS region");
	});
});
