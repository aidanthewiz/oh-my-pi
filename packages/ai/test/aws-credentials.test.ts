import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AWS_MODEL_AUTH_MODE_ENV,
	AWS_MODEL_PROFILE_ENV,
	AWS_MODEL_REGION_ENV,
	MANAGED_AWS_MODEL_AUTH_MODE,
} from "@oh-my-pi/pi-ai";
import {
	clearAwsCredentialCache,
	resolveAwsCredentials,
	setAwsCredentialRecoveryHandler,
	tokenizeCredentialProcessCommand,
} from "@oh-my-pi/pi-ai/providers/aws-credentials";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { removeWithRetries } from "../../utils/src/temp";
import { waitForDelayOrAbort } from "./helpers";

// Process-backed credential integration coverage. Drives real `Bun.spawn`
// calls against fixture scripts so credential_process and modern SSO export
// envelopes, exit handling, abort propagation, and caching are exercised
// end-to-end.

const ENV_KEYS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_SDK_LOAD_CONFIG",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_EC2_METADATA_DISABLED",
	AWS_MODEL_AUTH_MODE_ENV,
	AWS_MODEL_PROFILE_ENV,
	AWS_MODEL_REGION_ENV,
	"PATH",
	"HOME",
	"USERPROFILE",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_ROLE_ARN",
	"AWS_ROLE_SESSION_NAME",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
] as const;

