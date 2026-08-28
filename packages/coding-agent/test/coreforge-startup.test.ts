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
import { CoreforgeIdentityStore } from "@oh-my-pi/pi-coding-agent/identity/coreforge-store";
import { ensureCoreforgeIdentityAtStartup } from "@oh-my-pi/pi-coding-agent/identity/startup";

// The startup gate's "never throws" contract at its outermost boundary: the
// identity store constructor performs filesystem work (mkdir + SQLite open)
// and can throw. Startup must degrade to signed-out with a notice — a crash
// here bricks every managed install with a read-only home dir or full disk.

const TENANT_ID = "11111111-2222-4333-8444-555555555555";
const MANAGED_MODEL_ENV_KEYS = [AWS_MODEL_AUTH_MODE_ENV, AWS_MODEL_PROFILE_ENV, AWS_MODEL_REGION_ENV] as const;
const initialManagedModelEnv: Record<string, string | undefined> = {
	[AWS_MODEL_AUTH_MODE_ENV]: Bun.env[AWS_MODEL_AUTH_MODE_ENV],
	[AWS_MODEL_PROFILE_ENV]: Bun.env[AWS_MODEL_PROFILE_ENV],
	[AWS_MODEL_REGION_ENV]: Bun.env[AWS_MODEL_REGION_ENV],
};

