import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import {
	filterProcessEnv,
	getOperationalAwsLaunchMetadata,
	getReservedManagedAwsProfiles,
	logger,
	prompt,
	ptree,
	untilAborted,
} from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";
import type { MCPHostCallContext } from "../mcp/types";
import awsDescription from "../prompts/tools/aws.md" with { type: "text" };
import { enforceDestructiveCommandGuard, type DcgDecision } from "./destructive-command-guard";
import {
	type RuntimeToolApprovalRequest,
	resolveApproval,
	resolveApprovalFromContext,
	truncateForPrompt,
} from "./approval";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";
import { readShellWord } from "./shell-tokenize";
import { OutputSink } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { cfgToolsMaxTimeout } from "./settings";
import { ToolAbortError } from "./tool-errors";
const MAX_AWS_OUTPUT_BYTES = 1024 * 1024;

const PROFILE_CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REGION_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+-\d+$/;
const FILE_VALUE_RE = /(?:^|@=)\s*fileb?:\/\//iu;
const BLOCKED_PARAMETER_NAMES = [
	"profile",
	"region",
	"endpoint-url",
	"output",
	"query",
	"no-paginate",
	"no-verify-ssl",
	"ca-bundle",
	"cli-input-json",
	"cli-binary-format",
	"cli-auto-prompt",
	"cli-pager",
	"pager",
	"debug",
	"version",
	"no-sign-request",
	"no-cli-pager",
	"generate-cli-skeleton",
	"color",
] as const;
const BLOCKED_AWS_SERVICES: Readonly<Record<string, true>> = {
	configure: true,
	completion: true,
	help: true,
	history: true,
};
const CORE_FORGE_PROFILE_RE = /^coreforge$/iu;
const SSO_SECTION_PREFIX = "\0sso-session:";

class AwsToolError extends ToolError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, { ...context, code: message.slice(0, message.indexOf(":")) });
	}
}

const awsSchema = type({
	profile: "string",
	service: "string",
	operation: "string",
	"region?": "string",
	"parameters?": type({ "[string]": "unknown" }),
	"timeout?": type("number").describe("per-request timeout seconds"),
});
const awsIdentitySchema = type({ Arn: "string", Account: "string" });

function buildAwsSchema(profileNames: readonly string[]): typeof awsSchema {
	if (profileNames.length === 0) return awsSchema;
	return type({
		profile: type
			.enumerated(...profileNames)
			.describe("AWS profile selected from the trusted launcher configuration"),
		service: "string",
		operation: "string",
		"region?": "string",
		"parameters?": type({ "[string]": "unknown" }),
		"timeout?": type("number").describe("per-request timeout seconds"),
	}) as unknown as typeof awsSchema;
}

export type AwsToolParams = typeof awsSchema.infer;
export type AwsPartition =
	| "aws"
	| "aws-us-gov"
	| "aws-cn"
	| "aws-eusc"
	| "aws-iso"
	| "aws-iso-b"
	| "aws-iso-e"
	| "aws-iso-f";
export type AwsAuthGroupState = "unknown" | "offered" | "approved" | "declined" | "authenticated";

export interface AwsProfileCatalogEntry {
	name: string;
	auth: "sso" | "static" | "role" | "custom" | "unconfigured";
	configuredRegion?: string;
	partition?: AwsPartition;
	ssoGroup?: string;
	lastValidation: "unverified" | "valid" | "auth-required" | "access-denied";
}

function isAwsProfileName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !PROFILE_CONTROL_RE.test(value);
}

export interface AwsIni {
	[section: string]: Record<string, string>;
}

interface AwsIdentity {
	account: string;
	arn: string;
	partition: AwsPartition;
}

export interface AwsAuthenticationRecoveryBudget {
	attempted: boolean;
}

interface PreparedAwsCall {
	params: AwsToolParams;
	profile: AwsProfileCatalogEntry;
	region: string;
	argv: string[];
	mutation: boolean;
	login: boolean;
	loginProfile?: string;
	configPath: string;
	tempDir: string;
	sessionManagerBin?: string;
	dcg?: DcgDecision;
	expectedIdentity?: AwsIdentity;
	authRecovery: AwsAuthenticationRecoveryBudget;
	ownsAuthRecovery: boolean;
	authenticationGeneration: number;
	loginReservation?: AwsLoginReservation;
}

interface AwsToolDetails {
	profile: string;
	service: string;
	operation: string;
	region?: string;
	partition?: AwsPartition;
	identityArn?: string;
	exitCode?: number;
	timedOut?: boolean;
	code?: string;
	meta?: Record<string, unknown>;
}

export function parseAwsIni(text: string, kind: "config" | "credentials" = "config"): AwsIni {
	const out: AwsIni = Object.create(null);
	let current: Record<string, string> | undefined;
	let previousKey: string | undefined;
	let previousIndent = 0;
	for (const raw of text.split(/\r?\n/u)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			if (!line.endsWith("]")) throw new AwsToolError("PROFILE_NOT_FOUND: malformed AWS INI section");
			let section = line.slice(1, -1).trim();
			previousKey = undefined;
			if (kind === "config") {
				if (section.startsWith("profile ")) section = section.slice("profile ".length).trim();
				else if (section.startsWith("sso-session "))
					section = `${SSO_SECTION_PREFIX}${section.slice("sso-session ".length).trim()}`;
				else if (section !== "default") {
					current = undefined;
					continue;
				}
			}
			current = out[section] ??= Object.create(null);
			continue;
		}
		if (!current) continue;
		const indent = raw.length - raw.trimStart().length;
		if (previousKey && indent > previousIndent) {
			current[previousKey] += `\n${raw}`;
			continue;
		}
		const equals = line.indexOf("=");
		if (equals <= 0) throw new AwsToolError("PROFILE_NOT_FOUND: malformed AWS INI property");
		previousKey = line.slice(0, equals).trim().toLowerCase();
		previousIndent = indent;
		current[previousKey] = line.slice(equals + 1).trim();
	}
	return out;
}

