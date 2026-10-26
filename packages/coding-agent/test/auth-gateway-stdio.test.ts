import { describe, expect, it, spyOn } from "bun:test";
import { registerCustomApi, unregisterCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import { AuthGatewayStdioResponseLimitError } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { encodeGatewayJobId } from "@oh-my-pi/pi-ai/providers/video-server";
import * as anthropicMessages from "@oh-my-pi/pi-ai/providers/anthropic-messages-server";
import * as openaiChat from "@oh-my-pi/pi-ai/providers/openai-chat-server";
import * as openaiResponses from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import * as piNative from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createAuthGatewayStdioRouter, selectorCandidates } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { cfgDisabledModels, cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isRecord } from "@oh-my-pi/pi-utils";

const fast = getBundledModel("google", "gemini-3.5-flash")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const vertex = getBundledModel("google-vertex", "gemini-3.5-flash")!;
const models = [fast, mini, vertex];
const registry = { getAll: () => models, getAvailable: () => models };
const key = (model: typeof fast) => `${model.provider}/${model.id}`;
const video = buildModel({
	id: "video-test",
	name: "Video test",
	api: "openrouter-video",
	provider: "stdio-video-test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: null,
	maxTokens: null,
	kind: "video",
});
const fullRegistry = {
	getAll: (kind?: string) => (kind === "all" ? [...models, video] : models),
	getAvailable: (kind?: string) => (kind === "all" ? [...models, video] : models),
};

describe("auth-gateway stdio model selectors", () => {
	it("skips comma entries that resolve to nothing and follows the chosen role's fallback chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex), key(fast)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@commit,@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("follows a concrete model's own chain and stops at the first resolvable entry", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(mini)]: [key(vertex)] } });
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([mini, vertex]);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorCandidates("@commit", Settings.isolated({}), registry)).toEqual([]);
	});

	it("excludes denied models and disabled providers from concrete and role fallbacks", () => {
		const settings = Settings.isolated({
			disabledModels: [key(vertex)],
			"retry.fallbackChains": { smol: [key(vertex), key(mini)], [key(fast)]: [key(vertex), key(mini)] },
		});
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, mini]);
		expect(selectorCandidates(key(fast), settings, registry)).toEqual([fast, mini]);
		cfgDisabledProviders.override(settings, ["openai"]);
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
		expect(selectorCandidates(key(fast), settings, registry)).toEqual([fast]);
	});

	it("keeps the allowlist authoritative across fallback chains", () => {
		const settings = Settings.isolated({
			enabledModels: [key(fast)],
			"retry.fallbackChains": { [key(fast)]: [key(vertex), key(mini)] },
		});
		expect(selectorCandidates(key(fast), settings, registry)).toEqual([fast]);
	});

	it("resolves non-chat models from the complete inventory", () => {
		expect(selectorCandidates(`${video.provider}/${video.id}`, Settings.isolated({}), fullRegistry)).toEqual([video]);
	});
});

describe("auth-gateway stdio routing boundaries", () => {
	it("lists only permitted models and leaves unknown routes to the route owner", async () => {
		const storage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ disabledModels: [key(mini)], disabledProviders: ["google-vertex"] });
		const router = createAuthGatewayStdioRouter(storage, settings, fullRegistry);
		try {
			const listing = await router.route(new Request("http://stdio/v1/models"));
			const body = await listing.json();
			if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("Expected model inventory");
			expect(body.data.map(row => (isRecord(row) ? row.id : undefined))).toEqual([
				key(fast),
				`${video.provider}/${video.id}`,
			]);
			const unknown = await router.route(
				new Request("http://stdio/not-a-route", {
					method: "POST",
					body: JSON.stringify({ model: "missing" }),
				}),
			);
			expect(unknown.status).toBe(404);
			const unknownBody = await unknown.json();
			expect(isRecord(unknownBody) ? unknownBody.error : undefined).toEqual(expect.any(String));
		} finally {
			router.close();
			await storage.close();
		}
	});

	it("resolves a persisted video job before any submission and preserves credential refusal", async () => {
		const storage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({});
		const router = createAuthGatewayStdioRouter(storage, settings, fullRegistry);
		const id = encodeGatewayJobId({ provider: video.provider, modelId: video.id, upstreamId: "existing-job" });
		try {
			const response = await router.route(new Request(`http://stdio/v1/videos/${id}`));
			expect(response.status).toBe(401);
			cfgDisabledModels.override(settings, [`${video.provider}/${video.id}`]);
			const blocked = await router.route(new Request(`http://stdio/v1/videos/${id}`));
			expect(blocked.status).toBe(404);
		} finally {
			router.close();
			await storage.close();
		}
	});
});

