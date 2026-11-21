import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetRoleCredentialsCommand, SSOClient } from "@aws-sdk/client-sso";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { ptree } from "@oh-my-pi/pi-utils";
import type { HttpRequest } from "@smithy/types";
import {
	AWS_SECRET_INPUT_CAPABILITY,
	AWS_SECRET_INPUT_LIMITS,
	AWS_SECRET_INPUT_PROTOCOL,
	AwsSecretInputFailure,
	type AwsSecretInputFailureCode,
	type AwsSecretInputRequest,
} from "../src/tools/aws-secret-input-contract";
import {
	type AwsSecretInputClient,
	type AwsSecretInputClientConfig,
	type AwsSecretInputCommand,
	type AwsSecretInputConsumerAdmission,
	type AwsSecretInputLaunchFiles,
	type AwsSecretInputScopeDependencies,
	type AwsSecretInputScopeResult,
	type AwsSecretInputService,
	runAwsSecretInputScope,
} from "../src/tools/aws-secret-input-scope";
import {
	PUBLIC_CONSUMER_STDERR,
	PUBLIC_CONSUMER_STDOUT,
	scopeStdinReceiptPath,
} from "./fixtures/aws-secret-input-scope-consumer";
import {
	boundaryInputCases,
	exactInputCases,
	FIXTURE_NOW,
	leakyFailure,
	rejectedPointerCases,
	SSO_PROFILE_CONFIG,
	SSO_SESSION_NAME,
	SSO_START_URL,
	STATIC_PROFILE_CONFIG,
	STATIC_PROFILE_CREDENTIALS,
	STATIC_PROFILE_WITH_UNRELATED_SERVICES,
	SYNTHETIC_ACCESS_KEY_ID,
	SYNTHETIC_DIAGNOSTIC,
	SYNTHETIC_SECRET_ACCESS_KEY,
	SYNTHETIC_SECRET_TEXT,
	SYNTHETIC_SESSION_TOKEN,
	syntheticAwsHttpResponse,
	syntheticBinary,
	syntheticRoleCredentials,
	syntheticSsoToken,
	WRITABLE_INPUT,
} from "./fixtures/aws-secret-input-scope-data";
import {
	createStdinProducerWitnessObserver,
	isVerifiedFiniteStdinHandoff,
	type StdinProducerWitness,
} from "./fixtures/aws-secret-input-stdin-metadata";

const consumerFixture = resolve(import.meta.dir, "fixtures/aws-secret-input-scope-consumer.ts");
type ConsumerOptions = NonNullable<Parameters<NonNullable<AwsSecretInputScopeDependencies["executeConsumer"]>>[1]>;
type Operation = "identity" | "secret" | "sso";

interface SecretResponse {
	ARN?: unknown;
	VersionId?: unknown;
	VersionStages?: unknown;
	SecretString?: unknown;
	SecretBinary?: unknown;
}

interface Fixture {
	request: AwsSecretInputRequest;
	launch: AwsSecretInputLaunchFiles;
	identity: { Account?: unknown; Arn?: unknown };
	secret: SecretResponse;
	files: Map<string, string>;
	dependencies: AwsSecretInputScopeDependencies;
	state: {
		operations: Operation[];
		commands: AwsSecretInputCommand[];
		readPaths: string[];
		readBuffers: Uint8Array[];
		clients: {
			service: AwsSecretInputService;
			config: AwsSecretInputClientConfig;
			returned: boolean;
			destroyCalls: number;
		}[];
		admissionCalls: number;
		onAdmission?: AwsSecretInputConsumerAdmission;
		consumerCalls: number;
		consumerArgv?: string[];
		consumerOptions?: ConsumerOptions;
		inputAtDelivery?: Uint8Array;
		inputReference?: Uint8Array;
		readFailure?: string;
		createFailure?: AwsSecretInputService;
		sendFailure?: Operation;
		consumerFailure?: boolean;
		failure: Error;
	};
	run(): Promise<AwsSecretInputScopeResult>;
}

function fixture(): Fixture {
	const root = resolve(import.meta.dir, "fixtures/aws-secret-input-scope-memory-home");
	const request: AwsSecretInputRequest = {
		profile: "scope-fixture",
		region: "us-east-1",
		service: "secretsmanager",
		operation: "get-secret-value",
		parameters: {
			SecretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:scope-fixture-ABC123",
			VersionId: "01234567-89ab-cdef-0123-456789abcdef",
			VersionStage: "AWSCURRENT",
		},
		secretInput: {
			protocol: AWS_SECRET_INPUT_PROTOCOL,
			capability: AWS_SECRET_INPUT_CAPABILITY.capability,
			expectedIdentity: {
				account: "123456789012",
				arn: "arn:aws:sts::123456789012:assumed-role/scope-role/scope-session",
				partition: "aws",
			},
			consumer: {
				argv: [process.execPath, "--no-env-file", "--no-install", consumerFixture, join(root, "public-state.json")],
				cwd: resolve(import.meta.dir, "fixtures"),
			},
		},
	};
	const launch: AwsSecretInputLaunchFiles = {
		homeDir: root,
		configFile: join(root, "synthetic-config"),
		sharedCredentialsFile: join(root, "synthetic-credentials"),
		reservedProfiles: ["reserved-model-profile"],
	};
	const identity = {
		Account: request.secretInput.expectedIdentity.account,
		Arn: request.secretInput.expectedIdentity.arn,
	};
	const secret: SecretResponse = {
		ARN: request.parameters.SecretId,
		VersionId: request.parameters.VersionId,
		VersionStages: ["AWSCURRENT"],
		SecretString: SYNTHETIC_SECRET_TEXT,
	};
	const files = new Map([
		[launch.configFile!, STATIC_PROFILE_CONFIG],
		[launch.sharedCredentialsFile!, STATIC_PROFILE_CREDENTIALS],
	]);
	const state: Fixture["state"] = {
		operations: [],
		commands: [],
		readPaths: [],
		readBuffers: [],
		clients: [],
		admissionCalls: 0,
		consumerCalls: 0,
		failure: leakyFailure(),
	};
	const dependencies: AwsSecretInputScopeDependencies = {
		now: () => FIXTURE_NOW,
		readFile: async path => {
			state.readPaths.push(path);
			if (state.readFailure === path) throw state.failure;
			const text = files.get(path);
			if (text === undefined) throw Object.assign(new Error("Synthetic file is absent"), { code: "ENOENT" });
			const bytes = new TextEncoder().encode(text);
			state.readBuffers.push(bytes);
			return bytes;
		},
		createClient: (service, config) => {
			const client = { service, config, returned: false, destroyCalls: 0 };
			state.clients.push(client);
			if (state.createFailure === service) throw state.failure;
			client.returned = true;
			return {
				async send(command) {
					state.commands.push(command);
					const operation =
						command instanceof GetCallerIdentityCommand
							? "identity"
							: command instanceof GetSecretValueCommand
								? "secret"
								: command instanceof GetRoleCredentialsCommand
									? "sso"
									: undefined;
					if (!operation) throw new Error("Unexpected synthetic SDK operation");
					state.operations.push(operation);
					if (state.sendFailure === operation) throw state.failure;
					if (operation === "identity") return identity;
					if (operation === "secret") return secret;
					return { roleCredentials: syntheticRoleCredentials() };
				},
				destroy() {
					client.destroyCalls++;
				},
			};
		},
		executeConsumer: async (argv, options) => {
			state.consumerCalls++;
			state.consumerArgv = [...argv];
			if (!(options?.input instanceof Uint8Array)) throw new Error("Expected finite synthetic stdin bytes");
			state.consumerOptions = options;
			state.inputAtDelivery = Uint8Array.from(options.input);
			state.inputReference = options.input;
			if (state.consumerFailure) throw state.failure;
			return { stdout: "", stderr: "", exitCode: 0, ok: true, ownedInputCleanedUp: true };
		},
	};
	return {
		request,
		launch,
		identity,
		secret,
		files,
		dependencies,
		state,
		run: () =>
			runAwsSecretInputScope(
				request,
				launch,
				async () => {},
				new AbortController().signal,
				async () => {
					state.admissionCalls++;
					await state.onAdmission?.();
				},
				dependencies,
			),
	};
}

