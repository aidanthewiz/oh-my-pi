import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { DescribeDBClustersCommand, DescribeDBInstancesCommand, ListTagsForResourceCommand } from "@aws-sdk/client-rds";
import { DescribeSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetRoleCredentialsCommand, SSOClient } from "@aws-sdk/client-sso";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { HttpRequest } from "@smithy/types";
import {
	AWS_DB_CAPABILITY,
	AwsDbFailure,
	type AwsDbFailureCode,
	type AwsDbInspectionRequest,
	type DbCredentials,
	type DbRead,
	type DbTarget,
	type SafeTemplateResult,
} from "../../src/tools/aws-db-contract";
import {
	type AwsDbClientConfig,
	type AwsDbCommand,
	type AwsDbLaunchFiles,
	type AwsDbScopeDependencies,
	type AwsDbService,
	type AwsDbStep,
	runAwsDbScope,
} from "../../src/tools/aws-db-scope";
import { AwsDbProvider } from "../../src/tools/aws-db-provider";

interface Fixture {
	request: AwsDbInspectionRequest;
	launch: AwsDbLaunchFiles;
	files: Map<string, string>;
	dependencies: AwsDbScopeDependencies;
	state: {
		commands: AwsDbCommand[];
		authorized: AwsDbStep[];
		events: string[];
		readPaths: string[];
		buffers: Uint8Array[];
		clients: { service: AwsDbService; config: AwsDbClientConfig; destroyed: boolean }[];
		dbCalls: number;
		dbCredentials: DbCredentials | undefined;
		dbTarget: DbTarget | undefined;
		dbRead: DbRead | undefined;
		now: number;
	};
	identity: { Account: string; Arn: string };
	cluster: {
		DBClusterArn: string;
		DbClusterResourceId: string;
		DBClusterIdentifier: string;
		Engine: string;
		EngineVersion: string;
		Status: string;
		Port: number;
		DatabaseName: string;
		DBClusterMembers: { DBInstanceIdentifier: string; IsClusterWriter: boolean }[];
	};
	instance: {
		DBInstanceArn: string;
		DbiResourceId: string;
		DBInstanceIdentifier: string;
		DBClusterIdentifier: string;
		Engine: string;
		EngineVersion: string;
		DBInstanceStatus: string;
		Endpoint: { Address: string; Port: number };
	};
	clusterTags: { Key: string; Value: string }[];
	instanceTags: { Key: string; Value: string }[];
	metadata: {
		ARN: string;
		Tags: { Key: string; Value: string }[];
		VersionIdsToStages: Record<string, string[]>;
		DeletedDate?: Date;
		PrimaryRegion?: string;
	};
	payload: {
		engine: string;
		host: string;
		port: number;
		dbname: string;
		username: string;
		password: string;
		dbClusterIdentifier: string;
	};
	secretValue: {
		ARN: string;
		VersionId: string;
		VersionStages: string[];
		SecretString?: string;
		SecretBinary?: Uint8Array;
	};
	roleCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: number };
	password: string;
	token: string;
	authorize(step: AwsDbStep): Promise<void>;
	run(signal?: AbortSignal): Promise<SafeTemplateResult>;
}

