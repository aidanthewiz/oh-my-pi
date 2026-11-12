import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { AsyncJobManager, type AsyncJob } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry, type AgentRef } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { agentsThreadService } from "../../src/thread/services/agents";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { identityThreadService } from "../../src/thread/services/identity";
import { threadServices } from "../../src/thread/services/index";
import { cfgAsyncWidgets } from "../../src/tools/settings";
import type {
	InvalidProducer,
	ProducerCustodyProbe,
	WorkerProducerProbe,
} from "../fixtures/widget-producer-custody-worker";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";

const PROGRESS_MATCH = String.raw`^req \d+ rps=(?P<rps>[\d.]+)`;
const SPEC = {
	title: "throughput",
	rules: [
		{ from: "*", match: PROGRESS_MATCH },
		{ from: "tools", match: PROGRESS_MATCH },
	],
	blocks: [{ kind: "spark", field: "rps", label: "requests", unit: "req/s" }],
	headline: { field: "rps", agg: "last", unit: "req/s" },
};

const INVALID: InvalidProducer[] = ["absent", "forged", "session", "kind", "manager", "replay", "lifetime", "capture"];

describe("worker widget producer admission", () => {
	let dir: string;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let root: AgentSession;
	let manager: AsyncJobManager;
	let widgets: NonNullable<AsyncJobManager["widgets"]>;
	let worker: ServiceWorker<ProducerCustodyProbe> | undefined;
	let producer: WorkerProducerProbe;
	let hold: boolean;
	let release: PromiseWithResolvers<void>;
	let specEntered: PromiseWithResolvers<AbortSignal>;
	let captionEntered: PromiseWithResolvers<AbortSignal>;
	let other: AsyncJobManager | undefined;
	let replacement: AgentRef | undefined;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-widget-producer-"));
		auth = createInMemoryAuthStorage();
		hold = false;
		release = Promise.withResolvers<void>();
		specEntered = Promise.withResolvers<AbortSignal>();
		captionEntered = Promise.withResolvers<AbortSignal>();
		const settings = Settings.isolated({
			"async.widgets": true,
			"async.widgetRemoteAuthoring": true,
			enabledModels: ["producer-custody-synthetic/widget-model"],
			"retry.enabled": false,
			modelRoles: { widget: "producer-custody-synthetic/widget-model" },
		});
		registry = new ModelRegistry(auth, path.join(dir, "models.yml"), { settings });
		registry.registerProvider(
			"producer-custody-synthetic",
			{
				baseUrl: "https://widget.synthetic.invalid",
				apiKey: "synthetic-widget-key",
				api: "producer-custody-api",
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
					const spec = context.tools?.some(tool => tool.name === "respond");
					const message = {
						...createAssistantMessage(
							spec ? JSON.stringify(SPEC) : "Measures request throughput until cancelled.",
						),
						api: selected.api,
						provider: selected.provider,
						model: selected.id,
					};
					message.usage = { ...message.usage, input: 11, output: 3, totalTokens: 14 };
					void (async () => {
						try {
							await resolveApiKeyOnce(options?.apiKey, options?.signal);
							await options?.onPayload?.({ widget: true }, selected, options?.signal);
							if (!options?.signal) throw new Error("Missing real model-request signal");
							(spec ? specEntered : captionEntered).resolve(options.signal);
							if (hold) await release.promise;
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
			"producer-custody-test",
		);
		const model = registry.find("producer-custody-synthetic", "widget-model");
		if (!model) throw new Error("Missing synthetic widget model");
		({ session: root } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			authStorage: auth,
			modelRegistry: registry,
			model,
			settings,
			agentRegistry: new AgentRegistry(),
			agentId: "CustodyRoot",
			sessionManager: SessionManager.create(dir, path.join(dir, "sessions")),
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
			toolNames: [],
			restrictToolNames: true,
		}));
		if (!(root.asyncJobManager instanceof AsyncJobManager)) throw new Error("Missing canonical SDK root manager");
		manager = root.asyncJobManager;
		if (!manager.widgets) throw new Error("Missing canonical SDK widget registry");
		widgets = manager.widgets;
		worker = await startServiceWorker<ProducerCustodyProbe>(
			new URL("../fixtures/widget-producer-custody-worker.ts", import.meta.url),
			threadServices().filter(
				service =>
					service === identityThreadService ||
					service === agentsThreadService ||
					service === asyncJobsThreadService,
			),
		);
		producer = await worker.probe.open(manager, model, dir);
	});

	afterEach(async () => {
		release.resolve();
		if (worker) await producer?.dispose();
		await other?.dispose({ timeoutMs: 500 });
		other = undefined;
		await root?.dispose();
		await worker?.stop();
		worker = undefined;
		if (replacement) AgentRegistry.global().unregister(replacement.id, replacement);
		replacement = undefined;
		registry?.clearSourceRegistrations("producer-custody-test");
		await auth?.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function prepare(id: string, owner = manager): Promise<AsyncJob> {
		const job = owner.getJob(id);
		if (!job) throw new Error("Missing canonical registered job");
		job.startTime = Date.now() - 16_000;
		job.widgetInputs?.sources();
		await producer.barrier();
		await producer.barrier();
		return job;
	}

	it("authors a queued Task producer after its actual canonical owner and run become live", async () => {
		const { id } = await producer.startTask();
		const job = await prepare(id);
		widgets.view(job);
		await widgets.drain();
		expect(widgets.view(job)).toMatchObject({
			state: "live",
			headline: { text: "30 req/s" },
			blocks: [{ kind: "spark", values: [10, 20, 30], last: "30 req/s" }],
		});
	}, 60_000);

	it("authors a Task already running before worker background registration", async () => {
		const { id } = await producer.startTask(false, false, true);
		const job = await prepare(id);
		widgets.view(job);
		await widgets.drain();
		expect(widgets.view(job)).toMatchObject({
			state: "live",
			headline: { text: "30 req/s" },
			blocks: [{ kind: "spark", values: [10, 20, 30], last: "30 req/s" }],
		});
	}, 60_000);

	it("renews Task admission for an SDK-authorized physical retry without retargeting its owner", async () => {
		hold = true;
		const { id } = await producer.startTask(false, true);
		const job = await prepare(id);
		expect(widgets.view(job)?.state).toBe("authoring");
		const signal = await specEntered.promise;
		await producer.retryTaskRun();
		expect(signal.aborted).toBe(false);
		release.resolve();
		await widgets.drain();
		expect(widgets.view(job)).toMatchObject({
			state: "live",
			headline: { text: "30 req/s" },
			blocks: [{ kind: "spark", values: [10, 20, 30], last: "30 req/s" }],
		});
	}, 60_000);

	it("does not renew Task custody when a fresh prompt supersedes an SDK-authorized retry", async () => {
		hold = true;
		const { id } = await producer.startTask(false, true);
		const job = await prepare(id);
		expect(widgets.view(job)?.state).toBe("authoring");
		const signal = await specEntered.promise;
		await producer.replaceTaskContinuation();
		expect(signal.aborted).toBe(true);
		release.resolve();
		await widgets.drain();
		const view = widgets.view(job);
		expect(view?.headline).toBeUndefined();
		expect(view?.blocks.some(block => block.kind === "spark")).toBe(false);
	}, 60_000);

	it("rejects a copied Task ref instead of accepting its serialized id and generation", async () => {
		const { id } = await producer.startTask(true);
		const job = await prepare(id);
		widgets.view(job);
		await widgets.drain();
		expect(widgets.view(job)?.state).toBe("fallback");
		expect(root.sessionManager.getUsageStatistics().totalTokens).toBe(0);
	}, 60_000);

	it.each(["ref", "run"] as const)(
		"revokes a Task producer when its canonical %s generation changes",
		async mode => {
			hold = true;
			const { id, owner } = await producer.startTask();
			const job = await prepare(id);
			expect(widgets.view(job)?.state).toBe("authoring");
			const signal = await specEntered.promise;
			if (mode === "ref") {
				replacement = AgentRegistry.global().register({
					id: owner.id,
					displayName: owner.displayName,
					kind: "sub",
					session: owner.session,
					status: "running",
				});
			} else {
				await producer.nextTaskRun();
			}
			expect(signal.aborted).toBe(true);
			release.resolve();
			await widgets.drain();
			const view = widgets.view(job);
			expect(view?.headline).toBeUndefined();
			expect(view?.blocks.some(block => block.kind === "spark")).toBe(false);
		},
		60_000,
	);

	it.each(["root", "session", "worker-producer", "main-producer", "inputs", "row", "peer"] as const)(
		"rejects a late Bash answer after %s custody is revoked",
		async mode => {
			hold = true;
			const job = await prepare(await producer.startBash());
			expect(widgets.view(job)?.state).toBe("authoring");
			await specEntered.promise;
			let inspected = job;
			if (mode === "root") {
				cfgAsyncWidgets.override(root.settings, false);
				cfgAsyncWidgets.override(root.settings, true);
			} else if (mode === "session") await producer.changeSession();
			else if (mode === "worker-producer") {
				await producer.replaceStreams(job.id);
				job.widgetInputs?.sources();
				await producer.barrier();
				await producer.barrier();
			} else if (mode === "main-producer") {
				job.process = { command: "replacement producer", cwd: dir, pids: () => [] };
			} else if (mode === "inputs") job.widgetInputs = { ...job.widgetInputs! };
			else if (mode === "row") {
				manager.cancel(job.id);
				await job.promise;
				manager.evictCompletedJobs();
				const done = Promise.withResolvers<string>();
				const id = manager.register(
					"bash",
					"replacement row",
					({ signal }) => {
						signal.addEventListener("abort", () => done.resolve("cancelled"), { once: true });
						return done.promise;
					},
					{ id: job.id, process: job.process, widgetInputs: job.widgetInputs },
				);
				inspected = manager.getJob(id)!;
				inspected.startTime = Date.now() - 16_000;
			} else {
				await worker!.stop();
				worker = undefined;
			}
			release.resolve();
			await widgets.drain();
			const view = widgets.view(inspected);
			expect(view?.headline).toBeUndefined();
			expect(view?.blocks.some(block => block.kind === "spark")).toBe(false);
		},
		60_000,
	);

	it.each(INVALID)(
		"keeps %s producer custody local without new model usage",
		async mode => {
			const control = await prepare(await producer.startBash());
			widgets.view(control);
			await widgets.drain();
			expect(widgets.view(control)?.headline?.text).toBe("30 req/s");
			const spent = root.sessionManager.getUsageStatistics().totalTokens;
			if (mode === "manager") {
				other = new AsyncJobManager({});
			}
			const destination = other ?? manager;
			const job = await prepare(await producer.registerInvalid(mode, other), destination);
			const registry = widgets;
			registry.view(job);
			await registry.drain();
			expect(registry.view(job)).toMatchObject({ state: "fallback", stage: "req 3 rps=30" });
			expect(registry.caption(job)).toBeUndefined();
			expect(root.sessionManager.getUsageStatistics().totalTokens).toBe(spent);
		},
		60_000,
	);

	it("drains admitted worker callbacks before the root journal closes", async () => {
		hold = true;
		const job = await prepare(await producer.startBash());
		widgets.view(job);
		await Promise.all([specEntered.promise, captionEntered.promise]);
		const journal = root.sessionManager.getSessionFile();
		if (!journal) throw new Error("Missing originating widget journal");
		let closed = false;
		const closing = root.dispose().then(() => {
			closed = true;
		});
		await producer.barrier();
		await producer.barrier();
		expect(closed).toBe(false);
		expect(root.sessionManager.getUsageStatistics().totalTokens).toBe(0);
		release.resolve();
		await closing;
		const receipts = (await fs.readFile(journal, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line))
			.filter(entry => entry.type === "model_usage")
			.map(entry => [entry.purpose, entry.usage.totalTokens])
			.sort();
		expect(receipts).toEqual([
			["job-caption", 14],
			["job-widget", 14],
		]);
		expect(widgets.view(job)).toBeUndefined();
	}, 60_000);
});
