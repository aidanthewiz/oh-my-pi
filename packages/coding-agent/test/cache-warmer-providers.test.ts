import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { encodeBedrockFrame as encodeBedrockTestFrame } from "../../ai/test/helpers/bedrock-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	CacheWarmer,
	type CacheWarmerDeps,
	type CacheWarmStream,
	type CacheWarmingRefreshEnd,
} from "../src/session/cache-warmer";

const PROMPT_TOKENS = 100_000;
// buildModel reapplies catalog TTLs; this fixture resets it for a 1ms timer.
const ACCELERATED_CACHE_TTL_SECONDS = 10.001;
const CONTEXT: Context = {
	systemPrompt: ["Keep this system prefix."],
	messages: [{ role: "user", content: "Keep this user prefix.", timestamp: 1 }],
};

interface WireCapture {
	url?: string;
	payload?: Record<string, unknown>;
	signal?: AbortSignal;
	aborted: boolean;
	bodyCanceled?: boolean;
	terminalMetadataSent: boolean;
}

async function captureRequest(capture: WireCapture, input: string | URL | Request, init?: RequestInit): Promise<void> {
	const request =
		input instanceof Request
			? new Request(input, init)
			: new Request(input instanceof URL ? input.href : input, init);
	capture.url = request.url;
	capture.signal = request.signal;
	const payload: unknown = await request.clone().json();
	if (!isRecord(payload)) throw new Error("Expected provider request payload object");
	capture.payload = payload;
}

function encodeBedrockFrame(eventType: string, payload: unknown): Uint8Array {
	return encodeBedrockTestFrame(
		{
			":message-type": "event",
			":event-type": eventType,
			":content-type": "application/json",
		},
		new TextEncoder().encode(JSON.stringify(payload)),
	);
}

function afterConsumerAdvances(
	source: CacheWarmStream,
	eventType: AssistantMessageEvent["type"],
	onAdvance: () => void,
): CacheWarmStream {
	return {
		async *[Symbol.asyncIterator]() {
			const iterator = source[Symbol.asyncIterator]();
			let releasePending = false;
			while (true) {
				if (releasePending) {
					releasePending = false;
					onAdvance();
				}
				const next = await iterator.next();
				if (next.done) return;
				yield next.value;
				if (next.value.type === eventType) releasePending = true;
			}
		},
		result: () => source.result(),
	};
}

function makeConverseModel(): Model<"bedrock-converse-stream"> {
	const model = buildModel({
		id: "us.anthropic.claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		thinking: { mode: "anthropic-adaptive", efforts: [Effort.High], supportsDisplay: true },
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		compat: {
			promptCacheMode: "explicit",
			supportsLongPromptCacheRetention: false,
			promptCacheMinimumTokens: 0,
			promptCacheMaximumCheckpoints: 2,
		},
	});
	model.promptCache = { ...model.promptCache, short: ACCELERATED_CACHE_TTL_SECONDS };
	return model;
}

function makeConverseFetch(capture: WireCapture, terminalGate: PromiseWithResolvers<void>, usage: Usage): FetchImpl {
	const initial = [
		encodeBedrockFrame("messageStart", { role: "assistant" }),
		encodeBedrockFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "x" } }),
	];
	const terminal = [
		encodeBedrockFrame("contentBlockStop", { contentBlockIndex: 0 }),
		encodeBedrockFrame("messageStop", { stopReason: "end_turn" }),
		encodeBedrockFrame("metadata", {
			usage: {
				inputTokens: usage.input,
				outputTokens: usage.output,
				cacheReadInputTokens: usage.cacheRead,
				cacheWriteInputTokens: usage.cacheWrite,
				totalTokens: usage.totalTokens,
			},
		}),
	];
	const fetchImpl: FetchImpl = async (input, init) => {
		await captureRequest(capture, input, init);
		capture.signal?.addEventListener(
			"abort",
			() => {
				capture.aborted = true;
				terminalGate.resolve();
			},
			{ once: true },
		);
		let tailSent = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of initial) controller.enqueue(frame);
			},
			async pull(controller) {
				if (tailSent) return;
				tailSent = true;
				await terminalGate.promise;
				if (capture.signal?.aborted) {
					controller.close();
					return;
				}
				for (const frame of terminal) controller.enqueue(frame);
				capture.terminalMetadataSent = true;
				controller.close();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
	};
	return fetchImpl;
}

