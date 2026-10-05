import { expect, test } from "bun:test";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ExtensionAPI } from "../src/extensibility/extensions/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

async function makeSession() {
	const runtime = new ExtensionRuntime();
	const manager = SessionManager.inMemory();
	let api!: ExtensionAPI;
	const extension = await loadExtensionFromFactory(
		extensionApi => {
			api = extensionApi;
		},
		manager.getCwd(),
		new EventBus(),
		runtime,
	);
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	const runner = new ExtensionRunner([extension], runtime, manager.getCwd(), manager, registry);
	const agent = new Agent({ initialState: { systemPrompt: [], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: registry,
		extensionRunner: runner,
	});
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "x" }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return {
		authStorage,
		api,
		session,
		agent,
		message,
		emit(delta: string) {
			const update: AgentEvent = {
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
			};
			agent.emitExternalEvent(update);
		},
	};
}

test("async message_update handlers finish before the next update starts", async () => {
	const { api, authStorage, session, emit } = await makeSession();
	const firstStarted = Promise.withResolvers<void>();
	const releaseFirst = Promise.withResolvers<void>();
	const secondDone = Promise.withResolvers<void>();
	const order: string[] = [];
	api.on("message_update", async event => {
		if (event.assistantMessageEvent.type !== "text_delta") return;
		const delta = event.assistantMessageEvent.delta;
		order.push(`start:${delta}`);
		if (delta === "A") {
			firstStarted.resolve();
			await releaseFirst.promise;
		}
		order.push(`end:${delta}`);
		if (delta === "B") secondDone.resolve();
	});
	try {
		emit("A");
		emit("B");
		await firstStarted.promise;
		expect(order).toEqual(["start:A"]);
		releaseFirst.resolve();
		await secondDone.promise;
		expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
	} finally {
		releaseFirst.resolve();
		await session.dispose();
		authStorage.close();
	}
});

test("a failing message_update handler does not block later updates", async () => {
	const { api, authStorage, session, emit } = await makeSession();
	const received: string[] = [];
	const laterUpdate = Promise.withResolvers<void>();
	api.on("message_update", event => {
		if (event.assistantMessageEvent.type !== "text_delta") return;
		if (event.assistantMessageEvent.delta === "A") throw new Error("expected handler failure");
		received.push(event.assistantMessageEvent.delta);
		laterUpdate.resolve();
	});
	try {
		emit("A");
		emit("B");
		await laterUpdate.promise;
		expect(received).toEqual(["B"]);
	} finally {
		await session.dispose();
		authStorage.close();
	}
});

test("terminal lifecycle waits for queued updates and idle drains their handlers", async () => {
	const { api, authStorage, session, agent, message, emit } = await makeSession();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const terminalFrame = Promise.withResolvers<void>();
	const order: string[] = [];
	api.on("message_update", async () => {
		order.push("update:start");
		started.resolve();
		await release.promise;
		order.push("update:end");
	});
	api.on("message_end", () => {
		order.push("message:end");
	});
	api.on("turn_end", () => {
		order.push("turn:end");
	});
	session.subscribe(event => {
		if (event.type === "turn_end") terminalFrame.resolve();
	});
	try {
		emit("A");
		await started.promise;
		agent.emitExternalEvent({ type: "message_end", message });
		agent.emitExternalEvent({ type: "turn_end", message, toolResults: [] });
		await terminalFrame.promise;
		expect(order).toEqual(["update:start"]);
		const idle = session.waitForIdle();
		release.resolve();
		await idle;
		expect(order).toEqual(["update:start", "update:end", "message:end", "turn:end"]);
	} finally {
		release.resolve();
		await session.dispose();
		authStorage.close();
	}
});
