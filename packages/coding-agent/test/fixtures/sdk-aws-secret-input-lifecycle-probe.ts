import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isRecord } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { BUILTIN_TOOLS } from "../../src/tools";
import { AwsTool } from "../../src/tools/aws";
import { VibeSessionRegistry } from "../../src/vibe/runtime";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	awsSecretInputLifecycleLaunch,
	awsSecretInputLifecycleProcessExists,
	awsSecretInputLifecycleRequest,
	cleanupAwsSecretInputLifecycleProcesses,
	createAwsSecretInputLifecycleWorkerClient,
	waitForAwsSecretInputLifecycleConsumerReady,
	type AwsSecretInputLifecycleWorker,
} from "./aws-secret-input-lifecycle-client";
import { createAwsSecretInputLifecycleControl } from "./aws-secret-input-lifecycle-control";
import {
	assertAwsSecretInputNativeFiles,
	awsSecretInputNativeResponse,
	observeAwsSecretInputNativeSurfaces,
	requireAwsSecretInputNativeTransport,
	requireNativeFailure,
	requireNativeProof,
	type AwsSecretInputNativeTransportEvidence,
} from "./aws-secret-input-native";

const emit = process.stdout.write.bind(process.stdout);
let stage = "setup";
let cleanupFailureStage: string | undefined;
let primaryFailure = false;

export interface AwsSecretInputSdkLifecycleReceipt extends AwsSecretInputNativeTransportEvidence {
	schema: "sdk-aws-secret-input-lifecycle/v1";
	transition:
		| { kind: "fork"; identityChanged: true; returnedToOriginalSession: true; staleGrantRejected: true }
		| {
				kind: "dispose";
				rootTeardownBlocked: true;
				completeCallbacksDeferred: true;
				childExitedWhileTeardownBlocked: true;
				newPreparationRejected: true;
				newExecutionRejected: true;
				completeCallbacksEventuallyRun: true;
		  };
	consumerReady: true;
	scopeAborted: true;
	cancelled: true;
	workerReapedBeforeResult: true;
	consumerReaped: true;
	descendantReaped: true;
	guardianReaped: true;
	publicSurfacesClean: true;
	ownedFilesClean: true;
	modelDispatches: 0;
	liveAws: false;
}

function requireNativeCancellation(result: AgentToolResult<unknown>): void {
	const response = awsSecretInputNativeResponse(result);
	requireNativeProof(result.isError === true && response?.ok === true && isRecord(response.result));
	requireNativeProof(
		isRecord(result.details) &&
			isRecord(result.details.xdev) &&
			result.details.xdev.tool === "aws" &&
			result.details.xdev.mode === "execute",
	);
	const cancelled = response.result;
	requireNativeProof(
		cancelled.cancelled === true && cancelled.timedOut === false && cancelled.completion === "uncertain",
	);
	requireNativeProof(
		cancelled.stdout === "" &&
			cancelled.stderr === "" &&
			cancelled.stdoutTruncated === false &&
			cancelled.stderrTruncated === false,
	);
	requireNativeProof(
		Bun.deepEquals(cancelled.teardown, { consumerReaped: true, workerReaped: true, referencesReleased: true }),
	);
}

