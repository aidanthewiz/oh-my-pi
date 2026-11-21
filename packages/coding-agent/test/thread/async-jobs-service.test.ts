import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { procmgr } from "@oh-my-pi/pi-utils";
import { AsyncJobManager, type AsyncJob, type AsyncJobManagerApi } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { JobWidgets } from "../../src/job-widgets/registry";
import { TextTap } from "../../src/job-widgets/text-tap";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { threadServices } from "../../src/thread/services/index";
import type { AsyncJobsProbe } from "../fixtures/async-jobs-service-worker";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

const SPEC = {
	title: "load test",
	rules: [{ from: "out", match: String.raw`^req \d+ rps=(?P<rps>[\d.]+)` }],
	blocks: [{ kind: "spark", field: "rps", label: "req/s" }],
	headline: { field: "rps", agg: "last", unit: "req/s" },
};

describe("async-job thread custody", () => {
	let manager: AsyncJobManager;
	let fixture: ServiceWorker<AsyncJobsProbe> | undefined;
	let probe: AsyncJobsProbe;
	let dir: string;
	const releaseGates: Array<() => void> = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-async-custody-"));
		manager = new AsyncJobManager({});
		fixture = await startServiceWorker<AsyncJobsProbe>(
			new URL("../fixtures/async-jobs-service-worker.ts", import.meta.url),
			threadServices().filter(
				service =>
					service === identityThreadService ||
					service === agentsThreadService ||
					service === asyncJobsThreadService,
			),
		);
		probe = fixture.probe;
	});

	afterEach(async () => {
		for (const release of releaseGates.splice(0)) release();
		await manager.dispose({ timeoutMs: 100 });
		await fixture?.stop();
		fixture = undefined;
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("checks captured main authority without retargeting a stale worker to a successor", async () => {
		let reference = Symbol("root-reference");
		let widgetGeneration = 0;
		let parked = false;
		manager.captureWidgetOwnerCurrent = function (this: AsyncJobManager) {
			const capturedReference = reference;
			const generation = widgetGeneration;
			return () => this === manager && capturedReference === reference && generation === widgetGeneration && !parked;
		};
		manager.captureOwnerLifetimeCurrent = () => {
			const capturedReference = reference;
			return () => capturedReference === reference;
		};

		const original = await probe.capture(manager);
		expect(await probe.current(original)).toEqual({ widget: true, lifetime: true });
		widgetGeneration++;
		expect(await probe.current(original)).toEqual({ widget: false, lifetime: true });

		const renewed = await probe.capture(manager);
		parked = true;
		expect(await probe.current(renewed)).toEqual({ widget: false, lifetime: true });
		parked = false;
		expect(await probe.current(renewed)).toEqual({ widget: true, lifetime: true });

		reference = Symbol("successor-reference");
		expect(await probe.current(renewed)).toEqual({ widget: false, lifetime: false });
		const successor = await probe.capture(manager);
		expect(await probe.current(successor)).toEqual({ widget: true, lifetime: true });
		expect(await probe.current(original)).toEqual({ widget: false, lifetime: false });

		await manager.dispose({ timeoutMs: 100 });
		expect(await probe.current(successor)).toEqual({ widget: false, lifetime: false });
	});

	it("preserves missing root authority instead of inventing a worker admission", async () => {
		const owner = await probe.capture(manager);
		expect(await probe.current(owner)).toEqual({ widget: undefined, lifetime: undefined });
	});

	it("authors widgets for worker-registered bash jobs with inherited SDK admission", async () => {
		const authStorage = createInMemoryAuthStorage();
		const provider = "async-widget-service-synthetic";
		const source = "async-widget-service-regression";
		const settings = Settings.isolated({
			"async.enabled": true,
			"async.widgets": true,
			"async.widgetRemoteAuthoring": true,
			"launch.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: process.platform === "win32" ? procmgr.resolveWindowsShell() : "/bin/sh",
			modelRoles: { widget: `${provider}/widget-model` },
		});
		const registry = new ModelRegistry(authStorage, path.join(dir, "models.yml"), { settings });
		registry.registerProvider(
			provider,
			{
				baseUrl: "https://widget.synthetic.invalid",
				apiKey: "synthetic-widget-key",
				api: "async-widget-service-api",
				models: [
					{
						id: "widget-model",
						name: "Widget",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 32000,
						maxTokens: 3000,
					},
				],
				streamSimple: (selected, context, options) => {
					const stream = createAssistantMessageEventStream();
					const answer = context.tools?.some(tool => tool.name === "respond")
						? JSON.stringify(SPEC)
						: "Measures request throughput until cancelled.";
					const message = {
						...createAssistantMessage(answer),
						api: selected.api,
						provider: selected.provider,
						model: selected.id,
					};
					void (async () => {
						try {
							await resolveApiKeyOnce(options?.apiKey, options?.signal);
							await options?.onPayload?.({ widget: true }, selected, options?.signal);
							stream.push({ type: "start", partial: message });
							stream.push({ type: "done", reason: "stop", message });
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
			source,
		);
		let session: AgentSession | undefined;
		try {
			const model = registry.find(provider, "widget-model");
			if (!model) throw new Error("Synthetic widget model is missing");
			({ session } = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				authStorage,
				modelRegistry: registry,
				model,
				settings,
				agentRegistry: new AgentRegistry(),
				agentId: "WidgetRoot",
				sessionManager: SessionManager.inMemory(dir),
				bindProcessState: false,
				cacheWarming: false,
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
			}));
			const rootManager = session.asyncJobManager;
			if (!(rootManager instanceof AsyncJobManager)) throw new Error("SDK root job manager is missing");
			await manager.dispose({ timeoutMs: 100 });
			manager = rootManager;
			const widgets = manager.widgets;
			if (!widgets) throw new Error("SDK root widget registry is missing");
			const assertAuthored = async (job: AsyncJob) => {
				// The SDK registry retains its production age and output thresholds.
				job.startTime = Date.now() - 16_000;
				widgets.view(job);
				await widgets.drain();
				expect(widgets.view(job)).toMatchObject({
					state: "live",
					headline: { text: "30 req/s" },
					blocks: [{ kind: "spark", values: [10, 20, 30], last: "30" }],
				});
				expect(widgets.caption(job)).toBe("Measures request throughput until cancelled");
			};
			const command = "printf 'req 1 rps=10\\nreq 2 rps=20\\nreq 3 rps=30\\n'; sleep 60";
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Main bash tool is missing");
			const ready = Promise.withResolvers<void>();
			await bash.execute(
				"main-widget-control",
				{ command, async: true, pty: false, timeout: 0 },
				undefined,
				update => {
					if (update.content.some(block => block.type === "text" && block.text.includes("req 3 rps=30"))) {
						ready.resolve();
					}
				},
			);
			const control = manager.getRunningJobs({ ownerId: "WidgetRoot" })[0];
			if (!control) throw new Error("Main bash did not register a running job");
			await Promise.race([
				ready.promise,
				control.promise.then(() => {
					throw new Error("Main bash ended before producing the widget sample");
				}),
			]);
			await assertAuthored(control);
			manager.cancel(control.id);
			await control.promise;

			const id = await probe.startBash(manager, model, dir, command);
			const job = manager.getJob(id);
			if (!job) throw new Error("Worker bash did not register on the root manager");
			job.widgetInputs?.sources();
			await probe.barrier();
			await probe.barrier();
			await assertAuthored(job);
		} finally {
			await probe.stopBash();
			await session?.dispose();
			registry.clearSourceRegistrations(source);
			await authStorage.close();
		}
	}, 60_000);

	it("invalidates on main and drains admitted persistence even after the manager detaches its widgets", async () => {
		const usageFile = path.join(dir, "usage.jsonl");
		await fs.writeFile(usageFile, "");
		const entered = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		releaseGates.push(release.resolve);
		let generation = 0;
		manager.captureWidgetOwnerCurrent = () => {
			const captured = generation;
			return () => captured === generation;
		};
		const root: AsyncJobManagerApi = manager;
		const canAuthor = root.captureWidgetOwnerCurrent?.();
		if (!canAuthor) throw new Error("Missing root widget authority");
		const widgets = new JobWidgets({
			authorAfterMs: 0,
			minIngestMs: 0,
			author: async (_request, signal) => {
				entered.resolve(signal);
				await release.promise;
				await fs.appendFile(usageFile, '{"tokens":14}\n');
				return SPEC;
			},
		});
		manager.widgets = widgets;
		const output = new TextTap("out", "load test output");
		output.append("req 1 rps=10\nreq 2 rps=20\nreq 3 rps=30\n");
		const finished = Promise.withResolvers<string>();
		releaseGates.push(() => finished.resolve("done"));
		const id = manager.register(
			"bash",
			"load test",
			({ signal }) => {
				signal.addEventListener("abort", () => finished.resolve("cancelled"), { once: true });
				return finished.promise;
			},
			{
				widgetInputs: {
					canAuthor,
					sources: () => [output],
					brief: () => ({ kind: "bash", command: "load test" }),
				},
			},
		);
		const job = manager.getJob(id);
		if (!job) throw new Error("Missing root job");
		expect((await probe.view(manager, id))?.state).toBe("authoring");
		const signal = await entered.promise;
		generation++;
		await probe.invalidate(manager);
		expect(signal.aborted).toBe(true);

		const disposing = manager.dispose({ timeoutMs: 100 });
		expect(manager.widgets).toBeUndefined();
		let drained = false;
		const draining = probe.drain(manager).then(() => {
			drained = true;
		});
		// Two link barriers also process an incorrectly early drain response.
		await probe.barrier();
		await probe.barrier();
		expect(drained).toBe(false);
		expect(await fs.readFile(usageFile, "utf8")).toBe("");

		release.resolve();
		await Promise.all([disposing, draining]);
		expect(await fs.readFile(usageFile, "utf8")).toBe('{"tokens":14}\n');
		expect(widgets.view(job)).toBeUndefined();
	});
});
