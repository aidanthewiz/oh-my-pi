import { afterEach, describe, expect, it } from "bun:test";
import type { ReadyInfo, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { buildTabWorkerEnv, initializeTabWorkerForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

class FakeStartupWorker {
	#errorHandlers = new Set<(error: Error) => void>();
	#messageHandlers = new Set<(msg: WorkerOutbound) => void>();
	readonly sent: WorkerInbound[] = [];
	readonly mode = "worker" as const;

	send(msg: WorkerInbound): void {
		this.sent.push(msg);
	}

	onMessage(handler: (msg: WorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {}

	emitReady(info: ReadyInfo): void {
		for (const handler of this.#messageHandlers) handler({ type: "ready", info });
	}

	emitError(error: Error): void {
		for (const handler of this.#errorHandlers) handler(error);
	}
}

const initPayload = {
	mode: "headless" as const,
	browserWSEndpoint: "ws://127.0.0.1/devtools/browser/test",
	safeDir: "/tmp/omp-puppeteer",
	timeoutMs: 1_000,
};
const SECRET_KEY = "BROWSER_WORKER_PARENT_SECRET";
const MANAGED_SECRET_KEY = "OMP_MANAGED_BROWSER_WORKER_SECRET";

afterEach(() => {
	delete Bun.env[SECRET_KEY];
	delete Bun.env[MANAGED_SECRET_KEY];
});

describe("browser tab worker startup", () => {
	it("surfaces worker startup errors instead of waiting for the generic init timeout", async () => {
		const worker = new FakeStartupWorker();
		const pending = initializeTabWorkerForTest(worker, initPayload, 1_000);

		worker.emitError(new Error("Cannot find tab-worker-entry.ts"));

		await expect(pending).rejects.toThrow("Tab worker failed during startup: Cannot find tab-worker-entry.ts");
		expect(worker.sent).toEqual([{ type: "init", payload: initPayload }]);
	});
	it("scrubs ambient and managed credentials from the worker environment", () => {
		Bun.env[SECRET_KEY] = "ambient-secret";
		Bun.env[MANAGED_SECRET_KEY] = "managed-secret";

		const env = buildTabWorkerEnv();

		expect(env[SECRET_KEY]).toBeUndefined();
		expect(env[MANAGED_SECRET_KEY]).toBeUndefined();
		expect(env.PATH ?? "").toBe(Bun.env.PATH ?? "");
	});
});
