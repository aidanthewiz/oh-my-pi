import { DescribeDBClustersCommand, DescribeDBInstancesCommand, ListTagsForResourceCommand } from "@aws-sdk/client-rds";
import { DescribeSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { Type, type TTyped } from "@oh-my-pi/omptype/typebox";
import {
	AwsDbFailure,
	type AwsDbFailureCode,
	type AwsDbInspectionRequest,
	type DbCredentials,
	type SafeTemplateResult,
	normalizeAwsDbRequest,
	safeAwsDbFailure,
} from "./aws-db-contract";
import {
	AwsDbProvider,
	type AwsDbAuthorize,
	type AwsDbLaunchFiles,
	type AwsDbProviderDependencies,
	releaseAwsDbResponse,
	parseAwsDbFlatJson,
} from "./aws-db-provider";
import { runAutomationTemplateRead } from "./aws-db-query";
import { isSafeTemplateStructure } from "./aws-db-sanitize";

export type {
	AwsDbAuthorize,
	AwsDbClient,
	AwsDbClientConfig,
	AwsDbClientFactory,
	AwsDbCommand,
	AwsDbFileReader,
	AwsDbLaunchFiles,
	AwsDbService,
	AwsDbStep,
} from "./aws-db-provider";

export const AWS_DB_SCOPE_ID = "aws-db-sdk-scope/v1";

export interface AwsDbScopeDependencies extends AwsDbProviderDependencies {
	readDatabase?: typeof runAutomationTemplateRead;
}

const awsText = () => Type.String({ minLength: 1, maxLength: 2048 });
const tagsSchema = Type.Array(Type.Object({ Key: awsText(), Value: Type.String({ maxLength: 2048 }) }), {
	maxItems: 100,
});
const identitySchema = Type.Object({ Account: awsText(), Arn: awsText() });
const clusterSchema = Type.Object({
	DBClusters: Type.Array(
		Type.Object({
			DBClusterArn: awsText(),
			DbClusterResourceId: awsText(),
			DBClusterIdentifier: awsText(),
			Engine: awsText(),
			EngineVersion: awsText(),
			Status: awsText(),
			Port: Type.Integer(),
			DatabaseName: Type.Optional(awsText()),
			DBClusterMembers: Type.Array(
				Type.Object({ DBInstanceIdentifier: awsText(), IsClusterWriter: Type.Boolean() }),
				{ minItems: 1, maxItems: 64 },
			),
		}),
		{ minItems: 1, maxItems: 1 },
	),
	Marker: Type.Optional(Type.String()),
});
const instanceSchema = Type.Object({
	DBInstances: Type.Array(
		Type.Object({
			DBInstanceArn: awsText(),
			DbiResourceId: awsText(),
			DBInstanceIdentifier: awsText(),
			DBClusterIdentifier: awsText(),
			Engine: awsText(),
			EngineVersion: awsText(),
			DBInstanceStatus: awsText(),
			Endpoint: Type.Object({ Address: awsText(), Port: Type.Integer() }),
		}),
		{ minItems: 1, maxItems: 1 },
	),
	Marker: Type.Optional(Type.String()),
});
const tagsResponseSchema = Type.Object({ TagList: tagsSchema });
const secretMetadataSchema = Type.Object({
	ARN: awsText(),
	Tags: tagsSchema,
	VersionIdsToStages: Type.Record(Type.String(), Type.Array(awsText(), { maxItems: 20 })),
	DeletedDate: Type.Optional(Type.Unknown()),
	PrimaryRegion: Type.Optional(awsText()),
});
const secretValueSchema = Type.Object({
	ARN: awsText(),
	VersionId: awsText(),
	VersionStages: Type.Array(awsText(), { minItems: 1, maxItems: 20 }),
	SecretString: Type.Optional(Type.String({ maxLength: 65_536 })),
	SecretBinary: Type.Optional(Type.Unknown()),
});
const safeResultSchema = Type.Object(
	{
		disposition: Type.Union([Type.Literal("sanitized"), Type.Literal("withheld"), Type.Literal("not-found")]),
		structure: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
		proof: Type.Object(
			{ sameConnection: Type.Literal(true), reader: Type.Literal(true) },
			{ additionalProperties: false },
		),
		teardown: Type.Object(
			{ connectionClosed: Type.Literal(true), referencesReleased: Type.Literal(true) },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
const SECRET_KEYS: Readonly<Record<string, true>> = {
	engine: true,
	host: true,
	port: true,
	dbname: true,
	username: true,
	password: true,
	dbClusterIdentifier: true,
};

function verified<T>(schema: TTyped<T>, value: unknown, code: AwsDbFailureCode): T {
	try {
		return schema.assert(value);
	} catch {
		throw new AwsDbFailure(code);
	}
}

function verifyTags(tags: typeof tagsSchema.infer, tenantId: string, reader: boolean, code: AwsDbFailureCode): void {
	const values = new Map<string, string>();
	for (const { Key, Value } of tags) {
		if (values.has(Key)) throw new AwsDbFailure(code);
		values.set(Key, Value);
	}
	if (
		values.get("coreforge:tenant-id") !== tenantId ||
		(reader && values.get("coreforge:database-reader") !== "true")
	) {
		throw new AwsDbFailure(code);
	}
}

export async function runAwsDbScope(
	input: AwsDbInspectionRequest,
	launch: AwsDbLaunchFiles,
	authorize: AwsDbAuthorize,
	signal: AbortSignal,
	dependencies: AwsDbScopeDependencies = {},
): Promise<SafeTemplateResult> {
	const request = normalizeAwsDbRequest(input);
	if (request.action !== "inspect-automation-template") throw new AwsDbFailure("INVALID_REQUEST");
	if (signal.aborted) throw new AwsDbFailure("CANCELLED");
	const files = Object.freeze({ ...launch, reservedProfiles: Object.freeze([...launch.reservedProfiles]) });
	const controller = new AbortController();
	const cancel = () => controller.abort();
	signal.addEventListener("abort", cancel, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, request.limits.timeoutMs);
	const provider = new AwsDbProvider(request, files, authorize, controller.signal, dependencies);
	let credentials: DbCredentials | undefined;
	let secretValue: typeof secretValueSchema.infer | undefined;
	let secretResponse: unknown;
	let secret: Record<string, string | number> | undefined;
	let databasePhase = false;
	try {
		const expected = request.expected;
		const clusterIdentifier = expected.clusterArn.split(":")[6];
		const instanceIdentifier = expected.instanceArn.split(":")[6];
		if (
			!clusterIdentifier ||
			!instanceIdentifier ||
			!/^arn:[^:]+:rds:[^:]+:\d{12}:cluster:[a-zA-Z][a-zA-Z0-9-]{0,62}$/u.test(expected.clusterArn) ||
			!/^arn:[^:]+:rds:[^:]+:\d{12}:db:[a-zA-Z][a-zA-Z0-9-]{0,62}$/u.test(expected.instanceArn)
		)
			throw new AwsDbFailure("INVALID_REQUEST");
		await provider.initialize();
		const identity = verified(
			identitySchema,
			await provider.send(
				{ service: "sts", operation: "get-caller-identity", region: expected.region },
				new GetCallerIdentityCommand({}),
			),
			"IDENTITY_MISMATCH",
		);
		if (
			identity.Account !== expected.accountId ||
			identity.Arn !== expected.principalArn ||
			identity.Arn.split(":")[1] !== expected.partition
		)
			throw new AwsDbFailure("IDENTITY_MISMATCH");

		const clusterResponse = verified(
			clusterSchema,
			await provider.send(
				{
					service: "rds",
					operation: "describe-db-clusters",
					resource: expected.clusterArn,
					region: expected.region,
				},
				new DescribeDBClustersCommand({ DBClusterIdentifier: expected.clusterArn, MaxRecords: 20 }),
			),
			"RESOURCE_MISMATCH",
		);
		const cluster = clusterResponse.DBClusters[0]!;
		const members = cluster.DBClusterMembers.filter(member => member.DBInstanceIdentifier === instanceIdentifier);
		if (
			clusterResponse.Marker ||
			cluster.DBClusterArn !== expected.clusterArn ||
			cluster.DbClusterResourceId !== expected.clusterResourceId ||
			cluster.DBClusterIdentifier !== clusterIdentifier ||
			cluster.Engine !== "aurora-mysql" ||
			!/^8\.0\.mysql_aurora\.3\.\d+\.\d+$/u.test(cluster.EngineVersion) ||
			cluster.Status !== "available" ||
			cluster.Port !== expected.port ||
			members.length !== 1 ||
			members[0]!.IsClusterWriter !== false
		)
			throw new AwsDbFailure("RESOURCE_MISMATCH");
		const clusterTags = verified(
			tagsResponseSchema,
			await provider.send(
				{
					service: "rds",
					operation: "list-tags-for-resource",
					resource: expected.clusterArn,
					region: expected.region,
				},
				new ListTagsForResourceCommand({ ResourceName: expected.clusterArn }),
			),
			"RESOURCE_MISMATCH",
		);
		verifyTags(clusterTags.TagList, expected.tenantId, false, "RESOURCE_MISMATCH");

		const instanceResponse = verified(
			instanceSchema,
			await provider.send(
				{
					service: "rds",
					operation: "describe-db-instances",
					resource: expected.instanceArn,
					region: expected.region,
				},
				new DescribeDBInstancesCommand({ DBInstanceIdentifier: expected.instanceArn, MaxRecords: 20 }),
			),
			"RESOURCE_MISMATCH",
		);
		const instance = instanceResponse.DBInstances[0]!;
		if (
			instanceResponse.Marker ||
			instance.DBInstanceArn !== expected.instanceArn ||
			instance.DbiResourceId !== expected.instanceResourceId ||
			instance.DBInstanceIdentifier !== instanceIdentifier ||
			instance.DBClusterIdentifier !== clusterIdentifier ||
			instance.Engine !== "aurora-mysql" ||
			instance.EngineVersion !== cluster.EngineVersion ||
			instance.DBInstanceStatus !== "available" ||
			instance.Endpoint.Address !== expected.endpoint ||
			instance.Endpoint.Port !== expected.port
		)
			throw new AwsDbFailure("RESOURCE_MISMATCH");
		const instanceTags = verified(
			tagsResponseSchema,
			await provider.send(
				{
					service: "rds",
					operation: "list-tags-for-resource",
					resource: expected.instanceArn,
					region: expected.region,
				},
				new ListTagsForResourceCommand({ ResourceName: expected.instanceArn }),
			),
			"RESOURCE_MISMATCH",
		);
		verifyTags(instanceTags.TagList, expected.tenantId, false, "RESOURCE_MISMATCH");

		const metadata = verified(
			secretMetadataSchema,
			await provider.send(
				{
					service: "secretsmanager",
					operation: "describe-secret",
					resource: expected.secretArn,
					region: expected.region,
				},
				new DescribeSecretCommand({ SecretId: expected.secretArn }),
			),
			"SECRET_MISMATCH",
		);
		if (
			metadata.ARN !== expected.secretArn ||
			metadata.DeletedDate !== undefined ||
			(metadata.PrimaryRegion !== undefined && metadata.PrimaryRegion !== expected.region)
		)
			throw new AwsDbFailure("SECRET_MISMATCH");
		verifyTags(metadata.Tags, expected.tenantId, true, "SECRET_MISMATCH");
		const versions = Object.entries(metadata.VersionIdsToStages);
		const currentVersions = versions.filter(([_version, stages]) => stages.includes("AWSCURRENT"));
		if (
			versions.length > 100 ||
			currentVersions.length !== 1 ||
			currentVersions[0]![0] !== expected.secretVersionId ||
			currentVersions[0]![1].filter(stage => stage === "AWSCURRENT").length !== 1
		)
			throw new AwsDbFailure("SECRET_MISMATCH");
		secretResponse = await provider.send(
			{
				service: "secretsmanager",
				operation: "get-secret-value",
				resource: expected.secretArn,
				region: expected.region,
			},
			new GetSecretValueCommand({
				SecretId: expected.secretArn,
				VersionId: expected.secretVersionId,
				VersionStage: "AWSCURRENT",
			}),
		);
		secretValue = verified(secretValueSchema, secretResponse, "SECRET_MISMATCH");
		if (
			secretValue.ARN !== expected.secretArn ||
			secretValue.VersionId !== expected.secretVersionId ||
			secretValue.VersionStages.filter(stage => stage === "AWSCURRENT").length !== 1 ||
			typeof secretValue.SecretString !== "string" ||
			secretValue.SecretBinary !== undefined ||
			Buffer.byteLength(secretValue.SecretString, "utf8") > 65_536
		)
			throw new AwsDbFailure("SECRET_MISMATCH");
		secret = parseAwsDbFlatJson(secretValue.SecretString, SECRET_KEYS, "SECRET_MISMATCH");
		secretValue.SecretString = undefined;
		if (
			secret.engine !== "mysql" ||
			secret.host !== expected.endpoint ||
			secret.port !== expected.port ||
			secret.dbname !== expected.database ||
			(secret.dbClusterIdentifier !== undefined && secret.dbClusterIdentifier !== clusterIdentifier) ||
			typeof secret.username !== "string" ||
			!secret.username ||
			secret.username.length > 128 ||
			/[\u0000-\u001f\u007f]/u.test(secret.username) ||
			typeof secret.password !== "string" ||
			!secret.password ||
			secret.password.length > 4096 ||
			secret.password.includes("\u0000")
		)
			throw new AwsDbFailure("SECRET_MISMATCH");
		credentials = { username: secret.username, password: secret.password };
		for (const key of Object.keys(secret)) delete secret[key];
		secret = undefined;
		databasePhase = true;
		const result = verified(
			safeResultSchema,
			await (dependencies.readDatabase ?? runAutomationTemplateRead)(
				{
					partition: expected.partition,
					endpoint: expected.endpoint,
					port: expected.port,
					database: expected.database,
					instanceIdentifier,
				},
				credentials,
				{
					agencyId: request.agencyId,
					automationId: request.automationId,
					stepId: request.stepId,
					limits: { ...request.limits },
				},
				controller.signal,
			),
			"UNSAFE_OUTPUT",
		);
		if (controller.signal.aborted) throw new AwsDbFailure("CANCELLED");
		const { disposition, structure } = result;
		if (
			(disposition === "sanitized" &&
				(!isSafeTemplateStructure(structure) || Buffer.byteLength(structure) > request.limits.maxBytes)) ||
			(disposition !== "sanitized" && structure !== undefined)
		)
			throw new AwsDbFailure("UNSAFE_OUTPUT");
		return {
			disposition,
			...(disposition === "sanitized" ? { structure } : {}),
			proof: { sameConnection: true, reader: true },
			teardown: { connectionClosed: true, referencesReleased: true },
		};
	} catch (error) {
		if (timedOut) throw new AwsDbFailure("TIMEOUT");
		if (signal.aborted || controller.signal.aborted) throw new AwsDbFailure("CANCELLED");
		const code = safeAwsDbFailure(error);
		throw new AwsDbFailure(code === "WORKER_FAILED" && databasePhase ? "DB_READ_FAILED" : code);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
		let cleanupFailed = false;
		try {
			if (credentials) {
				credentials.username = "";
				credentials.password = "";
			}
			if (secret) for (const key of Object.keys(secret)) delete secret[key];
			if (!releaseAwsDbResponse(secretValue)) cleanupFailed = true;
			if (!releaseAwsDbResponse(secretResponse)) cleanupFailed = true;
		} catch {
			cleanupFailed = true;
		}
		credentials = undefined;
		secret = undefined;
		secretValue = undefined;
		secretResponse = undefined;
		if (!provider.dispose() || cleanupFailed) throw new AwsDbFailure("WORKER_FAILED");
	}
}
