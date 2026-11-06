import { createHash, createHmac } from "node:crypto";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import * as path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import type { HttpRequest, MetadataBearer, MiddlewareStack } from "@smithy/types";
import type {
	AwsSecretInputClient,
	AwsSecretInputClientConfig,
	AwsSecretInputLaunchFiles,
	AwsSecretInputScopeDependencies,
	AwsSecretInputService,
} from "../../src/tools/aws-secret-input-scope";
import type { AwsSecretInputFailureCode, AwsSecretInputRequest } from "../../src/tools/aws-secret-input-contract";

const FAILURE = "AWS_SECRET_INPUT_SDK_ISOLATION_FAILED";
const emit = process.stdout.write.bind(process.stdout);
let stage = 0;
let substage = "startup";
let failureCode: AwsSecretInputFailureCode | "UNCLASSIFIED" | "FIXTURE_PROOF_FAILED" = "UNCLASSIFIED";
let activeClient: AwsSecretInputService | "none" = "none";
let activeOmission: Omission | undefined;
let signatureKind: "none" | "sigv4" | "sigv4a" | "other" = "none";
type SignatureFailure =
	| "none"
	| "authorization"
	| "empty-signing-region"
	| "access-key"
	| "region"
	| "service"
	| "session-token"
	| "timestamp"
	| "query"
	| "signed-headers"
	| "payload-hash"
	| "signature";
let signatureFailure: SignatureFailure = "none";
let firstAmbientRead:
	| { client: AwsSecretInputService | "none"; substage: string; kind: "config" | "credentials" }
	| undefined;

function requireProof(value: unknown): asserts value {
	if (!value) {
		failureCode = "FIXTURE_PROOF_FAILED";
		throw new Error(FAILURE);
	}
}

const counters = { ambientReads: 0, forbiddenReads: 0, networkCalls: 0, spawnCalls: 0, outputCalls: 0 };
for (const stream of [process.stdout, process.stderr]) {
	stream.write = new Proxy(stream.write, {
		apply(_target, _receiver, args: unknown[]) {
			counters.outputCalls++;
			const callback = args.find(value => typeof value === "function");
			if (typeof callback === "function") callback();
			return true;
		},
	});
}
for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) {
	console[name] = () => {
		counters.outputCalls++;
	};
}

const SELECTED = [
	{
		accessKeyId: "sdk-isolation-selected-first-key",
		secretAccessKey: "sdk-isolation-selected-first-private-never-real",
		sessionToken: "sdk-isolation-selected-first-session-never-real",
		payload: "sdk-isolation-first-private-input-é-雪\n",
	},
	{
		accessKeyId: "sdk-isolation-selected-second-key",
		secretAccessKey: "sdk-isolation-selected-second-private-never-real",
		sessionToken: "sdk-isolation-selected-second-session-never-real",
		payload: "sdk-isolation-second-private-input-🔒\r\n",
	},
] as const;
const SSO_TOKEN = "sdk-isolation-private-sso-token-never-real";
const DECOYS = [
	{
		appId: "ambient-sdk-first",
		endpoint: "https://ambient-sdk-first.invalid",
		accessKeyId: "sdk-isolation-ambient-first-key",
		secretAccessKey: "sdk-isolation-ambient-first-private-never-real",
		sessionToken: "sdk-isolation-ambient-first-session-never-real",
		region: "ap-southeast-1",
		defaultsMode: "mobile",
	},
	{
		appId: "ambient-sdk-second",
		endpoint: "https://ambient-sdk-second.invalid",
		accessKeyId: "sdk-isolation-ambient-second-key",
		secretAccessKey: "sdk-isolation-ambient-second-private-never-real",
		sessionToken: "sdk-isolation-ambient-second-session-never-real",
		region: "eu-central-1",
		defaultsMode: "cross-region",
	},
] as const;
const PUBLIC_STDOUT = "consumer output remains raw\n";
const PUBLIC_STDERR = "consumer diagnostic remains raw\n";
const NOW = Date.UTC(2099, 0, 1);
const PROFILE = "sdk-isolation";
const SSO_SESSION = "sdk-isolation-session";
const SSO_START_URL = "https://sdk-isolation.awsapps.com/start";
const ACCOUNT = "123456789012";
const PRINCIPAL = "arn:aws:sts::123456789012:assumed-role/sdk-isolation-role/sdk-isolation-session";
const VERSION = "01234567-89ab-cdef-0123-456789abcdef";
const root = path.resolve(process.argv[2] ?? "");
const repoRoot = path.resolve(import.meta.dir, "../../../..");
const ambientFiles = new Set<string>();

