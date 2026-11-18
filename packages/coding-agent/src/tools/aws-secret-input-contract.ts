import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Type } from "@oh-my-pi/omptype/typebox";

export const AWS_SECRET_INPUT_PROTOCOL = "aws-secret-input/v1" as const;
export const AWS_SECRET_INPUT_LIMITS = Object.freeze({
	maxInputBytes: 65_536,
	maxStdoutBytes: 1_048_576,
	maxStderrBytes: 1_048_576,
	defaultTimeoutMs: 30_000,
	maxTimeoutMs: 120_000,
});
const text = (maxLength: number, pattern?: string) => {
	const schema = type("string").atLeastLength(1).atMostLength(maxLength);
	return pattern ? schema.matching(new RegExp(`${pattern}(?![\\s\\S])`, "u")) : schema;
};
const partitionSchema = Type.Union([Type.Literal("aws"), Type.Literal("aws-us-gov"), Type.Literal("aws-cn")]);
export const awsSecretInputSchema = Type.Object(
	{
		protocol: Type.Literal(AWS_SECRET_INPUT_PROTOCOL),
		capability: text(71, "^sha256:[a-f0-9]{64}$"),
		expectedIdentity: Type.Object(
			{ account: text(12, "^[0-9]{12}$"), arn: text(2_048), partition: partitionSchema },
			{ additionalProperties: false },
		),
		jsonPointer: Type.Optional(Type.String({ maxLength: 4_096 })),
		appendNewline: Type.Optional(Type.Boolean()),
		consumer: Type.Object(
			{ argv: Type.Array(Type.String({ maxLength: 8_192 }), { minItems: 1, maxItems: 128 }), cwd: text(2_048) },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export const awsSecretInputCapabilitySchema = Type.Object(
	{ action: Type.Literal("secret-input-capabilities"), protocol: Type.Literal(AWS_SECRET_INPUT_PROTOCOL) },
	{ additionalProperties: false },
);
export const ordinaryAwsSchema = Type.Object(
	{
		profile: Type.String(),
		service: Type.String(),
		operation: Type.String(),
		region: Type.Optional(Type.String()),
		parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		timeout: Type.Optional(Type.Number({ description: "per-request timeout seconds" })),
	},
	{ additionalProperties: false },
);
export const awsSecretInputRequestSchema = Type.Object(
	{
		profile: text(128, "^[A-Za-z0-9][A-Za-z0-9_+=,.@ -]*$"),
		region: text(32, "^[a-z][a-z0-9]*(?:-[a-z0-9]+)+-[0-9]+$"),
		service: Type.Literal("secretsmanager"),
		operation: Type.Literal("get-secret-value"),
		parameters: Type.Object(
			{
				SecretId: text(2_048),
				VersionId: text(64, "^[A-Za-z0-9-]{32,64}$"),
				VersionStage: Type.Optional(text(256)),
			},
			{ additionalProperties: false },
		),
		timeout: Type.Optional(
			Type.Number({ exclusiveMinimum: 0, maximum: AWS_SECRET_INPUT_LIMITS.maxTimeoutMs / 1_000 }),
		),
		secretInput: awsSecretInputSchema,
	},
	{ additionalProperties: false },
);
export const awsSchema = Type.Union([ordinaryAwsSchema, awsSecretInputCapabilitySchema, awsSecretInputRequestSchema]);
export type AwsToolParams = typeof ordinaryAwsSchema.infer;
export type AwsToolRequest = typeof awsSchema.infer;
export type AwsSecretInputRequest = typeof awsSecretInputRequestSchema.infer;
export type AwsSecretInputCapabilityRequest = typeof awsSecretInputCapabilitySchema.infer;
export type AwsSecretInputLocalRequest = AwsSecretInputRequest | AwsSecretInputCapabilityRequest;

export const AWS_SECRET_INPUT_FAILURE_CODES = [
	"CAPABILITY_INCOMPATIBLE",
	"INVALID_REQUEST",
	"APPROVAL_REQUIRED",
	"POLICY_DENIED",
	"GUARD_DENIED",
	"PROFILE_UNSUPPORTED",
	"AUTH_REQUIRED",
	"IDENTITY_MISMATCH",
	"RESOURCE_MISMATCH",
	"SECRET_MISMATCH",
	"INPUT_LIMIT_EXCEEDED",
	"INPUT_SELECTION_FAILED",
	"AWS_ACCESS_DENIED",
	"AWS_FAILED",
	"CONSUMER_FAILED",
	"CANCELLED",
	"TIMEOUT",
	"WORKER_FAILED",
	"UNSAFE_OUTPUT",
] as const;
export type AwsSecretInputFailureCode = (typeof AWS_SECRET_INPUT_FAILURE_CODES)[number];
export class AwsSecretInputFailure extends Error {
	constructor(readonly code: AwsSecretInputFailureCode) {
		super(code);
		this.name = "AwsSecretInputFailure";
	}
}
export function safeAwsSecretInputFailure(error: unknown): AwsSecretInputFailureCode {
	try {
		if (error instanceof AwsSecretInputFailure) {
			const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
			if (typeof code === "string" && AWS_SECRET_INPUT_FAILURE_CODES.some(value => value === code))
				return code as AwsSecretInputFailureCode;
		}
	} catch {}
	return "WORKER_FAILED";
}
export function assertAwsSecretInputPlainData(value: unknown, code: AwsSecretInputFailureCode = "UNSAFE_OUTPUT"): void {
	const seen = new Set<object>();
	let entries = 0;
	const visit = (item: unknown, depth: number): void => {
		if (
			item === null ||
			typeof item === "string" ||
			typeof item === "boolean" ||
			(typeof item === "number" && Number.isFinite(item))
		)
			return;
		if (typeof item !== "object" || depth > 32 || seen.has(item) || ++entries > 8_192)
			throw new AwsSecretInputFailure(code);
		const prototype = Object.getPrototypeOf(item);
		if (
			prototype !== Object.prototype &&
			prototype !== null &&
			!(Array.isArray(item) && prototype === Array.prototype)
		)
			throw new AwsSecretInputFailure(code);
		seen.add(item);
		for (const key of Reflect.ownKeys(item)) {
			if (Array.isArray(item) && key === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
				throw new AwsSecretInputFailure(code);
			visit(descriptor.value, depth + 1);
		}
	};
	try {
		visit(value, 0);
	} catch {
		throw new AwsSecretInputFailure(code);
	}
}
export function canonicalAwsSecretInputJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalAwsSecretInputJson).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalAwsSecretInputJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
export const AWS_SECRET_INPUT_INPUT_SCHEMA = freeze(awsSchema.toJsonSchema());
export const AWS_SECRET_INPUT_MANIFEST = freeze({
	scope: "aws-secret-input-sdk-scope/v2",
	worker: "aws-secret-input-isolated-process/v1",
	executionPolicy: "tool-cancellation-cleanup/v1",
	hostPolicy: "native-tool-host/v2",
	lifecyclePolicy: "tool-session-lifecycle/v2",
	deliveryPolicy: "finite-stdin-owned-process-group/v3",
	outputPolicy: "raw-bounded-consumer-output/v1",
	sdk: "@aws-sdk/{client-sts,client-secrets-manager,client-sso}@3.1150.0",
	authPolicy: "read-only-explicit-static-sso/v1",
});
const supportedProviders = ["explicit-static", "existing-unexpired-sso"] as const;
export const AWS_SECRET_INPUT_CAPABILITY = freeze({
	device: "aws" as const,
	protocol: AWS_SECRET_INPUT_PROTOCOL,
	capability: `sha256:${createHash("sha256")
		.update(
			canonicalAwsSecretInputJson({
				protocol: AWS_SECRET_INPUT_PROTOCOL,
				manifest: AWS_SECRET_INPUT_MANIFEST,
				inputSchema: AWS_SECRET_INPUT_INPUT_SCHEMA,
				limits: AWS_SECRET_INPUT_LIMITS,
				supportedProviders,
			}),
		)
		.digest("hex")}`,
	manifest: AWS_SECRET_INPUT_MANIFEST,
	limits: AWS_SECRET_INPUT_LIMITS,
	supportedProviders,
});
export type AwsSecretInputCapability = typeof AWS_SECRET_INPUT_CAPABILITY;
export function assertAwsSecretInputCapability(value: unknown): asserts value is AwsSecretInputCapability {
	assertAwsSecretInputPlainData(value, "CAPABILITY_INCOMPATIBLE");
	if (canonicalAwsSecretInputJson(value) !== canonicalAwsSecretInputJson(AWS_SECRET_INPUT_CAPABILITY))
		throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
}
export function awsSecretInputRegionPartition(region: string): "aws" | "aws-us-gov" | "aws-cn" | undefined {
	if (/[\u0000-\u0020\u007f]/u.test(region)) return undefined;
	if (/^(?:us-iso(?:b|f)?-|eu-isoe-)/u.test(region)) return undefined;
	if (/^us-gov-(?:east|west)-[1-9][0-9]*$/u.test(region)) return "aws-us-gov";
	if (/^cn-(?:north|northwest)-[1-9][0-9]*$/u.test(region)) return "aws-cn";
	if (/^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:[a-z]+-)*[a-z]+-[1-9][0-9]*$/u.test(region)) return "aws";
	return undefined;
}
export function isAwsSecretInputRequest(value: unknown): boolean {
	return (
		!!value && typeof value === "object" && (Object.hasOwn(value, "action") || Object.hasOwn(value, "secretInput"))
	);
}
export function normalizeAwsSecretInputRequest(value: unknown): AwsSecretInputLocalRequest {
	assertAwsSecretInputPlainData(value, "INVALID_REQUEST");
	let request: AwsSecretInputLocalRequest;
	try {
		request = Type.Union([awsSecretInputCapabilitySchema, awsSecretInputRequestSchema]).assert(value);
	} catch {
		throw new AwsSecretInputFailure("INVALID_REQUEST");
	}
	if ("action" in request) return freeze({ action: request.action, protocol: request.protocol });
	if (request.secretInput.capability !== AWS_SECRET_INPUT_CAPABILITY.capability)
		throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
	const { account, arn, partition } = request.secretInput.expectedIdentity;
	const pointer = request.secretInput.jsonPointer;
	if (
		request.profile.trim() !== request.profile ||
		awsSecretInputRegionPartition(request.region) !== partition ||
		[arn, request.parameters.SecretId, request.parameters.VersionId].some(value =>
			/[\u0000-\u001f\u007f]/u.test(value),
		) ||
		!new RegExp(
			`^arn:${partition}:(?:sts::${account}:(?:assumed-role/[A-Za-z0-9_+=,.@/-]+/[A-Za-z0-9_+=,.@-]+|federated-user/[A-Za-z0-9_+=,.@-]+)|iam::${account}:(?:user/[A-Za-z0-9_+=,.@/-]+|root))$`,
			"u",
		).test(arn) ||
		!new RegExp(
			`^arn:${partition}:secretsmanager:${request.region}:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`,
			"u",
		).test(request.parameters.SecretId) ||
		(request.parameters.VersionStage !== undefined &&
			/[\u0000-\u001f\u007f]/u.test(request.parameters.VersionStage)) ||
		(pointer !== undefined && ((pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/u.test(pointer))) ||
		!isAbsolute(request.secretInput.consumer.argv[0]!) ||
		!isAbsolute(request.secretInput.consumer.cwd) ||
		request.secretInput.consumer.argv.some(arg => arg.includes("\0")) ||
		request.secretInput.consumer.cwd.includes("\0") ||
		request.secretInput.consumer.argv.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 131_072
	)
		throw new AwsSecretInputFailure("INVALID_REQUEST");
	return freeze({
		...request,
		parameters: { ...request.parameters },
		secretInput: {
			...request.secretInput,
			expectedIdentity: { ...request.secretInput.expectedIdentity },
			consumer: { argv: [...request.secretInput.consumer.argv], cwd: request.secretInput.consumer.cwd },
		},
	});
}
export function awsSecretInputRequestFingerprint(request: AwsSecretInputRequest): string {
	return `sha256:${createHash("sha256").update(canonicalAwsSecretInputJson(request)).digest("hex")}`;
}
export function awsSecretInputTimeoutMs(request: AwsSecretInputRequest): number {
	return request.timeout === undefined
		? AWS_SECRET_INPUT_LIMITS.defaultTimeoutMs
		: Math.max(1, Math.floor(request.timeout * 1_000));
}
export function quoteAwsSecretInputArgv(argv: readonly string[]): string {
	return argv.map(word => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

export interface AwsSecretInputResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	cancelled: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	completion: "exited" | "uncertain";
	teardown: { consumerReaped: true; workerReaped: true; referencesReleased: true };
}
