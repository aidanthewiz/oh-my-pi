import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const originalSchedulerWait = scheduler.wait.bind(scheduler);

describe("AgentSession context promotion", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let small: Model;
	let large: Model;
	let text: Model;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-context-promotion-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("promotion-codex", "test-key");
		authStorage.keys.setRuntime("promotion-text", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const definition = {
			name: "Promotion fixture",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 1024,
		};
		modelRegistry.registerProvider("promotion-codex", {
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "test-key",
			api: "openai-codex-responses",
			models: [
				{ ...definition, id: "small", contextWindow: 32_768, contextPromotionTarget: "promotion-codex/large" },
				{ ...definition, id: "large", contextWindow: 131_072 },
			],
		});
		modelRegistry.registerProvider("promotion-text", {
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [{ ...definition, id: "text", contextWindow: 32_768 }],
		});
		const requireModel = (provider: string, id: string): Model => {
			const model = modelRegistry.find(provider, id);
			if (!model) throw new Error(`Missing fixture model ${provider}/${id}`);
			return model;
		};
		small = requireModel("promotion-codex", "small");
		large = requireModel("promotion-codex", "large");
		text = requireModel("promotion-text", "text");
		vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => originalSchedulerWait(0, options));
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			vi.restoreAllMocks();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	function makeSession(model: Model = small, promotion = false, overflow = false) {
		const requested: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: selected => {
				requested.push(selected.id);
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const failure = overflow && requested.length === 1;
					const message = boundary(selected, failure ? "error" : "stop");
					if (!failure) message.content = [{ type: "text", text: "Recovered after promotion" }];
					stream.push({ type: "start", partial: message });
					if (failure) stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "contextPromotion.enabled": promotion }),
			modelRegistry,
		});
		return { session, requested };
	}

	function boundary(model: Model, stopReason: "stop" | "length" | "error" = "stop"): AssistantMessage {
		return {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: stopReason === "length" ? [{ type: "thinking", thinking: "" }] : [{ type: "text", text: "" }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			...(stopReason === "error"
				? { errorMessage: "context_length_exceeded: input exceeds the context window" }
				: {}),
			timestamp: Date.now(),
		};
	}

	function cacheReplay(active: AgentSession) {
		const close = vi.fn();
		active.providerSessionState.set("openai-codex-responses", { close } satisfies ProviderSessionState);
		return close;
	}

	it.each(["direct", "temporary"] as const)("evicts Codex replay on a %s model switch", async kind => {
		const { session: active } = makeSession(kind === "direct" ? small : text);
		const target = kind === "direct" ? text : small;
		const close = cacheReplay(active);
		if (kind === "direct") await active.setModel(target);
		else await active.setModelTemporary(target);
		expect(active.model?.provider).toBe(target.provider);
		expect(active.model?.id).toBe(target.id);
		expect(close).toHaveBeenCalledTimes(1);
		expect(active.providerSessionState.has("openai-codex-responses")).toBe(false);
	});

	it.each(["branch", "navigate"] as const)("evicts Codex replay when %s rewrites history", async kind => {
		const { session: active } = makeSession();
		const manager = active.sessionManager;
		const firstUser = manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		manager.appendMessage(boundary(small));
		manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
		manager.appendMessage(boundary(small));
		active.agent.replaceMessages(manager.buildSessionContext().messages);
		const close = cacheReplay(active);
		const result =
			kind === "branch"
				? await active.branch(firstUser)
				: await active.navigateTree(firstUser, { summarize: false });
		expect(result.cancelled).toBe(false);
		expect(active.messages.some(message => message.role === "user" && message.content === "second")).toBe(false);
		expect(close).toHaveBeenCalledTimes(1);
		expect(active.providerSessionState.has("openai-codex-responses")).toBe(false);
	});

	it("keeps the active model and replay when promotion is disabled", async () => {
		const { session: active, requested } = makeSession();
		const close = cacheReplay(active);
		const failure = boundary(small, "error");
		active.agent.emitExternalEvent({ type: "message_end", message: failure });
		active.agent.emitExternalEvent({ type: "agent_end", messages: [failure] });
		await active.waitForIdle();
		expect(active.model?.id).toBe(small.id);
		expect(close).not.toHaveBeenCalled();
		expect(active.providerSessionState.has("openai-codex-responses")).toBe(true);
		expect(requested).toEqual([]);
	});

	it("ignores a stale incomplete response from the previous model", async () => {
		const { session: active, requested } = makeSession(large, true);
		const close = cacheReplay(active);
		const stale = boundary(small, "length");
		active.agent.emitExternalEvent({ type: "message_end", message: stale });
		active.agent.emitExternalEvent({ type: "agent_end", messages: [stale] });
		await active.waitForIdle();
		expect(active.model?.id).toBe(large.id);
		expect(close).not.toHaveBeenCalled();
		expect(requested).toEqual([]);
	});

	it("waits for the promoted continuation before resolving the prompt", async () => {
		const { session: active, requested } = makeSession(small, true, true);
		const close = cacheReplay(active);
		await active.prompt("Handle overflow");
		expect(requested).toEqual([small.id, large.id]);
		expect(active.model?.id).toBe(large.id);
		expect(active.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "Recovered after promotion" }]);
		expect(active.isStreaming).toBe(false);
		expect(close).toHaveBeenCalledTimes(1);
		expect(active.providerSessionState.has("openai-codex-responses")).toBe(false);
	});
});
