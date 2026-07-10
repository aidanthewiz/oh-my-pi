import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import {
	type AwsCredentialRecoveryHandler,
	type AwsCredentialRecoveryRequest,
	clearAwsCredentialCache,
	setAwsCredentialRecoveryHandler,
} from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { installCoreforgeAwsRecovery } from "@oh-my-pi/pi-coding-agent/identity/aws-recovery";
import { CoreforgeIdentityStore } from "@oh-my-pi/pi-coding-agent/identity/coreforge-store";
import { ensureCoreforgeIdentityAtStartup } from "@oh-my-pi/pi-coding-agent/identity/startup";

// An AWS IAM Identity Center session that expires *during* a conversation. The
// managed profile is validated at startup only, so the mid-session expiry used
// to surface as `Connection error.` on every attempt (the SigV4 fetch wrapper
// throws while resolving credentials, and the Anthropic client wrapped that
// throw as a network fault) until the user opened a new window. The same open
// conversation must instead re-authenticate once and complete its request.

const TENANT_ID = "11111111-2222-4333-8444-555555555555";
const SSO_START_URL = "https://d-example.awsapps.com/start";
const AWS_PROFILE = "coreforge";
// Startup clears the whole managed model-auth family process-locally, so every
// name it touches is saved and restored around the test.
const ENV_KEYS = [
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_ROLE_ARN",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
	"AWS_BEARER_TOKEN_BEDROCK",
	"HOME",
	"USERPROFILE",
	"OPENAI_API_KEY",
	"OPENAI_AWS_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_WORKSPACE_ID",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AWS_API_KEY",
	"ANTHROPIC_AWS_WORKSPACE_ID",
	"ANTHROPIC_AWS_INFERENCE_GEO",
] as const;

const savedEnv = new Map<string, string | undefined>();
let home: string;

async function ssoCacheFile(): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(SSO_START_URL));
	const hash = Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
	return path.join(home, ".aws", "sso", "cache", `${hash}.json`);
}

async function writeSsoToken(expiresAt: number): Promise<void> {
	const file = await ssoCacheFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			accessToken: `sso-access-token-${expiresAt}`,
			expiresAt: new Date(expiresAt).toISOString(),
			startUrl: SSO_START_URL,
			region: "us-east-1",
		}),
	);
}

function identitySettings(): Settings {
	return Settings.isolated({
		"identity.entra.enabled": true,
		"identity.entra.tenantId": TENANT_ID,
		"identity.entra.clientId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		"identity.entra.authorityHost": "login.microsoftonline.com",
		"identity.aws.profile": AWS_PROFILE,
		"identity.aws.region": "us-east-1",
		"identity.aws.ssoStartUrl": SSO_START_URL,
		"identity.aws.ssoRegion": "us-east-1",
		"identity.aws.ssoAccountId": "891455110252",
		"identity.aws.ssoRoleName": "CoreforgeModelAccess",
		"identity.claude.workspaceId": "wrkspc_test",
		"identity.claude.baseUrl": "https://aws-external-anthropic.us-east-1.api.aws",
	});
}

/**
 * Every consumer (startup, and the recovery handler it installs) opens its own
 * handle and closes it, mirroring production, so the factory hands out a new
 * store on the shared fixture path each time.
 */
function openStore(): CoreforgeIdentityStore {
	return new CoreforgeIdentityStore(path.join(home, "agent.db"));
}

function seedSignedInProfile(): void {
	const store = openStore();
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
	store.close();
}

function awsClaudeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic-aws",
		baseUrl: "https://aws-external-anthropic.us-east-1.api.aws",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

const conversation: Context = {
	messages: [{ role: "user", content: "still there?", timestamp: Date.now() }],
};

