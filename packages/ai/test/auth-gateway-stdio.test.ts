import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import {
	AuthGatewayStdioResponseLimitError,
	type AuthGatewayStdioOptions,
	createAuthGatewayRouter,
	readAuthGatewayStdioBody,
	serveAuthGatewayStdio,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage, type ObservedUsageInput } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Serves `lines` through `route`; the parsed output lines. */
async function serve(
	lines: string[],
	route: (req: Request) => Promise<Response>,
	limits: Pick<AuthGatewayStdioOptions, "maxConcurrentRequests" | "maxResponseBytes"> = {},
): Promise<unknown[]> {
	const output: unknown[] = [];
	await serveAuthGatewayStdio({
		input: new Response(`${lines.join("\n")}\n`).body!,
		write: line => {
			output.push(JSON.parse(line));
		},
		route,
		version: "test",
		...limits,
	});
	return output;
}

afterEach(() => {
	vi.restoreAllMocks();
	clearCustomApis();
});

describe("auth-gateway stdio transport", () => {
	it.each(["chat", "native"] as const)(
		"drains %s requests and their late usage before closing provider state or credential storage",
		async format => {
			const api = `gateway-close-${format}`;
			const model = buildModel({
				id: "owned-model",
				name: "Owned model",
				api,
				provider: api,
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			});
			const message: AssistantMessage = {
				role: "assistant",
				api,
				provider: api,
				model: model.id,
				content: [],
				usage: {
					input: 17,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 22,
					cost: { input: 0.17, output: 0.08, cacheRead: 0, cacheWrite: 0, total: 0.25 },
				},
				stopReason: "aborted",
				timestamp: 1,
			};
			const storage = await AuthStorage.create(":memory:");
			storage.keys.setRuntime(api, "synthetic-key");
			const observed: ObservedUsageInput[] = [];
			vi.spyOn(storage.usage, "observe").mockImplementation(entry => observed.push(entry));
			const source = new AssistantMessageEventStream();
			const entered = Promise.withResolvers<void>();
			const cancelled = Promise.withResolvers<void>();
			const stateClosedAfterUsage: number[] = [];
			let sends = 0;
			registerCustomApi(
				api,
				(_model, _context, options) => {
					sends++;
					if (!options?.signal || !options.providerSessionState) throw new Error("Missing request owner");
					options.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
					options.providerSessionState.set("owned-probe", {
						close: () => stateClosedAfterUsage.push(observed.length),
					});
					source.push({ type: "start", partial: message });
					entered.resolve();
					return source;
				},
				api,
			);
			const router = createAuthGatewayRouter({ storage, resolveModel: () => model });
			const request = () =>
				new Request(format === "chat" ? "http://stdio/v1/chat/completions" : "http://stdio/v1/pi/stream", {
					method: "POST",
					body: JSON.stringify(
						format === "chat"
							? { model: model.id, messages: [{ role: "user", content: "hi" }], stream: true }
							: { modelId: model.id, context: { messages: [] }, stream: true },
					),
				});
			let close: Promise<void> | undefined;
			try {
				const response = await router.route(request(), "test");
				await entered.promise;
				close = router.close().then(() => storage.close());
				await cancelled.promise;
				await response.body?.cancel();
				expect(storage.isClosed).toBe(false);
				expect(observed).toEqual([]);
				expect(stateClosedAfterUsage).toEqual([]);
				const rejected = await router.route(request(), "test");
				expect(rejected.status).toBe(503);
				expect(sends).toBe(1);
				source.push({ type: "error", reason: "aborted", error: message });
				await close;
				expect(storage.isClosed).toBe(true);
				expect(observed).toMatchObject([
					{ provider: api, model: model.id, usage: { input: 17, output: 5 }, costUsd: 0.25 },
				]);
				expect(stateClosedAfterUsage).toEqual([1]);
			} finally {
				source.push({ type: "error", reason: "aborted", error: message });
				await router.close();
				await close;
				await storage.close();
			}
		},
	);

	it("answers a chat request line through the gateway routes", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-stdio-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.keys.setRuntime("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "mock/stdio-model" });
		const router = createAuthGatewayRouter({ storage, resolveModel: () => mock.model });
		try {
			mock.push({ content: ["hello"] });
			const request = {
				id: "a",
				path: "/v1/chat/completions",
				body: { model: "mock/stdio-model", messages: [{ role: "user", content: "hi" }] },
			};
			const output = await serve([JSON.stringify(request)], req => router.route(req, "test"));
			expect(output[0]).toEqual({ ready: true, version: "test" });
			expect(output[1]).toMatchObject({
				id: "a",
				status: 200,
				body: { object: "chat.completion", choices: [{ message: { role: "assistant", content: "hello" } }] },
			});
		} finally {
			await router.close();
			await storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("serves Apple chat without a stored credential while rejecting credential-required providers", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-stdio-keyless-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const apple = createMockModel({ provider: "apple", id: "on-device" });
		// Unregistered provider: no env-var fallback, so a host `~/.env` key cannot satisfy it.
		const required = createMockModel({ provider: "keyed-test", id: "missing-key" });
		const router = createAuthGatewayRouter({
			storage,
			resolveModel: id => (id === "apple/on-device" ? apple.model : required.model),
		});
		try {
			apple.push({ content: ["ok"] });
			const output = await serve(
				["apple/on-device", "keyed-test/missing-key"].map((model, id) =>
					JSON.stringify({
						id,
						path: "/v1/chat/completions",
						body: { model, messages: [{ role: "user", content: "Reply with ok." }] },
					}),
				),
				req => router.route(req, "test"),
			);
			expect(output).toContainEqual(
				expect.objectContaining({
					id: 0,
					status: 200,
					body: expect.objectContaining({
						choices: [
							expect.objectContaining({
								message: expect.objectContaining({ role: "assistant", content: "ok" }),
							}),
						],
					}),
				}),
			);
			expect(output).toContainEqual(
				expect.objectContaining({
					id: 1,
					status: 401,
					body: { error: expect.objectContaining({ type: "authentication_error" }) },
				}),
			);
		} finally {
			await router.close();
			await storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("answers in completion order by id, rejects malformed lines and waits for requests in flight", async () => {
		const fastAnswered = Promise.withResolvers<void>();
		const route = async (req: Request): Promise<Response> => {
			const { pathname } = new URL(req.url);
			if (pathname === "/slow") {
				await fastAnswered.promise;
				return Response.json({ state: "complete" });
			}
			queueMicrotask(() => fastAnswered.resolve());
			return new Response(new Uint8Array([0xff, 0x00, 0x7f]), { headers: { "content-type": "audio/mpeg" } });
		};
		const output = await serve(
			[
				JSON.stringify({ id: 1, path: "/slow" }),
				"{not json",
				JSON.stringify({ id: 2, path: "relative" }),
				JSON.stringify({ id: 3, path: "/fast" }),
			],
			route,
		);
		expect(output.slice(1)).toEqual([
			{ id: null, status: 400, body: { error: expect.objectContaining({ type: "invalid_request_error" }) } },
			{ id: 2, status: 400, body: { error: expect.objectContaining({ type: "invalid_request_error" }) } },
			{ id: 3, status: 200, body: "/wB/", encoding: "base64" },
			{ id: 1, status: 200, body: { state: "complete" } },
		]);
	});

	it("cancels pending route waits when its caller aborts after EOF", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<AbortSignal>();
		const output: unknown[] = [];
		const work = serveAuthGatewayStdio({
			input: new Response('{"id":1,"path":"/v1/models"}\n').body!,
			write: line => {
				output.push(JSON.parse(line));
			},
			signal: controller.signal,
			route: req => {
				started.resolve(req.signal);
				return new Promise<Response>(() => {});
			},
		});
		const requestSignal = await started.promise;
		controller.abort();
		await work;
		expect(requestSignal.aborted).toBe(true);
		expect(output[1]).toMatchObject({ id: 1, status: 499, body: { error: { type: "request_aborted" } } });
	});

	it("waits for the final output write before completing", async () => {
		const written = Promise.withResolvers<void>();
		const drained = Promise.withResolvers<void>();
		let complete = false;
		const work = serveAuthGatewayStdio({
			input: new Response('{"id":1,"path":"/v1/models"}\n').body!,
			write: async line => {
				if (!("id" in JSON.parse(line))) return;
				written.resolve();
				await drained.promise;
			},
			route: async () => Response.json({ data: [] }),
		}).then(() => {
			complete = true;
		});
		await written.promise;
		expect(complete).toBe(false);
		drained.resolve();
		await work;
		expect(complete).toBe(true);
	});

	it("admits only the configured number of stalled routes and continues in completion order", async () => {
		const releases = Array.from({ length: 5 }, () => Promise.withResolvers<Response>());
		const firstBatch = Promise.withResolvers<void>();
		const thirdStarted = Promise.withResolvers<void>();
		const admitted: number[] = [];
		let active = 0;
		let peak = 0;
		const work = serve(
			releases.map((_, id) => JSON.stringify({ id, path: `/${id}` })),
			async req => {
				const id = Number(new URL(req.url).pathname.slice(1));
				admitted.push(id);
				active++;
				peak = Math.max(peak, active);
				if (admitted.length === 2) firstBatch.resolve();
				if (admitted.length === 3) thirdStarted.resolve();
				const response = await releases[id]!.promise;
				active--;
				return response;
			},
			{ maxConcurrentRequests: 2 },
		);
		await firstBatch.promise;
		await scheduler.yield();
		expect(admitted).toEqual([0, 1]);
		releases[1]!.resolve(Response.json({ id: 1 }));
		await thirdStarted.promise;
		expect(admitted).toEqual([0, 1, 2]);
		for (const [id, release] of releases.entries()) release.resolve(Response.json({ id }));
		const output = await work;
		expect(peak).toBe(2);
		expect(output[1]).toEqual({ id: 1, status: 200, body: { id: 1 } });
		expect(output.slice(1)).toHaveLength(5);
		expect(output.slice(1)).toEqual(
			expect.arrayContaining(releases.map((_, id) => ({ id, status: 200, body: { id } }))),
		);
	});

	it("retains admission slots until output writes drain", async () => {
		const drains = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
		const firstBatch = Promise.withResolvers<void>();
		const nextWrite = Promise.withResolvers<void>();
		const routed: number[] = [];
		const output: unknown[] = [];
		let pending = 0;
		let peak = 0;
		const work = serveAuthGatewayStdio({
			input: new Response(drains.map((_, id) => JSON.stringify({ id, path: `/${id}` })).join("\n")).body!,
			maxConcurrentRequests: 2,
			route: async req => {
				const id = Number(new URL(req.url).pathname.slice(1));
				routed.push(id);
				return Response.json({ id });
			},
			write: async line => {
				const frame = JSON.parse(line);
				output.push(frame);
				if (!("id" in frame)) return;
				pending++;
				peak = Math.max(peak, pending);
				if (output.length === 3) firstBatch.resolve();
				if (frame.id === 2) nextWrite.resolve();
				await drains[frame.id]!.promise;
				pending--;
			},
		});
		await firstBatch.promise;
		await scheduler.yield();
		expect(routed).toEqual([0, 1]);
		drains[1]!.resolve();
		await nextWrite.promise;
		expect(routed).toEqual([0, 1, 2]);
		for (const drain of drains) drain.resolve();
		await work;
		expect(peak).toBe(2);
		expect(output.slice(1)).toEqual([0, 1, 2, 3].map(id => ({ id, status: 200, body: { id } })));
	});

	it.each([undefined, "1"])(
		"rejects oversized streams with Content-Length %s and serves later requests",
		async length => {
			let pulls = 0;
			let cancelReason: unknown;
			const body = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulls++;
						if (pulls > 4) {
							controller.close();
							return;
						}
						controller.enqueue(new Uint8Array([1, 2, 3]));
					},
					cancel(reason) {
						cancelReason = reason;
					},
				},
				{ highWaterMark: 0 },
			);
			const output = await serve(
				[JSON.stringify({ id: 1, path: "/large" }), JSON.stringify({ id: 2, path: "/ok" })],
				async req =>
					new URL(req.url).pathname === "/large"
						? new Response(body, { headers: length === undefined ? {} : { "content-length": length } })
						: new Response("ok", { headers: { "content-type": "text/plain" } }),
				{ maxResponseBytes: 8, maxConcurrentRequests: 1 },
			);
			expect(output.slice(1)).toEqual([
				{
					id: 1,
					status: 502,
					body: { error: { type: "response_limit_error", message: "Response exceeds the 8 byte stdio limit" } },
				},
				{ id: 2, status: 200, body: "ok" },
			]);
			expect(pulls).toBe(3);
			expect(cancelReason).toBeInstanceOf(AuthGatewayStdioResponseLimitError);
			expect(body.locked).toBe(false);
		},
	);

	it.each([
		{ type: "application/json", bytes: new TextEncoder().encode('{"n":1}'), body: { n: 1 } },
		{ type: "text/event-stream", bytes: new TextEncoder().encode("data: é\n\n"), body: "data: é\n\n" },
		{ type: "audio/mpeg", bytes: new Uint8Array([0xff, 0, 0x7f]), body: "/wB/", encoding: "base64" },
	])("preserves exact-limit $type payloads", async ({ type, bytes, body, ...encoding }) => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
				controller.close();
			},
		});
		const output = await serve(
			[JSON.stringify({ id: 1, path: "/exact" })],
			async () => new Response(stream, { headers: { "content-type": type } }),
			{ maxResponseBytes: bytes.byteLength },
		);
		expect(output[1]).toEqual({ id: 1, status: 200, body, ...encoding });
		expect(stream.locked).toBe(false);
	});

	it.each(["reject", "stall"])("keeps the size error when overflow cancellation must %s", async mode => {
		let cancelReason: unknown;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
			},
			cancel(reason) {
				cancelReason = reason;
				return mode === "reject" ? Promise.reject(new Error("cleanup failed")) : new Promise<void>(() => {});
			},
		});
		await expect(readAuthGatewayStdioBody(new Response(stream), undefined, 2)).rejects.toBeInstanceOf(
			AuthGatewayStdioResponseLimitError,
		);
		expect(cancelReason).toBeInstanceOf(AuthGatewayStdioResponseLimitError);
		expect(stream.locked).toBe(false);
		await scheduler.yield();
	});

	it("accepts empty bodies at a zero-byte limit", async () => {
		const output = await serve(
			[JSON.stringify({ id: 1, path: "/empty" })],
			async () => new Response(null, { status: 204 }),
			{ maxResponseBytes: 0 },
		);
		expect(output[1]).toEqual({ id: 1, status: 204, body: null });
	});

	it("releases a failed body reader and serves the next request", async () => {
		const failure = new Error("upstream disconnected");
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.error(failure);
				},
			},
			{ highWaterMark: 0 },
		);
		const output = await serve(
			[JSON.stringify({ id: 1, path: "/failed" }), JSON.stringify({ id: 2, path: "/ok" })],
			async req =>
				new Response(new URL(req.url).pathname === "/failed" ? stream : "ok", {
					headers: { "content-type": "text/plain" },
				}),
			{ maxConcurrentRequests: 1 },
		);
		expect(output.slice(1)).toEqual([
			{ id: 1, status: 500, body: { error: { type: "server_error", message: "internal error" } } },
			{ id: 2, status: 200, body: "ok" },
		]);
		expect(stream.locked).toBe(false);
	});

	it("cancels a stalled body reader on abort without waiting for source cleanup", async () => {
		const controller = new AbortController();
		const reading = Promise.withResolvers<void>();
		let cancelReason: unknown;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull() {
					reading.resolve();
				},
				cancel(reason) {
					cancelReason = reason;
					return new Promise<void>(() => {});
				},
			},
			{ highWaterMark: 0 },
		);
		const reason = new Error("caller stopped");
		const work = readAuthGatewayStdioBody(new Response(stream), controller.signal, 8);
		const outcome = work.catch(error => error);
		await reading.promise;
		controller.abort(reason);
		expect(await outcome).toBe(reason);
		expect(cancelReason).toBe(reason);
		expect(stream.locked).toBe(false);
	});

	it("cancels an already-aborted response body and releases its reader", async () => {
		const controller = new AbortController();
		const reason = new Error("already stopped");
		controller.abort(reason);
		let cancelReason: unknown;
		const stream = new ReadableStream<Uint8Array>({
			cancel(reason) {
				cancelReason = reason;
			},
		});
		await expect(readAuthGatewayStdioBody(new Response(stream), controller.signal)).rejects.toBe(reason);
		expect(cancelReason).toBe(reason);
		expect(stream.locked).toBe(false);
	});

	it("aborts while output is stalled without admitting more requests", async () => {
		const controller = new AbortController();
		const written = Promise.withResolvers<void>();
		const drain = Promise.withResolvers<void>();
		let routed = 0;
		const work = serveAuthGatewayStdio({
			input: new Response('{"id":1,"path":"/one"}\n{"id":2,"path":"/two"}\n').body!,
			maxConcurrentRequests: 1,
			signal: controller.signal,
			route: async () => {
				routed++;
				return new Response("ok", { headers: { "content-type": "text/plain" } });
			},
			write: async line => {
				if (!("id" in JSON.parse(line))) return;
				written.resolve();
				await drain.promise;
			},
		});
		await written.promise;
		controller.abort();
		await work;
		expect(routed).toBe(1);
		drain.reject(new Error("writer closed after abort"));
		await scheduler.yield();
	});

	it.each(["throw", "reject"])("settles stalled peers when an output write fails by %s", async mode => {
		const peerStarted = Promise.withResolvers<AbortSignal>();
		const output: unknown[] = [];
		const failure = new Error("output closed");
		const work = serveAuthGatewayStdio({
			input: new Response('{"id":1,"path":"/stall"}\n{"id":2,"path":"/fail"}\n{"id":3,"path":"/later"}\n').body!,
			maxConcurrentRequests: 2,
			route: async req => {
				if (new URL(req.url).pathname === "/stall") {
					peerStarted.resolve(req.signal);
					return new Promise<Response>(() => {});
				}
				return new Response("ok", { headers: { "content-type": "text/plain" } });
			},
			write: line => {
				const frame = JSON.parse(line);
				output.push(frame);
				if (!("id" in frame)) return;
				if (mode === "throw") throw failure;
				return Promise.reject(failure);
			},
		});
		const rejected = expect(work).rejects.toBe(failure);
		const peerSignal = await peerStarted.promise;
		await rejected;
		expect(peerSignal.aborted).toBe(true);
		expect(output).toEqual([{ ready: true }, { id: 2, status: 200, body: "ok" }]);
	});

	it("isolates concurrent request model resolution without changing the default resolver", async () => {
		const storage = await AuthStorage.create(":memory:");
		const chat = createMockModel({ provider: "stdio-resolver-test", id: "same-model" });
		const video = { ...chat, kind: "video" as const };
		const router = createAuthGatewayRouter({ storage, resolveModel: () => video });
		const request = () =>
			new Request("http://stdio/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "same-model", messages: [{ role: "user", content: "hi" }] }),
			});
		try {
			const [chatResponse, videoResponse] = await Promise.all([
				router.route(request(), "test", undefined, () => chat),
				router.route(request(), "test", undefined, () => video),
			]);
			expect(chatResponse.status).toBe(401);
			expect(videoResponse.status).toBe(400);
			const next = await router.route(request(), "test");
			expect(next.status).toBe(400);
		} finally {
			await router.close();
			await storage.close();
		}
	});
});
