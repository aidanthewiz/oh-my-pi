import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, ImageContent, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { tagImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const FORM = `<form><fieldset><legend>Q?</legend><label><input type="radio" name="q" value="a" checked>A</label><label><input type="radio" name="q" value="b">B</label></fieldset></form>`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkRkAAAAASUVORK5CYII=";
const TEXT_ONLY = buildModel({
	id: "text-only",
	name: "Text only",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://synthetic.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});
type AskDialog = NonNullable<NonNullable<AgentToolContext["ui"]>["askDialog"]>;

function context(askDialog: AskDialog): AgentToolContext {
	return { hasUI: true, ui: { askDialog }, abort: () => {} } as unknown as AgentToolContext;
}

function answerForQuestion(
	question: ExtensionAskDialogQuestion | undefined,
	answer: Omit<ExtensionAskDialogResultItem, "id" | "question" | "options" | "multi">,
): ExtensionAskDialogResultItem {
	if (!question) throw new Error("Ask did not present the expected question");
	return {
		id: question.id,
		question: question.question,
		options: question.options.map(option => option.label),
		multi: question.multi ?? false,
		...answer,
	};
}

function toolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/ask-rich",
		hasUI: true,
		settings: Settings.isolated({ "ask.notify": "off" }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...overrides,
	};
}

beforeAll(() => initTheme(false));

describe("HTML rich choice answers", () => {
	it("keeps image markers and admitted attachment provenance across fields", async () => {
		const first = tagImageAttachmentSource(
			{ type: "image", data: PNG, mimeType: "image/png" },
			"local://answer.png",
			"image",
		);
		const second: ImageContent = { type: "image", data: PNG, mimeType: "image/png" };
		const result = await new AskTool(toolSession()).execute(
			"rich-images",
			{
				html: FORM.replace(
					"</form>",
					`<fieldset><legend>Second?</legend><label><input type="radio" name="second" value="x">X</label><label><input type="radio" name="second" value="y">Y</label></fieldset></form>`,
				),
			},
			undefined,
			undefined,
			context(async questions => ({
				kind: "submit",
				results: [
					answerForQuestion(questions[0], {
						selectedOptions: [],
						customInput: "Like [Image #1]",
						customInputImages: [first],
					}),
					answerForQuestion(questions[1], {
						selectedOptions: ["Y"],
						note: "Use [Image #1], not [Image #5]",
						noteOption: "Y",
						noteImages: [second],
					}),
				],
			})),
		);
		expect(result.details?.answers).toEqual([
			{ name: "q", question: "Q?", answer: "Other: Like [Image #1]" },
			{ name: "second", question: "Second?", answer: "Y" },
		]);
		expect(result.details?.notes).toEqual([
			{ name: "second", question: "Second?", option: "Y", value: "y", text: "Use [Image #2], not [Image #5]" },
		]);
		expect(result.content.slice(1)).toEqual([
			{ type: "text", text: expect.stringContaining("local://answer.png") },
			first,
			second,
		]);
		expect(JSON.stringify(result.details)).not.toContain(PNG);
	});

	it("does not convert checked defaults or a timeout note into an answer or a paid image description", async () => {
		let descriptions = 0;
		const result = await new AskTool(
			toolSession({
				getActiveModel: () => TEXT_ONLY,
				describeAttachedImages: async () => {
					descriptions++;
					return [];
				},
			}),
		).execute(
			"rich-timeout",
			{ html: FORM },
			undefined,
			undefined,
			context(async questions => ({
				kind: "submit",
				results: [
					answerForQuestion(questions[0], {
						selectedOptions: [],
						note: "Need time",
						noteImages: [{ type: "image", data: PNG, mimeType: "image/png" }],
						timedOut: true,
					}),
				],
			})),
		);
		expect(result.details).toMatchObject({ answers: [{ name: "q", answer: "" }], timedOut: true });
		expect(result.content.filter(block => block.type === "image")).toHaveLength(1);
		expect(descriptions).toBe(0);
	});

	it("retains explicit partial answers, hidden data and notes without treating untouched defaults as timeout consent", async () => {
		let descriptions = 0;
		const result = await new AskTool(
			toolSession({
				getActiveModel: () => TEXT_ONLY,
				describeAttachedImages: async () => {
					descriptions++;
					return [];
				},
			}),
		).execute(
			"rich-timeout",
			{
				html: FORM.replace(
					"</form>",
					`<input type="hidden" name="version" value="7"><fieldset><legend>Second?</legend><label><input type="radio" name="second" value="x" checked>X</label><label><input type="radio" name="second" value="y">Y</label></fieldset></form>`,
				),
			},
			undefined,
			undefined,
			context(async questions => ({
				kind: "submit",
				results: [
					answerForQuestion(questions[0], {
						selectedOptions: ["B"],
						note: "Need time",
						noteOption: "B",
						noteImages: [{ type: "image", data: PNG, mimeType: "image/png" }],
					}),
					answerForQuestion(questions[1], { selectedOptions: [], timedOut: true }),
				],
			})),
		);
		expect(result.details).toEqual({
			answers: [
				{ name: "q", question: "Q?", answer: "B" },
				{ name: "second", question: "Second?", answer: "" },
			],
			notes: [{ name: "q", question: "Q?", option: "B", value: "b", text: "Need time" }],
			timedOut: true,
		});
		const answer = result.content[0];
		if (answer?.type !== "text") throw new Error("Expected form answer text");
		expect(JSON.parse(answer.text.slice(answer.text.indexOf("{"), answer.text.lastIndexOf("}") + 1))).toEqual({
			version: "7",
			q: "b",
		});
		expect(result.content.filter(block => block.type === "image")).toHaveLength(1);
		expect(descriptions).toBe(0);
	});

	it("does not describe images from an answer returned after caller cancellation", async () => {
		const controller = new AbortController();
		const late = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		const presented = Promise.withResolvers<ExtensionAskDialogQuestion[]>();
		let descriptions = 0;
		const running = new AskTool(
			toolSession({
				getActiveModel: () => TEXT_ONLY,
				describeAttachedImages: async () => {
					descriptions++;
					return [];
				},
			}),
		).execute(
			"late-answer",
			{ html: FORM },
			controller.signal,
			undefined,
			context(async questions => {
				presented.resolve(questions);
				return late.promise;
			}),
		);
		const questions = await presented.promise;
		controller.abort();
		late.resolve({
			kind: "submit",
			results: [
				answerForQuestion(questions[0], {
					selectedOptions: ["A"],
					noteImages: [{ type: "image", data: PNG, mimeType: "image/png" }],
				}),
			],
		});
		await expect(running).rejects.toBeInstanceOf(ToolAbortError);
		expect(descriptions).toBe(0);
	});
});

describe("Ask pause completion authority", () => {
	it.each(
		(["chat", "rich-timeout", "form-timeout"] as const).flatMap(kind =>
			(["abort", "owner", "session", "model", "steering"] as const).map(change => [kind, change] as const),
		),
	)("rejects a %s result invalidated by %s while its owned goal pause is pending", async (kind, change) => {
		let state: GoalModeState | undefined;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtime = new GoalRuntime({
			getState: () => state,
			setState: next => {
				state = next;
			},
			getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
			isWaitingForUser: () => false,
			persist: () => {},
			sendHiddenMessage: async () => {},
			now: () => 0,
			emit: async event => {
				if (event.type === "goal_updated" && event.goal?.status === "paused") {
					entered.resolve();
					await release.promise;
				}
			},
		});
		await runtime.createGoal({ objective: "Requires consent" });
		let current = true;
		let sessionId = "original";
		let model = TEXT_ONLY;
		const controller = new AbortController();
		const steering = new AbortController();
		const uiContext =
			kind === "form-timeout"
				? { hasUI: true, ui: { formDialog: async () => ({ data: {}, timedOut: true }) }, abort: () => {} }
				: context(async questions =>
						kind === "chat"
							? { kind: "chat" }
							: {
									kind: "submit",
									results: [answerForQuestion(questions[0], { selectedOptions: [], timedOut: true })],
								},
					);
		const running = new AskTool(
			toolSession({
				getGoalRuntime: () => runtime,
				getGoalModeState: () => state,
				captureOwnerCurrent: () => () => current,
				getSessionId: () => sessionId,
				getActiveModel: () => model,
			}),
		).execute("deferred-pause", { html: FORM }, controller.signal, undefined, {
			...uiContext,
			toolCall: { steeringSignal: steering.signal },
		} as unknown as AgentToolContext);
		try {
			await entered.promise;
			if (change === "abort") controller.abort();
			else if (change === "owner") current = false;
			else if (change === "session") sessionId = "replacement";
			else if (change === "model") model = { ...TEXT_ONLY };
			else steering.abort("user");
			release.resolve();
			await expect(running).rejects.toBeInstanceOf(ToolAbortError);
		} finally {
			release.resolve();
			await running.catch(() => undefined);
		}
	});

	it.each(["chat", "rich-timeout", "form-timeout"] as const)(
		"rejects a %s result when its queued pause is skipped for a retired owner",
		async kind => {
			let state: GoalModeState | undefined;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const runtime = new GoalRuntime({
				getState: () => state,
				setState: next => {
					state = next;
				},
				getCurrentUsage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
				isWaitingForUser: () => false,
				persist: () => {},
				sendHiddenMessage: async () => {},
				now: () => 0,
				emit: async event => {
					if (event.type === "goal_updated" && event.goal?.tokenBudget === 100) {
						entered.resolve();
						await release.promise;
					}
				},
			});
			const original = await runtime.createGoal({ objective: "Requires consent" });
			const accounting = runtime.onBudgetMutated(100);
			await entered.promise;
			const queued = Promise.withResolvers<void>();
			const pauseGoal = runtime.pauseGoal.bind(runtime);
			const observePause = vi.spyOn(runtime, "pauseGoal").mockImplementation(options => {
				const admitted = pauseGoal(options);
				queued.resolve();
				return admitted;
			});
			let current = true;
			const uiContext =
				kind === "form-timeout"
					? { hasUI: true, ui: { formDialog: async () => ({ data: {}, timedOut: true }) }, abort: () => {} }
					: context(async questions =>
							kind === "chat"
								? { kind: "chat" }
								: {
										kind: "submit",
										results: [answerForQuestion(questions[0], { selectedOptions: [], timedOut: true })],
									},
						);
			const running = new AskTool(
				toolSession({
					getGoalRuntime: () => runtime,
					getGoalModeState: () => state,
					captureOwnerCurrent: () => () => current,
				}),
			).execute("retired-pause", { html: FORM }, undefined, undefined, uiContext as AgentToolContext);
			try {
				await queued.promise;
				current = false;
				release.resolve();
				await expect(running).rejects.toBeInstanceOf(ToolAbortError);
				expect(state).toMatchObject({ enabled: true, goal: { id: original.goal.id, status: "active" } });
			} finally {
				release.resolve();
				await accounting;
				await running.catch(() => undefined);
				observePause.mockRestore();
			}
		},
	);
});

describe("rich answer image request authority", () => {
	const vision = buildModel({
		id: "gpt-4o",
		name: "Vision",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	});
	const textModel: Model<Api> = { ...vision, id: "gpt-4.1-mini", input: ["text"] };
	const image: ImageContent = { type: "image", data: PNG, mimeType: "image/png" };
	let temp: TempDir;
	let sessions: AgentSession[];
	let dispatched: Model<Api>[];

	beforeEach(() => {
		temp = TempDir.createSync("@ask-image-authority-");
		sessions = [];
		dispatched = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model, _context, options) => {
			if (typeof options?.apiKey === "function")
				await options.apiKey({ lastChance: false, error: undefined, signal: options.signal });
			await options?.onPayload?.({}, model, options.signal);
			options?.signal?.throwIfAborted();
			dispatched.push(model);
			return {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
				content: [{ type: "text", text: "A red banner reading ZEBRA 42." }],
			} satisfies AssistantMessage;
		});
	});
	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		vi.restoreAllMocks();
		temp.removeSync();
	});

	function runAsk(options: {
		settings?: Settings;
		signal?: AbortSignal;
		ownerCurrent?: () => boolean;
		onLookup?: (session: AgentSession) => void | Promise<void>;
		onPayload?: ai.SimpleStreamOptions["onPayload"];
	}) {
		const settings =
			options.settings ?? Settings.isolated({ modelRoles: { vision: "openai/gpt-4o" }, "ask.notify": "off" });
		const registry = {
			getAvailable: () => [vision],
			getApiKey: async () => {
				await options.onLookup?.(session);
				return "synthetic-key";
			},
			resolver: () => async () => "synthetic-key",
		} as unknown as NonNullable<ToolSession["modelRegistry"]>;
		const agent = new Agent({ initialState: { model: textModel, tools: [] }, getApiKey: () => "synthetic-key" });
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(temp.path(), temp.path()),
			settings,
			modelRegistry: registry,
			onPayload: options.onPayload,
		});
		sessions.push(session);
		session.setSideRequestOwnerCapture(
			() => options.ownerCurrent ?? (() => true),
			() => () => false,
		);
		return new AskTool(
			toolSession({
				settings,
				getActiveModel: () => session.model,
				getSessionId: () => session.sessionId,
				isDisposed: () => session.isDisposed,
				captureOwnerCurrent: () => options.ownerCurrent ?? (() => true),
				describeAttachedImages: (images, signal, current) =>
					session.describeAttachedImages(images, signal, current),
			}),
		).execute(
			"owned-images",
			{ html: FORM },
			options.signal,
			undefined,
			context(async questions => ({
				kind: "submit",
				results: [
					answerForQuestion(questions[0], {
						selectedOptions: ["A"],
						note: "see [Image #1]",
						noteImages: [image],
					}),
				],
			})),
		);
	}

	it("delivers the original image followed by its admitted description", async () => {
		const result = await runAsk({});
		expect(result.content.slice(1)).toEqual([image, { type: "text", text: expect.stringContaining("ZEBRA 42") }]);
		expect(dispatched).toEqual([vision]);
		expect(sessions[0]?.model).toBe(textModel);
	});

	it.each(["model", "account", "session"] as const)(
		"refuses a changed %s owner during credential lookup",
		async replacement => {
			let current = true;
			await expect(
				runAsk({
					ownerCurrent: () => current,
					onLookup: async session => {
						if (replacement === "model") session.agent.setModel(vision);
						else if (replacement === "session") await session.sessionManager.newSession();
						else current = false;
					},
				}),
			).rejects.toBeInstanceOf(ToolAbortError);
			expect(dispatched).toEqual([]);
		},
	);

	it.each(["lookup", "admission"] as const)("does not dispatch after cancellation during %s", async stage => {
		const controller = new AbortController();
		await expect(
			runAsk({
				signal: controller.signal,
				...(stage === "lookup" ? { onLookup: () => controller.abort() } : { onPayload: () => controller.abort() }),
			}),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(dispatched).toEqual([]);
	});

	it("keeps the admitted attachment without dispatch when credit admission refuses the description", async () => {
		const result = await runAsk({
			onPayload: () => {
				throw new Error("Insufficient credit");
			},
		});
		expect(dispatched).toEqual([]);
		expect(result.content.filter(block => block.type === "image")).toEqual([image]);
	});

	it("never substitutes a model outside the configured allowlist", async () => {
		const result = await runAsk({
			settings: Settings.isolated({
				modelRoles: { vision: "openai/gpt-4o" },
				enabledModels: ["openai/gpt-4.1-mini"],
				"ask.notify": "off",
			}),
		});
		expect(dispatched).toEqual([]);
		expect(result.content.filter(block => block.type === "image")).toEqual([image]);
	});
});