function fixture(): Fixture {
	const now = Date.UTC(2026, 0, 1);
	const request: AwsDbInspectionRequest = {
		action: "inspect-automation-template",
		capability: AWS_DB_CAPABILITY.capability,
		profile: "reader",
		expected: {
			accountId: "123456789012",
			principalArn: "arn:aws:sts::123456789012:assumed-role/reader/session",
			partition: "aws",
			region: "us-east-1",
			tenantId: "fixture",
			clusterArn: "arn:aws:rds:us-east-1:123456789012:cluster:fixture-cluster",
			clusterResourceId: "cluster-ABC123",
			instanceArn: "arn:aws:rds:us-east-1:123456789012:db:fixture-reader",
			instanceResourceId: "db-ABC123",
			endpoint: "fixture-reader.example.us-east-1.rds.amazonaws.com",
			port: 3306,
			database: "fixture",
			secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture-reader-ABC123",
			secretVersionId: "01234567-89ab-cdef-0123-456789abcdef",
		},
		agencyId: "1",
		automationId: "2",
		stepId: "3",
		limits: { maxRows: 1, maxBytes: 4096, timeoutMs: 10_000 },
	};
	const home = resolve(import.meta.dir, "../fixtures/aws-db-memory-home");
	const launch: AwsDbLaunchFiles = {
		homeDir: home,
		configFile: join(home, "selected-config"),
		sharedCredentialsFile: join(home, "selected-credentials"),
		reservedProfiles: ["managed-model"],
	};
	const accessKeyId = randomBytes(12).toString("hex");
	const secretAccessKey = randomBytes(24).toString("hex");
	const password = randomBytes(24).toString("hex");
	const token = randomBytes(24).toString("hex");
	const files = new Map<string, string>([
		[launch.configFile!, "[profile reader]\nregion = us-east-1\n"],
		[
			launch.sharedCredentialsFile!,
			`[reader]\naws_access_key_id = ${accessKeyId}\naws_secret_access_key = ${secretAccessKey}\n`,
		],
	]);
	const cluster = {
		DBClusterArn: request.expected.clusterArn,
		DbClusterResourceId: request.expected.clusterResourceId,
		DBClusterIdentifier: "fixture-cluster",
		Engine: "aurora-mysql",
		EngineVersion: "8.0.mysql_aurora.3.08.2",
		Status: "available",
		Port: 3306,
		DatabaseName: "fixture",
		DBClusterMembers: [
			{ DBInstanceIdentifier: "fixture-reader", IsClusterWriter: false },
			{ DBInstanceIdentifier: "fixture-writer", IsClusterWriter: true },
		],
	};
	const instance = {
		DBInstanceArn: request.expected.instanceArn,
		DbiResourceId: request.expected.instanceResourceId,
		DBInstanceIdentifier: "fixture-reader",
		DBClusterIdentifier: "fixture-cluster",
		Engine: "aurora-mysql",
		EngineVersion: cluster.EngineVersion,
		DBInstanceStatus: "available",
		Endpoint: { Address: request.expected.endpoint, Port: 3306 },
	};
	const identity = { Account: request.expected.accountId, Arn: request.expected.principalArn };
	const clusterTags = [{ Key: "coreforge:tenant-id", Value: "fixture" }];
	const instanceTags = [{ Key: "coreforge:tenant-id", Value: "fixture" }];
	const metadata = {
		ARN: request.expected.secretArn,
		Tags: [
			{ Key: "coreforge:tenant-id", Value: "fixture" },
			{ Key: "coreforge:database-reader", Value: "true" },
		],
		VersionIdsToStages: { [request.expected.secretVersionId]: ["AWSCURRENT"] },
	};
	const payload = {
		engine: "mysql",
		host: request.expected.endpoint,
		port: request.expected.port,
		dbname: request.expected.database,
		username: "fixture_reader",
		password,
		dbClusterIdentifier: "fixture-cluster",
	};
	const secretValue: {
		ARN: string;
		VersionId: string;
		VersionStages: string[];
		SecretString?: string;
		SecretBinary?: Uint8Array;
	} = {
		ARN: request.expected.secretArn,
		VersionId: request.expected.secretVersionId,
		VersionStages: ["AWSCURRENT"],
		SecretString: JSON.stringify(payload),
	};
	const roleCredentials = { accessKeyId, secretAccessKey, sessionToken: token, expiration: now + 60_000 };
	const state = {
		commands: [] as AwsDbCommand[],
		authorized: [] as AwsDbStep[],
		events: [] as string[],
		readPaths: [] as string[],
		buffers: [] as Uint8Array[],
		clients: [] as { service: AwsDbService; config: AwsDbClientConfig; destroyed: boolean }[],
		dbCalls: 0,
		dbCredentials: undefined as DbCredentials | undefined,
		dbTarget: undefined as DbTarget | undefined,
		dbRead: undefined as DbRead | undefined,
		now,
	};
	const dependencies: AwsDbScopeDependencies = {
		now: () => state.now,
		readFile: async (path, maxBytes) => {
			state.readPaths.push(path);
			const text = files.get(path);
			if (text === undefined) throw Object.assign(new Error(), { code: "ENOENT" });
			const bytes = new TextEncoder().encode(text);
			expect(maxBytes > 0).toBe(true);
			state.buffers.push(bytes);
			return bytes;
		},
		createClient: (service, config) => {
			const client = { service, config, destroyed: false };
			state.clients.push(client);
			return {
				async send(command, options) {
					expect(options.abortSignal.aborted).toBe(false);
					state.events.push(`send:${command.constructor.name}`);
					state.commands.push(command);
					if (command instanceof GetCallerIdentityCommand) return identity;
					if (command instanceof DescribeDBClustersCommand) return { DBClusters: [cluster] };
					if (command instanceof DescribeDBInstancesCommand) return { DBInstances: [instance] };
					if (command instanceof ListTagsForResourceCommand) {
						return {
							TagList: command.input.ResourceName === request.expected.clusterArn ? clusterTags : instanceTags,
						};
					}
					if (command instanceof DescribeSecretCommand) return metadata;
					if (command instanceof GetSecretValueCommand) return secretValue;
					if (command instanceof GetRoleCredentialsCommand) {
						expect(command.input.accessToken === token).toBe(true);
						return { roleCredentials };
					}
					throw new Error("Unexpected SDK command");
				},
				destroy() {
					client.destroyed = true;
				},
			};
		},
		readDatabase: async (target, credentials, read) => {
			state.dbCalls++;
			state.dbTarget = target;
			state.dbCredentials = credentials;
			state.dbRead = read;
			expect(credentials.password === password).toBe(true);
			return {
				disposition: "withheld",
				proof: { sameConnection: true, reader: true },
				teardown: { connectionClosed: true, referencesReleased: true },
			};
		},
	};
	const authorize = async (step: AwsDbStep) => {
		state.events.push(`authorize:${step.operation}`);
		state.authorized.push(step);
	};
	const run = (signal = new AbortController().signal) =>
		runAwsDbScope(request, launch, authorize, signal, dependencies);
	return {
		request,
		launch,
		files,
		dependencies,
		state,
		identity,
		cluster,
		instance,
		clusterTags,
		instanceTags,
		metadata,
		payload,
		secretValue,
		roleCredentials,
		password,
		token,
		authorize,
		run,
	};
}

async function rejectsSafely(operation: Promise<unknown>, code: AwsDbFailureCode, fixture: Fixture): Promise<void> {
	let caught: unknown;
	try {
		await operation;
	} catch (error) {
		caught = error;
	}
	expect(caught instanceof AwsDbFailure).toBe(true);
	if (!(caught instanceof AwsDbFailure)) return;
	expect(caught.code === code).toBe(true);
	expect(caught.message === code).toBe(true);
	expect(Object.hasOwn(caught, "cause")).toBe(false);
	const serialized = JSON.stringify({ error: caught, message: caught.message, stack: caught.stack });
	expect(serialized.includes(fixture.password) || serialized.includes(fixture.token)).toBe(false);
	expect(fixture.state.clients.every(client => client.destroyed)).toBe(true);
	expect(
		fixture.state.clients.every(
			client =>
				client.config.credentials.accessKeyId === "" &&
				client.config.credentials.secretAccessKey === "" &&
				client.config.credentials.sessionToken === undefined,
		),
	).toBe(true);
	expect(fixture.state.buffers.every(buffer => buffer.every(value => value === 0))).toBe(true);
}

