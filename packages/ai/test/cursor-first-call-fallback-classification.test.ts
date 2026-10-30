import { expect, it, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import http2 from "node:http2";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { retryTransientCompletion } from "@oh-my-pi/pi-ai/oneshot-retry";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	BidiAppendRequestSchema,
	BidiRequestIdSchema,
	CursorError,
	CustomErrorDetailsSchema,
	ErrorDetailsSchema,
	InteractionUpdateSchema,
	type InteractionUpdate,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

function frame(bytes: Uint8Array, flags = 0): Buffer {
	const out = Buffer.alloc(bytes.length + 5);
	out[0] = flags;
	out.writeUInt32BE(bytes.length, 1);
	out.set(bytes, 5);
	return out;
}

function rejection(): Buffer {
	const details = create(ErrorDetailsSchema, {
		error: CursorError.ERROR_PROVIDER_ERROR,
		details: create(CustomErrorDetailsSchema, {
			title: "Provider Error",
			detail: "Synthetic terminal rejection",
			isRetryable: false,
		}),
		isExpected: true,
	});
	return frame(
		Buffer.from(
			JSON.stringify({
				error: {
					code: "resource_exhausted",
					message: "Error",
					details: [
						{
							type: "aiserver.v1.ErrorDetails",
							value: Buffer.from(toBinary(ErrorDetailsSchema, details)).toString("base64"),
						},
					],
				},
			}),
		),
		2,
	);
}

function success(): Buffer {
	const update = (message: InteractionUpdate["message"]) =>
		frame(
			toBinary(
				AgentServerMessageSchema,
				create(AgentServerMessageSchema, {
					message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) },
				}),
			),
		);
	return Buffer.concat([
		update({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "synthetic success" }) }),
		update({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) }),
	]);
}

function failNegotiation() {
	const negotiation = spyOn(http2, "connect").mockImplementation(() => {
		const request = Object.assign(new EventEmitter(), {
			closed: false,
			writableEnded: false,
			write: () => true,
			end: () => {},
			close() {
				this.closed = true;
			},
		});
		const client = Object.assign(new EventEmitter(), { request: () => request, close: () => {} });
		queueMicrotask(() =>
			client.emit("error", Object.assign(new Error("h2 is not supported"), { code: "ERR_HTTP2_ERROR" })),
		);
		return client as unknown as http2.ClientHttp2Session;
	});
	return () => negotiation.mockRestore();
}

it.each([false, true])(
	"preserves pre-call conversation classification through HTTP1 fallback (established=%s)",
	async established => {
		const ready = new Map<
			string,
			{
				promise: Promise<ReadableStreamDefaultController<Uint8Array>>;
				resolve(controller: ReadableStreamDefaultController<Uint8Array>): void;
			}
		>();
		const runs: string[] = [];
		const conversations: (string | undefined)[] = [];
		let turn = 0;
		const slot = (id: string) => {
			let item = ready.get(id);
			if (!item) {
				item = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
				ready.set(id, item);
			}
			return item;
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				const bytes = new Uint8Array(await request.arrayBuffer());
				if (path === "/agent.v1.AgentService/RunSSE") {
					const id = fromBinary(BidiRequestIdSchema, bytes.subarray(5)).requestId;
					runs.push(id);
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								slot(id).resolve(controller);
							},
						}),
						{ headers: { "content-type": "application/connect+proto" } },
					);
				}
				if (path === "/aiserver.v1.BidiService/BidiAppend") {
					const append = fromBinary(BidiAppendRequestSchema, bytes);
					const message = fromBinary(AgentClientMessageSchema, append.dataBinary);
					if (message.message.case === "runRequest") {
						conversations.push(message.message.value.conversationId);
						const controller = await slot(append.requestId!.requestId).promise;
						const reject = established ? turn === 1 : true;
						turn++;
						controller.enqueue(reject ? rejection() : success());
						controller.close();
					}
					return new Response(null, { headers: { "content-type": "application/proto" } });
				}
				return new Response(null, { status: 404 });
			},
		});
		const model = buildModel({
			id: "synthetic-fallback-classification",
			name: "Synthetic fallback classification",
			provider: "cursor",
			api: "cursor-agent",
			baseUrl: server.url.toString(),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 128,
		});
		const context: Context = { messages: [{ role: "user", content: "synthetic input", timestamp: 1 }] };
		const sessionId = `synthetic-${crypto.randomUUID()}`;
		const abort = new AbortController();
		let restoreNegotiation: (() => void) | undefined;
		try {
			if (established) {
				const warm = await streamCursor(model, context, {
					apiKey: "synthetic-token",
					sessionId,
					transport: "http1",
					signal: abort.signal,
				}).result();
				expect(warm.stopReason).toBe("stop");
			}
			restoreNegotiation = failNegotiation();
			if (established) {
				const rejected = await streamCursor(model, context, {
					apiKey: "synthetic-token",
					sessionId,
					signal: abort.signal,
				}).result();
				expect(rejected.errorStatus).toBe(400);
				expect(AIError.retriable(rejected.errorId)).toBe(true);
				const recovered = await streamCursor(model, context, {
					apiKey: "synthetic-token",
					sessionId,
					signal: abort.signal,
				}).result();
				expect(recovered.stopReason).toBe("stop");
				expect(recovered.content).toEqual([expect.objectContaining({ type: "text", text: "synthetic success" })]);
				expect(conversations.slice(0, 2)).toEqual([sessionId, sessionId]);
				expect(conversations[2]).not.toBe(sessionId);
				expect(new Set(conversations).size).toBe(2);
				expect(runs).toHaveLength(3);
			} else {
				const result = await retryTransientCompletion(
					() =>
						streamSimple(model, context, {
							apiKey: "synthetic-token",
							signal: abort.signal,
						}).result(),
					{ maxAttempts: 2, baseDelayMs: 0, signal: abort.signal },
				);
				expect(result.stopReason).toBe("error");
				expect(result.errorStatus).toBe(400);
				expect(AIError.retriable(result.errorId)).toBe(false);
				expect(runs).toHaveLength(1);
			}
		} finally {
			abort.abort();
			restoreNegotiation?.();
			await server.stop(true);
			ready.clear();
		}
	},
	10_000,
);