async function readIni(filePath: string | undefined, kind: "config" | "credentials" = "config"): Promise<AwsIni> {
	if (!filePath || !path.isAbsolute(filePath)) return {};
	try {
		return parseAwsIni(await fs.readFile(filePath, "utf8"), kind);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function readIniSync(filePath: string | undefined, kind: "config" | "credentials" = "config"): AwsIni {
	if (!filePath || !path.isAbsolute(filePath)) return {};
	try {
		return parseAwsIni(readFileSync(filePath, "utf8"), kind);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

function profileSettings(name: string, config: AwsIni, credentials: AwsIni): Record<string, string> {
	return { ...config[name], ...credentials[name] };
}

function normaliseSsoStartUrl(value: string): string {
	try {
		const url = new URL(value);
		url.hash = "";
		url.search = "";
		return url.toString().replace(/\/$/u, "").toLowerCase();
	} catch {
		return value.trim().toLowerCase();
	}
}

function findSsoGroup(
	profile: string,
	config: AwsIni,
	credentials: AwsIni,
	seen: Set<string> = new Set(),
): string | undefined {
	if (seen.has(profile)) return undefined;
	seen.add(profile);
	const settings = profileSettings(profile, config, credentials);
	const session = settings.sso_session ? config[`${SSO_SECTION_PREFIX}${settings.sso_session}`] : undefined;
	if (settings.sso_session && session) return `sso-session:${settings.sso_session}`;
	const startUrl = settings.sso_start_url ?? session?.sso_start_url;
	const ssoRegion = settings.sso_region ?? session?.sso_region;
	if (startUrl && ssoRegion) return `${normaliseSsoStartUrl(startUrl)}|${ssoRegion.toLowerCase()}`;
	return settings.source_profile ? findSsoGroup(settings.source_profile, config, credentials, seen) : undefined;
}

function findSsoProfile(
	profile: string,
	config: AwsIni,
	credentials: AwsIni,
	seen: Set<string> = new Set(),
): string | undefined {
	if (seen.has(profile)) return undefined;
	seen.add(profile);
	const settings = profileSettings(profile, config, credentials);
	const session = settings.sso_session ? config[`${SSO_SECTION_PREFIX}${settings.sso_session}`] : undefined;
	if ((settings.sso_start_url ?? session?.sso_start_url) && (settings.sso_region ?? session?.sso_region))
		return profile;
	return settings.source_profile ? findSsoProfile(settings.source_profile, config, credentials, seen) : undefined;
}

function configuredProfilePartition(
	profiles: readonly string[],
	config: AwsIni,
	credentials: AwsIni,
): AwsPartition | null | undefined {
	const partitions = new Set<AwsPartition | undefined>();
	for (const name of profiles) {
		const settings = profileSettings(name, config, credentials);
		const session = settings.sso_session ? config[`${SSO_SECTION_PREFIX}${settings.sso_session}`] : undefined;
		const ssoRegion = settings.sso_region ?? session?.sso_region;
		if (settings.region) partitions.add(partitionForAwsRegion(settings.region));
		if (settings.role_arn) partitions.add(partitionFromArn(settings.role_arn));
		if (ssoRegion) partitions.add(partitionForAwsRegion(ssoRegion));
	}
	if (partitions.size === 0) return undefined;
	return partitions.size === 1 ? (partitions.values().next().value ?? null) : null;
}

function classifyProfile(
	name: string,
	config: AwsIni,
	credentials: AwsIni,
	reachable: readonly string[],
): AwsProfileCatalogEntry {
	const settings = profileSettings(name, config, credentials);
	const ssoGroup = findSsoGroup(name, config, credentials);
	const configuredRegion = settings.region;
	const auth = ssoGroup
		? "sso"
		: settings.role_arn
			? "role"
			: settings.aws_access_key_id && settings.aws_secret_access_key
				? "static"
				: settings.credential_process
					? "custom"
					: "unconfigured";
	return {
		name,
		auth,
		lastValidation: "unverified",
		...(configuredRegion
			? {
					configuredRegion,
					partition: configuredProfilePartition(reachable, config, credentials) ?? undefined,
				}
			: {}),
		...(ssoGroup ? { ssoGroup } : {}),
	};
}

/** Parse all user profiles without resolving credentials or pruning expired SSO sessions. */
export function catalogAwsProfiles(config: AwsIni, credentials: AwsIni): AwsProfileCatalogEntry[] {
	const names = new Set([...Object.keys(config), ...Object.keys(credentials)]);
	const profiles: AwsProfileCatalogEntry[] = [];
	for (const name of names) {
		if (
			!isAwsProfileName(name) ||
			name.startsWith(SSO_SECTION_PREFIX) ||
			CORE_FORGE_PROFILE_RE.test(name) ||
			getReservedManagedAwsProfiles().includes(name)
		)
			continue;
		let reachable: string[];
		try {
			reachable = reachableProfiles(name, config, credentials);
		} catch {
			continue;
		}
		profiles.push(classifyProfile(name, config, credentials, reachable));
	}
	return profiles.sort((left, right) => left.name.localeCompare(right.name));
}

/** Resolve a session-shared SSO group through legacy inline and source-profile chains. */
export function resolveAwsSsoAuthGroup(profile: string, config: AwsIni, credentials: AwsIni): string | undefined {
	return findSsoGroup(profile, config, credentials);
}

/** Partition classification is explicit; unknown Regions never fall back to commercial AWS. */
export function partitionForAwsRegion(region: string): AwsPartition | undefined {
	if (region.startsWith("us-gov-")) return "aws-us-gov";
	if (region.startsWith("eusc-")) return "aws-eusc";
	if (region.startsWith("cn-")) return "aws-cn";
	if (region.startsWith("us-isob-")) return "aws-iso-b";
	if (region.startsWith("eu-isoe-")) return "aws-iso-e";
	if (region.startsWith("us-isof-")) return "aws-iso-f";
	if (region.startsWith("us-iso-")) return "aws-iso";
	if (
		/^(?:af-south-1|ap-east-[12]|ap-northeast-[123]|ap-south-[12]|ap-southeast-[1-7]|ca-central-1|ca-west-1|eu-central-[12]|eu-north-1|eu-south-[12]|eu-west-[123]|il-central-1|me-central-1|me-south-1|mx-central-1|sa-east-1|us-east-[12]|us-west-[12])$/u.test(
			region,
		)
	)
		return "aws";
	return undefined;
}

function partitionFromArn(arn: string): AwsPartition | undefined {
	const partition = /^arn:([^:]+):/u.exec(arn)?.[1];
	switch (partition) {
		case "aws":
		case "aws-eusc":
		case "aws-us-gov":
		case "aws-cn":
		case "aws-iso":
		case "aws-iso-b":
		case "aws-iso-e":
		case "aws-iso-f":
			return partition;
		default:
			return undefined;
	}
}

function camelToFlag(key: string): string {
	return key
		.replace(/([A-Z])([A-Z][a-z])/gu, "$1-$2")
		.replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
		.replace(/_/gu, "-")
		.toLowerCase();
}

function assertSafeParameterValue(value: unknown): void {
	if (typeof value === "string") {
		if (FILE_VALUE_RE.test(value.trim()))
			throw new AwsToolError("INVALID_OPERATION: file:// and fileb:// parameter values are not allowed");
		return;
	}
	if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
	if (Array.isArray(value)) {
		for (const item of value) assertSafeParameterValue(item);
		return;
	}
	if (typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) assertSafeParameterValue(item);
		return;
	}
	throw new AwsToolError("INVALID_OPERATION: parameters must contain JSON values");
}

export function buildAwsParameterArgv(parameters: Record<string, unknown> | undefined): string[] {
	const argv: string[] = [];
	for (const [key, value] of Object.entries(parameters ?? {})) {
		if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key)) throw new AwsToolError("INVALID_OPERATION: invalid parameter name");
		const flag = camelToFlag(key);
		const option = value === false ? `no-${flag}` : flag;
		if (
			BLOCKED_PARAMETER_NAMES.some(blocked => blocked.startsWith(flag) || blocked.startsWith(option)) ||
			/^(?:no-)?cli-/u.test(flag)
		) {
			throw new AwsToolError(`INVALID_OPERATION: --${option} is controlled by the native AWS route`);
		}
		assertSafeParameterValue(value);
		if (typeof value === "boolean") argv.push(`--${option}`);
		else argv.push(`--${flag}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return argv;
}

const AWS_REFERENCE_ROOT = "https://servicereference.us-east-1.amazonaws.com/v1/";
const AWS_REFERENCE_TTL_MS = 60 * 60 * 1000;
const AWS_REFERENCE_FAILURE_TTL_MS = 60 * 1000;
const AWS_REFERENCE_TIMEOUT_MS = 5_000;
// IAM Read includes SQS consumption, workload invocation, and credential issuance.
const AWS_STATEFUL_IAM_READ_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	bedrock: new Set(["InvokeAgent", "InvokeFlow", "InvokeInlineAgent"]),
	sagemaker: new Set(["InvokeEndpoint", "InvokeEndpointAsync"]),
	signin: new Set(["CreateOAuth2Token"]),
	sqs: new Set(["ReceiveMessage"]),
};

interface AwsAuthorizedAction {
	service: string;
	name: string;
}

interface AwsServiceReference {
	actions: Map<string, boolean>;
	operations: Map<string, readonly AwsAuthorizedAction[] | null>;
}

function awsRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseAwsServiceReference(value: unknown, service: string): AwsServiceReference | undefined {
	const document = awsRecord(value);
	const operationRows = document?.Operations ?? [];
	if (document?.Name !== service || !Array.isArray(document.Actions) || !Array.isArray(operationRows)) {
		return undefined;
	}
	const actions = new Map<string, boolean>();
	for (const value of document.Actions) {
		const action = awsRecord(value);
		const properties = awsRecord(awsRecord(action?.Annotations)?.Properties);
		if (typeof action?.Name !== "string") continue;
		actions.set(
			action.Name,
			!AWS_STATEFUL_IAM_READ_ACTIONS[service]?.has(action.Name) &&
				typeof properties?.IsList === "boolean" &&
				properties.IsWrite === false &&
				properties.IsPermissionManagement === false &&
				properties.IsTaggingOnly === false,
		);
	}
	const operations = new Map<string, readonly AwsAuthorizedAction[] | null>();
	for (const value of operationRows) {
		const operation = awsRecord(value);
		if (!Array.isArray(operation?.SDK)) continue;
		const authorized = Array.isArray(operation.AuthorizedActions)
			? operation.AuthorizedActions.map((value: unknown): AwsAuthorizedAction | undefined => {
					const action = awsRecord(value);
					if (
						typeof action?.Name !== "string" ||
						typeof action.Service !== "string" ||
						!COMMAND_NAME_RE.test(action.Service)
					) {
						return undefined;
					}
					return { name: action.Name, service: action.Service };
				})
			: [];
		const permitted =
			authorized.length > 0 && authorized.every((action): action is AwsAuthorizedAction => action !== undefined)
				? authorized
				: null;
		for (const value of operation.SDK) {
			const sdk = awsRecord(value);
			if (sdk?.Package !== "Boto3" || typeof sdk.Name !== "string" || typeof sdk.Method !== "string") {
				continue;
			}
			const key = `${sdk.Name}\0${sdk.Method}`;
			operations.set(key, operations.has(key) ? null : permitted);
		}
	}
	return { actions, operations };
}

class AwsOperationAccess {
	#cache = new Map<string, { value: unknown; expiresAt: number }>();
	#pending = new Map<string, Promise<unknown>>();

	async #load<T>(
		path: string,
		parse: (value: unknown) => T | undefined,
		signal?: AbortSignal,
	): Promise<T | undefined> {
		signal?.throwIfAborted();
		const cached = this.#cache.get(path);
		if (cached && cached.expiresAt > Date.now()) return cached.value as T | undefined;
		let pending = this.#pending.get(path) as Promise<T | undefined> | undefined;
		if (!pending) {
			pending = (async () => {
				try {
					const response = await fetch(`${AWS_REFERENCE_ROOT}${path}`, {
						redirect: "error",
						signal: AbortSignal.timeout(AWS_REFERENCE_TIMEOUT_MS),
					});
					return response.ok ? parse(await response.json()) : undefined;
				} catch {
					return undefined;
				}
			})().then(value => {
				this.#cache.set(path, {
					value,
					expiresAt: Date.now() + (value === undefined ? AWS_REFERENCE_FAILURE_TTL_MS : AWS_REFERENCE_TTL_MS),
				});
				this.#pending.delete(path);
				return value;
			});
			this.#pending.set(path, pending);
		}
		return untilAborted(signal, pending);
	}

	async isRead(service: string, operation: string, signal?: AbortSignal): Promise<boolean> {
		const sdkService = service === "s3api" ? "s3" : service;
		const mapping = await this.#load(
			"mapping.json",
			value => awsRecord(awsRecord(awsRecord(awsRecord(value)?.SDK)?.Python)?.Boto3),
			signal,
		);
		const referenceService = awsRecord(mapping?.[sdkService])?.service;
		if (typeof referenceService !== "string" || !COMMAND_NAME_RE.test(referenceService)) return false;
		const reference = await this.#load(
			`${referenceService}/${referenceService}.json`,
			value => parseAwsServiceReference(value, referenceService),
			signal,
		);
		const authorized = reference?.operations.get(`${sdkService}\0${operation.replaceAll("-", "_")}`);
		if (!authorized?.length) return false;
		const results = await Promise.all(
			authorized.map(async action => {
				const source =
					action.service === referenceService
						? reference
						: await this.#load(
								`${action.service}/${action.service}.json`,
								value => parseAwsServiceReference(value, action.service),
								signal,
							);
				return source?.actions.get(action.name) === true;
			}),
		);
		return results.every(Boolean);
	}
}

// Identity probes must remain available when the public AWS reference is unreachable.
function isAwsIdentityProbe(service: string, operation: string): boolean {
	return service === "sts" && operation === "get-caller-identity";
}

function redactedArgv(argv: readonly string[], redactSecrets = true): string {
	return argv
		.map(value => {
			const equals = value.indexOf("=");
			const safe =
				redactSecrets && value.startsWith("--") && equals > 0 && AWS_SECRET_FIELD_RE.test(value.slice(0, equals))
					? `${value.slice(0, equals + 1)}[redacted]`
					: value;
			return `'${safe.replace(/'/gu, "'\\''")}'`;
		})
		.join(" ");
}

