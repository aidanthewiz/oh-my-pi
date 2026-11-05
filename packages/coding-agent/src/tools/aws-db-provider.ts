import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Agent } from "node:https";
import { isAbsolute, join } from "node:path";
import {
	DescribeDBClustersCommand,
	DescribeDBInstancesCommand,
	ListTagsForResourceCommand,
	RDSClient,
} from "@aws-sdk/client-rds";
import { DescribeSecretCommand, GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetRoleCredentialsCommand, SSOClient } from "@aws-sdk/client-sso";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { Type } from "@oh-my-pi/omptype/typebox";
import { AWS_DB_MANIFEST, AwsDbFailure, type AwsDbInspectionRequest, safeAwsDbFailure } from "./aws-db-contract";

export const AWS_DB_PROVIDER_POLICY_ID = "read-only-explicit-static-sso/v1";

export interface AwsDbLaunchFiles {
	configFile?: string;
	sharedCredentialsFile?: string;
	homeDir: string;
	reservedProfiles: readonly string[];
}

export interface AwsDbStep {
	service: "sts" | "rds" | "secretsmanager" | "sso";
	operation:
		| "get-caller-identity"
		| "describe-db-clusters"
		| "describe-db-instances"
		| "list-tags-for-resource"
		| "describe-secret"
		| "get-secret-value"
		| "get-role-credentials";
	resource?: string;
	roleName?: string;
	region?: string;
}

export type AwsDbAuthorize = (step: AwsDbStep) => Promise<void>;
export type AwsDbService = AwsDbStep["service"];
export type AwsDbCommand =
	| GetCallerIdentityCommand
	| DescribeDBClustersCommand
	| DescribeDBInstancesCommand
	| ListTagsForResourceCommand
	| DescribeSecretCommand
	| GetSecretValueCommand
	| GetRoleCredentialsCommand;

interface MemoryAwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	expiration?: Date;
}

export interface AwsDbClientConfig {
	region: string;
	credentials: MemoryAwsCredentials;
	maxAttempts: 1;
	retryMode: "standard";
	ignoreConfiguredEndpointUrls: true;
	useFipsEndpoint: false;
	useDualstackEndpoint: false;
	endpointDiscoveryEnabled: false;
	logger: Record<"trace" | "debug" | "info" | "warn" | "error", (...args: unknown[]) => void>;
	requestHandler: {
		httpsAgent: Agent;
		connectionTimeout: number;
		requestTimeout: number;
	};
}

export interface AwsDbClient {
	send(command: AwsDbCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
	destroy(): void;
}

export type AwsDbClientFactory = (service: AwsDbService, config: AwsDbClientConfig) => AwsDbClient;
export type AwsDbFileReader = (path: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;

export interface AwsDbProviderDependencies {
	readFile?: AwsDbFileReader;
	createClient?: AwsDbClientFactory;
	now?: () => number;
}

const MAX_INI_BYTES = 256 * 1024;
const MAX_TOKEN_BYTES = 64 * 1024;
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
const ssoResponseSchema = Type.Object({
	roleCredentials: Type.Object({
		accessKeyId: Type.String({ minLength: 1, maxLength: 16384 }),
		secretAccessKey: Type.String({ minLength: 1, maxLength: 16384 }),
		sessionToken: Type.String({ minLength: 1, maxLength: 16384 }),
		expiration: Type.Number(),
	}),
});
type Ini = Map<string, Map<string, string>>;

export function awsDbRegionPartition(region: string): "aws" | "aws-us-gov" | "aws-cn" | undefined {
	if (AWS_DB_MANIFEST.tlsRegions.aws.some(candidate => candidate === region)) return "aws";
	if (AWS_DB_MANIFEST.tlsRegions["aws-us-gov"].some(candidate => candidate === region)) return "aws-us-gov";
	if (AWS_DB_MANIFEST.tlsRegions["aws-cn"].some(candidate => candidate === region)) return "aws-cn";
	return undefined;
}

function createClient(service: AwsDbService, config: AwsDbClientConfig): AwsDbClient {
	switch (service) {
		case "sts":
			return new STSClient(config) as unknown as AwsDbClient;
		case "rds":
			return new RDSClient(config) as unknown as AwsDbClient;
		case "secretsmanager":
			return new SecretsManagerClient(config) as unknown as AwsDbClient;
		case "sso":
			return new SSOClient(config) as unknown as AwsDbClient;
	}
}

async function readBoundedFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	if (signal.aborted) throw new AwsDbFailure("CANCELLED");
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let buffer: Buffer | undefined;
	let closed = false;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		buffer = Buffer.alloc(maxBytes + 1);
		let size = 0;
		while (size < buffer.length) {
			if (signal.aborted) throw new AwsDbFailure("CANCELLED");
			const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
			if (bytesRead === 0) break;
			size += bytesRead;
		}
		if (size > maxBytes) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		const result = buffer.subarray(0, size);
		await file.close();
		closed = true;
		return result;
	} finally {
		if (!closed) {
			buffer?.fill(0);
			await file.close();
		}
	}
}