function quoteForConfig(p: string): string {
	if (!/[\s"]/.test(p)) return p;
	// Wrap in double quotes; our tokenizer preserves backslashes so Windows
	// paths survive without further escaping.
	return `"${p.replace(/(["])/g, "\\$1")}"`;
}

const MODERN_SSO_CONFIG = `sso_session = managed-session
sso_account_id = 111122223333
sso_role_name = ModelAccess

[sso-session managed-session]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access`;

describe("tokenizeCredentialProcessCommand", () => {
	test("splits on whitespace", () => {
		expect(tokenizeCredentialProcessCommand("/bin/auth --json")).toEqual(["/bin/auth", "--json"]);
	});

	test("collapses runs of whitespace", () => {
		expect(tokenizeCredentialProcessCommand("  a\tb \n c")).toEqual(["a", "b", "c"]);
	});

	test("double quotes preserve Windows backslashes", () => {
		expect(tokenizeCredentialProcessCommand(`"C:\\Program Files\\auth\\tool.exe" --json`)).toEqual([
			"C:\\Program Files\\auth\\tool.exe",
			"--json",
		]);
	});

	test('double quotes still escape $ ` " and \\', () => {
		expect(tokenizeCredentialProcessCommand(`"a\\"b" "\\$x" "\\\\n"`)).toEqual([`a"b`, "$x", "\\n"]);
	});

	test("single quotes are fully literal", () => {
		expect(tokenizeCredentialProcessCommand(`'C:\\path with spaces\\bin' --x`)).toEqual([
			"C:\\path with spaces\\bin",
			"--x",
		]);
	});

	test("backslash outside quotes escapes the next character", () => {
		expect(tokenizeCredentialProcessCommand(`a\\ b c`)).toEqual(["a b", "c"]);
	});

	test("rejects unterminated quotes", () => {
		expect(() => tokenizeCredentialProcessCommand(`"unterminated`)).toThrow(/unterminated/);
		expect(() => tokenizeCredentialProcessCommand(`'half`)).toThrow(/unterminated/);
	});

	test("empty input yields no tokens", () => {
		expect(tokenizeCredentialProcessCommand("")).toEqual([]);
		expect(tokenizeCredentialProcessCommand("   \t  ")).toEqual([]);
	});
});

describe("resolveAwsCredentials", () => {
	let tmp: string;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const k of ENV_KEYS) {
			saved.set(k, Bun.env[k]);
			delete Bun.env[k];
		}
		Bun.env.AWS_EC2_METADATA_DISABLED = "true";
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-credproc-"));
		clearAwsCredentialCache();
		Bun.env.HOME = tmp;
		Bun.env.USERPROFILE = tmp;
	});

	afterEach(async () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete Bun.env[k];
			else Bun.env[k] = v;
		}
		saved.clear();
		await removeWithRetries(tmp);
		clearAwsCredentialCache();
		setAwsCredentialRecoveryHandler(undefined);
	});

	async function writeFixture(name: string, body: string): Promise<string> {
		const p = path.join(tmp, name);
		await Bun.write(p, body);
		return p;
	}

	async function installFakeAws(body: string): Promise<void> {
		const script = await writeFixture("fake-aws.js", body);
		const isWindows = process.platform === "win32";
		const executable = await writeFixture(
			isWindows ? "aws.cmd" : "aws",
			isWindows
				? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
				: `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
		);
		if (!isWindows) await fs.chmod(executable, 0o755);
		Bun.env.PATH = `${tmp}${path.delimiter}${saved.get("PATH") ?? ""}`;
	}

	async function writeConfig(profile: string, line: string): Promise<void> {
		const cfg = path.join(tmp, "config");
		await Bun.write(cfg, `[profile ${profile}]\n${line}\n`);
		Bun.env.AWS_CONFIG_FILE = cfg;
		// Point shared credentials at a known-empty file so static-creds resolution
		// definitely misses.
		const sharedPath = path.join(tmp, "credentials");
		await Bun.write(sharedPath, "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = sharedPath;
	}

	async function writeDefaultConfig(profile: string, line: string): Promise<void> {
		const awsDir = path.join(tmp, ".aws");
		await fs.mkdir(awsDir, { recursive: true });
		await Bun.write(path.join(awsDir, "config"), `[profile ${profile}]\n${line}\n`);
		await Bun.write(path.join(awsDir, "credentials"), "");
	}

	async function writeRawConfig(body: string): Promise<void> {
		const cfg = path.join(tmp, "config");
		await Bun.write(cfg, body);
		Bun.env.AWS_CONFIG_FILE = cfg;
		const sharedPath = path.join(tmp, "credentials");
		await Bun.write(sharedPath, "");
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = sharedPath;
	}

	/** Mock STS: web-identity + AssumeRole exchanges, capturing each request body. */
	function stsMock(captured: Array<Record<string, string>>): FetchImpl {
		const decoder = new TextDecoder();
		return Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const raw = typeof init?.body === "string" ? init.body : decoder.decode(init?.body as Uint8Array);
				const params = Object.fromEntries(new URLSearchParams(raw));
				captured.push(params);
				const tag = params.Action === "AssumeRoleWithWebIdentity" ? "AssumeRoleWithWebIdentity" : "AssumeRole";
				const akid = params.Action === "AssumeRoleWithWebIdentity" ? "AKIABASE" : "AKIAFINAL";
				return new Response(
					`<${tag}Response><${tag}Result><Credentials>
						<AccessKeyId>${akid}</AccessKeyId><SecretAccessKey>${akid}-secret</SecretAccessKey>
						<SessionToken>${akid}-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration>
					</Credentials></${tag}Result></${tag}Response>`,
					{ headers: { "content-type": "text/xml" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);
	}

	test("parses a Version 1 envelope and honors Expiration", async () => {
		const script = await writeFixture(
			"good.js",
			`console.log(JSON.stringify({Version:1,AccessKeyId:"AKIATEST",SecretAccessKey:"sek",SessionToken:"tok",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig("good", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);

		const creds = await resolveAwsCredentials({ profile: "good", region: "us-east-1" });
		expect(creds.accessKeyId).toBe("AKIATEST");
		expect(creds.secretAccessKey).toBe("sek");
		expect(creds.sessionToken).toBe("tok");
		expect(creds.expiresAt).toBe(Date.parse("2099-01-01T00:00:00Z"));
	});

	test("managed model auth ignores operational credentials, explicit options, and config redirects", async () => {
		await writeConfig(
			"model-inference",
			"aws_access_key_id = REDIRECTEDKEY\naws_secret_access_key = redirected-secret",
		);
		await writeDefaultConfig("model-inference", "aws_access_key_id = MODELKEY\naws_secret_access_key = model-secret");
		Bun.env[AWS_MODEL_AUTH_MODE_ENV] = MANAGED_AWS_MODEL_AUTH_MODE;
		Bun.env[AWS_MODEL_PROFILE_ENV] = "model-inference";
		Bun.env[AWS_MODEL_REGION_ENV] = "us-east-1";
		Bun.env.AWS_PROFILE = "employee-operations";
		Bun.env.AWS_REGION = "eu-west-1";
		Bun.env.AWS_ACCESS_KEY_ID = "OPERATIONALKEY";
		Bun.env.AWS_SECRET_ACCESS_KEY = "operational-secret";

		const creds = await resolveAwsCredentials({ profile: "employee-operations", region: "eu-west-1" });
		expect(creds.accessKeyId).toBe("MODELKEY");
		expect(creds.secretAccessKey).toBe("model-secret");
	});

	test("managed role chains reject ambient credential_source credentials", async () => {
		await writeDefaultConfig(
			"model-inference",
			"role_arn = arn:aws:iam::111122223333:role/model\ncredential_source = Environment",
		);
		Bun.env[AWS_MODEL_AUTH_MODE_ENV] = MANAGED_AWS_MODEL_AUTH_MODE;
		Bun.env[AWS_MODEL_PROFILE_ENV] = "model-inference";
		Bun.env[AWS_MODEL_REGION_ENV] = "us-east-1";
		Bun.env.AWS_ACCESS_KEY_ID = "OPERATIONALKEY";
		Bun.env.AWS_SECRET_ACCESS_KEY = "operational-secret";

		await expect(resolveAwsCredentials()).rejects.toThrow(/unavailable under managed model authentication/);
	});

	test("managed credential processes do not inherit operational AWS settings", async () => {
		const childEnvPath = path.join(tmp, "child-env.json");
		const script = await writeFixture(
			"managed-process.js",
			`await Bun.write(${JSON.stringify(childEnvPath)}, JSON.stringify({
				profile: Bun.env.AWS_PROFILE ?? null,
				region: Bun.env.AWS_REGION ?? null,
				accessKey: Bun.env.AWS_ACCESS_KEY_ID ?? null,
				config: Bun.env.AWS_CONFIG_FILE ?? null,
				credentials: Bun.env.AWS_SHARED_CREDENTIALS_FILE ?? null
			}));
			console.log(JSON.stringify({Version:1,AccessKeyId:"MODELPROCESSKEY",SecretAccessKey:"model-process-secret"}));`,
		);
		await writeConfig("model-inference", "aws_access_key_id = WRONGKEY\naws_secret_access_key = wrong-secret");
		await writeDefaultConfig(
			"model-inference",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);
		Bun.env[AWS_MODEL_AUTH_MODE_ENV] = MANAGED_AWS_MODEL_AUTH_MODE;
		Bun.env[AWS_MODEL_PROFILE_ENV] = "model-inference";
		Bun.env[AWS_MODEL_REGION_ENV] = "us-east-1";
		Bun.env.AWS_PROFILE = "employee-operations";
		Bun.env.AWS_REGION = "eu-west-1";
		Bun.env.AWS_ACCESS_KEY_ID = "OPERATIONALKEY";
		Bun.env.AWS_SECRET_ACCESS_KEY = "operational-secret";

		const creds = await resolveAwsCredentials();
		expect(creds.accessKeyId).toBe("MODELPROCESSKEY");
		expect(JSON.parse(await Bun.file(childEnvPath).text())).toEqual({
			profile: null,
			region: null,
			accessKey: null,
			config: null,
			credentials: null,
		});
	});

	test("caches by profile so the helper is only invoked once", async () => {
		const counterPath = path.join(tmp, "calls.txt");
		const script = await writeFixture(
			"counted.js",
			`const fs=require("node:fs");
			 const prev=fs.existsSync(${JSON.stringify(counterPath)})?Number(fs.readFileSync(${JSON.stringify(counterPath)},"utf8")):0;
			 fs.writeFileSync(${JSON.stringify(counterPath)},String(prev+1));
			 console.log(JSON.stringify({Version:1,AccessKeyId:"AKIA",SecretAccessKey:"s",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig(
			"counted",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);

		await resolveAwsCredentials({ profile: "counted" });
		await resolveAwsCredentials({ profile: "counted" });
		const calls = Number(await Bun.file(counterPath).text());
		expect(calls).toBe(1);
	});

	test("rejects unsupported envelope versions", async () => {
		const script = await writeFixture(
			"badversion.js",
			`console.log(JSON.stringify({Version:2,AccessKeyId:"a",SecretAccessKey:"b"}));`,
		);
		await writeConfig("badv", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		await expect(resolveAwsCredentials({ profile: "badv" })).rejects.toThrow(/unsupported Version 2/);
	});

	test("surfaces stderr on non-zero exit", async () => {
		const script = await writeFixture("fail.js", `process.stderr.write("auth helper broke");process.exit(7);`);
		await writeConfig(
			"failing",
			`credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`,
		);
		await expect(resolveAwsCredentials({ profile: "failing" })).rejects.toThrow(/exited 7.*auth helper broke/);
	});

	test("aborts a long-running helper when the caller's signal fires", async () => {
		const script = await writeFixture("hang.js", `setTimeout(()=>{},60_000);`);
		await writeConfig("hangs", `credential_process = ${quoteForConfig(process.execPath)} ${quoteForConfig(script)}`);
		const ctrl = new AbortController();
		const promise = resolveAwsCredentials({ profile: "hangs", signal: ctrl.signal });
		setTimeout(() => ctrl.abort(new Error("test abort")), 50);
		await expect(promise).rejects.toBeDefined();
	});

	test("uses AWS CLI token refresh for a modern SSO session", async () => {
		const argvPath = path.join(tmp, "aws-argv.json");
		await installFakeAws(
			`await Bun.write(${JSON.stringify(argvPath)}, JSON.stringify(Bun.argv.slice(2)));
console.log(JSON.stringify({Version:1,AccessKeyId:"ASIAREFRESHED",SecretAccessKey:"secret",SessionToken:"session",Expiration:"2099-01-01T00:00:00Z"}));`,
		);
		await writeConfig("managed", MODERN_SSO_CONFIG);

		const creds = await resolveAwsCredentials({ profile: "managed", region: "us-east-1" });

		expect(creds).toEqual({
			accessKeyId: "ASIAREFRESHED",
			secretAccessKey: "secret",
			sessionToken: "session",
			expiresAt: Date.parse("2099-01-01T00:00:00Z"),
		});
		expect(JSON.parse(await Bun.file(argvPath).text())).toEqual([
			"configure",
			"export-credentials",
			"--profile",
			"managed",
			"--format",
			"process",
		]);
	});

	test("falls back to the cached token exchange when AWS CLI is unavailable", async () => {
		Bun.env.PATH = tmp;
		await writeConfig("managed", MODERN_SSO_CONFIG);
		const cacheDir = path.join(tmp, ".aws", "sso", "cache");
		await fs.mkdir(cacheDir, { recursive: true });
		const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode("managed-session"));
		const hash = Buffer.from(digest).toString("hex");
		await Bun.write(
			path.join(cacheDir, `${hash}.json`),
			JSON.stringify({
				accessToken: "cached-token",
				expiresAt: "2099-01-01T00:00:00Z",
				startUrl: "https://example.awsapps.com/start",
				region: "us-east-1",
			}),
		);

		const creds = await resolveAwsCredentials({
			profile: "managed",
			fetch: async (_input, init) => {
				expect(new Headers(init?.headers).get("x-amz-sso_bearer_token")).toBe("cached-token");
				return Response.json({
					roleCredentials: {
						accessKeyId: "ASIAFALLBACK",
						secretAccessKey: "secret",
						sessionToken: "session",
						expiration: Date.parse("2099-01-01T00:00:00Z"),
					},
				});
			},
		});

		expect(creds.accessKeyId).toBe("ASIAFALLBACK");
	});

	test("does not fall back when AWS CLI credential export fails", async () => {
		await installFakeAws(`process.stderr.write("AccessDenied: role is not assigned"); process.exit(17);`);
		await writeConfig("managed", MODERN_SSO_CONFIG);

		await expect(resolveAwsCredentials({ profile: "managed" })).rejects.toMatchObject({ kind: "sso-role" });
	});

	test("classifies an exhausted AWS CLI SSO session as an expired token", async () => {
		await installFakeAws(`process.stderr.write("The SSO session has expired and refresh failed"); process.exit(1);`);
		await writeConfig("managed", MODERN_SSO_CONFIG);

		await expect(resolveAwsCredentials({ profile: "managed" })).rejects.toMatchObject({
			kind: "sso-token-expired",
		});
	});
	test("clears recovery cooldown after a non-auth post-login failure", async () => {
		const counterPath = path.join(tmp, "recovery-calls.txt");
		await installFakeAws(
			`const fs=require("node:fs");
			 const prev=fs.existsSync(${JSON.stringify(counterPath)})?Number(fs.readFileSync(${JSON.stringify(counterPath)},"utf8")):0;
			 fs.writeFileSync(${JSON.stringify(counterPath)},String(prev+1));
			 process.stderr.write(prev===0?"The SSO session has expired and refresh failed":"AccessDenied: role is not assigned");
			 process.exit(1);`,
		);
		await writeConfig("managed", MODERN_SSO_CONFIG);
		let recoveries = 0;
		setAwsCredentialRecoveryHandler(() => {
			recoveries += 1;
			return true;
		});

		await expect(resolveAwsCredentials({ profile: "managed" })).rejects.toMatchObject({ kind: "sso-role" });
		expect(recoveries).toBe(1);

		await installFakeAws(`process.stderr.write("The SSO session has expired and refresh failed"); process.exit(1);`);
		await expect(resolveAwsCredentials({ profile: "managed" })).rejects.toMatchObject({
			kind: "sso-token-expired",
		});
		expect(recoveries).toBe(2);
	});

	test("resolves ECS container credentials with the authorization token", async () => {
		const credentialsPath = path.join(tmp, "empty-credentials");
		const configPath = path.join(tmp, "empty-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/test";
		Bun.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = "container-auth";
		const capture: { url?: string; authorization?: string | null } = {};
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				capture.url = String(input);
				capture.authorization = new Headers(init?.headers).get("authorization");
				return Response.json({
					AccessKeyId: "AKIAECS",
					SecretAccessKey: "ecs-secret",
					Token: "ecs-token",
					Expiration: "2099-01-01T00:00:00Z",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		const credentials = await resolveAwsCredentials({ fetch: fetchImpl });

		expect(capture.url).toBe("http://169.254.170.2/v2/credentials/test");
		expect(capture.authorization).toBe("container-auth");
		expect(credentials).toEqual({
			accessKeyId: "AKIAECS",
			secretAccessKey: "ecs-secret",
			sessionToken: "ecs-token",
			expiresAt: Date.parse("2099-01-01T00:00:00Z"),
		});
	});

	test("rejects dynamic container credentials without expiration", async () => {
		const credentialsPath = path.join(tmp, "empty-dynamic-credentials");
		const configPath = path.join(tmp, "empty-dynamic-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/rotating";
		let calls = 0;
		const fetchImpl: FetchImpl = Object.assign(
			async () => {
				calls++;
				return Response.json({
					AccessKeyId: "AKIAECS",
					SecretAccessKey: "ecs-secret",
					Token: "ecs-token",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		await expect(resolveAwsCredentials({ fetch: fetchImpl })).rejects.toThrow(/missing or invalid Expiration/);
		expect(calls).toBe(1);
	});

	test("rejects container relative URIs that can replace the metadata host", async () => {
		const credentialsPath = path.join(tmp, "empty-relative-credentials");
		const configPath = path.join(tmp, "empty-relative-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "//attacker.invalid/credentials";

		await expect(resolveAwsCredentials()).rejects.toThrow(/single-host absolute path/);
	});

	test("honors AWS_EC2_METADATA_SERVICE_ENDPOINT for instance-role credentials", async () => {
		const credentialsPath = path.join(tmp, "empty-imds-credentials");
		const configPath = path.join(tmp, "empty-imds-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_EC2_METADATA_DISABLED = "false";
		Bun.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = "http://imds.internal:8181/";
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				const url = String(input);
				requestedUrls.push(url);
				if (url.endsWith("/latest/api/token")) return new Response("imds-token");
				if (url.endsWith("/latest/meta-data/iam/security-credentials/")) return new Response("test-role");
				return Response.json({
					AccessKeyId: "AKIAIMDS",
					SecretAccessKey: "imds-secret",
					Token: "imds-session",
					Expiration: "2099-01-01T00:00:00Z",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		const credentials = await resolveAwsCredentials({ fetch: fetchImpl });

		expect(requestedUrls).toEqual([
			"http://imds.internal:8181/latest/api/token",
			"http://imds.internal:8181/latest/meta-data/iam/security-credentials/",
			"http://imds.internal:8181/latest/meta-data/iam/security-credentials/test-role",
		]);
		expect(credentials.accessKeyId).toBe("AKIAIMDS");
		expect(credentials.sessionToken).toBe("imds-session");
	});

	test("uses the IPv6 IMDS endpoint when endpoint mode requests it", async () => {
		const credentialsPath = path.join(tmp, "empty-ipv6-imds-credentials");
		const configPath = path.join(tmp, "empty-ipv6-imds-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_EC2_METADATA_DISABLED = "false";
		Bun.env.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE = "IPv6";
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				const url = String(input);
				requestedUrls.push(url);
				if (url.endsWith("/latest/api/token")) return new Response("imds-token");
				if (url.endsWith("/latest/meta-data/iam/security-credentials/")) return new Response("test-role");
				return Response.json({
					AccessKeyId: "AKIAIMDS",
					SecretAccessKey: "imds-secret",
					Token: "imds-session",
					Expiration: "2099-01-01T00:00:00Z",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		await resolveAwsCredentials({ fetch: fetchImpl });

		expect(requestedUrls[0]).toBe("http://[fd00:ec2::254]/latest/api/token");
	});

	test("gives each IMDS request its own timeout budget", async () => {
		const credentialsPath = path.join(tmp, "empty-slow-imds-credentials");
		const configPath = path.join(tmp, "empty-slow-imds-config");
		await Promise.all([Bun.write(credentialsPath, ""), Bun.write(configPath, "")]);
		Bun.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
		Bun.env.AWS_CONFIG_FILE = configPath;
		Bun.env.AWS_EC2_METADATA_DISABLED = "false";
		Bun.env.AWS_EC2_METADATA_SERVICE_ENDPOINT = "http://slow-imds.internal";
		let calls = 0;
		const fetchImpl: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				await waitForDelayOrAbort(450, init?.signal ?? undefined);
				calls++;
				if (calls === 1) return new Response("imds-token");
				if (calls === 2) return new Response("test-role");
				return Response.json({
					AccessKeyId: "AKIASLOWIMDS",
					SecretAccessKey: "imds-secret",
					Token: "imds-session",
					Expiration: "2099-01-01T00:00:00Z",
				});
			},
			{ preconnect: fetch.preconnect },
		);

		const credentials = await resolveAwsCredentials({ fetch: fetchImpl });

		expect(calls).toBe(3);
		expect(credentials.accessKeyId).toBe("AKIASLOWIMDS");
	});

	test("exchanges web identity tokens for STS credentials", async () => {
		const tokenPath = path.join(tmp, "web-identity-token");
		await Bun.write(tokenPath, "signed-identity-token\n");
		Bun.env.AWS_WEB_IDENTITY_TOKEN_FILE = tokenPath;
		Bun.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test-role";
		Bun.env.AWS_ROLE_SESSION_NAME = "test-session";
		await writeConfig("regional", "region = cn-north-1");
		let requestedUrl = "";
		let requestBody = "";
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				requestedUrl = String(input);
				requestBody = String(init?.body);
				return new Response(
					`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
						<AccessKeyId>AKIAWEB</AccessKeyId><SecretAccessKey>web-secret</SecretAccessKey>
						<SessionToken>web-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration>
					</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
					{ headers: { "content-type": "text/xml" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);

		const credentials = await resolveAwsCredentials({ profile: "regional", fetch: fetchImpl });

		expect(requestedUrl).toBe("https://sts.cn-north-1.amazonaws.com.cn/");
		expect(new URLSearchParams(requestBody).get("WebIdentityToken")).toBe("signed-identity-token");
		expect(new URLSearchParams(requestBody).get("RoleSessionName")).toBe("test-session");
		expect(credentials).toEqual({
			accessKeyId: "AKIAWEB",
			secretAccessKey: "web-secret",
			sessionToken: "web-token",
			expiresAt: Date.parse("2099-01-01T00:00:00Z"),
		});
	});

	test("rejects web-identity responses without a valid expiration", async () => {
		const tokenPath = path.join(tmp, "web-identity-token-without-expiration");
		await Bun.write(tokenPath, "signed-identity-token\n");
		Bun.env.AWS_WEB_IDENTITY_TOKEN_FILE = tokenPath;
		Bun.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/test-role";
		const fetchImpl: FetchImpl = Object.assign(
			async () =>
				new Response(
					`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
						<AccessKeyId>AKIAWEB</AccessKeyId><SecretAccessKey>web-secret</SecretAccessKey>
						<SessionToken>web-token</SessionToken>
					</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
					{ headers: { "content-type": "text/xml" } },
				),
			{ preconnect: fetch.preconnect },
		);

		await expect(resolveAwsCredentials({ region: "us-east-1", fetch: fetchImpl })).rejects.toThrow(
			/missing or invalid Expiration/,
		);
	});

	test("chains role_arn + source_profile through web identity then AssumeRole", async () => {
		const tokenPath = path.join(tmp, "sa-token");
		await Bun.write(tokenPath, "irsa-jwt\n");
		await writeRawConfig(
			`[profile irsa]\nrole_arn = arn:aws:iam::111122223333:role/workspace\nweb_identity_token_file = ${tokenPath}\n\n` +
				`[profile app]\nrole_arn = arn:aws:iam::111122223333:role/user\nrole_session_name = someone@example.com\n` +
				`source_profile = irsa\nexternal_id = ext-1\nduration_seconds = 1800\n`,
		);
		const captured: Array<Record<string, string>> = [];

		const creds = await resolveAwsCredentials({ profile: "app", region: "us-east-1", fetch: stsMock(captured) });

		expect(captured).toHaveLength(2);
		expect(captured[0].Action).toBe("AssumeRoleWithWebIdentity");
		expect(captured[0].RoleArn).toBe("arn:aws:iam::111122223333:role/workspace");
		expect(captured[0].WebIdentityToken).toBe("irsa-jwt");
		expect(captured[1].Action).toBe("AssumeRole");
		expect(captured[1].RoleArn).toBe("arn:aws:iam::111122223333:role/user");
		// role_session_name must survive the second hop for per-user CloudTrail attribution.
		expect(captured[1].RoleSessionName).toBe("someone@example.com");
		expect(captured[1].ExternalId).toBe("ext-1");
		expect(captured[1].DurationSeconds).toBe("1800");
		expect(creds).toEqual({
			accessKeyId: "AKIAFINAL",
			secretAccessKey: "AKIAFINAL-secret",
			sessionToken: "AKIAFINAL-token",
			expiresAt: Date.parse("2099-01-01T00:00:00Z"),
		});
	});

	test("SigV4-signs the AssumeRole hop with the source profile's credentials", async () => {
		await writeRawConfig(
			`[profile base]\naws_access_key_id = AKIASOURCE\naws_secret_access_key = source-secret\n\n` +
				`[profile role]\nrole_arn = arn:aws:iam::111122223333:role/target\nsource_profile = base\n`,
		);
		let authorization: string | null = null;
		const fetchImpl: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				authorization = new Headers(init?.headers).get("authorization");
				return new Response(
					`<AssumeRoleResponse><AssumeRoleResult><Credentials>
						<AccessKeyId>AKIAROLE</AccessKeyId><SecretAccessKey>role-secret</SecretAccessKey>
						<SessionToken>role-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration>
					</Credentials></AssumeRoleResult></AssumeRoleResponse>`,
					{ headers: { "content-type": "text/xml" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);

		const creds = await resolveAwsCredentials({ profile: "role", region: "us-east-1", fetch: fetchImpl });

		expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIASOURCE\//);
		expect(creds.accessKeyId).toBe("AKIAROLE");
	});

	test("rejects role_arn without a base credential source", async () => {
		await writeRawConfig(`[profile orphan]\nrole_arn = arn:aws:iam::111122223333:role/target\n`);
		await expect(resolveAwsCredentials({ profile: "orphan", region: "us-east-1" })).rejects.toThrow(
			/sets role_arn without source_profile/,
		);
	});

	test("detects source_profile cycles", async () => {
		await writeRawConfig(
			`[profile a]\nrole_arn = arn:aws:iam::1:role/a\nsource_profile = b\n\n` +
				`[profile b]\nrole_arn = arn:aws:iam::1:role/b\nsource_profile = a\n`,
		);
		await expect(resolveAwsCredentials({ profile: "a", region: "us-east-1" })).rejects.toThrow(/cycle/);
	});
});