interface HttpAttempt {
	service: AwsSecretInputService;
	hostname: string;
	protocol: string;
	fixtureCredentials: boolean;
	secretReference?: boolean;
	ssoActorAccount?: boolean;
}

function useInMemorySdk(f: Fixture, retryableService?: AwsSecretInputService): HttpAttempt[] {
	const attempts: HttpAttempt[] = [];
	const approvedParameters = { ...f.request.parameters };
	const actorAccount = f.request.secretInput.expectedIdentity.account;
	f.dependencies.createClient = (service, config) => {
		const client = { service, config, returned: false, destroyCalls: 0 };
		f.state.clients.push(client);
		const options = {
			...config,
			region: config.region ?? f.request.region,
			maxAttempts: config.maxAttempts ?? 3,
			retryMode: config.retryMode ?? "standard",
			ignoreConfiguredEndpointUrls: true,
			useFipsEndpoint: config.useFipsEndpoint ?? false,
			useDualstackEndpoint: config.useDualstackEndpoint ?? false,
			defaultsMode: "standard" as const,
			authSchemePreference: [],
			sigv4aSigningRegionSet: [],
			userAgentAppId: async () => undefined,
			credentialDefaultProvider: () => async () => {
				throw new Error("Synthetic SDK must never resolve default credentials");
			},
			requestHandler: {
				async handle(request: HttpRequest) {
					const headers = Object.fromEntries(
						Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]),
					);
					const attempt: HttpAttempt = {
						service,
						hostname: request.hostname,
						protocol: request.protocol,
						fixtureCredentials:
							service === "sso"
								? headers["x-amz-sso_bearer_token"] === SYNTHETIC_SESSION_TOKEN
								: headers.authorization?.includes(`Credential=${SYNTHETIC_ACCESS_KEY_ID}/`) === true &&
									headers["x-amz-security-token"] === SYNTHETIC_SESSION_TOKEN,
					};
					if (service === "secretsmanager") {
						let parameters: unknown;
						try {
							const body =
								typeof request.body === "string"
									? request.body
									: request.body instanceof Uint8Array
										? new TextDecoder().decode(request.body)
										: "";
							parameters = JSON.parse(body);
						} catch {
							parameters = undefined;
						}
						attempt.secretReference =
							parameters !== null &&
							typeof parameters === "object" &&
							(parameters as Record<string, unknown>).SecretId === approvedParameters.SecretId &&
							(parameters as Record<string, unknown>).VersionId === approvedParameters.VersionId &&
							(parameters as Record<string, unknown>).VersionStage === approvedParameters.VersionStage;
					}
					if (service === "sso") attempt.ssoActorAccount = request.query?.account_id === actorAccount;
					attempts.push(attempt);
					return {
						response: syntheticAwsHttpResponse(service, f.identity, f.secret, service === retryableService),
					};
				},
			},
		};
		const sdk = (service === "sts"
			? new STSClient(options)
			: service === "secretsmanager"
				? new SecretsManagerClient(options)
				: new SSOClient(options)) as unknown as AwsSecretInputClient;
		client.returned = true;
		return {
			send(command, sendOptions) {
				f.state.commands.push(command);
				f.state.operations.push(service === "sts" ? "identity" : service === "secretsmanager" ? "secret" : "sso");
				return sdk.send(command, sendOptions);
			},
			destroy() {
				client.destroyCalls++;
				sdk.destroy();
			},
		};
	};
	return attempts;
}

function configureSso(
	f: Fixture,
	expiresAt = FIXTURE_NOW + 60_000,
	options: { startUrl?: string; legacy?: boolean } = {},
): string {
	const startUrl = options.startUrl ?? SSO_START_URL;
	let config = SSO_PROFILE_CONFIG.replace(SSO_START_URL, startUrl);
	if (options.legacy) {
		config = config.replace(`sso_session = ${SSO_SESSION_NAME}\n`, "");
		config = config.replace(`[sso-session ${SSO_SESSION_NAME}]\n`, "");
	}
	f.files.set(f.launch.configFile!, config);
	f.files.set(f.launch.sharedCredentialsFile!, "");
	const cache = join(
		f.launch.homeDir,
		".aws",
		"sso",
		"cache",
		`${createHash("sha1")
			.update(options.legacy ? startUrl : SSO_SESSION_NAME)
			.digest("hex")}.json`,
	);
	f.files.set(cache, syntheticSsoToken(expiresAt, startUrl));
	return cache;
}

