import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { ToolPathWithSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import type { LoadExtensionsResult, PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

import { cfgTierAnthropic, cfgTierGoogle, cfgTierOpenai } from "@oh-my-pi/pi-coding-agent/session/settings";

function createMockSession(
	onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void | Promise<void>,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let disposed = false;
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		get isDisposed() {
			return disposed;
		},
		dispose: async () => {
			disposed = true;
		},
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			await onPrompt({ emit });
			return true;
		},
	};
	return session as unknown as AgentSession;
}

function emitYield(emit: (event: AgentSessionEvent) => void): void {
	emit({
		type: "tool_execution_end",
		toolCallId: "tool-pass-through",
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data: { ok: true } },
		},
		isError: false,
	});
}

function yieldEmittingSession(): AgentSession {
	return createMockSession(({ emit }) => emitYield(emit));
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		captureOwnerCurrent: () => () => !session.isDisposed,
		captureOwnerLifetimeCurrent: () => () => !session.isDisposed,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "subagent-pass-through",
	settings: Settings.isolated(),
	modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
	enableLsp: false,
};

function createModelRegistry(
	models: Model | Model[],
	getApiKeyForProvider: ModelRegistry["getApiKeyForProvider"] = async () => "test-key",
): ModelRegistry {
	const available = Array.isArray(models) ? models : [models];
	return {
		authStorage: {},
		refresh: async () => {},
		getAvailable: () => available,
		getApiKeyForProvider,
	} as unknown as ModelRegistry;
}

