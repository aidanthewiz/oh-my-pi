import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as daemonClientModule from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient, DaemonTunnel, UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as titleClient from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { TinyWorkerRequest, TinyWorkerResponse } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import { TempDir } from "@oh-my-pi/pi-utils";

const modelSpec: ModelSpec<Api> = {
	id: "tiny-client-dispose",
	name: "Tiny client dispose",
	api: "test-tiny-client-dispose",
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
};
const model = buildModel(modelSpec);

const TINY_MODEL = "qwen3-1.7b";

/** Stands in for the tiny-model worker; replies only when the test emits one. */
class FakeTinyWorker {
	#messageHandlers = new Set<(message: TinyWorkerResponse) => void>();
	#requests: TinyWorkerRequest[] = [];
	#waiters: Array<(request: TinyWorkerRequest) => void> = [];

	send(message: TinyWorkerRequest): void {
		if (message.type === "ping") return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter(message);
		else this.#requests.push(message);
	}

	/** Resolves with the next non-ping request the client sends. */
	nextRequest(): Promise<TinyWorkerRequest> {
		const queued = this.#requests.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<TinyWorkerRequest>();
		this.#waiters.push(resolve);
		return promise;
	}

	onMessage(handler: (message: TinyWorkerResponse) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	emit(message: TinyWorkerResponse): void {
		for (const handler of this.#messageHandlers) handler(message);
	}
}

function inferDaemon(worker: FakeTinyWorker): DaemonClient {
	const unit: UnitSnapshot = {
		id: "tiny-fixture",
		kind: "infer",
		scope: { kind: "global" },
		key: TINY_MODEL,
		label: TINY_MODEL,
		generation: "fixture-generation",
		state: "running",
		pids: [],
		createdAt: 0,
		startedAt: 0,
		restartCount: 0,
		outputBytes: 0,
		leases: 1,
		policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
		supervised: true,
	};
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	return {
		open: async () => ({ unit, lease: crypto.randomUUID(), created: false }),
		attach: async () => {
			let unsubscribe: (() => void) | undefined;
			return {
				unit,
				send(data) {
					const text = typeof data === "string" ? data : decoder.decode(data);
					for (const line of text.trim().split("\n")) worker.send(JSON.parse(line));
					return true;
				},
				start(onData) {
					unsubscribe = worker.onMessage(message => onData(encoder.encode(`${JSON.stringify(message)}\n`)));
				},
				close: () => unsubscribe?.(),
				drained: async () => {},
				ref() {},
				unref() {},
			} satisfies DaemonTunnel;
		},
		release: async () => {},
		onReconnect: () => () => {},
	} as unknown as DaemonClient;
}

// Only the process-owning session closes its shared client tunnels; daemon workers may serve other processes.
describe("tiny-model client shutdown on session dispose", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			if (!session.isDisposed) await session.dispose();
		}
		await titleClient.tinyTitleClient.terminate();
		vi.restoreAllMocks();
	});

	const starter = async (tempDir: TempDir) => {
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const start = async (
			settings: Settings,
			extra: Pick<CreateAgentSessionOptions, "parentTaskPrefix" | "taskDepth" | "agentId" | "bindProcessState"> = {},
		): Promise<AgentSession> => {
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				...extra,
			});
			sessions.push(session);
			return session;
		};
		return {
			start,
			close: async () => {
				for (const session of sessions.splice(0)) {
					if (!session.isDisposed) await session.dispose();
				}
				await authStorage.close();
			},
		};
	};

	it("keeps pending requests alive until the parent's first dispose", async () => {
		using tempDir = TempDir.createSync("@pi-tiny-client-dispose-");
		const { start, close } = await starter(tempDir);
		const worker = new FakeTinyWorker();
		vi.spyOn(titleClient, "tinyWorkerUsesMlx").mockReturnValue(false);
		vi.spyOn(daemonClientModule, "daemonClient").mockResolvedValue(inferDaemon(worker));
		const client = titleClient.tinyTitleClient;
		try {
			const parentSettings = Settings.isolated({ "compaction.enabled": false });
			const parent = await start(parentSettings);
			const sub = await start(createSubagentSettings(parentSettings), {
				parentTaskPrefix: "0-Sub",
				taskDepth: 1,
				agentId: "0-Sub",
			});
			const helper = await start(await parentSettings.cloneForCwd(tempDir.path()), { bindProcessState: false });

			// A subagent or helper finishing leaves the parent's request running.
			const first = client.complete(TINY_MODEL, "first");
			const firstRequest = await worker.nextRequest();
			await sub.dispose();
			await helper.dispose();
			worker.emit({ type: "text", id: firstRequest.id, text: "kept" });
			expect(await first).toBe("kept");

			// The parent owns process state: its dispose fails what is still in flight.
			const second = client.complete(TINY_MODEL, "second");
			await worker.nextRequest();
			await parent.dispose();
			expect(await second).toBeNull();

			// A repeat dispose must not cancel requests made after the first one.
			const third = client.complete(TINY_MODEL, "third");
			const thirdRequest = await worker.nextRequest();
			await parent.dispose();
			worker.emit({ type: "text", id: thirdRequest.id, text: "after" });
			expect(await third).toBe("after");
		} finally {
			await close();
		}
	});
});
