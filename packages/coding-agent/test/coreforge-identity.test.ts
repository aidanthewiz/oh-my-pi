import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AWS_MODEL_ACCOUNT_ID_ENV,
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
	restoreCoreforgeOperationalAwsEnvironment,
} from "@oh-my-pi/pi-coding-agent/identity/runtime";
import { OPERATIONAL_AWS_ENV_NAMES } from "@oh-my-pi/pi-utils";

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
		"identity.aws.ssoAccountId": "891455110252",
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
		expect(env[AWS_MODEL_ACCOUNT_ID_ENV]).toBe("891455110252");
		expect(env.ANTHROPIC_AWS_WORKSPACE_ID).toBe("wrkspc_test");
		expect(env.ANTHROPIC_BASE_URL).toBe("https://aws-external-anthropic.us-east-1.api.aws");
	});

	it("keeps managed and operational credentials out of repository child environments", async () => {
		const script = `
			import {
				AWS_MODEL_PROFILE_ENV,
				AWS_MODEL_ACCOUNT_ID_ENV,
				AWS_MODEL_REGION_ENV,
			} from "@oh-my-pi/pi-ai";
			import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
			import { applyCoreforgeIdentityProviderDefaults } from "@oh-my-pi/pi-coding-agent/identity/runtime";
			import { filterChildShellEnv } from "@oh-my-pi/pi-utils";

			const settings = Settings.isolated({
				"identity.entra.enabled": true,
				"identity.entra.tenantId": "${TENANT_ID}",
				"identity.entra.clientId": "${CLIENT_ID}",
				"identity.aws.profile": "managed-coreforge",
				"identity.aws.region": "us-east-1",
				"identity.aws.ssoAccountId": "891455110252",
				"identity.claude.workspaceId": "wrkspc_sensitive",
				"identity.claude.baseUrl": "https://aws-external-anthropic.us-east-1.api.aws",
			});
			applyCoreforgeIdentityProviderDefaults(settings, Bun.env, () => ({}));
			const child = filterChildShellEnv(Bun.env, process.cwd(), {
				LEAKED_WORKSPACE: Bun.env.ANTHROPIC_AWS_WORKSPACE_ID,
				SCOPE: "global",
				REGION_LABEL: "us-east-1",
			});
			const modelKeys = [
				AWS_MODEL_PROFILE_ENV,
				AWS_MODEL_ACCOUNT_ID_ENV,
				AWS_MODEL_REGION_ENV,
				"ANTHROPIC_AWS_WORKSPACE_ID",
				"ANTHROPIC_BASE_URL",
			];
			process.stdout.write(JSON.stringify({
				exposedModelKeys: modelKeys.filter((key) => child[key] !== undefined),
				exposedRenamedKeys: ["LEAKED_WORKSPACE"].filter((key) => child[key] !== undefined),
				scope: child.SCOPE,
				regionLabel: child.REGION_LABEL,
				awsProfile: child.AWS_PROFILE,
				awsRegion: child.AWS_REGION,
			}));
		`;
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				PATH: Bun.env.PATH,
				HOME: Bun.env.HOME,
				BUN_OPTIONS: "--no-env-file",
				OMP_NO_ENV_FILE: "1",
				AWS_PROFILE: "employee-ops",
				AWS_REGION: "us-west-2",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			exposedModelKeys: [],
			exposedRenamedKeys: [],
			scope: "global",
			regionLabel: "us-east-1",
		});
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

	it("removes a reserved model profile from the AWS default-profile alias", () => {
		const settings = identitySettings();
		const env: Record<string, string | undefined> = {
			AWS_DEFAULT_PROFILE: "my-own-name",
		};
		const profile = sampleProfile({
			aws: {
				profile: "my-own-name",
				region: "us-east-1",
				accountId: "891455110252",
				roleArn: "arn:test",
				validatedAt: Date.now(),
			},
		});

		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => profile);

		expect(env.AWS_DEFAULT_PROFILE).toBeUndefined();
		expect(env[AWS_MODEL_PROFILE_ENV]).toBe("my-own-name");
		expect(result.removedManagedAwsProfile).toBe(true);
	});

	it("rejects forged operational aliases without adopting them as model credentials", () => {
		const env: Record<string, string | undefined> = {
			AWS_PROFILE: "managed-model-profile",
			AWS_REGION: "managed-model-region",
		};
		for (const key of OPERATIONAL_AWS_ENV_NAMES) {
			env[`OMP_OPERATIONAL_${key}_SET`] = "1";
			env[`OMP_OPERATIONAL_${key}`] = `launcher-${key}`;
		}

		restoreCoreforgeOperationalAwsEnvironment(env);

		for (const key of OPERATIONAL_AWS_ENV_NAMES) {
			expect(env[key]).not.toBe(`launcher-${key}`);
			expect(env[`OMP_OPERATIONAL_${key}_SET`]).toBeUndefined();
			expect(env[`OMP_OPERATIONAL_${key}`]).toBeUndefined();
		}
		expect(env[AWS_MODEL_PROFILE_ENV]).toBeUndefined();
		expect(env[AWS_MODEL_REGION_ENV]).toBeUndefined();
	});

	it("clears ambient model authentication and operational credentials", () => {
		const settings = identitySettings();
		const env: Record<string, string | undefined> = {
			ANTHROPIC_API_KEY: "sk-ant-stale",
			ANTHROPIC_WORKSPACE_ID: "ws-stale",
			ANTHROPIC_BASE_URL: "https://aws-external-anthropic.us-east-1.api.aws",
			OPENAI_API_KEY: "sk-openai-stale",
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
		expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
		expect(result.clearedKeys).toContain("OPENAI_API_KEY");

		expect(env.AWS_PROFILE).toBeUndefined();
		expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.AWS_CONFIG_FILE).not.toBe("/home/dev/.aws/other-config");
		expect(env.AWS_SHARED_CREDENTIALS_FILE).not.toBe("/home/dev/.aws/other-creds");
		expect(env.PERPLEXITY_API_KEY).toBe("pplx-keep");
	});

	it("blocks ambient model and operational authentication before sign-in", () => {
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
		expect(env.AWS_PROFILE).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBe("ghp-keep");
	});

	it("preserves classic AWS credentials and selectors when Entra is unprovisioned", () => {
		const settings = identitySettings({
			"identity.entra.tenantId": undefined,
			"identity.entra.clientId": undefined,
		});
		const env: Record<string, string | undefined> = {
			ANTHROPIC_API_KEY: "sk-keep",
			AWS_PROFILE: "keep",
			AWS_REGION: "us-west-2",
			AWS_ACCESS_KEY_ID: "caller-access",
			AWS_SECRET_ACCESS_KEY: "caller-secret",
		};
		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => sampleProfile());
		expect(result.entraProvisioned).toBe(false);
		expect(env).toEqual({
			ANTHROPIC_API_KEY: "sk-keep",
			AWS_PROFILE: "keep",
			AWS_REGION: "us-west-2",
			AWS_ACCESS_KEY_ID: "caller-access",
			AWS_SECRET_ACCESS_KEY: "caller-secret",
		});
	});

	it("is a no-op when Entra is disabled entirely", () => {
		const settings = identitySettings({ "identity.entra.enabled": false });
		const env: Record<string, string | undefined> = {
			ANTHROPIC_API_KEY: "sk-keep",
			AWS_PROFILE: "caller-profile",
			AWS_REGION: "us-east-1",
			AWS_ACCESS_KEY_ID: "caller-access",
			AWS_SECRET_ACCESS_KEY: "caller-secret",
		};
		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => sampleProfile());
		expect(result.entraProvisioned).toBe(false);
		expect(env).toEqual({
			ANTHROPIC_API_KEY: "sk-keep",
			AWS_PROFILE: "caller-profile",
			AWS_REGION: "us-east-1",
			AWS_ACCESS_KEY_ID: "caller-access",
			AWS_SECRET_ACCESS_KEY: "caller-secret",
		});
	});

	it("preserves classic caller AWS state without exposing credentials to repository children", async () => {
		const script = `
			import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
			import { clearAwsCredentialCache, resolveAwsCredentials } from "@oh-my-pi/pi-ai/providers/aws-credentials";
			import { ensureCoreforgeIdentityAtStartup } from "@oh-my-pi/pi-coding-agent/identity/startup";
			import { filterChildShellEnv } from "@oh-my-pi/pi-utils";
			const settings = (enabled, tenantId, clientId) => Settings.isolated({
				"identity.entra.enabled": enabled,
				"identity.entra.tenantId": tenantId,
				"identity.entra.clientId": clientId,
			});
			const snapshot = () => {
				const child = filterChildShellEnv(Bun.env);
				return {
					accessIsCaller: Bun.env.AWS_ACCESS_KEY_ID === "caller-access",
					secretIsCaller: Bun.env.AWS_SECRET_ACCESS_KEY === "caller-secret",
					sessionIsCaller: Bun.env.AWS_SESSION_TOKEN === "caller-session",
					profileIsCaller: Bun.env.AWS_PROFILE === "caller-profile",
					regionIsCaller: Bun.env.AWS_REGION === "us-west-2",
					defaultProfileIsLaunch: Bun.env.AWS_DEFAULT_PROFILE === "employee",
					childSafe: child.AWS_ACCESS_KEY_ID === undefined && child.AWS_SECRET_ACCESS_KEY === undefined &&
						child.AWS_SESSION_TOKEN === undefined && child.OMP_OPERATIONAL_AWS_PROFILE === undefined,
				};
			};
			Bun.env.AWS_ACCESS_KEY_ID = "caller-access";
			Bun.env.AWS_SECRET_ACCESS_KEY = "caller-secret";
			Bun.env.AWS_SESSION_TOKEN = "caller-session";
			Bun.env.AWS_PROFILE = "caller-profile";
			Bun.env.AWS_REGION = "us-west-2";
			await ensureCoreforgeIdentityAtStartup(settings(false), { interactive: false });
			const disabled = snapshot();
			disabled.modelAccessIsCaller = (await resolveAwsCredentials({ region: "us-west-2" })).accessKeyId === "caller-access";
			clearAwsCredentialCache();
			await ensureCoreforgeIdentityAtStartup(settings(true), {
				interactive: false,
				createStore: () => { throw Error("store unavailable"); },
			});
			const unprovisioned = snapshot();
			unprovisioned.modelAccessIsCaller = (await resolveAwsCredentials({ region: "us-west-2" })).accessKeyId === "caller-access";
			await ensureCoreforgeIdentityAtStartup(settings(true, "not-a-uuid", "also-not-a-uuid"), {
				interactive: false,
				createStore: () => { throw Error("store unavailable"); },
			});
			const managed = snapshot();
			process.stdout.write(JSON.stringify({ disabled, unprovisioned, managed }));
		`;
		const classic = {
			accessIsCaller: true,
			secretIsCaller: true,
			sessionIsCaller: true,
			profileIsCaller: true,
			regionIsCaller: true,
			defaultProfileIsLaunch: true,
			modelAccessIsCaller: true,
			childSafe: true,
		};
		for (const controlledDotenv of [false, true]) {
			const proc = Bun.spawn([process.execPath, "-e", script], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: {
					PATH: Bun.env.PATH,
					HOME: Bun.env.HOME,
					...(controlledDotenv ? { BUN_OPTIONS: "--no-env-file", OMP_NO_ENV_FILE: "1" } : {}),
					AWS_ACCESS_KEY_ID: "trusted-access",
					AWS_SECRET_ACCESS_KEY: "trusted-secret",
					AWS_SESSION_TOKEN: "trusted-session",
					AWS_DEFAULT_PROFILE: "employee",
					OMP_OPERATIONAL_AWS_PROFILE: "employee",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const result = JSON.parse(stdout);
			expect(result.disabled).toEqual(classic);
			expect(result.unprovisioned).toEqual(classic);
			expect(result.managed).toEqual({
				accessIsCaller: false,
				secretIsCaller: false,
				sessionIsCaller: false,
				profileIsCaller: false,
				regionIsCaller: false,
				defaultProfileIsLaunch: false,
				childSafe: true,
			});
		}
	});

	it("still blocks ambient model auth when a signed-in identity hits a malformed managed value", () => {
		const settings = identitySettings({ "identity.claude.baseUrl": "https://not-the-gateway.example.com" });
		const env: Record<string, string | undefined> = {
			ANTHROPIC_API_KEY: "sk-stale",
			AWS_PROFILE: "user-profile",
			AWS_BEARER_TOKEN_BEDROCK: "bedrock-stale",
		};
		const result = applyCoreforgeIdentityProviderDefaults(settings, env, () => sampleProfile());
		expect(result.entraProvisioned).toBe(true);
		expect(result.appliedKeys).toEqual([AWS_MODEL_AUTH_MODE_ENV]);
		expect(env[AWS_MODEL_AUTH_MODE_ENV]).toBe(MANAGED_AWS_MODEL_AUTH_MODE);
		expect(env[AWS_MODEL_PROFILE_ENV]).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
		expect(env.AWS_PROFILE).toBeUndefined();
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

describe.skipIf(process.platform === "win32")("AWS CLI launch provenance", () => {
	it("uses PATH outside managed launches and never falls back to PATH for a managed launch", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-aws-provenance-"));
		try {
			const awsDir = path.join(root, ".aws");
			fs.mkdirSync(awsDir);
			fs.writeFileSync(
				path.join(awsDir, "config"),
				"[profile production]\nregion = us-east-1\nsso_session = employee\nsso_account_id = 123456789012\nsso_role_name = Reader\n[sso-session employee]\nsso_start_url = https://fixture.invalid/start\nsso_region = us-east-1\n",
			);
			fs.writeFileSync(
				path.join(root, "aws"),
				`#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(path.join(root, "aws.calls"))}, JSON.stringify(Bun.argv.slice(2)) + "\\n");
if (Bun.argv.includes("export-credentials")) {
 console.log(JSON.stringify({Version:1,AccessKeyId:"ASIAFIXTURE",SecretAccessKey:"fixture-secret",SessionToken:"fixture-token",Expiration:"2099-01-01T00:00:00Z"}));
} else {
 console.log(JSON.stringify({Account:"123456789012",Arn:"arn:aws:iam::123456789012:user/fixture"}));
}
`,
				{ mode: 0o755 },
			);
			const script = `
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureCoreforgeAwsSso } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/identity/aws-sso.ts"))};
import { protectCoreforgeOperationalAwsChildEnvironment } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/identity/runtime.ts"))};
import { resolveAwsCredentials } from ${JSON.stringify(path.resolve(import.meta.dir, "../../ai/src/providers/aws-credentials.ts"))};
import { filterChildShellEnv, getOperationalAwsLaunchMetadata, isCoreforgeManagedLaunch } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/index.ts"))};
const managed = process.env.EXPECT_MANAGED === "1";
assert.equal(isCoreforgeManagedLaunch(), managed);
const metadata = getOperationalAwsLaunchMetadata();
if (process.platform === "linux") assert.ok(metadata);
assert.equal(metadata?.executable, undefined);
protectCoreforgeOperationalAwsChildEnvironment();
const child = filterChildShellEnv({
 NODE_ENV: "production", OTHER_REGION: "us-east-1",
 OMP_OPERATIONAL_AWS_PROFILE: "production", OMP_OPERATIONAL_AWS_REGION: "us-east-1",
 RENAMED_CONFIG: metadata?.configFile,
}, process.env.HOME);
assert.equal(child.NODE_ENV, "production");
assert.equal(child.OTHER_REGION, "us-east-1");
assert.equal(child.OMP_OPERATIONAL_AWS_PROFILE, undefined);
assert.equal(child.OMP_OPERATIONAL_AWS_REGION, undefined);
assert.equal(child.RENAMED_CONFIG, undefined);
if (managed) {
 await assert.rejects(ensureCoreforgeAwsSso({profile:"production",region:"us-east-1"}), /AWS CLI v2 is required/);
 await assert.rejects(resolveAwsCredentials({profile:"production",region:"us-east-1"}));
 assert.equal(readFileSync(join(process.env.HOME, "aws.calls"), "utf8"), "");
} else {
 const identity = await ensureCoreforgeAwsSso({profile:"production",region:"us-east-1"});
 assert.equal(identity.accountId, "123456789012");
 const credentials = await resolveAwsCredentials({profile:"production",region:"us-east-1"});
 assert.equal(credentials.accessKeyId, "ASIAFIXTURE");
 const calls = readFileSync(join(process.env.HOME, "aws.calls"), "utf8");
 assert.match(calls, /get-caller-identity/);
 assert.match(calls, /export-credentials/);
}
`;
			for (const managed of [false, true]) {
				fs.writeFileSync(path.join(root, "aws.calls"), "");
				const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
					cwd: root,
					env: {
						HOME: root,
						USERPROFILE: root,
						PATH: root,
						NODE_ENV: "production",
						EXPECT_MANAGED: managed ? "1" : "0",
						...(managed ? { OMP_DOTENV_OVERRIDE: "1", OMP_CF_PRODUCT_VERSION: "fixture" } : {}),
						...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exit] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(exit, `${stdout}\n${stderr}`).toBe(0);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