function expectInput(f: Fixture, expected: Uint8Array): void {
	const received = f.state.inputAtDelivery;
	expect(
		received !== undefined &&
			received.byteLength === expected.byteLength &&
			received.every((byte, index) => byte === expected[index]),
		"private stdin byte delivery differs",
	).toBe(true);
}

function expectReleased(f: Fixture): void {
	for (const client of f.state.clients) {
		expect(client.destroyCalls).toBe(client.returned ? 1 : 0);
		if (!client.returned) continue;
		expect(client.config.credentials.accessKeyId === "").toBe(true);
		expect(client.config.credentials.secretAccessKey === "").toBe(true);
		expect(client.config.credentials.sessionToken === undefined).toBe(true);
	}
	for (const bytes of f.state.readBuffers) expect(bytes.every(byte => byte === 0)).toBe(true);
	if (f.state.inputReference) expect(f.state.inputReference.every(byte => byte === 0)).toBe(true);
}

async function runSuccessfully(f: Fixture): Promise<AwsSecretInputScopeResult> {
	try {
		return await f.run();
	} catch {
		throw new Error("Synthetic private scope did not complete");
	}
}

function expectNoPrivateDiagnostics(value: unknown): void {
	const binary = Buffer.from(syntheticBinary());
	const markers = [
		SYNTHETIC_ACCESS_KEY_ID,
		SYNTHETIC_SECRET_ACCESS_KEY,
		SYNTHETIC_SESSION_TOKEN,
		SYNTHETIC_SECRET_TEXT,
		SYNTHETIC_DIAGNOSTIC,
		binary.toString("base64"),
		binary.toString("hex"),
	].flatMap(marker => [marker, JSON.stringify(marker).slice(1, -1)]);
	const seen = new Set<object>();
	const visit = (item: unknown): void => {
		if (typeof item === "string" || typeof item === "symbol") {
			expect(
				markers.some(marker => String(item).includes(marker)),
				"scope failure must not expose private diagnostic text",
			).toBe(false);
			return;
		}
		if (item === null || (typeof item !== "object" && typeof item !== "function") || seen.has(item)) return;
		seen.add(item);
		for (const key of ["cause", "response", "$metadata"]) {
			expect(Reflect.has(item, key), "scope failure must not retain provider diagnostic properties").toBe(false);
		}
		const bytes =
			item instanceof ArrayBuffer
				? Buffer.from(item)
				: ArrayBuffer.isView(item)
					? Buffer.from(item.buffer)
					: Array.isArray(item) && item.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
						? Buffer.from(item)
						: undefined;
		expect(bytes?.includes(binary) ?? false, "scope failure must not expose private diagnostic bytes").toBe(false);
		for (const key of Reflect.ownKeys(item)) {
			visit(key);
			let exposed: unknown;
			try {
				exposed = Reflect.get(item, key);
			} catch (error) {
				exposed = error;
			}
			visit(exposed);
		}
	};
	visit(value);
}

async function rejectsSafely(f: Fixture, code: AwsSecretInputFailureCode): Promise<void> {
	let caught: unknown;
	try {
		await f.run();
	} catch (error) {
		caught = error;
	}
	expect(caught instanceof AwsSecretInputFailure, "scope must return a fixed failure").toBe(true);
	if (!(caught instanceof AwsSecretInputFailure)) throw new Error("Expected fixed scope failure");
	expect(caught.code === code, "scope failure code differs").toBe(true);
	expect(caught.message === code, "scope must withhold private diagnostics").toBe(true);
	expect(caught === f.state.failure, "scope must not return the original private exception").toBe(false);
	expectNoPrivateDiagnostics(caught);
	expectReleased(f);
}

for (const input of exactInputCases()) {
	test(`private scope delivers exact ${input.name}`, async () => {
		const f = fixture();
		delete f.secret.SecretString;
		if (input.secretString !== undefined) f.secret.SecretString = input.secretString;
		if (input.secretBinary !== undefined) f.secret.SecretBinary = input.secretBinary;
		if (input.jsonPointer !== undefined) f.request.secretInput.jsonPointer = input.jsonPointer;
		if (input.appendNewline !== undefined) f.request.secretInput.appendNewline = input.appendNewline;
		await runSuccessfully(f);
		expectInput(f, input.expected);
		expect(f.state.operations).toEqual(["identity", "secret"]);
		expect(f.state.consumerCalls).toBe(1);
		const publicDelivery = JSON.stringify({
			argv: f.state.consumerArgv,
			cwd: f.state.consumerOptions?.cwd,
			env: f.state.consumerOptions?.env,
		});
		for (const marker of [
			SYNTHETIC_ACCESS_KEY_ID,
			SYNTHETIC_SECRET_ACCESS_KEY,
			SYNTHETIC_SESSION_TOKEN,
			SYNTHETIC_SECRET_TEXT,
		]) {
			expect(
				publicDelivery.includes(marker) || publicDelivery.includes(JSON.stringify(marker).slice(1, -1)),
				"private material must not enter consumer argv or environment",
			).toBe(false);
		}
		expect(
			JSON.stringify(f.state.consumerArgv) === JSON.stringify(f.request.secretInput.consumer.argv),
			"consumer argv must contain only the approved public arguments",
		).toBe(true);
		expect(Object.keys(f.state.consumerOptions?.env ?? {}).some(key => key.startsWith("AWS_"))).toBe(false);
		expectReleased(f);
	});
}