test("SDK dispatch binds every approved operation, secret version, database target, and teardown", async () => {
	const f = fixture();
	const result = await f.run();
	expect(result).toEqual({
		disposition: "withheld",
		proof: { sameConnection: true, reader: true },
		teardown: { connectionClosed: true, referencesReleased: true },
	});
	expect(f.state.events).toEqual([
		"authorize:get-caller-identity",
		"send:GetCallerIdentityCommand",
		"authorize:describe-db-clusters",
		"send:DescribeDBClustersCommand",
		"authorize:list-tags-for-resource",
		"send:ListTagsForResourceCommand",
		"authorize:describe-db-instances",
		"send:DescribeDBInstancesCommand",
		"authorize:list-tags-for-resource",
		"send:ListTagsForResourceCommand",
		"authorize:describe-secret",
		"send:DescribeSecretCommand",
		"authorize:get-secret-value",
		"send:GetSecretValueCommand",
	]);
	const secretCommand = f.state.commands.find(command => command instanceof GetSecretValueCommand);
	expect(secretCommand instanceof GetSecretValueCommand).toBe(true);
	if (secretCommand instanceof GetSecretValueCommand) {
		expect(secretCommand.input).toEqual({
			SecretId: f.request.expected.secretArn,
			VersionId: f.request.expected.secretVersionId,
			VersionStage: "AWSCURRENT",
		});
	}
	expect(f.state.dbTarget).toEqual({
		partition: "aws",
		endpoint: f.request.expected.endpoint,
		port: 3306,
		database: "fixture",
		instanceIdentifier: "fixture-reader",
	});
	expect(f.state.dbRead).toEqual({ agencyId: "1", automationId: "2", stepId: "3", limits: f.request.limits });
	expect(f.state.dbCredentials?.username === "" && f.state.dbCredentials.password === "").toBe(true);
	expect(f.secretValue.SecretString === undefined).toBe(true);
	expect(f.state.clients.every(client => client.destroyed)).toBe(true);
	for (const { config } of f.state.clients) {
		expect(config.maxAttempts).toBe(1);
		expect(config.ignoreConfiguredEndpointUrls).toBe(true);
		expect(config.endpointDiscoveryEnabled).toBe(false);
		expect(config.requestHandler.httpsAgent.options.rejectUnauthorized).toBe(true);
		expect(Object.hasOwn(config, "endpoint")).toBe(false);
		expect(
			config.credentials.accessKeyId === "" &&
				config.credentials.secretAccessKey === "" &&
				config.credentials.sessionToken === undefined,
		).toBe(true);
	}
});

const preSecretFailures: readonly [string, AwsDbFailureCode, (f: Fixture) => void][] = [
	[
		"account",
		"IDENTITY_MISMATCH",
		f => {
			f.identity.Account = "999999999999";
		},
	],
	[
		"principal",
		"IDENTITY_MISMATCH",
		f => {
			f.identity.Arn += "-other";
		},
	],
	[
		"partition",
		"IDENTITY_MISMATCH",
		f => {
			f.identity.Arn = f.identity.Arn.replace("arn:aws:", "arn:aws-cn:");
		},
	],
	[
		"cluster ARN",
		"RESOURCE_MISMATCH",
		f => {
			f.cluster.DBClusterArn += "-other";
		},
	],
	[
		"cluster resource ID",
		"RESOURCE_MISMATCH",
		f => {
			f.cluster.DbClusterResourceId += "OTHER";
		},
	],
	[
		"cluster engine",
		"RESOURCE_MISMATCH",
		f => {
			f.cluster.Engine = "mysql";
		},
	],
	[
		"Aurora version",
		"RESOURCE_MISMATCH",
		f => {
			f.cluster.EngineVersion = "5.7.mysql_aurora.2.11.0";
		},
	],
	[
		"cluster availability",
		"RESOURCE_MISMATCH",
		f => {
			f.cluster.Status = "failing-over";
		},
	],
	[
		"cluster port",
		"RESOURCE_MISMATCH",
		f => {
			f.cluster.Port++;
		},
	],
	[
		"writer",
		"RESOURCE_MISMATCH",
		f => {
			f.cluster.DBClusterMembers[0]!.IsClusterWriter = true;
		},
	],
	[
		"cluster membership",
		"RESOURCE_MISMATCH",
		f => {
			f.cluster.DBClusterMembers[0]!.DBInstanceIdentifier = "other";
		},
	],
	[
		"duplicate cluster membership",
		"RESOURCE_MISMATCH",
		f => {
			f.cluster.DBClusterMembers.push({ ...f.cluster.DBClusterMembers[0]! });
		},
	],
	[
		"cluster tenant",
		"RESOURCE_MISMATCH",
		f => {
			f.clusterTags[0]!.Value = "other";
		},
	],
	[
		"instance ARN",
		"RESOURCE_MISMATCH",
		f => {
			f.instance.DBInstanceArn += "-other";
		},
	],
	[
		"instance resource ID",
		"RESOURCE_MISMATCH",
		f => {
			f.instance.DbiResourceId += "OTHER";
		},
	],
	[
		"instance cluster",
		"RESOURCE_MISMATCH",
		f => {
			f.instance.DBClusterIdentifier = "other";
		},
	],
	[
		"instance engine",
		"RESOURCE_MISMATCH",
		f => {
			f.instance.Engine = "mysql";
		},
	],
	[
		"instance version",
		"RESOURCE_MISMATCH",
		f => {
			f.instance.EngineVersion = "8.0.mysql_aurora.3.01.0";
		},
	],
	[
		"instance availability",
		"RESOURCE_MISMATCH",
		f => {
			f.instance.DBInstanceStatus = "rebooting";
		},
	],
	[
		"endpoint",
		"RESOURCE_MISMATCH",
		f => {
			f.instance.Endpoint.Address = "other.invalid";
		},
	],
	[
		"instance port",
		"RESOURCE_MISMATCH",
		f => {
			f.instance.Endpoint.Port++;
		},
	],
	[
		"instance tenant",
		"RESOURCE_MISMATCH",
		f => {
			f.instanceTags[0]!.Value = "other";
		},
	],
	[
		"duplicate tenant",
		"RESOURCE_MISMATCH",
		f => {
			f.instanceTags.push({ ...f.instanceTags[0]! });
		},
	],
	[
		"secret ARN",
		"SECRET_MISMATCH",
		f => {
			f.metadata.ARN += "-other";
		},
	],
	[
		"secret tenant",
		"SECRET_MISMATCH",
		f => {
			f.metadata.Tags[0]!.Value = "other";
		},
	],
	[
		"reader tag",
		"SECRET_MISMATCH",
		f => {
			f.metadata.Tags[1]!.Value = "false";
		},
	],
	[
		"scheduled secret deletion",
		"SECRET_MISMATCH",
		f => {
			f.metadata.DeletedDate = new Date();
		},
	],
	[
		"secret primary region",
		"SECRET_MISMATCH",
		f => {
			f.metadata.PrimaryRegion = "us-west-2";
		},
	],
	[
		"secret version",
		"SECRET_MISMATCH",
		f => {
			f.metadata.VersionIdsToStages = { ["f".repeat(32)]: ["AWSCURRENT"] };
		},
	],
	[
		"secret version stage",
		"SECRET_MISMATCH",
		f => {
			f.metadata.VersionIdsToStages[f.request.expected.secretVersionId] = ["AWSPREVIOUS"];
		},
	],
	[
		"ambiguous current version",
		"SECRET_MISMATCH",
		f => {
			f.metadata.VersionIdsToStages["f".repeat(32)] = ["AWSCURRENT"];
		},
	],
];

