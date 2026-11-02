import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { computeNonMessageTokens, estimateContextToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { ModelRegistry } from "../src/config/model-registry";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { SessionStatsTracker } from "../src/session/session-stats";

type Snapshot = NonNullable<AssistantMessage["contextSnapshot"]>;
const PROVIDER_PROMPT = 100_000;

describe("context anchors across tool-schema estimator versions", () => {
	let auth: AuthStorage;
	let registry: ModelRegistry;
	const fixtures: { agent: Agent; manager: SessionManager }[] = [];

	beforeAll(async () => {
		auth = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true, cacheDbPath: ":memory:" });
	});

	afterEach(async () => {
		for (const { agent, manager } of fixtures.splice(0)) {
			agent.abort();
			agent.reset();
			await manager.close();
		}
	});

	afterAll(async () => {
		await auth.close();
	});

	function fixture() {
		const bundled = registry.getAll().find(model => model.provider === "openai" && model.api === "openai-responses");
		if (!bundled) throw new Error("Expected bundled OpenAI Responses model");
		const model: Model = { ...bundled, toolSchemasInContext: true };
		const tools: AgentTool[] = ["read_synthetic", "search_synthetic"].map(name => ({
			name,
			label: name,
			description: "Detailed synthetic tool documentation. ".repeat(200),
			parameters: type({ path: "string" }),
			execute: async () => {
				throw new Error("Accounting must not execute a tool");
			},
		}));
		const agent = new Agent({
			pruneToolDescriptions: true,
			initialState: { model, systemPrompt: ["Synthetic base prompt"], tools, messages: [] },
		});
		const manager = SessionManager.inMemory();
		fixtures.push({ agent, manager });
		if (!agent.prunesToolDescriptions(model)) {
			throw new Error("Accounting fixture requires provider-native tool calling; unset PI_DIALECT");
		}
		const source = {
			get model() {
				return agent.state.model;
			},
			get systemPrompt() {
				return agent.state.systemPrompt;
			},
			agent,
		};
		const tracker = new SessionStatsTracker({
			session: source,
			agent,
			sessionManager: manager,
			modelRegistry: registry,
			model: () => agent.state.model,
			sessionId: () => manager.getSessionId(),
		});
		const schemas = (pruneDescriptions: boolean) =>
			estimateContextToolSchemaTokens(agent.state.tools, agent.tokenizer, agent.state.model, { pruneDescriptions });
		const legacy = (includeSchema = true): Snapshot => {
			const full = schemas(false);
			return {
				promptTokens: PROVIDER_PROMPT,
				nonMessageTokens: agent.tokenizer.countTokens(agent.state.systemPrompt) + full,
				...(includeSchema ? { toolSchemaTokens: full } : {}),
			};
		};
		const record = (snapshot: Snapshot, persist = true) => {
			const assistant: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Synthetic answer" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				timestamp: 2,
				usage: {
					input: PROVIDER_PROMPT + 500,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: PROVIDER_PROMPT + 501,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				contextSnapshot: JSON.parse(JSON.stringify(snapshot)) as Snapshot,
			};
			if (persist) manager.appendMessage(assistant);
			agent.replaceMessages([assistant]);
			return assistant;
		};
		return { agent, manager, source, tracker, schemas, legacy, record };
	}

	it.each([true, false])(
		"CA01 preserves legacy occupancy, history corrections, tail, and pending content (persisted=%s)",
		persist => {
			const f = fixture();
			expect(f.schemas(false)).toBeGreaterThan(f.schemas(true));
			const assistant = f.record({ ...f.legacy(), historyRewriteTokensRemoved: 37 }, persist);
			const original = structuredClone(assistant);
			const tail: AgentMessage = { role: "user", content: "Synthetic next question", timestamp: 3 };
			const pending: AgentMessage = { role: "user", content: "Synthetic pending question", timestamp: 4 };
			f.agent.replaceMessages([assistant, tail]);

			expect(f.tracker.getContextBreakdown({ pendingMessages: [pending] })?.usedTokens).toBe(
				PROVIDER_PROMPT - 37 + f.agent.tokenizer.countMessages([tail]) + f.agent.tokenizer.countMessages([pending]),
			);
			expect(assistant).toEqual(original);
		},
	);

	it.each([true, false])("CA02 retains non-schema growth above a legacy anchor (schema field=%s)", includeSchema => {
		const f = fixture();
		f.record(f.legacy(includeSchema));
		const added = "A small synthetic system-context addition.";
		f.agent.setSystemPrompt([...f.agent.state.systemPrompt, added]);

		expect(f.tracker.getContextBreakdown()?.usedTokens).toBe(
			PROVIDER_PROMPT + f.agent.tokenizer.countTokens([added]),
		);
	});

	it("CA03 measures signed legacy roster changes in the historical estimator basis", () => {
		const f = fixture();
		const full = f.schemas(false);
		f.record(f.legacy());
		f.agent.setTools(f.agent.state.tools.slice(0, 1));

		expect(f.tracker.getContextBreakdown()?.usedTokens).toBe(PROVIDER_PROMPT + f.schemas(false) - full);
	});

	it.each([false, true])(
		"CA04 keeps current-basis roster deltas after a snapshot round trip (pending=%s)",
		pending => {
			const f = fixture();
			const pruned = f.schemas(true);
			if (pending) {
				f.tracker.setPendingSnapshot({
					promptTokens: PROVIDER_PROMPT,
					nonMessageTokens: computeNonMessageTokens(f.source, f.agent.tokenizer),
					cutoffCount: 0,
				});
			}
			const snapshot = f.tracker.nonMessageSnapshot();
			f.tracker.setPendingSnapshot(undefined);
			f.record({ promptTokens: PROVIDER_PROMPT, ...snapshot });

			expect(f.tracker.getContextBreakdown()?.usedTokens).toBe(PROVIDER_PROMPT);
			f.agent.setTools(f.agent.state.tools.slice(0, 1));
			expect(f.tracker.getContextBreakdown()?.usedTokens).toBe(PROVIDER_PROMPT + f.schemas(true) - pruned);
		},
	);

	it("CA05 uses the submitted estimator basis for an in-flight roster shrink", () => {
		const f = fixture();
		const pruned = f.schemas(true);
		f.tracker.setPendingSnapshot({
			promptTokens: PROVIDER_PROMPT,
			nonMessageTokens: computeNonMessageTokens(f.source, f.agent.tokenizer),
			cutoffCount: 0,
		});
		f.agent.setTools(f.agent.state.tools.slice(0, 1));

		expect(f.tracker.getContextBreakdown()?.usedTokens).toBe(PROVIDER_PROMPT + f.schemas(true) - pruned);
	});

	it("CA06 removes and restores only the submitted pruned schemas on a deferred-model transition", () => {
		const f = fixture();
		const inlineModel = f.agent.state.model!;
		const pruned = f.schemas(true);
		f.record({ promptTokens: PROVIDER_PROMPT, ...f.tracker.nonMessageSnapshot() });
		f.agent.setModel({ ...inlineModel, toolSchemasInContext: false });

		expect(f.tracker.getContextBreakdown()?.usedTokens).toBe(PROVIDER_PROMPT - pruned);
		expect(f.tracker.getContextBreakdown()?.systemToolsTokens).toBe(0);
		f.agent.setModel(inlineModel);
		expect(f.tracker.getContextBreakdown()?.usedTokens).toBe(PROVIDER_PROMPT);
	});
});
