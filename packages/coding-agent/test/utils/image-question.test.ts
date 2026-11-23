import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, AssistantMessage, completeSimple, Model } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CostCapError, CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	askImageQuestion,
	type ResolvedImageQuestionModel,
	resolveImageQuestionModel,
} from "@oh-my-pi/pi-coding-agent/utils/image-question";
import { rejectionOf } from "../helpers/rejection";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function makeProxyModel(id: string, compat?: ModelSpec["compat"]): Model<Api> {
	return buildModel<Api>({
		id,
		name: id,
		api: "openai-completions",
		provider: "myproxy",
		baseUrl: "https://proxy.example.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		compat,
	});
}

function makeSession(active: Model<Api>, available: Model<Api>[]): ToolSession & { modelRegistry: ModelRegistry } {
	const dir = TempDir.createSync("@pi-image-question-");
	const auth = createInMemoryAuthStorage();
	const settings = Settings.isolated({ enabledModels: available.map(model => `${model.provider}/${model.id}`) });
	const modelRegistry = new ModelRegistry(auth, dir.join("models.yml"), { settings });
	const sourceId = `image-question-${crypto.randomUUID()}`;
	cleanups.push(async () => {
		try {
			modelRegistry.clearSourceRegistrations(sourceId);
			await auth.close();
		} finally {
			dir.removeSync();
		}
	});
	modelRegistry.registerProvider(
		active.provider,
		{
			api: active.api,
			baseUrl: active.baseUrl,
			apiKey: "synthetic-image-question-key",
			models: available.map(model => {
				if (model.contextWindow === null || model.maxTokens === null)
					throw new Error("Synthetic image-question models require explicit token limits");
				return {
					id: model.id,
					name: model.name,
					reasoning: model.reasoning,
					input: [...model.input],
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					compat: toModelSpec(model).compat,
				};
			}),
		},
		sourceId,
	);
	return {
		cwd: dir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		modelRegistry,
		getModelString: () => `${active.provider}/${active.id}`,
		getActiveModelString: () => `${active.provider}/${active.id}`,
	};
}

function questionSession(
	model: Model<Api>,
	overrides: Omit<Partial<ToolSession>, "modelRegistry"> = {},
): ToolSession & { modelRegistry: ModelRegistry } {
	return { ...makeSession(model, [model]), ...overrides };
}

const image = { resolvedPath: "/x.png", mimeType: "image/png", data: "AAAA", textNote: "", bytes: 3 };

function answer(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "A red square." }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 14,
			cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("resolveImageQuestionModel wire truth (#9697)", () => {
	it("skips a wire-stripped model that declares image input", () => {
		const stripped = makeProxyModel("deepseek-v4-flash", { stripImageInput: true });
		const vision = makeProxyModel("qwen-vl", { stripImageInput: false });
		const resolved = resolveImageQuestionModel(makeSession(stripped, [stripped, vision]));
		expect(resolved.model.id).toBe("qwen-vl");
	});

	it("throws instead of returning the stripped model when nothing else can see", () => {
		const stripped = makeProxyModel("deepseek-v4-flash", { stripImageInput: true });
		expect(() => resolveImageQuestionModel(makeSession(stripped, [stripped]))).toThrow(
			"Resolved model myproxy/deepseek-v4-flash does not support image input.",
		);
	});
});

