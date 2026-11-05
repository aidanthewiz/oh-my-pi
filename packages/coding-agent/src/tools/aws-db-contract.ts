import { createHash } from "node:crypto";
import { type } from "@oh-my-pi/omptype";
import { Type } from "@oh-my-pi/omptype/typebox";

export const AWS_DB_PROTOCOL = "aws-db-memory/v1" as const;
export const AWS_DB_LIMITS = Object.freeze({ maxRows: 1 as const, maxBytes: 65_536, timeoutMs: 10_000 });
const text = (pattern: string, maxLength: number) =>
	type("string")
		.atLeastLength(1)
		.atMostLength(maxLength)
		.matching(new RegExp(`${pattern}(?![\\s\\S])`));
const id = () => text("^[1-9][0-9]{0,18}$", 19);
const arn = () => text("^arn:(aws|aws-us-gov|aws-cn):[A-Za-z0-9:/+=,.@_-]+$", 2_048);
const expectedSchema = Type.Object(
	{
		accountId: text("^[0-9]{12}$", 12),
		principalArn: arn(),
		partition: Type.Union([Type.Literal("aws"), Type.Literal("aws-us-gov"), Type.Literal("aws-cn")]),
		region: text("^[a-z][a-z0-9]*(?:-[a-z0-9]+)+-[0-9]+$", 32),
		tenantId: text("^[A-Za-z0-9][A-Za-z0-9._-]*$", 128),
		clusterArn: arn(),
		clusterResourceId: text("^cluster-[A-Z0-9]+$", 64),
		instanceArn: arn(),
		instanceResourceId: text("^db-[A-Z0-9]+$", 64),
		endpoint: text("^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$", 253),
		port: Type.Integer({ minimum: 1, maximum: 65_535 }),
		database: text("^[A-Za-z0-9_]+$", 64),
		secretArn: arn(),
		secretVersionId: text("^[A-Za-z0-9-]{32,64}$", 64),
	},
	{ additionalProperties: false },
);
const limitsSchema = Type.Object(
	{
		maxRows: Type.Literal(1),
		maxBytes: Type.Integer({ minimum: 1, maximum: AWS_DB_LIMITS.maxBytes }),
		timeoutMs: Type.Integer({ minimum: 1, maximum: AWS_DB_LIMITS.timeoutMs }),
	},
	{ additionalProperties: false },
);
const capabilitiesSchema = Type.Object({ action: Type.Literal("capabilities") }, { additionalProperties: false });
const inspectionSchema = Type.Object(
	{
		action: Type.Literal("inspect-automation-template"),
		capability: text("^sha256:[a-f0-9]{64}$", 71),
		profile: text("^[A-Za-z0-9][A-Za-z0-9_+=,.@ -]*$", 128),
		expected: expectedSchema,
		agencyId: id(),
		automationId: id(),
		stepId: id(),
		limits: limitsSchema,
	},
	{ additionalProperties: false },
);
export const awsDbSchema = Type.Union([capabilitiesSchema, inspectionSchema]);

export type AwsDbRequest = typeof capabilitiesSchema.infer | typeof inspectionSchema.infer;
export type AwsDbInspectionRequest = typeof inspectionSchema.infer;
export type AwsDbExpected = AwsDbInspectionRequest["expected"];
export type DbLimits = AwsDbInspectionRequest["limits"];
export interface DbTarget {
	partition: AwsDbExpected["partition"];
	endpoint: string;
	port: number;
	database: string;
	instanceIdentifier: string;
}
export interface DbCredentials {
	username: string;
	password: string;
}
export interface DbRead {
	agencyId: string;
	automationId: string;
	stepId: string;
	limits: DbLimits;
}
export interface SafeTemplateResult {
	disposition: "sanitized" | "withheld" | "not-found";
	structure?: string;
	proof: { sameConnection: true; reader: true };
	teardown: { connectionClosed: true; referencesReleased: true };
}

