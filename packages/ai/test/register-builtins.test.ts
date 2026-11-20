import { afterEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as BedrockProvider from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { setBedrockProviderModule, streamBedrock } from "@oh-my-pi/pi-ai/providers/register-builtins";
import { completeSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// The transport override is process-global: put the built-in back so later files stream for real.
afterEach(() => setBedrockProviderModule(BedrockProvider));

async function drainMicrotasksUntil(predicate: () => boolean, errorMessage: string): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(errorMessage);
}

function createModel(
	overrides: { reasoning?: boolean; compat?: { streamIdleTimeoutMs?: number } } = {},
): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "mock-bedrock",
		name: "Mock Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://example.invalid",
		reasoning: overrides.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
		compat: overrides.compat,
	});
}

function createAssistantMessage(
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: errorMessage ? `error: ${errorMessage}` : "ok" }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: "mock-bedrock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

const baseContext: Context = { messages: [] };

describe("register-builtins lazy streams", () => {
	it.each(["caller-abort", "provider-failure", "unattributable-result"] as const)(
		"retains admitted completion custody through %s without inventing usage",
		async failure => {
			const entered = Promise.withResolvers<void>();
			const interrupt = Promise.withResolvers<void>();
			const final = Promise.withResolvers<AssistantMessage>();
			const controller = new AbortController();
			const message = createAssistantMessage();
			message.usage = {
				...message.usage,
				input: 17,
				output: 5,
				totalTokens: 22,
				cost: { ...message.usage.cost, total: 0.25 },
			};
			const providerFailure = new AIError.StreamTimeoutError("provider stalled after admission");
			let draining = false;
			const source = {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: createAssistantMessage() } as const;
					entered.resolve();
					await interrupt.promise;
					throw providerFailure;
				},
				result() {
					draining = true;
					return final.promise;
				},
			} as unknown as AssistantMessageEventStream;
			setBedrockProviderModule({ streamBedrock: () => source });
			const billed: number[] = [];
			let completed = false;
			const pending = completeSimple(createModel(), baseContext, {
				signal: controller.signal,
				waitForTerminalDrain: true,
				onAttempt: result => billed.push(result.usage.cost.total),
			}).then(result => {
				completed = true;
				return result;
			});
			try {
				await entered.promise;
				if (failure === "caller-abort") controller.abort(new Error("caller cancelled"));
				interrupt.resolve();
				await drainMicrotasksUntil(() => draining, "completion discarded its admitted provider result");
				expect(completed).toBe(false);
				expect(billed).toEqual([]);
				if (failure === "unattributable-result") {
					final.reject(new Error("provider result unavailable"));
					await expect(pending).rejects.toBe(providerFailure);
					expect(billed).toEqual([]);
				} else {
					final.resolve(message);
					const result = await pending;
					expect(result.stopReason).toBe(failure === "caller-abort" ? "aborted" : "error");
					expect(result.usage).toMatchObject({ input: 17, output: 5, totalTokens: 22, cost: { total: 0.25 } });
					expect(billed).toEqual([0.25]);
				}
			} finally {
				interrupt.resolve();
				final.resolve(message);
				await pending.catch(() => {});
			}
		},
	);

	it("resolves the outer stream result from source.result() when no terminal event is iterated", async () => {
		const finalMessage = createAssistantMessage("stop");
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
			},
			result: async () => finalMessage,
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream result");
		}
		expect(result).toEqual(finalMessage);
	});

	it("turns iterator failures into terminal error results", async () => {
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				throw new Error("bedrock exploded");
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded error result");
		}
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("bedrock exploded");
	});

	it("turns idle lazy provider streams into retryable terminal errors", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, { streamIdleTimeoutMs: 10 });
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream stall result");
		}
		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
		// The watchdog's StreamTimeoutError classification must survive onto the
		// message so session-level auto-retry can classify it structurally.
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("honors model.compat.streamIdleTimeoutMs as the lazy watchdog fallback", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		// No per-call option: the catalog compat override must reach the lazy
		// watchdog (a stalled Bedrock stream previously waited the generic 300s
		// default because model.compat was ignored on this path).
		const model = createModel({ reasoning: true, compat: { streamIdleTimeoutMs: 20 } });
		expect(model.compat.streamIdleTimeoutMs).toBe(20);
		const stream = streamBedrock(model, baseContext, {});
		// Real-clock race guard (matching this file's other lazy-stream tests):
		// the lazy watchdog runs on the platform clock, so fake timers cannot
		// drive it; the 20ms compat deadline settles the result long before the
		// bound, which exists only to fail fast instead of hanging the test.
		const result = await Promise.race([stream.result(), Bun.sleep(2_000).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for compat-driven stream stall result");
		}
		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});

	it("disables the lazy watchdog when model.compat.streamIdleTimeoutMs is 0", async () => {
		vi.useFakeTimers();
		try {
			const partialMessage = createAssistantMessage("stop");
			const abortController = new AbortController();
			let providerSignal: AbortSignal | undefined;
			let steadyState = false;
			const source = {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: partialMessage } as const;
					yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
					steadyState = true;
					const { promise, reject } = Promise.withResolvers<never>();
					if (providerSignal?.aborted) {
						reject(new Error("Request was aborted"));
					}
					providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
						once: true,
					});
					await promise;
				},
			} as unknown as AssistantMessageEventStream;

			setBedrockProviderModule({
				streamBedrock: (_model, _context, options) => {
					providerSignal = options.signal;
					return source;
				},
			});

			// reasoning:true would floor the watchdog at 600s for this id — the
			// explicit 0 override must disable it entirely through the lazy
			// wrapper, not fall back to any default (e.g. via a `||` regression).
			const model = createModel({ reasoning: true, compat: { streamIdleTimeoutMs: 0 } });
			expect(model.compat.streamIdleTimeoutMs).toBe(0);
			let settled = false;
			// First-event watchdog stays out of this case's scope (mirrors the
			// direct-Anthropic 0-disable test): fake-timer advancement could
			// otherwise outrun the microtask that consumes the first event.
			const resultPromise = streamBedrock(model, baseContext, {
				signal: abortController.signal,
				streamFirstEventTimeoutMs: 0,
			}).result();
			void resultPromise.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);

			await drainMicrotasksUntil(
				() => steadyState,
				"Bedrock mock stream did not reach steady-state idle for the compat-disabled watchdog test",
			);
			// Well past the generic 300s idle budget: the disabled watchdog must
			// not classify the post-first-event silence as a stall.
			vi.advanceTimersByTime(400_000);
			await drainMicrotasksUntil(
				() => vi.getTimerCount() === 0,
				"lazy watchdog timer did not drain after advancing past the idle budget",
			);
			expect(settled).toBe(false);
			expect(providerSignal?.aborted).toBe(false);

			abortController.abort();
			const result = await resultPromise;
			expect(result.stopReason).toBe("aborted");
			expect(result.errorMessage).toBe("Request was aborted");
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves caller aborts while forwarding lazy provider streams", async () => {
		const abortController = new AbortController();
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, {
			signal: abortController.signal,
			streamIdleTimeoutMs: 500,
		});
		const iterator = stream[Symbol.asyncIterator]();
		const firstEvent = await iterator.next();
		expect(firstEvent.value?.type).toBe("start");

		abortController.abort();
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded caller abort result");
		}
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});
});