const AWS_SECRET_FIELD_RE = /(?:secret|password|token|private[_-]?key|access[_-]?key)/iu;

function redactAwsJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactAwsJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
				key,
				AWS_SECRET_FIELD_RE.test(key) ? "[redacted]" : redactAwsJson(nested),
			]),
		);
	}
	return value;
}

export function redactAwsOutput(value: string, jsonOnly = false): string {
	const withheld = "AWS output withheld: invalid or truncated JSON";
	if (value.length > MAX_AWS_OUTPUT_BYTES || Buffer.byteLength(value, "utf8") > MAX_AWS_OUTPUT_BYTES) return withheld;
	try {
		return JSON.stringify(redactAwsJson(JSON.parse(value)));
	} catch {
		let start = 0;
		while (start < value.length && (/\s/u.test(value[start]!) || value.charCodeAt(start) === 0xfeff)) start++;
		if (jsonOnly || value[start] === "{" || value[start] === "[") return withheld;
		return value
			.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/gu, "[redacted]")
			.replace(
				/((?:["']?)[\w-]*(?:secret|password|token|private[_-]?key|access[_-]?key)[\w-]*(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|\\?$)|'[^']*(?:'|$)|[^\s,}\]]+)/giu,
				"$1[redacted]",
			)
			.replace(/(Authorization:\s*(?:AWS4-HMAC-SHA256|Bearer)\s+)[^\s]+/giu, "$1[redacted]");
	}
}

export function awsFailureCode(
	stderr: string,
	timedOut: boolean,
): "ACCESS_DENIED" | "AUTH_REQUIRED" | "INVALID_OPERATION" | "TIMEOUT" | undefined {
	if (timedOut) return "TIMEOUT";
	if (/\b(?:accessdenied(?:exception)?|unauthorizedoperation|notauthorized(?:exception)?)\b/iu.test(stderr))
		return "ACCESS_DENIED";
	if (
		/\b(?:AUTH_REQUIRED|expiredtoken(?:exception)?|invalidclienttoken(?:id)?|unrecognizedclient(?:exception)?|unable to locate credentials|error loading sso token|sso.*(?:expired|invalid|login))\b/iu.test(
			stderr,
		)
	) {
		return "AUTH_REQUIRED";
	}
	if (
		/\b(?:unknown options|invalid choice|parameter validation failed|invalidparameter(?:value|exception)?)\b/iu.test(
			stderr,
		)
	) {
		return "INVALID_OPERATION";
	}
	return undefined;
}

function minimumAwsEnv(
	profile: string,
	region: string,
	configFile: string,
	credentialsFile: string,
	sessionManagerBin?: string,
): Record<string, string> {
	const inherited = filterProcessEnv(Bun.env);
	const env: Record<string, string> = {};
	for (const key of ["LANG", "LC_ALL", "SYSTEMROOT", "SystemRoot"]) {
		if (inherited[key] !== undefined) env[key] = inherited[key];
	}
	const home = getOperationalAwsLaunchMetadata()?.homeDirectory;
	if (home) {
		env.HOME = home;
		env.USERPROFILE = home;
	}
	if (sessionManagerBin) env.PATH = sessionManagerBin;
	env.AWS_CONFIG_FILE = configFile;
	env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile;
	env.AWS_PROFILE = profile;
	env.AWS_REGION = region;
	env.AWS_EC2_METADATA_DISABLED = "true";
	env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";
	env.AWS_PAGER = "";
	env.AWS_CLI_AUTO_PROMPT = "off";
	env.AWS_CLI_HISTORY_FILE = os.devNull;
	return env;
}

function iniValue(value: string): string {
	return value.replace(/\r/gu, "");
}

function reachableProfiles(profile: string, config: AwsIni, credentials: AwsIni): string[] {
	const ordered: string[] = [];
	const seen = new Set<string>();
	let current: string | undefined = profile;
	while (current && !seen.has(current)) {
		if (CORE_FORGE_PROFILE_RE.test(current) || getReservedManagedAwsProfiles().includes(current)) {
			throw new AwsToolError(
				"AUTH_REQUIRED: managed Coreforge profiles are not available through the native AWS route",
			);
		}
		seen.add(current);
		ordered.push(current);
		const settings = profileSettings(current, config, credentials);
		current = settings.source_profile;
	}
	if (current) throw new AwsToolError("AUTH_REQUIRED: source_profile cycle detected");
	return ordered;
}

function serialiseSafeConfig(profiles: readonly string[], config: AwsIni): string {
	const sections: string[] = [];
	for (const profile of profiles) {
		const values = config[profile];
		if (!values) continue;
		sections.push(profile === "default" ? "[default]" : `[profile ${profile}]`);
		for (const [key, value] of Object.entries(values)) {
			if (key !== "cli_history") sections.push(`${key} = ${iniValue(value)}`);
		}
		sections.push("cli_history = disabled");
		sections.push("");
	}
	const sessions = new Set(
		profiles.map(profile => config[profile]?.sso_session).filter((name): name is string => Boolean(name)),
	);
	for (const session of sessions) {
		const values = config[`${SSO_SECTION_PREFIX}${session}`];
		if (!values) continue;
		sections.push(`[sso-session ${session}]`);
		for (const [key, value] of Object.entries(values)) sections.push(`${key} = ${iniValue(value)}`);
		sections.push("");
	}
	return sections.join("\n");
}

export interface AwsLoginReservation {
	readonly group: string;
}

export class AwsSessionAuthGroups {
	#states = new Map<string, AwsAuthGroupState>();
	#inFlight = new Map<string, Promise<AwsApprovedLoginResult>>();
	#recoveries = new Map<string, Promise<boolean>>();
	#generations = new Map<string, number>();
	#reservations = new Map<string, AwsLoginReservation>();

	status(group: string): AwsAuthGroupState {
		return this.#states.get(group) ?? "unknown";
	}

	generation(group: string): number {
		return this.#generations.get(group) ?? 0;
	}

	#markAuthenticated(group: string): void {
		this.#states.set(group, "authenticated");
		this.#generations.set(group, this.generation(group) + 1);
		this.#reservations.delete(group);
	}

	recordAuthenticationFailure(group: string, generation: number): void {
		if (this.#reservations.has(group) || this.#recoveries.has(group)) return;
		this.#recordFailure(group, generation);
	}

	#recordFailure(group: string, generation: number): void {
		if (this.generation(group) !== generation) return;
		this.#states.set(group, "declined");
	}

	declineLogin(reservation: AwsLoginReservation): void {
		if (this.#reservations.get(reservation.group) !== reservation) return;
		this.#reservations.delete(reservation.group);
		this.#states.set(reservation.group, "declined");
	}

	markApproved(reservation: AwsLoginReservation): void {
		if (this.#reservations.get(reservation.group) !== reservation) return;
		if (this.status(reservation.group) === "offered") this.#states.set(reservation.group, "approved");
	}

	reserveLogin(group: string): AwsLoginReservation | undefined {
		return this.#recoveries.has(group) ? undefined : this.#reserveLogin(group);
	}

	#reserveLogin(group: string): AwsLoginReservation | undefined {
		if (this.#reservations.has(group) || this.#inFlight.has(group)) return undefined;
		const reservation: AwsLoginReservation = { group };
		this.#reservations.set(group, reservation);
		this.#states.set(group, "offered");
		this.#generations.set(group, this.generation(group) + 1);
		return reservation;
	}

	async recoverOnce(
		group: string,
		recover: (reserveLogin: () => AwsLoginReservation | undefined) => Promise<boolean>,
	): Promise<boolean> {
		const pending = this.#recoveries.get(group);
		if (pending) return await pending;
		const login = this.#inFlight.get(group);
		if (login) return (await login).authenticated;
		const state = this.status(group);
		if (state !== "unknown" && state !== "authenticated") return false;
		const generation = this.generation(group);
		let reservation: AwsLoginReservation | undefined;
		const recovery = Promise.resolve().then(() =>
			recover(() => {
				if (reservation) return undefined;
				reservation = this.#reserveLogin(group);
				return reservation;
			}),
		);
		this.#recoveries.set(group, recovery);
		try {
			const authenticated = await recovery;
			if (!authenticated) {
				if (reservation) this.declineLogin(reservation);
				else this.#recordFailure(group, generation);
			}
			return authenticated;
		} catch (error) {
			if (reservation) this.declineLogin(reservation);
			else this.#recordFailure(group, generation);
			throw error;
		} finally {
			this.#recoveries.delete(group);
		}
	}

	/** Run an approved login once for all callers sharing the authentication group. */
	async runApprovedLogin(
		reservation: AwsLoginReservation,
		login: () => Promise<boolean | void>,
	): Promise<AwsApprovedLoginResult> {
		const { group } = reservation;
		const state = this.status(group);
		if (this.#reservations.get(group) !== reservation) {
			return { authenticated: false, declined: state === "declined" };
		}
		const inFlight = this.#inFlight.get(group);
		if (inFlight) return await inFlight;
		if (state !== "approved") return { authenticated: false, declined: false };
		const pending = (async () => {
			const authenticated = (await login()) !== false && this.#reservations.get(group) === reservation;
			if (authenticated) this.#markAuthenticated(group);
			else this.declineLogin(reservation);
			return { authenticated, declined: !authenticated };
		})();
		this.#inFlight.set(group, pending);
		try {
			return await pending;
		} catch (error) {
			this.declineLogin(reservation);
			throw error;
		} finally {
			this.#inFlight.delete(group);
		}
	}
}

let trustedAwsProfiles: AwsProfileCatalogEntry[] | undefined;
let trustedAwsReservedProfiles: readonly string[] | undefined;

const sessionApprovals = new WeakMap<ToolSession["settings"], Set<string>>();
function cacheAwsProfiles(config: AwsIni, credentials: AwsIni): AwsProfileCatalogEntry[] {
	const reserved = getReservedManagedAwsProfiles();
	if (!trustedAwsProfiles || trustedAwsReservedProfiles !== reserved) {
		trustedAwsProfiles = catalogAwsProfiles(config, credentials);
		trustedAwsReservedProfiles = reserved;
	}
	return trustedAwsProfiles;
}

/** List profiles from immutable launcher-selected AWS configuration files. */
export async function listTrustedAwsProfiles(): Promise<AwsProfileCatalogEntry[]> {
	if (trustedAwsProfiles && trustedAwsReservedProfiles === getReservedManagedAwsProfiles()) return trustedAwsProfiles;
	const metadata = getOperationalAwsLaunchMetadata();
	const [config, credentials] = await Promise.all([
		readIni(metadata?.configFile),
		readIni(metadata?.sharedCredentialsFile, "credentials"),
	]);
	return cacheAwsProfiles(config, credentials);
}

/** Validate an explicitly supplied AWS profile against immutable launcher configuration. */
export async function resolveTrustedAwsProfile(profile: string): Promise<AwsProfileCatalogEntry | undefined> {
	if (!isAwsProfileName(profile)) return undefined;
	return (await listTrustedAwsProfiles()).find(candidate => candidate.name === profile);
}

/** Session-global SSO state shared by the native AWS and managed-MCP routes. */
export const awsSessionAuthGroups = new AwsSessionAuthGroups();
export async function resolveTrustedAwsLoginProfile(profile: string): Promise<string | undefined> {
	if (!isAwsProfileName(profile)) return undefined;
	const metadata = getOperationalAwsLaunchMetadata();
	const [config, credentials] = await Promise.all([
		readIni(metadata?.configFile),
		readIni(metadata?.sharedCredentialsFile, "credentials"),
	]);
	return findSsoProfile(profile, config, credentials);
}

/** Describe the source SSO login needed by an explicitly selected profile. */
export async function describeTrustedAwsLogin(profile: string): Promise<string> {
	const loginProfile = await resolveTrustedAwsLoginProfile(profile);
	const executable = getOperationalAwsLaunchMetadata()?.executable;
	const group = (await resolveTrustedAwsProfile(profile))?.ssoGroup;
	const retryHint =
		group && awsSessionAuthGroups.status(group) === "declined"
			? "Automatic AWS sign-in is paused after a declined or failed attempt. Request an explicit AWS SSO login to retry. "
			: "";
	if (!loginProfile || !executable || !path.isAbsolute(executable)) {
		return "AUTH_REQUIRED: no AWS IAM Identity Center login route is configured for this profile.";
	}
	return `${retryHint}Native action: aws(${JSON.stringify({ profile, service: "sso", operation: "login" })}); trusted CLI argv: ${JSON.stringify([executable, "sso", "login", "--profile", loginProfile])}.`;
}
/** Resolve one profile's shared SSO group from immutable launcher-selected AWS files. */
export async function resolveTrustedAwsSsoAuthGroup(profile: string): Promise<string | undefined> {
	const metadata = getOperationalAwsLaunchMetadata();
	const [config, credentials] = await Promise.all([
		readIni(metadata?.configFile),
		readIni(metadata?.sharedCredentialsFile, "credentials"),
	]);
	return resolveAwsSsoAuthGroup(profile, config, credentials);
}

export interface AwsApprovedLoginResult {
	authenticated: boolean;
	declined: boolean;
}

function assertMcpHostOwner(context: MCPHostCallContext | undefined, signal?: AbortSignal): void {
	if (!context?.mcpOwnerCurrent && !context?.mcpCheckOwner) return;
	signal?.throwIfAborted();
	if (context?.mcpOwnerCurrent?.() === false) throw new ToolAbortError("MCP call owner changed");
}

async function checkMcpHostOwner(context: MCPHostCallContext | undefined, signal?: AbortSignal): Promise<void> {
	assertMcpHostOwner(context, signal);
	if (context?.mcpCheckOwner) {
		await context.mcpCheckOwner();
		assertMcpHostOwner(context, signal);
	}
}

export async function recoverTrustedAwsAuthentication(
	profile: string,
	source: string,
	context: MCPHostCallContext | undefined,
	signal?: AbortSignal,
	region?: string,
	existingTool?: AwsTool,
): Promise<boolean> {
	if (!context?.hasUI || !context.ui || !context.settings) return false;
	await checkMcpHostOwner(context, signal);
	const group = (await resolveTrustedAwsProfile(profile))?.ssoGroup;
	await checkMcpHostOwner(context, signal);
	if (!group) return false;
	const { ui, settings } = context;
	return await untilAborted(signal, () =>
		awsSessionAuthGroups.recoverOnce(group, async reserveLogin => {
			await checkMcpHostOwner(context, signal);
			if (awsSessionAuthGroups.status(group) === "authenticated") {
				// Validation runs inside this group's recovery and cannot join that recovery.
				const probe = new AwsTool(
					{
						cwd: context.sessionManager.getCwd(),
						hasUI: false,
						settings,
						getSessionFile: () => null,
						getSessionSpawns: () => null,
					},
					{ attempted: true },
				);
				assertMcpHostOwner(context, signal);
				const validation = await probe.execute(
					"aws-renewal-authentication-check",
					{ profile, service: "sts", operation: "get-caller-identity", region, timeout: 15 },
					signal,
					undefined,
					context,
				);
				await checkMcpHostOwner(context, signal);
				if (!validation.isError) return true;
				if (validation.details?.code !== "AUTH_REQUIRED") return false;
			}
			const tool =
				existingTool ??
				new AwsTool({
					cwd: context.sessionManager.getCwd(),
					hasUI: true,
					settings,
					getSessionFile: () => null,
					getSessionSpawns: () => null,
				});
			const params: AwsToolParams = { profile, service: "sso", operation: "login", region, timeout: 120 };
			const { approvalMode, userPolicies } = resolveApprovalFromContext(context);
			if (resolveApproval(tool, params, approvalMode, userPolicies).policy === "deny") return false;
			const callId = `aws-sso-login-${crypto.randomUUID()}`;
			try {
				await checkMcpHostOwner(context, signal);
				assertMcpHostOwner(context, signal);
				const request = await tool.prepareRuntimeApproval(callId, params, signal, context, () => {
					assertMcpHostOwner(context, signal);
					return reserveLogin();
				});
				await checkMcpHostOwner(context, signal);
				if (request) {
					const capability =
						existingTool && request.allowSessionApproval === true ? tool.sessionApproval : undefined;
					const message = `${request.prompt}\nSource: ${source}`;
					let approveSession = false;
					let approved: boolean;
					assertMcpHostOwner(context, signal);
					if (existingTool) {
						const choice = await ui.select(
							`AWS sign-in approval\nReason: ${request.reason}\n${message}`,
							capability ? ["Deny", "Approve once", capability.label] : ["Deny", "Approve once"],
							{ signal, timeout: 120_000, tuiStyle: request.tuiStyle },
						);
						approveSession = capability !== undefined && choice === capability.label;
						approved = choice === "Approve once" || approveSession;
					} else {
						approved = await ui.confirm(request.reason, message, { signal, timeout: 120_000 });
					}
					await checkMcpHostOwner(context, signal);
					signal?.throwIfAborted();
					assertMcpHostOwner(context, signal);
					if (!approved) {
						tool.denyRuntimeApproval(callId, params);
						return false;
					}
					tool.approveRuntimeApproval(callId, params);
					if (approveSession) capability!.approve();
				}
				await checkMcpHostOwner(context, signal);
				assertMcpHostOwner(context, signal);
				return !(await tool.execute(callId, params, signal, undefined, context)).isError;
			} catch (error) {
				tool.denyRuntimeApproval(callId, params);
				throw error;
			}
		}),
	);
}

export class AwsTool implements AgentTool<typeof awsSchema, AwsToolDetails> {
	readonly name = "aws";
	readonly label = "AWS";
	readonly summary = "Call AWS APIs through the trusted AWS CLI route";
	#description?: string;
	#catalog?: AwsProfileCatalogEntry[];
	#schemaReservedProfiles?: readonly string[];
	#parameters?: typeof awsSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	#prepared = new Map<string, { fingerprint: string; sessionId: string | null; call: PreparedAwsCall }>();
	#approved = new Map<string, string>();
	#access = new AwsOperationAccess();
	#classifications = new Map<string, { read: boolean; expiresAt: number }>();
	#instanceApproval = false;

	#getSessionId(): string | null {
		return this.session.getSessionId?.() ?? this.session.sessionManager?.getSessionId?.() ?? null;
	}

	#hasSessionApproval(): boolean {
		const sessionId = this.#getSessionId();
		return sessionId === null
			? this.#instanceApproval
			: sessionApprovals.get(this.session.settings)?.has(sessionId) === true;
	}

	get sessionApproval() {
		const sessionId = this.#getSessionId();
		return {
			label: "Allow for the rest of this session",
			approve: (): void => {
				if (sessionId !== this.#getSessionId()) {
					throw new AwsToolError("AUTH_REQUIRED: session changed while awaiting AWS approval");
				}
				if (sessionId === null) {
					this.#instanceApproval = true;
					return;
				}
				let approved = sessionApprovals.get(this.session.settings);
				if (!approved) sessionApprovals.set(this.session.settings, (approved = new Set()));
				approved.add(sessionId);
			},
		};
	}

	get parameters(): typeof awsSchema {
		const reserved = getReservedManagedAwsProfiles();
		if (this.#parameters && this.#schemaReservedProfiles === reserved) return this.#parameters;
		const metadata = getOperationalAwsLaunchMetadata();
		const config = readIniSync(metadata?.configFile);
		const credentials = readIniSync(metadata?.sharedCredentialsFile, "credentials");
		this.#catalog = cacheAwsProfiles(config, credentials);
		this.#schemaReservedProfiles = reserved;
		this.#description = `${prompt.render(awsDescription)}\nLocal profile routing metadata (no credentials):\n${JSON.stringify(this.#catalog.map(profile => ({ ...profile, managedMcpCompatible: profile.partition === "aws" })))}`;
		return (this.#parameters = buildAwsSchema(this.#catalog.map(profile => profile.name)));
	}

	get description(): string {
		void this.parameters;
		return this.#description!;
	}

	constructor(
		private readonly session: ToolSession,
		private readonly authenticationRecovery?: AwsAuthenticationRecoveryBudget,
	) {
		session.registerDisposeCallback?.(() => {
			for (const callId of this.#prepared.keys()) {
				void this.#discardPrepared(callId).catch(error =>
					logger.warn("Failed to remove AWS temporary configuration", { error }),
				);
			}
		});
	}

	async #discardPrepared(callId: string): Promise<void> {
		const prepared = this.#prepared.get(callId);
		this.#prepared.delete(callId);
		this.#approved.delete(callId);
		if (prepared) {
			if (prepared.call.loginReservation) awsSessionAuthGroups.declineLogin(prepared.call.loginReservation);
			await fs.rm(prepared.call.tempDir, { force: true, recursive: true });
		}
	}

	readonly approval = (args: unknown): ToolApprovalDecision => {
		const tier = this.#approvalTier(args);
		return this.#hasSessionApproval() ? { tier, policy: "allow" } : tier;
	};

	#approvalTier(args: unknown): "read" | "exec" {
		const input = args as Partial<AwsToolParams>;
		if (
			(input.service === "sso" && input.operation === "login") ||
			isAwsIdentityProbe(String(input.service ?? ""), String(input.operation ?? ""))
		) {
			return "read";
		}
		const key = `${input.service}\0${input.operation}`;
		const classification = this.#classifications.get(key);
		return classification?.read && classification.expiresAt > Date.now() ? "read" : "exec";
	}
	async prepareApprovalTier(args: unknown, signal?: AbortSignal): Promise<void> {
		const input = args as Partial<AwsToolParams>;
		if (
			typeof input.service !== "string" ||
			typeof input.operation !== "string" ||
			!COMMAND_NAME_RE.test(input.service) ||
			!COMMAND_NAME_RE.test(input.operation) ||
			Object.hasOwn(BLOCKED_AWS_SERVICES, input.service) ||
			input.service === "sso" ||
			this.#approvalTier(input) === "read"
		) {
			return;
		}
		const read = await this.#access.isRead(input.service, input.operation, signal);
		this.#classifications.set(`${input.service}\0${input.operation}`, {
			read,
			expiresAt: Date.now() + AWS_REFERENCE_TTL_MS,
		});
	}

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const input = args as Partial<AwsToolParams>;
		return [
			`Profile: ${typeof input.profile === "string" ? truncateForPrompt(input.profile) : "(missing)"}`,
			`Operation: ${typeof input.service === "string" ? input.service : "(missing)"} ${typeof input.operation === "string" ? input.operation : "(missing)"}`,
		];
	};

	async #loadCatalog(): Promise<{ config: AwsIni; credentials: AwsIni; profiles: AwsProfileCatalogEntry[] }> {
		const metadata = getOperationalAwsLaunchMetadata();
		const [config, credentials] = await Promise.all([
			readIni(metadata?.configFile),
			readIni(metadata?.sharedCredentialsFile, "credentials"),
		]);
		this.#catalog = cacheAwsProfiles(config, credentials);
		return { config, credentials, profiles: this.#catalog };
	}

	async #prepare(params: AwsToolParams, signal?: AbortSignal): Promise<PreparedAwsCall> {
		const metadata = getOperationalAwsLaunchMetadata();
		if (!metadata?.executable)
			throw new AwsToolError("AWS_CLI_UNAVAILABLE: no trusted AWS CLI executable was captured at launch");
		if (!path.isAbsolute(metadata.executable))
			throw new AwsToolError("AUTH_REQUIRED: trusted AWS executable must be absolute");
		if (process.platform === "win32" && path.extname(metadata.executable).toLowerCase() !== ".exe") {
			throw new AwsToolError(
				"AWS_CLI_UNAVAILABLE: the native AWS route requires aws.exe, not a shell command wrapper",
			);
		}
		try {
			const stat = await fs.stat(metadata.executable);
			if (!stat.isFile()) throw new Error("not a file");
		} catch {
			throw new AwsToolError("AWS_CLI_UNAVAILABLE: the trusted AWS executable is unavailable");
		}
		if (!isAwsProfileName(params.profile)) throw new AwsToolError("PROFILE_NOT_FOUND: invalid AWS profile name");
		if (!COMMAND_NAME_RE.test(params.service) || !COMMAND_NAME_RE.test(params.operation)) {
			throw new AwsToolError("INVALID_OPERATION: service and operation must be AWS CLI command names");
		}
		const login = params.service === "sso" && params.operation === "login";
		if (Object.hasOwn(BLOCKED_AWS_SERVICES, params.service) || (params.service === "sso" && !login)) {
			throw new AwsToolError("INVALID_OPERATION: AWS CLI helpers and unsupported SSO operations are blocked");
		}
		const { config, credentials, profiles } = await this.#loadCatalog();
		const profile = profiles.find(candidate => candidate.name === params.profile);
		if (!profile) throw new AwsToolError(`PROFILE_NOT_FOUND: AWS profile ${params.profile} is not configured`);
		const reachable = reachableProfiles(params.profile, config, credentials);
		const configuredRegion = profile.configuredRegion?.trim();
		const region = (params.region ?? configuredRegion)?.trim();
		const configuredPartition = configuredProfilePartition(reachable, config, credentials);
		const requestedPartition = region ? partitionForAwsRegion(region) : undefined;
		if (
			configuredPartition === null ||
			(configuredPartition !== undefined && configuredPartition !== requestedPartition)
		) {
			throw new AwsToolError("WRONG_PARTITION: requested region does not match the configured profile partition");
		}
		if (!region || !REGION_RE.test(region))
			throw new AwsToolError("WRONG_PARTITION: an explicit valid region is required for this AWS profile");
		if (!requestedPartition)
			throw new AwsToolError("WRONG_PARTITION: AWS partition cannot be determined from region");
		if (metadata.sharedCredentialsFile && !path.isAbsolute(metadata.sharedCredentialsFile)) {
			throw new AwsToolError("PROFILE_NOT_FOUND: launcher provided an invalid AWS credentials path");
		}
		if (metadata.configFile && !path.isAbsolute(metadata.configFile)) {
			throw new AwsToolError("PROFILE_NOT_FOUND: launcher provided an invalid AWS configuration path");
		}
		await this.#validateCredentialProcesses(reachable, config, credentials);
		const loginProfile = login ? findSsoProfile(params.profile, config, credentials) : undefined;
		if (login && !loginProfile)
			throw new AwsToolError(
				"AUTH_REQUIRED: selected profile does not resolve to an AWS IAM Identity Center profile",
			);
		const argv = [
			metadata.executable,
			"--no-cli-pager",
			"--output",
			"json",
			"--profile",
			login ? loginProfile! : params.profile,
			"--region",
			region,
			params.service,
			params.operation,
			...buildAwsParameterArgv(params.parameters),
		];
		const dcg = await enforceDestructiveCommandGuard(redactedArgv(argv, false), this.session.cwd, "posix", signal);
		await this.prepareApprovalTier(params, signal);
		const mutation = !login && this.#approvalTier(params) !== "read";
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aws-"));
		const configPath = path.join(tempDir, "config");
		const sessionManager =
			(params.service === "ecs" && params.operation === "execute-command") ||
			(params.service === "ssm" && params.operation === "start-session");
		let sessionManagerBin: string | undefined;
		try {
			await fs.writeFile(configPath, serialiseSafeConfig(reachable, config), { mode: 0o600 });
			if (sessionManager) {
				const plugin = metadata.sessionManagerPlugin;
				if (!plugin || !path.isAbsolute(plugin)) {
					throw new AwsToolError(
						"AWS_SESSION_MANAGER_UNAVAILABLE: install session-manager-plugin on your launcher PATH and restart Coreforge",
					);
				}
				const resolved = await fs.realpath(plugin);
				if (
					!(await fs.stat(resolved)).isFile() ||
					(process.platform === "win32" && path.extname(resolved).toLowerCase() !== ".exe")
				) {
					throw new AwsToolError("AWS_SESSION_MANAGER_UNAVAILABLE: the captured plugin is not executable");
				}
				await fs.access(resolved, fs.constants.X_OK);
				const bin = path.join(tempDir, "bin");
				await fs.mkdir(bin, { mode: 0o700 });
				const target = path.join(
					bin,
					process.platform === "win32" ? "session-manager-plugin.exe" : "session-manager-plugin",
				);
				if (process.platform === "win32") await fs.copyFile(resolved, target);
				else await fs.symlink(resolved, target);
				sessionManagerBin = bin;
			}
		} catch (error) {
			await fs.rm(tempDir, { force: true, recursive: true });
			throw error;
		}
		return {
			params,
			profile,
			region,
			argv,
			mutation,
			login,
			authRecovery: this.authenticationRecovery ?? { attempted: false },
			ownsAuthRecovery: false,
			authenticationGeneration: profile.ssoGroup ? awsSessionAuthGroups.generation(profile.ssoGroup) : 0,
			...(loginProfile ? { loginProfile } : {}),
			configPath,
			tempDir,
			...(sessionManagerBin ? { sessionManagerBin } : {}),
			...(dcg ? { dcg } : {}),
		};
	}

	async #validateCredentialProcesses(profiles: readonly string[], config: AwsIni, credentials: AwsIni): Promise<void> {
		let repositoryRoot: string | undefined;
		for (const profile of profiles) {
			const command = profileSettings(profile, config, credentials).credential_process;
			if (!command) continue;
			if (credentials[profile]?.credential_process) {
				throw new AwsToolError("AUTH_REQUIRED: credential_process must be configured in the AWS config file");
			}
			const windowsWord =
				process.platform === "win32" ? /^(?:"([^"]+)"|([^\s"]+))(?=\s|$)/u.exec(command.trim()) : undefined;
			const word = windowsWord
				? { value: windowsWord[1] ?? windowsWord[2], rest: command.trim().slice(windowsWord[0].length).trim() }
				: readShellWord(command);
			if (!word || word === "unterminated" || !word.value || !path.isAbsolute(word.value)) {
				throw new AwsToolError("AUTH_REQUIRED: credential_process requires an absolute trusted executable");
			}
			if (!repositoryRoot) {
				repositoryRoot = await fs.realpath(this.session.cwd);
				for (let directory = repositoryRoot; ; directory = path.dirname(directory)) {
					if (
						await fs.lstat(path.join(directory, ".git")).then(
							() => true,
							error => {
								if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
								throw error;
							},
						)
					) {
						repositoryRoot = directory;
						break;
					}
					if (path.dirname(directory) === directory) break;
				}
			}
			let resolved: string;
			try {
				resolved = await fs.realpath(word.value);
			} catch {
				throw new AwsToolError("AUTH_REQUIRED: credential_process helper is unavailable");
			}
			const relativeToRepository = path.relative(repositoryRoot, resolved);
			const name = path
				.basename(resolved)
				.toLowerCase()
				.replace(/\.exe$/u, "");
			if (
				relativeToRepository === "" ||
				(!relativeToRepository.startsWith(`..${path.sep}`) && relativeToRepository !== "..") ||
				/^(?:sh|bash|dash|zsh|fish|csh|ksh|cmd|powershell|pwsh|env|xargs|sudo|doas|osascript|node|bun|python[\d.]*|ruby|perl)$/u.test(
					name,
				) ||
				/\.(?:sh|bash|zsh|js|ts|py|rb|pl|cmd|bat|ps1)$/iu.test(resolved)
			) {
				throw new AwsToolError("AUTH_REQUIRED: credential_process helper is not a trusted native executable");
			}
			const handle = await fs.open(resolved, "r");
			try {
				const magic = Buffer.allocUnsafe(4);
				const { bytesRead } = await handle.read(magic, 0, 4, 0);
				const signature = bytesRead === 4 ? magic.readUInt32BE() : 0;
				const native =
					process.platform === "win32"
						? signature >>> 16 === 0x4d5a
						: process.platform === "darwin"
							? signature === 0xfeedface ||
								signature === 0xfeedfacf ||
								signature === 0xcefaedfe ||
								signature === 0xcffaedfe ||
								signature === 0xcafebabe ||
								signature === 0xbebafeca ||
								signature === 0xcafebabf ||
								signature === 0xbfbafeca
							: signature === 0x7f454c46;
				if (!(await handle.stat()).isFile() || !native) {
					throw new AwsToolError(
						"AUTH_REQUIRED: credential_process must reference a native executable; scripts are not allowed",
					);
				}
			} finally {
				await handle.close();
			}
			config[profile].credential_process = `${JSON.stringify(resolved)}${word.rest ? ` ${word.rest}` : ""}`;
		}
	}

	async prepareRuntimeApproval(
		toolCallId: string,
		args: unknown,
		signal?: AbortSignal,
		context?: AgentToolContext,
		reserveLogin?: () => AwsLoginReservation | undefined,
	): Promise<RuntimeToolApprovalRequest | undefined> {
		const params = args as AwsToolParams;
		const sessionId = this.#getSessionId();
		await this.#discardPrepared(toolCallId);
		const prepared = await this.#prepare(params, signal);
		try {
			const fingerprint = JSON.stringify(params);
			const metadata = getOperationalAwsLaunchMetadata();
			const credentialsFile = metadata?.sharedCredentialsFile ?? os.devNull;
			const timeout = clampTimeout("aws", params.timeout, cfgToolsMaxTimeout.get(this.session.settings)) * 1000;
			const env = minimumAwsEnv(
				prepared.loginProfile ?? params.profile,
				prepared.region,
				prepared.configPath,
				credentialsFile,
				prepared.sessionManagerBin,
			);
			if (prepared.mutation && !prepared.login) {
				prepared.expectedIdentity = await this.#verifyIdentityWithRecovery(
					prepared,
					env,
					timeout,
					signal,
					context ?? this.session.getToolContext?.(),
				);
			}
			if (sessionId !== this.#getSessionId()) {
				throw new AwsToolError("AUTH_REQUIRED: session changed while preparing AWS approval");
			}
			this.#prepared.set(toolCallId, { fingerprint, sessionId, call: prepared });
			if (prepared.login) {
				const group = prepared.profile.ssoGroup;
				if (!group) throw new AwsToolError("AUTH_REQUIRED: selected profile does not use AWS IAM Identity Center");
				prepared.loginReservation = reserveLogin ? reserveLogin() : awsSessionAuthGroups.reserveLogin(group);
				if (!prepared.loginReservation)
					throw new AwsToolError(
						"AUTH_REQUIRED: AWS SSO sign-in is already awaiting approval or running for this authentication group",
					);
				if (this.#hasSessionApproval() && prepared.dcg?.decision !== "ask") {
					this.approveRuntimeApproval(toolCallId, params);
					return undefined;
				}
				return {
					reason: "AWS IAM Identity Center sign-in",
					prompt: `Sign in to AWS SSO for profile ${prepared.profile.name}?\nAWS command: ${redactedArgv(prepared.argv)}`,
					allowSessionApproval: prepared.dcg?.decision !== "ask",
				};
			}
			if (prepared.dcg?.decision === "ask" || (prepared.mutation && !this.#hasSessionApproval())) {
				return {
					reason:
						prepared.dcg?.decision === "ask"
							? prepared.dcg.reason
							: "AWS mutation requires verified account approval",
					prompt: `AWS command: ${redactedArgv(prepared.argv)}\nAccount: ${prepared.expectedIdentity?.account ?? "not verified"}\nARN: ${prepared.expectedIdentity?.arn ?? "not verified"}\nRegion: ${prepared.region}\nPartition: ${prepared.expectedIdentity?.partition ?? "unknown"}`,
					tuiStyle: "destructive",
					allowSessionApproval: prepared.dcg?.decision !== "ask",
				};
			}
			return undefined;
		} catch (error) {
			if (prepared.loginReservation) awsSessionAuthGroups.declineLogin(prepared.loginReservation);
			this.#prepared.delete(toolCallId);
			this.#approved.delete(toolCallId);
			await fs.rm(prepared.tempDir, { force: true, recursive: true });
			throw error;
		}
	}

	approveRuntimeApproval(toolCallId: string, args: unknown): void {
		const params = args as AwsToolParams;
		const fingerprint = JSON.stringify(params);
		const prepared = this.#prepared.get(toolCallId);
		if (prepared?.fingerprint !== fingerprint || prepared.sessionId !== this.#getSessionId()) return;
		if (params.service === "sso" && params.operation === "login") {
			const reservation = prepared.call.loginReservation;
			if (!reservation) return;
			awsSessionAuthGroups.markApproved(reservation);
		}
		this.#approved.set(toolCallId, fingerprint);
	}

	denyRuntimeApproval(toolCallId: string, args: unknown): void {
		const fingerprint = JSON.stringify(args);
		const prepared = this.#prepared.get(toolCallId);
		if (prepared?.fingerprint !== fingerprint) return;
		if (prepared.call.loginReservation) awsSessionAuthGroups.declineLogin(prepared.call.loginReservation);
		this.#approved.delete(toolCallId);
		this.#prepared.delete(toolCallId);
		void fs.rm(prepared.call.tempDir, { force: true, recursive: true });
	}

	async #run(
		argv: string[],
		env: Record<string, string>,
		timeoutMs: number,
		signal?: AbortSignal,
		onStdout?: (chunk: string) => void,
		keepStdinOpen = false,
		context?: MCPHostCallContext,
	) {
		if (context?.mcpCheckOwner) await context.mcpCheckOwner();
		assertMcpHostOwner(context, signal);
		return await ptree.exec(argv, {
			cwd: os.tmpdir(),
			env,
			timeout: timeoutMs,
			onStdout,
			keepStdinOpen,
			signal,
			detached: true,
			subreaper: true,
			maxOutputBytes: MAX_AWS_OUTPUT_BYTES,
			allowNonZero: true,
			allowAbort: true,
		});
	}

	async #recoverAuthentication(
		prepared: PreparedAwsCall,
		source: string,
		context: AgentToolContext | undefined,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (prepared.authRecovery.attempted) {
			if (prepared.ownsAuthRecovery && prepared.profile.ssoGroup)
				awsSessionAuthGroups.recordAuthenticationFailure(
					prepared.profile.ssoGroup,
					prepared.authenticationGeneration,
				);
			return false;
		}
		prepared.authRecovery.attempted = true;
		prepared.ownsAuthRecovery = true;
		const authenticated = await recoverTrustedAwsAuthentication(
			prepared.params.profile,
			source,
			context,
			signal,
			prepared.region,
			this.authenticationRecovery ? undefined : this,
		);
		if (authenticated && prepared.profile.ssoGroup)
			prepared.authenticationGeneration = awsSessionAuthGroups.generation(prepared.profile.ssoGroup);
		return authenticated;
	}

	async #verifyIdentityWithRecovery(
		prepared: PreparedAwsCall,
		env: Record<string, string>,
		timeoutMs: number,
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<AwsIdentity> {
		try {
			return await this.#verifyIdentity(prepared, env, timeoutMs, signal, context);
		} catch (error) {
			if (!(error instanceof ToolError) || error.context?.code !== "AUTH_REQUIRED") throw error;
			if (
				!(await this.#recoverAuthentication(prepared, "native AWS mutation identity verification", context, signal))
			) {
				throw new AwsToolError(`${error.message}\n${await describeTrustedAwsLogin(prepared.params.profile)}`);
			}
			try {
				return await this.#verifyIdentity(prepared, env, timeoutMs, signal, context);
			} catch (retryError) {
				if (
					retryError instanceof ToolError &&
					retryError.context?.code === "AUTH_REQUIRED" &&
					prepared.profile.ssoGroup
				) {
					awsSessionAuthGroups.recordAuthenticationFailure(
						prepared.profile.ssoGroup,
						prepared.authenticationGeneration,
					);
				}
				throw retryError;
			}
		}
	}

	async #verifyIdentity(
		prepared: PreparedAwsCall,
		env: Record<string, string>,
		timeoutMs: number,
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<AwsIdentity> {
		if (prepared.profile.ssoGroup)
			prepared.authenticationGeneration = awsSessionAuthGroups.generation(prepared.profile.ssoGroup);
		const identity = await this.#run(
			[
				prepared.argv[0]!,
				"--no-cli-pager",
				"--output",
				"json",
				"--profile",
				prepared.params.profile,
				"--region",
				prepared.region,
				"sts",
				"get-caller-identity",
			],
			env,
			timeoutMs,
			signal,
			undefined,
			false,
			context,
		);
		if (!identity.ok) {
			const code = awsFailureCode(identity.stderr, identity.exitError instanceof ptree.TimeoutError) ?? "AWS_ERROR";
			throw new AwsToolError(`${code}: AWS STS identity verification failed`, { code });
		}
		let arn: string | undefined;
		let account: string | undefined;
		try {
			const parsed = awsIdentitySchema.assert(JSON.parse(identity.stdout));
			arn = parsed.Arn;
			account = parsed.Account;
		} catch {
			throw new AwsToolError("AWS_ERROR: STS returned an invalid identity response");
		}
		const selectedPartition = partitionForAwsRegion(prepared.region);
		const identityPartition = arn ? partitionFromArn(arn) : undefined;
		if (!arn || !selectedPartition || !identityPartition || selectedPartition !== identityPartition) {
			throw new AwsToolError("WRONG_PARTITION: verified STS identity does not match the selected region partition");
		}
		if (!account || !/^\d{12}$/u.test(account) || arn.split(":")[4] !== account) {
			throw new AwsToolError("AWS_ERROR: STS returned an invalid account identity");
		}
		if (
			!prepared.profile.ssoGroup ||
			awsSessionAuthGroups.generation(prepared.profile.ssoGroup) === prepared.authenticationGeneration
		)
			prepared.profile.lastValidation = "valid";
		return { account, arn, partition: identityPartition };
	}

	async execute(
		toolCallId: string,
		params: AwsToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AwsToolDetails, typeof awsSchema>,
		context?: MCPHostCallContext,
	): Promise<AgentToolResult<AwsToolDetails>> {
		const fingerprint = JSON.stringify(params);
		const sessionId = this.#getSessionId();
		let cached = this.#prepared.get(toolCallId);
		if (cached && (cached.fingerprint !== fingerprint || cached.sessionId !== sessionId)) {
			await this.#discardPrepared(toolCallId);
			cached = undefined;
		}
		const prepared = cached?.call ?? (await this.#prepare(params, signal));
		const metadata = getOperationalAwsLaunchMetadata();
		const credentialsFile = metadata?.sharedCredentialsFile ?? os.devNull;
		const timeout = clampTimeout("aws", params.timeout, cfgToolsMaxTimeout.get(this.session.settings));
		const executionEnv = minimumAwsEnv(
			prepared.loginProfile ?? params.profile,
			prepared.region,
			prepared.configPath,
			credentialsFile,
			prepared.sessionManagerBin,
		);
		try {
			signal?.throwIfAborted();
			if (sessionId !== this.#getSessionId()) {
				throw new AwsToolError("AUTH_REQUIRED: session changed before AWS execution");
			}
			if (prepared.login) {
				const group = prepared.profile.ssoGroup;
				if (
					group &&
					this.#hasSessionApproval() &&
					prepared.dcg?.decision !== "ask" &&
					!this.#approved.has(toolCallId)
				) {
					prepared.loginReservation = awsSessionAuthGroups.reserveLogin(group);
					if (!prepared.loginReservation) {
						throw new AwsToolError("AUTH_REQUIRED: AWS SSO sign-in is already awaiting approval or running");
					}
					awsSessionAuthGroups.markApproved(prepared.loginReservation);
					this.#approved.set(toolCallId, fingerprint);
				}
				if (
					!group ||
					!prepared.loginReservation ||
					awsSessionAuthGroups.status(group) !== "approved" ||
					this.#approved.get(toolCallId) !== fingerprint
				) {
					throw new AwsToolError("AUTH_REQUIRED: explicit AWS SSO login approval is required");
				}
				if (context?.mcpCheckOwner) await context.mcpCheckOwner();
				assertMcpHostOwner(context, signal);
				const loginResult = await awsSessionAuthGroups.runApprovedLogin(prepared.loginReservation, async () => {
					let pending = "";
					const ui = context?.ui;
					const result = await this.#run(
						prepared.argv,
						executionEnv,
						timeout * 1000,
						signal,
						ui
							? chunk => {
									pending += chunk;
									const newline = pending.lastIndexOf("\n");
									if (newline >= 0) {
										ui.notify(redactAwsOutput(pending.slice(0, newline)), "info");
										pending = pending.slice(newline + 1);
									}
								}
							: undefined,
						false,
						context,
					);
					if (pending) ui?.notify(redactAwsOutput(pending), "info");
					return result.ok;
				});
				if (!loginResult.authenticated) throw new AwsToolError("AUTH_REQUIRED: AWS SSO login did not complete");
				for (const profile of trustedAwsProfiles ?? []) {
					if (profile.ssoGroup === group) profile.lastValidation = "unverified";
				}
				return toolResult<AwsToolDetails>({
					profile: params.profile,
					service: params.service,
					operation: params.operation,
					region: prepared.region,
				})
					.text("AWS SSO login completed.")
					.done();
			}
			if (
				(prepared.dcg?.decision === "ask" || (prepared.mutation && !this.#hasSessionApproval())) &&
				this.#approved.get(toolCallId) !== fingerprint
			) {
				throw new AwsToolError("INVALID_OPERATION: AWS operation requires Destructive Command Guard approval");
			}
			const identity = prepared.mutation
				? await this.#verifyIdentityWithRecovery(
						prepared,
						executionEnv,
						timeout * 1000,
						signal,
						context ?? this.session.getToolContext?.(),
					)
				: undefined;
			if (
				prepared.expectedIdentity &&
				(!identity ||
					identity.arn !== prepared.expectedIdentity.arn ||
					identity.partition !== prepared.expectedIdentity.partition)
			) {
				throw new AwsToolError(
					"AUTH_REQUIRED: AWS identity changed after approval; review and retry the operation",
				);
			}
			const allocation = await this.session.allocateOutputArtifact?.("aws");
			const sink = new OutputSink({ artifactPath: allocation?.path, artifactId: allocation?.id });
			if (sessionId !== this.#getSessionId()) {
				throw new AwsToolError("AUTH_REQUIRED: session changed before AWS execution");
			}
			if (prepared.profile.ssoGroup)
				prepared.authenticationGeneration = awsSessionAuthGroups.generation(prepared.profile.ssoGroup);
			let result = await this.#run(
				prepared.argv,
				executionEnv,
				timeout * 1000,
				signal,
				undefined,
				prepared.sessionManagerBin !== undefined,
				context,
			);
			if (
				!result.ok &&
				awsFailureCode(result.stderr, result.exitError instanceof ptree.TimeoutError) === "AUTH_REQUIRED" &&
				(await this.#recoverAuthentication(
					prepared,
					`native AWS: ${params.service} ${params.operation}`,
					context ?? this.session.getToolContext?.(),
					signal,
				))
			) {
				if (prepared.mutation) {
					const refreshedIdentity = await this.#verifyIdentityWithRecovery(
						prepared,
						executionEnv,
						timeout * 1000,
						signal,
						context ?? this.session.getToolContext?.(),
					);
					if (!identity || refreshedIdentity.arn !== identity.arn) {
						throw new AwsToolError(
							"AUTH_REQUIRED: AWS identity changed after sign-in; review and retry the operation",
						);
					}
				}
				if (prepared.profile.ssoGroup)
					prepared.authenticationGeneration = awsSessionAuthGroups.generation(prepared.profile.ssoGroup);
				result = await this.#run(
					prepared.argv,
					executionEnv,
					timeout * 1000,
					signal,
					undefined,
					prepared.sessionManagerBin !== undefined,
					context,
				);
				if (!result.ok && awsFailureCode(result.stderr, false) === "AUTH_REQUIRED" && prepared.profile.ssoGroup) {
					awsSessionAuthGroups.recordAuthenticationFailure(
						prepared.profile.ssoGroup,
						prepared.authenticationGeneration,
					);
				}
			}
			if (result.stdout)
				sink.push(
					result.stdoutTruncated
						? "AWS output withheld: truncated response"
						: redactAwsOutput(result.stdout, !prepared.sessionManagerBin),
				);
			if (result.stderr) sink.push(redactAwsOutput(result.stderr));
			const timedOut = result.exitError instanceof ptree.TimeoutError;
			const output = await sink.dump(
				timedOut
					? `AWS timed out after ${timeout}s`
					: result.stdoutTruncated
						? `AWS output and artifact capped at ${MAX_AWS_OUTPUT_BYTES} bytes`
						: undefined,
			);
			const failed = !result.ok;
			const failure = awsFailureCode(result.stderr, timedOut) ?? (failed ? "AWS_ERROR" : undefined);
			if (
				!prepared.profile.ssoGroup ||
				awsSessionAuthGroups.generation(prepared.profile.ssoGroup) === prepared.authenticationGeneration
			) {
				if (failure === "AUTH_REQUIRED") prepared.profile.lastValidation = "auth-required";
				else if (failure === "ACCESS_DENIED") prepared.profile.lastValidation = "access-denied";
				else if (!failed) prepared.profile.lastValidation = "valid";
			}
			const details: AwsToolDetails = {
				profile: params.profile,
				service: params.service,
				operation: params.operation,
				region: prepared.region,
				...(identity ? { partition: identity.partition, identityArn: identity.arn } : {}),
				...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
				...(timedOut ? { timedOut: true } : {}),
				...(failure ? { code: failure } : {}),
			};
			const body = output.output || (!failed ? "AWS operation completed with no output." : "AWS operation failed.");
			const authHint = failure === "AUTH_REQUIRED" ? `\n${await describeTrustedAwsLogin(params.profile)}` : "";
			return toolResult(details)
				.text((failure ? `${failure}: ${body}` : body) + authHint)
				.truncationFromSummary(output, { direction: "head" })
				.error(failed)
				.done();
		} catch (error) {
			if (prepared.loginReservation) awsSessionAuthGroups.declineLogin(prepared.loginReservation);
			throw error;
		} finally {
			this.#approved.delete(toolCallId);
			this.#prepared.delete(toolCallId);
			await fs.rm(prepared.tempDir, { force: true, recursive: true });
		}
	}
}