function createConverseHarness(usage: Usage, deferTerminal = false) {
	const model = makeConverseModel();
	const capture: WireCapture = { aborted: false, terminalMetadataSent: false };
	const terminalAdvanced = Promise.withResolvers<void>();
	const refreshEnded = Promise.withResolvers<CacheWarmingRefreshEnd>();
	const warmed: AssistantMessage[] = [];
	let payloadHooks = 0;
	const warmer = new CacheWarmer({
		stream: (requestModel, context, options) => {
			const terminalGate = Promise.withResolvers<void>();
			const source = streamSimple(requestModel, context, {
				...options,
				fetch: makeConverseFetch(capture, terminalGate, usage),
			});
			return afterConsumerAdvances(source, "text_start", () => {
				terminalAdvanced.resolve();
				if (!deferTerminal) terminalGate.resolve();
			});
		},
		getPromptTokens: () => PROMPT_TOKENS,
		getMode: () => "streaming",
	});
	warmers.add(warmer);
	warmer.onWarmed = message => warmed.push(message);
	warmer.onRefreshEnd = refreshEnded.resolve;
	warmer.start(
		{
			model,
			context: CONTEXT,
			options: {
				cacheRetention: "long",
				reasoning: Effort.High,
				providerOptions: { bearerToken: "test-bedrock-token" },
				onPayload: payload => {
					payloadHooks++;
					return payload;
				},
			},
		},
		() => undefined,
	);
	return {
		warmer,
		model,
		capture,
		terminalAdvanced: terminalAdvanced.promise,
		refreshEnded: refreshEnded.promise,
		warmed,
		get payloadHooks() {
			return payloadHooks;
		},
	};
}

function makeAnthropicModel(
	provider: "amazon-bedrock" | "bedrock-mantle",
	baseUrl: string,
): Model<"anthropic-messages"> {
	const model = buildModel({
		id: "anthropic.claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 128_000,
		compat: { supportsLongCacheRetention: false },
	});
	model.promptCache = { ...model.promptCache, short: ACCELERATED_CACHE_TTL_SECONDS };
	return model;
}

function anthropicEvent(type: string, data: unknown): Uint8Array {
	return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function makeMessagesFetch(capture: WireCapture, terminalGate: PromiseWithResolvers<void>): FetchImpl {
	const fetchImpl: FetchImpl = async (input, init) => {
		await captureRequest(capture, input, init);
		const onAbort = () => {
			capture.aborted = true;
			terminalGate.resolve();
		};
		capture.signal?.addEventListener("abort", onAbort, { once: true });
		if (capture.signal?.aborted) onAbort();
		let stage = 0;
		let bodyCanceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					anthropicEvent("message_start", {
						type: "message_start",
						message: {
							id: "msg_1",
							type: "message",
							role: "assistant",
							content: [],
							model: "anthropic.claude-opus-5-5",
							stop_reason: null,
							stop_sequence: null,
							usage: {
								input_tokens: 1,
								output_tokens: 0,
								cache_read_input_tokens: PROMPT_TOKENS,
								cache_creation_input_tokens: 0,
							},
						},
					}),
				);
			},
			async pull(controller) {
				if (stage === 0) {
					stage = 1;
					controller.enqueue(
						anthropicEvent("content_block_start", {
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						}),
					);
					controller.enqueue(
						anthropicEvent("content_block_delta", {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "x" },
						}),
					);
					return;
				}
				if (stage === 1) {
					stage = 2;
					await terminalGate.promise;
					if (capture.signal?.aborted || bodyCanceled) {
						if (!bodyCanceled) controller.close();
						return;
					}
					const chunks = [
						anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
						anthropicEvent("message_delta", {
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 1 },
						}),
						anthropicEvent("message_stop", { type: "message_stop" }),
					];
					const joined = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
					let offset = 0;
					for (const chunk of chunks) {
						joined.set(chunk, offset);
						offset += chunk.length;
					}
					controller.enqueue(joined);
					capture.terminalMetadataSent = true;
					controller.close();
				}
			},
			cancel() {
				bodyCanceled = true;
				capture.bodyCanceled = true;
				terminalGate.resolve();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return fetchImpl;
}

