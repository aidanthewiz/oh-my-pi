import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Agent } from "node:https";
import { isAbsolute, join } from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetRoleCredentialsCommand, SSOClient } from "@aws-sdk/client-sso";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
	AwsSecretInputFailure,
	awsSecretInputRegionPartition,
	awsSecretInputTimeoutMs,
	safeAwsSecretInputFailure,
	type AwsSecretInputRequest,
} from "./aws-secret-input-contract";

export const AWS_SECRET_INPUT_PROVIDER_POLICY_ID = "read-only-explicit-static-sso/v1";
export interface AwsSecretInputLaunchFiles {
	configFile?: string;
	sharedCredentialsFile?: string;
	homeDir: string;
	reservedProfiles: readonly string[];
	runtimeDirectory?: string;
}
export interface AwsSecretInputStep {
	service: "sts" | "secretsmanager" | "sso";
	operation: "get-caller-identity" | "get-secret-value" | "get-role-credentials";
	resource?: string;
	roleName?: string;
	region?: string;
}
export type AwsSecretInputAuthorize = (step: AwsSecretInputStep) => Promise<void>;
export type AwsSecretInputService = AwsSecretInputStep["service"];
export type AwsSecretInputCommand = GetCallerIdentityCommand | GetSecretValueCommand | GetRoleCredentialsCommand;
interface MemoryAwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	expiration?: Date;
}
export interface AwsSecretInputClientConfig {
	region: string;
	credentials: MemoryAwsCredentials;
	maxAttempts: 1;
	retryMode: "standard";
	ignoreConfiguredEndpointUrls: true;
	useFipsEndpoint: false;
	useDualstackEndpoint: false;
	endpointDiscoveryEnabled: false;
	defaultsMode: "standard";
	disableClockSkewCorrection: false;
	authSchemePreference: string[];
	sigv4aSigningRegionSet: string[];
	userAgentAppId: () => Promise<undefined>;
	logger: Record<"trace" | "debug" | "info" | "warn" | "error", (...args: unknown[]) => void>;
	requestHandler: { httpsAgent: Agent; connectionTimeout: number; requestTimeout: number };
}
export interface AwsSecretInputClient {
	send(command: AwsSecretInputCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
	destroy(): void;
}
export type AwsSecretInputClientFactory = (
	service: AwsSecretInputService,
	config: AwsSecretInputClientConfig,
) => AwsSecretInputClient;
export type AwsSecretInputFileReader = (path: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
export interface AwsSecretInputProviderDependencies {
	readFile?: AwsSecretInputFileReader;
	createClient?: AwsSecretInputClientFactory;
	now?: () => number;
}
const MAX_INI_BYTES = 262_144;
const MAX_TOKEN_BYTES = 65_536;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_+=,.@ -]{0,127}$/u;
const PROFILE_KEYS: Readonly<Record<string, true>> = {
	region: true,
	output: true,
	aws_access_key_id: true,
	aws_secret_access_key: true,
	aws_session_token: true,
	expiration: true,
	aws_session_expiration: true,
	sso_session: true,
	sso_start_url: true,
	sso_region: true,
	sso_account_id: true,
	sso_role_name: true,
};
const SESSION_KEYS: Readonly<Record<string, true>> = {
	sso_start_url: true,
	sso_region: true,
	sso_registration_scopes: true,
};
const TOKEN_KEYS: Readonly<Record<string, true>> = {
	accessToken: true,
	expiresAt: true,
	region: true,
	startUrl: true,
	clientId: true,
	clientSecret: true,
	registrationExpiresAt: true,
	refreshToken: true,
};
type Ini = Map<string, Map<string, string>>;
function createClient(service: AwsSecretInputService, config: AwsSecretInputClientConfig): AwsSecretInputClient {
	switch (service) {
		case "sts":
			return new STSClient(config) as unknown as AwsSecretInputClient;
		case "secretsmanager":
			return new SecretsManagerClient(config) as unknown as AwsSecretInputClient;
		case "sso":
			return new SSOClient(config) as unknown as AwsSecretInputClient;
	}
}
async function readBoundedFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	if (signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let buffer: Buffer | undefined;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		buffer = Buffer.alloc(maxBytes + 1);
		let size = 0;
		while (size < buffer.length) {
			if (signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
			const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
			if (bytesRead === 0) break;
			size += bytesRead;
		}
		if (size > maxBytes) throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		const result = buffer.subarray(0, size);
		buffer = undefined;
		return result;
	} finally {
		buffer?.fill(0);
		await file.close();
	}
}
function parseIni(text: string, kind: "config" | "credentials"): Ini {
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
		throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
	const result: Ini = new Map();
	let current: Map<string, string> | undefined;
	let services = false;
	for (const source of text.split(/\r?\n/u)) {
		if (source.length > 8_192) throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		const line = source.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			const section = /^\[([^[\]]+)\]$/u.exec(line)?.[1];
			if (!section) throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
			services = kind === "config" && section.startsWith("services ");
			if (services) {
				current = undefined;
				continue;
			}
			let name = section;
			if (kind === "config") {
				if (section.startsWith("profile ")) name = section.slice(8);
				else if (section.startsWith("sso-session ")) name = `sso-session:${section.slice(12)}`;
				else if (section !== "default") throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
			}
			if (
				!PROFILE_NAME.test(name.startsWith("sso-session:") ? name.slice(12) : name) ||
				result.has(name) ||
				result.size >= 512
			)
				throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
			current = new Map();
			result.set(name, current);
			continue;
		}
		if (services) continue;
		const setting = /^([a-zA-Z][a-zA-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
		if (!current || !setting) throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		const key = setting[1]!.toLowerCase();
		if (current.has(key) || current.size >= 64) throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		current.set(key, setting[2]!);
	}
	return result;
}
function clearIni(ini: Ini): void {
	for (const section of ini.values()) section.clear();
	ini.clear();
}
function parseToken(text: string): Record<string, string | number> {
	let offset = 0;
	const result: Record<string, string | number> = Object.create(null);
	const fail = (): never => {
		throw new AwsSecretInputFailure("AUTH_REQUIRED");
	};
	const space = () => {
		while (offset < text.length && /[\t\n\r ]/u.test(text[offset]!)) offset++;
	};
	const string = (): string => {
		if (text[offset++] !== '"') return fail();
		const start = offset - 1;
		while (offset < text.length) {
			const c = text[offset++];
			if (c === "\\") offset++;
			else if (c === '"') {
				try {
					return JSON.parse(text.slice(start, offset)) as string;
				} catch {
					return fail();
				}
			}
		}
		return fail();
	};
	try {
		space();
		if (text[offset++] !== "{") fail();
		space();
		if (text[offset] !== "}")
			for (;;) {
				const key = string();
				if (!Object.hasOwn(TOKEN_KEYS, key) || Object.hasOwn(result, key)) fail();
				space();
				if (text[offset++] !== ":") fail();
				space();
				if (text[offset] === '"') result[key] = string();
				else {
					const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(offset))?.[0];
					if (!number || !Number.isFinite(Number(number))) return fail();
					offset += number.length;
					result[key] = Number(number);
				}
				space();
				if (text[offset] !== ",") break;
				offset++;
				space();
			}
		if (text[offset++] !== "}") fail();
		space();
		if (offset !== text.length) fail();
		return result;
	} catch {
		for (const key of Object.keys(result)) delete result[key];
		return fail();
	}
}
export function releaseAwsSecretInputResponse(response: unknown): boolean {
	try {
		if (!response || typeof response !== "object") return true;
		if ("SecretString" in response) response.SecretString = undefined;
		if ("SecretBinary" in response) {
			if (response.SecretBinary instanceof Uint8Array) response.SecretBinary.fill(0);
			response.SecretBinary = undefined;
		}
		if ("roleCredentials" in response) {
			const credentials = response.roleCredentials;
			if (credentials && typeof credentials === "object")
				for (const key of ["accessKeyId", "secretAccessKey", "sessionToken", "expiration"])
					if (key in credentials) (credentials as Record<string, unknown>)[key] = key === "expiration" ? 0 : "";
			response.roleCredentials = undefined;
		}
		return true;
	} catch {
		return false;
	}
}
function safeAwsFailure(error: unknown, signal: AbortSignal): AwsSecretInputFailure {
	if (signal.aborted) return new AwsSecretInputFailure("CANCELLED");
	if (error instanceof AwsSecretInputFailure) return new AwsSecretInputFailure(safeAwsSecretInputFailure(error));
	let name: unknown;
	let status: unknown;
	try {
		if (error && typeof error === "object") {
			name = Object.getOwnPropertyDescriptor(error, "name")?.value;
			const metadata = Object.getOwnPropertyDescriptor(error, "$metadata")?.value;
			if (metadata && typeof metadata === "object")
				status = Object.getOwnPropertyDescriptor(metadata, "httpStatusCode")?.value;
		}
	} catch {}
	if (
		[
			"ExpiredToken",
			"ExpiredTokenException",
			"InvalidClientTokenId",
			"UnrecognizedClientException",
			"UnauthorizedException",
			"InvalidGrantException",
			"CredentialsProviderError",
		].includes(String(name))
	)
		return new AwsSecretInputFailure("AUTH_REQUIRED");
	if (status === 403 || ["AccessDenied", "AccessDeniedException", "ForbiddenException"].includes(String(name)))
		return new AwsSecretInputFailure("AWS_ACCESS_DENIED");
	return new AwsSecretInputFailure("AWS_FAILED");
}

export class AwsSecretInputProvider {
	readonly #readFile: AwsSecretInputFileReader;
	readonly #createClient: AwsSecretInputClientFactory;
	readonly #now: () => number;
	readonly #clients = new Map<AwsSecretInputService, AwsSecretInputClient>();
	readonly #agents = new Set<Agent>();
	readonly #credentials: MemoryAwsCredentials = { accessKeyId: "", secretAccessKey: "" };
	readonly #anonymous: MemoryAwsCredentials = { accessKeyId: "", secretAccessKey: "" };
	#config: Ini = new Map();
	#ssoStep?: AwsSecretInputStep;
	#prepared = false;
	#initialized = false;
	#disposed = false;
	#disposalFailed = false;
	readonly #onAbort = () => this.dispose();
	constructor(
		private readonly request: AwsSecretInputRequest,
		private readonly launch: AwsSecretInputLaunchFiles,
		private readonly authorize: AwsSecretInputAuthorize,
		private readonly signal: AbortSignal,
		dependencies: AwsSecretInputProviderDependencies = {},
	) {
		this.#readFile = dependencies.readFile ?? readBoundedFile;
		this.#createClient = dependencies.createClient ?? createClient;
		this.#now = dependencies.now ?? Date.now;
		signal.addEventListener("abort", this.#onAbort, { once: true });
	}
	async prepare(): Promise<void> {
		this.#check();
		if (
			this.#prepared ||
			!PROFILE_NAME.test(this.request.profile) ||
			/^coreforge$/iu.test(this.request.profile) ||
			this.launch.reservedProfiles.includes(this.request.profile) ||
			!isAbsolute(this.launch.homeDir) ||
			[this.launch.configFile, this.launch.sharedCredentialsFile].some(
				file => file !== undefined && !isAbsolute(file),
			)
		)
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		this.#config = await this.#ini(this.launch.configFile, "config");
		const settings = this.#config.get(this.request.profile);
		if (settings && [...settings.keys()].some(key => key.startsWith("sso_"))) {
			const sso = this.#ssoSettings(settings);
			this.#ssoStep = Object.freeze({
				service: "sso",
				operation: "get-role-credentials",
				resource: sso.account,
				roleName: sso.role,
				region: sso.region,
			});
			await this.authorize(this.#ssoStep);
		}
		this.#check();
		this.#prepared = true;
	}
	async initialize(): Promise<void> {
		this.#check();
		if (!this.#prepared || this.#initialized) throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		const credentials = await this.#ini(this.launch.sharedCredentialsFile, "credentials");
		const settings = new Map<string, string>();
		try {
			const config = this.#config.get(this.request.profile);
			const credential = credentials.get(this.request.profile);
			if (!config && !credential) throw new AwsSecretInputFailure("AUTH_REQUIRED");
			for (const section of [config, credential])
				for (const [key, value] of section ?? []) {
					if (!Object.hasOwn(PROFILE_KEYS, key) || settings.has(key))
						throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
					settings.set(key, value);
				}
			const region = settings.get("region");
			if (region && awsSecretInputRegionPartition(region) !== this.request.secretInput.expectedIdentity.partition)
				throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
			if ([...settings.keys()].some(key => key.startsWith("sso_"))) {
				if (!this.#ssoStep) throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
				await this.#sso(settings);
			} else this.#static(settings);
			this.#check();
			this.#initialized = true;
		} finally {
			settings.clear();
			clearIni(credentials);
			clearIni(this.#config);
		}
	}
	async send(step: AwsSecretInputStep, command: AwsSecretInputCommand): Promise<unknown> {
		this.#check();
		if (!this.#initialized || step.service === "sso") throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		return this.#dispatch(step, command);
	}
	dispose(): boolean {
		if (this.#disposed) return !this.#disposalFailed;
		this.#disposed = true;
		this.signal.removeEventListener("abort", this.#onAbort);
		for (const client of this.#clients.values())
			try {
				client.destroy();
			} catch {
				this.#disposalFailed = true;
			}
		this.#clients.clear();
		for (const agent of this.#agents)
			try {
				agent.destroy();
			} catch {
				this.#disposalFailed = true;
			}
		this.#agents.clear();
		clearIni(this.#config);
		for (const credentials of [this.#credentials, this.#anonymous]) {
			credentials.accessKeyId = "";
			credentials.secretAccessKey = "";
			delete credentials.sessionToken;
			delete credentials.expiration;
		}
		this.#ssoStep = undefined;
		return !this.#disposalFailed;
	}
	#check(): void {
		if (this.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
		if (this.#disposed) throw new AwsSecretInputFailure("AWS_FAILED");
		if (this.#credentials.expiration && this.#credentials.expiration.getTime() <= this.#now())
			throw new AwsSecretInputFailure("AUTH_REQUIRED");
	}
	async #text(path: string, maxBytes: number): Promise<string> {
		let bytes: Uint8Array | undefined;
		try {
			bytes = await this.#readFile(path, maxBytes, this.signal);
			this.#check();
			if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
				throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} finally {
			bytes?.fill(0);
		}
	}
	async #ini(path: string | undefined, kind: "config" | "credentials"): Promise<Ini> {
		if (!path) return new Map();
		try {
			return parseIni(await this.#text(path, MAX_INI_BYTES), kind);
		} catch (error) {
			if (this.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
			if (error instanceof AwsSecretInputFailure) throw error;
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return new Map();
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		}
	}
	#static(settings: Map<string, string>): void {
		const accessKeyId = settings.get("aws_access_key_id");
		const secretAccessKey = settings.get("aws_secret_access_key");
		const sessionToken = settings.get("aws_session_token");
		if (!accessKeyId || !secretAccessKey) throw new AwsSecretInputFailure("AUTH_REQUIRED");
		for (const value of [accessKeyId, secretAccessKey, sessionToken])
			if (value !== undefined && (!value || value.length > 8_192 || /[\u0000-\u0020\u007f]/u.test(value)))
				throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		if (settings.has("expiration") && settings.has("aws_session_expiration"))
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		const expiration = settings.get("expiration") ?? settings.get("aws_session_expiration");
		if (expiration) {
			const ms = Date.parse(expiration.replace(/UTC$/u, "Z"));
			if (!Number.isFinite(ms) || ms <= this.#now()) throw new AwsSecretInputFailure("AUTH_REQUIRED");
			this.#credentials.expiration = new Date(ms);
		}
		this.#credentials.accessKeyId = accessKeyId;
		this.#credentials.secretAccessKey = secretAccessKey;
		if (sessionToken) this.#credentials.sessionToken = sessionToken;
	}
	#ssoSettings(settings: Map<string, string>): {
		startUrl: string;
		region: string;
		account: string;
		role: string;
		sessionName?: string;
	} {
		if ([...settings.keys()].some(key => key.startsWith("aws_") || key === "expiration"))
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		const sessionName = settings.get("sso_session");
		const session = sessionName ? this.#config.get(`sso-session:${sessionName}`) : undefined;
		if (sessionName && (!PROFILE_NAME.test(sessionName) || !session))
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		if (
			session &&
			([...session.keys()].some(key => !Object.hasOwn(SESSION_KEYS, key)) ||
				(settings.has("sso_start_url") && settings.get("sso_start_url") !== session.get("sso_start_url")) ||
				(settings.has("sso_region") && settings.get("sso_region") !== session.get("sso_region")) ||
				(session.has("sso_registration_scopes") && session.get("sso_registration_scopes") !== "sso:account:access"))
		)
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		const startUrl = session?.get("sso_start_url") ?? settings.get("sso_start_url");
		const region = session?.get("sso_region") ?? settings.get("sso_region");
		const account = settings.get("sso_account_id");
		const role = settings.get("sso_role_name");
		if (!startUrl || !region || !account || !role || !/^[\w+=,.@-]{1,64}$/u.test(role))
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		if (account !== this.request.secretInput.expectedIdentity.account)
			throw new AwsSecretInputFailure("IDENTITY_MISMATCH");
		if (awsSecretInputRegionPartition(region) !== this.request.secretInput.expectedIdentity.partition)
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		try {
			const url = new URL(startUrl);
			const suffix =
				this.request.secretInput.expectedIdentity.partition === "aws-cn" ? ".awsapps.cn" : ".awsapps.com";
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.port ||
				url.search ||
				url.hash ||
				!url.hostname.endsWith(suffix)
			)
				throw 0;
		} catch {
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		}
		return { startUrl, region, account, role, ...(sessionName ? { sessionName } : {}) };
	}
	async #sso(settings: Map<string, string>): Promise<void> {
		const sso = this.#ssoSettings(settings);
		if (
			this.#ssoStep?.region !== sso.region ||
			this.#ssoStep.roleName !== sso.role ||
			this.#ssoStep.resource !== sso.account
		)
			throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		const cacheKey = createHash("sha1")
			.update(sso.sessionName ?? sso.startUrl)
			.digest("hex");
		let token: Record<string, string | number> | undefined;
		let response: unknown;
		let command: GetRoleCredentialsCommand | undefined;
		try {
			token = parseToken(
				await this.#text(join(this.launch.homeDir, ".aws", "sso", "cache", `${cacheKey}.json`), MAX_TOKEN_BYTES),
			);
			const expires =
				typeof token.expiresAt === "string" ? Date.parse(token.expiresAt.replace(/UTC$/u, "Z")) : Number.NaN;
			if (
				token.startUrl !== sso.startUrl ||
				token.region !== sso.region ||
				!Number.isFinite(expires) ||
				expires <= this.#now() ||
				typeof token.accessToken !== "string" ||
				!token.accessToken ||
				token.accessToken.length > 16_384 ||
				/[\u0000-\u0020\u007f]/u.test(token.accessToken)
			)
				throw new AwsSecretInputFailure("AUTH_REQUIRED");
			command = new GetRoleCredentialsCommand({
				accountId: sso.account,
				roleName: sso.role,
				accessToken: token.accessToken,
			});
			response = await this.#dispatch(this.#ssoStep!, command);
			const role =
				response && typeof response === "object" && "roleCredentials" in response
					? response.roleCredentials
					: undefined;
			if (!role || typeof role !== "object") throw new AwsSecretInputFailure("AUTH_REQUIRED");
			const value = role as Record<string, unknown>;
			if (
				typeof value.expiration !== "number" ||
				!Number.isFinite(value.expiration) ||
				value.expiration <= this.#now()
			)
				throw new AwsSecretInputFailure("AUTH_REQUIRED");
			for (const key of ["accessKeyId", "secretAccessKey", "sessionToken"])
				if (
					typeof value[key] !== "string" ||
					!(value[key] as string).length ||
					(value[key] as string).length > 16_384 ||
					/[\u0000-\u0020\u007f]/u.test(value[key] as string)
				)
					throw new AwsSecretInputFailure("AUTH_REQUIRED");
			this.#check();
			this.#credentials.accessKeyId = value.accessKeyId as string;
			this.#credentials.secretAccessKey = value.secretAccessKey as string;
			this.#credentials.sessionToken = value.sessionToken as string;
			this.#credentials.expiration = new Date(value.expiration);
		} catch (error) {
			throw error instanceof AwsSecretInputFailure
				? error
				: new AwsSecretInputFailure(this.signal.aborted ? "CANCELLED" : "AUTH_REQUIRED");
		} finally {
			if (command) command.input.accessToken = undefined;
			if (token) for (const key of Object.keys(token)) delete token[key];
			if (!releaseAwsSecretInputResponse(response)) this.#disposalFailed = true;
			response = undefined;
			command = undefined;
		}
	}
	async #dispatch(step: AwsSecretInputStep, command: AwsSecretInputCommand): Promise<unknown> {
		let response: unknown;
		try {
			this.#check();
			const expected = this.request.secretInput.expectedIdentity;
			const parameters = this.request.parameters;
			const matches =
				(step.service === "sts" &&
					step.operation === "get-caller-identity" &&
					command instanceof GetCallerIdentityCommand &&
					step.resource === undefined &&
					Object.keys(command.input).length === 0) ||
				(step.service === "secretsmanager" &&
					step.operation === "get-secret-value" &&
					command instanceof GetSecretValueCommand &&
					step.resource === parameters.SecretId &&
					command.input.SecretId === parameters.SecretId &&
					command.input.VersionId === parameters.VersionId &&
					command.input.VersionStage === parameters.VersionStage) ||
				(step.service === "sso" &&
					step.operation === "get-role-credentials" &&
					command instanceof GetRoleCredentialsCommand &&
					step === this.#ssoStep &&
					command.input.accountId === expected.account &&
					command.input.roleName === step.roleName);
			if (
				!matches ||
				!step.region ||
				awsSecretInputRegionPartition(step.region) !== expected.partition ||
				(step.service !== "sso" && (step.region !== this.request.region || step.roleName !== undefined))
			)
				throw new AwsSecretInputFailure("INVALID_REQUEST");
			let client = this.#clients.get(step.service);
			if (!client) {
				const agent = new Agent({
					keepAlive: false,
					maxSockets: 1,
					maxTotalSockets: 1,
					maxFreeSockets: 0,
					rejectUnauthorized: true,
					minVersion: "TLSv1.2",
				});
				this.#agents.add(agent);
				client = this.#createClient(step.service, {
					region: step.region,
					credentials: step.service === "sso" ? this.#anonymous : this.#credentials,
					maxAttempts: 1,
					retryMode: "standard",
					ignoreConfiguredEndpointUrls: true,
					useFipsEndpoint: false,
					useDualstackEndpoint: false,
					endpointDiscoveryEnabled: false,
					defaultsMode: "standard",
					disableClockSkewCorrection: false,
					authSchemePreference: [],
					sigv4aSigningRegionSet: [],
					userAgentAppId: async () => undefined,
					logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
					requestHandler: {
						httpsAgent: agent,
						connectionTimeout: awsSecretInputTimeoutMs(this.request),
						requestTimeout: awsSecretInputTimeoutMs(this.request),
					},
				});
				this.#clients.set(step.service, client);
				this.#check();
			}
			await this.authorize(Object.freeze({ ...step }));
			this.#check();
			response = await client.send(command, { abortSignal: this.signal });
			this.#check();
			const result = response;
			response = undefined;
			return result;
		} catch (error) {
			if (!releaseAwsSecretInputResponse(response)) this.#disposalFailed = true;
			response = undefined;
			throw safeAwsFailure(error, this.signal);
		}
	}
}