function parseIni(text: string, kind: "config" | "credentials"): Ini {
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
		throw new AwsDbFailure("PROFILE_UNSUPPORTED");
	}
	const result: Ini = new Map();
	let current: Map<string, string> | undefined;
	for (const source of text.split(/\r?\n/u)) {
		if (source.length > 8192) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		const line = source.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			const section = /^\[([^\[\]]+)\]$/u.exec(line)?.[1];
			if (!section) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
			let name = section;
			if (kind === "config") {
				if (section.startsWith("profile ")) name = section.slice(8);
				else if (section.startsWith("sso-session ")) name = `sso-session:${section.slice(12)}`;
				else if (section !== "default") throw new AwsDbFailure("PROFILE_UNSUPPORTED");
			}
			const plainName = name.startsWith("sso-session:") ? name.slice(12) : name;
			if (!PROFILE_NAME.test(plainName) || result.has(name) || result.size >= 512) {
				throw new AwsDbFailure("PROFILE_UNSUPPORTED");
			}
			current = new Map();
			result.set(name, current);
			continue;
		}
		const setting = /^([a-zA-Z][a-zA-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
		if (!current || !setting) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		const key = setting[1]!.toLowerCase();
		if (current.has(key) || current.size >= 64) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		current.set(key, setting[2]!);
	}
	return result;
}

function clearIni(ini: Ini): void {
	for (const section of ini.values()) section.clear();
	ini.clear();
}

