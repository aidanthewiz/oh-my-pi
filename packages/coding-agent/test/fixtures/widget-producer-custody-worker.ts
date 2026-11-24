import { type MessagePort, parentPort } from "node:worker_threads";
import * as path from "node:path";
import { createAssistantMessageEventStream, type Model } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { PipeStreams } from "@oh-my-pi/pi-natives";
import { procmgr } from "@oh-my-pi/pi-utils";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { AsyncJobManagerApi } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { TextTap } from "../../src/job-widgets/text-tap";
import { AgentRegistry, type AgentRef } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { SessionManager } from "../../src/session/session-manager";
import { Semaphore } from "../../src/task/parallel";
import { SpawnRun } from "../../src/task/spawn-run";
import { appendToolResult, createTaskWidgetInputs } from "../../src/task/widget-inputs";
import { setCurrentThreadId } from "../../src/thread/identity";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RemoteObject, type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { agentsThreadService } from "../../src/thread/services/agents";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import {
	ASYNC_JOB_MANAGER_KIND,
	type AsyncJobManagerProtocol,
	type WireWidgetProducer,
} from "../../src/thread/services/async-jobs-protocol";
import { RemoteAsyncJobManager } from "../../src/thread/services/async-jobs-remote";
import { identityThreadService } from "../../src/thread/services/identity";
import { threadServices } from "../../src/thread/services/index";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

export type InvalidProducer = "absent" | "forged" | "session" | "kind" | "manager" | "replay" | "lifetime" | "capture";

export interface WorkerProducerProbe {
	startBash(): Promise<string>;
	registerInvalid(mode: InvalidProducer, other?: AsyncJobManagerApi): Promise<string>;
	replaceStreams(id: string): Promise<void>;
	changeSession(): Promise<void>;
	startTask(
		forgedOwner?: boolean,
		retryContinuation?: boolean,
		alreadyRunning?: boolean,
	): Promise<{ id: string; owner: AgentRef }>;
	retryTaskRun(): Promise<void>;
	replaceTaskContinuation(): Promise<void>;
	nextTaskRun(): Promise<void>;
	dispose(): Promise<void>;
	barrier(): Promise<void>;
}

export interface ProducerCustodyProbe {
	open(manager: AsyncJobManagerApi, model: Model, cwd: string): Promise<WorkerProducerProbe>;
}

const SAMPLE = "req 1 rps=10\nreq 2 rps=20\nreq 3 rps=30\n";
const COMMAND = "printf 'req 1 rps=10\\nreq 2 rps=20\\nreq 3 rps=30\\n'; sleep 60";
const rawManagers = new WeakMap<AsyncJobManagerApi, RemoteObject<AsyncJobManagerProtocol>>();
const minted = new WeakMap<AgentSessionHandle, WireWidgetProducer[]>();

class ObservedManager extends RemoteAsyncJobManager {
	readonly owners = new WeakMap<AgentSessionHandle, () => boolean>();

	override bindWidgetSession(ownerCurrent: () => boolean, session: AgentSessionHandle): boolean {
		const bound = super.bindWidgetSession(ownerCurrent, session);
		if (bound) this.owners.set(session, ownerCurrent);
		return bound;
	}
}

function settings(model: Model): Settings {
	return Settings.isolated({
		enabledModels: [`${model.provider}/${model.id}`],
		"async.enabled": true,
		"async.widgets": true,
		"async.widgetRemoteAuthoring": true,
		"launch.enabled": false,
		"bash.autoBackground.enabled": false,
		"bashInterceptor.enabled": false,
		"worktree.clone": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.enabled": false,
		"autolearn.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		shellPath: process.platform === "win32" ? procmgr.resolveWindowsShell() : "/bin/sh",
	});
}