describe("askImageQuestion cost cap", () => {
	it("sends no image question once the session is at its cost cap", async () => {
		const model = makeProxyModel("vision");
		const costGate = new CostGate(Settings.isolated({ "session.maxCost": 1 }), 1.2, () => {});
		const session = questionSession(model, { costGate });
		let calls = 0;
		const completeImpl: typeof completeSimple = async () => {
			calls++;
			throw new Error("should not be called");
		};

		const refused = await rejectionOf(
			askImageQuestion(
				session,
				{ model, selectedPattern: "myproxy/vision" },
				image,
				"what?",
				undefined,
				completeImpl,
			),
		);

		expect(refused).toBeInstanceOf(CostCapError);
		expect(calls).toBe(0);
	});
	it("rechecks the cap after the provider admission hook finishes waiting", async () => {
		const model = makeProxyModel("vision");
		const costGate = new CostGate(Settings.isolated({ "session.maxCost": 1 }), 0, () => {});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const session = questionSession(model, {
			costGate,
			prepareSimpleStreamOptions: options => ({
				...options,
				onPayload: async () => {
					entered.resolve();
					await release.promise;
				},
			}),
		});
		let sent = 0;
		const completeImpl: typeof completeSimple = async (requestModel, _context, options) => {
			await options?.onPayload?.({}, requestModel, options.signal);
			sent++;
			return answer(requestModel);
		};
		const refused = rejectionOf(
			askImageQuestion(session, { model, selectedPattern: undefined }, image, "what?", undefined, completeImpl),
		);
		await entered.promise;
		costGate.record(1);
		release.resolve();

		expect(await refused).toBeInstanceOf(CostCapError);
		expect(sent).toBe(0);
		expect(costGate.spent).toBe(1);
	});

	it("sends nothing when its captured owner changes during credential resolution", async () => {
		const model = makeProxyModel("vision");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let current = true;
		const session = questionSession(model, { captureOwnerCurrent: () => () => current });
		const getApiKey = session.modelRegistry.getApiKey.bind(session.modelRegistry);
		vi.spyOn(session.modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return getApiKey(...args);
		});
		let sent = 0;
		const completeImpl: typeof completeSimple = async () => {
			sent++;
			throw new Error("unexpected dispatch");
		};
		const refused = rejectionOf(
			askImageQuestion(session, { model, selectedPattern: undefined }, image, "what?", undefined, completeImpl),
		);
		await entered.promise;
		current = false;
		release.resolve();

		expect(await refused).toBeInstanceOf(ToolError);
		expect(sent).toBe(0);
	});

	it("records billed usage once under the initiating leaf without moving a successor leaf", async () => {
		const model = makeProxyModel("vision");
		const costGate = new CostGate(Settings.isolated(), 0, () => {});
		const manager = SessionManager.inMemory("/image-question");
		const parentId = manager.appendCustomEntry("before-image-question", {});
		let successor: string | null = null;
		const session = questionSession(model, {
			costGate,
			sessionManager: manager,
			prepareSimpleStreamOptions: options => ({
				...options,
				onPayload: () => {
					successor = manager.appendCustomEntry("successor", {});
				},
			}),
		});
		const completeImpl: typeof completeSimple = async (requestModel, _context, options) => {
			await options?.onPayload?.({}, requestModel, options.signal);
			return answer(requestModel);
		};
		try {
			const result = await askImageQuestion(
				session,
				{ model, selectedPattern: undefined },
				image,
				"what?",
				undefined,
				completeImpl,
			);
			expect(result.text).toBe("A red square.");
			expect(costGate.spent).toBe(0.25);
			const usages = manager.getEntries().filter(entry => entry.type === "model_usage");
			expect(usages.map(entry => ({ parentId: entry.parentId, cost: entry.usage.cost.total }))).toEqual([
				{ parentId, cost: 0.25 },
			]);
			expect(manager.getLeafId()).toBe(successor);
		} finally {
			await manager.close();
		}
	});
});

describe("askImageQuestion usage journal", () => {
	it("journals an answered question once as `image-question`, with the question and no image data", async () => {
		const model = makeProxyModel("vision");
		const sessionManager = SessionManager.inMemory();
		const session = questionSession(model, { sessionManager });
		const usage = {
			input: 12,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
		};
		const completeImpl = (async () => ({
			role: "assistant",
			content: [{ type: "text", text: "A cat." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "stop",
			timestamp: Date.now(),
		})) as unknown as typeof completeSimple;
		const image = { resolvedPath: "/x.png", mimeType: "image/png", data: "AAAA", textNote: "", bytes: 3 };

		await askImageQuestion(
			session,
			{ model, selectedPattern: "myproxy/vision" } as ResolvedImageQuestionModel,
			image,
			"what?",
			undefined,
			completeImpl,
		);

		const journaled = sessionManager.getEntries().filter(entry => entry.type === "model_usage");
		expect(journaled).toHaveLength(1);
		expect(journaled[0]).toMatchObject({
			purpose: "image-question",
			usage,
			completion: { prompt: "what?", reply: "A cat." },
		});
		expect(sessionManager.getUsageStatistics().cost).toBe(0.02);
	});
});