export const AWS_DB_FAILURE_CODES = [
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
	"AWS_ACCESS_DENIED",
	"AWS_FAILED",
	"DB_CONNECT_FAILED",
	"DB_READER_REQUIRED",
	"DB_IDENTITY_CHANGED",
	"DB_POLICY_DENIED",
	"DB_LIMIT_EXCEEDED",
	"DB_TIMEOUT",
	"DB_CANCELLED",
	"DB_READ_FAILED",
	"DB_TLS_REQUIRED",
	"CANCELLED",
	"TIMEOUT",
	"WORKER_FAILED",
	"UNSAFE_OUTPUT",
] as const;
export type AwsDbFailureCode = (typeof AWS_DB_FAILURE_CODES)[number];
export class AwsDbFailure extends Error {
	constructor(readonly code: AwsDbFailureCode) {
		super(code);
		this.name = "AwsDbFailure";
	}
}
export function safeAwsDbFailure(error: unknown): AwsDbFailureCode {
	try {
		if (error instanceof AwsDbFailure) {
			const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
			if (typeof code === "string" && AWS_DB_FAILURE_CODES.some(value => value === code))
				return code as AwsDbFailureCode;
		}
	} catch {}
	return "WORKER_FAILED";
}

export function assertAwsDbPlainData(value: unknown, code: AwsDbFailureCode = "UNSAFE_OUTPUT"): void {
	const seen = new Set<object>();
	const visit = (item: unknown, depth: number): void => {
		if (
			item === null ||
			typeof item === "string" ||
			typeof item === "boolean" ||
			(typeof item === "number" && Number.isFinite(item))
		)
			return;
		if (typeof item !== "object" || depth > 32 || seen.has(item)) throw new AwsDbFailure(code);
		const prototype = Object.getPrototypeOf(item);
		if (
			prototype !== Object.prototype &&
			prototype !== null &&
			!(Array.isArray(item) && prototype === Array.prototype)
		)
			throw new AwsDbFailure(code);
		seen.add(item);
		for (const key of Reflect.ownKeys(item)) {
			if (Array.isArray(item) && key === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
				throw new AwsDbFailure(code);
			visit(descriptor.value, depth + 1);
		}
	};
	try {
		visit(value, 0);
	} catch {
		throw new AwsDbFailure(code);
	}
}

export function canonicalAwsDbJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalAwsDbJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalAwsDbJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
export const AWS_DB_INPUT_SCHEMA = freeze(awsDbSchema.toJsonSchema());
export const AWS_DB_MANIFEST = freeze({
	schema: "aws-db-inspect-automation-template/v1",
	scope: "aws-db-sdk-scope/v1",
	worker: "aws-db-isolated-process/v1",
	executionPolicy: "tool-cancellation-cleanup/v1",
	hostPolicy: "native-tool-host/v1",
	lifecyclePolicy: "tool-session-lifecycle/v1",
	readPolicy: "automation-step-query-text/v1",
	sanitizerPolicy: "restricted-template-structure/v1",
	tlsPolicy: "amazon-rds-partition-roots/v1",
	tlsTrust: "sha256:b46e17b6576526ba99028c668f7d8a393b9554d324b5f99c8f0cb843e0161ff6",
	tlsRegions: {
		aws: [
			"af-south-1",
			"ap-east-1",
			"ap-east-2",
			"ap-northeast-1",
			"ap-northeast-2",
			"ap-northeast-3",
			"ap-south-1",
			"ap-south-2",
			"ap-southeast-1",
			"ap-southeast-2",
			"ap-southeast-3",
			"ap-southeast-4",
			"ap-southeast-5",
			"ap-southeast-6",
			"ap-southeast-7",
			"ca-central-1",
			"ca-west-1",
			"eu-central-1",
			"eu-central-2",
			"eu-north-1",
			"eu-south-1",
			"eu-south-2",
			"eu-west-1",
			"eu-west-2",
			"eu-west-3",
			"il-central-1",
			"me-central-1",
			"me-south-1",
			"me-west-1",
			"mx-central-1",
			"sa-east-1",
			"sa-west-1",
			"us-east-1",
			"us-east-2",
			"us-west-1",
			"us-west-2",
		],
		"aws-cn": ["cn-north-1", "cn-northwest-1"],
		"aws-us-gov": ["us-gov-east-1", "us-gov-west-1"],
	},
	driver: "mysql2@3.24.6",
	sdk: "@aws-sdk/{client-sts,client-rds,client-secrets-manager,client-sso}@3.1150.0",
	authPolicy: "read-only-explicit-static-sso/v1",
});
export const AWS_DB_CAPABILITY = freeze({
	device: "aws_db" as const,
	protocol: AWS_DB_PROTOCOL,
	capability: `sha256:${createHash("sha256")
		.update(
			canonicalAwsDbJson({
				protocol: AWS_DB_PROTOCOL,
				manifest: AWS_DB_MANIFEST,
				inputSchema: AWS_DB_INPUT_SCHEMA,
				limits: AWS_DB_LIMITS,
				supportedProviders: ["explicit-static", "existing-unexpired-sso"],
			}),
		)
		.digest("hex")}`,
	manifest: AWS_DB_MANIFEST,
	limits: AWS_DB_LIMITS,
	supportedProviders: ["explicit-static", "existing-unexpired-sso"],
});
export type AwsDbCapability = typeof AWS_DB_CAPABILITY;

export function assertAwsDbCapability(value: unknown): asserts value is AwsDbCapability {
	assertAwsDbPlainData(value, "CAPABILITY_INCOMPATIBLE");
	if (canonicalAwsDbJson(value) !== canonicalAwsDbJson(AWS_DB_CAPABILITY))
		throw new AwsDbFailure("CAPABILITY_INCOMPATIBLE");
}
export function normalizeAwsDbRequest(value: unknown): AwsDbRequest {
	assertAwsDbPlainData(value, "INVALID_REQUEST");
	let parsed: AwsDbRequest;
	try {
		parsed = awsDbSchema.assert(value);
	} catch {
		throw new AwsDbFailure("INVALID_REQUEST");
	}
	if (parsed.action === "capabilities") return freeze({ action: "capabilities" });
	if (parsed.capability !== AWS_DB_CAPABILITY.capability) throw new AwsDbFailure("CAPABILITY_INCOMPATIBLE");
	const expected = parsed.expected;
	const actualPartition = /^us-gov-/u.test(expected.region)
		? "aws-us-gov"
		: /^cn-/u.test(expected.region)
			? "aws-cn"
			: "aws";
	if (
		actualPartition !== expected.partition ||
		!/^(?:us-gov-(?:east|west)-1|cn-(?:north-1|northwest-1)|(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+(?:-[a-z]+)?-[1-9])$/u.test(
			expected.region,
		)
	)
		throw new AwsDbFailure("INVALID_REQUEST");
	for (const [key, service, resource] of [
		["clusterArn", "rds", "cluster:"],
		["instanceArn", "rds", "db:"],
		["secretArn", "secretsmanager", "secret:"],
	] as const) {
		const prefix = `arn:${expected.partition}:${service}:${expected.region}:${expected.accountId}:${resource}`;
		if (!expected[key].startsWith(prefix) || expected[key].length === prefix.length)
			throw new AwsDbFailure("INVALID_REQUEST");
	}
	if (
		!expected.principalArn.startsWith(`arn:${expected.partition}:`) ||
		expected.principalArn.split(":")[4] !== expected.accountId ||
		!/^arn:[^:]+:(?:sts::[0-9]{12}:assumed-role\/[A-Za-z0-9_+=,.@-]+\/[A-Za-z0-9_+=,.@-]+|iam::[0-9]{12}:user\/[A-Za-z0-9_+=,.@/-]+)$/u.test(
			expected.principalArn,
		)
	)
		throw new AwsDbFailure("INVALID_REQUEST");
	for (const value of [parsed.agencyId, parsed.automationId, parsed.stepId]) {
		if (BigInt(value) > 9_223_372_036_854_775_807n) throw new AwsDbFailure("INVALID_REQUEST");
	}
	if (
		parsed.profile.trim() !== parsed.profile ||
		expected.endpoint.includes("..") ||
		/^\d+\.\d+\.\d+\.\d+$/u.test(expected.endpoint)
	)
		throw new AwsDbFailure("INVALID_REQUEST");
	if (!AWS_DB_MANIFEST.tlsRegions[expected.partition].includes(expected.region))
		throw new AwsDbFailure("CAPABILITY_INCOMPATIBLE");
	return freeze({
		action: parsed.action,
		capability: parsed.capability,
		profile: parsed.profile,
		expected: { ...expected },
		agencyId: parsed.agencyId,
		automationId: parsed.automationId,
		stepId: parsed.stepId,
		limits: { ...parsed.limits },
	});
}
export function awsDbRequestFingerprint(request: AwsDbInspectionRequest): string {
	return `sha256:${createHash("sha256").update(canonicalAwsDbJson(request)).digest("hex")}`;
}
