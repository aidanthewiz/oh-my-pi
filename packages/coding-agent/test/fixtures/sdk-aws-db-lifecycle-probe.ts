import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Subprocess } from "bun";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { BUILTIN_TOOLS } from "../../src/tools";
import { AwsDbTool, type AwsDbToolDetails } from "../../src/tools/aws-db";
import type { AwsDbFailureCode } from "../../src/tools/aws-db-contract";
import type { AwsDbLaunchFiles } from "../../src/tools/aws-db-scope";
import { VibeSessionRegistry } from "../../src/vibe/runtime";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	createAwsDbNativeSmokeWorkerClient,
	freeLoopbackPort,
	inspection,
	type WorkerPlan,
} from "./aws-db-native-smoke";

type WorkerChild = Subprocess<"ignore", "ignore", "ignore">;

interface LifecycleReceipt {
	schema: "sdk-aws-db-lifecycle/v1";
	primaryFactoryCalls: 1;
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
	readStarted: true;
	scopeAborted: true;
	failureCode: "CANCELLED";
	workers: 1;
	workerExitCode: 0;
	workerExitedBeforeResult: true;
	updates: 0;
	guardSteps: 7;
	modelDispatches: 0;
	physical: "synthetic-mysql-over-real-tls";
	liveAws: false;
	hostedDatabase: false;
}

const FAILURE = "SDK_AWS_DB_LIFECYCLE_BOUNDARY_FAILED";
let stage = "setup";

function requireProof(value: unknown): asserts value {
	if (!value) throw new Error(FAILURE);
}

function requireFailure(result: AgentToolResult<AwsDbToolDetails>, code: AwsDbFailureCode) {
	const expected = JSON.stringify({ ok: false, code });
	requireProof(result.isError === true && JSON.stringify(result.details?.response) === expected);
	requireProof(
		result.content.length === 1 && result.content[0]?.type === "text" && result.content[0].text === expected,
	);
}