const probe: ProducerCustodyProbe = {
	async open(manager, model, cwd) {
		if (!(manager instanceof ObservedManager)) throw new Error("Missing real remote manager");
		const raw = rawManagers.get(manager);
		if (!raw) throw new Error("Missing manager protocol");
		const auth = createInMemoryAuthStorage();
		const sourceSettings = settings(model);
		const registry = new ModelRegistry(auth, path.join(cwd, "source-models.yml"), { settings: sourceSettings });
		const create = async (id: string, sharedRegistry: boolean, retryContinuation = false) =>
			createAgentSession({
				cwd,
				agentDir: cwd,
				authStorage: auth,
				modelRegistry: registry,
				model,
				settings: retryContinuation
					? sourceSettings.overlay({
							"retry.enabled": true,
							"retry.baseDelayMs": 1,
							"retry.maxRetries": 1,
							"retry.modelFallback": false,
						})
					: sourceSettings,
				agentRegistry: sharedRegistry ? AgentRegistry.global() : new AgentRegistry(),
				agentId: id,
				parentTaskPrefix: id,
				taskDepth: 1,
				requireYieldTool: false,
				asyncJobManager: manager,
				sessionManager: SessionManager.inMemory(cwd),
				bindProcessState: false,
				cacheWarming: "off",
				disableModelFallback: true,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				preloadedCustomToolPaths: [],
				enableMCP: false,
				enableIrc: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: ["bash"],
				restrictToolNames: true,
			});
		const { session: source } = await create("CustodySource", false);
		const runs = new Set<string>();
		const releaseTask = Promise.withResolvers<void>();
		const bodyGates: PromiseWithResolvers<void>[] = [];
		const firstTaskEnd = Promise.withResolvers<boolean>();
		const replacementReady = Promise.withResolvers<void>();
		let replaceContinuation = false;
		let ownedTask: AgentRef | undefined;
		const bodyEntered: PromiseWithResolvers<void>[] = [];
		let target: AgentSession | undefined;
		let prompting: Promise<boolean> | undefined;
		let closed = false;
		const sessionSignal = new AbortController();
		return {
			async startBash() {
				const bash = source.getToolByName("bash");
				if (!bash) throw new Error("Missing SDK Bash producer");
				const ready = Promise.withResolvers<void>();
				await bash.execute(
					"custody-bash",
					{ command: COMMAND, async: true, pty: false, timeout: 0 },
					undefined,
					update => {
						if (update.content.some(block => block.type === "text" && block.text.includes("req 3 rps=30")))
							ready.resolve();
					},
				);
				const job = manager.getRunningJobs({ ownerId: "CustodySource" }).at(-1);
				if (!job) throw new Error("No running SDK Bash job");
				runs.add(job.id);
				await Promise.race([
					ready.promise,
					job.promise.then(() => {
						throw new Error("Bash ended before its output sample");
					}),
				]);
				return job.id;
			},
			async registerInvalid(mode, other) {
				const ownerCurrent = manager.owners.get(source);
				if (!ownerCurrent) throw new Error("SDK source lineage was not bound");
				let wire: WireWidgetProducer | undefined;
				if (mode === "replay") wire = minted.get(source)?.at(-1);
				else if (mode === "forged") wire = { id: "unissued-producer", sessionId: source.sessionId, kind: "bash" };
				else if (mode !== "absent") {
					const captured = mode === "lifetime" ? raw.callSync("captureOwner", "lifetime") : undefined;
					if (mode === "capture") {
						const fresh = manager.captureWidgetOwnerCurrent();
						if (fresh) {
							const lease = manager.captureWidgetProducer(fresh, source, "bash", sessionSignal.signal);
							if (lease) wire = minted.get(source)?.at(-1);
						}
					} else if (mode === "lifetime") {
						if (captured !== undefined) wire = raw.callSync("widgetProducer", captured, source, "bash");
					} else {
						const lease = manager.captureWidgetProducer(
							ownerCurrent,
							source,
							mode === "kind" ? "task" : "bash",
							sessionSignal.signal,
						);
						if (!lease) throw new Error("Could not mint the negative case's genuine producer");
						wire = minted.get(source)?.at(-1);
					}
				}
				if (mode === "session" && wire) wire = { ...wire, sessionId: `${wire.sessionId}-other` };
				const destination = other ?? manager;
				const destinationRaw = rawManagers.get(destination);
				if (!destinationRaw) throw new Error("Missing destination protocol");
				const out = new TextTap("out", "synthetic stdout");
				out.append(SAMPLE);
				const done = Promise.withResolvers<string>();
				let offset = 0;
				const id = destinationRaw.callSync(
					"register",
					"bash",
					"rejected producer",
					async ctx => {
						if (ctx.signal.aborted) done.resolve("cancelled");
						else ctx.signal.addEventListener("abort", () => done.resolve("cancelled"), { once: true });
						return done.promise;
					},
					{
						id: `widget-custody-invalid-${mode}`,
						ownerId: "CustodySource",
						feed: {
							process: { command: COMMAND, cwd },
							brief: { kind: "bash", command: COMMAND },
							producer: wire,
							pull: () => {
								const chunk = out.read(offset);
								offset = chunk.end;
								return { sources: [{ id: out.id, label: out.label, text: chunk.text, open: chunk.open }] };
							},
						},
					},
				);
				if (destination === manager) runs.add(id);
				return id;
			},
			async replaceStreams(id) {
				const job = manager.getJob(id);
				if (!job?.process) throw new Error("No live producer process");
				Reflect.set(job.process, "streams", new PipeStreams());
			},
			async changeSession() {
				await source.newSession();
			},
			async startTask(forgedOwner = false, retryContinuation = false, alreadyRunning = false) {
				const { contextWindow, maxTokens } = model;
				if (contextWindow === null || maxTokens === null) {
					throw new Error("Synthetic Task model requires token limits");
				}
				const ownerCurrent = manager.owners.get(source);
				if (!ownerCurrent) throw new Error("SDK source lineage was not bound");
				const producer = manager.captureWidgetProducer(ownerCurrent, source, "task", sessionSignal.signal);
				if (!producer) throw new Error("No genuine task producer lease");
				const firstEntered = Promise.withResolvers<void>();
				const firstStarted = Promise.withResolvers<void>();
				bodyEntered.push(firstEntered);
				registry.registerProvider(
					model.provider,
					{
						baseUrl: "https://task-body.synthetic.invalid",
						apiKey: "synthetic-task-key",
						api: model.api,
						models: [
							{
								id: model.id,
								name: model.name,
								reasoning: false,
								input: ["text"],
								cost: model.cost,
								contextWindow,
								maxTokens,
							},
						],
						streamSimple: (selected, _context, options) => {
							const stream = createAssistantMessageEventStream();
							const gate = Promise.withResolvers<void>();
							const attempt = bodyGates.length;
							const entered = bodyEntered[attempt];
							bodyGates.push(gate);
							const message = {
								...createAssistantMessage("Synthetic task complete"),
								api: selected.api,
								provider: selected.provider,
								model: selected.id,
							};
							void (async () => {
								try {
									await resolveApiKeyOnce(options?.apiKey, options?.signal);
									await options?.onPayload?.({ task: true }, selected, options?.signal);
									stream.push({ type: "start", partial: message });
									entered?.resolve();
									await gate.promise;
									if (retryContinuation && attempt === 0) {
										const failure = {
											...message,
											stopReason: "error" as const,
											errorMessage: "overloaded_error: provider returned error 503",
										};
										stream.push({ type: "error", reason: "error", error: failure });
									} else {
										stream.push({ type: "done", reason: "stop", message });
									}
								} catch (error) {
									stream.push({
										type: "error",
										reason: "error",
										error: { ...message, stopReason: "error", errorMessage: String(error) },
									});
								}
							})();
							return stream;
						},
					},
					"custody-task-body",
				);
				const progress: AgentProgress = {
					id: "CustodyTask",
					index: 0,
					agent: "task",
					agentSource: "bundled",
					status: "running",
					task: "Measure request throughput",
					watch: "req/s",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				};
				let run: SpawnRun | undefined;
				const ready = Promise.withResolvers<AgentRef>();
				const createRun = () =>
					new SpawnRun(new Semaphore(1), async body => {
						({ session: target } = await create("CustodyTask", true, retryContinuation));
						const owner = AgentRegistry.global().get("CustodyTask");
						if (!owner) throw new Error("Task did not register its real owner");
						ownedTask = owner;
						body.onAgentRegistered(owner);
						let firstRun: string | undefined;
						target.addDisposer(
							target.subscribeLifecycle(event => {
								if (event.type === "agent_start") {
									firstRun ??= event.runId;
									firstStarted.resolve();
								} else if (event.type === "agent_end" && event.runId === firstRun) {
									firstTaskEnd.resolve(event.isTerminal);
									if (replaceContinuation && event.isTerminal === false) {
										const current = target;
										const previous = prompting;
										const entered = bodyEntered[1];
										if (!current || !previous || !entered) {
											replacementReady.reject(new Error("Missing canonical continuation to replace"));
											return;
										}
										void (async () => {
											await current.abort();
											await previous;
											prompting = current.prompt("Start a distinct successor after cancelling retry", {
												runCommands: false,
											});
											await entered.promise;
											replacementReady.resolve();
										})().catch(replacementReady.reject);
									}
								}
							}),
						);
						prompting = target.prompt("Measure request throughput", { runCommands: false });
						await firstEntered.promise;
						await firstStarted.promise;
						appendToolResult(body.tools, { tool: "bash", text: SAMPLE, isError: false });
						ready.resolve(owner);
						await releaseTask.promise;
						for (const gate of bodyGates) gate.resolve();
						await prompting;
						return {
							content: [{ type: "text", text: "Task finished" }],
							details: { results: [], totalDurationMs: 1, projectAgentsDir: null } as TaskToolDetails,
						};
					});
				if (alreadyRunning) {
					run = createRun();
					await ready.promise;
				}
				const id = manager.register(
					"task",
					"CustodyTask",
					async ({ signal, markRunning }) => {
						run ??= createRun();
						run.attach({
							signal,
							onAgentRegistered: owner => {
								producer.bindTaskOwner(forgedOwner ? { ...owner } : owner);
								markRunning();
							},
						});
						void run.result.then(
							() => producer.revoke(),
							() => producer.revoke(),
						);
						await run.started;
						await run.result;
						return "Task finished";
					},
					{
						id: "CustodyTask",
						agentId: "CustodyTask",
						ownerId: "CustodySource",
						queued: true,
						widgetInputs: createTaskWidgetInputs({
							manager,
							agentId: "CustodyTask",
							owner: () => run?.ownerRef,
							widgetOwnerCurrent: ownerCurrent,
							producer,
							tools: () => run?.tools,
							progress,
						}),
					},
				);
				runs.add(id);
				const owner = await Promise.race([
					ready.promise,
					manager.getJob(id)!.promise.then(() => {
						throw new Error("Task ended before its canonical owner and output became ready");
					}),
				]);
				return { id, owner };
			},
			async retryTaskRun() {
				if (!target || !prompting || !bodyGates[0]) throw new Error("No active task run");
				const entered = Promise.withResolvers<void>();
				bodyEntered.push(entered);
				bodyGates[0].resolve();
				if ((await firstTaskEnd.promise) !== false) throw new Error("SDK retry settled as terminal");
				await entered.promise;
			},
			async replaceTaskContinuation() {
				if (!target || !prompting || !bodyGates[0]) throw new Error("No active task run");
				bodyEntered.push(Promise.withResolvers<void>());
				replaceContinuation = true;
				bodyGates[0].resolve();
				if ((await firstTaskEnd.promise) !== false) throw new Error("SDK retry settled as terminal");
				await replacementReady.promise;
			},
			async nextTaskRun() {
				if (!target || !prompting || !bodyGates[0]) throw new Error("No active task run");
				bodyGates[0].resolve();
				await prompting;
				if ((await firstTaskEnd.promise) !== true) throw new Error("SDK predecessor did not terminate");
				const entered = Promise.withResolvers<void>();
				bodyEntered.push(entered);
				prompting = target.prompt("Start a distinct successor run", { runCommands: false });
				await entered.promise;
			},
			async dispose() {
				if (closed) return;
				closed = true;
				sessionSignal.abort();
				for (const id of runs) manager.cancel(id);
				releaseTask.resolve();
				for (const gate of bodyGates) gate.resolve();
				await target?.dispose();
				if (ownedTask) AgentRegistry.global().unregister(ownedTask.id, ownedTask);
				await source.dispose();
				registry.clearSourceRegistrations("custody-task-body");
				await auth.close();
			},
			async barrier() {},
		};
	},
};

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");
port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	setCurrentThreadId("w1");
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "widget-producer-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	const services = threadServices().filter(
		service =>
			service === identityThreadService || service === agentsThreadService || service === asyncJobsThreadService,
	);
	for (const service of services) service.installWorker?.(link);
	link.importClass<ObservedManager, AsyncJobManagerProtocol>(ASYNC_JOB_MANAGER_KIND, remote => {
		const observed: RemoteObject<AsyncJobManagerProtocol> = {
			id: remote.id,
			call: (method, ...args) => remote.call(method, ...args),
			notify: (method, ...args) => remote.notify(method, ...args),
			callSync(method, ...args) {
				const value = remote.callSync(method, ...args);
				if (method === "widgetProducer" && value !== undefined) {
					const [, session] = args as AsyncJobManagerProtocol["widgetProducer"]["args"];
					const list = minted.get(session) ?? [];
					list.push(value as WireWidgetProducer);
					minted.set(session, list);
				}
				return value;
			},
		};
		const manager = new ObservedManager(observed);
		rawManagers.set(manager, remote);
		return manager;
	});
	link.handle("boot", async globals => {
		for (const service of services) await service.boot?.(globals[service.name], link);
		const test = globals.test;
		if (typeof test !== "object" || test === null || typeof Reflect.get(test, "ready") !== "function")
			throw new Error("Missing fixture probe");
		await Reflect.get(test, "ready")(probe);
	});
	port.postMessage({ ready: true });
});
