import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { MCPConnectionTimeoutError, connectToServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { analyzeAuthError } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { dispatchMCPTool, isRetriableConnectionError } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { LegacySseTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/sse";
import type { JsonRpcMessage, JsonRpcRequest } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPProgress } from "@oh-my-pi/pi-tui/tools/mcp";
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
	it.each(["connect", "request", "notify"] as const)(
		"keeps OAuth body and header discovery private and usable when %s is rejected",
		async operation => {
			let posts = 0;
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.method === "GET" && operation !== "connect") {
						return new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
								},
							}),
							{ headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (request.method === "POST") posts++;
					return Response.json(
						{
							oauth: {
								authorization_url: "https://auth.example/authorize",
								token_url: "https://auth.example/token",
								issuer: "https://auth.example",
								client_secret: "wire-secret",
							},
							access_token: "wire-secret",
						},
						{
							status: 401,
							headers: {
								"WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example/metadata", scope="read"',
								"Mcp-Auth-Server": "https://auth.example",
							},
						},
					);
				},
			});
			const transport = new LegacySseTransport({
				type: "sse",
				url: `http://127.0.0.1:${server.port}/sse`,
				timeout: 1_000,
			});
			try {
				if (operation !== "connect") await transport.connect();
				const failed =
					operation === "connect"
						? transport.connect()
						: operation === "request"
							? transport.request("initialize")
							: transport.notify("notifications/initialized");
				const error = await failed.then(
					() => undefined,
					reason => reason,
				);
				if (!(error instanceof MCPTransportError)) throw new Error("Expected a transport rejection");
				expect(analyzeAuthError(error, transport.url)).toMatchObject({
					requiresAuth: true,
					authType: "oauth",
					authServerUrl: "https://auth.example/",
					resourceMetadataUrl: "https://mcp.example/metadata",
					scopes: "read",
					oauth: {
						authorizationUrl: "https://auth.example/authorize",
						tokenUrl: "https://auth.example/token",
						issuerUrl: "https://auth.example",
						scopes: "read",
					},
				});
				expect(error.message).not.toContain("wire-secret");
				expect(JSON.stringify(error)).not.toContain("wire-secret");
				expect(error.retryable).toBe(false);
				expect(posts).toBe(operation === "connect" ? 0 : 1);
			} finally {
				await transport.close();
			}
		},
	);

	it("routes GET-stream progress only while its POST request is pending and preserves notification fanout", async () => {
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		let sent: JsonRpcRequest | undefined;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								stream = controller;
								controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				sent = (await req.json()) as JsonRpcRequest;
				const token = (sent.params?._meta as Record<string, unknown> | undefined)?.progressToken;
				for (const message of [
					{
						jsonrpc: "2.0",
						method: "notifications/progress",
						params: { progressToken: String(token), progress: 99 },
					},
					{
						jsonrpc: "2.0",
						method: "notifications/progress",
						params: { progressToken: token, progress: 1, message: "working" },
					},
					{ jsonrpc: "2.0", id: sent.id, result: { done: true } },
					{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 2 } },
				]) {
					stream?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
				}
				return new Response(null, { status: 202 });
			},
		});
		const transport = new LegacySseTransport({
			type: "sse",
			url: `http://127.0.0.1:${server.port}/sse`,
			timeout: 300,
		});
		const updates: MCPProgress[] = [];
		const notifications: unknown[] = [];
		const late = Promise.withResolvers<void>();
		transport.onNotification = (_method, params) => {
			notifications.push(params);
			if ((params as Record<string, unknown>).progress === 2) late.resolve();
		};
		try {
			await transport.connect();
			const args = { steps: 1 };
			const result = await transport.request(
				"tools/call",
				{ arguments: args, _meta: { trace: "keep" } },
				{
					onProgress: progress => updates.push(progress),
				},
			);
			await withTimeout(late.promise, 300, "late progress was not forwarded");
			expect(result).toEqual({ done: true });
			expect(updates).toEqual([{ progress: 1, message: "working" }]);
			expect(sent?.params?._meta).toEqual({ trace: "keep", progressToken: sent?.id });
			expect(sent?.params?.arguments).toEqual(args);
			expect(notifications).toHaveLength(3);
		} finally {
			await transport.close();
		}
	});

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

	it("does not replay a request whose POST connection closes after it was sent", async () => {
		// Raw TCP: the GET stream announces the endpoint, then each POST connection closes after its request arrives.
		const tcp = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, chunk) {
					if (chunk.toString().startsWith("GET ")) {
						socket.write(
							"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n\r\nevent: endpoint\ndata: /messages\n\n",
						);
					} else {
						socket.end();
					}
				},
			},
		});
		const transport = new LegacySseTransport({
			type: "sse",
			url: `http://127.0.0.1:${tcp.port}/sse`,
			timeout: 1_000,
		});
		try {
			await transport.connect();
			const error = await transport.request("tools/call", { name: "write" }).then(
				() => undefined,
				reason => reason,
			);
			expect(error).toBeInstanceOf(MCPTransportError);
			expect(error).toMatchObject({ transport: "http", stage: "send", retryable: false });
			expect(["reset", "eof"]).toContain((error as MCPTransportError).failure);
			expect(isRetriableConnectionError(error)).toBe(false);
		} finally {
			await transport.close();
			tcp.stop(true);
		}
	});

	it("does not mistake a JSON-RPC error containing fetch failed for a connection failure", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								streamController = controller;
								controller.enqueue(encoder.encode("event: endpoint\ndata: /mcp/messages/\n\n"));
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				const body = (await req.json()) as JsonRpcMessage;
				if (!streamController) return new Response("SSE stream not open", { status: 500 });
				if ("id" in body && "method" in body) {
					const response =
						body.method === "initialize"
							? {
									jsonrpc: "2.0",
									id: body.id,
									result: {
										protocolVersion: "2024-11-05",
										capabilities: { tools: {} },
										serverInfo: { name: "legacy-sse", version: "1.0.0" },
									},
								}
							: {
									jsonrpc: "2.0",
									id: body.id,
									error: { code: -32603, message: "fetch failed inside the tool" },
								};
					streamController.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(response)}\n\n`));
				}
				return new Response(null, { status: 202 });
			},
		});

		const connection = await connectToServer("legacy-sse", {
			type: "sse",
			url: `http://127.0.0.1:${server.port}/mcp/sse`,
			timeout: 300,
		});
		try {
			const error = await listTools(connection).then(
				() => undefined,
				reason => reason,
			);
			expect(error).toBeInstanceOf(MCPTransportError);
			expect(error).toMatchObject({
				transport: "http",
				stage: "protocol",
				failure: "json_rpc",
				retryable: false,
				code: -32603,
				message: "MCP error -32603: fetch failed inside the tool",
			});
			expect(isRetriableConnectionError(error)).toBe(false);
		} finally {
			await connection.transport.close();
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

	it.each(["caller", "timeout", "close"] as const)(
		"retains %s ownership of a live POST after its SSE result settles",
		async source => {
			const routed = Promise.withResolvers<void>();
			let postSignal: AbortSignal | undefined;
			let posts = 0;
			const receiver = installLegacySseReceiver((request, signal) => {
				posts++;
				postSignal = signal;
				receiver.reply(request, { committed: true });
				receiver.streamController.enqueue(
					encoder.encode('event: message\ndata: {"jsonrpc":"2.0","method":"result-routed"}\n\n'),
				);
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			});
			const controller = new AbortController();
			const reason = new DOMException("cancel live POST", "AbortError");
			const transport = new LegacySseTransport({
				type: "sse",
				url: "http://legacy.test/sse",
				timeout: source === "timeout" ? 100 : 0,
			});
			transport.onNotification = method => {
				if (method === "result-routed") routed.resolve();
			};
			try {
				await transport.connect();
				const result = transport.request("tools/call", {}, { signal: controller.signal }).then(
					() => undefined,
					error => error,
				);
				await withTimeout(routed.promise, 2_000, "SSE result was not routed");
				if (source === "caller") controller.abort(reason);
				if (source === "close") await transport.close();
				const error = await withTimeout(result, 2_000, "settled SSE result orphaned its live POST");
				if (source === "caller") expect(error).toBe(reason);
				else if (source === "close") expect(error).toMatchObject({ name: "AbortError" });
				else expect(error).toBeInstanceOf(Error);
				expect(postSignal?.aborted).toBe(true);
				expect(isRetriableConnectionError(error)).toBe(false);
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

describe("legacy SSE authentication replay contracts", () => {
	for (const scenario of [
		{ label: "explicit never mutation", status: 401, retry: "never", readOnly: false, safe: false },
		{ label: "never overriding readonly metadata", status: 403, retry: "never", readOnly: true, safe: false },
		{ label: "default unannotated mutation", status: 403, retry: undefined, readOnly: false, safe: false },
		{ label: "annotated safe read", status: 401, retry: undefined, readOnly: true, safe: true },
		{ label: "explicit safe read", status: 403, retry: "read", readOnly: false, safe: true },
	] as const) {
		it(`honors HTTP authentication replay policy for ${scenario.label}`, async () => {
			const definition = {
				name: scenario.safe ? "read_state" : "apply_change",
				inputSchema: { type: "object" as const },
				...(scenario.readOnly ? { annotations: { readOnlyHint: true } } : {}),
			};
			const effects: string[] = [];
			let attempts = 0;
			let refreshes = 0;
			let activeStreams = 0;
			let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
			const streamClosed = Promise.withResolvers<void>();
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const url = new URL(request.url);
					if (request.method === "GET" && url.pathname === "/mcp/sse") {
						activeStreams++;
						let closed = false;
						const finish = () => {
							if (closed) return;
							closed = true;
							activeStreams--;
							streamClosed.resolve();
						};
						request.signal.addEventListener("abort", finish, { once: true });
						return new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									streamController = controller;
									controller.enqueue(
										encoder.encode("event: endpoint\ndata: /mcp/messages?session_id=synthetic-auth\n\n"),
									);
								},
								cancel: finish,
							}),
							{ headers: { "Content-Type": "text/event-stream" } },
						);
					}
					if (request.method !== "POST" || url.pathname !== "/mcp/messages") {
						return new Response("not found", { status: 404 });
					}
					const rpc = (await request.json()) as JsonRpcMessage;
					if (!("method" in rpc) || !("id" in rpc)) return new Response(null, { status: 202 });
					let result: unknown = {};
					if (rpc.method === "initialize") {
						result = {
							protocolVersion: "2024-11-05",
							capabilities: { tools: {} },
							serverInfo: { name: "synthetic-auth", version: "1" },
						};
					} else if (rpc.method === "tools/list") {
						result = { tools: [definition] };
					} else if (rpc.method === "tools/call") {
						attempts++;
						if (!scenario.safe) effects.push("synthetic-effect");
						if (request.headers.get("Authorization") !== "Bearer synthetic-refreshed") {
							return new Response("synthetic challenge after processing", { status: scenario.status });
						}
						result = {
							content: [{ type: "text", text: "synthetic state" }],
							structuredContent: { state: "synthetic-state" },
						};
					} else if (rpc.method === "ping") {
						result = { state: "stream-still-usable" };
					}
					if (!streamController) return new Response("stream missing", { status: 500 });
					streamController.enqueue(
						encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`),
					);
					return new Response(null, { status: 202 });
				},
			});
			const connection = await connectToServer("synthetic-auth", {
				type: "sse",
				url: `${server.url.origin}/mcp/sse`,
				headers: { Authorization: "Bearer synthetic-expired" },
				timeout: 1000,
			});
			try {
				if (!(connection.transport instanceof LegacySseTransport)) throw new Error("Expected legacy SSE transport");
				connection.transport.onAuthError = async () => {
					refreshes++;
					return { Authorization: "Bearer synthetic-refreshed" };
				};
				const [tool] = await listTools(connection);
				if (!tool) throw new Error("Synthetic server exposed no tool");
				const outcome = await dispatchMCPTool(connection, tool, {}, undefined, { retry: scenario.retry }).then(
					attempt => ({ result: attempt.result, error: undefined }),
					(error: unknown) => ({ result: undefined, error }),
				);
				if (scenario.safe) {
					expect(outcome.error).toBeUndefined();
					expect(outcome.result?.structuredContent?.state).toBe("synthetic-state");
					expect(attempts).toBe(2);
					expect(refreshes).toBe(1);
					expect(effects).toEqual([]);
				} else {
					expect(effects).toEqual(["synthetic-effect"]);
					expect(attempts).toBe(1);
					expect(refreshes).toBe(0);
					expect(outcome.result).toBeUndefined();
					expect(outcome.error).toBeInstanceOf(MCPTransportError);
					expect(outcome.error).toMatchObject({
						transport: "http",
						stage: "receive",
						failure: "http_status",
						code: scenario.status,
						retryable: false,
					});
				}
				await expect(connection.transport.request("ping")).resolves.toEqual({ state: "stream-still-usable" });
			} finally {
				await connection.transport.close();
				await withTimeout(streamClosed.promise, 2_000, "authentication replay test leaked its SSE stream");
				expect(activeStreams).toBe(0);
			}
		});
	}

	it.each(["before-dispatch", "before-refresh", "during-refresh", "during-refresh-reject", "after-response"])(
		"rejects an expired request owner at %s without credential or request replay",
		async phase => {
			let ownerCurrent = phase !== "before-dispatch";
			let posts = 0;
			let refreshes = 0;
			let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
			const refreshEntered = Promise.withResolvers<void>();
			const releaseRefresh = Promise.withResolvers<void>();
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (request.method === "GET") {
						return new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									stream = controller;
									controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
								},
							}),
							{ headers: { "Content-Type": "text/event-stream" } },
						);
					}
					const rpc = (await request.json()) as JsonRpcRequest;
					posts++;
					if (phase === "before-refresh" || phase === "after-response") ownerCurrent = false;
					if (phase === "after-response") {
						stream?.enqueue(
							encoder.encode(
								`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { state: "obsolete-owner" } })}\n\n`,
							),
						);
						return new Response(null, { status: 202 });
					}
					return new Response("synthetic auth challenge", { status: 401 });
				},
			});
			const transport = new LegacySseTransport({ type: "sse", url: server.url.href, timeout: 1000 });
			transport.onAuthError = async () => {
				refreshes++;
				refreshEntered.resolve();
				await releaseRefresh.promise;
				if (phase === "during-refresh-reject") throw new Error("synthetic refresh failure");
				return { Authorization: "Bearer synthetic-refreshed" };
			};
			try {
				await transport.connect();
				const outcome = transport
					.request(
						"tools/call",
						{},
						{
							allowAuthRetry: true,
							mcpOwnerCurrent: () => ownerCurrent,
						},
					)
					.then(
						result => ({ result, error: undefined }),
						(error: unknown) => ({ result: undefined, error }),
					);
				if (phase.startsWith("during-refresh")) {
					await withTimeout(refreshEntered.promise, 2_000, "owner-fenced auth refresh did not start");
					ownerCurrent = false;
					releaseRefresh.resolve();
				}
				const result = await withTimeout(outcome, 2_000, "owner-fenced request did not settle");
				expect(result.error).toMatchObject({ name: "AbortError" });
				expect(result.result).toBeUndefined();
				expect(posts).toBe(phase === "before-dispatch" ? 0 : 1);
				expect(refreshes).toBe(phase.startsWith("during-refresh") ? 1 : 0);
			} finally {
				releaseRefresh.resolve();
				await transport.close();
			}
		},
	);
});