test("private scope releases provider ownership before delivering independent binary bytes", async () => {
	const f = fixture();
	const original = syntheticBinary();
	const expected = syntheticBinary();
	delete f.secret.SecretString;
	f.secret.SecretBinary = original;
	const captureConsumer = f.dependencies.executeConsumer!;
	let sourceReleasedBeforeDelivery = false;
	let clientsDisposedBeforeDelivery = false;
	let credentialsReleasedBeforeDelivery = false;
	let providerReleasedBeforeAdmission = false;
	f.state.onAdmission = async () => {
		providerReleasedBeforeAdmission =
			f.secret.SecretBinary === undefined &&
			original.every(byte => byte === 0) &&
			f.state.clients.length === 2 &&
			f.state.clients.every(
				client =>
					client.destroyCalls === 1 &&
					client.config.credentials.accessKeyId === "" &&
					client.config.credentials.secretAccessKey === "" &&
					client.config.credentials.sessionToken === undefined,
			);
	};
	f.dependencies.executeConsumer = async (argv, options) => {
		sourceReleasedBeforeDelivery =
			f.secret.SecretBinary === undefined &&
			f.secret.SecretString === undefined &&
			original.every(byte => byte === 0);
		clientsDisposedBeforeDelivery =
			f.state.clients.length === 2 && f.state.clients.every(client => client.returned && client.destroyCalls === 1);
		credentialsReleasedBeforeDelivery = f.state.clients.every(
			client =>
				client.config.credentials.accessKeyId === "" &&
				client.config.credentials.secretAccessKey === "" &&
				client.config.credentials.sessionToken === undefined,
		);
		return captureConsumer(argv, options);
	};
	await runSuccessfully(f);
	expect(sourceReleasedBeforeDelivery, "provider response must be released before consumer entry").toBe(true);
	expect(clientsDisposedBeforeDelivery, "SDK clients must be disposed before consumer entry").toBe(true);
	expect(credentialsReleasedBeforeDelivery, "SDK credentials must be released before consumer entry").toBe(true);
	expect(providerReleasedBeforeAdmission, "consumer admission must follow selection and provider release").toBe(true);
	expect(f.state.admissionCalls).toBe(1);
	expectInput(f, expected);
	expect(f.state.operations).toEqual(["identity", "secret"]);
	expect(f.state.consumerCalls).toBe(1);
	expectReleased(f);
});

test("private scope cannot start a consumer when final admission denies selected input", async () => {
	const f = fixture();
	f.state.onAdmission = async () => {
		throw Object.assign(new AwsSecretInputFailure("POLICY_DENIED"), {
			message: SYNTHETIC_DIAGNOSTIC,
			cause: leakyFailure(),
			response: { SecretString: SYNTHETIC_SECRET_TEXT },
		});
	};
	await rejectsSafely(f, "POLICY_DENIED");
	expect(f.state.operations).toEqual(["identity", "secret"]);
	expect(f.state.admissionCalls).toBe(1);
	expect(f.state.consumerCalls).toBe(0);
	expect(f.state.inputAtDelivery === undefined, "denied input must not reach the consumer").toBe(true);
});

for (const input of rejectedPointerCases()) {
	test(`private scope withholds ${input.name}`, async () => {
		const f = fixture();
		delete f.secret.SecretString;
		if (input.secretString !== undefined) f.secret.SecretString = input.secretString;
		if (input.secretBinary !== undefined) f.secret.SecretBinary = input.secretBinary;
		f.request.secretInput.jsonPointer = input.jsonPointer;
		await rejectsSafely(f, input.invalidRequest ? "INVALID_REQUEST" : "INPUT_SELECTION_FAILED");
		expect(f.state.operations).toEqual(input.invalidRequest ? [] : ["identity", "secret"]);
		expect(f.state.consumerCalls).toBe(0);
		expect(f.state.admissionCalls).toBe(0);
		if (input.invalidRequest) expect(f.state.readPaths).toEqual([]);
	});
}

for (const input of boundaryInputCases(AWS_SECRET_INPUT_LIMITS.maxInputBytes)) {
	test(`private scope enforces ${input.name}`, async () => {
		const f = fixture();
		delete f.secret.SecretString;
		if (input.secretString !== undefined) f.secret.SecretString = input.secretString;
		if (input.secretBinary !== undefined) f.secret.SecretBinary = input.secretBinary;
		if (input.jsonPointer !== undefined) f.request.secretInput.jsonPointer = input.jsonPointer;
		f.request.secretInput.appendNewline = input.appendNewline;
		if (input.rejected) {
			await rejectsSafely(f, "INPUT_LIMIT_EXCEEDED");
			expect(f.state.consumerCalls).toBe(0);
			expect(f.state.admissionCalls).toBe(0);
		} else {
			await runSuccessfully(f);
			expectInput(f, input.expected);
			expect(f.state.consumerCalls).toBe(1);
			expectReleased(f);
		}
		expect(f.state.operations).toEqual(["identity", "secret"]);
	});
}

const identityMismatches: readonly [string, (f: Fixture) => void][] = [
	[
		"account",
		f => {
			f.identity.Account = "999999999999";
		},
	],
	[
		"principal",
		f => {
			f.identity.Arn = `${f.request.secretInput.expectedIdentity.arn}-other`;
		},
	],
	[
		"partition",
		f => {
			f.identity.Arn = f.request.secretInput.expectedIdentity.arn.replace("arn:aws:", "arn:aws-us-gov:");
		},
	],
	[
		"missing principal",
		f => {
			delete f.identity.Arn;
		},
	],
	[
		"inherited account",
		f => {
			delete f.identity.Account;
			Object.setPrototypeOf(f.identity, { Account: f.request.secretInput.expectedIdentity.account });
		},
	],
];

for (const [name, change] of identityMismatches) {
	test(`private scope rejects ${name} identity before fetching a secret`, async () => {
		const f = fixture();
		change(f);
		await rejectsSafely(f, "IDENTITY_MISMATCH");
		expect(f.state.operations).toEqual(["identity"]);
		expect(f.state.consumerCalls).toBe(0);
	});
}