function inside(filename: string, directory: string): boolean {
	const relative = path.relative(directory, filename);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function envPath(name: string): string {
	const value = process.env[name];
	requireProof(value && path.isAbsolute(value) && inside(value, root) && value !== root);
	return value;
}

async function writeDecoys(index: number, control?: number): Promise<void> {
	const decoy = DECOYS[index % DECOYS.length]!;
	if (control !== undefined) {
		process.env.AWS_CONFIG_FILE = path.join(root, "ambient", `control-${control}`, "config");
		process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(root, "ambient", `control-${control}`, "credentials");
	}
	const settings = [
		`region = ${decoy.region}`,
		`defaults_mode = ${decoy.defaultsMode}`,
		"disable_clock_skew_correction = true",
		"auth_scheme_preference = sigv4a,sigv4",
		`sigv4a_signing_region_set = ${decoy.region},*`,
		`sdk_ua_app_id = ${decoy.appId}`,
		`endpoint_url = ${decoy.endpoint}`,
		"use_fips_endpoint = true",
		"use_dualstack_endpoint = true",
		"services = ambient-endpoints",
	].join("\n");
	const config = [
		"[default]",
		settings,
		"[profile ambient-sdk-isolation]",
		settings,
		`[profile ${PROFILE}]`,
		settings,
		"[services ambient-endpoints]",
		"sts =",
		`  endpoint_url = ${decoy.endpoint}`,
		"secretsmanager =",
		`  endpoint_url = ${decoy.endpoint}`,
		"sso =",
		`  endpoint_url = ${decoy.endpoint}`,
		"",
	].join("\n");
	const credentials = ["default", "ambient-sdk-isolation", PROFILE]
		.map(name =>
			[
				`[${name}]`,
				`aws_access_key_id = ${decoy.accessKeyId}`,
				`aws_secret_access_key = ${decoy.secretAccessKey}`,
				`aws_session_token = ${decoy.sessionToken}`,
				"",
			].join("\n"),
		)
		.join("\n");
	const homes = [path.join(envPath("HOME"), ".aws"), path.join(envPath("XDG_CONFIG_HOME"), "aws")];
	for (const [filename, text] of [
		[envPath("AWS_CONFIG_FILE"), config],
		[envPath("AWS_SHARED_CREDENTIALS_FILE"), credentials],
		...homes.flatMap(home => [
			[path.join(home, "config"), config],
			[path.join(home, "credentials"), credentials],
		]),
	]) {
		requireProof(filename && text);
		ambientFiles.add(filename);
		await fsPromises.mkdir(path.dirname(filename), { recursive: true });
		await fsPromises.writeFile(filename, text, { mode: 0o600 });
	}
	for (const key of [
		"AWS_ENDPOINT_URL",
		"AWS_ENDPOINT_URL_STS",
		"AWS_ENDPOINT_URL_SECRETS_MANAGER",
		"AWS_ENDPOINT_URL_SSO",
	]) {
		process.env[key] = decoy.endpoint;
	}
	process.env.AWS_REGION = decoy.region;
	process.env.AWS_DEFAULT_REGION = decoy.region;
}

function intercept(target: object, name: string, before: (args: unknown[]) => void): void {
	const original: unknown = Reflect.get(target, name);
	if (typeof original !== "function") return;
	requireProof(
		Reflect.set(
			target,
			name,
			new Proxy(original, {
				apply(fn, receiver, args: unknown[]) {
					before(args);
					return Reflect.apply(fn, receiver, args);
				},
			}),
		),
	);
}

function installFilesystemGuard(): void {
	const moduleRoots = [path.join(repoRoot, "packages"), path.join(repoRoot, "node_modules")];
	for (const directory of moduleRoots.slice()) {
		try {
			moduleRoots.push(fs.realpathSync(directory));
		} catch {}
	}
	const check = (input: unknown, read = true): void => {
		let filename: string | undefined;
		try {
			if (typeof input === "string") filename = path.resolve(input);
			else if (input instanceof URL && input.protocol === "file:") filename = path.resolve(fileURLToPath(input));
			else if (Buffer.isBuffer(input)) filename = path.resolve(input.toString("utf8"));
		} catch {}
		if (filename && !read && inside(filename, root)) return;
		if (filename && read && ambientFiles.has(filename)) {
			firstAmbientRead ??= {
				client: activeClient,
				substage,
				kind: path.basename(filename) === "config" ? "config" : "credentials",
			};
			counters.ambientReads++;
			return;
		}
		if (
			filename &&
			read &&
			/\.(?:[cm]?js|tsx?|json|node|wasm|dylib|so)$/u.test(filename) &&
			moduleRoots.some(directory => inside(filename!, directory))
		)
			return;
		counters.forbiddenReads++;
		substage = "filesystem-guard";
		throw new Error(FAILURE);
	};
	const opening = (args: unknown[]) => {
		const flags = args[1];
		const read =
			typeof flags === "string"
				? flags.includes("r") || flags.includes("+")
				: typeof flags !== "number" ||
					(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== fs.constants.O_WRONLY;
		check(args[0], read);
	};
	for (const name of ["readFile", "readFileSync", "createReadStream"]) intercept(fs, name, args => check(args[0]));
	for (const name of ["open", "openSync"]) intercept(fs, name, opening);
	for (const target of new Set([fsPromises, fs.promises])) {
		intercept(target, "readFile", args => check(args[0]));
		intercept(target, "open", opening);
	}
	intercept(Bun, "file", args => check(args[0]));
}

function installTransportGuard(): void {
	const denyNetwork = () => {
		substage = "network-guard";
		counters.networkCalls++;
		throw new Error(FAILURE);
	};
	for (const [target, names] of [
		[globalThis, ["fetch"]],
		[Bun, ["connect", "udpSocket", "listen"]],
		[http, ["request", "get"]],
		[https, ["request", "get"]],
		[http2, ["connect"]],
		[net, ["connect", "createConnection"]],
		[net.Socket.prototype, ["connect"]],
		[tls, ["connect"]],
		[dgram, ["createSocket"]],
		[dns, Object.keys(dns).filter(name => /^(?:lookup|resolve)/u.test(name))],
		[dnsPromises, Object.keys(dnsPromises).filter(name => /^(?:lookup|resolve)/u.test(name))],
	] as const) {
		for (const name of names) intercept(target, name, denyNetwork);
	}
	if (typeof globalThis.WebSocket === "function") {
		globalThis.WebSocket = new Proxy(globalThis.WebSocket, { construct: denyNetwork });
	}
	const denySpawn = () => {
		substage = "spawn-guard";
		counters.spawnCalls++;
		throw new Error(FAILURE);
	};
	for (const name of ["spawn", "spawnSync"]) intercept(Bun, name, denySpawn);
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
		intercept(childProcess, name, denySpawn);
	}
}

function bodyText(request: HttpRequest): string {
	if (typeof request.body === "string") return request.body;
	if (request.body instanceof Uint8Array) return new TextDecoder("utf8", { fatal: true }).decode(request.body);
	requireProof(request.body === undefined);
	return "";
}

function failSignature(reason: Exclude<SignatureFailure, "none">): false {
	signatureFailure = reason;
	return false;
}

function rejectedUnboundSigningScope(): boolean {
	return (
		activeClient === "sts" &&
		substage === "sigv4-signature" &&
		signatureKind === "sigv4" &&
		signatureFailure === "empty-signing-region" &&
		failureCode === "FIXTURE_PROOF_FAILED"
	);
}

function verifySigv4(
	request: HttpRequest,
	service: "sts" | "secretsmanager",
	region: string,
	selected: (typeof SELECTED)[number],
): boolean {
	signatureFailure = "none";
	const headers = Object.fromEntries(
		Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
	);
	const authorization = headers.authorization ?? "";
	const match =
		/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/u.exec(
			authorization,
		);
	if (!match) {
		return failSignature(
			/^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/\/[^/]+\/aws4_request, /u.test(authorization)
				? "empty-signing-region"
				: "authorization",
		);
	}
	if (match[1] !== selected.accessKeyId) return failSignature("access-key");
	if (match[3] !== region) return failSignature("region");
	if (match[4] !== service) return failSignature("service");
	if (headers["x-amz-security-token"] !== selected.sessionToken) return failSignature("session-token");
	if (!/^\d{8}T\d{6}Z$/u.test(headers["x-amz-date"] ?? "") || !headers["x-amz-date"]?.startsWith(match[2]!))
		return failSignature("timestamp");
	if (Object.keys(request.query ?? {}).length !== 0) return failSignature("query");
	const names = match[5]!.split(";");
	if (!names.includes("host") || !names.includes("x-amz-date") || !names.includes("x-amz-security-token"))
		return failSignature("signed-headers");
	if (names.some((name, index) => !(name in headers) || (index > 0 && names[index - 1]! >= name)))
		return failSignature("signed-headers");
	const canonicalHeaders = names.map(name => `${name}:${headers[name]!.trim().replace(/\s+/gu, " ")}`).join("\n");
	const payloadHash = createHash("sha256").update(bodyText(request)).digest("hex");
	if (headers["x-amz-content-sha256"] !== undefined && headers["x-amz-content-sha256"] !== payloadHash)
		return failSignature("payload-hash");
	const canonical = [request.method, request.path, "", canonicalHeaders, "", match[5], payloadHash].join("\n");
	const credentialScope = `${match[2]}/${region}/${service}/aws4_request`;
	const toSign = [
		"AWS4-HMAC-SHA256",
		headers["x-amz-date"],
		credentialScope,
		createHash("sha256").update(canonical).digest("hex"),
	].join("\n");
	let key = createHmac("sha256", `AWS4${selected.secretAccessKey}`).update(match[2]!).digest();
	for (const component of [region, service, "aws4_request"]) {
		const next = createHmac("sha256", key).update(component).digest();
		key.fill(0);
		key = next;
	}
	try {
		if (createHmac("sha256", key).update(toSign).digest("hex") !== match[6]) return failSignature("signature");
		return true;
	} finally {
		key.fill(0);
	}
}

type Omission =
	| "authSchemePreference"
	| "userAgentAppId"
	| "defaultsMode"
	| "sigv4aSigningRegionSet"
	| "disableClockSkewCorrection";

async function main() {
	stage = 1;
	requireProof(process.argv.length === 3 && path.isAbsolute(process.argv[2]!) && root !== path.parse(root).root);
	for (const name of [
		"HOME",
		"USERPROFILE",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"AWS_CONFIG_FILE",
		"AWS_SHARED_CREDENTIALS_FILE",
		"TMPDIR",
		"TMP",
		"TEMP",
	])
		envPath(name);
	for (const name of [
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_AUTH_SCHEME_PREFERENCE",
		"AWS_DEFAULTS_MODE",
		"AWS_DISABLE_CLOCK_SKEW_CORRECTION",
		"AWS_SIGV4A_SIGNING_REGION_SET",
		"AWS_SDK_UA_APP_ID",
	]) {
		requireProof(process.env[name] === undefined);
	}
	await writeDecoys(0);
	installFilesystemGuard();
	installTransportGuard();
	syncBuiltinESMExports();
	stage = 2;
	const [scope, contract, sts, secretsmanager, sso, protocols] = await Promise.all([
		import("../../src/tools/aws-secret-input-scope"),
		import("../../src/tools/aws-secret-input-contract"),
		import("@aws-sdk/client-sts"),
		import("@aws-sdk/client-secrets-manager"),
		import("@aws-sdk/client-sso"),
		import("@smithy/core/protocols"),
	]);

	async function runScope(index: 0 | 1, omission?: Omission) {
		const ambientReadsBefore = counters.ambientReads;
		activeOmission = omission;
		activeClient = "none";
		signatureKind = "none";
		signatureFailure = "none";
		const selected = SELECTED[index];
		const region = index === 0 ? "us-east-2" : "eu-west-1";
		const ssoRegion = "us-west-2";
		const launch: AwsSecretInputLaunchFiles = {
			homeDir: path.join(root, "bounded", `scope-${index}`),
			configFile: path.join(root, "bounded", `scope-${index}`, "config"),
			sharedCredentialsFile: path.join(root, "bounded", `scope-${index}`, "credentials"),
			reservedProfiles: [],
		};
		const request: AwsSecretInputRequest = {
			profile: PROFILE,
			region,
			service: "secretsmanager",
			operation: "get-secret-value",
			parameters: {
				SecretId: `arn:aws:secretsmanager:${region}:${ACCOUNT}:secret:sdk-isolation-ABC123`,
				VersionId: VERSION,
				VersionStage: "AWSCURRENT",
			},
			timeout: 10,
			secretInput: {
				protocol: contract.AWS_SECRET_INPUT_PROTOCOL,
				capability: contract.AWS_SECRET_INPUT_CAPABILITY.capability,
				expectedIdentity: { account: ACCOUNT, arn: PRINCIPAL, partition: "aws" },
				consumer: { argv: [process.execPath, "--no-env-file", "--no-install"], cwd: root },
			},
		};
		const config =
			index === 0
				? `[profile ${PROFILE}]\nregion = ${region}\n`
				: [
						`[profile ${PROFILE}]`,
						`sso_session = ${SSO_SESSION}`,
						`sso_account_id = ${ACCOUNT}`,
						"sso_role_name = sdk-isolation-role",
						`[sso-session ${SSO_SESSION}]`,
						`sso_start_url = ${SSO_START_URL}`,
						`sso_region = ${ssoRegion}`,
						"",
					].join("\n");
		const files = new Map<string, string>([
			[launch.configFile!, config],
			[
				launch.sharedCredentialsFile!,
				index === 0
					? [
							`[${PROFILE}]`,
							`aws_access_key_id = ${selected.accessKeyId}`,
							`aws_secret_access_key = ${selected.secretAccessKey}`,
							`aws_session_token = ${selected.sessionToken}`,
							"",
						].join("\n")
					: "",
			],
		]);
		if (index === 1) {
			files.set(
				path.join(
					launch.homeDir,
					".aws",
					"sso",
					"cache",
					`${createHash("sha1").update(SSO_SESSION).digest("hex")}.json`,
				),
				JSON.stringify({
					accessToken: SSO_TOKEN,
					expiresAt: new Date(NOW + 3_600_000).toISOString(),
					region: ssoRegion,
					startUrl: SSO_START_URL,
				}),
			);
		}
		const evidence = {
			identityRequests: 0,
			secretRequests: 0,
			ssoRequests: 0,
			verifiedSigv4Requests: 0,
			verifiedBearerRequests: 0,
			boundedReads: 0,
			destroyedClients: 0,
			resolvedDefaultsProviders: 0,
			resolvedSigv4aProviders: 0,
			consumerVerified: false,
			publicResultOnlyConsumer: false,
		};
		const dependencies: AwsSecretInputScopeDependencies = {
			now: () => NOW,
			readFile: async (filename, maxBytes, signal) => {
				substage = "bounded-read";
				requireProof(!signal.aborted && files.has(filename));
				const value = new TextEncoder().encode(files.get(filename)!);
				requireProof(value.byteLength <= maxBytes);
				evidence.boundedReads++;
				return value;
			},
			createClient: (service: AwsSecretInputService, config: AwsSecretInputClientConfig) => {
				activeClient = service;
				substage = "create-client";
				const options = {
					...config,
					requestHandler: {
						async handle(wire: HttpRequest) {
							substage = "wire-protocol";
							const headers = Object.fromEntries(
								Object.entries(wire.headers).map(([name, value]) => [name.toLowerCase(), value]),
							);
							const agent = `${headers["user-agent"] ?? ""} ${headers["x-amz-user-agent"] ?? ""}`;
							requireProof(wire.protocol === "https:" && (wire.port === undefined || wire.port === 443));
							substage = "user-agent";
							requireProof(
								omission === "userAgentAppId"
									? agent.includes(`app/${DECOYS[0].appId}`)
									: !agent.includes("app/"),
							);
							let body: string;
							if (service === "sso") {
								substage = "sso-request";
								requireProof(
									wire.hostname === `portal.sso.${ssoRegion}.amazonaws.com` && wire.method === "GET",
								);
								requireProof(wire.path === "/federation/credentials" && bodyText(wire) === "");
								requireProof(
									Bun.deepEquals(wire.query, { account_id: ACCOUNT, role_name: "sdk-isolation-role" }),
								);
								requireProof(
									headers["x-amz-sso_bearer_token"] === SSO_TOKEN && headers.authorization === undefined,
								);
								evidence.ssoRequests++;
								evidence.verifiedBearerRequests++;
								body = JSON.stringify({
									roleCredentials: {
										accessKeyId: selected.accessKeyId,
										secretAccessKey: selected.secretAccessKey,
										sessionToken: selected.sessionToken,
										expiration: NOW + 3_600_000,
									},
								});
							} else {
								substage = "sigv4-request";
								requireProof(
									wire.hostname === `${service}.${region}.amazonaws.com` &&
										wire.method === "POST" &&
										wire.path === "/",
								);
								substage = "sigv4-signature";
								signatureKind = headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")
									? "sigv4"
									: headers.authorization?.startsWith("AWS4-ECDSA-P256-SHA256 ")
										? "sigv4a"
										: "other";
								requireProof(verifySigv4(wire, service, region, selected));
								evidence.verifiedSigv4Requests++;
								if (service === "sts") {
									substage = "sts-operation";
									requireProof(
										Bun.deepEquals([...new URLSearchParams(bodyText(wire))].sort(), [
											["Action", "GetCallerIdentity"],
											["Version", "2011-06-15"],
										]),
									);
									evidence.identityRequests++;
									body = [
										'<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">',
										`<GetCallerIdentityResult><Arn>${PRINCIPAL}</Arn><UserId>sdk-isolation-user</UserId><Account>${ACCOUNT}</Account></GetCallerIdentityResult>`,
										"<ResponseMetadata><RequestId>sdk-isolation-request</RequestId></ResponseMetadata></GetCallerIdentityResponse>",
									].join("");
								} else {
									substage = "secret-operation";
									requireProof(headers["x-amz-target"] === "secretsmanager.GetSecretValue");
									requireProof(Bun.deepEquals(JSON.parse(bodyText(wire)), request.parameters));
									evidence.secretRequests++;
									body = JSON.stringify({
										ARN: request.parameters.SecretId,
										VersionId: VERSION,
										VersionStages: ["AWSCURRENT"],
										SecretString: selected.payload,
									});
								}
							}
							return {
								response: new protocols.HttpResponse({
									statusCode: 200,
									headers: {
										"content-type": service === "sts" ? "text/xml" : "application/x-amz-json-1.1",
										"x-amzn-requestid": "sdk-isolation-request",
									},
									body: new TextEncoder().encode(body),
								}),
							};
						},
						destroy() {
							evidence.destroyedClients++;
						},
					},
				};
				if (omission) delete (options as unknown as Partial<AwsSecretInputClientConfig>)[omission];
				const sdk =
					service === "sts"
						? new sts.STSClient(options)
						: service === "secretsmanager"
							? new secretsmanager.SecretsManagerClient(options)
							: new sso.SSOClient(options);
				const stack = sdk.middlewareStack as unknown as MiddlewareStack<object, MetadataBearer>;
				stack.add(
					next => async args => {
						const resolved = sdk.config as unknown as Record<string, unknown>;
						substage = "defaults-provider";
						const defaultsMode = resolved.defaultsMode;
						requireProof(typeof defaultsMode === "function");
						await defaultsMode();
						evidence.resolvedDefaultsProviders++;
						if (service === "sts") {
							substage = "sigv4a-provider";
							const sigv4a = resolved.sigv4aSigningRegionSet;
							requireProof(typeof sigv4a === "function");
							await sigv4a();
							evidence.resolvedSigv4aProviders++;
						}
						substage = "sdk-send";
						return next(args);
					},
					{ name: "sdkIsolationLazyProviderProbe", step: "initialize" },
				);
				return sdk as unknown as AwsSecretInputClient;
			},
			executeConsumer: async (_argv, options) => {
				substage = "consumer-input";
				requireProof(options?.input instanceof Uint8Array);
				requireProof(Buffer.from(options.input).equals(Buffer.from(selected.payload)));
				evidence.consumerVerified = true;
				return { stdout: PUBLIC_STDOUT, stderr: PUBLIC_STDERR, exitCode: 0, ok: true, ownedInputCleanedUp: true };
			},
		};
		try {
			substage = "scope-run";
			const result = await scope.runAwsSecretInputScope(
				request,
				launch,
				async () => {},
				new AbortController().signal,
				async () => {},
				dependencies,
			);
			substage = "scope-result";
			evidence.publicResultOnlyConsumer = Bun.deepEquals(result, {
				stdout: PUBLIC_STDOUT,
				stderr: PUBLIC_STDERR,
				exitCode: 0,
				signal: null,
				timedOut: false,
				cancelled: false,
				stdoutTruncated: false,
				stderrTruncated: false,
				completion: "exited",
				teardown: { consumerReaped: true, referencesReleased: true },
			});
			requireProof(evidence.consumerVerified && evidence.publicResultOnlyConsumer);
			substage = "request-counts";
			requireProof(
				evidence.identityRequests === 1 && evidence.secretRequests === 1 && evidence.verifiedSigv4Requests === 2,
			);
			requireProof(evidence.ssoRequests === index && evidence.verifiedBearerRequests === index);
			requireProof(evidence.destroyedClients === 2 + index && evidence.boundedReads === 2 + index);
			return evidence;
		} catch (error) {
			// The SDK maps an empty SigV4a region set to an empty HMAC signing scope.
			if (
				omission === "authSchemePreference" &&
				rejectedUnboundSigningScope() &&
				error instanceof contract.AwsSecretInputFailure &&
				contract.safeAwsSecretInputFailure(error) === "AWS_FAILED" &&
				counters.ambientReads > ambientReadsBefore &&
				evidence.identityRequests === 0 &&
				evidence.secretRequests === 0 &&
				evidence.ssoRequests === 0 &&
				!evidence.consumerVerified &&
				evidence.destroyedClients === 1
			) {
				failureCode = "UNCLASSIFIED";
				return evidence;
			}
			if (failureCode === "UNCLASSIFIED" && error instanceof contract.AwsSecretInputFailure) {
				failureCode = contract.safeAwsSecretInputFailure(error);
			}
			throw error;
		} finally {
			files.clear();
		}
	}

	stage = 3;
	const first = await runScope(0);
	substage = "ambient-read-check";
	requireProof(counters.ambientReads === 0);
	await writeDecoys(1);
	stage = 4;
	const second = await runScope(1);
	substage = "ambient-read-check";
	requireProof(counters.ambientReads === 0);
	const productionAmbientReads = counters.ambientReads;
	stage = 5;
	let omissionControlsDetected = 0;
	for (const [index, omission] of (
		[
			"authSchemePreference",
			"userAgentAppId",
			"defaultsMode",
			"sigv4aSigningRegionSet",
			"disableClockSkewCorrection",
		] as const
	).entries()) {
		await writeDecoys(0, index);
		const before = counters.ambientReads;
		await runScope(0, omission);
		substage = "omission-control";
		requireProof(counters.ambientReads > before);
		omissionControlsDetected++;
	}
	stage = 6;
	requireProof(
		counters.forbiddenReads === 0 &&
			counters.networkCalls === 0 &&
			counters.spawnCalls === 0 &&
			counters.outputCalls === 0,
	);
	requireProof(omissionControlsDetected === 5);
	return {
		passed: true,
		productionScopes: 2,
		identityRequests: first.identityRequests + second.identityRequests,
		secretRequests: first.secretRequests + second.secretRequests,
		ssoRequests: first.ssoRequests + second.ssoRequests,
		verifiedSigv4Requests: first.verifiedSigv4Requests + second.verifiedSigv4Requests,
		verifiedBearerRequests: first.verifiedBearerRequests + second.verifiedBearerRequests,
		boundedReads: first.boundedReads + second.boundedReads,
		destroyedClients: first.destroyedClients + second.destroyedClients,
		resolvedDefaultsProviders: first.resolvedDefaultsProviders + second.resolvedDefaultsProviders,
		resolvedSigv4aProviders: first.resolvedSigv4aProviders + second.resolvedSigv4aProviders,
		productionAmbientReads,
		forbiddenReads: counters.forbiddenReads,
		networkCalls: counters.networkCalls,
		spawnCalls: counters.spawnCalls,
		outputCalls: counters.outputCalls,
		publicResultOnlyConsumer: first.publicResultOnlyConsumer && second.publicResultOnlyConsumer,
		secondScopeIndependent: first.consumerVerified && second.consumerVerified,
		omissionControlsDetected,
		controlAmbientReads: counters.ambientReads - productionAmbientReads,
	};
}

void main().then(
	receipt => {
		emit(`${JSON.stringify(receipt)}\n`);
	},
	() => {
		emit(
			`${JSON.stringify({
				passed: false,
				stage,
				substage,
				failureCode,
				control: activeOmission ?? "none",
				client: activeClient,
				signatureKind,
				signatureFailure,
				ambient: { count: counters.ambientReads, ...firstAmbientRead },
			})}\n`,
		);
		process.exitCode = 1;
	},
);