function createMessagesHarness(provider: "amazon-bedrock" | "bedrock-mantle", baseUrl: string) {
	const model = makeAnthropicModel(provider, baseUrl);
	const capture: WireCapture = { aborted: false, terminalMetadataSent: false };
	const refreshEnded = Promise.withResolvers<CacheWarmingRefreshEnd>();
	const warmer = new CacheWarmer({
		stream: (requestModel, context, options) => {
			const terminalGate = Promise.withResolvers<void>();
			return streamSimple(requestModel, context, {
				...options,
				fetch: makeMessagesFetch(capture, terminalGate),
			});
		},
		getPromptTokens: () => PROMPT_TOKENS,
		getMode: () => "streaming",
	});
	warmers.add(warmer);
	warmer.onRefreshEnd = refreshEnded.resolve;
	warmer.start(
		{
			model,
			context: CONTEXT,
			options: {
				cacheRetention: "long",
				...(provider === "amazon-bedrock" ? { apiKey: "bedrock-runtime-api-key" } : {}),
				...(provider === "bedrock-mantle"
					? { providerOptions: { bearerToken: "mantle-bearer-token", region: "us-east-1" } }
					: {}),
			},
		},
		() => undefined,
	);
	return { warmer, model, capture, refreshEnded: refreshEnded.promise };
}

async function drain(): Promise<void> {
	for (let i = 0; i < 150; i++) await Promise.resolve();
}

async function advanceWarmTimer(): Promise<void> {
	vi.advanceTimersByTime(1);
	await drain();
}

function makeUsage(cacheRead: number, cacheWrite: number): Usage {
	return {
		input: 5,
		output: 1,
		cacheRead,
		cacheWrite,
		totalTokens: 100_006,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createResponsesPayloadHarness(
	options: Pick<SimpleStreamOptions, "onPayload" | "cacheRetention">,
	decide?: CacheWarmerDeps["decide"],
	terminal: "completed" | "failed" = "completed",
) {
	const bundled = getBundledModel<"openai-responses">("openai", "gpt-5.6");
	if (!bundled) throw new Error("Expected bundled openai/gpt-5.6");
	const model: Model<"openai-responses"> = {
		...bundled,
		promptCache: { short: ACCELERATED_CACHE_TTL_SECONDS, long: ACCELERATED_CACHE_TTL_SECONDS },
	};
	const bodies: Record<string, unknown>[] = [];
	const warmed: { message: AssistantMessage; extensionOverride: boolean }[] = [];
	const ended = Promise.withResolvers<CacheWarmingRefreshEnd>();
	const fetchSynthetic: FetchImpl = async (_input, init) => {
		if (typeof init?.body !== "string") throw new Error("Expected serialized Responses request");
		bodies.push(JSON.parse(init.body));
		const item = {
			type: "message",
			id: "msg_warm_payload",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Synthetic cache refresh" }],
		};
		const terminalEvent = {
			type: `response.${terminal}`,
			response: {
				id: "resp_warm_payload",
				status: terminal,
				output: terminal === "failed" ? [] : [item],
				...(terminal === "failed"
					? { error: { code: "invalid_request_error", message: "Synthetic paid rejection" } }
					: {}),
				usage: {
					input_tokens: 6000,
					output_tokens: 0,
					total_tokens: 6000,
					input_tokens_details: { cached_tokens: 6000 },
				},
			},
		};
		const events =
			terminal === "failed"
				? [terminalEvent]
				: [
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { ...item, status: "in_progress", content: [] },
						},
						{
							type: "response.content_part.added",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "" },
						},
						{
							type: "response.output_text.delta",
							output_index: 0,
							content_index: 0,
							delta: "Synthetic cache refresh",
						},
						{ type: "response.output_item.done", output_index: 0, item },
						terminalEvent,
					];
		return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	};
	const warmer = new CacheWarmer({
		stream: (requestModel, context, replayOptions) => {
			const source = streamOpenAIResponses(requestModel as Model<"openai-responses">, context, {
				...replayOptions,
				apiKey: "test-key",
				reasoning: undefined,
				fetch: fetchSynthetic,
				statefulResponses: false,
			});
			return {
				async *[Symbol.asyncIterator]() {
					await source.result();
					yield* source;
				},
				result: () => source.result(),
			};
		},
		getPromptTokens: () => 6000,
		getMode: () => "streaming",
		decide,
	});
	warmers.add(warmer);
	warmer.onWarmed = (message, extensionOverride) => warmed.push({ message, extensionOverride });
	warmer.onRefreshEnd = ended.resolve;
	const request = {
		model,
		context: CONTEXT,
		options: { apiKey: "test-key", cacheRetention: "long" as const, ...options },
	};
	warmer.start(request, () => undefined);
	return { warmer, request, bodies, warmed, ended: ended.promise };
}