const secretMismatches: readonly [string, (f: Fixture) => void][] = [
	[
		"secret ARN",
		f => {
			f.secret.ARN = `${f.request.parameters.SecretId}-other`;
		},
	],
	[
		"secret partition",
		f => {
			f.secret.ARN = f.request.parameters.SecretId.replace("arn:aws:", "arn:aws-cn:");
		},
	],
	[
		"secret region",
		f => {
			f.secret.ARN = f.request.parameters.SecretId.replace("us-east-1", "us-west-2");
		},
	],
	[
		"missing secret ARN",
		f => {
			delete f.secret.ARN;
		},
	],
	[
		"secret version",
		f => {
			f.secret.VersionId = "fedcba98-7654-3210-fedc-ba9876543210";
		},
	],
	[
		"missing secret version",
		f => {
			delete f.secret.VersionId;
		},
	],
	[
		"secret stage",
		f => {
			f.secret.VersionStages = ["AWSPREVIOUS"];
		},
	],
	[
		"missing requested stage",
		f => {
			delete f.secret.VersionStages;
		},
	],
	[
		"duplicate secret stages",
		f => {
			f.secret.VersionStages = ["AWSCURRENT", "AWSCURRENT"];
		},
	],
	[
		"malformed secret stages",
		f => {
			f.secret.VersionStages = ["AWSCURRENT", 1];
		},
	],
	[
		"ambiguous string and binary",
		f => {
			f.secret.SecretBinary = syntheticBinary();
		},
	],
	[
		"ambiguous empty string and binary",
		f => {
			f.secret.SecretString = "";
			f.secret.SecretBinary = new Uint8Array();
		},
	],
	[
		"missing string and binary",
		f => {
			delete f.secret.SecretString;
		},
	],
	[
		"non-string SecretString",
		f => {
			f.secret.SecretString = null;
		},
	],
	[
		"non-byte SecretBinary",
		f => {
			delete f.secret.SecretString;
			f.secret.SecretBinary = [0, 255];
		},
	],
];

for (const [name, change] of secretMismatches) {
	test(`private scope rejects ${name} before delivering stdin`, async () => {
		const f = fixture();
		change(f);
		await rejectsSafely(f, "SECRET_MISMATCH");
		expect(f.state.operations).toEqual(["identity", "secret"]);
		expect(f.state.consumerCalls).toBe(0);
	});
}

test("private scope binds an explicit non-current stage without adding an implicit default", async () => {
	for (const stage of ["scope-release", undefined]) {
		const f = fixture();
		if (stage === undefined) {
			delete f.request.parameters.VersionStage;
			delete f.secret.VersionStages;
		} else {
			f.request.parameters.VersionStage = stage;
			f.secret.VersionStages = [stage];
		}
		await runSuccessfully(f);
		const command = f.state.commands.find(value => value instanceof GetSecretValueCommand);
		expect(command).toBeInstanceOf(GetSecretValueCommand);
		if (!(command instanceof GetSecretValueCommand)) throw new Error("Missing pinned secret operation");
		expect(command.input.SecretId).toBe(f.request.parameters.SecretId);
		expect(command.input.VersionId).toBe(f.request.parameters.VersionId);
		expect(command.input.VersionStage).toBe(stage);
		expectInput(f, new TextEncoder().encode(SYNTHETIC_SECRET_TEXT));
		expect(f.state.operations).toEqual(["identity", "secret"]);
		expect(f.state.consumerCalls).toBe(1);
		expectReleased(f);
	}
});

interface FailureCase {
	name: string;
	code: AwsSecretInputFailureCode;
	change(f: Fixture): void;
	operations: Operation[];
	created: AwsSecretInputService[];
	consumers: number;
}

const failures: readonly FailureCase[] = [
	{
		name: "config provider failure",
		code: "PROFILE_UNSUPPORTED",
		change: f => {
			f.state.readFailure = f.launch.configFile!;
		},
		operations: [],
		created: [],
		consumers: 0,
	},
	{
		name: "credential provider failure",
		code: "PROFILE_UNSUPPORTED",
		change: f => {
			f.state.readFailure = f.launch.sharedCredentialsFile!;
		},
		operations: [],
		created: [],
		consumers: 0,
	},
	{
		name: "identity client construction failure",
		code: "AWS_FAILED",
		change: f => {
			f.state.createFailure = "sts";
		},
		operations: [],
		created: ["sts"],
		consumers: 0,
	},
	{
		name: "secret client construction failure",
		code: "AWS_FAILED",
		change: f => {
			f.state.createFailure = "secretsmanager";
		},
		operations: ["identity"],
		created: ["sts", "secretsmanager"],
		consumers: 0,
	},
	{
		name: "identity SDK failure",
		code: "AWS_FAILED",
		change: f => {
			f.state.sendFailure = "identity";
		},
		operations: ["identity"],
		created: ["sts"],
		consumers: 0,
	},
	{
		name: "secret SDK failure",
		code: "AWS_FAILED",
		change: f => {
			f.state.sendFailure = "secret";
		},
		operations: ["identity", "secret"],
		created: ["sts", "secretsmanager"],
		consumers: 0,
	},
	{
		name: "AWS denial",
		code: "AWS_ACCESS_DENIED",
		change: f => {
			f.state.sendFailure = "secret";
			f.state.failure.name = "AccessDeniedException";
		},
		operations: ["identity", "secret"],
		created: ["sts", "secretsmanager"],
		consumers: 0,
	},
	{
		name: "expired AWS credentials",
		code: "AUTH_REQUIRED",
		change: f => {
			f.state.sendFailure = "identity";
			f.state.failure.name = "ExpiredTokenException";
		},
		operations: ["identity"],
		created: ["sts"],
		consumers: 0,
	},
	{
		name: "consumer start failure",
		code: "CONSUMER_FAILED",
		change: f => {
			f.state.consumerFailure = true;
		},
		operations: ["identity", "secret"],
		created: ["sts", "secretsmanager"],
		consumers: 1,
	},
];

for (const failure of failures) {
	test(`private scope withholds private diagnostics for ${failure.name} and never retries`, async () => {
		const f = fixture();
		failure.change(f);
		await rejectsSafely(f, failure.code);
		expect(f.state.operations).toEqual(failure.operations);
		expect(f.state.clients.map(client => client.service)).toEqual(failure.created);
		expect(f.state.consumerCalls).toBe(failure.consumers);
	});
}

test("private scope does not preserve private diagnostics attached to an otherwise recognized failure", async () => {
	const f = fixture();
	f.state.consumerFailure = true;
	f.state.failure = Object.assign(new AwsSecretInputFailure("AWS_FAILED"), {
		message: SYNTHETIC_DIAGNOSTIC,
		cause: leakyFailure(),
		response: { SecretString: SYNTHETIC_SECRET_TEXT },
	});
	await rejectsSafely(f, "CONSUMER_FAILED");
	expect(f.state.operations).toEqual(["identity", "secret"]);
	expect(f.state.consumerCalls).toBe(1);
});