export async function runSdkAwsSecretInputLifecycleProbe(
	root: string,
	scenario: "fork" | "dispose",
): Promise<AwsSecretInputSdkLifecycleReceipt> {
	requireNativeProof(path.isAbsolute(root));
	const observation = observeAwsSecretInputNativeSurfaces();
	const authStorage = createInMemoryAuthStorage();
	const model = getBundledModel("openai", "gpt-4o-mini");
	requireNativeProof(model);
	authStorage.keys.setRuntime(model.provider, randomUUID());
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
	await sessionManager.ensureOnDisk();
	const settings = Settings.isolated({
		"async.enabled": false,
		"browser.enabled": false,
		"computer.enabled": false,
		"compaction.enabled": false,
		"plan.enabled": false,
		"todo.enabled": false,
		"tools.xdev": true,
		"tools.approvalMode": "yolo",
		"approval.notify": "off",
		"tools.approval": { aws: "allow", bash: "allow" },
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const control = await createAwsSecretInputLifecycleControl();
	const request = awsSecretInputLifecycleRequest(root, "hold", control.port);
	const launch = awsSecretInputLifecycleLaunch(root);
	const workers: { child: Bun.Subprocess<"ignore", "ignore", "ignore">; exited: boolean; code?: number }[] = [];
	const workerChildren: AwsSecretInputLifecycleWorker[] = [];
	const removedDirectories = new Set<string>();
	const client = createAwsSecretInputLifecycleWorkerClient({
		scenario: "success",
		controlPort: control.port,
		withControlDescriptor: true,
		onMessage: observation.inspect,
		onSpawn: child => {
			const worker = { child, exited: false } as (typeof workers)[number];
			workers.push(worker);
			workerChildren.push(child);
			void child.exited.then(code => {
				worker.code = code;
				worker.exited = true;
			});
		},
		beforeDirectoryRemoval: async directory => {
			removedDirectories.add(directory);
			await assertAwsSecretInputNativeFiles(directory);
		},
	});
	const constructed: { tool?: AwsTool; signal?: AbortSignal } = {};
	const lifecycle = { completeCallbacks: 0, workerReapedBeforeResult: false, synchronousCleanupComplete: false };
	let session: AgentSession | undefined;
	let probeWorkers = 0;
	let runWorkers = 0;
	let providerDispatches = 0;
	let approvals = 0;
	let active: Promise<AgentToolResult<unknown>> | undefined;
	let disposing: Promise<void> | undefined;
	let restoreTeardown: (() => void) | undefined;
	let restoreUI: (() => void) | undefined;
	let restoreWriter: (() => void) | undefined;
	let unsubscribeAgent: (() => void) | undefined;
	let consumerPid: number | undefined;
	let descendantPid: number | undefined;
	let guardianPid: number | undefined;
	const teardownEntered = Promise.withResolvers<void>();
	const releaseTeardown = Promise.withResolvers<void>();
	const originalFactory = BUILTIN_TOOLS.aws;
	try {
		stage = "sdk-construction";
		BUILTIN_TOOLS.aws = toolSession => {
			if (toolSession.getAgentId?.() === "advisor") return originalFactory(toolSession);
			const completed: () => void = () => ++lifecycle.completeCallbacks;
			toolSession.registerDisposeCallback?.(completed);
			const native = new AwsTool(toolSession, undefined, {
				launch: () => launch,
				probeWorker: async signal => {
					probeWorkers++;
					return client.probeAwsSecretInputWorker(signal);
				},
				runWorker: async (approvedRequest, files, authorize, signal, admitConsumer) => {
					runWorkers++;
					constructed.signal = signal;
					try {
						return await client.runAwsSecretInputWorker(approvedRequest, files, authorize, signal, admitConsumer);
					} finally {
						requireNativeProof(workers.every(worker => worker.exited && worker.code === 0));
						lifecycle.workerReapedBeforeResult = true;
					}
				},
			});
			constructed.tool = native;
			return native;
		};
		try {
			const created = await createAgentSession({
				cwd: root,
				agentDir: root,
				authStorage,
				modelRegistry,
				agentRegistry: new AgentRegistry(),
				sessionManager,
				settings,
				model: { ...model, baseUrl: "https://sdk-secret-input-model.invalid" },
				cacheWarming: false,
				autoTitle: false,
				bindProcessState: false,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				skipPythonPreflight: true,
				toolNames: ["aws", "read", "write"],
				mountedToolNames: ["aws"],
				requireYieldTool: false,
				preloadedCustomToolPaths: [],
				skills: [],
				contextFiles: [],
				noContextFiles: true,
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				workspaceTree: { rootPath: root, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				onFirstChatDispatch: () => {
					providerDispatches++;
				},
			});
			session = created.session;
			const synchronousCleanup: () => void = () => (lifecycle.synchronousCleanupComplete = true);
			session.addDisposer(synchronousCleanup);
		} finally {
			BUILTIN_TOOLS.aws = originalFactory;
		}
		const native = constructed.tool;
		requireNativeProof(native && session.getToolByName("aws") && session.getToolByName("write"));
		const runner = session.extensionRunner;
		requireNativeProof(runner);
		const originalGetUIContext = runner.getUIContext;
		const originalHasUI = runner.hasUI;
		const ui: ExtensionUIContext = {
			...runner.getUIContext(),
			select: async (title, options) => {
				approvals++;
				observation.inspect([title, options]);
				requireNativeProof(Bun.deepEquals(options, ["Deny", "Approve once"]));
				return "Approve once";
			},
		};
		runner.getUIContext = () => ui;
		runner.hasUI = () => true;
		restoreUI = () => {
			runner.getUIContext = originalGetUIContext;
			runner.hasUI = originalHasUI;
		};
		const originalSessionId = sessionManager.getSessionId();
		const originalSessionFile = session.sessionFile;
		requireNativeProof(originalSessionFile);
		stage = "fresh-approval";
		const invocation = { path: "xd://aws", content: JSON.stringify(request) };
		const synthetic = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "active", name: "write", arguments: invocation }] },
				{ content: ["Private execution settled."] },
			],
		});
		let activeResult: AgentToolResult<unknown> | undefined;
		let staleGrantRejected = false;
		const writer = session.agent.state.tools.find(tool => tool.name === "write");
		requireNativeProof(writer);
		const execute = writer.execute;
		writer.execute = async (toolCallId, args, signal, onUpdate, context) => {
			if (toolCallId === "active") {
				const approval = await native.prepareRuntimeApproval("unused", request, signal, context);
				requireNativeProof(approval?.allowSessionApproval === false);
				native.approveRuntimeApproval("unused", request);
				stage = "consumer-readiness";
			} else if (toolCallId === "replay") {
				native.approveRuntimeApproval("unused", request);
				const replay = await native.execute("unused", request, signal, undefined, context);
				observation.inspect(replay);
				requireNativeFailure(replay, "APPROVAL_REQUIRED");
				staleGrantRejected = true;
				return replay;
			}
			return execute.call(writer, toolCallId, args, signal, onUpdate, context);
		};
		restoreWriter = () => {
			writer.execute = execute;
		};
		session.agent.streamFn = synthetic.stream;
		unsubscribeAgent = session.agent.subscribe(event => {
			observation.inspect(event);
			if (event.type === "tool_execution_end" && event.toolCallId === "active") {
				activeResult = { ...event.result, isError: event.isError === true };
			}
		});
		active = session.agent.prompt("Run the synthetic private AWS lifecycle request.").then(() => {
			requireNativeProof(activeResult);
			return activeResult;
		});
		void active.catch(() => {});
		const readiness = waitForAwsSecretInputLifecycleConsumerReady(control, workerChildren);
		void readiness.catch(() => {});
		const ready = await Promise.race([readiness, active.then(() => undefined)]);
		requireNativeProof(ready && Number.isSafeInteger(ready.pid) && Number.isSafeInteger(ready.descendantPid));
		consumerPid = ready.pid!;
		descendantPid = ready.descendantPid!;
		requireNativeProof(
			awsSecretInputLifecycleProcessExists(consumerPid) &&
				awsSecretInputLifecycleProcessExists(descendantPid) &&
				runWorkers === 1,
		);
		const spawned = await control.waitForEvent(
			"consumer-spawned",
			20_000,
			event => event.workerPid === workers.at(-1)?.child.pid,
		);
		requireNativeProof(Number.isSafeInteger(spawned.pid) && spawned.groupId === spawned.pid);
		guardianPid = spawned.pid!;
		requireNativeProof(awsSecretInputLifecycleProcessExists(guardianPid));
		const input = await control.waitForEvent("input-complete", 20_000, event => event.pid === consumerPid);
		requireNativeProof(
			input.parentPid === guardianPid && (spawned.receiverPid === null || spawned.receiverPid === consumerPid),
		);
		requireNativeProof(Array.isArray(spawned.privateDescriptors));
		requireNativeProof(spawned.guardianFdSnapshotAvailable === (process.platform === "linux"));
		requireNativeProof(
			process.platform === "linux"
				? Array.isArray(spawned.guardianDescriptors)
				: spawned.guardianDescriptors === null,
		);
		const receiverEvidence = requireAwsSecretInputNativeTransport(input, spawned);
		let transition: AwsSecretInputSdkLifecycleReceipt["transition"];
		if (scenario === "fork") {
			stage = "supported-fork";
			requireNativeProof(await session.fork());
			requireNativeProof(
				sessionManager.getSessionId() !== originalSessionId && constructed.signal?.aborted === true,
			);
			stage = "joined-worker-and-consumer";
			requireNativeProof(workers.every(worker => worker.exited && worker.code === 0));
			requireNativeProof(
				!awsSecretInputLifecycleProcessExists(consumerPid) &&
					!awsSecretInputLifecycleProcessExists(descendantPid) &&
					!awsSecretInputLifecycleProcessExists(guardianPid),
			);
			requireNativeCancellation(await active);
			stage = "returned-session-replay";
			requireNativeProof(await session.switchSession(originalSessionFile));
			requireNativeProof(sessionManager.getSessionId() === originalSessionId);
			const beforeReplay = { workers: workers.length, probes: probeWorkers, approvals };
			let rejectedPreparation = false;
			try {
				await native.prepareRuntimeApproval("after-fork", request);
			} catch (error) {
				observation.inspect(error);
				rejectedPreparation = error instanceof Error && error.message === "CAPABILITY_INCOMPATIBLE";
			}
			requireNativeProof(rejectedPreparation);
			requireNativeFailure(await native.execute("after-fork", request), "CAPABILITY_INCOMPATIBLE");
			synthetic.push({
				content: [{ type: "toolCall", id: "replay", name: "write", arguments: invocation }],
			});
			synthetic.push({ content: ["Stale approval replay settled."] });
			await session.agent.prompt("Replay the previous private AWS approval without a fresh approval.");
			requireNativeProof(
				staleGrantRejected &&
					runWorkers === 1 &&
					workers.length === beforeReplay.workers &&
					probeWorkers === beforeReplay.probes &&
					approvals === beforeReplay.approvals,
			);
			transition = {
				kind: "fork",
				identityChanged: true,
				returnedToOriginalSession: true,
				staleGrantRejected: true,
			};
		} else {
			stage = "root-disposal-begin";
			const vibe = VibeSessionRegistry.global();
			const originalSuspendScope = vibe.suspendScope;
			vibe.suspendScope = async (...args) => {
				teardownEntered.resolve();
				await releaseTeardown.promise;
				return originalSuspendScope.apply(vibe, args);
			};
			restoreTeardown = () => {
				vibe.suspendScope = originalSuspendScope;
			};
			disposing = session.dispose();
			void disposing.catch(() => {});
			await Promise.race([
				teardownEntered.promise,
				disposing.then(() => {
					throw new Error("AWS_SECRET_INPUT_NATIVE_BOUNDARY_FAILED");
				}),
			]);
			stage = "root-disposal-state";
			requireNativeProof(session.isDisposed && lifecycle.synchronousCleanupComplete);
			stage = "root-disposal-cancellation";
			requireNativeProof(constructed.signal?.aborted === true);
			stage = "root-disposal-deferral";
			requireNativeProof(lifecycle.completeCallbacks === 0);
			stage = "joined-worker-and-consumer";
			requireNativeCancellation(await active);
			requireNativeProof(workers.every(worker => worker.exited && worker.code === 0));
			requireNativeProof(
				!awsSecretInputLifecycleProcessExists(consumerPid) &&
					!awsSecretInputLifecycleProcessExists(descendantPid) &&
					!awsSecretInputLifecycleProcessExists(guardianPid) &&
					lifecycle.completeCallbacks === 0,
			);
			stage = "closed-disposal-admission";
			const beforeAdmission = { workers: workers.length, probes: probeWorkers, approvals };
			let rejectedPreparation = false;
			try {
				await native.prepareRuntimeApproval("after-dispose", request);
			} catch (error) {
				observation.inspect(error);
				rejectedPreparation = error instanceof Error && error.message === "CANCELLED";
			}
			requireNativeProof(rejectedPreparation);
			requireNativeFailure(await native.execute("after-dispose", request), "CANCELLED");
			native.approveRuntimeApproval("unused", request);
			requireNativeFailure(await native.execute("unused", request), "CANCELLED");
			requireNativeProof(
				runWorkers === 1 &&
					workers.length === beforeAdmission.workers &&
					probeWorkers === beforeAdmission.probes &&
					approvals === beforeAdmission.approvals &&
					lifecycle.completeCallbacks === 0,
			);
			stage = "complete-root-teardown";
			releaseTeardown.resolve();
			await disposing;
			requireNativeProof(lifecycle.completeCallbacks > 0);
			transition = {
				kind: "dispose",
				rootTeardownBlocked: true,
				completeCallbacksDeferred: true,
				childExitedWhileTeardownBlocked: true,
				newPreparationRejected: true,
				newExecutionRejected: true,
				completeCallbacksEventuallyRun: true,
			};
		}
		stage = "public-surfaces";
		observation.inspect(control.events);
		requireNativeProof(control.clean);
		stage = "public-session-records";
		observation.inspect(sessionManager.getEntries());
		requireNativeProof(observation.clean);
		stage = "no-model-dispatch";
		requireNativeProof(providerDispatches === 0);
		stage = "worker-owned-directories";
		requireNativeProof(removedDirectories.size > 0 && workers.length > 0);
		for (const directory of removedDirectories) {
			let missing = false;
			try {
				await fs.lstat(directory);
			} catch (error) {
				missing = !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
			}
			requireNativeProof(missing);
		}
		stage = "worker-private-boundary";
		const activeWorker = control.events.find(
			event => event.kind === "worker-ready" && event.pid === workers.at(-1)?.child.pid,
		);
		requireNativeProof(activeWorker?.ipcAvailable === true && activeWorker.controlFdPresent === true);
		stage = "worker-teardown-receipts";
		const done = await Promise.all(
			workers.map(worker => control.waitForEvent("worker-done", 20_000, event => event.pid === worker.child.pid)),
		);
		for (const event of done) {
			requireNativeProof(
				event.cleanSurfaces === true && event.unexpectedOutput === false && event.retryDisabled === true,
			);
			requireNativeProof(
				event.filesReleased === true &&
					((event.inputsObserved === 0 && event.inputsReleased === null) ||
						(event.inputsObserved === 1 && event.inputsReleased === true)) &&
					event.responsesReleased === true &&
					event.credentialsReleased === true,
			);
		}
		requireNativeProof(done.filter(event => event.realConsumer === true).length === 1);
		stage = "root-disposal-complete";
		if (!disposing) await session.dispose();
		requireNativeProof(lifecycle.synchronousCleanupComplete && lifecycle.completeCallbacks > 0);
		await sessionManager.flush();
		stage = "owned-files";
		await assertAwsSecretInputNativeFiles(root);
		requireNativeProof(
			!awsSecretInputLifecycleProcessExists(consumerPid) &&
				!awsSecretInputLifecycleProcessExists(descendantPid) &&
				!awsSecretInputLifecycleProcessExists(guardianPid),
		);
		requireNativeProof(workers.every(worker => worker.exited && worker.code === 0));
		requireNativeProof(lifecycle.workerReapedBeforeResult);
		stage = "exact-approval-count";
		requireNativeProof(approvals === 1);
		return {
			schema: "sdk-aws-secret-input-lifecycle/v1",
			transition,
			consumerReady: true,
			scopeAborted: true,
			cancelled: true,
			workerReapedBeforeResult: true,
			consumerReaped: true,
			descendantReaped: true,
			guardianReaped: true,
			publicSurfacesClean: true,
			ownedFilesClean: true,
			modelDispatches: 0,
			liveAws: false,
			...receiverEvidence,
		};
	} catch (error) {
		observation.inspect(error);
		primaryFailure = true;
		throw error;
	} finally {
		let cleanupFailed = false;
		const cleanup = async (phase: string, operation: () => unknown | Promise<unknown>): Promise<void> => {
			try {
				await operation();
			} catch (error) {
				observation.inspect(error);
				cleanupFailureStage ??= phase;
				cleanupFailed = true;
			}
		};
		try {
			BUILTIN_TOOLS.aws = originalFactory;
			releaseTeardown.resolve();
			restoreTeardown?.();
			restoreUI?.();
			session?.agent.abort();
			control.send("release-consumer");
			await cleanup("private-processes", () => cleanupAwsSecretInputLifecycleProcesses(workerChildren));
			await cleanup("active-execution", () => active);
			await cleanup("session-disposal", () => disposing ?? session?.dispose());
			await cleanup("control-listener", () => control.close());
			await cleanup("in-memory-auth", () => authStorage.close());
			await cleanup("session-writer", () => sessionManager.close());
			await cleanup("owned-files", () => assertAwsSecretInputNativeFiles(root));
			requireNativeProof(!cleanupFailed && observation.clean);
		} finally {
			restoreWriter?.();
			unsubscribeAgent?.();
			observation.restore();
		}
	}
}

if (import.meta.main) {
	try {
		const scenario = process.argv[3];
		requireNativeProof(scenario === "fork" || scenario === "dispose");
		const receipt = await runSdkAwsSecretInputLifecycleProbe(process.argv[2]!, scenario);
		emit(`${JSON.stringify(receipt)}\n`);
	} catch {
		emit(
			`${JSON.stringify({
				schema: "sdk-aws-secret-input-lifecycle-failure/v1",
				stage,
				cleanup: cleanupFailureStage ?? null,
				primaryFailure,
				passed: false,
			})}\n`,
		);
		process.exitCode = 42;
	}
}
