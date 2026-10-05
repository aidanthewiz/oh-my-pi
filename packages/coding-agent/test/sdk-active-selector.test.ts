import { afterEach, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { unregisterCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resolveModelOverrideWithAuthFallback } from "../src/config/model-resolver";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";
import * as discovery from "../src/task/discovery";
import { resolveEffectiveSubagentPolicy, runStructuredSubagent } from "../src/task/structured-subagent";
import type { AgentDefinition } from "../src/task/types";
import * as tools from "../src/tools";
import type { ToolSession } from "../src/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const worker: AgentDefinition = {
	name: "fixture-worker",
	description: "Fixture worker",
	systemPrompt: "Yield the result.",
	source: "bundled",
};
afterEach(() => {
	vi.restoreAllMocks();
	unregisterCustomApi("mock", "sdk-inheritance-fixture");
});

for (const provider of ["openrouter", "vercel-ai-gateway"] as const) {
	it(`SDK inherited model selection preserves ${provider} routing`, async () => {
		using dir = TempDir.createSync("sdk-active-selector-");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const routing =
			provider === "openrouter"
				? { openRouterRouting: { only: ["anthropic"] } }
				: { vercelGatewayRouting: { only: ["anthropic"] } };
		const base = buildModel({
			id: "anthropic/fixture-model",
			name: "Fixture",
			provider,
			api: "openai-completions",
			baseUrl: "https://fixture.invalid/v1",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000,
			maxTokens: 4096,
		});
		const routed = buildModel({ ...base, compat: routing });
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([base]);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("fixture");
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [worker], projectAgentsDir: null });
		let toolSession: ToolSession | undefined;
		const original = tools.createTools;
		vi.spyOn(tools, "createTools").mockImplementation((session, names) => {
			toolSession = session;
			return original(session, names);
		});
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			model: routed,
			thinkingLevel: Effort.Low,
			settings: Settings.isolated(),
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});
		try {
			if (!toolSession) throw new Error("Expected tool session");
			const policy = await resolveEffectiveSubagentPolicy({
				session: toolSession,
				invocationKind: "eval",
				assignment: "Inspect.",
				agent: worker.name,
				model: "@default:high",
			});
			const resolved = await resolveModelOverrideWithAuthFallback(
				policy.modelOverride ?? [],
				undefined,
				modelRegistry,
				toolSession.settings,
				undefined,
				policy.modelInheritedThinkingIndexes,
				policy.modelRequestedThinkingLevels,
			);
			expect(resolved.model?.compat).toMatchObject(routing);
			expect(resolved.model?.id).toBe(base.id);
			expect(resolved.thinkingLevel).toBe(Effort.High);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
}

it("SDK children preserve the actual parent model and effective thinking without interpreting effort as a literal sibling", async () => {
	using dir = TempDir.createSync("sdk-inherited-reasoning-");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("nanogpt", "synthetic-test-key");
	const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
	registerMockApi("sdk-inheritance-fixture");
	const makeModel = (id: string) =>
		Object.assign(
			createMockModel({
				provider: "nanogpt",
				id,
				reasoning: true,
				handler: () => ({ content: [{ type: "toolCall", name: "yield", arguments: { data: { served: id } } }] }),
			}),
			{ thinking: { mode: "effort" as const, efforts: [Effort.Low, Effort.High], defaultLevel: Effort.High } },
		);
	const base = makeModel("coding-router");
	const literal = makeModel("coding-router:low");
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([base, literal]);
	vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("fixture");
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [worker], projectAgentsDir: null });
	let toolSession: ToolSession | undefined;
	const original = tools.createTools;
	vi.spyOn(tools, "createTools").mockImplementation((session, names) => {
		toolSession ??= session;
		return original(session, names);
	});
	const { session } = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		model: base,
		thinkingLevel: ThinkingLevel.Off,
		settings: Settings.isolated({ "task.enableLsp": false }),
		authStorage,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		disableExtensionDiscovery: true,
		extensions: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		preloadedCustomToolPaths: [],
		toolNames: ["read"],
	});
	try {
		if (!toolSession) throw new Error("Expected tool session");
		for (const [level, model, reasoning, agentModel] of [
			[ThinkingLevel.Off, "@default", undefined, undefined],
			[ThinkingLevel.Off, undefined, undefined, undefined],
			[ThinkingLevel.Low, "@default", Effort.Low, undefined],
			[ThinkingLevel.Low, undefined, Effort.Low, undefined],
			[ThinkingLevel.Low, "@default:high", Effort.High, undefined],
			[ThinkingLevel.Low, undefined, Effort.High, "@task:high"],
			[ThinkingLevel.Low, undefined, Effort.High, "pi/task:high"],
		] as const) {
			session.setThinkingLevel(level);
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
				agents: [{ ...worker, model: agentModel === undefined ? undefined : [agentModel] }],
				projectAgentsDir: null,
			});
			base.reset();
			literal.reset();
			const execution = await runStructuredSubagent({
				session: toolSession,
				invocationKind: "eval",
				assignment: "Yield the served model.",
				agent: worker.name,
				model,
				identity: { label: "InheritanceFixture" },
				outputSchema: { type: "object", required: ["served"], properties: { served: { type: "string" } } },
				keepAlive: false,
				enableIrc: false,
				enableLsp: false,
			});
			expect(execution.result.structuredOutput?.data, JSON.stringify(execution.result)).toEqual({ served: base.id });
			if (reasoning === undefined) expect(base.calls[0]?.options?.disableReasoning).toBe(true);
			else expect(base.calls[0]?.options?.reasoning).toBe(reasoning);
		}
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [worker], projectAgentsDir: null });
		await session.setModel(literal);
		session.setThinkingLevel(ThinkingLevel.Off);
		literal.reset();
		const execution = await runStructuredSubagent({
			session: toolSession,
			invocationKind: "eval",
			assignment: "Yield the served model.",
			agent: worker.name,
			model: "@default",
			identity: { label: "LiteralInheritanceFixture" },
			outputSchema: { type: "object", required: ["served"], properties: { served: { type: "string" } } },
			keepAlive: false,
			enableIrc: false,
			enableLsp: false,
		});
		expect(execution.result.structuredOutput?.data).toEqual({ served: literal.id });
		expect(literal.calls[0]?.options?.disableReasoning).toBe(true);
	} finally {
		await session.dispose();
		authStorage.close();
	}
});