for (const provider of ["explicit-static", "existing-unexpired-sso"] as const) {
	test(`private scope uses ${provider} for an exactly approved cross-account secret`, async () => {
		const f = fixture();
		f.request.parameters.SecretId = f.request.parameters.SecretId.replace("123456789012", "210987654321");
		f.secret.ARN = f.request.parameters.SecretId;
		const expected =
			provider === "explicit-static" ? new TextEncoder().encode(SYNTHETIC_SECRET_TEXT) : syntheticBinary();
		if (provider === "existing-unexpired-sso") {
			configureSso(f);
			delete f.secret.SecretString;
			f.secret.SecretBinary = syntheticBinary();
		}
		const attempts = useInMemorySdk(f);
		await runSuccessfully(f);
		expect(attempts.map(attempt => attempt.service)).toEqual(
			provider === "explicit-static" ? ["sts", "secretsmanager"] : ["sso", "sts", "secretsmanager"],
		);
		const hostnames: Record<AwsSecretInputService, string> = {
			sts: "sts.us-east-1.amazonaws.com",
			secretsmanager: "secretsmanager.us-east-1.amazonaws.com",
			sso: "portal.sso.us-east-1.amazonaws.com",
		};
		for (const attempt of attempts) {
			expect(attempt.hostname).toBe(hostnames[attempt.service]);
			expect(attempt.protocol).toBe("https:");
			expect(attempt.fixtureCredentials).toBe(true);
		}
		expect(
			attempts.find(attempt => attempt.service === "secretsmanager")?.secretReference === true,
			"serialized SDK request must retain the approved cross-account ARN and version",
		).toBe(true);
		if (provider === "existing-unexpired-sso") {
			expect(
				attempts.find(attempt => attempt.service === "sso")?.ssoActorAccount === true,
				"SSO role credentials must use the actor account, not the secret account",
			).toBe(true);
		}
		expectInput(f, expected);
		expect(f.state.consumerCalls).toBe(1);
		expect(f.state.operations).toEqual(
			provider === "explicit-static" ? ["identity", "secret"] : ["sso", "identity", "secret"],
		);
		expectReleased(f);
	});
}

for (const [name, account] of [
	["actor-account", "123456789012"],
	["third-account", "999999999999"],
] as const) {
	test(`private scope rejects an unapproved ${name} response for a cross-account reference`, async () => {
		const f = fixture();
		f.request.parameters.SecretId = f.request.parameters.SecretId.replace("123456789012", "210987654321");
		f.secret.ARN = f.request.parameters.SecretId.replace("210987654321", account);
		const attempts = useInMemorySdk(f);
		await rejectsSafely(f, "SECRET_MISMATCH");
		expect(attempts.find(attempt => attempt.service === "secretsmanager")?.secretReference === true).toBe(true);
		expect(f.state.operations).toEqual(["identity", "secret"]);
		expect(f.state.admissionCalls).toBe(0);
		expect(f.state.consumerCalls).toBe(0);
	});
}

for (const service of ["sts", "secretsmanager", "sso"] as const) {
	test(`private scope never retries an actual ${service} SDK retryable response`, async () => {
		const f = fixture();
		if (service === "sso") configureSso(f);
		const attempts = useInMemorySdk(f, service);
		await rejectsSafely(f, "AWS_FAILED");
		expect(attempts.map(attempt => attempt.service)).toEqual(
			service === "secretsmanager" ? ["sts", "secretsmanager"] : [service],
		);
		expect(f.state.operations).toEqual(
			service === "secretsmanager" ? ["identity", "secret"] : service === "sts" ? ["identity"] : ["sso"],
		);
		expect(f.state.consumerCalls).toBe(0);
	});
}

test("private scope rejects expired SSO before any SDK request without refresh or fallback", async () => {
	const f = fixture();
	const cache = configureSso(f, FIXTURE_NOW);
	const attempts = useInMemorySdk(f);
	await rejectsSafely(f, "AUTH_REQUIRED");
	expect(attempts).toEqual([]);
	expect(f.state.operations).toEqual([]);
	expect(f.state.consumerCalls).toBe(0);
	expect(f.state.readPaths).toEqual([f.launch.configFile!, f.launch.sharedCredentialsFile!, cache]);
});

const opaqueSsoStartUrl = "https://scope-fixture.awsapps.com/access-portal/../launch/%7eoperator";

for (const [name, startUrl, overlap] of [
	["portal", SSO_START_URL, `sso_start_url = ${SSO_START_URL}`],
	["region", SSO_START_URL, "sso_region = us-east-1"],
	["portal and region", SSO_START_URL, `sso_start_url = ${SSO_START_URL}\nsso_region = us-east-1`],
	["opaque portal and region", opaqueSsoStartUrl, `sso_start_url = ${opaqueSsoStartUrl}\nsso_region = us-east-1`],
] as const) {
	test(`private scope delivers input when legacy ${name} settings exactly match the SSO session`, async () => {
		const f = fixture();
		const cache = configureSso(f, FIXTURE_NOW + 60_000, { startUrl });
		f.files.set(
			f.launch.configFile!,
			f.files.get(f.launch.configFile!)!.replace("[profile scope-fixture]", `[profile scope-fixture]\n${overlap}`),
		);
		const attempts = useInMemorySdk(f);
		await runSuccessfully(f);
		expect(attempts.map(attempt => attempt.service)).toEqual(["sso", "sts", "secretsmanager"]);
		expect(attempts.every(attempt => attempt.fixtureCredentials)).toBe(true);
		expect(f.state.readPaths).toEqual([f.launch.configFile!, f.launch.sharedCredentialsFile!, cache]);
		expectInput(f, new TextEncoder().encode(SYNTHETIC_SECRET_TEXT));
		expect(f.state.consumerCalls).toBe(1);
		expectReleased(f);
	});
}