describe("runSubprocess child policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("removes MCP and fresh discovery sources for a restricted child", async () => {
		const session = yieldEmittingSession();
		const persistedInits: Array<{ restrictToolNames?: boolean; tools: string[] }> = [];
		vi.spyOn(session.sessionManager, "appendSessionInit").mockImplementation(init => {
			persistedInits.push(init);
			return "session-init";
		});
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const preloadedExtensionPaths = ["/hostile/extensions/read.ts"];
		const preloadedPreparedExtensions: PreparedExtension[] = [
			{
				path: preloadedExtensionPaths[0]!,
				resolvedPath: preloadedExtensionPaths[0]!,
				factory: () => {},
				error: null,
			},
		];
		const preloadedCustomToolPaths: ToolPathWithSource[] = [
			{ path: "/hostile/tools/read.ts", source: { provider: "test", providerName: "Test", level: "project" } },
		];
		const getTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		const mcpManager = { getTools } as unknown as MCPManager;

		const result = await runSubprocess({
			...baseOptions,
			id: "restricted-child",
			restrictToolNames: true,
			mcpManager,
			preloadedExtensionPaths,
			preloadedPreparedExtensions,
			preloadedCustomToolPaths,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			outputSchemaMode: "strict",
		});

		expect(result.exitCode).toBe(0);
		const forwarded = spy.mock.calls[0]?.[0];
		expect(forwarded?.restrictToolNames).toBe(true);
		expect(forwarded?.enableMCP).toBe(false);
		expect(forwarded?.mcpManager).toBeUndefined();
		expect(forwarded?.customTools).toBeUndefined();
		expect(forwarded?.mcpTools).toBeUndefined();
		expect(forwarded?.preloadedExtensionPaths).toEqual([]);
		expect(forwarded?.preloadedCustomToolPaths).toEqual([]);
		expect(getTools).not.toHaveBeenCalled();
		expect(forwarded?.outputSchemaMode).toBe("strict");
		expect(persistedInits).toHaveLength(1);
		expect(persistedInits[0]).toMatchObject({ restrictToolNames: true, tools: ["read", "yield"] });
	});

	it("persists mounted tool commands from the enabled set", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getActiveToolNames").mockReturnValue(["read", "yield"]);
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "lsp", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "tool-command-child" });

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "lsp", "yield"] }));
	});

	it("omits transport-only write from the persisted cold-revival contract", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "transport-only-child",
			agent: { ...baseAgent, tools: ["read"] },
		});

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "yield"] }));
	});

	it("persists write when the original subagent contract grants it", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(session, "getEnabledToolNames").mockReturnValue(["read", "write", "yield"]);
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			id: "writable-child",
			agent: { ...baseAgent, tools: ["read", "write"] },
		});

		expect(result.exitCode).toBe(0);
		expect(appendSessionInit).toHaveBeenCalledWith(expect.objectContaining({ tools: ["read", "write", "yield"] }));
	});

	it("persists @advisor expanded against the spawning owner's roles so cold revival keeps its model", async () => {
		const session = yieldEmittingSession();
		const appendSessionInit = vi.spyOn(session.sessionManager, "appendSessionInit");
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		// A nested spawn's owner is a parent subagent whose advisor role overrides the root's.
		const parentSettings = Settings.isolated({ modelRoles: { advisor: "anthropic/claude-sonnet-4-5" } });

		const result = await runSubprocess({
			...baseOptions,
			id: "nested-advised-child",
			settings: parentSettings,
			agent: { ...baseAgent, advisor: "@advisor:high" },
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.settings?.getModelRole("advisor")).toBe("anthropic/claude-sonnet-4-5:high");
		expect(appendSessionInit).toHaveBeenCalledWith(
			expect.objectContaining({ advisor: "anthropic/claude-sonnet-4-5:high" }),
		);
	});

	it("preserves the legacy result shape when no output schema is selected", async () => {
		const session = yieldEmittingSession();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({ ...baseOptions, id: "legacy-output-child" });

		expect(result.exitCode).toBe(0);
		expect(Object.hasOwn(result, "structuredOutput")).toBe(false);
	});

	it("caps caller-requested effort at task.maxEffort", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const settings = Settings.isolated({ "task.maxEffort": "low" });
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-effort-ceiling",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBe(Effort.Low);
		// The ceiling itself rides into the session so retry-fallback recovery
		// can re-clamp to it after model swaps.
		expect(spy.mock.calls[0]?.[0]?.thinkingLevelCeiling).toBe(Effort.Low);
	});

	it("rejects a spawn when task.maxEffort is below the model floor", async () => {
		const baseModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!baseModel) throw new Error("Expected gpt-5.6-sol model to exist");
		const model = {
			...baseModel,
			id: "mock-high-only",
			provider: "mock",
			thinking: { mode: "effort", efforts: [Effort.High] },
		} as Model;
		const settings = Settings.isolated({ "task.maxEffort": "low" });
		settings.setModelRole("task", `${model.provider}/${model.id}`);
		const spy = vi.spyOn(sdkModule, "createAgentSession");

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, model: ["@task"] },
			id: "subagent-effort-ceiling-below-floor",
			effort: "hi",
			settings,
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(1);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("runSubprocess per-agent compaction threshold overrides", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies the override to the named child only, not to agents that child spawns", async () => {
		const createSession = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createSessionResult(yieldEmittingSession()))
			.mockResolvedValueOnce(createSessionResult(yieldEmittingSession()));
		const rootSettings = Settings.isolated({ "compaction.thresholdTokens": 40_000 });

		const child = await runSubprocess({
			...baseOptions,
			id: "compaction-override-child",
			settings: rootSettings,
			compactionThresholdOverride: { thresholdPercent: 80, thresholdTokens: -1 },
		});
		expect(child.exitCode).toBe(0);
		const childSettings = createSession.mock.calls[0]?.[0]?.settings;
		if (!childSettings) throw new Error("Expected child settings");
		const childCompaction = cfgCompaction.get(childSettings);
		expect(resolveThresholdTokens(200_000, childCompaction)).toBe(160_000);
		expect(shouldCompact(50_000, 200_000, childCompaction)).toBe(false);
		expect(shouldCompact(160_001, 200_000, childCompaction)).toBe(true);

		// A grandchild without its own entry is spawned from the child's settings.
		const grandchild = await runSubprocess({
			...baseOptions,
			id: "compaction-override-grandchild",
			settings: childSettings,
		});
		expect(grandchild.exitCode).toBe(0);
		const grandchildSettings = createSession.mock.calls[1]?.[0]?.settings;
		if (!grandchildSettings) throw new Error("Expected grandchild settings");
		const grandchildCompaction = cfgCompaction.get(grandchildSettings);
		expect(resolveThresholdTokens(200_000, grandchildCompaction)).toBe(40_000);
		expect(shouldCompact(50_000, 200_000, grandchildCompaction)).toBe(true);
	});
});