for (const [name, code, mutate] of preSecretFailures) {
	test(`rejects ${name} mismatch before secret retrieval or connection`, async () => {
		const f = fixture();
		mutate(f);
		await rejectsSafely(f.run(), code, f);
		expect(f.state.commands.some(command => command instanceof GetSecretValueCommand)).toBe(false);
		expect(f.state.dbCalls).toBe(0);
	});
}

for (const [name, mutate] of [
	[
		"host",
		(f: Fixture) => {
			f.payload.host = "other.invalid";
		},
	],
	[
		"port",
		(f: Fixture) => {
			f.payload.port++;
		},
	],
	[
		"database",
		(f: Fixture) => {
			f.payload.dbname = "other";
		},
	],
	[
		"engine",
		(f: Fixture) => {
			f.payload.engine = "postgres";
		},
	],
	[
		"cluster",
		(f: Fixture) => {
			f.payload.dbClusterIdentifier = "other";
		},
	],
	[
		"empty username",
		(f: Fixture) => {
			f.payload.username = "";
		},
	],
	[
		"control username",
		(f: Fixture) => {
			f.payload.username = "reader\n";
		},
	],
	[
		"empty password",
		(f: Fixture) => {
			f.payload.password = "";
		},
	],
] as const) {
	test(`rejects secret ${name} override before connecting`, async () => {
		const f = fixture();
		mutate(f);
		f.secretValue.SecretString = JSON.stringify(f.payload);
		await rejectsSafely(f.run(), "SECRET_MISMATCH", f);
		expect(f.state.dbCalls).toBe(0);
		expect(f.secretValue.SecretString === undefined).toBe(true);
	});
}

for (const variant of [
	"unknown key",
	"duplicate key",
	"escaped duplicate",
	"nested value",
	"invalid JSON",
	"binary",
	"wrong returned version",
	"wrong returned ARN",
	"missing stage",
] as const) {
	test(`rejects ${variant} in secret retrieval without exposing credentials`, async () => {
		const f = fixture();
		if (variant === "unknown key")
			f.secretValue.SecretString = JSON.stringify({ ...f.payload, endpoint: "other.invalid" });
		if (variant === "duplicate key")
			f.secretValue.SecretString = JSON.stringify(f.payload).replace(/\}$/u, ',"host":"other.invalid"}');
		if (variant === "escaped duplicate")
			f.secretValue.SecretString = JSON.stringify(f.payload).replace(/\}$/u, ',"h\\u006fst":"other.invalid"}');
		if (variant === "nested value")
			f.secretValue.SecretString = JSON.stringify({ ...f.payload, password: { value: f.password } });
		if (variant === "invalid JSON") f.secretValue.SecretString = `{${f.password}`;
		if (variant === "binary") {
			f.secretValue.SecretString = undefined;
			f.secretValue.SecretBinary = new TextEncoder().encode(f.password);
		}
		if (variant === "wrong returned version") f.secretValue.VersionId = "f".repeat(32);
		if (variant === "wrong returned ARN") f.secretValue.ARN += "-other";
		if (variant === "missing stage") f.secretValue.VersionStages = ["AWSPREVIOUS"];
		await rejectsSafely(f.run(), "SECRET_MISMATCH", f);
		expect(f.state.dbCalls).toBe(0);
		expect(f.secretValue.SecretString === undefined).toBe(true);
	});
}

for (const operation of [
	"get-caller-identity",
	"describe-db-clusters",
	"list-tags-for-resource",
	"describe-db-instances",
	"describe-secret",
	"get-secret-value",
] as const) {
	test(`policy refusal prevents ${operation} dispatch`, async () => {
		const f = fixture();
		const authorize = async (step: AwsDbStep) => {
			if (step.operation === operation) throw new AwsDbFailure("POLICY_DENIED");
			await f.authorize(step);
		};
		await rejectsSafely(
			runAwsDbScope(f.request, f.launch, authorize, new AbortController().signal, f.dependencies),
			"POLICY_DENIED",
			f,
		);
		const deniedClass = {
			"get-caller-identity": GetCallerIdentityCommand,
			"describe-db-clusters": DescribeDBClustersCommand,
			"list-tags-for-resource": ListTagsForResourceCommand,
			"describe-db-instances": DescribeDBInstancesCommand,
			"describe-secret": DescribeSecretCommand,
			"get-secret-value": GetSecretValueCommand,
		}[operation];
		expect(f.state.commands.some(command => command instanceof deniedClass)).toBe(false);
		expect(f.state.dbCalls).toBe(0);
	});
}

for (const [name, code] of [
	["AccessDeniedException", "AWS_ACCESS_DENIED"],
	["ExpiredTokenException", "AUTH_REQUIRED"],
	["ThrottlingException", "AWS_FAILED"],
] as const) {
	test(`SDK ${name} is fixed-code, cause-free, and never retried`, async () => {
		const f = fixture();
		let sends = 0;
		f.dependencies.createClient = (_service, config) => {
			const client = { service: "sts" as const, config, destroyed: false };
			f.state.clients.push(client);
			return {
				async send() {
					sends++;
					throw Object.assign(new Error(f.password, { cause: { token: f.token } }), {
						name,
						nested: { credentials: f.password },
					});
				},
				destroy() {
					client.destroyed = true;
				},
			};
		};
		await rejectsSafely(f.run(), code, f);
		expect(sends).toBe(1);
		expect(f.state.dbCalls).toBe(0);
	});
}

for (const variant of [
	"credential_process",
	"source_profile",
	"role_arn",
	"web_identity_token_file",
	"credential_source",
	"endpoint_url",
	"services",
	"aws_account_id",
] as const) {
	test(`rejects unsupported ${variant} without provider fallback`, async () => {
		const f = fixture();
		f.files.set(f.launch.configFile!, `[profile reader]\nregion = us-east-1\n${variant} = unsupported\n`);
		await rejectsSafely(f.run(), "PROFILE_UNSUPPORTED", f);
		expect(f.state.authorized.length === 0 && f.state.commands.length === 0).toBe(true);
	});
}

