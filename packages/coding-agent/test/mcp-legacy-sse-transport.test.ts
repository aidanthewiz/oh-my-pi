import { afterEach, describe, expect, it } from "bun:test";
import { MCPConnectionTimeoutError, connectToServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { dispatchMCPTool, isRetriableConnectionError } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { LegacySseTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/sse";
import type { JsonRpcMessage } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { withTimeout } from "@oh-my-pi/pi-utils";

const encoder = new TextEncoder();
let server: Bun.Server<undefined> | null = null;

afterEach(() => {
	server?.stop(true);
	server = null;
});

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

	it("surfaces stream drops during requests as retriable transport failures", async () => {
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

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
					} else if ("id" in body && "method" in body && body.method === "tools/list") {
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
			await listTools(connection);
			throw new Error("Expected listTools to fail after legacy SSE stream close");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			if (error instanceof Error) {
				expect(error.message).toBe("Transport closed: legacy SSE stream closed");
				expect(isRetriableConnectionError(error)).toBe(true);
			}
		} finally {
			await connection.transport.close();
		}
	});
});

describe("legacy SSE authentication replay contracts", () => {
	for (const scenario of [
		{ label: "explicit never mutation", status: 401, retry: "never", readOnly: false, safe: false },
		{ label: "never overriding readonly metadata", status: 403, retry: "never", readOnly: true, safe: false },
		{ label: "default unannotated mutation", status: 403, retry: undefined, readOnly: false, safe: false },
		{ label: "annotated safe read", status: 401, retry: undefined, readOnly: true, safe: true },
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
					expect(outcome.error).toBeInstanceOf(Error);
					expect((outcome.error as Error).message).toBe(
						`HTTP ${scenario.status}: synthetic challenge after processing`,
					);
				}
				await expect(connection.transport.request("ping")).resolves.toEqual({ state: "stream-still-usable" });
			} finally {
				await connection.transport.close();
				await withTimeout(streamClosed.promise, 2_000, "authentication replay test leaked its SSE stream");
				expect(activeStreams).toBe(0);
			}
		});
	}
});