for (const legacy of [false, true]) {
	const provider = legacy ? "legacy" : "session";
	test(`private scope preserves the opaque ${provider} portal and cache identity through stdin delivery`, async () => {
		const f = fixture();
		const cache = configureSso(f, FIXTURE_NOW + 60_000, { startUrl: opaqueSsoStartUrl, legacy });
		const attempts = useInMemorySdk(f);
		await runSuccessfully(f);
		expect(attempts.map(attempt => [attempt.service, attempt.hostname, attempt.protocol])).toEqual([
			["sso", "portal.sso.us-east-1.amazonaws.com", "https:"],
			["sts", "sts.us-east-1.amazonaws.com", "https:"],
			["secretsmanager", "secretsmanager.us-east-1.amazonaws.com", "https:"],
		]);
		expect(attempts.every(attempt => attempt.fixtureCredentials)).toBe(true);
		expect(f.state.readPaths).toEqual([f.launch.configFile!, f.launch.sharedCredentialsFile!, cache]);
		expectInput(f, new TextEncoder().encode(SYNTHETIC_SECRET_TEXT));
		expect(f.state.consumerCalls).toBe(1);
		expectReleased(f);
	});

	test(`private scope rejects a normalized cached portal for the raw ${provider} portal before SDK access`, async () => {
		const f = fixture();
		const cache = configureSso(f, FIXTURE_NOW + 60_000, { startUrl: opaqueSsoStartUrl, legacy });
		f.files.set(cache, syntheticSsoToken(FIXTURE_NOW + 60_000, new URL(opaqueSsoStartUrl).href));
		const attempts = useInMemorySdk(f);
		await rejectsSafely(f, "AUTH_REQUIRED");
		expect(attempts).toEqual([]);
		expect(f.state.readPaths).toEqual([f.launch.configFile!, f.launch.sharedCredentialsFile!, cache]);
		expect(f.state.admissionCalls).toBe(0);
		expect(f.state.consumerCalls).toBe(0);
	});
}

for (const [name, overlap] of [
	["portal authority", "sso_start_url = https://other-fixture.awsapps.com/start"],
	["normalized-equivalent portal", "sso_start_url = https://SCOPE-FIXTURE.awsapps.com/start"],
	["portal path", `sso_start_url = ${SSO_START_URL}/`],
	["region", "sso_region = us-west-2"],
] as const) {
	test(`private scope rejects conflicting legacy SSO ${name} before credentials or SDK access`, async () => {
		const f = fixture();
		configureSso(f);
		f.files.set(
			f.launch.configFile!,
			SSO_PROFILE_CONFIG.replace("[profile scope-fixture]", `[profile scope-fixture]\n${overlap}`),
		);
		const attempts = useInMemorySdk(f);
		await rejectsSafely(f, "PROFILE_UNSUPPORTED");
		expect(attempts).toEqual([]);
		expect(f.state.readPaths).toEqual([f.launch.configFile!]);
		expect(f.state.admissionCalls).toBe(0);
		expect(f.state.consumerCalls).toBe(0);
	});
}

for (const [name, startUrl] of [
	["HTTP scheme", "http://scope-fixture.awsapps.com/access-portal"],
	["non-HTTP scheme", "file://scope-fixture.awsapps.com/access-portal"],
	["non-AWS authority", "https://scope-fixture.invalid/access-portal"],
	["suffix lookalike", "https://scope-fixture.awsapps.com.invalid/access-portal"],
	["bare suffix", "https://awsapps.com/access-portal"],
	["other partition authority", "https://scope-fixture.awsapps.cn/access-portal"],
	["username", "https://operator@scope-fixture.awsapps.com/access-portal"],
	["password", "https://:synthetic@scope-fixture.awsapps.com/access-portal"],
	["port", "https://scope-fixture.awsapps.com:8443/access-portal"],
	["query", "https://scope-fixture.awsapps.com/access-portal?redirect=invalid"],
	["fragment", "https://scope-fixture.awsapps.com/access-portal#invalid"],
] as const) {
	test(`private scope rejects an unsafe SSO portal ${name} despite matching overlap`, async () => {
		const f = fixture();
		configureSso(f, FIXTURE_NOW + 60_000, { startUrl });
		const config = f.files.get(f.launch.configFile!)!;
		f.files.set(
			f.launch.configFile!,
			config.replace(
				"[profile scope-fixture]",
				`[profile scope-fixture]\nsso_start_url = ${startUrl}\nsso_region = us-east-1`,
			),
		);
		const attempts = useInMemorySdk(f);
		await rejectsSafely(f, "PROFILE_UNSUPPORTED");
		expect(attempts).toEqual([]);
		expect(f.state.readPaths).toEqual([f.launch.configFile!]);
		expect(f.state.admissionCalls).toBe(0);
		expect(f.state.consumerCalls).toBe(0);
	});
}

const rejectedSsoSettings: readonly [string, (config: string) => string][] = [
	["missing session", config => config.replace(`sso_session = ${SSO_SESSION_NAME}`, "sso_session = absent-session")],
	["unknown session setting", config => `${config}endpoint_url = https://never-connect.invalid\n`],
	["unsupported session scope", config => `${config}sso_registration_scopes = sso:unsupported\n`],
	[
		"missing session portal with a legacy value",
		config =>
			config
				.replace(`sso_start_url = ${SSO_START_URL}\n`, "")
				.replace("[profile scope-fixture]", `[profile scope-fixture]\nsso_start_url = ${SSO_START_URL}`),
	],
	[
		"missing session region with a legacy value",
		config =>
			config
				.replace("sso_region = us-east-1\n", "")
				.replace("[profile scope-fixture]", "[profile scope-fixture]\nsso_region = us-east-1"),
	],
	[
		"static credential mixing",
		config =>
			config.replace(
				"[profile scope-fixture]",
				`[profile scope-fixture]\naws_access_key_id = ${SYNTHETIC_ACCESS_KEY_ID}`,
			),
	],
];

for (const [name, change] of rejectedSsoSettings) {
	test(`private scope rejects ${name} before credentials or SDK access`, async () => {
		const f = fixture();
		configureSso(f);
		f.files.set(f.launch.configFile!, change(SSO_PROFILE_CONFIG));
		const attempts = useInMemorySdk(f);
		await rejectsSafely(f, "PROFILE_UNSUPPORTED");
		expect(attempts).toEqual([]);
		expect(f.state.readPaths).toEqual([f.launch.configFile!]);
		expect(f.state.admissionCalls).toBe(0);
		expect(f.state.consumerCalls).toBe(0);
	});
}