for (const config of [
	"[profile reader]\nregion = us-east-1\nREGION = us-east-1\n",
	"[profile reader]\nregion = us-east-1\n[profile reader]\noutput = json\n",
	"[profile reader]\nregion = us-east-1\nendpoint_url =\n  sts = https://other.invalid\n",
]) {
	test("rejects ambiguous or nested launcher INI settings", async () => {
		const f = fixture();
		f.files.set(f.launch.configFile!, config);
		await rejectsSafely(f.run(), "PROFILE_UNSUPPORTED", f);
		expect(f.state.commands.length).toBe(0);
	});
}

test("missing explicit authentication does not consult defaults", async () => {
	const f = fixture();
	f.launch.configFile = undefined;
	f.launch.sharedCredentialsFile = undefined;
	await rejectsSafely(f.run(), "AUTH_REQUIRED", f);
	expect(f.state.readPaths).toEqual([]);
	expect(f.state.commands).toEqual([]);
});

test("managed profiles and relative launcher paths fail before reading files", async () => {
	for (const variant of ["reserved", "managed", "relative"] as const) {
		const f = fixture();
		if (variant === "reserved") f.request.profile = "managed-model";
		if (variant === "managed") f.request.profile = "coreforge";
		if (variant === "relative") f.launch.configFile = "relative-config";
		await rejectsSafely(f.run(), "PROFILE_UNSUPPORTED", f);
		expect(f.state.readPaths).toEqual([]);
	}
});

test("incompatible capability fails before provider work", async () => {
	const f = fixture();
	f.request.capability = `sha256:${"0".repeat(64)}`;
	await rejectsSafely(f.run(), "CAPABILITY_INCOMPATIBLE", f);
	expect(f.state.readPaths).toEqual([]);
	expect(f.state.commands).toEqual([]);
});

function configureSso(f: Fixture, session: boolean, startUrl = "https://fixture.awsapps.com/start"): string {
	const name = "fixture-session";
	f.files.set(f.launch.sharedCredentialsFile!, "");
	f.files.set(
		f.launch.configFile!,
		`[profile reader]\nregion = us-east-1\nsso_account_id = ${f.request.expected.accountId}\nsso_role_name = Reader\n${session ? `sso_session = ${name}\n[sso-session ${name}]\n` : ""}sso_start_url = ${startUrl}\nsso_region = us-east-1\n`,
	);
	const cache = join(
		f.launch.homeDir,
		".aws",
		"sso",
		"cache",
		`${createHash("sha1")
			.update(session ? name : startUrl)
			.digest("hex")}.json`,
	);
	f.files.set(
		cache,
		JSON.stringify({
			accessToken: f.token,
			expiresAt: new Date(f.state.now + 60_000).toISOString(),
			region: "us-east-1",
			startUrl,
			refreshToken: randomBytes(20).toString("hex"),
			clientSecret: randomBytes(20).toString("hex"),
		}),
	);
	return cache;
}

for (const session of [false, true]) {
	test(`existing ${session ? "session" : "legacy"} SSO token gets guarded credentials in memory only`, async () => {
		const f = fixture();
		const cache = configureSso(f, session);
		await f.run();
		expect(f.state.readPaths).toEqual([f.launch.configFile!, f.launch.sharedCredentialsFile!, cache]);
		expect(f.state.events.slice(0, 4)).toEqual([
			"authorize:get-role-credentials",
			"send:GetRoleCredentialsCommand",
			"authorize:get-caller-identity",
			"send:GetCallerIdentityCommand",
		]);
		expect(f.state.authorized[0]).toEqual({
			service: "sso",
			operation: "get-role-credentials",
			resource: f.request.expected.accountId,
			roleName: "Reader",
			region: "us-east-1",
		});
		const command = f.state.commands.find(command => command instanceof GetRoleCredentialsCommand);
		expect(command instanceof GetRoleCredentialsCommand && command.input.accessToken === undefined).toBe(true);
		expect(
			f.roleCredentials.accessKeyId === "" &&
				f.roleCredentials.secretAccessKey === "" &&
				f.roleCredentials.sessionToken === "" &&
				f.roleCredentials.expiration === 0,
		).toBe(true);
		expect(
			f.state.clients.every(
				client =>
					client.destroyed &&
					client.config.credentials.accessKeyId === "" &&
					client.config.credentials.sessionToken === undefined,
			),
		).toBe(true);
		expect(JSON.stringify(f.state.authorized).includes(f.token)).toBe(false);
	});
}

for (const variant of [
	"expired",
	"missing",
	"wrong region",
	"wrong URL",
	"wrong account",
	"mixed providers",
] as const) {
	test(`SSO ${variant} never refreshes or requests role credentials`, async () => {
		const f = fixture();
		const cache = configureSso(f, true);
		const cached = JSON.parse(f.files.get(cache)!) as Record<string, unknown>;
		if (variant === "expired") cached.expiresAt = new Date(f.state.now - 1).toISOString();
		if (variant === "wrong region") cached.region = "us-west-2";
		if (variant === "wrong URL") cached.startUrl = "https://other.awsapps.com/start";
		f.files.set(cache, JSON.stringify(cached));
		if (variant === "missing") f.files.delete(cache);
		if (variant === "wrong account")
			f.files.set(
				f.launch.configFile!,
				f.files.get(f.launch.configFile!)!.replace(f.request.expected.accountId, "999999999999"),
			);
		if (variant === "mixed providers")
			f.files.set(
				f.launch.sharedCredentialsFile!,
				`[reader]\naws_access_key_id = ${randomBytes(16).toString("hex")}\n`,
			);
		await rejectsSafely(
			f.run(),
			variant === "wrong account"
				? "IDENTITY_MISMATCH"
				: variant === "mixed providers"
					? "PROFILE_UNSUPPORTED"
					: "AUTH_REQUIRED",
			f,
		);
		expect(f.state.commands).toEqual([]);
	});
}

test("SSO policy refusal never sends the cached token", async () => {
	const f = fixture();
	configureSso(f, true);
	await rejectsSafely(
		runAwsDbScope(
			f.request,
			f.launch,
			async () => {
				throw new AwsDbFailure("GUARD_DENIED");
			},
			new AbortController().signal,
			f.dependencies,
		),
		"GUARD_DENIED",
		f,
	);
	expect(f.state.clients).toEqual([]);
	expect(f.state.commands).toEqual([]);
});