const warmers = new Set<CacheWarmer>();

beforeEach(() => vi.useFakeTimers());

afterEach(async () => {
	for (const warmer of warmers) warmer.cancel();
	warmers.clear();
	await drain();
	vi.useRealTimers();
});

describe("cache warmer provider replay behavior", () => {
	test("Converse waits for terminal cache usage with a one-token adaptive request and unchanged prefix/effort", async () => {
		const h = createConverseHarness(makeUsage(PROMPT_TOKENS, 0));
		// onPayload is passed through by the warmer option clone, rather than
		// being replaced by the adaptive thinking-budget override.
		await advanceWarmTimer();
		const ended = await h.refreshEnded;
		const payload = h.capture.payload;
		expect(ended.outcome).toBe("hit");
		expect(h.warmer.status.state).toBe("scheduled");
		expect(h.capture.terminalMetadataSent).toBe(true);
		expect(h.capture.aborted).toBe(false);
		expect(payload?.inferenceConfig).toMatchObject({ maxTokens: 1 });
		expect(payload?.additionalModelRequestFields).toMatchObject({
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		});
		const requestText = JSON.stringify(payload);
		expect(requestText).toContain("Keep this system prefix.");
		expect(requestText).toContain("Keep this user prefix.");
		expect(requestText).toContain('"cachePoint":{"type":"default"}');
		expect(requestText).not.toContain('"ttl":"1h"');
		expect(h.warmed[0]?.usage.output).toBe(1);
		expect(h.payloadHooks).toBe(1);
		expect(requestText).not.toContain("budget_tokens");
		h.warmer.cancel();
	});

	test("Converse terminal cache writes stop warming after a miss", async () => {
		const h = createConverseHarness(makeUsage(0, PROMPT_TOKENS));
		await advanceWarmTimer();
		const ended = await h.refreshEnded;
		expect(ended.outcome).toBe("miss");
		expect(h.capture.terminalMetadataSent).toBe(true);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "refresh missed the cache" });
	});

	test("Converse run cancellation aborts while terminal usage is pending", async () => {
		const h = createConverseHarness(makeUsage(PROMPT_TOKENS, 0), true);
		await advanceWarmTimer();
		const reachedTerminalWait = await Promise.race([
			h.terminalAdvanced.then(() => true),
			h.refreshEnded.then(() => false),
		]);
		expect(reachedTerminalWait).toBe(true);
		expect(h.capture.signal?.aborted).toBe(false);
		h.warmer.cancel();
		const ended = await h.refreshEnded;
		expect(ended.outcome).toBe("aborted");
		await drain();
		expect(h.capture.signal?.aborted).toBe(true);
		expect(h.capture.terminalMetadataSent).toBe(false);
	});

	for (const route of [
		{
			name: "Bedrock Runtime /anthropic",
			provider: "amazon-bedrock" as const,
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
		},
		{
			name: "Bedrock Mantle /anthropic",
			provider: "bedrock-mantle" as const,
			baseUrl: "https://bedrock-mantle.{region}.api.aws/anthropic",
		},
	]) {
		test(route.name + " preserves early usage and cuts generation off", async () => {
			const h = createMessagesHarness(route.provider, route.baseUrl);
			await advanceWarmTimer();
			const ended = await h.refreshEnded;
			expect(ended.outcome).toBe("hit");
			expect(h.capture.bodyCanceled).toBe(true);
			expect(h.capture.terminalMetadataSent).toBe(false);
			expect(h.capture.url).toBe(route.baseUrl.replace("{region}", "us-east-1") + "/v1/messages");
			expect(h.capture.payload).toMatchObject({ max_tokens: 1 });
			const requestText = JSON.stringify(h.capture.payload);
			expect(requestText).toContain("Keep this user prefix.");
			expect(requestText).toContain('"type":"ephemeral"');
			expect(requestText).not.toContain('"ttl":"1h"');
			expect(h.warmer.status.state).toBe("scheduled");
			h.warmer.cancel();
		});
	}

	test("budget-based mandatory Converse reasoning is refused before a provider request", () => {
		const model = makeConverseModel();
		model.thinking = { mode: "budget", efforts: [Effort.High], requiresEffort: true };
		let streamCalls = 0;
		const warmer = new CacheWarmer({
			stream: () => {
				streamCalls++;
				throw new Error("unsafe budget-based replay was sent");
			},
			getPromptTokens: () => PROMPT_TOKENS,
			getMode: () => "streaming",
		});
		warmers.add(warmer);
		warmer.start({ model, context: CONTEXT, options: { reasoning: Effort.High } }, () => undefined);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "request cannot be replayed safely" });
		expect(streamCalls).toBe(0);
	});
});

