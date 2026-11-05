import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DescribeDBClustersCommand, DescribeDBInstancesCommand, ListTagsForResourceCommand } from "@aws-sdk/client-rds";
import { DescribeSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { Type } from "@oh-my-pi/omptype/typebox";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resolveToolCancellationBehavior } from "@oh-my-pi/pi-agent-core/tool-cancellation";
import { Settings } from "../../src/config/settings";
import type { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";
import { createTools, type Tool, type ToolSession } from "../../src/tools";
import { AwsDbTool, type AwsDbToolDependencies } from "../../src/tools/aws-db";
import {
	assertAwsDbCapability,
	AWS_DB_CAPABILITY,
	AWS_DB_FAILURE_CODES,
	AWS_DB_INPUT_SCHEMA,
	AwsDbFailure,
	normalizeAwsDbRequest,
	type AwsDbCapability,
	type AwsDbFailureCode,
	type AwsDbInspectionRequest,
	type DbCredentials,
} from "../../src/tools/aws-db-contract";
import { createAutomationTemplateReader } from "../../src/tools/aws-db-query";
import { isSafeTemplateStructure } from "../../src/tools/aws-db-sanitize";
import type { AwsDbClientConfig, AwsDbLaunchFiles, AwsDbScopeDependencies } from "../../src/tools/aws-db-scope";
import { startAwsDbWorker } from "../../src/tools/aws-db-worker";
import { createAwsDbWorkerClient } from "../../src/tools/aws-db-worker-client";
import { TOOL_EXECUTION_HOST_CAPABILITIES } from "../../src/tools/tool-execution-host";
import { resolveMountedXdevExecutable, resolveXdevTool } from "../../src/tools/xdev";
import {
	startAwsDbMysqlFixture,
	type AwsDbMysqlFixture,
	type AwsDbMysqlFixtureOptions,
} from "../helpers/aws-db-mysql-fixture";
import { AWS_DB_SMOKE_FAILURE_CHECKS, type AwsDbSmokeFailureStage } from "./aws-db-native-diagnostics";

type ScopeFailure = "identity" | "tenant" | "resource" | "version" | "provider-error";
export interface WorkerPlan {
	request: AwsDbInspectionRequest;
	fixture?: Pick<AwsDbMysqlFixtureOptions, "reader" | "promotion" | "replaceSession" | "delay" | "errorAt">;
	source?: "unsupported";
	failure?: ScopeFailure;
	expectConnections: 0 | 1;
	expectReads: 0 | 1;
	cancelAtRead?: boolean;
}
interface WorkerHostPlan extends WorkerPlan {
	launch: AwsDbLaunchFiles;
}
const workerHostPlanSchema = Type.Object(
	{
		request: Type.Unknown(),
		fixture: Type.Optional(
			Type.Object(
				{
					reader: Type.Optional(Type.Union([Type.Literal("writable"), Type.Literal("unknown")])),
					promotion: Type.Optional(Type.Union([Type.Literal("during-read"), Type.Literal("after-read")])),
					replaceSession: Type.Optional(Type.Boolean()),
					delay: Type.Optional(Type.Union([Type.Literal("handshake"), Type.Literal("read")])),
					errorAt: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
				},
				{ additionalProperties: false },
			),
		),
		source: Type.Optional(Type.Literal("unsupported")),
		failure: Type.Optional(
			Type.Union([
				Type.Literal("identity"),
				Type.Literal("tenant"),
				Type.Literal("resource"),
				Type.Literal("version"),
				Type.Literal("provider-error"),
			]),
		),
		expectConnections: Type.Union([Type.Literal(0), Type.Literal(1)]),
		expectReads: Type.Union([Type.Literal(0), Type.Literal(1)]),
		cancelAtRead: Type.Optional(Type.Boolean()),
		launch: Type.Object(
			{
				configFile: Type.String({ minLength: 1, maxLength: 4096 }),
				sharedCredentialsFile: Type.String({ minLength: 1, maxLength: 4096 }),
				homeDir: Type.String({ minLength: 1, maxLength: 4096 }),
				reservedProfiles: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
interface Observation {
	leaked: boolean;
	output: boolean;
	mutations: number;
	inspect(value: unknown): void;
}
interface SmokeCounts {
	approvals: number;
	artifactAllocations: number;
	providerScopes: number;
	guardSteps: number;
	workers: number;
	exitedWorkers: number;
	physicalConnectionsVerified: number;
	physicalSourceReadsVerified: number;
	fileMutations: number;
}
interface Invocation {
	result?: AgentToolResult<unknown>;
	failed: boolean;
	code?: AwsDbFailureCode;
}
interface SmokeWorkerRoot {
	directory: string;
	watcher?: fs.FSWatcher;
	exitObserved: boolean;
	inspected: boolean;
	removed: boolean;
}

const FAILURE = "AWS_DB_NATIVE_SMOKE_BOUNDARY_FAILED";
const emitFixedOutput = process.stdout.write.bind(process.stdout);
let failureCase = "setup";
let failureStage: AwsDbSmokeFailureStage = "SETUP";
let failureNativeCode: AwsDbFailureCode | "NONE" = "NONE";
let failureWorkerCode: AwsDbFailureCode | "NONE" = "NONE";
const failureChecks: Record<(typeof AWS_DB_SMOKE_FAILURE_CHECKS)[number], boolean> = {
	hostIdentity: false,
	nativeCleanup: false,
	mountedCleanup: false,
	canonicalWriterCleanup: false,
	decoratedWriterCleanup: false,
	invokeSucceeded: false,
	resultPresent: false,
	zeroApproval: false,
	zeroProvider: false,
	zeroGuard: false,
	workerCapabilities: false,
	workerFailure: false,
	workersExited: false,
	workerExitSuccess: false,
	cleanSurfaces: false,
	zeroArtifacts: false,
	cleanFiles: false,
	workerRootUnobserved: false,
	workerRootNonempty: false,
	workerWatcherMutation: false,
	workerCleanupObserved: false,
	workerCleanupBeforeExit: false,
	workerRootsRemoved: false,
};
function requireProof(value: unknown): asserts value {
	if (!value) throw new Error(FAILURE);
}
function nativeResponse(result: AgentToolResult<unknown> | undefined): Record<string, unknown> | undefined {
	const details = result?.details;
	if (!isRecord(details)) return undefined;
	let response: unknown = details.response;
	if (isRecord(details.xdev) && isRecord(details.xdev.inner)) response = details.xdev.inner.response;
	return isRecord(response) ? response : undefined;
}
function marker(): string {
	return `smokedb_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
}
function observeSurfaces(sensitive: (value: string) => boolean): Observation {
	const observation: Observation = {
		leaked: false,
		output: false,
		mutations: 0,
		inspect(value: unknown): void {
			const seen = new WeakSet<object>();
			const visit = (item: unknown): void => {
				if (typeof item === "string") {
					if (sensitive(item)) observation.leaked = true;
					return;
				}
				if (!item || typeof item !== "object" || seen.has(item)) return;
				seen.add(item);
				if (item instanceof Uint8Array) {
					visit(Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString("utf8"));
					return;
				}
				for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
					visit(key);
					if ("value" in descriptor) visit(descriptor.value);
				}
			};
			visit(value);
		},
	};
	const filesystem = createRequire(import.meta.url)("node:fs") as typeof fs;
	for (const name of [
		"writeFile",
		"appendFile",
		"writeFileSync",
		"appendFileSync",
		"write",
		"writeSync",
		"createWriteStream",
	] as const) {
		Object.defineProperty(filesystem, name, {
			value: new Proxy(filesystem[name], {
				apply(_target, _receiver, values) {
					observation.mutations++;
					observation.inspect(values);
					throw new Error(FAILURE);
				},
			}),
		});
	}
	for (const name of ["writeFile", "appendFile"] as const) {
		Object.defineProperty(filesystem.promises, name, {
			value: new Proxy(filesystem.promises[name], {
				apply(_target, _receiver, values) {
					observation.mutations++;
					observation.inspect(values);
					throw new Error(FAILURE);
				},
			}),
		});
	}
	Bun.write = new Proxy(Bun.write, {
		apply(_target, _receiver, values) {
			observation.mutations++;
			observation.inspect(values);
			throw new Error(FAILURE);
		},
	});
	syncBuiltinESMExports();
	for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) {
		console[name] = (...values: unknown[]) => {
			observation.output = true;
			observation.inspect(values);
		};
	}
	for (const stream of [process.stdout, process.stderr]) {
		stream.write = new Proxy(stream.write, {
			apply(_target, _this, values) {
				observation.output = true;
				observation.inspect(values);
				const callback = values.find(value => typeof value === "function") as (() => void) | undefined;
				callback?.();
				return true;
			},
		});
	}
	if (process.send) {
		process.send = new Proxy(process.send, {
			apply(target, receiver, values) {
				observation.inspect(values[0]);
				if (observation.leaked || observation.output || observation.mutations !== 0) process.exit(42);
				return Reflect.apply(target, receiver, values);
			},
		});
	}
	return observation;
}
async function snapshot(root: string, observation: Observation): Promise<Map<string, Uint8Array>> {
	const entries = new Map<string, Uint8Array>();
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
			const filename = path.join(directory, entry.name);
			observation.inspect(filename);
			if (entry.isDirectory()) await visit(filename);
			else if (entry.isFile()) {
				const bytes = new Uint8Array(await Bun.file(filename).arrayBuffer());
				observation.inspect(bytes);
				entries.set(path.relative(root, filename), bytes);
			} else {
				const target = await fs.promises.readlink(filename);
				observation.inspect(target);
				entries.set(path.relative(root, filename), new TextEncoder().encode(target));
			}
		}
	};
	await visit(root);
	return entries;
}
function sameSnapshot(before: Map<string, Uint8Array>, after: Map<string, Uint8Array>): boolean {
	if (before.size !== after.size) return false;
	for (const [filename, bytes] of before) {
		const current = after.get(filename);
		if (!current || !Bun.deepEquals(bytes, current)) return false;
	}
	return true;
}
async function closed(fixture: AwsDbMysqlFixture): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (fixture.state.closedConnections !== fixture.state.connections && Date.now() < deadline) await Bun.sleep(5);
	requireProof(fixture.state.closedConnections === fixture.state.connections);
}

async function runWorkerHost(plan: WorkerHostPlan): Promise<void> {
	const request = normalizeAwsDbRequest(plan.request);
	requireProof(request.action === "inspect-automation-template");
	const secrets = [marker(), marker(), marker(), marker(), marker(), marker()];
	let fixture: AwsDbMysqlFixture | undefined;
	const observation = observeSurfaces(
		value => secrets.some(secret => value.includes(secret)) || fixture?.containsSensitive(value) === true,
	);
	const before = await snapshot(process.cwd(), observation);
	let clients = 0;
	let secretReads = 0;
	let serviceRequests = 0;
	let readCalls = 0;
	const credentialReferences: DbCredentials[] = [];
	const providerReferences: AwsDbClientConfig[] = [];
	const fileReferences: Uint8Array[] = [];
	const source =
		plan.source === "unsupported"
			? `SELECT '${secrets[3]}' /* ${secrets[4]} */; DELETE FROM ${secrets[5]}`
			: `SELECT ${secrets[3]}, '${secrets[4]}@example.invalid' FROM ${secrets[5]} WHERE ${secrets[3]} = '${secrets[0]}' AND ${secrets[5]} = {steps.${secrets[2]}.value}`;
	try {
		if (plan.expectConnections === 1) {
			fixture = await startAwsDbMysqlFixture({
				...plan.fixture,
				port: request.expected.port,
				timeoutMs: request.limits.timeoutMs,
				rawTemplate: source,
			});
			requireProof(
				fixture.target.endpoint === request.expected.endpoint &&
					fixture.target.port === request.expected.port &&
					fixture.target.database === request.expected.database,
			);
		}
		const databaseCredentials = { username: fixture?.username ?? marker(), password: fixture?.password ?? marker() };
		secrets.push(databaseCredentials.username, databaseCredentials.password);
		const launch = plan.launch;
		requireProof(launch && path.isAbsolute(launch.homeDir) && launch.configFile && launch.sharedCredentialsFile);
		const clusterName = request.expected.clusterArn.split(":")[6];
		const instanceName = request.expected.instanceArn.split(":")[6];
		const tag = {
			Key: "coreforge:tenant-id",
			Value: plan.failure === "tenant" ? "other-tenant" : request.expected.tenantId,
		};
		const dependencies: AwsDbScopeDependencies = {
			readFile: async (filename, maxBytes, signal) => {
				requireProof(!signal.aborted && maxBytes > 0);
				let text: string;
				if (filename === launch.configFile)
					text = `[profile ${request.profile}]\nregion = ${request.expected.region}\n`;
				else if (filename === launch.sharedCredentialsFile) {
					text = `[${request.profile}]\naws_access_key_id = ${secrets[0]}\naws_secret_access_key = ${secrets[1]}\naws_session_token = ${secrets[2]}\n`;
				} else throw new AwsDbFailure("PROFILE_UNSUPPORTED");
				const bytes = new TextEncoder().encode(text);
				requireProof(bytes.byteLength <= maxBytes);
				fileReferences.push(bytes);
				return bytes;
			},
			createClient: (service, config) => {
				requireProof(
					config.maxAttempts === 1 &&
						config.ignoreConfiguredEndpointUrls === true &&
						config.region === request.expected.region,
				);
				requireProof(
					config.credentials.accessKeyId === secrets[0] &&
						config.credentials.secretAccessKey === secrets[1] &&
						config.credentials.sessionToken === secrets[2],
				);
				providerReferences.push(config);
				clients++;
				let destroyed = false;
				return {
					async send(command, options) {
						requireProof(!destroyed && !options.abortSignal.aborted);
						serviceRequests++;
						if (plan.failure === "provider-error")
							throw new Error(secrets[0], { cause: { nested: [secrets[1], secrets[3]] } });
						if (command instanceof GetCallerIdentityCommand) {
							requireProof(service === "sts");
							return {
								Account: plan.failure === "identity" ? "999999999999" : request.expected.accountId,
								Arn: request.expected.principalArn,
							};
						}
						if (command instanceof DescribeDBClustersCommand) {
							requireProof(
								service === "rds" && command.input.DBClusterIdentifier === request.expected.clusterArn,
							);
							return {
								DBClusters: [
									{
										DBClusterArn: request.expected.clusterArn,
										DbClusterResourceId: request.expected.clusterResourceId,
										DBClusterIdentifier: clusterName,
										Engine: "aurora-mysql",
										EngineVersion: "8.0.mysql_aurora.3.10.0",
										Status: "available",
										Port: request.expected.port,
										DatabaseName: request.expected.database,
										DBClusterMembers: [
											{ DBInstanceIdentifier: instanceName, IsClusterWriter: false },
											{ DBInstanceIdentifier: "fixture-writer", IsClusterWriter: true },
										],
									},
								],
							};
						}
						if (command instanceof DescribeDBInstancesCommand) {
							requireProof(
								service === "rds" && command.input.DBInstanceIdentifier === request.expected.instanceArn,
							);
							return {
								DBInstances: [
									{
										DBInstanceArn: request.expected.instanceArn,
										DbiResourceId:
											plan.failure === "resource" ? "db-OTHER" : request.expected.instanceResourceId,
										DBInstanceIdentifier: instanceName,
										DBClusterIdentifier: clusterName,
										Engine: "aurora-mysql",
										EngineVersion: "8.0.mysql_aurora.3.10.0",
										DBInstanceStatus: "available",
										Endpoint: { Address: request.expected.endpoint, Port: request.expected.port },
									},
								],
							};
						}
						if (command instanceof ListTagsForResourceCommand) {
							requireProof(
								service === "rds" &&
									[request.expected.clusterArn, request.expected.instanceArn].includes(
										command.input.ResourceName ?? "",
									),
							);
							return { TagList: [tag] };
						}
						if (command instanceof DescribeSecretCommand) {
							requireProof(
								service === "secretsmanager" && command.input.SecretId === request.expected.secretArn,
							);
							return {
								ARN: request.expected.secretArn,
								Tags: [tag, { Key: "coreforge:database-reader", Value: "true" }],
								VersionIdsToStages: {
									[plan.failure === "version"
										? "00000000-0000-4000-8000-000000000000"
										: request.expected.secretVersionId]: ["AWSCURRENT"],
								},
							};
						}
						if (command instanceof GetSecretValueCommand) {
							secretReads++;
							requireProof(
								service === "secretsmanager" &&
									command.input.SecretId === request.expected.secretArn &&
									command.input.VersionId === request.expected.secretVersionId &&
									command.input.VersionStage === "AWSCURRENT",
							);
							return {
								ARN: request.expected.secretArn,
								VersionId: request.expected.secretVersionId,
								VersionStages: ["AWSCURRENT"],
								SecretString: JSON.stringify({
									engine: "mysql",
									host: request.expected.endpoint,
									port: request.expected.port,
									dbname: request.expected.database,
									...databaseCredentials,
									dbClusterIdentifier: clusterName,
								}),
							};
						}
						throw new AwsDbFailure("AWS_FAILED");
					},
					destroy() {
						if (!destroyed) clients--;
						destroyed = true;
					},
				};
			},
			readDatabase: async (target, credentials, read, signal) => {
				readCalls++;
				requireProof(fixture !== undefined);
				credentialReferences.push(credentials);
				requireProof(
					target.partition === request.expected.partition &&
						Bun.deepEquals(target, fixture.target) &&
						read.agencyId === fixture.read.agencyId &&
						read.automationId === fixture.read.automationId &&
						read.stepId === fixture.read.stepId &&
						read.limits.maxBytes === fixture.read.limits.maxBytes,
				);
				const reader = createAutomationTemplateReader({ tlsCa: fixture.tlsCa });
				if (plan.cancelAtRead) void fixture.readStarted.then(() => process.kill(process.ppid, "SIGUSR1"));
				try {
					const result = await reader(target, credentials, read, signal);
					requireProof(
						result.proof.reader &&
							result.proof.sameConnection &&
							result.teardown.connectionClosed &&
							result.teardown.referencesReleased,
					);
					if (plan.source === "unsupported")
						requireProof(result.disposition === "withheld" && result.structure === undefined);
					else
						requireProof(
							result.disposition === "sanitized" &&
								isSafeTemplateStructure(result.structure) &&
								result.structure.includes("PLACEHOLDER") &&
								result.structure.includes("LITERAL"),
						);
					return result;
				} finally {
					await closed(fixture);
				}
			},
		};
		await startAwsDbWorker(dependencies);
		const expectedRequests =
			plan.failure === "identity" || plan.failure === "provider-error"
				? 1
				: plan.failure === "tenant"
					? 3
					: plan.failure === "resource"
						? 4
						: plan.failure === "version"
							? 6
							: plan.expectConnections === 1
								? 7
								: request.profile === "smoke-guard-deny"
									? 0
									: 3;
		requireProof(serviceRequests === expectedRequests);
		requireProof(clients === 0 && fileReferences.every(bytes => bytes.every(byte => byte === 0)));
		requireProof(
			providerReferences.every(
				config =>
					config.credentials.accessKeyId === "" &&
					config.credentials.secretAccessKey === "" &&
					!config.credentials.sessionToken,
			),
		);
		requireProof(
			credentialReferences.every(credentials => credentials.username === "" && credentials.password === ""),
		);
		requireProof(readCalls === plan.expectConnections && secretReads === plan.expectConnections);
		if (fixture) {
			await closed(fixture);
			requireProof(
				fixture.state.connections === 1 &&
					fixture.state.tlsConnections === 1 &&
					fixture.state.closedConnections === 1 &&
					fixture.state.authenticationVerified,
			);
			requireProof(fixture.state.definitionReads === plan.expectReads);
			if (plan.expectReads === 1)
				requireProof(fixture.state.definitionBindingsVerified && fixture.state.serverExecutionLimitVerified);
			observation.inspect(fixture.state.commands);
		}
		requireProof(!observation.leaked && !observation.output && observation.mutations === 0);
	} catch {
		process.exitCode = 42;
	} finally {
		try {
			if (
				!sameSnapshot(before, await snapshot(process.cwd(), observation)) ||
				observation.leaked ||
				observation.output ||
				observation.mutations !== 0
			)
				process.exitCode = 42;
		} catch {
			process.exitCode = 42;
		}
		await fixture?.close();
	}
}

export async function freeLoopbackPort(): Promise<number> {
	const server = net.createServer();
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	requireProof(address !== null && typeof address !== "string");
	const done = Promise.withResolvers<void>();
	server.close(error => (error ? done.reject(error) : done.resolve()));
	await done.promise;
	return address.port;
}
export function inspection(port = 3306, profile = "smoke"): AwsDbInspectionRequest {
	return {
		action: "inspect-automation-template",
		capability: AWS_DB_CAPABILITY.capability,
		profile,
		expected: {
			accountId: "123456789012",
			principalArn: "arn:aws:sts::123456789012:assumed-role/fixture-reader/smoke",
			partition: "aws",
			region: "us-east-1",
			tenantId: "fixture-tenant",
			clusterArn: "arn:aws:rds:us-east-1:123456789012:cluster:fixture-cluster",
			clusterResourceId: "cluster-FIXTURE",
			instanceArn: "arn:aws:rds:us-east-1:123456789012:db:fixture-reader",
			instanceResourceId: "db-FIXTURE",
			endpoint: "localhost",
			port,
			database: "fixture",
			secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture-reader-ABCDEF",
			secretVersionId: "11111111-1111-4111-8111-111111111111",
		},
		agencyId: "7",
		automationId: "11",
		stepId: "13",
		limits: { maxRows: 1, maxBytes: 4096, timeoutMs: 10_000 },
	};
}

export function createAwsDbNativeSmokeWorkerClient(
	plan: WorkerPlan,
	launch: AwsDbLaunchFiles,
	onSpawn?: (child: Bun.Subprocess<"ignore", "ignore", "ignore">) => void,
	beforeDirectoryRemoval?: (directory: string) => void,
) {
	return createAwsDbWorkerClient({
		beforeDirectoryRemoval,
		spawn: (_command, options) => {
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					"--no-install",
					import.meta.path,
					"--worker-host",
					JSON.stringify({ ...plan, launch }),
				],
				options,
			);
			onSpawn?.(child);
			return child;
		},
	});
}

async function runSmoke(root: string, mode: "full" | "capabilities" | "missing"): Promise<void> {
	const stdout = emitFixedOutput;
	const observation = observeSurfaces(value => /smokedb_[a-f0-9]{48}/u.test(value));
	const counts: SmokeCounts = {
		approvals: 0,
		artifactAllocations: 0,
		providerScopes: 0,
		guardSteps: 0,
		workers: 0,
		exitedWorkers: 0,
		physicalConnectionsVerified: 0,
		physicalSourceReadsVerified: 0,
		fileMutations: 0,
	};
	let failedWorker = false;
	const ownedRoots = new Map<string, SmokeWorkerRoot>();
	const inspectOwnedRoot = (owned: SmokeWorkerRoot): void => {
		const watcher = owned.watcher;
		owned.watcher = undefined;
		try {
			watcher?.close();
		} catch {
			failureChecks.workerRootUnobserved = true;
			counts.fileMutations++;
		}
		if (!owned.exitObserved) {
			failureChecks.workerCleanupBeforeExit = true;
			counts.fileMutations++;
		}
		try {
			if (fs.readdirSync(owned.directory).length !== 0) {
				failureChecks.workerRootNonempty = true;
				counts.fileMutations++;
			}
			owned.inspected = true;
		} catch {
			failureChecks.workerRootUnobserved = true;
			counts.fileMutations++;
		}
	};
	const beforeDirectoryRemoval = (directory: string): void => {
		const owned = ownedRoots.get(directory);
		if (!owned) {
			failureChecks.workerRootUnobserved = true;
			counts.fileMutations++;
			return;
		}
		failureChecks.workerCleanupObserved = true;
		inspectOwnedRoot(owned);
	};
	const originalSpawn = Bun.spawn;
	Bun.spawn = new Proxy(originalSpawn, {
		apply(target, receiver, values) {
			observation.inspect(values);
			const command = values[0] as unknown;
			const worker =
				Array.isArray(command) &&
				command.some(
					argument =>
						typeof argument === "string" &&
						(argument.endsWith("aws-db-worker.ts") ||
							argument === "__omp_worker_aws_db" ||
							argument === "--worker-host"),
				);
			let workerRoot: SmokeWorkerRoot | undefined;
			const options = values[1] as
				| {
						cwd?: string;
						ipc?: (...args: unknown[]) => unknown;
						onExit?: (...args: unknown[]) => unknown;
				  }
				| undefined;
			if (options) {
				const observed = { ...options };
				if (options.ipc) {
					observed.ipc = new Proxy(options.ipc, {
						apply(callback, context, args) {
							observation.inspect(args);
							const message = args[0];
							if (worker && isRecord(message)) {
								if (message.type === "capabilities") failureChecks.workerCapabilities = true;
								if (message.type === "failure") {
									failureChecks.workerFailure = true;
									failureWorkerCode = AWS_DB_FAILURE_CODES.find(code => code === message.code) ?? "NONE";
								}
							}
							return Reflect.apply(callback, context, args);
						},
					});
				}
				if (worker && options.onExit) {
					observed.onExit = new Proxy(options.onExit, {
						apply(callback, context, args) {
							if (workerRoot) {
								workerRoot.exitObserved = true;
							}
							return Reflect.apply(callback, context, args);
						},
					});
				}
				values[1] = observed;
				if (worker && options.cwd) {
					workerRoot = { directory: options.cwd, exitObserved: false, inspected: false, removed: false };
					ownedRoots.set(options.cwd, workerRoot);
					workerRoot.watcher = fs.watch(options.cwd, () => {
						failureChecks.workerWatcherMutation = true;
						counts.fileMutations++;
					});
					workerRoot.watcher.unref();
				}
			}
			let child: Bun.Subprocess;
			try {
				child = Reflect.apply(target, receiver, values) as Bun.Subprocess;
			} catch (error) {
				workerRoot?.watcher?.close();
				throw error;
			}
			if (worker) {
				counts.workers++;
				void child.exited.then(code => {
					if (workerRoot) workerRoot.exitObserved = true;
					counts.exitedWorkers++;
					if (code !== 0) failedWorker = true;
				});
			}
			return child;
		},
	});
	let sessionId = "aws-db-native-smoke";
	let choice: "approve" | "deny" = "approve";
	const choices: string[][] = [];
	const dispose = new Set<() => void>();
	const beginDispose = new Set<() => void>();
	const sessionChanges = new Set<() => void>();
	let disposed = false;
	let activeContext: AgentToolContext;
	const session: ToolSession = {
		cwd: root,
		hasUI: true,
		skipPythonPreflight: true,
		settings: Settings.isolated({ "tools.approvalMode": "yolo" }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => sessionId,
		isDisposed: () => disposed,
		getToolContext: () => activeContext,
		registerDisposeCallback: (callback, options) => {
			const callbacks = options?.phase === "begin" ? beginDispose : dispose;
			callbacks.add(callback);
			return () => {
				callbacks.delete(callback);
			};
		},
		registerSessionChangeCallback: callback => {
			sessionChanges.add(callback);
			return () => {
				sessionChanges.delete(callback);
			};
		},
		getToolExecutionCapabilities: (tool, args) => {
			failureChecks.hostIdentity = !disposed && Boolean(sessionId);
			failureChecks.nativeCleanup = resolveToolCancellationBehavior(tool, args) === "await-cleanup";
			if (!failureChecks.hostIdentity || !failureChecks.nativeCleanup) return undefined;
			const mounted = session.xdev && resolveMountedXdevExecutable(session.xdev, tool.name);
			const canonicalWriter = session.toolRegistry?.get("write");
			failureChecks.mountedCleanup =
				mounted !== undefined && resolveToolCancellationBehavior(mounted, args) === "await-cleanup";
			if (!mounted || !canonicalWriter || !executionWrite || !failureChecks.mountedCleanup) return undefined;
			const input = { path: `xd://${tool.name}`, content: JSON.stringify(args) };
			failureChecks.canonicalWriterCleanup =
				resolveToolCancellationBehavior(canonicalWriter, input) === "await-cleanup";
			failureChecks.decoratedWriterCleanup =
				resolveToolCancellationBehavior(executionWrite, input) === "await-cleanup";
			if (!failureChecks.canonicalWriterCleanup || !failureChecks.decoratedWriterCleanup) return undefined;
			return TOOL_EXECUTION_HOST_CAPABILITIES;
		},
		allocateOutputArtifact: async (...args) => {
			counts.artifactAllocations++;
			observation.inspect(args);
			throw new Error(FAILURE);
		},
		sessionManager: {
			appendCustomEntry: (...args: unknown[]) => {
				observation.inspect(args);
				return "smoke-audit";
			},
			ensureOnDisk: async () => {
				throw new Error(FAILURE);
			},
			flush: async () => {
				throw new Error(FAILURE);
			},
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => sessionId,
		},
	};
	const ui = {
		select: async (title: string, options: string[]) => {
			counts.approvals++;
			observation.inspect([title, options]);
			choices.push([...options]);
			return choice === "deny"
				? "Deny"
				: options.find(option => ["Approve once", "Approve Once", "Approve"].includes(option));
		},
	};
	const approvalAuthority = {
		authStorage: {
			credentials: { list: () => [] },
			oauth: { accounts: () => [] },
			sourceIdentity: undefined,
		},
	};
	const context = (): AgentToolContext =>
		({
			settings: session.settings,
			hasUI: true,
			ui,
			sessionManager: { getCwd: () => root, getSessionId: () => sessionId, getSessionName: () => undefined },
			modelRegistry: approvalAuthority,
			model: undefined,
		}) as unknown as AgentToolContext;
	activeContext = context();
	const runner = {
		cwd: root,
		get sessionId() {
			return sessionId;
		},
		get sessionSettings() {
			return session.settings;
		},
		createContext: context,
		hasHandlers: () => false,
		hasUI: () => true,
		consumeToolCallEmitted: () => false,
		hasSessionApproval: () => true,
		grantSessionApproval: () => {
			throw new Error(FAILURE);
		},
		runScoped: <T>(fn: () => T): T => fn(),
		getUIContext: () => ui,
	} as unknown as ExtensionRunner;
	if (mode === "missing") {
		const before = await snapshot(root, observation);
		await createTools(session, ["read", "write"]);
		requireProof(
			session.xdev && resolveXdevTool(session.xdev, "aws_db") === undefined && !session.toolRegistry?.has("aws_db"),
		);
		requireProof(
			counts.providerScopes === 0 && counts.approvals === 0 && counts.guardSteps === 0 && counts.workers === 0,
		);
		requireProof(sameSnapshot(before, await snapshot(root, observation)) && !observation.leaked);
		stdout(
			`${JSON.stringify({ discovery: null, nativeCalls: { authentication: 0, approval: 0, provider: 0, network: 0 } })}\n`,
		);
		return;
	}
	const tools = await createTools(session);
	requireProof(session.xdev && session.toolRegistry && session.xdev.mountedNames.has("aws_db"));
	const registered = session.toolRegistry.get("aws_db");
	const canonicalWrite = tools.find(tool => tool.name === "write");
	requireProof(registered && canonicalWrite);
	const probeClient = createAwsDbWorkerClient({ beforeDirectoryRemoval });
	const canonical = new AwsDbTool(session, { probeWorker: probeClient.probeAwsDbWorker });
	session.toolRegistry.set("aws_db", canonical);
	session.xdev.decorateExecution = tool =>
		new ExtensionToolWrapper(tool as unknown as AgentTool, runner) as unknown as Tool;
	const write = new ExtensionToolWrapper(canonicalWrite as unknown as AgentTool, runner);
	const executionWrite = write;
	const launch = Object.freeze({
		configFile: path.join(root, "synthetic-config"),
		sharedCredentialsFile: path.join(root, "synthetic-credentials"),
		homeDir: root,
		reservedProfiles: Object.freeze([] as string[]),
	});
	let sequence = 0;
	const invoke = async (args: unknown, signal?: AbortSignal, id = `smoke-${++sequence}`): Promise<Invocation> => {
		activeContext = context();
		const input = { path: "xd://aws_db", content: JSON.stringify(args) };
		observation.inspect(input);
		try {
			const result = await write.execute(id, input, signal, update => observation.inspect(update), activeContext);
			observation.inspect(result);
			const response = nativeResponse(result);
			return {
				result,
				failed: result.isError === true,
				code: AWS_DB_FAILURE_CODES.find(code => code === response?.code),
			};
		} catch (error) {
			observation.inspect(error);
			return {
				failed: true,
				code: error instanceof Error ? AWS_DB_FAILURE_CODES.find(code => code === error.message) : undefined,
			};
		}
	};
	const before = await snapshot(root, observation);
	const cases: { name: string; passed: true }[] = [];
	const record = async (name: string, run: () => Promise<void>): Promise<void> => {
		failureCase = name;
		failureStage = "CASE_BODY";
		failureNativeCode = "NONE";
		failureWorkerCode = "NONE";
		for (const name of AWS_DB_SMOKE_FAILURE_CHECKS) failureChecks[name] = false;
		choice = "approve";
		session.settings = Settings.isolated({ "tools.approvalMode": "yolo" });
		activeContext = context();
		await run();
		failureStage = "CASE_WORKERS";
		failureChecks.workersExited = counts.exitedWorkers === counts.workers;
		failureChecks.workerExitSuccess = !failedWorker;
		requireProof(failureChecks.workersExited && failureChecks.workerExitSuccess);
		failureStage = "CASE_SURFACES";
		failureChecks.cleanSurfaces = !observation.leaked && observation.mutations === 0;
		failureChecks.zeroArtifacts = counts.artifactAllocations === 0;
		requireProof(failureChecks.cleanSurfaces && failureChecks.zeroArtifacts);
		failureStage = "CASE_FILES";
		if (!sameSnapshot(before, await snapshot(root, observation))) counts.fileMutations++;
		failureChecks.workerRootsRemoved = true;
		for (const owned of ownedRoots.values()) {
			if (!owned.inspected) {
				failureChecks.workerRootUnobserved = true;
				failureChecks.workerRootsRemoved = false;
				continue;
			}
			if (!owned.removed) {
				try {
					fs.lstatSync(owned.directory);
				} catch (error) {
					owned.removed = Boolean(
						error && typeof error === "object" && "code" in error && error.code === "ENOENT",
					);
				}
			}
			if (!owned.removed) failureChecks.workerRootsRemoved = false;
		}
		failureChecks.cleanFiles = counts.fileMutations === 0 && !observation.leaked && failureChecks.workerRootsRemoved;
		requireProof(failureChecks.cleanFiles);
		failureStage = "CASE_COMPLETE";
		cases.push({ name, passed: true });
	};
	const install = (plan: WorkerPlan, overrides: Partial<AwsDbToolDependencies> = {}): AwsDbTool => {
		const client = createAwsDbNativeSmokeWorkerClient(plan, launch, undefined, beforeDirectoryRemoval);
		const native = new AwsDbTool(session, {
			launch: () => launch,
			probeWorker: probeClient.probeAwsDbWorker,
			runWorker: async (request, files, authorize, signal) => {
				counts.providerScopes++;
				const result = await client.runAwsDbWorker(
					request,
					files,
					async step => {
						counts.guardSteps++;
						observation.inspect(step);
						await authorize(step);
					},
					signal,
				);
				requireProof(counts.exitedWorkers === counts.workers && !failedWorker);
				return result;
			},
			...overrides,
		});
		session.toolRegistry!.set("aws_db", native);
		return native;
	};
	try {
		await record("registered-capability-no-access", async () => {
			session.settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
			const beforeApprovals = counts.approvals;
			failureStage = "CAPABILITY_INVOKE";
			const result = await invoke({ action: "capabilities" });
			failureNativeCode = result.code ?? "NONE";
			failureChecks.invokeSucceeded = !result.failed;
			failureChecks.resultPresent = result.result !== undefined;
			failureChecks.zeroApproval = counts.approvals === beforeApprovals;
			failureChecks.zeroProvider = counts.providerScopes === 0;
			failureChecks.zeroGuard = counts.guardSteps === 0;
			failureChecks.workersExited = counts.exitedWorkers === counts.workers;
			failureChecks.workerExitSuccess = !failedWorker;
			failureStage = "CAPABILITY_RESULT";
			requireProof(!result.failed && result.result);
			failureStage = "CAPABILITY_APPROVAL";
			requireProof(failureChecks.zeroApproval);
			failureStage = "CAPABILITY_ACCESS";
			requireProof(failureChecks.zeroProvider && failureChecks.zeroGuard);
			const capability = nativeResponse(result.result);
			failureStage = "CAPABILITY_VALUE";
			assertAwsDbCapability(capability);
			failureStage = "CAPABILITY_SCHEMA";
			requireProof(Bun.deepEquals(canonical.parameters.toJsonSchema(), AWS_DB_INPUT_SCHEMA));
			if (mode === "capabilities")
				stdout(
					`${JSON.stringify({
						discovery: { name: "aws_db", inputSchema: canonical.parameters.toJsonSchema() },
						capability,
						nativeCalls: {
							authentication: 0,
							approval: counts.approvals,
							provider: counts.providerScopes,
							network: counts.guardSteps,
						},
					})}\n`,
				);
		});
		if (mode === "capabilities") return;
		await record("missing-device-no-access", async () => {
			const oldSession: ToolSession = {
				cwd: root,
				hasUI: true,
				settings: Settings.isolated({ "tools.approvalMode": "always-ask" }),
				getSessionFile: () => null,
				getSessionSpawns: () => null,
			};
			await createTools(oldSession, ["read", "write"]);
			requireProof(
				oldSession.xdev &&
					resolveXdevTool(oldSession.xdev, "aws_db") === undefined &&
					!oldSession.toolRegistry?.has("aws_db"),
			);
			requireProof(counts.providerScopes === 0 && counts.approvals === 0 && counts.guardSteps === 0);
		});
		await record("missing-execution-host-no-access", async () => {
			install({ request: inspection(), expectConnections: 0, expectReads: 0 });
			session.settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
			const beforeWorkers = counts.workers;
			const host = session.getToolExecutionCapabilities;
			session.getToolExecutionCapabilities = undefined;
			try {
				const result = await invoke(inspection());
				requireProof(
					result.failed &&
						result.code === "CAPABILITY_INCOMPATIBLE" &&
						counts.workers === beforeWorkers &&
						counts.approvals === 0 &&
						counts.providerScopes === 0 &&
						counts.guardSteps === 0,
				);
			} finally {
				session.getToolExecutionCapabilities = host;
			}
		});
		await record("incompatible-capability-no-access", async () => {
			install({ request: inspection(), expectConnections: 0, expectReads: 0 });
			session.settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
			const result = await invoke({ ...inspection(), capability: `sha256:${"0".repeat(64)}` });
			requireProof(
				result.failed &&
					result.code === "CAPABILITY_INCOMPATIBLE" &&
					counts.approvals === 0 &&
					counts.providerScopes === 0 &&
					counts.guardSteps === 0,
			);
		});
		await record("incompatible-worker-no-access", async () => {
			install(
				{ request: inspection(), expectConnections: 0, expectReads: 0 },
				{
					probeWorker: async () =>
						({ ...AWS_DB_CAPABILITY, protocol: "incompatible" }) as unknown as AwsDbCapability,
				},
			);
			session.settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
			const result = await invoke(inspection());
			requireProof(
				result.failed &&
					result.code === "CAPABILITY_INCOMPATIBLE" &&
					counts.approvals === 0 &&
					counts.providerScopes === 0 &&
					counts.guardSteps === 0,
			);
		});
		await record("public-fixture-arguments-denial", async () => {
			const request = inspection();
			install({ request, expectConnections: 0, expectReads: 0 });
			session.settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
			const result = await invoke({
				...request,
				fixture: { workerHost: "untrusted", tlsCa: "untrusted", query: "SELECT 1" },
			});
			requireProof(
				result.failed &&
					result.code === "INVALID_REQUEST" &&
					counts.approvals === 0 &&
					counts.providerScopes === 0 &&
					counts.guardSteps === 0,
			);
		});
		await record("native-policy-denial", async () => {
			install({ request: inspection(), expectConnections: 0, expectReads: 0 });
			session.settings = Settings.isolated({ "tools.approvalMode": "yolo", "tools.approval": { aws_db: "deny" } });
			requireProof((await invoke(inspection())).failed && counts.providerScopes === 0 && counts.approvals === 0);
		});
		const denyPlan = { request: inspection(), expectConnections: 0, expectReads: 0 } as const;
		await record("inner-policy-denial", async () => {
			install(denyPlan);
			session.settings = Settings.isolated({
				"tools.approvalMode": "yolo",
				"tools.approval": { "aws.rds.describe-db-instances": "deny" },
			});
			const result = await invoke(denyPlan.request);
			requireProof(result.failed && result.code === "POLICY_DENIED");
		});
		await record("guard-denial", async () => {
			const plan: WorkerPlan = {
				request: inspection(3306, "smoke-guard-deny"),
				expectConnections: 0,
				expectReads: 0,
			};
			install(plan);
			const result = await invoke(plan.request);
			requireProof(result.failed && result.code === "GUARD_DENIED");
		});
		const physical = async (
			name: string,
			options: Partial<WorkerPlan> = {},
			expectedCode?: AwsDbFailureCode,
		): Promise<void> => {
			await record(name, async () => {
				const request = inspection(
					await freeLoopbackPort(),
					name === "guard-mandatory-once-approval" ? "smoke-guard-ask" : "smoke",
				);
				const plan: WorkerPlan = { request, expectConnections: 1, expectReads: 1, ...options };
				install(plan);
				const beforeApprovals = counts.approvals;
				const beforeScopes = counts.providerScopes;
				const cancel = new AbortController();
				const abort = () => cancel.abort();
				if (plan.cancelAtRead) process.once("SIGUSR1", abort);
				let invocation: Invocation;
				try {
					invocation = await invoke(request, cancel.signal);
				} finally {
					process.off("SIGUSR1", abort);
				}
				const expectFailure = expectedCode !== undefined;
				requireProof(
					invocation.failed === expectFailure &&
						(!expectFailure || invocation.code === expectedCode) &&
						counts.providerScopes === beforeScopes + 1,
				);
				requireProof(counts.approvals > beforeApprovals);
				if (name === "guard-mandatory-once-approval") {
					requireProof(counts.approvals > beforeApprovals + 1);
					requireProof(
						choices
							.slice(beforeApprovals)
							.every(options => !options.some(option => /session|always/iu.test(option))),
					);
				}
				if (!expectFailure) {
					const response = nativeResponse(invocation.result);
					requireProof(response?.ok === true && isRecord(response.result));
					if (plan.source === "unsupported")
						requireProof(response.result.disposition === "withheld" && response.result.structure === undefined);
					else
						requireProof(
							response.result.disposition === "sanitized" && isSafeTemplateStructure(response.result.structure),
						);
				}
				counts.physicalConnectionsVerified++;
				counts.physicalSourceReadsVerified += plan.expectReads;
			});
		};
		await physical("guard-mandatory-once-approval");
		await record("missing-approval", async () => {
			const request = inspection();
			const native = install({ request, expectConnections: 0, expectReads: 0 });
			const beforeScopes = counts.providerScopes;
			const result = await native.execute("unapproved", request, undefined, undefined, context());
			observation.inspect(result);
			requireProof(
				result.isError === true &&
					nativeResponse(result)?.code === "APPROVAL_REQUIRED" &&
					counts.providerScopes === beforeScopes,
			);
		});
		await record("user-denial", async () => {
			install(denyPlan);
			choice = "deny";
			const beforeScopes = counts.providerScopes;
			requireProof((await invoke(inspection())).failed && counts.providerScopes === beforeScopes);
		});
		await record("changed-approved-arguments", async () => {
			const request = inspection();
			const native = install({ request, expectConnections: 0, expectReads: 0 });
			const beforeScopes = counts.providerScopes;
			requireProof(await native.prepareRuntimeApproval("changed-args", request, undefined, context()));
			native.approveRuntimeApproval("changed-args", request);
			const result = await native.execute(
				"changed-args",
				{ ...request, stepId: "17" },
				undefined,
				undefined,
				context(),
			);
			observation.inspect(result);
			requireProof(
				result.isError === true &&
					nativeResponse(result)?.code === "APPROVAL_REQUIRED" &&
					counts.providerScopes === beforeScopes,
			);
		});
		await record("changed-approval-session", async () => {
			const request = inspection();
			const native = install({ request, expectConnections: 0, expectReads: 0 });
			const beforeScopes = counts.providerScopes;
			requireProof(await native.prepareRuntimeApproval("changed-session", request, undefined, context()));
			native.approveRuntimeApproval("changed-session", request);
			sessionId = "aws-db-native-smoke-changed";
			for (const callback of [...sessionChanges]) callback();
			const result = await native.execute("changed-session", request, undefined, undefined, context());
			observation.inspect(result);
			requireProof(
				result.isError === true &&
					nativeResponse(result)?.code === "APPROVAL_REQUIRED" &&
					counts.providerScopes === beforeScopes,
			);
			sessionId = "aws-db-native-smoke";
			for (const callback of [...sessionChanges]) callback();
		});
		await record("consumed-approval-no-replay", async () => {
			const request = inspection(await freeLoopbackPort());
			const native = install({ request, expectConnections: 1, expectReads: 1 });
			requireProof(!(await invoke(request, undefined, "consume-once")).failed);
			const beforeScopes = counts.providerScopes;
			const result = await native.execute("consume-once", request, undefined, undefined, context());
			observation.inspect(result);
			requireProof(
				result.isError === true &&
					nativeResponse(result)?.code === "APPROVAL_REQUIRED" &&
					counts.providerScopes === beforeScopes,
			);
			counts.physicalConnectionsVerified++;
			counts.physicalSourceReadsVerified++;
		});
		for (const [name, failure, code] of [
			["identity-denial-before-secret", "identity", "IDENTITY_MISMATCH"],
			["tenant-denial-before-secret", "tenant", "RESOURCE_MISMATCH"],
			["resource-denial-before-secret", "resource", "RESOURCE_MISMATCH"],
			["secret-version-denial-before-read", "version", "SECRET_MISMATCH"],
		] as const) {
			await record(name, async () => {
				const plan: WorkerPlan = { request: inspection(), failure, expectConnections: 0, expectReads: 0 };
				install(plan);
				const result = await invoke(plan.request);
				requireProof(result.failed && result.code === code);
			});
		}
		await physical("physical-reader-bounded-source");
		await physical("unsupported-source-withheld", { source: "unsupported" });
		await physical("writable-node-denial", { fixture: { reader: "writable" }, expectReads: 0 }, "DB_READER_REQUIRED");
		await physical("promoted-node-denial", { fixture: { promotion: "during-read" } }, "DB_READER_REQUIRED");
		await physical("replaced-session-denial", { fixture: { replaceSession: true } }, "DB_IDENTITY_CHANGED");
		await physical("cancelled-physical-read", { fixture: { delay: "read" }, cancelAtRead: true }, "CANCELLED");
		await physical("timed-out-physical-read", { fixture: { delay: "read" } }, "TIMEOUT");
		await record("provider-error-withholding", async () => {
			const plan: WorkerPlan = {
				request: inspection(),
				failure: "provider-error",
				expectConnections: 0,
				expectReads: 0,
			};
			install(plan);
			const result = await invoke(plan.request);
			requireProof(result.failed && result.code === "AWS_FAILED");
		});
		await physical("physical-error-withholding", { fixture: { errorAt: 8 } }, "DB_READ_FAILED");
		requireProof(counts.workers > 0 && counts.workers === counts.exitedWorkers && !failedWorker);
		stdout(
			`${JSON.stringify({
				schema: "aws-db-native-smoke/v1",
				cases,
				counts,
				physical: {
					protocol: "synthetic-aurora-mysql-over-real-tls",
					dedicatedSocket: true,
					readerProof: true,
					sameConnection: true,
					authenticationVerified: true,
					allClosed: true,
					liveAws: false,
					hostedAurora: false,
				},
			})}\n`,
		);
	} finally {
		disposed = true;
		for (const callback of [...beginDispose]) callback();
		for (const callback of [...dispose].reverse()) await callback();
		beginDispose.clear();
		dispose.clear();
		sessionChanges.clear();
	}
}

if (import.meta.main) {
	try {
		if (process.argv[2] === "--worker-host") {
			const plan = workerHostPlanSchema.assert(JSON.parse(process.argv[3]!));
			const request = normalizeAwsDbRequest(plan.request);
			requireProof(request.action === "inspect-automation-template");
			await runWorkerHost({ ...plan, request });
		} else if (process.argv[2] === "--capabilities-only" || process.argv[2] === "--preflight-registry") {
			const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aws-db-native-preflight-"));
			try {
				await runSmoke(root, process.argv[2] === "--capabilities-only" ? "capabilities" : "missing");
			} finally {
				await fs.promises.rm(root, { recursive: true, force: true });
			}
		} else await runSmoke(process.argv[2]!, "full");
	} catch (error) {
		const code = error instanceof Error ? AWS_DB_FAILURE_CODES.find(code => code === error.message) : undefined;
		if (code) failureNativeCode = code;
		if (process.argv[2] !== "--worker-host")
			emitFixedOutput(
				`${JSON.stringify({ schema: "aws-db-native-smoke-failure/v1", case: failureCase, passed: false, stage: failureStage, code: failureNativeCode, workerCode: failureWorkerCode, checks: failureChecks })}\n`,
			);
		process.exitCode = 42;
	}
}