for (const phase of ["approval", "SDK"] as const) {
	test(`cancellation during ${phase} destroys resources and releases credentials`, async () => {
		const f = fixture();
		const controller = new AbortController();
		const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
		const { promise: blocked } = Promise.withResolvers<never>();
		let authorize = f.authorize;
		if (phase === "approval")
			authorize = async () => {
				enter();
				await blocked;
			};
		if (phase === "SDK")
			f.dependencies.createClient = (_service, config) => {
				const client = { service: "sts" as const, config, destroyed: false };
				f.state.clients.push(client);
				return {
					send: async () => {
						enter();
						return blocked;
					},
					destroy() {
						client.destroyed = true;
					},
				};
			};
		const operation = runAwsDbScope(f.request, f.launch, authorize, controller.signal, f.dependencies);
		await entered;
		controller.abort();
		await rejectsSafely(operation, "CANCELLED", f);
	});
}

test("scope deadline cancels stalled SDK work without retry", async () => {
	const f = fixture();
	f.request.limits.timeoutMs = 10;
	let sends = 0;
	f.dependencies.createClient = (_service, config) => {
		const client = { service: "sts" as const, config, destroyed: false };
		f.state.clients.push(client);
		return {
			send: async () => {
				sends++;
				return Promise.withResolvers<never>().promise;
			},
			destroy() {
				client.destroyed = true;
			},
		};
	};
	await rejectsSafely(f.run(), "TIMEOUT", f);
	expect(sends).toBe(1);
});

test("raw database failures cannot expose nested driver diagnostics", async () => {
	const f = fixture();
	f.dependencies.readDatabase = async (_target, credentials) => {
		f.state.dbCredentials = credentials;
		throw Object.assign(new Error(f.password, { cause: { query: f.token } }), { sql: f.password });
	};
	await rejectsSafely(f.run(), "DB_READ_FAILED", f);
	expect(f.state.dbCredentials?.username === "" && f.state.dbCredentials.password === "").toBe(true);
});

for (const variant of ["unsafe structure", "extra output", "missing teardown", "withheld structure"] as const) {
	test(`rejects ${variant} from a database helper`, async () => {
		const f = fixture();
		const output: Record<string, unknown> = {
			disposition: "withheld",
			proof: { sameConnection: true, reader: true },
			teardown: { connectionClosed: true, referencesReleased: true },
		};
		if (variant === "unsafe structure") {
			output.disposition = "sanitized";
			output.structure = f.password;
		}
		if (variant === "extra output") output.source = f.password;
		if (variant === "missing teardown") output.teardown = { connectionClosed: false, referencesReleased: true };
		if (variant === "withheld structure") output.structure = "SELECT IDENTIFIER";
		f.dependencies.readDatabase = async () => output as unknown as SafeTemplateResult;
		await rejectsSafely(f.run(), "UNSAFE_OUTPUT", f);
	});
}

test("scope waits for cancelled database teardown before releasing its credential reference", async () => {
	const f = fixture();
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	let teardownFinished = false;
	let settled = false;
	f.dependencies.readDatabase = async (_target, credentials, _read, signal) => {
		if (!signal) throw new Error("Missing cancellation signal");
		f.state.dbCredentials = credentials;
		const aborted = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		entered.resolve();
		try {
			await aborted.promise;
			await closed.promise;
			throw new AwsDbFailure("DB_CANCELLED");
		} finally {
			teardownFinished = true;
		}
	};
	const operation = f.run(controller.signal);
	void operation.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await entered.promise;
	controller.abort();
	await Promise.resolve();
	await Promise.resolve();
	expect(settled || teardownFinished).toBe(false);
	expect(f.state.dbCredentials?.password === f.password).toBe(true);
	closed.resolve();
	await rejectsSafely(operation, "CANCELLED", f);
	expect(teardownFinished).toBe(true);
	expect(f.state.dbCredentials?.password === "").toBe(true);
});

for (const phase of ["secret", "SSO"] as const) {
	test(`late ${phase} responses are cleared after scope cancellation`, async () => {
		const f = fixture();
		if (phase === "SSO") configureSso(f, true);
		const factory = f.dependencies.createClient!;
		const entered = Promise.withResolvers<void>();
		const late = Promise.withResolvers<unknown>();
		f.dependencies.createClient = (service, config) => {
			const client = factory(service, config);
			return {
				send(command, options) {
					if (
						(phase === "secret" && command instanceof GetSecretValueCommand) ||
						(phase === "SSO" && command instanceof GetRoleCredentialsCommand)
					) {
						f.state.commands.push(command);
						entered.resolve();
						return late.promise;
					}
					return client.send(command, options);
				},
				destroy() {
					client.destroy();
				},
			};
		};
		const controller = new AbortController();
		const operation = f.run(controller.signal);
		await entered.promise;
		controller.abort();
		await rejectsSafely(operation, "CANCELLED", f);
		late.resolve(phase === "secret" ? f.secretValue : { roleCredentials: f.roleCredentials });
		await late.promise;
		if (phase === "secret") expect(f.secretValue.SecretString === undefined).toBe(true);
		else
			expect(
				f.roleCredentials.accessKeyId === "" &&
					f.roleCredentials.secretAccessKey === "" &&
					f.roleCredentials.sessionToken === "",
			).toBe(true);
	});
}

test("expired SSO credentials and token expiry during approval do not reach STS", async () => {
	for (const phase of ["role", "approval"] as const) {
		const f = fixture();
		configureSso(f, true);
		if (phase === "role") f.roleCredentials.expiration = f.state.now;
		const authorize = async (step: AwsDbStep) => {
			await f.authorize(step);
			if (phase === "approval") f.state.now += 60_000;
		};
		await rejectsSafely(
			runAwsDbScope(f.request, f.launch, authorize, new AbortController().signal, f.dependencies),
			"AUTH_REQUIRED",
			f,
		);
		expect(f.state.commands.some(command => command instanceof GetCallerIdentityCommand)).toBe(false);
		if (phase === "approval") expect(f.state.commands.length).toBe(0);
	}
});