function assistantSseResponse(text: string): Response {
	const events: Array<Record<string, unknown> & { type: string }> = [
		{
			type: "message_start",
			message: {
				id: "msg_recovered",
				usage: { input_tokens: 9, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface WireTraffic {
	ssoRoleCredentialCalls: number;
	gatewayCalls: number;
	fetch: FetchImpl;
}

/**
 * Fake wire: the SSO portal mints role credentials for whichever bearer token
 * the cache currently holds, and the Claude gateway answers one assistant turn.
 */
function wireTraffic(): WireTraffic {
	const traffic: WireTraffic = {
		ssoRoleCredentialCalls: 0,
		gatewayCalls: 0,
		fetch: async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("portal.sso.")) {
				traffic.ssoRoleCredentialCalls += 1;
				const bearer = new Headers(init?.headers).get("x-amz-sso_bearer_token") ?? "";
				return new Response(
					JSON.stringify({
						roleCredentials: {
							accessKeyId: "ASIARECOVERED000000",
							secretAccessKey: `secret-for-${bearer}`,
							sessionToken: "session-token",
							expiration: Date.now() + 3_600_000,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			traffic.gatewayCalls += 1;
			return assistantSseResponse("still here");
		},
	};
	return traffic;
}

beforeEach(async () => {
	for (const key of ENV_KEYS) {
		savedEnv.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
	home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-midsession-"));
	Bun.env.HOME = home;
	Bun.env.USERPROFILE = home;
	Bun.env.AWS_EC2_METADATA_DISABLED = "true";
	// Managed startup clears `AWS_CONFIG_FILE`, so the fixture profile lives at
	// the HOME-derived default path. Legacy `sso_start_url` shape: resolution
	// reads the SSO token cache directly, which is where a mid-session expiry
	// becomes observable.
	fs.mkdirSync(path.join(home, ".aws"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".aws", "config"),
		`[profile ${AWS_PROFILE}]\n` +
			`sso_start_url = ${SSO_START_URL}\n` +
			"sso_region = us-east-1\n" +
			"sso_account_id = 891455110252\n" +
			"sso_role_name = CoreforgeModelAccess\n" +
			"region = us-east-1\n",
	);
	await writeSsoToken(Date.now() + 3_600_000);
	clearAwsCredentialCache();
});

afterEach(() => {
	setAwsCredentialRecoveryHandler(undefined);
	clearAwsCredentialCache();
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	savedEnv.clear();
	fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Startup deliberately clears `AWS_CONFIG_FILE` (an ambient redirect would
 * shadow the managed profile), so the fixture redirect is (re-)applied for the
 * conversation phase. `~/.aws/sso/cache` already follows `HOME`.
 */
function pointAwsConfigAtFixture(): void {
	Bun.env.AWS_CONFIG_FILE = path.join(home, ".aws", "config");
	Bun.env.AWS_SHARED_CREDENTIALS_FILE = path.join(home, ".aws", "credentials");
}

function expiredRecoveryRequest(profile = AWS_PROFILE): AwsCredentialRecoveryRequest {
	const error = new AIError.AwsCredentialsError("AWS SSO session expired", "sso-token-expired");
	return { profile, region: "us-east-1", kind: error.kind, error };
}

describe("mid-session AWS session expiry", () => {
	it("re-authenticates in place and completes the in-flight conversation request", async () => {
		seedSignedInProfile();
		let awsChecks = 0;
		let reauthentications = 0;
		const startup = await ensureCoreforgeIdentityAtStartup(identitySettings(), {
			interactive: true,
			isTty: () => true,
			createStore: openStore,
			ensureAwsSso: async config => {
				awsChecks += 1;
				if (awsChecks > 1) {
					reauthentications += 1;
					await writeSsoToken(Date.now() + 3_600_000);
				}
				return {
					profile: config.profile,
					region: config.region,
					accountId: "891455110252",
					roleArn: "arn:aws:sts::891455110252:assumed-role/CoreforgeModelAccess/aidan",
					validatedAt: Date.now(),
				};
			},
		});
		expect(startup.notices.some(notice => notice.includes("sign-in"))).toBe(false);
		expect(awsChecks).toBe(1);
		expect(reauthentications).toBe(0);

		await writeSsoToken(Date.now() - 60_000);
		clearAwsCredentialCache();
		pointAwsConfigAtFixture();

		const traffic = wireTraffic();
		const result = await streamAnthropic(awsClaudeModel(), conversation, {
			apiKey: "<authenticated>",
			fetch: traffic.fetch,
		}).result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "text", text: "still here" });
		expect(awsChecks).toBe(2);
		expect(reauthentications).toBe(1);
		expect(traffic.gatewayCalls).toBe(1);
		expect(traffic.ssoRoleCredentialCalls).toBe(1);
		const store = openStore();
		expect(store.getProfile()?.aws?.profile).toBe(AWS_PROFILE);
		store.close();
	});
	it("reports the actionable auth failure instead of a connection error when re-authentication fails", async () => {
		seedSignedInProfile();
		let awsChecks = 0;
		const startup = await ensureCoreforgeIdentityAtStartup(identitySettings(), {
			interactive: true,
			isTty: () => true,
			createStore: openStore,
			ensureAwsSso: async config => {
				awsChecks += 1;
				if (awsChecks > 1) throw new Error("AWS SSO sign-in failed for profile coreforge");
				return {
					profile: config.profile,
					region: config.region,
					accountId: "891455110252",
					roleArn: "arn:aws:sts::891455110252:assumed-role/CoreforgeModelAccess/aidan",
					validatedAt: Date.now(),
				};
			},
		});
		expect(startup.notices.some(notice => notice.includes("sign-in"))).toBe(false);
		expect(awsChecks).toBe(1);

		await writeSsoToken(Date.now() - 60_000);
		clearAwsCredentialCache();
		pointAwsConfigAtFixture();

		const traffic = wireTraffic();
		const result = await streamAnthropic(awsClaudeModel(), conversation, {
			apiKey: "<authenticated>",
			fetch: traffic.fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("has expired");
		expect(result.errorMessage).not.toContain("Connection error");
		expect(awsChecks).toBe(2);
		expect(traffic.gatewayCalls).toBe(0);
	});

	it("does not open an AWS sign-in flow for non-interactive callers", async () => {
		seedSignedInProfile();
		let installs = 0;
		const startup = await ensureCoreforgeIdentityAtStartup(identitySettings(), {
			interactive: false,
			createStore: openStore,
			installAwsRecovery: () => {
				installs += 1;
			},
		});
		expect(startup.notices.some(notice => notice.startsWith("AWS sign-in failed:"))).toBe(false);
		expect(installs).toBe(0);
	});
	it("does not arm mid-session recovery when startup validation fails", async () => {
		seedSignedInProfile();
		let installs = 0;
		const startup = await ensureCoreforgeIdentityAtStartup(identitySettings(), {
			interactive: true,
			isTty: () => true,
			createStore: openStore,
			ensureAwsSso: async () => {
				throw new Error("AWS SSO sign-in failed for profile coreforge");
			},
			installAwsRecovery: () => {
				installs += 1;
			},
		});
		expect(startup.notices).toContain(
			"AWS sign-in failed: AWS SSO sign-in failed for profile coreforge. Retry with `coreforge identity login`.",
		);
		expect(installs).toBe(0);
	});
	it("ignores recovery requests for profiles outside the managed identity", async () => {
		let handler: AwsCredentialRecoveryHandler | undefined;
		let signIns = 0;
		installCoreforgeAwsRecovery({
			awsConfig: { profile: AWS_PROFILE, region: "us-east-1" },
			ensureAwsSso: async () => {
				signIns += 1;
				throw new Error("unexpected sign-in");
			},
			setHandler: value => {
				handler = value;
			},
		});
		expect(handler).toBeDefined();
		if (!handler) throw new Error("Recovery handler was not installed");

		expect(await handler(expiredRecoveryRequest("other-profile"))).toBe(false);
		expect(signIns).toBe(0);
	});

	it("stops waiting when an AWS CLI child ignores graceful termination", async () => {
		let handler: AwsCredentialRecoveryHandler | undefined;
		installCoreforgeAwsRecovery({
			awsConfig: { profile: AWS_PROFILE, region: "us-east-1" },
			recoveryTimeoutMs: 25,
			terminationGraceMs: 25,
			ensureAwsSso: async (_config, _constants, _onProgress, dependencies) => {
				const run = dependencies?.run;
				if (!run) throw new Error("AWS command runner was not installed");
				await run(
					[
						process.execPath,
						"-e",
						'process.on("SIGTERM", () => {}); require("node:net").createServer().listen(0);',
					],
					true,
				);
				throw new Error("AWS command runner unexpectedly completed");
			},
			setHandler: value => {
				handler = value;
			},
		});
		expect(handler).toBeDefined();
		if (!handler) throw new Error("Recovery handler was not installed");

		await expect(handler(expiredRecoveryRequest())).rejects.toThrow(/timed out/);
	});
});
