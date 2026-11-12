import { type MessagePort, parentPort } from "node:worker_threads";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { procmgr } from "@oh-my-pi/pi-utils";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type { AsyncJobManagerApi } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { JobWidgetRegistry } from "../../src/job-widgets/types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { setCurrentThreadId } from "../../src/thread/identity";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { threadServices } from "../../src/thread/services/index";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

export interface AsyncJobsProbe {
	capture(manager: AsyncJobManagerApi): Promise<number>;
	current(id: number): Promise<{ widget: boolean | undefined; lifetime: boolean | undefined }>;
	startBash(manager: AsyncJobManagerApi, model: Model, cwd: string, command: string): Promise<string>;
	stopBash(): Promise<void>;
	view(manager: AsyncJobManagerApi, jobId: string): Promise<JobWidgetView | undefined>;
	invalidate(manager: AsyncJobManagerApi): Promise<void>;
	drain(manager: AsyncJobManagerApi): Promise<void>;
	barrier(): Promise<void>;
}

interface CapturedOwner {
	widget: (() => boolean) | undefined;
	lifetime: (() => boolean) | undefined;
}

function widgets(manager: AsyncJobManagerApi): JobWidgetRegistry {
	const registry = manager.widgets;
	if (!registry) throw new Error("Root has no widget registry");
	return registry;
}

function isTestGlobals(value: unknown): value is { ready(probe: AsyncJobsProbe): void } {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const captures = new Map<number, CapturedOwner>();
let nextCapture = 1;
let stopBash: (() => Promise<void>) | undefined;
const probe: AsyncJobsProbe = {
	capture: async manager => {
		const id = nextCapture++;
		captures.set(id, {
			widget: manager.captureWidgetOwnerCurrent?.(),
			lifetime: manager.captureOwnerLifetimeCurrent?.(),
		});
		return id;
	},
	current: async id => {
		const capture = captures.get(id);
		if (!capture) throw new Error("No captured root owner");
		return { widget: capture.widget?.(), lifetime: capture.lifetime?.() };
	},
	startBash: async (manager, model, cwd, command) => {
		const authStorage = createInMemoryAuthStorage();
		const settings = Settings.isolated({
			"async.enabled": true,
			"async.widgets": true,
			"async.widgetRemoteAuthoring": true,
			"launch.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: process.platform === "win32" ? procmgr.resolveWindowsShell() : "/bin/sh",
		});
		const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "worker-models.yml"), { settings });
		let session: AgentSession | undefined;
		stopBash = async () => {
			await session?.dispose();
			await authStorage.close();
		};
		try {
			({ session } = await createAgentSession({
				cwd,
				agentDir: cwd,
				authStorage,
				modelRegistry,
				model,
				settings,
				agentRegistry: new AgentRegistry(),
				agentId: "WidgetWorker",
				parentTaskPrefix: "WidgetWorker",
				taskDepth: 1,
				asyncJobManager: manager,
				sessionManager: SessionManager.inMemory(cwd),
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
			const bash = session.getToolByName("bash");
			if (!bash) throw new Error("Worker bash tool is missing");
			const ready = Promise.withResolvers<void>();
			await bash.execute("worker-widget", { command, async: true, pty: false, timeout: 0 }, undefined, update => {
				if (update.content.some(block => block.type === "text" && block.text.includes("req 3 rps=30"))) {
					ready.resolve();
				}
			});
			const job = manager.getRunningJobs({ ownerId: "WidgetWorker" })[0];
			if (!job) throw new Error("Worker bash did not register a running job");
			await Promise.race([
				ready.promise,
				job.promise.then(() => {
					throw new Error("Worker bash ended before producing the widget sample");
				}),
			]);
			return job.id;
		} catch (error) {
			await probe.stopBash();
			throw error;
		}
	},
	stopBash: async () => {
		const stop = stopBash;
		stopBash = undefined;
		await stop?.();
	},
	view: async (manager, jobId) => {
		const job = manager.getJob(jobId);
		if (!job) throw new Error("No root job");
		return widgets(manager).view(job);
	},
	invalidate: async manager => widgets(manager).invalidate(),
	drain: async manager => widgets(manager).drain(),
	// Frames from prior operations reach main before this response.
	barrier: async () => {},
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
		{ name: "async-jobs-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	const services = threadServices().filter(
		service =>
			service === identityThreadService || service === agentsThreadService || service === asyncJobsThreadService,
	);
	for (const service of services) service.installWorker?.(link);
	link.handle("boot", async globals => {
		for (const service of services) await service.boot?.(globals[service.name], link);
		if (!isTestGlobals(globals.test)) throw new Error("missing test globals");
		await globals.test.ready(probe);
	});
	port.postMessage({ ready: true });
});