test("static session expiration is checked again after approval", async () => {
	const f = fixture();
	f.files.set(
		f.launch.sharedCredentialsFile!,
		`${f.files.get(f.launch.sharedCredentialsFile!)}expiration = ${new Date(f.state.now + 1).toISOString()}\n`,
	);
	const authorize = async (step: AwsDbStep) => {
		await f.authorize(step);
		f.state.now++;
	};
	await rejectsSafely(
		runAwsDbScope(f.request, f.launch, authorize, new AbortController().signal, f.dependencies),
		"AUTH_REQUIRED",
		f,
	);
	expect(f.state.commands.length).toBe(0);
});

test("oversized or invalid UTF-8 provider files are bounded and cleared before SDK work", async () => {
	for (const variant of ["oversized", "UTF-8"] as const) {
		const f = fixture();
		f.dependencies.readFile = async () => {
			const bytes = variant === "oversized" ? new Uint8Array(256 * 1024 + 1).fill(65) : new Uint8Array([0xc0, 0xaf]);
			f.state.buffers.push(bytes);
			return bytes;
		};
		await rejectsSafely(f.run(), "PROFILE_UNSUPPORTED", f);
		expect(f.state.commands.length).toBe(0);
	}
});

test("a provider file arriving after cancellation is cleared without further work", async () => {
	const f = fixture();
	const entered = Promise.withResolvers<void>();
	const file = Promise.withResolvers<Uint8Array>();
	f.dependencies.readFile = () => {
		entered.resolve();
		return file.promise;
	};
	const controller = new AbortController();
	const operation = f.run(controller.signal);
	await entered.promise;
	controller.abort();
	await rejectsSafely(operation, "CANCELLED", f);
	const bytes = new TextEncoder().encode(f.password);
	file.resolve(bytes);
	await file.promise;
	expect(bytes.every(value => value === 0)).toBe(true);
	expect(f.state.commands.length).toBe(0);
});

test("approved request fields remain immutable when the caller changes its original object", async () => {
	const f = fixture();
	const endpoint = f.request.expected.endpoint;
	const authorize = async (step: AwsDbStep) => {
		await f.authorize(step);
		f.request.expected.endpoint = "other.invalid";
		f.request.expected.database = "other";
		f.request.automationId = "4";
	};
	await runAwsDbScope(f.request, f.launch, authorize, new AbortController().signal, f.dependencies);
	expect(f.state.dbTarget?.endpoint).toBe(endpoint);
	expect(f.state.dbTarget?.database).toBe("fixture");
	expect(f.state.dbRead?.automationId).toBe("2");
});

test("service descriptors cannot authorize a different SDK operation or secret version", async () => {
	const f = fixture();
	const provider = new AwsDbProvider(f.request, f.launch, f.authorize, new AbortController().signal, f.dependencies);
	try {
		await provider.initialize();
		await rejectsSafely(
			provider.send(
				{ service: "sts", operation: "get-caller-identity", region: f.request.expected.region },
				new GetSecretValueCommand({
					SecretId: f.request.expected.secretArn,
					VersionId: f.request.expected.secretVersionId,
					VersionStage: "AWSCURRENT",
				}),
			),
			"INVALID_REQUEST",
			f,
		);
		await rejectsSafely(
			provider.send(
				{
					service: "secretsmanager",
					operation: "get-secret-value",
					resource: f.request.expected.secretArn,
					region: f.request.expected.region,
				},
				new GetSecretValueCommand({
					SecretId: f.request.expected.secretArn,
					VersionId: "f".repeat(32),
					VersionStage: "AWSCURRENT",
				}),
			),
			"INVALID_REQUEST",
			f,
		);
		expect(f.state.authorized.length).toBe(0);
		expect(f.state.commands.length).toBe(0);
	} finally {
		provider.dispose();
	}
});

test("client disposal failure is fixed-code and cannot produce a successful result", async () => {
	const f = fixture();
	const factory = f.dependencies.createClient!;
	f.dependencies.createClient = (service, config) => {
		const client = factory(service, config);
		return {
			send: (command, options) => client.send(command, options),
			destroy() {
				client.destroy();
				throw new Error(f.password);
			},
		};
	};
	await rejectsSafely(f.run(), "WORKER_FAILED", f);
	expect(f.state.dbCredentials?.password === "").toBe(true);
});

test("official SSO and STS clients use only guarded in-memory credentials and synthetic transports", async () => {
	const f = fixture();
	f.state.now = Date.now();
	f.roleCredentials.expiration = f.state.now + 60_000;
	configureSso(f, true);
	const factory = f.dependencies.createClient!;
	let ssoRequests = 0;
	let stsRequests = 0;
	let bearerBound = false;
	let signingBound = false;
	f.dependencies.createClient = (service, config) => {
		if (service !== "sso" && service !== "sts") return factory(service, config);
		const tracked = { service, config, destroyed: false };
		f.state.clients.push(tracked);
		if (service === "sso") {
			const client = new SSOClient({
				...config,
				requestHandler: {
					async handle(request: HttpRequest) {
						ssoRequests++;
						bearerBound =
							request.headers["x-amz-sso_bearer_token"] === f.token &&
							request.query?.account_id === f.request.expected.accountId &&
							request.query?.role_name === "Reader" &&
							request.path === "/federation/credentials" &&
							request.hostname.endsWith(".amazonaws.com");
						return {
							response: {
								statusCode: 200,
								headers: { "content-type": "application/json" },
								body: new TextEncoder().encode(JSON.stringify({ roleCredentials: f.roleCredentials })),
							},
						};
					},
				},
			});
			return {
				async send(command, options) {
					if (!(command instanceof GetRoleCredentialsCommand)) throw new Error("Unexpected SDK command");
					return client.send(command, options);
				},
				destroy() {
					tracked.destroyed = true;
					client.destroy();
				},
			};
		}
		const client = new STSClient({
			...config,
			requestHandler: {
				async handle(request: HttpRequest) {
					stsRequests++;
					signingBound =
						request.headers.authorization?.includes(`Credential=${f.roleCredentials.accessKeyId}/`) === true &&
						request.headers["x-amz-security-token"] === f.token &&
						request.hostname === "sts.us-east-1.amazonaws.com";
					const body = `<GetCallerIdentityResponse xmlns=\"https://sts.amazonaws.com/doc/2011-06-15/\"><GetCallerIdentityResult><Arn>${f.identity.Arn}</Arn><Account>${f.identity.Account}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>fixture</RequestId></ResponseMetadata></GetCallerIdentityResponse>`;
					return {
						response: {
							statusCode: 200,
							headers: { "content-type": "text/xml" },
							body: new TextEncoder().encode(body),
						},
					};
				},
			},
		});
		return {
			async send(command, options) {
				if (!(command instanceof GetCallerIdentityCommand)) throw new Error("Unexpected SDK command");
				return client.send(command, options);
			},
			destroy() {
				tracked.destroyed = true;
				client.destroy();
			},
		};
	};
	await f.run();
	expect<boolean>(ssoRequests === 1 && stsRequests === 1 && bearerBound && signingBound).toBe(true);
	expect(
		f.state.clients.every(
			client =>
				client.destroyed &&
				client.config.credentials.accessKeyId === "" &&
				client.config.credentials.secretAccessKey === "",
		),
	).toBe(true);
});