describe("cache warmer preserves real Responses accounting", () => {
	for (const partial of [true, false]) {
		test.each([
			{ provider: "openai", servedTier: undefined, money: {}, expected: 1 },
			{ provider: "openai", servedTier: "priority", money: {}, expected: 2 },
			{ provider: "openrouter", servedTier: undefined, money: { cost: 7.25 }, expected: 7.25 },
			{ provider: "openrouter", servedTier: undefined, money: { cost: 0 }, expected: 0 },
			{
				provider: "openrouter",
				servedTier: undefined,
				money: { cost: 0.75, is_byok: true, cost_details: { upstream_inference_cost: 7 } },
				expected: 7.75,
			},
		] as const)(
			`${partial ? "partial cutoff" : "normal done"} retains $provider monetary total $expected`,
			async scenario => {
				const official = buildModel({
					id: "gpt-5.6",
					name: "GPT-5.6",
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: true,
					input: ["text"],
					cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
					contextWindow: 400_000,
					maxTokens: 128_000,
				});
				const model: Model<"openai-responses"> = {
					...official,
					provider: scenario.provider,
					id: scenario.provider === "openai" ? "gpt-5.6" : "openai/gpt-5.6",
					baseUrl: scenario.provider === "openai" ? official.baseUrl : "https://openrouter.ai/api/v1",
					identity: classifyModel(
						scenario.provider,
						scenario.provider === "openai" ? "gpt-5.6" : "openai/gpt-5.6",
					),
					promptCache: { short: ACCELERATED_CACHE_TTL_SECONDS, long: ACCELERATED_CACHE_TTL_SECONDS },
				};
				const originalModel = structuredClone(model);
				const bodies: Record<string, unknown>[] = [];
				const consumed: AssistantMessageEvent["type"][] = [];
				const warmed: AssistantMessage[] = [];
				const ended = Promise.withResolvers<CacheWarmingRefreshEnd>();
				let decoded: AssistantMessage | undefined;
				let originalUsage: Usage | undefined;
				const fetchSynthetic: FetchImpl = async (_input, init) => {
					if (typeof init?.body !== "string") throw new Error("Expected serialized Responses request");
					bodies.push(JSON.parse(init.body));
					const item = {
						type: "message",
						id: "msg_warming",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Accounted warm response" }],
					};
					const events = [
						...(partial
							? [
									{
										type: "response.output_item.added",
										output_index: 0,
										item: { ...item, status: "in_progress", content: [] },
									},
									{
										type: "response.content_part.added",
										output_index: 0,
										content_index: 0,
										part: { type: "output_text", text: "" },
									},
									{
										type: "response.output_text.delta",
										output_index: 0,
										content_index: 0,
										delta: "Accounted warm response",
									},
								]
							: []),
						{ type: "response.output_item.done", output_index: 0, item },
						{
							type: "response.completed",
							response: {
								status: "completed",
								service_tier: scenario.servedTier,
								usage: {
									input_tokens: 100_000,
									output_tokens: 0,
									total_tokens: 100_000,
									input_tokens_details: { cached_tokens: 0, cache_write_tokens: 100_000 },
									...scenario.money,
								},
							},
						},
					];
					return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				};
				const warmer = new CacheWarmer({
					stream: (requestModel, context, options) => {
						const source = streamSimple(requestModel, context, {
							...options,
							fetch: fetchSynthetic,
							statefulResponses: false,
						});
						return {
							async *[Symbol.asyncIterator]() {
								// Let the real producer finish before the slower consumer drains its queued events.
								decoded = await source.result();
								originalUsage = structuredClone(decoded.usage);
								for await (const event of source) {
									consumed.push(event.type);
									yield event;
								}
							},
							result: () => source.result(),
						};
					},
					getPromptTokens: () => PROMPT_TOKENS,
					getMode: () => "streaming",
				});
				warmers.add(warmer);
				warmer.onWarmed = message => warmed.push(message);
				warmer.onRefreshEnd = ended.resolve;
				warmer.start(
					{
						model,
						context: CONTEXT,
						options: {
							apiKey: "test-key",
							cacheRetention: "long",
							serviceTier: scenario.servedTier ? "flex" : undefined,
						},
					},
					() => undefined,
				);
				await advanceWarmTimer();
				const refresh = await ended.promise;
				expect(bodies).toHaveLength(1);
				expect(bodies[0]?.prompt_cache_options).toEqual({ mode: "implicit", ttl: "12h" });
				expect(originalUsage?.cost.total).toBeCloseTo(scenario.expected, 10);
				expect(decoded?.usage).toEqual(originalUsage);
				expect(model).toEqual(originalModel);
				expect(consumed.includes("done")).toBe(!partial);
				expect(warmed).toHaveLength(1);
				expect(warmed[0]?.stopReason).toBe(partial ? "aborted" : "stop");
				expect(warmed[0]?.usage.cacheWrite).toBe(100_000);
				expect(warmed[0]?.usage.cost.total).toBeCloseTo(scenario.expected, 10);
				expect(refresh.usage?.cost.total).toBeCloseTo(scenario.expected, 10);
			},
		);
	}

	test("retains billed usage and cost from a failed Responses replay", async () => {
		const h = createResponsesPayloadHarness({}, undefined, "failed");
		await advanceWarmTimer();
		const ended = await h.ended;
		await h.warmer.drain();
		expect(h.bodies).toHaveLength(1);
		expect(h.warmed).toHaveLength(1);
		expect(h.warmed[0]).toMatchObject({
			extensionOverride: false,
			message: {
				provider: "openai",
				model: h.request.model.id,
				stopReason: "error",
				usage: { input: 0, output: 0, cacheRead: 6000, cacheWrite: 0, totalTokens: 6000 },
			},
		});
		expect(h.warmed[0]?.message.usage.cost.total).toBeCloseTo(0.0024, 10);
		expect(ended.outcome).toBe("error");
		expect(ended.usage?.cost.total).toBeCloseTo(0.0024, 10);
		expect(h.warmer.status).toMatchObject({ state: "inactive", reason: "refresh failed" });
	});
});