describe("runSubprocess per-agent service-tier overrides", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// The child session evaluates the resolver against its final model; the
	// tests evaluate it the same way, with the model dispatch handed over.
	function childTiers(
		sessionOptions: CreateAgentSessionOptions | undefined,
		model: Model | undefined = sessionOptions?.model,
	): ServiceTierByFamily {
		const resolve = sessionOptions?.resolveServiceTierByFamily;
		if (!resolve) throw new Error("Expected createAgentSession to receive a service-tier resolver");
		return resolve(model);
	}

	it("applies the dispatch-resolved override to the effective model selected by task policy", async () => {
		const effectiveModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		const definitionModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!effectiveModel || !definitionModel) throw new Error("Expected bundled service-tier models to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: [`${definitionModel.provider}/${definitionModel.id}`] },
			modelOverride: [`${effectiveModel.provider}/${effectiveModel.id}`],
			serviceTierOverride: "scale",
			id: "subagent-agent-service-tier-effective-model",
			settings: Settings.isolated({ "tier.subagent": "priority" }),
			modelRegistry: createModelRegistry(effectiveModel),
		});

		expect(result.exitCode).toBe(0);
		expect(childTiers(spy.mock.calls[0]?.[0])).toEqual({ openai: "scale" });
	});

	it("keeps tier.subagent when dispatch resolved no override for the agent", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: [`${model.provider}/${model.id}`] },
			id: "subagent-agent-service-tier-absent",
			settings: Settings.isolated({ "tier.subagent": "flex" }),
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		const sessionOptions = spy.mock.calls[0]?.[0];
		expect(sessionOptions?.resolveServiceTierByFamily).toBeUndefined();
		expect([
			sessionOptions?.settings ? cfgTierOpenai.get(sessionOptions?.settings) : undefined,
			sessionOptions?.settings ? cfgTierAnthropic.get(sessionOptions?.settings) : undefined,
			sessionOptions?.settings ? cfgTierGoogle.get(sessionOptions?.settings) : undefined,
		]).toEqual(["flex", "none", "flex"]);
	});

	it("drops inherited live tiers a family can't realize instead of failing the spawn", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!model) throw new Error("Expected gpt-5.6-sol model to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		// A resumed parent session file can carry a live tier its family never realizes.
		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: [`${model.provider}/${model.id}`] },
			id: "subagent-inherited-unrealizable-tier",
			settings: Settings.isolated({ "tier.subagent": "inherit" }),
			parentServiceTier: { openai: "flex", anthropic: "flex" },
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		const childSettings = spy.mock.calls[0]?.[0]?.settings;
		if (!childSettings) throw new Error("Expected createAgentSession to receive settings");
		expect([
			cfgTierOpenai.get(childSettings),
			cfgTierAnthropic.get(childSettings),
			cfgTierGoogle.get(childSettings),
		]).toEqual(["flex", "none", "none"]);
	});

	it("lets an unsupported concrete override beat the global tier without crossing families", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "reviewer", model: [`${model.provider}/${model.id}`] },
			serviceTierOverride: "scale",
			id: "subagent-agent-service-tier-family-validation",
			settings: Settings.isolated({ "tier.subagent": "priority" }),
			modelRegistry: createModelRegistry(model),
		});

		expect(result.exitCode).toBe(0);
		expect(childTiers(spy.mock.calls[0]?.[0])).toEqual({});
	});

	it("does not substitute the parent model when the requested model has no credentials", async () => {
		const requested = getBundledModel("anthropic", "claude-sonnet-4-5");
		const parentModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!requested || !parentModel) throw new Error("Expected bundled service-tier models to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		// The parent's credentials cannot authorize a different requested provider.
		const modelRegistry = createModelRegistry([requested, parentModel], async provider =>
			provider === parentModel.provider ? "test-key" : undefined,
		);

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: [`${requested.provider}/${requested.id}`] },
			parentActiveModelPattern: `${parentModel.provider}/${parentModel.id}`,
			serviceTierOverride: "scale",
			id: "subagent-agent-service-tier-auth-fallback",
			settings: Settings.isolated({ "tier.subagent": "priority" }),
			modelRegistry,
		});

		expect(result.exitCode).toBe(1);
		expect(spy).not.toHaveBeenCalled();
	});

	it("scopes a concrete override to the model the session resolves instead of broadcasting it", async () => {
		const openAIModel = getBundledModel("openai-codex", "gpt-5.6-sol");
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!openAIModel || !anthropicModel) throw new Error("Expected bundled service-tier models to exist");
		const session = yieldEmittingSession();
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			...baseOptions,
			agent: { ...baseAgent, name: "scout", model: ["extension/deferred-model"] },
			modelOverride: ["extension/deferred-model"],
			serviceTierOverride: "priority",
			id: "subagent-agent-service-tier-deferred-model",
			settings: Settings.isolated({ "tier.subagent": "none" }),
			modelRegistry: createModelRegistry([]),
		});

		expect(result.exitCode).toBe(0);
		const sessionOptions = spy.mock.calls[0]?.[0];
		expect(sessionOptions?.model).toBeUndefined();
		expect(sessionOptions?.modelPattern).toEqual(["extension/deferred-model"]);
		// Whichever family the session settles on gets the tier — and only that family.
		expect(childTiers(sessionOptions, anthropicModel)).toEqual({ anthropic: "priority" });
		expect(childTiers(sessionOptions, openAIModel)).toEqual({ openai: "priority" });
		expect(childTiers(sessionOptions, undefined)).toEqual({});
	});
});