let fixtureId = 0;

async function streamingFixture(
	emit: (stream: AssistantMessageEventStream, model: Model<Api>, options?: SimpleStreamOptions) => void,
) {
	const api = `stdio-fallback-test-${++fixtureId}`;
	const candidates = ["first", "denied", "second"].map(id =>
		buildModel({
			id,
			name: id,
			api,
			provider: api,
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 1024,
		}),
	);
	const storage = await AuthStorage.create(":memory:");
	storage.keys.setRuntime(api, "synthetic-key");
	const calls: string[] = [];
	registerCustomApi(
		api,
		(model, _context, options) => {
			calls.push(model.id);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => emit(stream, model, options));
			return stream;
		},
		api,
	);
	const settings = Settings.isolated({
		enabledModels: [key(candidates[0]), key(candidates[2])],
		"retry.fallbackChains": { smol: [key(candidates[1]), key(candidates[2])] },
	});
	settings.setModelRole("smol", key(candidates[0]));
	const router = createAuthGatewayStdioRouter(storage, settings, {
		getAll: () => candidates,
		getAvailable: () => candidates,
	});
	return {
		router,
		calls,
		async close() {
			router.close();
			await storage.close();
			unregisterCustomApi(api, api);
		},
	};
}

function streamMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function emitText(stream: AssistantMessageEventStream, message: AssistantMessage) {
	stream.push({ type: "start", partial: message });
	stream.push({ type: "text_start", contentIndex: 0, partial: message });
	const text = message.content[0];
	if (text.type !== "text") throw new Error("Expected scripted text");
	stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
	stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
}

const streamFormats = [
	{
		path: "/v1/chat/completions",
		module: openaiChat,
		body: { messages: [{ role: "user", content: "hello" }] },
	},
	{
		path: "/v1/responses",
		module: openaiResponses,
		body: { input: "hello" },
	},
	{
		path: "/v1/messages",
		module: anthropicMessages,
		body: { messages: [{ role: "user", content: "hello" }], max_tokens: 128 },
	},
	{
		path: "/v1/pi/stream",
		module: piNative,
		body: { context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] } },
	},
] as const;

function streamRequest(format: (typeof streamFormats)[number], signal?: AbortSignal) {
	return new Request(`http://stdio${format.path}`, {
		method: "POST",
		body: JSON.stringify({
			...format.body,
			...(format.path === "/v1/pi/stream" ? { modelId: "@smol" } : { model: "@smol" }),
			stream: true,
		}),
		signal,
	});
}

function splitGatewayStream(format: (typeof streamFormats)[number], chunks?: Uint8Array[]) {
	const transform = (chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) => {
		chunks?.push(chunk);
		for (let offset = 0; offset < chunk.byteLength; offset += 7) {
			controller.enqueue(chunk.subarray(offset, offset + 7));
		}
	};
	if (format.path === "/v1/pi/stream") {
		const encodeStream = format.module.encodeStream;
		return spyOn(format.module, "encodeStream").mockImplementation((...args) =>
			encodeStream(...args).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform })),
		);
	}
	const encodeStream = format.module.encodeStream;
	return spyOn(format.module, "encodeStream").mockImplementation((...args) =>
		encodeStream(...args).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform })),
	);
}