async function run(root: string, scenario: "fork" | "dispose"): Promise<LifecycleReceipt> {
	requireProof(path.isAbsolute(root));
	const authStorage = createInMemoryAuthStorage();
	const model = getBundledModel("openai", "gpt-4o-mini");
	requireProof(model);
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
		"tools.xdev": false,
		"tools.approvalMode": "yolo",
		"tools.approval": { aws_db: "allow", aws: "allow" },
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const port = await freeLoopbackPort();
	const request = inspection(port);
	const launch: AwsDbLaunchFiles = {
		homeDir: root,
		configFile: path.join(root, "synthetic-config-not-written"),
		sharedCredentialsFile: path.join(root, "synthetic-credentials-not-written"),
		reservedProfiles: ["coreforge"],
	};
	const plan: WorkerPlan = {
		request,
		fixture: { delay: "read" },
		expectConnections: 1,
		expectReads: 1,
		cancelAtRead: true,
	};
	const children: WorkerChild[] = [];
	const childStatus: { exited: boolean; code?: number } = { exited: false };
	const client = createAwsDbNativeSmokeWorkerClient(plan, launch, child => {
		children.push(child);
		void child.exited.then(code => {
			childStatus.code = code;
			childStatus.exited = true;
		});
	});
	const constructed: { tool?: AwsDbTool; signal?: AbortSignal } = {};
	const lifecycle = { completeCallbacks: 0 };
	let session: AgentSession | undefined;
	let primaryFactoryCalls = 0;
	let guardSteps = 0;
	let modelDispatches = 0;
	let updates = 0;
	let readStarted = false;
	let active: Promise<AgentToolResult<AwsDbToolDetails>> | undefined;
	let disposing: Promise<void> | undefined;
	let restoreTeardown: (() => void) | undefined;
	const external = new AbortController();
	const physicalRead = Promise.withResolvers<void>();
	const forked = Promise.withResolvers<boolean>();
	const teardownEntered = Promise.withResolvers<void>();
	const releaseTeardown = Promise.withResolvers<void>();
	void forked.promise.catch(() => {});
	const onReadStarted = () => {
		readStarted = true;
		physicalRead.resolve();
		if (scenario === "dispose") return;
		if (!session) {
			forked.reject(new Error(FAILURE));
			return;
		}
		void session.fork().then(forked.resolve, forked.reject);
	};
	const originalFactory = BUILTIN_TOOLS.aws_db;
	try {
		stage = "sdk-construction";
		BUILTIN_TOOLS.aws_db = toolSession => {
			if (toolSession.getAgentId?.() === "advisor") return originalFactory(toolSession);
			primaryFactoryCalls++;
			toolSession.registerDisposeCallback?.(() => {
				lifecycle.completeCallbacks++;
			});
			const tool = new AwsDbTool(toolSession, {
				launch: () => launch,
				runWorker: async (approvedRequest, files, authorize, signal) => {
					constructed.signal = signal;
					return client.runAwsDbWorker(
						approvedRequest,
						files,
						async step => {
							guardSteps++;
							await authorize(step);
						},
						signal,
					);
				},
			});
			constructed.tool = tool;
			return tool;
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
				model: { ...model, baseUrl: "https://sdk-lifecycle-model.invalid" },
				cacheWarming: false,
				autoTitle: false,
				bindProcessState: false,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				skipPythonPreflight: true,
				restrictToolNames: true,
				toolNames: ["aws_db"],
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
					modelDispatches++;
				},
			});
			session = created.session;
		} finally {
			BUILTIN_TOOLS.aws_db = originalFactory;
		}
		const native = constructed.tool;
		requireProof(primaryFactoryCalls === 1 && native && session.getToolByName("aws_db"));
		const originalSessionId = sessionManager.getSessionId();
		const originalSessionFile = session.sessionFile;
		requireProof(originalSessionFile);
		stage = "fresh-approval";
		for (const id of ["active", "unused"]) {
			const approval = await native.prepareRuntimeApproval(id, request);
			requireProof(approval?.allowSessionApproval === false);
			native.approveRuntimeApproval(id, request);
		}
		stage = "physical-read";
		process.once("SIGUSR1", onReadStarted);
		active = native.execute("active", request, external.signal, () => {
			updates++;
		});
		const readReached = await Promise.race([physicalRead.promise.then(() => true), active.then(() => false)]);
		requireProof(readReached && readStarted && children.length === 1);
		let transition: LifecycleReceipt["transition"];
		if (scenario === "fork") {
			stage = "supported-fork";
			requireProof(await forked.promise);
			requireProof(sessionManager.getSessionId() !== originalSessionId && constructed.signal?.aborted === true);
			stage = "cancelled-worker-exit";
			requireFailure(await active, "CANCELLED");
			requireProof(childStatus.exited && childStatus.code === 0 && children.length === 1);
			stage = "returned-session-replay";
			requireProof(await session.switchSession(originalSessionFile));
			requireProof(sessionManager.getSessionId() === originalSessionId);
			requireFailure(await native.execute("unused", request), "APPROVAL_REQUIRED");
			requireProof(children.length === 1);
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
				disposing.then(
					() => {
						throw new Error(FAILURE);
					},
					() => {
						throw new Error(FAILURE);
					},
				),
			]);
			requireProof(constructed.signal?.aborted === true && lifecycle.completeCallbacks === 0);
			stage = "worker-exit-before-root-teardown";
			requireFailure(await active, "CANCELLED");
			requireProof(childStatus.exited && childStatus.code === 0 && lifecycle.completeCallbacks === 0);
			stage = "closed-disposal-admission";
			let rejectedPreparation = false;
			try {
				await native.prepareRuntimeApproval("after-dispose", request);
			} catch (error) {
				rejectedPreparation = error instanceof Error && error.message === "CANCELLED";
			}
			requireProof(rejectedPreparation);
			requireFailure(await native.execute("after-dispose", request), "CANCELLED");
			requireProof(children.length === 1 && lifecycle.completeCallbacks === 0);
			stage = "complete-root-teardown";
			releaseTeardown.resolve();
			await disposing;
			requireProof(lifecycle.completeCallbacks > 0);
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
		requireProof(childStatus.exited && guardSteps === 7 && updates === 0 && modelDispatches === 0);
		return {
			schema: "sdk-aws-db-lifecycle/v1",
			primaryFactoryCalls: 1,
			transition,
			readStarted: true,
			scopeAborted: true,
			failureCode: "CANCELLED",
			workers: 1,
			workerExitCode: 0,
			workerExitedBeforeResult: true,
			updates: 0,
			guardSteps: 7,
			modelDispatches: 0,
			physical: "synthetic-mysql-over-real-tls",
			liveAws: false,
			hostedDatabase: false,
		};
	} finally {
		BUILTIN_TOOLS.aws_db = originalFactory;
		process.off("SIGUSR1", onReadStarted);
		releaseTeardown.resolve();
		restoreTeardown?.();
		external.abort();
		await active;
		for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
		await Promise.all(children.map(child => child.exited));
		if (disposing) await disposing;
		else await session?.dispose();
		await authStorage.close();
		await sessionManager.close();
	}
}

try {
	const scenario = process.argv[3];
	requireProof(scenario === "fork" || scenario === "dispose");
	const receipt = await run(process.argv[2]!, scenario);
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch {
	process.stdout.write(`${JSON.stringify({ schema: "sdk-aws-db-lifecycle-failure/v1", stage, passed: false })}\n`);
	process.exitCode = 42;
}