describe("cache warmer admits the final Responses payload", () => {
	for (const mutation of ["replacement", "in-place"] as const) {
		test(`${mutation} shortening to 30m stops before fetch`, async () => {
			const onPayload = vi.fn((payload: unknown) => {
				if (!isRecord(payload)) throw new Error("Expected Responses payload");
				const prompt_cache_options = { mode: "implicit", ttl: "30m" };
				if (mutation === "replacement") return { ...payload, prompt_cache_options };
				payload.prompt_cache_options = prompt_cache_options;
				return undefined;
			});
			const decide = vi.fn<NonNullable<CacheWarmerDeps["decide"]>>(async event => event.action);
			const h = createResponsesPayloadHarness({ onPayload }, decide);
			await advanceWarmTimer();
			const ended = await h.ended;
			expect(h.bodies).toHaveLength(0);
			expect(onPayload).toHaveBeenCalledTimes(1);
			expect(decide).toHaveBeenCalledTimes(2);
			expect(decide.mock.calls[0]?.[0].action).toBe("warm");
			expect(decide.mock.calls[1]?.[0].action).toBe("stop");
			expect(h.warmed).toHaveLength(0);
			expect(ended.outcome).toBe("aborted");
			expect(ended.usage).toBeUndefined();
			expect(h.warmer.status).toMatchObject({
				state: "inactive",
				reason: "expected savings below threshold",
				decision: { action: "stop" },
				extensionOverride: false,
			});
		});
	}

	test("a revised extension stop vetoes a final beneficial request", async () => {
		const onPayload = vi.fn((payload: unknown) => {
			if (!isRecord(payload)) throw new Error("Expected Responses payload");
			return { ...payload, prompt_cache_options: { mode: "implicit", ttl: "12h" } };
		});
		const decide = vi.fn<NonNullable<CacheWarmerDeps["decide"]>>(async event =>
			event.action === "stop" ? "warm" : "stop",
		);
		const h = createResponsesPayloadHarness({ cacheRetention: "short", onPayload }, decide);
		await advanceWarmTimer();
		const ended = await h.ended;
		expect(h.bodies).toHaveLength(0);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(decide).toHaveBeenCalledTimes(2);
		expect(h.warmed).toHaveLength(0);
		expect(ended.outcome).toBe("aborted");
		expect(ended.usage).toBeUndefined();
		expect(h.warmer.status).toMatchObject({
			state: "inactive",
			reason: "stopped by extension",
			decision: { action: "warm" },
			extensionOverride: true,
		});
	});

	test("unchanged beneficial 12h payload fetches once without repeating extension decisions", async () => {
		const onPayload = vi.fn((payload: unknown) => payload);
		const decide = vi.fn<NonNullable<CacheWarmerDeps["decide"]>>(async event => event.action);
		const h = createResponsesPayloadHarness({ onPayload }, decide);
		const originalModel = structuredClone(h.request.model);
		await advanceWarmTimer();
		const ended = await h.ended;
		expect(h.bodies).toHaveLength(1);
		expect(h.bodies[0]?.prompt_cache_options).toEqual({ mode: "implicit", ttl: "12h" });
		expect(h.bodies[0]?.max_output_tokens).toBe(1);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(decide).toHaveBeenCalledTimes(1);
		expect(h.warmed).toHaveLength(1);
		expect(h.warmed[0]?.extensionOverride).toBe(false);
		expect(h.warmed[0]?.message.usage.cacheRead).toBe(6000);
		expect(h.warmed[0]?.message.usage.cost.total).toBeCloseTo(0.0024, 10);
		expect(ended.usage?.cost.total).toBeCloseTo(0.0024, 10);
		expect(ended.outcome).toBe("hit");
		expect(h.request.model).toEqual(originalModel);
		expect(h.warmer.status.state).toBe("scheduled");
	});

	test("a revised extension warm override permits the final low-benefit request and attributes its cost", async () => {
		const onPayload = vi.fn((payload: unknown) => {
			if (!isRecord(payload)) throw new Error("Expected Responses payload");
			return { ...payload, prompt_cache_options: { mode: "implicit", ttl: "30m" } };
		});
		const decide = vi.fn(async () => "warm" as const);
		const h = createResponsesPayloadHarness({ onPayload }, decide);
		await advanceWarmTimer();
		const ended = await h.ended;
		expect(h.bodies).toHaveLength(1);
		expect(h.bodies[0]?.prompt_cache_options).toEqual({ mode: "implicit", ttl: "30m" });
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(decide).toHaveBeenCalledTimes(2);
		expect(h.warmed).toHaveLength(1);
		expect(h.warmed[0]?.extensionOverride).toBe(true);
		expect(h.warmed[0]?.message.usage.cost.total).toBeCloseTo(0.0024, 10);
		expect(ended.usage?.cost.total).toBeCloseTo(0.0024, 10);
		expect(ended.outcome).toBe("hit");
	});

	test("a final beneficial request removes an earlier extension override attribution", async () => {
		const onPayload = vi.fn((payload: unknown) => {
			if (!isRecord(payload)) throw new Error("Expected Responses payload");
			return { ...payload, prompt_cache_options: { mode: "implicit", ttl: "12h" } };
		});
		const decide = vi.fn(async () => "warm" as const);
		const h = createResponsesPayloadHarness({ cacheRetention: "short", onPayload }, decide);
		await advanceWarmTimer();
		const ended = await h.ended;
		expect(h.bodies).toHaveLength(1);
		expect(h.bodies[0]?.prompt_cache_options).toEqual({ mode: "implicit", ttl: "12h" });
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(decide).toHaveBeenCalledTimes(2);
		expect(h.warmed).toHaveLength(1);
		expect(h.warmed[0]?.extensionOverride).toBe(false);
		expect(ended.outcome).toBe("hit");
	});

	test("an explicit extension stop never evaluates a payload hook or submits", async () => {
		const onPayload = vi.fn((payload: unknown) => payload);
		const decide = vi.fn(async () => "stop" as const);
		const h = createResponsesPayloadHarness({ onPayload }, decide);
		await advanceWarmTimer();
		await h.warmer.drain();
		expect(onPayload).toHaveBeenCalledTimes(0);
		expect(decide).toHaveBeenCalledTimes(1);
		expect(h.bodies).toHaveLength(0);
		expect(h.warmed).toHaveLength(0);
		expect(h.warmer.status).toMatchObject({
			state: "inactive",
			reason: "stopped by extension",
			extensionOverride: true,
		});
	});

	for (const interruption of ["cancel", "replace", "context"] as const) {
		test(`${interruption} during an awaited payload hook prevents submission`, async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let current = true;
			const onPayload = vi.fn(async (payload: unknown) => {
				entered.resolve();
				await release.promise;
				return payload;
			});
			const h = createResponsesPayloadHarness({ onPayload });
			if (interruption === "context") h.warmer.start(h.request, () => (current ? undefined : { kind: "history" }));
			try {
				await advanceWarmTimer();
				await entered.promise;
				if (interruption === "cancel") h.warmer.cancel();
				if (interruption === "replace") h.warmer.start(h.request, () => undefined);
				if (interruption === "context") current = false;
			} finally {
				release.resolve();
			}
			const ended = await h.ended;
			expect(h.bodies).toHaveLength(0);
			expect(onPayload).toHaveBeenCalledTimes(1);
			expect(h.warmed).toHaveLength(0);
			expect(ended.outcome).toBe("aborted");
			expect(h.warmer.status.state).toBe(interruption === "replace" ? "scheduled" : "inactive");
		});
	}

	test("cancellation during a revised awaited extension decision prevents submission", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const onPayload = vi.fn((payload: unknown) => {
			if (!isRecord(payload)) throw new Error("Expected Responses payload");
			return { ...payload, prompt_cache_options: { mode: "implicit", ttl: "30m" } };
		});
		const decide = vi.fn<NonNullable<CacheWarmerDeps["decide"]>>(async event => {
			if (event.action === "stop") {
				entered.resolve();
				await release.promise;
				return "warm";
			}
			return event.action;
		});
		const h = createResponsesPayloadHarness({ onPayload }, decide);
		try {
			await advanceWarmTimer();
			await entered.promise;
			h.warmer.cancel();
		} finally {
			release.resolve();
		}
		const ended = await h.ended;
		expect(h.bodies).toHaveLength(0);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(decide).toHaveBeenCalledTimes(2);
		expect(h.warmed).toHaveLength(0);
		expect(ended.outcome).toBe("aborted");
		expect(h.warmer.status.state).toBe("inactive");
	});
});