afterEach(() => {
	for (const key of MANAGED_MODEL_ENV_KEYS) {
		const value = initialManagedModelEnv[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

function identitySettings(): Settings {
	return Settings.isolated({
		"identity.entra.enabled": true,
		"identity.entra.tenantId": TENANT_ID,
		"identity.entra.clientId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		"identity.entra.authorityHost": "login.microsoftonline.com",
	});
}

function throwingStore(): never {
	throw new Error("EACCES: permission denied, mkdir '/home/user/.omp'");
}

describe("ensureCoreforgeIdentityAtStartup store failure", () => {
	it("degrades to signed-out AND clears ambient model-auth envs when the store cannot open", async () => {
		const previous = Bun.env.AWS_BEARER_TOKEN_BEDROCK;
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-key";
		try {
			const result = await ensureCoreforgeIdentityAtStartup(identitySettings(), {
				interactive: false,
				createStore: throwingStore,
			});
			expect(result.firstName).toBeUndefined();
			expect(result.notices).toHaveLength(1);
			expect(result.notices[0]).toContain("Coreforge identity store unavailable");
			expect(result.notices[0]).toContain("EACCES");
			// Store failure must not leave ambient AWS-model auth live when provisioned.
			expect(Bun.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
			else Bun.env.AWS_BEARER_TOKEN_BEDROCK = previous;
		}
	});

	it("prompts for sign-in (does not fall back to envs) when provisioned, non-interactive, not signed in", async () => {
		// Ambient env auth used to suppress the managed flow entirely; now, with
		// Entra provisioned, it must NOT — the user is told to sign in instead.
		const previous = Bun.env.AWS_BEARER_TOKEN_BEDROCK;
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-key";
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-startup-"));
		try {
			const result = await ensureCoreforgeIdentityAtStartup(identitySettings(), {
				interactive: false,
				createStore: () => new CoreforgeIdentityStore(path.join(dir, "agent.db")),
			});
			expect(result.firstName).toBeUndefined();
			expect(result.notices.some(n => n.includes("Coreforge sign-in required"))).toBe(true);
			// Integration proof: the real startup path cleared the ambient model-auth
			// var (not just the unit-level applyDefaults), so no env can authenticate
			// an AWS model when provisioned.
			expect(Bun.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
			else Bun.env.AWS_BEARER_TOKEN_BEDROCK = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restores shell-owned AWS selectors before disabled or unprovisioned identity exits", async () => {
		const previous = {
			AWS_PROFILE: Bun.env.AWS_PROFILE,
			AWS_REGION: Bun.env.AWS_REGION,
			OMP_OPERATIONAL_AWS_PROFILE_SET: Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET,
			OMP_OPERATIONAL_AWS_PROFILE: Bun.env.OMP_OPERATIONAL_AWS_PROFILE,
			OMP_OPERATIONAL_AWS_REGION_SET: Bun.env.OMP_OPERATIONAL_AWS_REGION_SET,
			OMP_OPERATIONAL_AWS_REGION: Bun.env.OMP_OPERATIONAL_AWS_REGION,
		};
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-startup-"));
		try {
			for (const enabled of [false, true]) {
				Bun.env.AWS_PROFILE = "managed-dotenv-profile";
				Bun.env.AWS_REGION = "us-east-1";
				Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET = "1";
				Bun.env.OMP_OPERATIONAL_AWS_PROFILE = "employee-operations";
				Bun.env.OMP_OPERATIONAL_AWS_REGION_SET = "1";
				Bun.env.OMP_OPERATIONAL_AWS_REGION = "eu-west-1";
				const settings = Settings.isolated({ "identity.entra.enabled": enabled });
				const result = await ensureCoreforgeIdentityAtStartup(settings, {
					interactive: false,
					createStore: () => new CoreforgeIdentityStore(path.join(dir, `agent-${enabled}.db`)),
				});
				expect(result.notices).toEqual([]);
				expect(Bun.env.AWS_PROFILE).toBe("employee-operations");
				expect(Bun.env.AWS_REGION).toBe("eu-west-1");
				expect(Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET).toBeUndefined();
				expect(Bun.env.OMP_OPERATIONAL_AWS_REGION_SET).toBeUndefined();
			}
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clears ambient model-auth envs when Entra IDs are present but malformed", async () => {
		// Provisioning intent (IDs present) but a bad tenant UUID -> resolve
		// throws -> can't sign in, but ambient envs must STILL be cleared so
		// they cannot authenticate AWS models.
		const previous = Bun.env.AWS_BEARER_TOKEN_BEDROCK;
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-key";
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-startup-"));
		try {
			const settings = Settings.isolated({
				"identity.entra.enabled": true,
				"identity.entra.tenantId": "not-a-valid-uuid",
				"identity.entra.clientId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				"identity.entra.authorityHost": "login.microsoftonline.com",
			});
			const result = await ensureCoreforgeIdentityAtStartup(settings, {
				interactive: false,
				createStore: () => new CoreforgeIdentityStore(path.join(dir, "agent.db")),
			});
			expect(result.notices.some(n => n.includes("managed identity settings are invalid"))).toBe(true);
			expect(Bun.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
			else Bun.env.AWS_BEARER_TOKEN_BEDROCK = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces BOTH the Entra and Claude errors when tenantId and baseUrl are each malformed", async () => {
		// Malformed tenantId (Entra resolve throws) AND bad Claude baseUrl
		// (applyDefaults' resolve throws). The user must see both, not just the
		// Entra one — the catch path must not drop applied.configError.
		const previous = Bun.env.AWS_BEARER_TOKEN_BEDROCK;
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-key";
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-startup-"));
		try {
			const store = new CoreforgeIdentityStore(path.join(dir, "agent.db"));
			store.setProfile({
				tenantId: TENANT_ID,
				objectId: "99999999-8888-4777-a666-555555555544",
				homeAccountId: `99999999-8888-4777-a666-555555555544.${TENANT_ID}`,
				username: "aidan@coreforcetech.com",
				displayName: "Aidan Artherton",
				givenName: "Aidan",
				familyName: "Artherton",
				email: "aidan@coreforcetech.com",
				authorityHost: "login.microsoftonline.com",
				authenticatedAt: 1_700_000_000_000,
				updatedAt: 1_700_000_000_000,
			});
			store.setTokenCache("opaque");
			const settings = Settings.isolated({
				"identity.entra.enabled": true,
				"identity.entra.tenantId": "not-a-valid-uuid",
				"identity.entra.clientId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				"identity.entra.authorityHost": "login.microsoftonline.com",
				"identity.aws.profile": "model-inference",
				"identity.aws.region": "us-east-1",
				"identity.claude.workspaceId": "wrkspc_test",
				"identity.claude.baseUrl": "https://not-the-gateway.example.com",
			});
			const result = await ensureCoreforgeIdentityAtStartup(settings, {
				interactive: false,
				createStore: () => store,
			});
			expect(result.notices.some(n => n.includes("tenant ID"))).toBe(true);
			expect(result.notices.some(n => n.includes("Invalid managed Claude Platform on AWS URL"))).toBe(true);
			expect(Bun.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
		} finally {
			if (previous === undefined) delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
			else Bun.env.AWS_BEARER_TOKEN_BEDROCK = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces a notice (not silent) when a signed-in identity has a bad managed Claude baseUrl", async () => {
		const previous = Bun.env.AWS_BEARER_TOKEN_BEDROCK;
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-key";
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-startup-"));
		try {
			const store = new CoreforgeIdentityStore(path.join(dir, "agent.db"));
			store.setProfile({
				tenantId: TENANT_ID,
				objectId: "99999999-8888-4777-a666-555555555544",
				homeAccountId: `99999999-8888-4777-a666-555555555544.${TENANT_ID}`,
				username: "aidan@coreforcetech.com",
				displayName: "Aidan Artherton",
				givenName: "Aidan",
				familyName: "Artherton",
				email: "aidan@coreforcetech.com",
				authorityHost: "login.microsoftonline.com",
				authenticatedAt: 1_700_000_000_000,
				updatedAt: 1_700_000_000_000,
			});
			store.setTokenCache("opaque");
			const settings = Settings.isolated({
				"identity.entra.enabled": true,
				"identity.entra.tenantId": TENANT_ID,
				"identity.entra.clientId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				"identity.entra.authorityHost": "login.microsoftonline.com",
				"identity.aws.profile": "model-inference",
				"identity.aws.region": "us-east-1",
				"identity.claude.workspaceId": "wrkspc_test",
				"identity.claude.baseUrl": "https://not-the-gateway.example.com",
			});
			const result = await ensureCoreforgeIdentityAtStartup(settings, {
				interactive: false,
				createStore: () => store,
			});
			// Auth was cleared AND the reason is surfaced — never a silent failure.
			expect(Bun.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
			expect(result.notices.some(n => n.includes("Invalid managed Claude Platform on AWS URL"))).toBe(true);
			// The "authoritative / set enabled:false" suppression notice must NOT
			// fire here — it would contradict the "settings invalid" notice.
			expect(result.notices.some(n => n.includes("managed Entra identity is authoritative"))).toBe(false);
		} finally {
			if (previous === undefined) delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
			else Bun.env.AWS_BEARER_TOKEN_BEDROCK = previous;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("injects the signed-in profile's adopted AWS identity through the store-bound loader", async () => {
		// Regression: managed .env loading must not replace the shell context
		// captured by the Coreforge launcher before engine startup.
		const previousOperationalEnv = {
			AWS_PROFILE: Bun.env.AWS_PROFILE,
			AWS_REGION: Bun.env.AWS_REGION,
			OMP_OPERATIONAL_AWS_PROFILE_SET: Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET,
			OMP_OPERATIONAL_AWS_PROFILE: Bun.env.OMP_OPERATIONAL_AWS_PROFILE,
			OMP_OPERATIONAL_AWS_REGION_SET: Bun.env.OMP_OPERATIONAL_AWS_REGION_SET,
			OMP_OPERATIONAL_AWS_REGION: Bun.env.OMP_OPERATIONAL_AWS_REGION,
		};
		const previousKey = Bun.env.AWS_BEARER_TOKEN_BEDROCK;
		Bun.env.AWS_PROFILE = "adopted-model-inference";
		Bun.env.AWS_REGION = "us-east-1";
		Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET = "1";
		Bun.env.OMP_OPERATIONAL_AWS_PROFILE = "employee-operations";
		Bun.env.OMP_OPERATIONAL_AWS_REGION_SET = "1";
		Bun.env.OMP_OPERATIONAL_AWS_REGION = "eu-west-1";
		Bun.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-stale";
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-startup-"));
		try {
			const store = new CoreforgeIdentityStore(path.join(dir, "agent.db"));
			store.setProfile({
				tenantId: TENANT_ID,
				objectId: "99999999-8888-4777-a666-555555555544",
				homeAccountId: `99999999-8888-4777-a666-555555555544.${TENANT_ID}`,
				username: "aidan@coreforcetech.com",
				displayName: "Aidan Artherton",
				givenName: "Aidan",
				familyName: "Artherton",
				email: "aidan@coreforcetech.com",
				authorityHost: "login.microsoftonline.com",
				authenticatedAt: 1_700_000_000_000,
				updatedAt: 1_700_000_000_000,
			});
			store.setTokenCache("opaque");
			// The login flow records the adopted profile name on the identity.
			store.setAwsIdentity({
				profile: "adopted-model-inference",
				region: "us-east-1",
				accountId: "891455110252",
				roleArn: "arn:test",
				validatedAt: Date.now(),
			});
			const settings = Settings.isolated({
				"identity.entra.enabled": true,
				"identity.entra.tenantId": TENANT_ID,
				"identity.entra.clientId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				"identity.entra.authorityHost": "login.microsoftonline.com",
				"identity.aws.profile": "model-inference",
				"identity.aws.region": "us-east-1",
				"identity.claude.workspaceId": "wrkspc_test",
				"identity.claude.baseUrl": "https://aws-external-anthropic.us-east-1.api.aws",
			});
			const result = await ensureCoreforgeIdentityAtStartup(settings, {
				interactive: false,
				createStore: () => store,
			});
			// The adopted inference profile is isolated while the employee's
			// operational AWS profile remains available to CLI and MCP tools.
			expect(Bun.env.AWS_PROFILE).toBe("employee-operations");
			expect(Bun.env.AWS_REGION).toBe("eu-west-1");
			expect(Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET).toBeUndefined();
			expect(Bun.env.OMP_OPERATIONAL_AWS_PROFILE).toBeUndefined();
			expect(Bun.env[AWS_MODEL_AUTH_MODE_ENV]).toBe(MANAGED_AWS_MODEL_AUTH_MODE);
			expect(Bun.env[AWS_MODEL_PROFILE_ENV]).toBe("adopted-model-inference");
			expect(Bun.env[AWS_MODEL_REGION_ENV]).toBe("us-east-1");
			expect(Bun.env.ANTHROPIC_BASE_URL).toBe("https://aws-external-anthropic.us-east-1.api.aws");
			// Stale ambient Bedrock bearer credentials cannot bypass the managed
			// profile. Startup reports that suppression instead of hiding it.
			expect(Bun.env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
			expect(
				result.notices.some(
					n => n.includes("ignored ambient credentials") && n.includes("AWS_BEARER_TOKEN_BEDROCK"),
				),
			).toBe(true);
		} finally {
			for (const [key, value] of Object.entries(previousOperationalEnv)) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
			if (previousKey === undefined) delete Bun.env.AWS_BEARER_TOKEN_BEDROCK;
			else Bun.env.AWS_BEARER_TOKEN_BEDROCK = previousKey;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("ensureCoreforgeIdentityAtStartup AWS refresh", () => {
	it("revalidates AWS SSO on interactive startup and stores the resolved profile", async () => {
		const previousProfile = Bun.env.AWS_PROFILE;
		const previousBaseUrl = Bun.env.ANTHROPIC_BASE_URL;
		const previousCapturedProfile = Bun.env.OMP_OPERATIONAL_AWS_PROFILE;
		const previousCapturedProfileState = Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET;
		Bun.env.AWS_PROFILE = "adopted-coreforge";
		Bun.env.OMP_OPERATIONAL_AWS_PROFILE = "adopted-coreforge";
		Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET = "1";
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-startup-"));
		try {
			const store = new CoreforgeIdentityStore(path.join(dir, "agent.db"));
			store.setProfile({
				tenantId: TENANT_ID,
				objectId: "99999999-8888-4777-a666-555555555544",
				homeAccountId: `99999999-8888-4777-a666-555555555544.${TENANT_ID}`,
				username: "aidan@coreforcetech.com",
				displayName: "Aidan Artherton",
				givenName: "Aidan",
				familyName: "Artherton",
				email: "aidan@coreforcetech.com",
				authorityHost: "login.microsoftonline.com",
				authenticatedAt: 1_700_000_000_000,
				updatedAt: 1_700_000_000_000,
			});
			store.setTokenCache("opaque");
			store.setAwsIdentity({
				profile: "legacy-name",
				region: "us-east-1",
				accountId: "891455110252",
				roleArn: "arn:aws:sts::891455110252:assumed-role/AdministratorAccess/aidan",
				validatedAt: 1_700_000_000_000,
			});
			const settings = Settings.isolated({
				"identity.entra.enabled": true,
				"identity.entra.tenantId": TENANT_ID,
				"identity.entra.clientId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				"identity.entra.authorityHost": "login.microsoftonline.com",
				"identity.aws.profile": "coreforge",
				"identity.aws.region": "us-east-1",
				"identity.aws.ssoStartUrl": "https://d-example.awsapps.com/start",
				"identity.aws.ssoRegion": "us-east-1",
				"identity.aws.ssoAccountId": "891455110252",
				"identity.aws.ssoRoleName": "CoreforgeModelAccess",
				"identity.claude.workspaceId": "wrkspc_test",
				"identity.claude.baseUrl": "https://aws-external-anthropic.us-east-1.api.aws",
			});
			let refreshes = 0;
			let recoveryProfile: string | undefined;
			const result = await ensureCoreforgeIdentityAtStartup(settings, {
				interactive: true,
				isTty: () => true,
				createStore: () => store,
				ensureAwsSso: async (config, constants) => {
					refreshes += 1;
					expect(config.profile).toBe("coreforge");
					expect(constants?.ssoRoleName).toBe("CoreforgeModelAccess");
					return {
						profile: "adopted-coreforge",
						region: "us-east-1",
						accountId: "891455110252",
						roleArn: "arn:aws:sts::891455110252:assumed-role/CoreforgeModelAccess/aidan",
						validatedAt: 1_700_000_200_000,
					};
				},
				installAwsRecovery: options => {
					recoveryProfile = options.awsConfig.profile;
				},
			});
			expect(refreshes).toBe(1);
			expect(result.notices).toContain(
				"Coreforge isolated its managed inference profile from operational AWS tools; local AWS settings remain authoritative.",
			);
			expect(recoveryProfile).toBe("adopted-coreforge");
			expect(Bun.env.AWS_PROFILE).toBeUndefined();
			expect(Bun.env.OMP_OPERATIONAL_AWS_PROFILE).toBeUndefined();
			expect(Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET).toBeUndefined();
			expect(Bun.env[AWS_MODEL_PROFILE_ENV]).toBe("adopted-coreforge");
			expect(Bun.env[AWS_MODEL_REGION_ENV]).toBe("us-east-1");
		} finally {
			if (previousProfile === undefined) delete Bun.env.AWS_PROFILE;
			else Bun.env.AWS_PROFILE = previousProfile;
			if (previousBaseUrl === undefined) delete Bun.env.ANTHROPIC_BASE_URL;
			else Bun.env.ANTHROPIC_BASE_URL = previousBaseUrl;
			if (previousCapturedProfile === undefined) delete Bun.env.OMP_OPERATIONAL_AWS_PROFILE;
			else Bun.env.OMP_OPERATIONAL_AWS_PROFILE = previousCapturedProfile;
			if (previousCapturedProfileState === undefined) delete Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET;
			else Bun.env.OMP_OPERATIONAL_AWS_PROFILE_SET = previousCapturedProfileState;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