describe("auth-gateway stdio completed stream fallback", () => {
	for (const format of streamFormats) {
		it(`${format.path}: discards partial failed output and uses the next permitted model`, async () => {
			const fixture = await streamingFixture((stream, model) => {
				const message = streamMessage(model, model.id === "first" ? "discard-this-partial" : "fallback-answer");
				emitText(stream, message);
				if (model.id === "first") {
					message.stopReason = "error";
					message.errorMessage = "HTTP 503: provider temporarily unavailable";
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			const encoder = splitGatewayStream(format);
			try {
				const response = await fixture.router.route(streamRequest(format));
				const payload = await response.text();
				expect(response.status).toBe(200);
				expect(payload).toContain("fallback-answer");
				expect(payload).not.toContain("discard-this-partial");
				expect(payload).not.toContain("provider temporarily unavailable");
				expect(fixture.calls).toEqual(["first", "second"]);
			} finally {
				encoder.mockRestore();
				await fixture.close();
			}
		});

		it(`${format.path}: retries HTTP 408 on the next permitted model`, async () => {
			const fixture = await streamingFixture((stream, model) => {
				const message = streamMessage(
					model,
					model.id === "first" ? "timed-out-partial" : "timeout-fallback-answer",
				);
				emitText(stream, message);
				if (model.id === "first") {
					message.stopReason = "error";
					message.errorMessage = "HTTP 408: provider request timeout";
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			try {
				const response = await fixture.router.route(streamRequest(format));
				const payload = await response.text();
				expect(payload).toContain("timeout-fallback-answer");
				expect(payload).not.toContain("timed-out-partial");
				expect(fixture.calls).toEqual(["first", "second"]);
			} finally {
				await fixture.close();
			}
		});

		it(`${format.path}: preserves successful bytes, split framing, error-like text and tool JSON`, async () => {
			const fixture = await streamingFixture((stream, model) => {
				const message = streamMessage(
					model,
					'HTTP 503: error response.failed {"error":{"message":"aborted"}} — 🙂',
				);
				const toolCall = {
					type: "toolCall" as const,
					id: "call_synthetic",
					name: "inspect",
					arguments: { error: { message: "HTTP 503: aborted" }, type: "response.failed" },
				};
				message.content.push(toolCall);
				emitText(stream, message);
				stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
				stream.push({
					type: "toolcall_delta",
					contentIndex: 1,
					delta: JSON.stringify(toolCall.arguments),
					partial: message,
				});
				stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: message });
				message.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message });
			});
			const chunks: Uint8Array[] = [];
			const encoder = splitGatewayStream(format, chunks);
			try {
				const response = await fixture.router.route(streamRequest(format));
				expect(response.bodyUsed).toBe(false);
				expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(Buffer.concat(chunks)));
				expect(fixture.calls).toEqual(["first"]);
			} finally {
				encoder.mockRestore();
				await fixture.close();
			}
		});

		it(`${format.path}: retains the last model's terminal error on exhaustion`, async () => {
			const fixture = await streamingFixture((stream, model) => {
				const message = streamMessage(model, `${model.id}-partial`);
				emitText(stream, message);
				message.stopReason = "error";
				message.errorMessage = `HTTP 503: ${model.id}-real-error`;
				stream.push({ type: "error", reason: "error", error: message });
			});
			try {
				const response = await fixture.router.route(streamRequest(format));
				const payload = await response.text();
				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toContain("text/event-stream");
				expect(payload).toContain("second-real-error");
				expect(payload).not.toContain("first-real-error");
				expect(fixture.calls).toEqual(["first", "second"]);
			} finally {
				await fixture.close();
			}
		});

		for (const status of [400, 422]) {
			it(`${format.path}: does not retry an upstream invalid request (${status})`, async () => {
				const fixture = await streamingFixture((stream, model) => {
					const message = streamMessage(model, "");
					message.stopReason = "error";
					message.errorMessage = `HTTP ${status}: invalid request payload`;
					stream.push({ type: "error", reason: "error", error: message });
				});
				try {
					const response = await fixture.router.route(streamRequest(format));
					expect(await response.text()).toContain(`HTTP ${status}: invalid request payload`);
					expect(fixture.calls).toEqual(["first"]);
				} finally {
					await fixture.close();
				}
			});
		}
	}

	it("does not dispatch a provider for a malformed request", async () => {
		const fixture = await streamingFixture(() => {
			throw new Error("Malformed requests must not reach inference");
		});
		try {
			const response = await fixture.router.route(
				new Request("http://stdio/v1/chat/completions", {
					method: "POST",
					body: JSON.stringify({ model: "@smol", messages: "not-an-array", stream: true }),
				}),
			);
			expect(response.status).toBe(400);
			expect(fixture.calls).toEqual([]);
		} finally {
			await fixture.close();
		}
	});

	for (const format of [streamFormats[0], streamFormats[3]]) {
		it(`${format.path}: cancels an unfinished attempt without calling the fallback`, async () => {
			const started = Promise.withResolvers<void>();
			const cancelled = Promise.withResolvers<void>();
			const controller = new AbortController();
			const reason = new Error("synthetic caller cancellation");
			const fixture = await streamingFixture((stream, model, options) => {
				const message = streamMessage(model, "unfinished-partial");
				emitText(stream, message);
				options?.signal?.addEventListener(
					"abort",
					() => {
						message.stopReason = "aborted";
						message.errorMessage = reason.message;
						stream.push({ type: "error", reason: "aborted", error: message });
						cancelled.resolve();
					},
					{ once: true },
				);
				started.resolve();
			});
			try {
				const response = fixture.router.route(streamRequest(format, controller.signal));
				await started.promise;
				controller.abort(reason);
				await expect(response).rejects.toBe(reason);
				await cancelled.promise;
				expect(fixture.calls).toEqual(["first"]);
			} finally {
				await fixture.close();
			}
		});
	}

	it("pi-native: falls back after an encoder catch-path error", async () => {
		const fixture = await streamingFixture((stream, model) => {
			const message = streamMessage(model, model.id === "first" ? "thrown-partial" : "native-catch-fallback-answer");
			emitText(stream, message);
			if (model.id === "first") stream.fail(new Error("HTTP 503: native iterator failed"));
			else stream.push({ type: "done", reason: "stop", message });
		});
		try {
			const response = await fixture.router.route(streamRequest(streamFormats[3]));
			const payload = await response.text();
			expect(payload).toContain("native-catch-fallback-answer");
			expect(payload).not.toContain("thrown-partial");
			expect(payload).not.toContain("native iterator failed");
			expect(fixture.calls).toEqual(["first", "second"]);
		} finally {
			await fixture.close();
		}
	});

	it("pi-native: preserves an aborted terminal event without falling back", async () => {
		const fixture = await streamingFixture((stream, model) => {
			const message = streamMessage(model, "");
			message.stopReason = "aborted";
			message.errorMessage = "opaque provider cancellation reason";
			stream.push({ type: "error", reason: "aborted", error: message });
		});
		try {
			const response = await fixture.router.route(streamRequest(streamFormats[3]));
			const payload = await response.text();
			expect(payload).toContain("opaque provider cancellation reason");
			expect(payload).toContain('"reason":"aborted"');
			expect(fixture.calls).toEqual(["first"]);
		} finally {
			await fixture.close();
		}
	});

	it("pi-native: resolves canonical IDs before compatibility selectors on each request", async () => {
		const fixture = await streamingFixture((stream, model) => {
			const message = streamMessage(model, "native-selector-answer");
			emitText(stream, message);
			stream.push({ type: "done", reason: "stop", message });
		});
		try {
			for (const selector of [
				{ modelId: "@smol", model: "missing-selector" },
				{ model: "@smol" },
				{ model: { id: "@smol" } },
			]) {
				const response = await fixture.router.route(
					new Request("http://stdio/v1/pi/stream", {
						method: "POST",
						body: JSON.stringify({
							...selector,
							context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
						}),
					}),
				);
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("native-selector-answer");
			}
			expect(fixture.calls).toEqual(["first", "first", "first"]);
		} finally {
			await fixture.close();
		}
	});

	it("rejects a response-size overflow without calling the fallback", async () => {
		const fixture = await streamingFixture((stream, model) => {
			const message = streamMessage(model, "");
			const toolCall = {
				type: "toolCall" as const,
				id: "call_oversized",
				name: "inspect",
				arguments: { payload: "x".repeat(16 * 1024 * 1024) },
			};
			message.content = [toolCall];
			message.stopReason = "toolUse";
			stream.push({ type: "start", partial: message });
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			stream.push({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: JSON.stringify(toolCall.arguments),
				partial: message,
			});
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
		});
		let emittedBytes = 0;
		const encodeStream = openaiChat.encodeStream;
		const encoder = spyOn(openaiChat, "encodeStream").mockImplementation((...args) =>
			encodeStream(...args).pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						emittedBytes += chunk.byteLength;
						controller.enqueue(chunk);
					},
				}),
			),
		);
		try {
			await expect(fixture.router.route(streamRequest(streamFormats[0]))).rejects.toBeInstanceOf(
				AuthGatewayStdioResponseLimitError,
			);
			expect(emittedBytes).toBeGreaterThan(16 * 1024 * 1024);
			expect(fixture.calls).toEqual(["first"]);
		} finally {
			encoder.mockRestore();
			await fixture.close();
		}
	});
});