for (const [partition, region] of [
	["aws", "me-west-1"],
	["aws", "sa-west-1"],
	["aws-us-gov", "us-gov-west-1"],
	["aws-cn", "cn-north-1"],
] as const) {
	test(`explicit ${partition}/${region} identities keep every SDK operation region-bound`, async () => {
		const f = fixture();
		const expected = f.request.expected;
		const rebind = (arn: string) =>
			arn.replace("arn:aws:", `arn:${partition}:`).replace(":us-east-1:", `:${region}:`);
		expected.partition = partition;
		expected.region = region;
		expected.principalArn = rebind(expected.principalArn);
		expected.clusterArn = rebind(expected.clusterArn);
		expected.instanceArn = rebind(expected.instanceArn);
		expected.secretArn = rebind(expected.secretArn);
		expected.endpoint = `fixture-reader.example.${region}.rds.amazonaws.com${partition === "aws-cn" ? ".cn" : ""}`;
		f.instance.Endpoint.Address = expected.endpoint;
		f.payload.host = expected.endpoint;
		f.secretValue.SecretString = JSON.stringify(f.payload);
		f.identity.Arn = expected.principalArn;
		f.cluster.DBClusterArn = expected.clusterArn;
		f.instance.DBInstanceArn = expected.instanceArn;
		f.metadata.ARN = expected.secretArn;
		f.secretValue.ARN = expected.secretArn;
		f.files.set(f.launch.configFile!, `[profile reader]\nregion = ${region}\n`);
		await f.run();
		expect(f.state.clients.every(client => client.config.region === region)).toBe(true);
		expect(f.state.dbTarget?.partition).toBe(partition);
	});
}

test("an unexpired AWS CLI UTC-suffix SSO cache is read without refresh", async () => {
	const f = fixture();
	const cache = configureSso(f, true);
	const token = JSON.parse(f.files.get(cache)!) as Record<string, unknown>;
	token.expiresAt = new Date(f.state.now + 60_000).toISOString().replace(/Z$/u, "UTC");
	f.files.set(cache, JSON.stringify(token));
	await f.run();
	expect(f.state.commands.filter(command => command instanceof GetRoleCredentialsCommand).length).toBe(1);
});

for (const session of [false, true]) {
	test(`configured trailing-slash ${session ? "session" : "legacy"} SSO URL keeps its exact cache and token binding`, async () => {
		const f = fixture();
		const cache = configureSso(f, session, "https://fixture.awsapps.com/start/");
		await f.run();
		expect(f.state.readPaths.includes(cache)).toBe(true);
		expect(f.state.commands.filter(command => command instanceof GetRoleCredentialsCommand).length).toBe(1);
	});
	test(`mixed trailing-slash ${session ? "session" : "legacy"} SSO URL spellings fail before role retrieval`, async () => {
		const f = fixture();
		const cache = configureSso(f, session, "https://fixture.awsapps.com/start/");
		const token = JSON.parse(f.files.get(cache)!) as Record<string, unknown>;
		token.startUrl = "https://fixture.awsapps.com/start";
		f.files.set(cache, JSON.stringify(token));
		await rejectsSafely(f.run(), "AUTH_REQUIRED", f);
		expect(f.state.commands.length).toBe(0);
	});
}

for (const startUrl of [
	"https://fixture.awsapps.com/start?redirect=other",
	"https://fixture.awsapps.com/start#fragment",
	"https://fixture.awsapps.com.other.invalid/start",
	"http://fixture.awsapps.com/start",
]) {
	test("unsafe configured SSO start URLs fail before cache or role access", async () => {
		const f = fixture();
		configureSso(f, true, startUrl);
		await rejectsSafely(f.run(), "PROFILE_UNSUPPORTED", f);
		expect(f.state.readPaths).toEqual([f.launch.configFile!, f.launch.sharedCredentialsFile!]);
		expect(f.state.commands.length).toBe(0);
	});
}

test("an uncovered future database region fails before provider or approval activity", async () => {
	const f = fixture();
	f.request.expected.region = "us-east-99";
	f.request.expected.endpoint = "fixture-reader.example.us-east-99.rds.amazonaws.com";
	for (const key of ["clusterArn", "instanceArn", "secretArn"] as const) {
		f.request.expected[key] = f.request.expected[key].replace(":us-east-1:", ":us-east-99:");
	}
	await rejectsSafely(f.run(), "INVALID_REQUEST", f);
	expect(f.state.readPaths).toEqual([]);
	expect(f.state.authorized).toEqual([]);
	expect(f.state.commands).toEqual([]);
});

for (const region of ["us-east-99", "cn-south-1", "us-gov-north-1"]) {
	test(`uncovered configured provider region ${region} cannot use ambient credentials`, async () => {
		const f = fixture();
		f.files.set(f.launch.configFile!, `[profile reader]\nregion = ${region}\n`);
		await rejectsSafely(f.run(), "PROFILE_UNSUPPORTED", f);
		expect(f.state.authorized).toEqual([]);
		expect(f.state.commands).toEqual([]);
	});
}

test("an uncovered SSO region fails before token cache or role credential access", async () => {
	const f = fixture();
	configureSso(f, true);
	f.files.set(
		f.launch.configFile!,
		f.files.get(f.launch.configFile!)!.replace("sso_region = us-east-1", "sso_region = us-east-99"),
	);
	await rejectsSafely(f.run(), "PROFILE_UNSUPPORTED", f);
	expect(f.state.readPaths).toEqual([f.launch.configFile!, f.launch.sharedCredentialsFile!]);
	expect(f.state.authorized).toEqual([]);
	expect(f.state.commands).toEqual([]);
});
