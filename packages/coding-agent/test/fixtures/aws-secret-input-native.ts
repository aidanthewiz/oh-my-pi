import type * as NodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolContext, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getCleanupOwnedToolCallArgs } from "@oh-my-pi/pi-agent-core/agent-loop";
import { resolveToolCancellationBehavior } from "@oh-my-pi/pi-agent-core/tool-cancellation";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import { isRecord } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import type { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";
import { BUILTIN_TOOLS, createTools, type Tool, type ToolSession } from "../../src/tools";
import { AwsTool, type AwsSecretInputDependencies } from "../../src/tools/aws";
import {
	assertAwsSecretInputCapability,
	AWS_SECRET_INPUT_CAPABILITY,
	AWS_SECRET_INPUT_LIMITS,
	AWS_SECRET_INPUT_PROTOCOL,
	type AwsSecretInputFailureCode,
	type AwsSecretInputRequest,
	type AwsToolParams,
} from "../../src/tools/aws-secret-input-contract";
import { TOOL_EXECUTION_HOST_CAPABILITIES } from "../../src/tools/tool-execution-host";
import { resolveMountedXdevExecutable } from "../../src/tools/xdev";
import { cfgToolsApproval, cfgToolsApprovalMode } from "../../src/tools/settings";
import {
	awsSecretInputLifecycleLaunch,
	awsSecretInputLifecycleRequest,
	createAwsSecretInputLifecycleWorkerClient,
	cleanupAwsSecretInputLifecycleProcesses,
	type AwsSecretInputLifecycleWorkerScenario,
} from "./aws-secret-input-lifecycle-client";
import { createAwsSecretInputLifecycleControl } from "./aws-secret-input-lifecycle-control";
import { LIFECYCLE_STDERR, LIFECYCLE_STDOUT, lifecycleContainsSensitive } from "./aws-secret-input-lifecycle-values";
import {
	AWS_SECRET_INPUT_STARTUP_MARKER,
	awsSecretInputLifecycleStartupPreloadSource,
} from "./aws-secret-input-lifecycle-startup-preload";
import {
	isSupportedFiniteStdinDescriptor,
	isVerifiedFiniteStdinHandoff,
	isVerifiedStdinProducerWitness,
	type StdinPrivateChannelEvidence,
	type StdinProducerWitness,
} from "./aws-secret-input-stdin-metadata";

const FAILURE = "AWS_SECRET_INPUT_NATIVE_BOUNDARY_FAILED";
const emit = process.stdout.write.bind(process.stdout);
let activeCase = "setup";

export function requireNativeProof(value: unknown): asserts value {
	if (!value) throw new Error(FAILURE);
}

export function awsSecretInputNativeResponse(result: AgentToolResult<unknown>): Record<string, unknown> | undefined {
	if (!isRecord(result.details)) return undefined;
	const details =
		isRecord(result.details.xdev) && isRecord(result.details.xdev.inner) ? result.details.xdev.inner : result.details;
	return isRecord(details.response) ? details.response : undefined;
}

export function requireNativeFailure(
	result: AgentToolResult<unknown>,
	code: AwsSecretInputFailureCode,
	completion?: "uncertain",
): void {
	const expected = { ok: false, code, ...(completion === undefined ? {} : { completion }) };
	requireNativeProof(result.isError === true);
	requireNativeProof(Bun.deepEquals(awsSecretInputNativeResponse(result), expected));
	requireNativeProof(
		result.content.length === 1 &&
			result.content[0]?.type === "text" &&
			Bun.deepEquals(JSON.parse(result.content[0].text), expected),
	);
}

interface GuardReceipt {
	command: string;
	cwd: string;
	decision: "allow" | "deny" | "ask";
	reason: string;
}

async function readNativeGuardReceipts(root: string): Promise<GuardReceipt[]> {
	return (await fs.readFile(path.join(root, "guard-public.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as GuardReceipt);
}

export interface AwsSecretInputNativeTransportEvidence {
	stdinPrivateChannelVerified: true;
	stdinInputMode: "empty-eof" | "anonymous-channel";
	stdinPrivateChannel: StdinPrivateChannelEvidence;
	stdinProducerWitness: StdinProducerWitness;
	stdinPeerMetadataObserved: boolean;
	noControllingTty: true;
	workerPrivateCanaryClosed: true;
	measurableWorkerDescriptorsClosed: true;
	workerSocketIdentitiesCompared: boolean;
	measurableGuardianDescriptorsClosed: true | null;
	guardianSocketIdentitiesCompared: boolean | null;
	guardianFdSnapshotAvailable: boolean;
}

export function requireAwsSecretInputNativeTransport(
	input: unknown,
	spawned: unknown,
): AwsSecretInputNativeTransportEvidence {
	requireNativeProof(isRecord(input) && input.kind === "input-complete");
	requireNativeProof(isRecord(spawned));
	requireNativeProof(input.exactInput === true && input.eof === true);
	const stdinPrivateChannel = input.stdinPrivateChannel;
	const stdinProducerWitness = spawned.stdinProducerWitness;
	requireNativeProof(isSupportedFiniteStdinDescriptor(stdinPrivateChannel));
	requireNativeProof(isVerifiedStdinProducerWitness(stdinProducerWitness));
	requireNativeProof(isVerifiedFiniteStdinHandoff(stdinPrivateChannel, stdinProducerWitness, input, spawned));
	requireNativeProof(input.stdinIsRegularFile === false);
	requireNativeProof(input.stdinIsTTY === false && input.noControllingTty === true);
	requireNativeProof(input.argvClean === true && input.envClean === true);
	requireNativeProof(
		Bun.deepEquals(input.credentialEnv, []) && input.ipcAvailable === false && input.controlFdInherited === false,
	);
	requireNativeProof(Array.isArray(input.descriptors) && typeof input.socketIdentitiesAvailable === "boolean");
	requireNativeProof(input.descriptors.length <= 256 && input.descriptors.every(isRecord));
	requireNativeProof(isRecord(spawned) && Array.isArray(spawned.privateDescriptors));
	requireNativeProof(
		spawned.privateFdSnapshotAvailable === true &&
			spawned.privateDescriptors.length <= 256 &&
			spawned.privateDescriptors.every(isRecord),
	);
	requireNativeProof(typeof spawned.privateSocketIdentitiesAvailable === "boolean");
	requireNativeProof(spawned.guardianDescriptors === null || Array.isArray(spawned.guardianDescriptors));
	requireNativeProof(
		spawned.guardianDescriptors === null ||
			(spawned.guardianDescriptors.length <= 256 && spawned.guardianDescriptors.every(isRecord)),
	);
	requireNativeProof(
		spawned.guardianSocketIdentitiesAvailable === null ||
			typeof spawned.guardianSocketIdentitiesAvailable === "boolean",
	);
	requireNativeProof(spawned.guardianFdSnapshotAvailable === (spawned.guardianDescriptors !== null));
	requireNativeProof((spawned.guardianSocketIdentitiesAvailable === null) === (spawned.guardianDescriptors === null));
	const inherited = input.descriptors.filter(isRecord);
	const workerDescriptors = spawned.privateDescriptors.filter(isRecord);
	const canary = workerDescriptors.find(
		descriptor =>
			descriptor.kind === "file" &&
			typeof descriptor.target === "string" &&
			descriptor.target.endsWith("aws-secret-input-lifecycle-control-fd"),
	);
	requireNativeProof(
		canary &&
			canary.measurable === true &&
			typeof canary.dev === "string" &&
			typeof canary.ino === "string" &&
			canary.ino !== "0",
	);
	requireNativeProof(!inherited.some(descriptor => descriptor.dev === canary.dev && descriptor.ino === canary.ino));
	const workerSockets = input.socketIdentitiesAvailable && spawned.privateSocketIdentitiesAvailable;
	const guardianSockets =
		spawned.guardianDescriptors === null
			? null
			: input.socketIdentitiesAvailable && spawned.guardianSocketIdentitiesAvailable === true;
	const requireDisjoint = (descriptors: readonly unknown[], sockets: boolean): void => {
		const identities = descriptors
			.filter(isRecord)
			.filter(
				descriptor =>
					descriptor.measurable === true &&
					(descriptor.kind === "file" || descriptor.kind === "pipe" || (descriptor.kind === "socket" && sockets)),
			);
		requireNativeProof(
			!inherited.some(descriptor =>
				identities.some(privateFd => descriptor.dev === privateFd.dev && descriptor.ino === privateFd.ino),
			),
		);
	};
	requireDisjoint(workerDescriptors, workerSockets);
	if (spawned.guardianDescriptors !== null) requireDisjoint(spawned.guardianDescriptors, guardianSockets === true);
	if (process.platform === "linux") {
		requireNativeProof(workerSockets === true);
		requireNativeProof(guardianSockets === true);
	}
	return {
		stdinPrivateChannelVerified: true,
		stdinInputMode: stdinProducerWitness.inputWasEmpty ? "empty-eof" : "anonymous-channel",
		stdinPrivateChannel,
		stdinProducerWitness,
		stdinPeerMetadataObserved:
			stdinPrivateChannel.isSocket === true &&
			stdinPrivateChannel.peerSocketFamily === "unix" &&
			stdinPrivateChannel.peerAddress === "unnamed",
		noControllingTty: true,
		workerPrivateCanaryClosed: true,
		measurableWorkerDescriptorsClosed: true,
		workerSocketIdentitiesCompared: workerSockets,
		measurableGuardianDescriptorsClosed: spawned.guardianDescriptors === null ? null : true,
		guardianSocketIdentitiesCompared: guardianSockets,
		guardianFdSnapshotAvailable: spawned.guardianDescriptors !== null,
	};
}

export async function assertAwsSecretInputNativeFiles(root: string): Promise<void> {
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const filename = path.join(directory, entry.name);
			requireNativeProof(!lifecycleContainsSensitive(filename));
			if (entry.isDirectory()) await visit(filename);
			else if (entry.isFile()) {
				const stat = await fs.stat(filename);
				requireNativeProof(stat.size <= 8_388_608);
				requireNativeProof(!lifecycleContainsSensitive(await fs.readFile(filename)));
			} else if (entry.isSymbolicLink()) {
				requireNativeProof(!lifecycleContainsSensitive(await fs.readlink(filename)));
			} else throw new Error(FAILURE);
		}
	};
	await visit(root);
}

export function observeAwsSecretInputNativeSurfaces() {
	let clean = true;
	let unexpectedOutput = false;
	const inspect = (value: unknown): void => {
		if (lifecycleContainsSensitive(value)) clean = false;
	};
	const spawn = Bun.spawn;
	Bun.spawn = new Proxy(spawn, {
		apply(target, receiver, values) {
			inspect(values);
			const options = values[1] as { ipc?: (...args: unknown[]) => unknown } | undefined;
			if (options?.ipc) {
				values[1] = {
					...options,
					ipc: new Proxy(options.ipc, {
						apply(callback, context, messages) {
							inspect(messages);
							return Reflect.apply(callback, context, messages);
						},
					}),
				};
			}
			const child = Reflect.apply(target, receiver, values) as Bun.Subprocess;
			if (child.send) {
				child.send = new Proxy(child.send, {
					apply(send, context, messages) {
						inspect(messages);
						return Reflect.apply(send, context, messages);
					},
				});
			}
			return child;
		},
	});
	const restore: (() => void)[] = [
		() => {
			Bun.spawn = spawn;
		},
	];
	for (const name of ["log", "info", "warn", "error", "debug", "trace"] as const) {
		const original = console[name];
		console[name] = (...values: unknown[]) => {
			inspect(values);
			unexpectedOutput = true;
		};
		restore.push(() => {
			console[name] = original;
		});
	}
	for (const stream of [process.stdout, process.stderr]) {
		const original = stream.write;
		stream.write = new Proxy(original, {
			apply(_target, _receiver, values) {
				inspect(values);
				unexpectedOutput = true;
				const callback = values.find(value => typeof value === "function") as (() => void) | undefined;
				callback?.();
				return true;
			},
		});
		restore.push(() => {
			stream.write = original;
		});
	}
	return {
		inspect,
		get clean() {
			return clean && !unexpectedOutput;
		},
		restore() {
			for (const callback of restore.reverse()) callback();
		},
	};
}

async function withoutNetwork<T>(run: () => Promise<T>): Promise<T> {
	const originalFetch = globalThis.fetch;
	const originalConnect = Bun.connect;
	const originalSocketConnect = net.Socket.prototype.connect;
	let attempted = false;
	const deny = () => {
		attempted = true;
		throw new Error(FAILURE);
	};
	globalThis.fetch = new Proxy(originalFetch, { apply: deny });
	Bun.connect = new Proxy(originalConnect, { apply: deny });
	net.Socket.prototype.connect = new Proxy(originalSocketConnect, { apply: deny });
	try {
		const result = await run();
		requireNativeProof(!attempted);
		return result;
	} finally {
		globalThis.fetch = originalFetch;
		Bun.connect = originalConnect;
		net.Socket.prototype.connect = originalSocketConnect;
	}
}

function ordinarySecretValueRequest(request: AwsSecretInputRequest): AwsToolParams {
	const ordinary = { ...request };
	Reflect.deleteProperty(ordinary, "secretInput");
	requireNativeProof(!Object.hasOwn(ordinary, "secretInput"));
	return ordinary;
}

async function withoutOrdinaryAwsIo<T>(run: () => Promise<T>): Promise<T> {
	const filesystem = createRequire(import.meta.url)("node:fs") as typeof NodeFs;
	const promises = filesystem.promises;
	const calls = { filesystem: 0, process: 0, network: 0 };
	const restore: (() => void)[] = [];
	const block = (target: object, key: string, category: keyof typeof calls): void => {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		if (!descriptor || typeof descriptor.value !== "function") return;
		Object.defineProperty(target, key, {
			...descriptor,
			value: new Proxy(descriptor.value, {
				apply() {
					calls[category]++;
					throw new Error("AWS_SECRET_INPUT_ORDINARY_IO_FORBIDDEN");
				},
			}),
		});
		restore.push(() => {
			Object.defineProperty(target, key, descriptor);
		});
	};
	for (const name of [
		"readFile",
		"readFileSync",
		"open",
		"openSync",
		"read",
		"readSync",
		"createReadStream",
		"stat",
		"statSync",
		"lstat",
		"lstatSync",
		"readdir",
		"readdirSync",
		"readlink",
		"readlinkSync",
		"access",
		"accessSync",
		"existsSync",
		"realpath",
		"realpathSync",
		"writeFile",
		"writeFileSync",
		"appendFile",
		"appendFileSync",
		"mkdir",
		"mkdirSync",
		"mkdtemp",
		"mkdtempSync",
		"rm",
		"rmSync",
		"rename",
		"renameSync",
		"copyFile",
		"copyFileSync",
		"unlink",
		"unlinkSync",
	])
		block(filesystem, name, "filesystem");
	for (const name of [
		"readFile",
		"open",
		"stat",
		"lstat",
		"readdir",
		"readlink",
		"access",
		"realpath",
		"writeFile",
		"appendFile",
		"mkdir",
		"mkdtemp",
		"rm",
		"rename",
		"copyFile",
		"unlink",
	])
		block(promises, name, "filesystem");
	block(Bun, "spawn", "process");
	block(Bun, "spawnSync", "process");
	block(Bun, "which", "filesystem");
	block(Bun, "connect", "network");
	block(globalThis, "fetch", "network");
	block(net.Socket.prototype, "connect", "network");
	try {
		syncBuiltinESMExports();
		const result = await run();
		requireNativeProof(calls.filesystem === 0 && calls.process === 0 && calls.network === 0);
		return result;
	} finally {
		for (const undo of restore.reverse()) undo();
		syncBuiltinESMExports();
	}
}

export interface AwsSecretInputNativeSmoke {
	request: AwsSecretInputRequest;
	dependencies: Required<AwsSecretInputDependencies>;
}
export interface AwsSecretInputNativeReceipt extends AwsSecretInputNativeTransportEvidence {
	schema: "aws-secret-input-native/v1";
	cases: { name: string; passed: true }[];
	transport: "native-write-xdev-private-worker-finite-stdin";
	allWorkersReaped: true;
	publicSurfacesClean: true;
	ownedFilesClean: true;
	liveAws: false;
	networkAccess: "owned-loopback-only";
}

export function runAwsSecretInputNativeProbe(root: string): Promise<AwsSecretInputNativeReceipt>;
export function runAwsSecretInputNativeProbe(
	root: string,
	smoke: AwsSecretInputNativeSmoke,
): Promise<AgentToolResult<unknown>>;

export async function runAwsSecretInputNativeProbe(
	root: string,
	smoke?: AwsSecretInputNativeSmoke,
): Promise<AgentToolResult<unknown> | AwsSecretInputNativeReceipt> {
	requireNativeProof(path.isAbsolute(root));
	const observation = observeAwsSecretInputNativeSurfaces();
	const control = await createAwsSecretInputLifecycleControl();
	const workers: { child: Bun.Subprocess<"ignore", "ignore", "ignore">; exited: boolean; code?: number }[] = [];
	const ownedDirectories = new Set<string>();
	const beginDispose = new Set<() => void | Promise<void>>();
	const completeDispose = new Set<() => void | Promise<void>>();
	const sessionChanges = new Set<() => void | Promise<void>>();
	const choices: { title: string; options: string[] }[] = [];
	let disposed = false;
	let sessionId = "aws-secret-input-native";
	let choice: "approve" | "deny" = "approve";
	let runWorkers = 0;
	let artifactAllocations = 0;
	let receiverEvidence: AwsSecretInputNativeTransportEvidence | undefined;
	let executionWrite: AgentTool | undefined;
	let activeContext: AgentToolContext;
	const audits: unknown[] = [];
	const session: ToolSession = {
		cwd: root,
		hasUI: true,
		skipPythonPreflight: true,
		settings: Settings.isolated({ "tools.approvalMode": "yolo", "approval.notify": "off", "tools.xdev": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => sessionId,
		isDisposed: () => disposed,
		getToolByName: name => session.toolRegistry?.get(name),
		getToolContext: () => activeContext,
		registerDisposeCallback: (callback, options) => {
			const callbacks = options?.phase === "begin" ? beginDispose : completeDispose;
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
			if (
				disposed ||
				!sessionId ||
				!executionWrite ||
				session.toolRegistry?.get(tool.name) !== tool ||
				resolveToolCancellationBehavior(tool, args) !== "await-cleanup"
			)
				return undefined;
			const input = getCleanupOwnedToolCallArgs(executionWrite);
			if (!isRecord(input) || input.path !== "xd://aws" || typeof input.content !== "string") return undefined;
			try {
				if (!Bun.deepEquals(JSON.parse(input.content), args)) return undefined;
			} catch {
				return undefined;
			}
			const mounted = session.xdev && resolveMountedXdevExecutable(session.xdev, tool.name);
			const canonicalWrite = session.toolRegistry?.get("write");
			if (
				!mounted ||
				!canonicalWrite ||
				resolveToolCancellationBehavior(mounted, args) !== "await-cleanup" ||
				resolveToolCancellationBehavior(canonicalWrite, input) !== "await-cleanup" ||
				resolveToolCancellationBehavior(executionWrite, input) !== "await-cleanup"
			)
				return undefined;
			return TOOL_EXECUTION_HOST_CAPABILITIES;
		},
		allocateOutputArtifact: async (...values) => {
			artifactAllocations++;
			observation.inspect(values);
			throw new Error(FAILURE);
		},
		sessionManager: {
			appendCustomEntry: (...values: unknown[]) => {
				audits.push(values);
				observation.inspect(values);
				return "fixture-audit";
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
			observation.inspect([title, options]);
			choices.push({ title, options: [...options] });
			return choice === "deny" ? "Deny" : options.find(option => option === "Approve once" || option === "Approve");
		},
	};
	const modelRegistry = {
		authStorage: { credentials: { list: () => [] }, oauth: { accounts: () => [] }, sourceIdentity: undefined },
	};
	const context = (): AgentToolContext =>
		({
			settings: session.settings,
			hasUI: true,
			ui,
			sessionManager: { getCwd: () => root, getSessionId: () => sessionId, getSessionName: () => undefined },
			modelRegistry,
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
		runScoped: <T>(run: () => T): T => run(),
		getUIContext: () => ui,
	} as unknown as ExtensionRunner;
	const launch = awsSecretInputLifecycleLaunch(root);
	const install = (
		scenario: AwsSecretInputLifecycleWorkerScenario = "success",
		overrides: Partial<AwsSecretInputDependencies> = {},
		targetSession: ToolSession = session,
	) => {
		const client = createAwsSecretInputLifecycleWorkerClient({
			scenario,
			controlPort: control.port,
			withControlDescriptor: true,
			onMessage: observation.inspect,
			onSpawn: child => {
				const owned = { child, exited: false } as (typeof workers)[number];
				workers.push(owned);
				void child.exited.then(code => {
					owned.code = code;
					owned.exited = true;
				});
			},
			beforeDirectoryRemoval: async directory => {
				ownedDirectories.add(directory);
				await assertAwsSecretInputNativeFiles(directory);
			},
		});
		const native = new AwsTool(targetSession, undefined, {
			launch: () => launch,
			probeWorker: client.probeAwsSecretInputWorker,
			runWorker: async (...args) => {
				runWorkers++;
				const result = await client.runAwsSecretInputWorker(...args);
				observation.inspect(result);
				requireNativeProof(workers.every(worker => worker.exited && worker.code === 0));
				return result;
			},
			...overrides,
		});
		session.toolRegistry?.set("aws", native);
		return native;
	};
	const originalFactories = { ...BUILTIN_TOOLS };
	const cases: { name: string; passed: true }[] = [];
	const verifiedWorkers = new Set<(typeof workers)[number]>();
	let sequence = 0;
	const dispatchWrite = async (request: unknown, id: string) => {
		requireNativeProof(executionWrite);
		activeContext = context();
		const input = { path: "xd://aws", content: JSON.stringify(request) };
		observation.inspect(input);
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id, name: executionWrite.name, arguments: input }] },
				{ content: ["Native fixture turn complete"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, tools: [executionWrite] },
			streamFn: mock.stream,
			getToolContext: () => activeContext,
		});
		const outcome: { result?: AgentToolResult<unknown> } = {};
		const unsubscribe = agent.subscribe(event => {
			observation.inspect(event);
			if (event.type === "tool_execution_end" && event.toolCallId === id)
				outcome.result = { ...event.result, isError: event.isError === true };
		});
		try {
			await agent.prompt("Run the native fixture Write call");
			requireNativeProof(outcome.result);
			return outcome.result;
		} finally {
			unsubscribe();
		}
	};
	const atWriteExecution = async <T>(request: unknown, id: string, run: () => T | Promise<T>): Promise<T> => {
		requireNativeProof(executionWrite);
		const rootTool = executionWrite;
		const originalExecute = Object.getOwnPropertyDescriptor(rootTool, "execute");
		const checkpoint: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
		rootTool.execute = async () => {
			try {
				checkpoint.outcome = { ok: true, value: await run() };
			} catch (error) {
				checkpoint.outcome = { ok: false, error };
			}
			return { content: [{ type: "text", text: "Native fixture checkpoint complete" }], details: {} };
		};
		try {
			await dispatchWrite(request, id);
		} finally {
			if (originalExecute) Object.defineProperty(rootTool, "execute", originalExecute);
			else Reflect.deleteProperty(rootTool, "execute");
		}
		requireNativeProof(checkpoint.outcome);
		if (!checkpoint.outcome.ok) throw checkpoint.outcome.error;
		return checkpoint.outcome.value;
	};
	const invoke = async (request: unknown, id = `native-${++sequence}`) => {
		try {
			const result = await dispatchWrite(request, id);
			observation.inspect(result);
			const response = awsSecretInputNativeResponse(result);
			const code =
				response?.code ??
				(result.content.length === 1 && result.content[0]?.type === "text" ? result.content[0].text : undefined);
			return { failed: result.isError === true, result, error: undefined, code };
		} catch (error) {
			observation.inspect(error);
			return { failed: true, result: undefined, error, code: error instanceof Error ? error.message : undefined };
		}
	};
	const record = async (name: string, run: () => Promise<void>, expectsLoopbackReceipt = true) => {
		activeCase = name;
		choice = "approve";
		session.settings = Settings.isolated({
			"tools.approvalMode": "yolo",
			"approval.notify": "off",
			"tools.xdev": true,
		});
		activeContext = context();
		await run();
		requireNativeProof(observation.clean && artifactAllocations === 0);
		requireNativeProof(workers.every(worker => worker.exited && worker.code === 0));
		for (const worker of workers) {
			if (verifiedWorkers.has(worker)) continue;
			const done = await control.waitForEvent("worker-done", 20_000, event => event.pid === worker.child.pid);
			observation.inspect(done);
			requireNativeProof(
				done.cleanSurfaces === true && done.unexpectedOutput === false && done.retryDisabled === true,
			);
			requireNativeProof(
				done.filesReleased === true &&
					((done.inputsObserved === 0 && done.inputsReleased === null) ||
						(done.inputsObserved === 1 && done.inputsReleased === true)) &&
					done.responsesReleased === true &&
					done.credentialsReleased === true,
			);
			requireNativeProof(isRecord(done.counts) && (done.counts.consumer === 0 || done.counts.consumer === 1));
			if (done.counts.consumer === 1 && expectsLoopbackReceipt) {
				const spawned = await control.waitForEvent(
					"consumer-spawned",
					20_000,
					event => event.workerPid === worker.child.pid,
				);
				requireNativeProof(Number.isSafeInteger(spawned.pid) && spawned.groupId === spawned.pid);
				const ready = await control.waitForEvent("worker-ready", 20_000, event => event.pid === worker.child.pid);
				requireNativeProof(ready.ipcAvailable === true && ready.controlFdPresent === true);
				const input = await control.waitForEvent(
					"input-complete",
					20_000,
					event => event.parentPid === spawned.pid,
				);
				requireNativeProof(spawned.receiverPid === null || spawned.receiverPid === input.pid);
				requireNativeProof(Array.isArray(spawned.privateDescriptors));
				requireNativeProof(spawned.guardianFdSnapshotAvailable === (process.platform === "linux"));
				requireNativeProof(
					process.platform === "linux"
						? Array.isArray(spawned.guardianDescriptors)
						: spawned.guardianDescriptors === null,
				);
				receiverEvidence = requireAwsSecretInputNativeTransport(input, spawned);
			}
			if (runWorkers === 0) {
				requireNativeProof(
					isRecord(done.counts) &&
						done.counts.files === 0 &&
						done.counts.clients === 0 &&
						done.counts.identity === 0 &&
						done.counts.secret === 0 &&
						done.counts.consumer === 0,
				);
			}
			verifiedWorkers.add(worker);
		}
		requireNativeProof(control.clean);
		await assertAwsSecretInputNativeFiles(root);
		for (const directory of ownedDirectories) {
			let missing = false;
			try {
				await fs.lstat(directory);
			} catch (error) {
				missing = !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
			}
			requireNativeProof(missing);
		}
		cases.push({ name, passed: true });
	};
	try {
		BUILTIN_TOOLS.aws = () => install();
		let tools: Tool[];
		try {
			for (const name of Object.keys(BUILTIN_TOOLS) as (keyof typeof BUILTIN_TOOLS)[]) {
				if (name !== "aws" && name !== "read" && name !== "write") BUILTIN_TOOLS[name] = () => null;
			}
			tools = await createTools(session);
		} finally {
			Object.assign(BUILTIN_TOOLS, originalFactories);
		}
		requireNativeProof(session.xdev);
		requireNativeProof(session.xdev.mountedNames.has("aws") && session.toolRegistry);
		session.xdev.decorateExecution = tool =>
			new ExtensionToolWrapper(tool as unknown as AgentTool, runner) as unknown as Tool;
		const canonicalWrite = tools.find(tool => tool.name === "write");
		const read = tools.find(tool => tool.name === "read");
		requireNativeProof(canonicalWrite && read);
		executionWrite = new ExtensionToolWrapper(canonicalWrite as unknown as AgentTool, runner);
		let native = install();
		if (smoke) {
			native = install("success", smoke.dependencies);
			const invocation = await invoke(smoke.request, "standalone-smoke");
			requireNativeProof(invocation.result);
			const response = awsSecretInputNativeResponse(invocation.result);
			requireNativeProof(response?.ok === true && isRecord(response.result) && isRecord(response.result.teardown));
			requireNativeProof(
				response.result.teardown.consumerReaped === true && response.result.teardown.workerReaped === true,
			);
			requireNativeProof(choices.length === 1 && Bun.deepEquals(choices[0]?.options, ["Deny", "Approve once"]));
			requireNativeProof(observation.clean && artifactAllocations === 0);
			await assertAwsSecretInputNativeFiles(root);
			return invocation.result;
		}
		await record("schema-before-access", async () => {
			const approvals = choices.length;
			const spawned = workers.length;
			const result = await withoutNetwork(() =>
				read.execute("schema", { path: "xd://aws/schema" }, undefined, observation.inspect, context()),
			);
			observation.inspect(result);
			requireNativeProof(
				!result.isError &&
					isRecord(result.details) &&
					result.details.shape === "value" &&
					result.details.contentType === "application/json",
			);
			const text = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			const discovery: unknown = JSON.parse(text);
			requireNativeProof(isRecord(discovery) && discovery.name === "aws" && isRecord(discovery.inputSchema));
			const schema = discovery.inputSchema;
			const fullRequest = structuredClone(awsSecretInputLifecycleRequest(root));
			fullRequest.secretInput.jsonPointer = "/config~1name/~0literal/0";
			fullRequest.secretInput.appendNewline = true;
			for (const accepted of [
				{ action: "secret-input-capabilities", protocol: AWS_SECRET_INPUT_PROTOCOL },
				{
					profile: "fixture",
					region: "us-east-1",
					service: "ec2",
					operation: "describe-instances",
					parameters: {},
				},
				fullRequest,
			])
				requireNativeProof(validateJsonSchemaValue(schema, accepted).success);
			for (const rejected of [
				{ action: "capabilities" },
				{ action: "inspect-automation-template", agencyId: "7" },
				{ ...fullRequest, provider: { factory: "untrusted" } },
				{ ...fullRequest, secretInput: { ...fullRequest.secretInput, stdin: "public-untrusted-input" } },
				{
					...fullRequest,
					secretInput: {
						...fullRequest.secretInput,
						consumer: { ...fullRequest.secretInput.consumer, env: { AWS_PROFILE: "untrusted" } },
					},
				},
				{
					...fullRequest,
					secretInput: { ...fullRequest.secretInput, expectedIdentity: { account: "123456789012" } },
				},
			])
				requireNativeProof(!validateJsonSchemaValue(schema, rejected).success);
			requireNativeProof(choices.length === approvals && runWorkers === 0 && workers.length === spawned);
		});
		await record("capability-before-access", async () => {
			const approvals = choices.length;
			const capability = await withoutNetwork(() =>
				invoke({ action: "secret-input-capabilities", protocol: AWS_SECRET_INPUT_PROTOCOL }),
			);
			requireNativeProof(!capability.failed && capability.result);
			assertAwsSecretInputCapability(awsSecretInputNativeResponse(capability.result));
			requireNativeProof(choices.length === approvals && runWorkers === 0 && workers.length > 0);
		});
		await record("host-admission-before-approval", async () => {
			const host = session.getToolExecutionCapabilities;
			const approvals = choices.length;
			const spawned = workers.length;
			session.getToolExecutionCapabilities = undefined;
			try {
				const invocation = await invoke(awsSecretInputLifecycleRequest(root));
				requireNativeProof(invocation.failed && invocation.code === "CAPABILITY_INCOMPATIBLE");
				requireNativeProof(choices.length === approvals && runWorkers === 0 && workers.length === spawned);
			} finally {
				session.getToolExecutionCapabilities = host;
			}
		});
		await record("worker-admission-before-approval", async () => {
			const staleDeliveryCapability = {
				...AWS_SECRET_INPUT_CAPABILITY,
				capability: "sha256:bac95b8ce6d793c137902275a7fc42ea4970babd0d73788f34e15529750bca12",
				manifest: {
					...AWS_SECRET_INPUT_CAPABILITY.manifest,
					deliveryPolicy: "finite-stdin-owned-process-group/v2",
				},
			};
			for (const capability of [
				{ ...AWS_SECRET_INPUT_CAPABILITY, protocol: "old-worker" },
				staleDeliveryCapability,
				{ ...staleDeliveryCapability, capability: AWS_SECRET_INPUT_CAPABILITY.capability },
				{ ...staleDeliveryCapability, manifest: AWS_SECRET_INPUT_CAPABILITY.manifest },
			]) {
				native = install("success", {
					probeWorker: async () => capability as unknown as typeof AWS_SECRET_INPUT_CAPABILITY,
				});
				const approvals = choices.length;
				const invocation = await invoke(awsSecretInputLifecycleRequest(root));
				requireNativeProof(invocation.failed && invocation.code === "CAPABILITY_INCOMPATIBLE");
				requireNativeProof(choices.length === approvals && runWorkers === 0);
			}
		});
		await record("capability-mismatch-before-approval", async () => {
			native = install();
			const request = structuredClone(awsSecretInputLifecycleRequest(root));
			request.secretInput.capability = `sha256:${"0".repeat(64)}`;
			const approvals = choices.length;
			const invocation = await invoke(request);
			requireNativeProof(invocation.failed && invocation.code === "CAPABILITY_INCOMPATIBLE");
			requireNativeProof(choices.length === approvals && runWorkers === 0);
		});
		await record("user-denial-before-delivery", async () => {
			native = install();
			choice = "deny";
			const approvals = choices.length;
			const request = awsSecretInputLifecycleRequest(root);
			const invocation = await invoke(request, "denied");
			requireNativeProof(invocation.failed && choices.length === approvals + 1 && runWorkers === 0);
			await atWriteExecution(request, "denied", async () => {
				requireNativeFailure(await native.execute("denied", request), "APPROVAL_REQUIRED");
			});
		});
		for (const [name, policy] of [
			["aws-policy-denial", { "aws.secretsmanager.get-secret-value": "deny" }],
			["identity-policy-denial", { "aws.sts.get-caller-identity": "deny" }],
			["consumer-policy-denial", { bash: "deny" }],
			["consumer-exec-policy-denial", { exec: "deny" }],
		] as const) {
			await record(name, async () => {
				native = install();
				session.settings = Settings.isolated({ "tools.approvalMode": "yolo", "tools.approval": policy });
				const approvals = choices.length;
				const invocation = await invoke(awsSecretInputLifecycleRequest(root));
				requireNativeProof(invocation.failed && choices.length === approvals && runWorkers === 0);
			});
		}
		for (const kind of ["aws", "consumer"] as const) {
			await record(`${kind}-guard-denial`, async () => {
				native = install();
				const request = structuredClone(awsSecretInputLifecycleRequest(root));
				if (kind === "aws") request.profile = "aws-secret-input-guard-deny";
				else request.secretInput.consumer.argv.push("consumer-secret-input-guard-deny");
				const approvals = choices.length;
				const invocation = await invoke(request);
				requireNativeProof(invocation.failed && invocation.code === "GUARD_DENIED");
				requireNativeProof(choices.length === approvals && runWorkers === 0);
			});
		}
		await record("combined-one-use-approval", async () => {
			native = install();
			const request = structuredClone(awsSecretInputLifecycleRequest(root, "success", control.port));
			request.secretInput.consumer.argv.push("consumer-secret-input-guard-ask");
			const approvals = choices.length;
			const guardsBefore = (await readNativeGuardReceipts(root)).length;
			const invocation = await invoke(request, "consume-once");
			requireNativeProof(
				!invocation.failed && invocation.result && awsSecretInputNativeResponse(invocation.result)?.ok === true,
			);
			requireNativeProof(choices.length === approvals + 1 && runWorkers === 1);
			requireNativeProof(Bun.deepEquals(choices.at(-1)?.options, ["Deny", "Approve once"]));
			const displayedRequests = (choices.at(-1)?.title ?? "").split("\n").flatMap(line => {
				const start = line.indexOf("{");
				if (start < 0) return [];
				try {
					return [JSON.parse(line.slice(start)) as unknown];
				} catch {
					return [];
				}
			});
			requireNativeProof(displayedRequests.some(displayed => Bun.deepEquals(displayed, request)));
			const visibleNumbers = new Set((choices.at(-1)?.title ?? "").match(/\d+/gu));
			for (const value of [
				AWS_SECRET_INPUT_LIMITS.maxInputBytes,
				AWS_SECRET_INPUT_LIMITS.maxStdoutBytes,
				AWS_SECRET_INPUT_LIMITS.maxStderrBytes,
				request.timeout! * 1_000,
			])
				requireNativeProof(visibleNumbers.has(String(value)));
			const guarded = (await readNativeGuardReceipts(root)).slice(guardsBefore);
			const title = choices.at(-1)?.title ?? "";
			requireNativeProof(
				guarded.some(guard => guard.command.includes("sts") && guard.command.includes("get-caller-identity")),
			);
			requireNativeProof(
				guarded.some(
					guard => guard.command.includes("secretsmanager") && guard.command.includes("get-secret-value"),
				),
			);
			requireNativeProof(guarded.some(guard => guard.decision === "ask"));
			for (const guard of guarded) {
				requireNativeProof(title.includes(guard.command) && title.includes(guard.cwd));
				if (guard.decision === "ask") requireNativeProof(title.includes(guard.reason));
			}
			await atWriteExecution(request, "consume-once", async () => {
				requireNativeFailure(await native.execute("consume-once", request), "APPROVAL_REQUIRED");
			});
			requireNativeProof(runWorkers === 1);
		});
		await record("immutable-approved-request", async () => {
			await fs.mkdir(path.join(root, "alternate-cwd"));
			const changes: ((request: AwsSecretInputRequest) => void)[] = [
				request => {
					request.profile = "other-profile";
				},
				request => {
					request.parameters.SecretId = request.parameters.SecretId.replace("generic-input", "other-input");
				},
				request => {
					request.parameters.VersionId = "22222222-2222-4222-8222-222222222222";
				},
				request => {
					request.parameters.VersionStage = "AWSPREVIOUS";
				},
				request => {
					request.region = "us-west-2";
					request.parameters.SecretId = request.parameters.SecretId.replace("us-east-1", "us-west-2");
				},
				request => {
					request.secretInput.expectedIdentity.arn = "arn:aws:iam::123456789012:user/other-principal";
				},
				request => {
					request.secretInput.jsonPointer = "/other-leaf";
				},
				request => {
					request.secretInput.appendNewline = true;
				},
				request => {
					request.secretInput.consumer.argv.push("other-public-argument");
				},
				request => {
					request.secretInput.consumer.cwd = path.join(root, "alternate-cwd");
				},
				request => {
					request.timeout = 13;
				},
			];
			for (const [index, change] of changes.entries()) {
				const request = structuredClone(awsSecretInputLifecycleRequest(root));
				const id = `immutable-${index}`;
				await atWriteExecution(request, id, async () => {
					const approval = await native.prepareRuntimeApproval(id, request, undefined, context());
					requireNativeProof(approval?.allowSessionApproval === false);
					native.approveRuntimeApproval(id, request);
				});
				change(request);
				await atWriteExecution(request, id, async () => {
					requireNativeFailure(
						await native.execute(id, request, undefined, observation.inspect, context()),
						"APPROVAL_REQUIRED",
					);
				});
			}
			requireNativeProof(runWorkers === 1);
		});
		await record("changed-settings-reject-grant", async () => {
			const request = awsSecretInputLifecycleRequest(root);
			await atWriteExecution(request, "settings", async () => {
				requireNativeProof(await native.prepareRuntimeApproval("settings", request, undefined, context()));
				native.approveRuntimeApproval("settings", request);
				cfgToolsApprovalMode.set(session.settings, "always-ask");
				requireNativeFailure(
					await native.execute("settings", request, undefined, observation.inspect, context()),
					"APPROVAL_REQUIRED",
				);
			});
			requireNativeProof(runWorkers === 1);
		});
		await record("changed-session-reject-grant", async () => {
			const request = awsSecretInputLifecycleRequest(root);
			await atWriteExecution(request, "session", async () => {
				requireNativeProof(await native.prepareRuntimeApproval("session", request, undefined, context()));
				native.approveRuntimeApproval("session", request);
				sessionId = "aws-secret-input-native-next";
				for (const callback of Array.from(sessionChanges)) callback();
				sessionId = "aws-secret-input-native";
				for (const callback of Array.from(sessionChanges)) callback();
				requireNativeFailure(
					await native.execute("session", request, undefined, observation.inspect, context()),
					"APPROVAL_REQUIRED",
				);
			});
			requireNativeProof(runWorkers === 1);
		});
		await record("changed-host-cwd-reject-grant", async () => {
			const request = awsSecretInputLifecycleRequest(root);
			await atWriteExecution(request, "host-cwd", async () => {
				requireNativeProof(await native.prepareRuntimeApproval("host-cwd", request, undefined, context()));
				native.approveRuntimeApproval("host-cwd", request);
				const originalCwd = session.cwd;
				const beforeWorkers = workers.length;
				session.cwd = path.join(root, "alternate-cwd");
				try {
					requireNativeFailure(
						await native.execute("host-cwd", request, undefined, observation.inspect, context()),
						"APPROVAL_REQUIRED",
					);
					requireNativeProof(runWorkers === 1 && workers.length === beforeWorkers);
				} finally {
					session.cwd = originalCwd;
				}
			});
		});
		await record("raw-consumer-output", async () => {
			native = install();
			const request = structuredClone(awsSecretInputLifecycleRequest(root, "write", control.port));
			request.secretInput.consumer.argv.push("public args spaces 'quote' $(not-run); *");
			const invocation = await invoke(request);
			requireNativeProof(invocation.failed && invocation.result);
			const response = awsSecretInputNativeResponse(invocation.result);
			requireNativeProof(response?.ok === true && isRecord(response.result));
			requireNativeProof(
				Bun.deepEquals(response.result, {
					stdout: LIFECYCLE_STDOUT,
					stderr: LIFECYCLE_STDERR,
					exitCode: 7,
					signal: null,
					timedOut: false,
					cancelled: false,
					stdoutTruncated: false,
					stderrTruncated: false,
					completion: "exited",
					teardown: { consumerReaped: true, workerReaped: true, referencesReleased: true },
				}),
			);
			requireNativeProof(
				response.capability === AWS_SECRET_INPUT_CAPABILITY.capability &&
					Bun.deepEquals(response.limits, AWS_SECRET_INPUT_LIMITS),
			);
			requireNativeProof(
				(await fs.readFile(path.join(root, "aws-secret-input-lifecycle-committed"), "utf8")) ===
					"public committed action\n",
			);
			const guards = await readNativeGuardReceipts(root);
			const command = request.secretInput.consumer.argv.map(arg => `'${arg.replace(/'/gu, "'\\''")}'`).join(" ");
			requireNativeProof(
				guards.some(guard => guard.command === command && guard.cwd === request.secretInput.consumer.cwd),
			);
			requireNativeProof(runWorkers === 2);
		});
		await record("fixed-provider-failure", async () => {
			native = install("provider-error");
			const invocation = await invoke(awsSecretInputLifecycleRequest(root));
			requireNativeProof(invocation.failed && invocation.result);
			requireNativeFailure(invocation.result, "AWS_FAILED", "uncertain");
			requireNativeProof(runWorkers === 3);
		});
		await record("no-session-one-use-approval", async () => {
			const noSession: ToolSession = { ...session, getSessionId: () => null, sessionManager: undefined };
			native = install("success", {}, noSession);
			native.sessionApproval.approve();
			const request = awsSecretInputLifecycleRequest(root, "success", control.port);
			const before = runWorkers;
			await atWriteExecution(request, "no-session-once", async () => {
				requireNativeFailure(await native.execute("ordinary-session-grant", request), "APPROVAL_REQUIRED");
				const approval = await native.prepareRuntimeApproval("no-session-once", request, undefined, context());
				requireNativeProof(approval?.allowSessionApproval === false);
				native.approveRuntimeApproval("no-session-once", request);
				const result = await native.execute("no-session-once", request, undefined, observation.inspect, context());
				observation.inspect(result);
				requireNativeProof(
					!result.isError && awsSecretInputNativeResponse(result)?.ok === true && runWorkers === before + 1,
				);
				requireNativeFailure(await native.execute("no-session-once", request), "APPROVAL_REQUIRED");
				requireNativeFailure(await native.execute("no-session-fresh", request), "APPROVAL_REQUIRED");
				requireNativeProof(runWorkers === before + 1);
			});
		});
		await record("completed-secret-input-cannot-downgrade", async () => {
			native = install();
			native.sessionApproval.approve();
			const request = awsSecretInputLifecycleRequest(root, "success", control.port);
			const completed = await atWriteExecution(request, "completed-protected-once", async () => {
				requireNativeProof(
					await native.prepareRuntimeApproval("completed-protected-once", request, undefined, context()),
				);
				native.approveRuntimeApproval("completed-protected-once", request);
				return native.execute("completed-protected-once", request, undefined, observation.inspect, context());
			});
			observation.inspect(completed);
			requireNativeProof(!completed.isError && awsSecretInputNativeResponse(completed)?.ok === true);
			const ordinary = ordinarySecretValueRequest(request);
			const beforeWorkers = workers.length;
			const beforeRuns = runWorkers;
			const beforePrompts = choices.length;
			await withoutOrdinaryAwsIo(async () => {
				const result = await native.execute(
					"completed-protected-once",
					ordinary,
					undefined,
					observation.inspect,
					context(),
				);
				observation.inspect(result);
				requireNativeFailure(result, "APPROVAL_REQUIRED");
			});
			requireNativeProof(
				workers.length === beforeWorkers && runWorkers === beforeRuns && choices.length === beforePrompts,
			);
		});
		await record("prepared-secret-input-cannot-downgrade", async () => {
			native = install();
			native.sessionApproval.approve();
			for (const phase of ["execute", "prepare", "approve", "deny"] as const) {
				const id = `strip-secret-input-${phase}`;
				const request = awsSecretInputLifecycleRequest(root);
				await atWriteExecution(request, id, async () => {
					requireNativeProof(await native.prepareRuntimeApproval(id, request, undefined, context()));
					native.approveRuntimeApproval(id, request);
					if (phase === "deny") native.denyRuntimeApproval(id, request);
				});
				const ordinary = ordinarySecretValueRequest(request);
				const beforeWorkers = workers.length;
				const beforeRuns = runWorkers;
				const beforePrompts = choices.length;
				await withoutOrdinaryAwsIo(async () => {
					if (phase === "prepare") {
						let rejected = false;
						try {
							await native.prepareRuntimeApproval(id, ordinary, undefined, context());
						} catch (error) {
							observation.inspect(error);
							rejected = error instanceof Error && error.message === "APPROVAL_REQUIRED";
						}
						requireNativeProof(rejected);
					}
					if (phase === "approve") native.approveRuntimeApproval(id, ordinary);
					const result = await native.execute(id, ordinary, undefined, observation.inspect, context());
					observation.inspect(result);
					requireNativeFailure(result, "APPROVAL_REQUIRED");
				});
				requireNativeProof(
					workers.length === beforeWorkers && runWorkers === beforeRuns && choices.length === beforePrompts,
				);
			}
		});
		await record("capability-call-cannot-downgrade", async () => {
			native = install();
			native.sessionApproval.approve();
			const capability = { action: "secret-input-capabilities", protocol: AWS_SECRET_INPUT_PROTOCOL } as const;
			const targets: [string, AwsToolParams][] = [
				[
					"identity",
					{
						profile: "fixture",
						region: "us-east-1",
						service: "sts",
						operation: "get-caller-identity",
						parameters: {},
					},
				],
				["secret", ordinarySecretValueRequest(awsSecretInputLifecycleRequest(root))],
			];
			for (const [target, request] of targets) {
				for (const phase of ["prepared", "completed", "denied"] as const) {
					const id = `replace-capability-${target}-${phase}`;
					await atWriteExecution(capability, id, async () => {
						if (phase === "completed") {
							const result = await native.execute(id, capability, undefined, observation.inspect, context());
							observation.inspect(result);
							requireNativeProof(!result.isError);
							assertAwsSecretInputCapability(awsSecretInputNativeResponse(result));
						} else {
							requireNativeProof(
								(await native.prepareRuntimeApproval(id, capability, undefined, context())) === undefined,
							);
							if (phase === "denied") native.denyRuntimeApproval(id, capability);
						}
					});
					const ordinary = { ...capability, ...request };
					Reflect.deleteProperty(ordinary, "action");
					Reflect.deleteProperty(ordinary, "protocol");
					requireNativeProof(!Object.hasOwn(ordinary, "action") && !Object.hasOwn(ordinary, "protocol"));
					const beforeWorkers = workers.length;
					const beforeRuns = runWorkers;
					const beforePrompts = choices.length;
					await withoutOrdinaryAwsIo(async () => {
						const result = await native.execute(id, ordinary, undefined, observation.inspect, context());
						observation.inspect(result);
						requireNativeFailure(result, "APPROVAL_REQUIRED");
						let rejected = false;
						try {
							await native.prepareRuntimeApproval(id, ordinary, undefined, context());
						} catch (error) {
							observation.inspect(error);
							rejected = error instanceof Error && error.message === "APPROVAL_REQUIRED";
						}
						requireNativeProof(rejected);
						native.approveRuntimeApproval(id, ordinary);
						requireNativeFailure(
							await native.execute(id, ordinary, undefined, observation.inspect, context()),
							"APPROVAL_REQUIRED",
						);
					});
					requireNativeProof(
						workers.length === beforeWorkers && runWorkers === beforeRuns && choices.length === beforePrompts,
					);
				}
			}
		});
		for (const location of ["project", "global"] as const) {
			await record(
				`${location}-bun-preload-cannot-intercept-non-bun-receiver`,
				async () => {
					const directory = path.join(root, `${location}-preload-receiver`);
					await fs.mkdir(directory);
					const approvedCwd = await fs.realpath(directory);
					const marker = path.join(approvedCwd, AWS_SECRET_INPUT_STARTUP_MARKER);
					if (location === "project") {
						await fs.writeFile(
							path.join(approvedCwd, "startup-preload.ts"),
							awsSecretInputLifecycleStartupPreloadSource(marker),
						);
						await fs.writeFile(path.join(approvedCwd, "bunfig.toml"), 'preload = ["./startup-preload.ts"]\n');
					}
					native = install(location === "global" ? "global-bun-preload" : "success");
					const request = structuredClone(awsSecretInputLifecycleRequest(root, "success", control.port));
					request.secretInput.consumer = {
						argv: ["/bin/sh", path.resolve(import.meta.dir, "aws-secret-input-native-receiver.sh"), approvedCwd],
						cwd: approvedCwd,
					};
					const beforeRuns = runWorkers;
					const beforeWorkers = workers.length;
					const invocation = await invoke(request);
					requireNativeProof(!invocation.failed && invocation.result);
					const response = awsSecretInputNativeResponse(invocation.result);
					requireNativeProof(response?.ok === true && isRecord(response.result));
					requireNativeProof(
						response.result.stdout === '{"inputMatched":true,"cwdMatched":true}\n' &&
							response.result.stderr === "" &&
							response.result.exitCode === 0 &&
							response.result.completion === "exited" &&
							response.result.timedOut === false &&
							response.result.cancelled === false &&
							response.result.stdoutTruncated === false &&
							response.result.stderrTruncated === false &&
							isRecord(response.result.teardown) &&
							response.result.teardown.consumerReaped === true &&
							response.result.teardown.workerReaped === true &&
							response.result.teardown.referencesReleased === true,
					);
					requireNativeProof(runWorkers === beforeRuns + 1);
					let markerAbsent = false;
					try {
						await fs.lstat(marker);
					} catch (error) {
						markerAbsent = !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
					}
					requireNativeProof(markerAbsent);
					if (location === "global") {
						const probe = await control.waitForEvent("global-preload-probe", 20_000, event =>
							workers.slice(beforeWorkers).some(worker => worker.child.pid === event.pid),
						);
						requireNativeProof(probe.executed === false);
					}
				},
				false,
			);
		}
		for (const [phase, mutations] of [
			["secret", ["bash", "exec", "replacement"]],
			["identity", ["aws", "replacement"]],
		] as const) {
			for (const mutation of mutations) {
				await record(`paused-${phase}-${mutation}-revokes-live-authority`, async () => {
					native = install(phase === "secret" ? "paused-secret" : "paused-identity");
					const beforeRuns = runWorkers;
					const beforeWorkers = workers.length;
					const beforePrompts = choices.length;
					const capturedSettings = session.settings;
					const capturedSessionId = sessionId;
					const pending = control.waitForEvent(`${phase}-response-pending`, 20_000, event =>
						workers.slice(beforeWorkers).some(worker => worker.child.pid === event.pid),
					);
					void pending.catch(() => {});
					const active = invoke(awsSecretInputLifecycleRequest(root, "success", control.port));
					try {
						const paused = await Promise.race([
							pending,
							active.then(() => {
								throw new Error(FAILURE);
							}),
						]);
						requireNativeProof(runWorkers === beforeRuns + 1 && choices.length === beforePrompts + 1);
						const workersAtPause = workers.length;
						if (mutation === "replacement") {
							const replacement = Settings.isolated({
								"tools.approvalMode": "yolo",
								"approval.notify": "off",
								"tools.xdev": true,
							});
							requireNativeProof(
								replacement !== capturedSettings &&
									replacement.revision === capturedSettings.revision &&
									Bun.deepEquals(cfgToolsApproval.get(replacement), cfgToolsApproval.get(capturedSettings)),
							);
							session.settings = replacement;
							activeContext = { ...activeContext, settings: replacement };
						} else {
							const policy = mutation === "aws" ? "aws.secretsmanager.get-secret-value" : mutation;
							cfgToolsApproval.set(capturedSettings, { [policy]: "deny" });
						}
						requireNativeProof(sessionId === capturedSessionId && session.cwd === root);
						control.send(`release-${phase}-response`);
						const invocation = await active;
						requireNativeProof(invocation.failed && invocation.result);
						requireNativeFailure(invocation.result, "APPROVAL_REQUIRED", "uncertain");
						const done = await control.waitForEvent("worker-done", 20_000, event => event.pid === paused.pid);
						requireNativeProof(
							isRecord(done.counts) &&
								done.counts.identity === 1 &&
								done.counts.secret === (phase === "secret" ? 1 : 0) &&
								done.counts.consumer === 0 &&
								done.counts.destroyed === done.counts.clients &&
								done.realConsumer === false,
						);
						requireNativeProof(
							done.inputsObserved === 0 &&
								done.inputsReleased === null &&
								done.responsesObserved === (phase === "secret" ? 1 : 0) &&
								done.responsesReleased === true &&
								done.credentialsReleased === true &&
								done.filesReleased === true,
						);
						requireNativeProof(
							!control.events.some(
								event => event.kind === "consumer-spawned" && event.workerPid === paused.pid,
							) &&
								runWorkers === beforeRuns + 1 &&
								workers.length === workersAtPause &&
								choices.length === beforePrompts + 1,
						);
					} finally {
						control.send(`release-${phase}-response`);
						await active;
					}
				});
			}
		}
		await record("cross-account-secret-binds-approved-resource", async () => {
			native = install();
			native.sessionApproval.approve();
			const request = structuredClone(awsSecretInputLifecycleRequest(root, "success", control.port));
			request.parameters.SecretId = request.parameters.SecretId.replace(":123456789012:", ":210987654321:");
			const approvedArn = request.parameters.SecretId;
			const version = request.parameters.VersionId;
			requireNativeProof(
				request.secretInput.expectedIdentity.account === "123456789012" &&
					approvedArn.includes(":210987654321:") &&
					typeof version === "string",
			);
			const beforeRuns = runWorkers;
			const beforePrompts = choices.length;
			const beforeGuards = (await readNativeGuardReceipts(root)).length;
			const invocation = await invoke(request);
			requireNativeProof(!invocation.failed && invocation.result);
			const response = awsSecretInputNativeResponse(invocation.result);
			requireNativeProof(
				response?.ok === true &&
					isRecord(response.result) &&
					response.result.stdout === LIFECYCLE_STDOUT &&
					response.result.stderr === LIFECYCLE_STDERR &&
					response.result.exitCode === 0 &&
					runWorkers === beforeRuns + 1 &&
					choices.length === beforePrompts + 1,
			);
			const title = choices.at(-1)?.title ?? "";
			requireNativeProof(
				title.includes(approvedArn) &&
					title.includes(version) &&
					title.includes(request.secretInput.expectedIdentity.arn),
			);
			const secretGuards = (await readNativeGuardReceipts(root))
				.slice(beforeGuards)
				.filter(guard => guard.command.includes("secretsmanager") && guard.command.includes("get-secret-value"));
			requireNativeProof(
				secretGuards.some(guard => guard.command.includes(approvedArn) && guard.command.includes(version)),
			);
			for (const guard of secretGuards)
				requireNativeProof(title.includes(guard.command) && title.includes(guard.cwd));
			const id = `cross-account-approved-${++sequence}`;
			await atWriteExecution(request, id, async () => {
				const approval = await native.prepareRuntimeApproval(id, request, undefined, context());
				requireNativeProof(approval?.allowSessionApproval === false);
				native.approveRuntimeApproval(id, request);
			});
			const unapproved = structuredClone(request);
			unapproved.parameters.SecretId = approvedArn.replace(":210987654321:", ":345678901234:");
			const beforeWorkers = workers.length;
			const promptsAfterApproval = choices.length;
			await atWriteExecution(unapproved, id, () =>
				withoutOrdinaryAwsIo(async () => {
					const result = await native.execute(id, unapproved, undefined, observation.inspect, context());
					observation.inspect(result);
					requireNativeFailure(result, "APPROVAL_REQUIRED");
				}),
			);
			requireNativeProof(
				runWorkers === beforeRuns + 1 &&
					workers.length === beforeWorkers &&
					choices.length === promptsAfterApproval,
			);
		});
		observation.inspect(audits);
		requireNativeProof(
			observation.clean && workers.length > 0 && workers.every(worker => worker.exited && worker.code === 0),
		);
		requireNativeProof(receiverEvidence);
		return {
			schema: "aws-secret-input-native/v1",
			cases,
			transport: "native-write-xdev-private-worker-finite-stdin",
			allWorkersReaped: true,
			publicSurfacesClean: true,
			ownedFilesClean: true,
			liveAws: false,
			networkAccess: "owned-loopback-only",
			...receiverEvidence,
		};
	} finally {
		try {
			Object.assign(BUILTIN_TOOLS, originalFactories);
			disposed = true;
			for (const callback of Array.from(beginDispose)) await callback();
			for (const callback of [...completeDispose].reverse()) await callback();
			control.send("release-consumer");
			await cleanupAwsSecretInputLifecycleProcesses(workers.map(worker => worker.child));
			await control.close();
			await assertAwsSecretInputNativeFiles(root);
			requireNativeProof(observation.clean);
		} finally {
			observation.restore();
		}
	}
}

if (import.meta.main) {
	try {
		emit(`${JSON.stringify(await runAwsSecretInputNativeProbe(process.argv[2]!))}\n`);
	} catch {
		emit(`${JSON.stringify({ schema: "aws-secret-input-native-failure/v1", case: activeCase, passed: false })}\n`);
		process.exitCode = 42;
	}
}