test("private scope accepts an explicit profile with unrelated standard service configuration", async () => {
	const f = fixture();
	f.files.set(f.launch.configFile!, STATIC_PROFILE_WITH_UNRELATED_SERVICES);
	const attempts = useInMemorySdk(f);
	await runSuccessfully(f);
	expect(attempts.map(attempt => attempt.service)).toEqual(["sts", "secretsmanager"]);
	expect(
		attempts.every(
			attempt =>
				attempt.fixtureCredentials &&
				attempt.protocol === "https:" &&
				attempt.hostname === `${attempt.service}.us-east-1.amazonaws.com`,
		),
		"unrelated service configuration must not replace the signed AWS target",
	).toBe(true);
	expectInput(f, new TextEncoder().encode(SYNTHETIC_SECRET_TEXT));
	expect(f.state.consumerCalls).toBe(1);
	expectReleased(f);
});

for (const [name, setting] of [
	["credential_process", "credential_process = /never-run-scope-credential-process"],
	["role source", "role_arn = arn:aws:iam::123456789012:role/other-role\nsource_profile = other-profile"],
	["environment credential source", "credential_source = Environment"],
	["web identity source", "web_identity_token_file = /never-read-scope-web-identity"],
	["endpoint override", "endpoint_url = https://never-connect.invalid"],
	[
		"selected service endpoint",
		STATIC_PROFILE_WITH_UNRELATED_SERVICES.replace(STATIC_PROFILE_CONFIG, "services = local\n"),
	],
] as const) {
	test(`private scope rejects unsupported ${name} provenance before any SDK request`, async () => {
		const f = fixture();
		f.files.set(f.launch.configFile!, `${STATIC_PROFILE_CONFIG}${setting}\n`);
		const attempts = useInMemorySdk(f);
		await rejectsSafely(f, "PROFILE_UNSUPPORTED");
		expect(attempts).toEqual([]);
		expect(f.state.operations).toEqual([]);
		expect(f.state.consumerCalls).toBe(0);
	});
}

test("private scope does not fall back to default profiles when the selected profile is missing", async () => {
	const f = fixture();
	f.files.set(f.launch.configFile!, STATIC_PROFILE_CONFIG.replace("profile scope-fixture", "default"));
	f.files.set(f.launch.sharedCredentialsFile!, STATIC_PROFILE_CREDENTIALS.replace("[scope-fixture]", "[default]"));
	const attempts = useInMemorySdk(f);
	await rejectsSafely(f, "AUTH_REQUIRED");
	expect(attempts).toEqual([]);
	expect(f.state.operations).toEqual([]);
	expect(f.state.consumerCalls).toBe(0);
});

test("private scope rejects a configured profile partition that differs from the approved identity", async () => {
	const f = fixture();
	f.files.set(f.launch.configFile!, STATIC_PROFILE_CONFIG.replace("us-east-1", "cn-north-1"));
	const attempts = useInMemorySdk(f);
	await rejectsSafely(f, "PROFILE_UNSUPPORTED");
	expect(attempts).toEqual([]);
	expect(f.state.operations).toEqual([]);
	expect(f.state.consumerCalls).toBe(0);
});

test("private scope cannot use a reserved model profile as an operational provider", async () => {
	const f = fixture();
	f.launch.reservedProfiles = [f.request.profile];
	const attempts = useInMemorySdk(f);
	await rejectsSafely(f, "PROFILE_UNSUPPORTED");
	expect(attempts).toEqual([]);
	expect(f.state.readPaths).toEqual([]);
	expect(f.state.consumerCalls).toBe(0);
});

test.skipIf(process.platform === "win32")(
	"real finite stdin consumer can write synthetic data and deliberately return raw stdout and stderr",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "aws-secret-input-scope-"));
		try {
			const statePath = join(root, "public-state.json");
			await writeFile(statePath, JSON.stringify({ counter: 2, writes: 0 }));
			const f = fixture();
			f.request.timeout = 10;
			f.request.secretInput.consumer = {
				argv: [process.execPath, "--no-env-file", "--no-install", consumerFixture, statePath],
				cwd: root,
			};
			f.secret.SecretString = WRITABLE_INPUT;
			const producerObserver = createStdinProducerWitnessObserver();
			let producerWitness: Promise<StdinProducerWitness | undefined> | undefined;
			let spawned: { pid: number; receiverPid: number; workerPid: number } | undefined;

			f.dependencies.executeConsumer = async (argv, options) => {
				if (!(options?.input instanceof Uint8Array)) throw new Error("Expected finite synthetic stdin bytes");
				producerObserver.begin(options.input);
				f.state.inputReference = options.input;
				const originalSpawn = Bun.spawn;
				try {
					Bun.spawn = new Proxy(originalSpawn, {
						apply(target, receiver, args) {
							const bind = producerObserver.captureSpawn(args[1]);

							const child = Reflect.apply(target, receiver, args);

							const observedChild = bind(child);

							return observedChild;
						},
					});
					return await ptree.exec(argv, options);
				} finally {
					Bun.spawn = originalSpawn;
					await producerObserver.end();
				}
			};
			let starts = 0;
			f.dependencies.onConsumerSpawn = child => {
				starts++;
				const identity = child.ownedInputIdentity;
				if (!identity || identity.receiverPid === null)
					throw new Error("Synthetic consumer identity is unavailable");
				spawned = { pid: identity.pid, receiverPid: identity.receiverPid, workerPid: process.pid };
				producerWitness = producerObserver.witnessFor(identity.pid, identity.receiverPid);
			};
			const result = await runSuccessfully(f);
			const received = JSON.parse(await readFile(scopeStdinReceiptPath(statePath), "utf8")) as {
				stdinPrivateChannel: unknown;
			};
			expect(
				isVerifiedFiniteStdinHandoff(received.stdinPrivateChannel, await producerWitness, received, spawned),
				"finite stdin requires exact input through EOF and the actual producer identity",
			).toBe(true);
			expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ counter: 9, writes: 1 });
			expect(result.stdout).toBe(PUBLIC_CONSUMER_STDOUT);
			expect(result.stderr).toBe(PUBLIC_CONSUMER_STDERR);
			expect(result.exitCode).toBe(0);
			expect(result.completion).toBe("exited");
			expect(result.stdoutTruncated).toBe(false);
			expect(result.stderrTruncated).toBe(false);
			expect(starts).toBe(1);
			expect(f.state.operations).toEqual(["identity", "secret"]);
			expectReleased(f);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	20_000,
);
