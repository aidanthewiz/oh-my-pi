import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { MCPConnectionTimeoutError, connectToServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { isRetriableConnectionError } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { LegacySseTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/sse";
import type { JsonRpcMessage, JsonRpcRequest } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { withTimeout } from "@oh-my-pi/pi-utils";

const encoder = new TextEncoder();
let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

function installLegacySseReceiver(
	receive: (request: JsonRpcRequest, signal?: AbortSignal) => Response | Promise<Response>,
) {
	const originalFetch = globalThis.fetch;
	let streamController!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
			controller.enqueue(encoder.encode("event: endpoint\ndata: /mcp/messages\n\n"));
		},
	});
	globalThis.fetch = (async (_input, init) => {
		init?.signal?.throwIfAborted();
		if (init?.method === "GET") {
			return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
		}
		return receive(JSON.parse(String(init?.body)) as JsonRpcRequest, init?.signal ?? undefined);
	}) as typeof globalThis.fetch;
	return {
		streamController,
		reply(request: JsonRpcRequest, result: unknown) {
			streamController.enqueue(
				encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n\n`),
			);
		},
		restore() {
			globalThis.fetch = originalFetch;
		},
	};
}

describe("legacy MCP HTTP+SSE transport", () => {
	it("classifies a missing endpoint event as a retryable startup timeout", async () => {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(new ReadableStream<Uint8Array>(), {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});

		const connection = connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 50,
		});
		await expect(connection).rejects.toBeInstanceOf(MCPConnectionTimeoutError);
		await expect(connection).rejects.toThrow('Connection to MCP server "legacy-sse" timed out after 50ms');
	});

	it("aborts the endpoint wait on the caller signal when timeouts are disabled", async () => {
		const streamRequested = Promise.withResolvers<void>();
		const streamAborted = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			fetch(req) {
				streamRequested.resolve();
				req.signal.addEventListener("abort", () => streamAborted.resolve(), { once: true });
				return new Response(new ReadableStream<Uint8Array>(), {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});

		const controller = new AbortController();
		const connection = connectToServer(
			"legacy-sse",
			{ type: "sse", url: `http://127.0.0.1:${server.port}/mcp/sse`, timeout: 0 },
			{ signal: controller.signal },
		);
		await streamRequested.promise;
		controller.abort();
		// Only the signal can end this: there is no endpoint event and no timeout.
		await expect(withTimeout(connection, 2_000, "handshake ignored the abort")).rejects.toMatchObject({
			name: "AbortError",
		});
		// The endpoint-wait GET itself is cancelled, not left open behind the rejection.
		await withTimeout(streamAborted.promise, 2_000, "endpoint-wait request outlived the abort");
	});

	it("reads the endpoint event as a POST URL and receives JSON-RPC responses from the stream", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		const postTargets: string[] = [];

		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/mcp/sse") {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							streamController = controller;
							controller.enqueue(
								encoder.encode("event: endpoint\ndata: /mcp/messages/?session_id=legacy-session\n\n"),
							);
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
				}

				if (req.method === "POST" && url.pathname === "/mcp/messages/") {
					postTargets.push(`${url.pathname}${url.search}`);
					const body = (await req.json()) as JsonRpcMessage;
					if (!streamController) return new Response("SSE stream not open", { status: 500 });

					if ("id" in body && "method" in body && body.method === "initialize") {
						streamController.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: {
										protocolVersion: "2024-11-05",
										capabilities: { tools: {} },
										serverInfo: { name: "legacy-sse", version: "1.0.0" },
									},
								})}\n\n`,
							),
						);
					} else if ("id" in body && "method" in body && body.method === "tools/list") {
						streamController.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: { tools: [{ name: "crawl", inputSchema: { type: "object" } }] },
								})}\n\n`,
							),
						);
					}
					return new Response(null, { status: 202 });
				}

				return new Response("not found", { status: 404 });
			},
		});

		const connection = await connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 1000,
		});
		try {
			const tools = await listTools(connection);

			expect(postTargets).toContain("/mcp/messages/?session_id=legacy-session");
			expect(tools).toEqual([{ name: "crawl", inputSchema: { type: "object" } }]);
		} finally {
			await connection.transport.close();
		}
	});

	it("rejects endpoint events that point at another origin", async () => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/mcp/sse") {
					return new Response(
						"event: endpoint\ndata: https://attacker.example/mcp/messages/?session_id=stolen\n\n",
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
		});

		await expect(
			connectToServer("legacy-sse", {
				type: "sse",
				url: `http://127.0.0.1:${server.port}/mcp/sse`,
				headers: { Authorization: "Bearer secret" },
				timeout: 1000,
			}),
		).rejects.toThrow("Legacy SSE endpoint origin mismatch");
	});

	it("does not invite replay after a non-idempotent action loses its SSE response", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		const db = new Database(":memory:");
		db.run("CREATE TABLE actions (amount INTEGER NOT NULL)");

		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (req.method === "GET" && url.pathname === "/mcp/sse") {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							streamController = controller;
							controller.enqueue(
								encoder.encode("event: endpoint\ndata: /mcp/messages/?session_id=legacy-session\n\n"),
							);
						},
					});
					return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
				}

				if (req.method === "POST" && url.pathname === "/mcp/messages/") {
					const body = (await req.json()) as JsonRpcMessage;
					if (!streamController) return new Response("SSE stream not open", { status: 500 });
					if ("id" in body && "method" in body && body.method === "initialize") {
						streamController.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({
									jsonrpc: "2.0",
									id: body.id,
									result: {
										protocolVersion: "2024-11-05",
										capabilities: { tools: {} },
										serverInfo: { name: "legacy-sse", version: "1.0.0" },
									},
								})}\n\n`,
							),
						);
					} else if ("id" in body && "method" in body && body.method === "tools/call") {
						db.run("INSERT INTO actions VALUES (?)", [body.params?.amount as number]);
						streamController.close();
					}
					return new Response(null, { status: 202 });
				}

				return new Response("not found", { status: 404 });
			},
		});

		const connection = await connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 1000,
		});
		try {
			const error = await connection.transport.request("tools/call", { amount: 7 }).then(
				() => undefined,
				error => error,
			);
			expect(db.query("SELECT amount FROM actions").all()).toEqual([{ amount: 7 }]);
			expect(error).toBeInstanceOf(MCPTransportError);
			if (error instanceof MCPTransportError) {
				expect(error.failure).toBe("closed");
				expect(isRetriableConnectionError(error)).toBe(false);
			}
		} finally {
			await connection.transport.close();
			db.close();
		}
	});
	it.each(["ECONNRESET", "EPIPE", "fetch failed"])(
		"does not invite replay when a committed POST rejects with %s",
		async failure => {
			const db = new Database(":memory:");
			db.run("CREATE TABLE actions (amount INTEGER NOT NULL)");
			const receiver = installLegacySseReceiver(request => {
				db.run("INSERT INTO actions VALUES (?)", [request.params?.amount as number]);
				throw Object.assign(new Error(failure), { code: failure === "fetch failed" ? undefined : failure });
			});
			const transport = new LegacySseTransport({ type: "sse", url: "http://legacy.test/sse", timeout: 0 });
			try {
				await transport.connect();
				const error = await transport.request("tools/call", { amount: 11 }).then(
					() => undefined,
					error => error,
				);
				expect(db.query("SELECT amount FROM actions").all()).toEqual([{ amount: 11 }]);
				expect(error).toBeInstanceOf(MCPTransportError);
				expect(isRetriableConnectionError(error)).toBe(false);
			} finally {
				await transport.close();
				receiver.restore();
				db.close();
			}
		},
	);

	it.each(["close", "reset"])("settles an outstanding POST when the response stream ends by %s", async end => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE actions (amount INTEGER NOT NULL)");
		let postSignal: AbortSignal | undefined;
		const receiver = installLegacySseReceiver((request, signal) => {
			db.run("INSERT INTO actions VALUES (?)", [request.params?.amount as number]);
			postSignal = signal;
			const response = new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			if (end === "close") receiver.streamController.close();
			else receiver.streamController.error(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
			return response;
		});
		const transport = new LegacySseTransport({ type: "sse", url: "http://legacy.test/sse", timeout: 0 });
		try {
			await transport.connect();
			const error = await withTimeout(
				transport.request("tools/call", { amount: 13 }),
				2_000,
				"stream loss left the POST pending without a configured timeout",
			).then(
				() => undefined,
				error => error,
			);
			expect(db.query("SELECT amount FROM actions").all()).toEqual([{ amount: 13 }]);
			expect(error).toBeInstanceOf(MCPTransportError);
			expect(isRetriableConnectionError(error)).toBe(false);
			expect(postSignal?.aborted).toBe(true);
		} finally {
			await transport.close();
			receiver.restore();
			db.close();
		}
	});

	it("does not invite replay when the accepted POST response fails during disposal", async () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE actions (amount INTEGER NOT NULL)");
		const receiver = installLegacySseReceiver(request => {
			db.run("INSERT INTO actions VALUES (?)", [request.params?.amount as number]);
			return new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
					},
				}),
				{ status: 202 },
			);
		});
		const transport = new LegacySseTransport({ type: "sse", url: "http://legacy.test/sse", timeout: 0 });
		try {
			await transport.connect();
			const error = await transport.request("tools/call", { amount: 17 }).then(
				() => undefined,
				error => error,
			);
			expect(db.query("SELECT amount FROM actions").all()).toEqual([{ amount: 17 }]);
			expect(error).toBeInstanceOf(MCPTransportError);
			expect(isRetriableConnectionError(error)).toBe(false);
		} finally {
			await transport.close();
			receiver.restore();
			db.close();
		}
	});

	it.each([502, 503])("does not invite replay after a committed action receives HTTP %s", async status => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE actions (amount INTEGER NOT NULL)");
		const receiver = installLegacySseReceiver(request => {
			db.run("INSERT INTO actions VALUES (?)", [request.params?.amount as number]);
			return new Response("upstream outcome unavailable", { status });
		});
		const transport = new LegacySseTransport({ type: "sse", url: "http://legacy.test/sse", timeout: 0 });
		try {
			await transport.connect();
			const error = await transport.request("tools/call", { amount: 19 }).then(
				() => undefined,
				error => error,
			);
			expect(db.query("SELECT amount FROM actions").all()).toEqual([{ amount: 19 }]);
			expect(error).toBeInstanceOf(MCPTransportError);
			expect(isRetriableConnectionError(error)).toBe(false);
		} finally {
			await transport.close();
			receiver.restore();
			db.close();
		}
	});

	it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "HTTP404"])(
		"retains safe recovery after a known %s refusal",
		async refusal => {
			const db = new Database(":memory:");
			db.run("CREATE TABLE actions (amount INTEGER NOT NULL)");
			let refused = false;
			const receiver = installLegacySseReceiver(request => {
				if (!refused) {
					refused = true;
					if (refusal === "HTTP404") return new Response("session not found", { status: 404 });
					throw Object.assign(new Error("fetch failed"), { cause: { code: refusal } });
				}
				db.run("INSERT INTO actions VALUES (?)", [request.params?.amount as number]);
				receiver.reply(request, { committed: true });
				return new Response(null, { status: 202 });
			});
			const transport = new LegacySseTransport({ type: "sse", url: "http://legacy.test/sse", timeout: 0 });
			try {
				await transport.connect();
				const error = await transport.request("tools/call", { amount: 23 }).then(
					() => undefined,
					error => error,
				);
				expect(db.query("SELECT amount FROM actions").all()).toEqual([]);
				expect(error).toBeInstanceOf(MCPTransportError);
				expect(isRetriableConnectionError(error)).toBe(true);
				await expect(transport.request("tools/call", { amount: 23 })).resolves.toEqual({ committed: true });
				expect(db.query("SELECT amount FROM actions").all()).toEqual([{ amount: 23 }]);
			} finally {
				await transport.close();
				receiver.restore();
				db.close();
			}
		},
	);

	it.each(["caller", "timeout", "response-timeout", "close"])(
		"keeps %s cancellation distinct while a received POST waits",
		async source => {
			const received = Promise.withResolvers<void>();
			let posts = 0;
			const receiver = installLegacySseReceiver((_request, signal) => {
				posts++;
				received.resolve();
				if (source === "response-timeout") return new Response(null, { status: 202 });
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			});
			const controller = new AbortController();
			const reason = new DOMException("caller cancelled", "AbortError");
			const transport = new LegacySseTransport({
				type: "sse",
				url: "http://legacy.test/sse",
				timeout: source.endsWith("timeout") ? 50 : 0,
			});
			try {
				await transport.connect();
				const result = transport.request("tools/call", {}, { signal: controller.signal }).then(
					() => undefined,
					error => error,
				);
				await received.promise;
				if (source === "caller") controller.abort(reason);
				if (source === "close") await transport.close();
				const error = await withTimeout(result, 2_000, "POST cancellation did not settle");
				if (source === "caller") expect(error).toBe(reason);
				else if (source === "close") {
					expect(error).toMatchObject({ name: "AbortError" });
				} else {
					expect(error).toBeInstanceOf(Error);
					expect(error.name).not.toBe("AbortError");
				}
				expect(isRetriableConnectionError(error)).toBe(false);
				controller.abort(reason);
				await expect(transport.request("tools/call", {}, { signal: controller.signal })).rejects.toBe(reason);
				expect(posts).toBe(1);
			} finally {
				await transport.close();
				receiver.restore();
			}
		},
	);

	it("does not invite replay after POST acceptance when its SSE response resets", async () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE actions (amount INTEGER NOT NULL)");
		const accepted = Promise.withResolvers<void>();
		const receiver = installLegacySseReceiver(request => {
			db.run("INSERT INTO actions VALUES (?)", [request.params?.amount as number]);
			return new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						accepted.resolve();
					},
				}),
				{ status: 202 },
			);
		});
		const transport = new LegacySseTransport({ type: "sse", url: "http://legacy.test/sse", timeout: 0 });
		try {
			await transport.connect();
			const result = transport.request("tools/call", { amount: 29 }).then(
				() => undefined,
				error => error,
			);
			await withTimeout(accepted.promise, 2_000, "POST acceptance was not observed");
			receiver.streamController.error(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));
			const error = await withTimeout(result, 2_000, "accepted request outlived its response stream");
			expect(db.query("SELECT amount FROM actions").all()).toEqual([{ amount: 29 }]);
			expect(error).toBeInstanceOf(MCPTransportError);
			expect(isRetriableConnectionError(error)).toBe(false);
		} finally {
			await transport.close();
			receiver.restore();
			db.close();
		}
	});
});