export function parseAwsDbFlatJson(
	text: string,
	allowedKeys: Readonly<Record<string, true>>,
	code: "AUTH_REQUIRED" | "SECRET_MISMATCH",
): Record<string, string | number> {
	let offset = 0;
	const result: Record<string, string | number> = Object.create(null);
	const fail = (): never => {
		throw new AwsDbFailure(code);
	};
	const whitespace = () => {
		while (offset < text.length && /[\t\n\r ]/u.test(text[offset]!)) offset++;
	};
	const string = (): string => {
		if (text[offset++] !== '"') return fail();
		const start = offset - 1;
		while (offset < text.length) {
			const character = text[offset++];
			if (character === "\\") offset++;
			else if (character === '"') {
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
		whitespace();
		if (text[offset++] !== "{") fail();
		whitespace();
		if (text[offset] !== "}") {
			for (;;) {
				const key = string();
				if (!Object.hasOwn(allowedKeys, key) || Object.hasOwn(result, key)) fail();
				whitespace();
				if (text[offset++] !== ":") fail();
				whitespace();
				if (text[offset] === '"') result[key] = string();
				else {
					const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(offset))?.[0];
					if (!number) return fail();
					result[key] = Number(number);
					if (!Number.isFinite(result[key])) fail();
					offset += number.length;
				}
				whitespace();
				if (text[offset] !== ",") break;
				offset++;
				whitespace();
			}
		}
		if (text[offset++] !== "}") fail();
		whitespace();
		if (offset !== text.length) fail();
		return result;
	} catch {
		for (const key of Object.keys(result)) delete result[key];
		throw new AwsDbFailure(code);
	}
}

export function awsDbSafeFailure(error: unknown, signal: AbortSignal): AwsDbFailure {
	if (signal.aborted) return new AwsDbFailure("CANCELLED");
	if (error instanceof AwsDbFailure) {
		const code = safeAwsDbFailure(error);
		return new AwsDbFailure(code === "WORKER_FAILED" ? "AWS_FAILED" : code);
	}
	let name: unknown;
	let status: unknown;
	try {
		if (error && typeof error === "object") {
			if ("name" in error) name = error.name;
			if (
				"$metadata" in error &&
				error.$metadata &&
				typeof error.$metadata === "object" &&
				"httpStatusCode" in error.$metadata
			) {
				status = error.$metadata.httpStatusCode;
			}
		}
	} catch {
		return new AwsDbFailure("AWS_FAILED");
	}
	if (
		name === "ExpiredToken" ||
		name === "ExpiredTokenException" ||
		name === "InvalidClientTokenId" ||
		name === "UnrecognizedClientException" ||
		name === "UnauthorizedException" ||
		name === "InvalidGrantException" ||
		name === "CredentialsProviderError"
	)
		return new AwsDbFailure("AUTH_REQUIRED");
	if (status === 403 || name === "AccessDenied" || name === "AccessDeniedException" || name === "ForbiddenException") {
		return new AwsDbFailure("AWS_ACCESS_DENIED");
	}
	return new AwsDbFailure("AWS_FAILED");
}

export async function awsDbAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		void operation.catch(() => {});
		throw new AwsDbFailure("CANCELLED");
	}
	const { promise, reject } = Promise.withResolvers<never>();
	const abort = () => reject(new AwsDbFailure("CANCELLED"));
	signal.addEventListener("abort", abort, { once: true });
	try {
		const result = await Promise.race([operation, promise]);
		if (signal.aborted) throw new AwsDbFailure("CANCELLED");
		return result;
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export function releaseAwsDbResponse(response: unknown): boolean {
	try {
		if (!response || typeof response !== "object") return true;
		if ("SecretString" in response) response.SecretString = undefined;
		if ("SecretBinary" in response) {
			if (response.SecretBinary instanceof Uint8Array) response.SecretBinary.fill(0);
			response.SecretBinary = undefined;
		}
		if ("roleCredentials" in response) {
			const credentials = response.roleCredentials;
			if (credentials && typeof credentials === "object") {
				if ("accessKeyId" in credentials) credentials.accessKeyId = "";
				if ("secretAccessKey" in credentials) credentials.secretAccessKey = "";
				if ("sessionToken" in credentials) credentials.sessionToken = "";
				if ("expiration" in credentials) credentials.expiration = 0;
			}
			response.roleCredentials = undefined;
		}
		return true;
	} catch {
		return false;
	}
}

export class AwsDbProvider {
	readonly #request: AwsDbInspectionRequest;
	readonly #launch: AwsDbLaunchFiles;
	readonly #authorize: AwsDbAuthorize;
	readonly #signal: AbortSignal;
	readonly #readFile: AwsDbFileReader;
	readonly #createClient: AwsDbClientFactory;
	readonly #now: () => number;
	readonly #clients = new Map<AwsDbService, AwsDbClient>();
	readonly #agents = new Set<Agent>();
	readonly #credentials: MemoryAwsCredentials = { accessKeyId: "", secretAccessKey: "" };
	readonly #anonymous: MemoryAwsCredentials = { accessKeyId: "", secretAccessKey: "" };
	#initialized = false;
	#disposed = false;
	#disposalFailed = false;
	#tokenExpiresAt: number | undefined;
	readonly #onAbort = () => this.dispose();

	constructor(
		request: AwsDbInspectionRequest,
		launch: AwsDbLaunchFiles,
		authorize: AwsDbAuthorize,
		signal: AbortSignal,
		dependencies: AwsDbProviderDependencies = {},
	) {
		this.#request = request;
		this.#launch = launch;
		this.#authorize = authorize;
		this.#signal = signal;
		this.#readFile = dependencies.readFile ?? readBoundedFile;
		this.#createClient = dependencies.createClient ?? createClient;
		this.#now = dependencies.now ?? Date.now;
		signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	async initialize(): Promise<void> {
		this.#check();
		if (this.#initialized) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		const { profile, expected } = this.#request;
		if (
			!PROFILE_NAME.test(profile) ||
			/^coreforge$/iu.test(profile) ||
			this.#launch.reservedProfiles.includes(profile) ||
			!isAbsolute(this.#launch.homeDir) ||
			(this.#launch.configFile !== undefined && !isAbsolute(this.#launch.configFile)) ||
			(this.#launch.sharedCredentialsFile !== undefined && !isAbsolute(this.#launch.sharedCredentialsFile)) ||
			awsDbRegionPartition(expected.region) !== expected.partition
		)
			throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		let config: Ini = new Map();
		let credentials: Ini = new Map();
		const settings = new Map<string, string>();
		try {
			config = await this.#ini(this.#launch.configFile, "config");
			credentials = await this.#ini(this.#launch.sharedCredentialsFile, "credentials");
			const configured = config.get(profile);
			const credential = credentials.get(profile);
			if (!configured && !credential) throw new AwsDbFailure("AUTH_REQUIRED");
			for (const section of [configured, credential]) {
				for (const [key, value] of section ?? []) {
					if (!Object.hasOwn(PROFILE_KEYS, key) || settings.has(key))
						throw new AwsDbFailure("PROFILE_UNSUPPORTED");
					settings.set(key, value);
				}
			}
			const region = settings.get("region");
			if (region && awsDbRegionPartition(region) !== expected.partition)
				throw new AwsDbFailure("PROFILE_UNSUPPORTED");
			if ([...settings.keys()].some(key => key.startsWith("sso_"))) await this.#sso(settings, config);
			else this.#static(settings);
			this.#check();
			this.#initialized = true;
		} finally {
			settings.clear();
			clearIni(config);
			clearIni(credentials);
		}
	}

	async send(step: AwsDbStep, command: AwsDbCommand): Promise<unknown> {
		this.#check();
		if (!this.#initialized || step.service === "sso") throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		return this.#dispatch(step, command);
	}

	dispose(): boolean {
		if (this.#disposed) return !this.#disposalFailed;
		this.#disposed = true;
		this.#signal.removeEventListener("abort", this.#onAbort);
		for (const client of this.#clients.values()) {
			try {
				client.destroy();
			} catch {
				this.#disposalFailed = true;
			}
		}
		this.#clients.clear();
		for (const agent of this.#agents) {
			try {
				agent.destroy();
			} catch {
				this.#disposalFailed = true;
			}
		}
		this.#agents.clear();
		for (const credentials of [this.#credentials, this.#anonymous]) {
			credentials.accessKeyId = "";
			credentials.secretAccessKey = "";
			delete credentials.sessionToken;
			delete credentials.expiration;
		}
		return !this.#disposalFailed;
	}

	#check(): void {
		if (this.#signal.aborted) throw new AwsDbFailure("CANCELLED");
		if (this.#disposed) throw new AwsDbFailure("AWS_FAILED");
		const expiration = this.#credentials.expiration;
		if (expiration && expiration.getTime() <= this.#now()) throw new AwsDbFailure("AUTH_REQUIRED");
		if (this.#tokenExpiresAt !== undefined && this.#tokenExpiresAt <= this.#now())
			throw new AwsDbFailure("AUTH_REQUIRED");
	}

	async #text(path: string, maxBytes: number): Promise<string> {
		let bytes: Uint8Array | undefined;
		try {
			const operation = this.#readFile(path, maxBytes, this.#signal).then(result => {
				if (this.#signal.aborted) {
					result.fill(0);
					throw new AwsDbFailure("CANCELLED");
				}
				return result;
			});
			bytes = await awsDbAbortable(operation, this.#signal);
			if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
				throw new AwsDbFailure("PROFILE_UNSUPPORTED");
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
			if (this.#signal.aborted) throw new AwsDbFailure("CANCELLED");
			if (error instanceof AwsDbFailure) throw new AwsDbFailure(safeAwsDbFailure(error));
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return new Map();
			throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		}
	}

	#static(settings: Map<string, string>): void {
		const accessKeyId = settings.get("aws_access_key_id");
		const secretAccessKey = settings.get("aws_secret_access_key");
		const sessionToken = settings.get("aws_session_token");
		if (!accessKeyId || !secretAccessKey) throw new AwsDbFailure("AUTH_REQUIRED");
		for (const value of [accessKeyId, secretAccessKey, sessionToken]) {
			if (value !== undefined && (!value || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value))) {
				throw new AwsDbFailure("PROFILE_UNSUPPORTED");
			}
		}
		const expiration = settings.get("expiration") ?? settings.get("aws_session_expiration");
		if (settings.has("expiration") && settings.has("aws_session_expiration"))
			throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		if (expiration) {
			const milliseconds = Date.parse(expiration.replace(/UTC$/u, "Z"));
			if (!Number.isFinite(milliseconds) || milliseconds <= this.#now()) throw new AwsDbFailure("AUTH_REQUIRED");
			this.#credentials.expiration = new Date(milliseconds);
		}
		this.#credentials.accessKeyId = accessKeyId;
		this.#credentials.secretAccessKey = secretAccessKey;
		if (sessionToken) this.#credentials.sessionToken = sessionToken;
	}

	async #sso(settings: Map<string, string>, config: Ini): Promise<void> {
		if ([...settings.keys()].some(key => key.startsWith("aws_") || key === "expiration")) {
			throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		}
		const sessionName = settings.get("sso_session");
		const session = sessionName ? config.get(`sso-session:${sessionName}`) : undefined;
		if (sessionName && (!PROFILE_NAME.test(sessionName) || !session)) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		if (session) {
			if ([...session.keys()].some(key => !Object.hasOwn(SESSION_KEYS, key)))
				throw new AwsDbFailure("PROFILE_UNSUPPORTED");
			if (settings.has("sso_start_url") || settings.has("sso_region")) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
			if (
				session.has("sso_registration_scopes") &&
				session.get("sso_registration_scopes") !== "sso:account:access"
			) {
				throw new AwsDbFailure("PROFILE_UNSUPPORTED");
			}
		}
		const startUrl = session?.get("sso_start_url") ?? settings.get("sso_start_url");
		const region = session?.get("sso_region") ?? settings.get("sso_region");
		const account = settings.get("sso_account_id");
		const role = settings.get("sso_role_name");
		if (!startUrl || !region || !account || !role || !/^[\w+=,.@-]{1,64}$/u.test(role)) {
			throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		}
		if (account !== this.#request.expected.accountId) throw new AwsDbFailure("IDENTITY_MISMATCH");
		if (awsDbRegionPartition(region) !== this.#request.expected.partition)
			throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		try {
			const url = new URL(startUrl);
			const suffix = this.#request.expected.partition === "aws-cn" ? ".awsapps.cn" : ".awsapps.com";
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				url.port ||
				url.search ||
				url.hash ||
				!url.hostname.endsWith(suffix) ||
				(url.pathname !== "/start" &&
					url.pathname !== "/start/" &&
					!/^\/directory\/d-[a-z0-9]+$/u.test(url.pathname))
			)
				throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		} catch {
			throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		}
		const cacheKey = createHash("sha1")
			.update(sessionName ?? startUrl)
			.digest("hex");
		const cacheFile = join(this.#launch.homeDir, ".aws", "sso", "cache", `${cacheKey}.json`);
		let token: Record<string, string | number> | undefined;
		let response: unknown;
		let command: GetRoleCredentialsCommand | undefined;
		try {
			token = parseAwsDbFlatJson(await this.#text(cacheFile, MAX_TOKEN_BYTES), TOKEN_KEYS, "AUTH_REQUIRED");
			const expires =
				typeof token.expiresAt === "string" ? Date.parse(token.expiresAt.replace(/UTC$/u, "Z")) : Number.NaN;
			if (
				token.startUrl !== startUrl ||
				token.region !== region ||
				!Number.isFinite(expires) ||
				expires <= this.#now() ||
				typeof token.accessToken !== "string" ||
				!token.accessToken ||
				token.accessToken.length > 16384 ||
				/[\u0000-\u0020\u007f]/u.test(token.accessToken)
			)
				throw new AwsDbFailure("AUTH_REQUIRED");
			this.#tokenExpiresAt = expires;
			command = new GetRoleCredentialsCommand({
				accountId: account,
				roleName: role,
				accessToken: token.accessToken,
			});
			response = await this.#dispatch(
				{ service: "sso", operation: "get-role-credentials", resource: account, roleName: role, region },
				command,
			);
			const parsed = ssoResponseSchema.safeParse(response);
			if (!parsed.success) throw new AwsDbFailure("AUTH_REQUIRED");
			const roleCredentials = parsed.data.roleCredentials;
			if (!Number.isFinite(roleCredentials.expiration) || roleCredentials.expiration <= this.#now()) {
				throw new AwsDbFailure("AUTH_REQUIRED");
			}
			for (const value of [
				roleCredentials.accessKeyId,
				roleCredentials.secretAccessKey,
				roleCredentials.sessionToken,
			]) {
				if (/[\u0000-\u0020\u007f]/u.test(value)) throw new AwsDbFailure("AUTH_REQUIRED");
			}
			this.#check();
			this.#credentials.accessKeyId = roleCredentials.accessKeyId;
			this.#credentials.secretAccessKey = roleCredentials.secretAccessKey;
			this.#credentials.sessionToken = roleCredentials.sessionToken;
			this.#credentials.expiration = new Date(roleCredentials.expiration);
		} catch (error) {
			if (error instanceof AwsDbFailure) throw new AwsDbFailure(safeAwsDbFailure(error));
			throw new AwsDbFailure(this.#signal.aborted ? "CANCELLED" : "AUTH_REQUIRED");
		} finally {
			this.#tokenExpiresAt = undefined;
			try {
				if (command) command.input.accessToken = undefined;
				if (token) for (const key of Object.keys(token)) delete token[key];
				if (!releaseAwsDbResponse(response)) this.#disposalFailed = true;
			} catch {
				this.#disposalFailed = true;
			}
			response = undefined;
			command = undefined;
		}
	}

	async #dispatch(step: AwsDbStep, command: AwsDbCommand): Promise<unknown> {
		let response: unknown;
		try {
			this.#check();
			const expected = this.#request.expected;
			const matches =
				(step.service === "sts" &&
					step.operation === "get-caller-identity" &&
					command instanceof GetCallerIdentityCommand &&
					step.resource === undefined) ||
				(step.service === "rds" &&
					step.operation === "describe-db-clusters" &&
					command instanceof DescribeDBClustersCommand &&
					step.resource === expected.clusterArn &&
					command.input.DBClusterIdentifier === expected.clusterArn) ||
				(step.service === "rds" &&
					step.operation === "describe-db-instances" &&
					command instanceof DescribeDBInstancesCommand &&
					step.resource === expected.instanceArn &&
					command.input.DBInstanceIdentifier === expected.instanceArn) ||
				(step.service === "rds" &&
					step.operation === "list-tags-for-resource" &&
					command instanceof ListTagsForResourceCommand &&
					(step.resource === expected.clusterArn || step.resource === expected.instanceArn) &&
					command.input.ResourceName === step.resource) ||
				(step.service === "secretsmanager" &&
					step.operation === "describe-secret" &&
					command instanceof DescribeSecretCommand &&
					step.resource === expected.secretArn &&
					command.input.SecretId === expected.secretArn) ||
				(step.service === "secretsmanager" &&
					step.operation === "get-secret-value" &&
					command instanceof GetSecretValueCommand &&
					step.resource === expected.secretArn &&
					command.input.SecretId === expected.secretArn &&
					command.input.VersionId === expected.secretVersionId &&
					command.input.VersionStage === "AWSCURRENT") ||
				(step.service === "sso" &&
					step.operation === "get-role-credentials" &&
					command instanceof GetRoleCredentialsCommand &&
					step.resource === expected.accountId &&
					command.input.accountId === expected.accountId &&
					command.input.roleName === step.roleName);
			if (
				!matches ||
				!step.region ||
				awsDbRegionPartition(step.region) !== expected.partition ||
				(step.service !== "sso" && (step.region !== expected.region || step.roleName !== undefined))
			)
				throw new AwsDbFailure("INVALID_REQUEST");
			await awsDbAbortable(this.#authorize(Object.freeze({ ...step })), this.#signal);
			this.#check();
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
					region: step.region ?? this.#request.expected.region,
					credentials: step.service === "sso" ? this.#anonymous : this.#credentials,
					maxAttempts: 1,
					retryMode: "standard",
					ignoreConfiguredEndpointUrls: true,
					useFipsEndpoint: false,
					useDualstackEndpoint: false,
					endpointDiscoveryEnabled: false,
					logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
					requestHandler: {
						httpsAgent: agent,
						connectionTimeout: this.#request.limits.timeoutMs,
						requestTimeout: this.#request.limits.timeoutMs,
					},
				});
				if (this.#disposed || this.#signal.aborted) {
					try {
						client.destroy();
					} catch {
						this.#disposalFailed = true;
					}
					throw new AwsDbFailure("CANCELLED");
				}
				this.#clients.set(step.service, client);
			}
			const operation = client.send(command, { abortSignal: this.#signal }).then(result => {
				if (this.#signal.aborted || this.#disposed) {
					if (!releaseAwsDbResponse(result)) this.#disposalFailed = true;
					throw new AwsDbFailure("CANCELLED");
				}
				response = result;
				return result;
			});
			const result = await awsDbAbortable(operation, this.#signal);
			this.#check();
			response = undefined;
			return result;
		} catch (error) {
			if (!releaseAwsDbResponse(response)) this.#disposalFailed = true;
			response = undefined;
			throw awsDbSafeFailure(error, this.#signal);
		}
	}
}
