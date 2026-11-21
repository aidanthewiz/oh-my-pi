import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { connectToServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { analyzeAuthError } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { dispatchMCPTool, MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPHttpServerConfig, MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import type { JsonRpcRequest } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPProgress } from "@oh-my-pi/pi-tui/tools/mcp";
import { postmortem } from "@oh-my-pi/pi-utils";

const encoder = new TextEncoder();
const TIMEOUT_TEST_MS = 50;
const REQUEST_TIMEOUT_MS = 5_000;
const GUARD_TIMEOUT_MS = 5_000;

let server: Bun.Server<undefined> | null = null;

type ToolList = {
	tools: { name: string; inputSchema: { type: string } }[];
};

afterEach(() => {
	server?.stop(true);
	server = null;
});

async function connectedTransport(timeout = REQUEST_TIMEOUT_MS): Promise<HttpTransport> {
	if (!server) throw new Error("Test server was not started");
	const transport = new HttpTransport({
		type: "http",
		url: `http://127.0.0.1:${server.port}/mcp`,
		timeout,
	});
	await transport.connect();
	return transport;
}

function stalledBodyResponse(bodyPrefix: string, init?: ResponseInit): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(bodyPrefix));
			},
		}),
		init,
	);
}

// Real time is intentional: this exercises Bun fetch aborting a live HTTP body stream,
// which fake timers do not drive through the socket/readable-stream stack.
async function withPendingGuard<T>(promise: Promise<T>, label: string): Promise<T> {
	return await Promise.race([
		promise,
		Bun.sleep(GUARD_TIMEOUT_MS).then(() => {
			throw new Error(`${label} stayed pending past ${GUARD_TIMEOUT_MS}ms`);
		}),
	]);
}

describe("MCP Streamable HTTP request progress", () => {
	it("routes pre-result SSE progress but only fans out malformed, unknown, and post-result frames", async () => {
		let sent: JsonRpcRequest | undefined;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				sent = (await req.json()) as JsonRpcRequest;
				const token = (sent.params?._meta as Record<string, unknown> | undefined)?.progressToken;
				const notification = (progressToken: unknown, progress: unknown) => ({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken, progress, total: 3, message: "fetching" },
				});
				const messages = [
					notification(String(token), 99),
					notification(token, "invalid"),
					notification(token, 1),
					{ jsonrpc: "2.0", id: sent.id, result: { done: true } },
					notification(token, 2),
				];
				return new Response(
					`data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":${JSON.stringify(token)},"progress":1e309}}\n\n` +
						`data: ${JSON.stringify(messages)}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport(300);
		const updates: MCPProgress[] = [];
		const notifications: unknown[] = [];
		transport.onNotification = (method, params) => {
			if (method === "notifications/progress") notifications.push(params);
		};
		try {
			const args = Object.freeze({ query: "unchanged" });
			const meta = Object.freeze({ trace: "keep", progressToken: "replace" });
			const result = await transport.request(
				"tools/call",
				{ name: "search", arguments: args, _meta: meta },
				{
					onProgress: progress => updates.push(progress),
				},
			);

			expect(result).toEqual({ done: true });
			expect(sent?.params?._meta).toEqual({ trace: "keep", progressToken: sent?.id });
			expect(sent?.params?.arguments).toEqual(args);
			expect(meta).toEqual({ trace: "keep", progressToken: "replace" });
			expect(updates).toEqual([{ progress: 1, total: 3, message: "fetching" }]);
			expect(notifications).toHaveLength(5);
			expect(notifications).toContainEqual(expect.objectContaining({ progress: 2 }));
		} finally {
			await transport.close();
		}
	});

	it("routes GET-listener progress during a pending POST and stops after settlement", async () => {
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		let token: unknown;
		const release = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								stream = controller;
								controller.enqueue(encoder.encode(": connected\n\n"));
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				const body = (await req.json()) as JsonRpcRequest;
				token = (body.params?._meta as Record<string, unknown> | undefined)?.progressToken;
				stream?.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							jsonrpc: "2.0",
							method: "notifications/progress",
							params: { progressToken: token, progress: 1 },
						})}\n\n`,
					),
				);
				await release.promise;
				return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
			},
		});
		const transport = await connectedTransport(300);
		const progressReceived = Promise.withResolvers<void>();
		const lateReceived = Promise.withResolvers<void>();
		const updates: MCPProgress[] = [];
		transport.onNotification = (_method, params) => {
			if ((params as Record<string, unknown>).progress === 1) progressReceived.resolve();
			if ((params as Record<string, unknown>).progress === 2) lateReceived.resolve();
		};
		try {
			await transport.startSSEListener();
			const pending = transport.request(
				"tools/call",
				{},
				{
					onProgress: progress => {
						updates.push(progress);
					},
				},
			);
			void pending.catch(() => {});
			await withPendingGuard(progressReceived.promise, "pending GET progress fanout");
			expect(updates).toEqual([{ progress: 1 }]);
			release.resolve();
			await pending;
			expect(updates).toEqual([{ progress: 1 }]);
			stream?.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/progress",
						params: { progressToken: token, progress: 2 },
					})}\n\n`,
				),
			);
			await withPendingGuard(lateReceived.promise, "late GET progress fanout");
			expect(updates).toEqual([{ progress: 1 }]);
		} finally {
			release.resolve();
			await transport.close();
		}
	});

	it("allocates a new progress token for an HTTP auth retry", async () => {
		const ids: (string | number)[] = [];
		const tokens: unknown[] = [];
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as JsonRpcRequest;
				ids.push(body.id);
				tokens.push((body.params?._meta as Record<string, unknown> | undefined)?.progressToken);
				if (ids.length === 1) return new Response("expired", { status: 401 });
				return new Response(
					`data: ${JSON.stringify([
						{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: ids[0], progress: 99 } },
						{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: body.id, progress: 1 } },
						{ jsonrpc: "2.0", id: body.id, result: {} },
					])}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport(300);
		transport.onAuthError = async () => ({ Authorization: "Bearer refreshed" });
		const updates: MCPProgress[] = [];
		try {
			await transport.request("tools/call", {}, { onProgress: progress => updates.push(progress) });
			expect(ids).toHaveLength(2);
			expect(ids[0]).not.toBe(ids[1]);
			expect(tokens).toEqual(ids);
			expect(updates).toEqual([{ progress: 1 }]);
		} finally {
			await transport.close();
		}
	});
});

describe("MCP Streamable HTTP initialization", () => {
	it("sends initialized before opening the optional GET SSE stream", async () => {
		const requests: string[] = [];
		let initialized = false;
		let sessionValid = true;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					requests.push("GET");
					if (initialized) return new Response(null, { status: 405 });
					sessionValid = false;
					return new Response("session is not initialized", { status: 400 });
				}
				if (req.method === "DELETE") return new Response(null, { status: 204 });

				const body = (await req.json()) as { id?: string | number; method: string };
				requests.push(body.method);
				if (body.method === "initialize") {
					const response = {
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							serverInfo: { name: "session-order", version: "1.0.0" },
						},
					};
					return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
						headers: {
							"Content-Type": "text/event-stream",
							"Mcp-Session-Id": "session-order",
						},
					});
				}
				if (!sessionValid) return new Response("session terminated", { status: 409 });
				initialized = true;
				return new Response(null, { status: 202 });
			},
		});

		const connection = await connectToServer("session-order", {
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});

		expect(requests).toEqual(["initialize", "notifications/initialized", "GET"]);
		await connection.transport.close();
	});

	it("aborts a stalled GET SSE listener start on the caller signal when timeouts are disabled", async () => {
		const listenerStarted = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				if (req.method === "GET") {
					listenerStarted.resolve();
					// Never answers: with timeouts disabled only the caller signal can end the handshake.
					return Promise.withResolvers<Response>().promise;
				}
				if (req.method === "DELETE") return new Response(null, { status: 204 });
				const body = (await req.json()) as { id?: string | number; method: string };
				if (body.method === "initialize") {
					const response = {
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: {},
							serverInfo: { name: "stalled-listener", version: "1.0.0" },
						},
					};
					return new Response(JSON.stringify(response), {
						headers: { "Content-Type": "application/json", "Mcp-Session-Id": "stalled-listener" },
					});
				}
				return new Response(null, { status: 202 });
			},
		});

		const controller = new AbortController();
		const connection = connectToServer(
			"stalled-listener",
			{ type: "http", url: `http://127.0.0.1:${server.port}/mcp`, timeout: 0 },
			{ signal: controller.signal },
		);
		await listenerStarted.promise;
		controller.abort();
		await expect(withPendingGuard(connection, "handshake")).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("MCP Streamable HTTP failure diagnostics", () => {
	it("preserves authentication challenges while redacting credentials", () => {
		const message = (value: string) =>
			new MCPTransportError({
				transport: "http",
				stage: "protocol",
				failure: "http_status",
				message: value,
				retryable: false,
			}).message;

		const challenge = 'HTTP 401: invalid_token [WWW-Authenticate: Bearer realm="https://auth.test"]';
		expect(message(challenge)).toBe(challenge);
		expect(message("Bearer fresh-token")).toBe("Bearer [redacted]");
		expect(message("Basic dXNlcjpwYXNz==")).toBe("Basic [redacted]");
	});

	it("does not replay an accepted JSON response whose body is cut short", async () => {
		const tcp = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket) {
					socket.end(
						'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{"jsonrpc":"2.0",',
					);
				},
			},
		});
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${tcp.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		try {
			await transport.connect();
			await expect(transport.request("tools/list")).rejects.toMatchObject({
				transport: "http",
				stage: "decode",
				retryable: false,
			});
		} finally {
			await transport.close();
			tcp.stop(true);
		}
	});

	it("classifies a reset after connecting as non-replayable without leaking Bun fetch advice", async () => {
		const tcp = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					socket.end();
				},
				data() {},
			},
		});
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${tcp.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		try {
			await transport.connect();
			const error = await transport.request("tools/list").then(
				() => undefined,
				reason => reason,
			);
			if (!(error instanceof MCPTransportError)) throw error;
			expect(error).toMatchObject({
				transport: "http",
				stage: "send",
				failure: "reset",
				retryable: false,
				code: "ECONNRESET",
			});
		} finally {
			await transport.close();
			tcp.stop(true);
		}
	});

	it("distinguishes connection refusal from a reset", async () => {
		const unused = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		const port = unused.port;
		unused.stop(true);
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		await transport.connect();

		await expect(transport.request("tools/list")).rejects.toMatchObject({
			transport: "http",
			stage: "connect",
			failure: "connect",
			retryable: true,
		});
		await transport.close();
	});

	it("classifies malformed JSON-RPC responses at the decode stage", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("{not-json", { headers: { "Content-Type": "application/json" } });
			},
		});
		const transport = await connectedTransport();

		await expect(transport.request("tools/list")).rejects.toMatchObject({
			transport: "http",
			stage: "decode",
			failure: "malformed_response",
			retryable: false,
		});
	});

	it("preserves bounded redacted JSON-RPC data and a response trace ID", async () => {
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as { id: string | number };
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						error: {
							code: -32042,
							message: "upstream rejected the call",
							data: { detail: "x".repeat(3_000), token: "server-secret", traceId: "data-trace" },
						},
					},
					{ headers: { "X-Request-Id": "request-abc123" } },
				);
			},
		});
		const transport = await connectedTransport();
		const error = await transport.request("tools/list").then(
			() => undefined,
			reason => reason,
		);
		if (!(error instanceof MCPTransportError)) throw error;

		expect(error).toMatchObject({
			transport: "http",
			stage: "protocol",
			failure: "json_rpc",
			retryable: false,
			code: -32042,
			traceId: "request-abc123",
		});
		expect(error.data?.length).toBeLessThanOrEqual(2_000);
		expect(error.data).toContain("[redacted]");
		expect(error.data).not.toContain("server-secret");
	});

	it("keeps a bare Bearer resource_metadata challenge while redacting echoed credentials", async () => {
		const metadataUrl = "https://auth.example.test/prm/probe";
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("rejected Authorization: Bearer server-secret", {
					status: 401,
					headers: {
						"WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}", authorization_uri="https://auth.example.test/authorize", token_uri="https://auth.example.test/token", scope="read"`,
					},
				});
			},
		});
		const transport = await connectedTransport();
		const error = await transport.request("initialize").then(
			() => undefined,
			reason => reason,
		);
		if (!(error instanceof MCPTransportError)) throw error;

		expect(error.message).not.toContain("server-secret");
		const auth = analyzeAuthError(error, `http://127.0.0.1:${server.port}/mcp`);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.resourceMetadataUrl).toBe(metadataUrl);
		expect(auth.oauth).toMatchObject({
			authorizationUrl: "https://auth.example.test/authorize",
			tokenUrl: "https://auth.example.test/token",
			scopes: "read",
		});
	});
});

describe("MCP Streamable HTTP action delivery", () => {
	it.each(["reset", "eof", "decode-reset", "fetch-failed", "gateway-error"] as const)(
		"does not replay a committed action after %s",
		async failure => {
			const effects = new Database(":memory:");
			effects.run("CREATE TABLE effects (units INTEGER NOT NULL)");
			const transports: HttpTransport[] = [];
			let received = 0;
			let reconnects = 0;
			const config: MCPHttpServerConfig = {
				type: "http",
				url: "https://owned-mcp-action.invalid/mcp",
				timeout: REQUEST_TIMEOUT_MS,
			};
			const receiver = Object.assign(
				async (...[input, init]: Parameters<typeof fetch>) => {
					const request =
						input instanceof Request
							? new Request(input, init as RequestInit)
							: new Request(String(input), init as RequestInit);
					expect(request.url).toBe(config.url);
					const body = (await request.json()) as {
						id: number;
						method: string;
						params: { arguments: { units: number } };
					};
					expect(body.method).toBe("tools/call");
					effects.run("INSERT INTO effects(units) VALUES (?)", [body.params.arguments.units]);
					received++;
					if (received === 1) {
						if (failure === "reset")
							throw Object.assign(new Error("response lost after commit"), { code: "ECONNRESET" });
						if (failure === "eof")
							throw Object.assign(new Error("socket closed after commit"), { code: "EPIPE" });
						if (failure === "fetch-failed") throw new TypeError("fetch failed");
						if (failure === "gateway-error")
							return new Response("gateway lost the committed response", { status: 503 });
						return new Response(
							new ReadableStream({
								start(controller) {
									controller.error(
										Object.assign(new Error("response body reset after commit"), { code: "ECONNRESET" }),
									);
								},
							}),
							{ headers: { "Content-Type": "application/json" } },
						);
					}
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: "committed" }] },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			);
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(receiver);
			const connect = async (): Promise<MCPServerConnection> => {
				const transport = new HttpTransport(config);
				transports.push(transport);
				await transport.connect();
				return {
					name: "owned-actions",
					config,
					transport,
					capabilities: { tools: {} },
					serverInfo: { name: "owned-actions", version: "1" },
				};
			};
			try {
				const tool = new MCPTool(
					await connect(),
					{
						name: "append_action",
						annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
						inputSchema: { type: "object", properties: { units: { type: "number" } }, required: ["units"] },
					},
					async () => {
						reconnects++;
						return connect();
					},
				);
				const result = await tool.execute(
					"one-authorized-action",
					{ units: 7 },
					undefined,
					{} as CustomToolContext,
				);
				expect(effects.query("SELECT units FROM effects").all()).toEqual([{ units: 7 }]);
				expect(result.isError).toBe(true);
				expect(reconnects).toBe(0);
			} finally {
				for (const transport of transports.reverse()) await transport.close();
				fetchSpy.mockRestore();
				effects.close();
			}
		},
	);

	it.each(["refused", "dns", "stale-session"] as const)(
		"recovers a known %s refusal before executing an action",
		async refusal => {
			const effects = new Database(":memory:");
			effects.run("CREATE TABLE effects (units INTEGER NOT NULL)");
			const transports: HttpTransport[] = [];
			let attempts = 0;
			let reconnects = 0;
			const config: MCPHttpServerConfig = {
				type: "http",
				url: "https://owned-mcp-action.invalid/mcp",
				timeout: REQUEST_TIMEOUT_MS,
			};
			const receiver = Object.assign(
				async (...[input, init]: Parameters<typeof fetch>) => {
					const request =
						input instanceof Request
							? new Request(input, init as RequestInit)
							: new Request(String(input), init as RequestInit);
					expect(request.url).toBe(config.url);
					attempts++;
					if (attempts === 1) {
						if (refusal === "stale-session") return new Response("unknown MCP session", { status: 404 });
						throw Object.assign(new TypeError("fetch failed"), {
							code: refusal === "dns" ? "ENOTFOUND" : "ECONNREFUSED",
						});
					}
					const body = (await request.json()) as {
						id: number;
						method: string;
						params: { arguments: { units: number } };
					};
					expect(body.method).toBe("tools/call");
					effects.run("INSERT INTO effects(units) VALUES (?)", [body.params.arguments.units]);
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: "committed" }] },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			);
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(receiver);
			const connect = async (): Promise<MCPServerConnection> => {
				const transport = new HttpTransport(config);
				transports.push(transport);
				await transport.connect();
				return {
					name: "owned-actions",
					config,
					transport,
					capabilities: { tools: {} },
					serverInfo: { name: "owned-actions", version: "1" },
				};
			};
			try {
				const tool = new MCPTool(
					await connect(),
					{
						name: "append_action",
						annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
						inputSchema: { type: "object", properties: { units: { type: "number" } }, required: ["units"] },
					},
					async () => {
						reconnects++;
						return connect();
					},
				);
				const result = await tool.execute(
					"one-authorized-action",
					{ units: 7 },
					undefined,
					{} as CustomToolContext,
				);
				expect(effects.query("SELECT units FROM effects").all()).toEqual([{ units: 7 }]);
				expect(result.isError).not.toBe(true);
				expect(reconnects).toBe(1);
			} finally {
				for (const transport of transports.reverse()) await transport.close();
				fetchSpy.mockRestore();
				effects.close();
			}
		},
	);
});

describe("MCP Streamable HTTP authentication replay policy", () => {
	for (const scenario of [
		{ label: "explicit never mutation", retry: "never", hint: false, safe: false, status: 401 },
		{ label: "explicit never overrides readonly metadata", retry: "never", hint: true, safe: false, status: 403 },
		{ label: "default unannotated mutation", retry: undefined, hint: false, safe: false, status: 403 },
		{ label: "default annotated read", retry: undefined, hint: true, safe: true, status: 401 },
		{ label: "explicit safe read", retry: "read", hint: false, safe: true, status: 403 },
	] as const) {
		it(`honors transport authentication replay policy for ${scenario.label}`, async () => {
			const effects: string[] = [];
			let calls = 0;
			let refreshes = 0;
			const definition = {
				name: scenario.safe ? "get_state" : "create_record",
				inputSchema: { type: "object" },
				annotations: scenario.hint ? { readOnlyHint: true } : undefined,
			};
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(req) {
					if (req.method !== "POST") return new Response(null, { status: 405 });
					const rpc = (await req.json()) as { id?: string | number; method: string };
					if (rpc.id === undefined) return new Response(null, { status: 202 });
					let result: unknown = {};
					if (rpc.method === "initialize") {
						result = {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "synthetic-http-auth", version: "1" },
						};
					} else if (rpc.method === "tools/list") {
						result = { tools: [definition] };
					} else if (rpc.method === "tools/call") {
						calls++;
						if (!scenario.safe) effects.push("synthetic-record");
						if (req.headers.get("Authorization") !== "Bearer synthetic-refreshed") {
							return new Response("synthetic auth rejection after processing", {
								status: scenario.status,
								headers: {
									"WWW-Authenticate": 'Bearer realm="synthetic"',
									"X-Request-Id": "synthetic-original-response",
								},
							});
						}
						result = {
							content: [{ type: "text", text: "Recovered synthetic state" }],
							structuredContent: { state: "synthetic-state" },
						};
					}
					return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
				},
			});
			const connection = await connectToServer("synthetic-http-auth", {
				type: "http",
				url: server.url.href,
				timeout: REQUEST_TIMEOUT_MS,
			});
			try {
				const [tool] = await listTools(connection);
				if (!tool) throw new Error("Synthetic server exposed no tool");
				if (!(connection.transport instanceof HttpTransport)) throw new Error("Expected HTTP transport");
				connection.transport.onAuthError = async () => {
					refreshes++;
					return { Authorization: "Bearer synthetic-refreshed" };
				};
				const outcome = await dispatchMCPTool(connection, tool, {}, undefined, { retry: scenario.retry }).then(
					attempt => ({ result: attempt.result, error: undefined }),
					(error: unknown) => ({ result: undefined, error }),
				);
				if (scenario.safe) {
					expect(outcome.error).toBeUndefined();
					expect(outcome.result?.structuredContent).toEqual({ state: "synthetic-state" });
					expect(calls).toBe(2);
					expect(refreshes).toBe(1);
					expect(effects).toEqual([]);
				} else {
					expect(effects).toEqual(["synthetic-record"]);
					expect(calls).toBe(1);
					expect(refreshes).toBe(0);
					expect(outcome.error).toBeInstanceOf(MCPTransportError);
					expect(outcome.error).toMatchObject({
						transport: "http",
						stage: "receive",
						failure: "http_status",
						code: scenario.status,
						traceId: "synthetic-original-response",
					});
				}
			} finally {
				await connection.transport.close();
			}
		});
	}

	it("enforces allowAuthRetry false at the direct request boundary", async () => {
		const effects: string[] = [];
		let refreshes = 0;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response(null, { status: 405 });
				const rpc = (await req.json()) as { id: number };
				effects.push("synthetic-record");
				if (req.headers.get("Authorization") !== "Bearer synthetic-refreshed") {
					return new Response("synthetic mutation recorded", { status: 401 });
				}
				return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { applied: true } });
			},
		});
		const transport = await connectedTransport();
		transport.onAuthError = async () => {
			refreshes++;
			return { Authorization: "Bearer synthetic-refreshed" };
		};
		try {
			const error = await transport.request("tools/call", { name: "create_record" }, { allowAuthRetry: false }).then(
				() => undefined,
				reason => reason,
			);
			expect(effects).toEqual(["synthetic-record"]);
			expect(refreshes).toBe(0);
			expect(error).toMatchObject({ failure: "http_status", code: 401, retryable: false });
		} finally {
			await transport.close();
		}
	});

	it("retains auth recovery for discovery requests without a replay override", async () => {
		let refreshes = 0;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				if (req.method !== "POST") return new Response(null, { status: 405 });
				const rpc = (await req.json()) as { id: number };
				if (req.headers.get("Authorization") !== "Bearer synthetic-refreshed") {
					return new Response("synthetic discovery auth rejection", { status: 403 });
				}
				return Response.json({
					jsonrpc: "2.0",
					id: rpc.id,
					result: { tools: [{ name: "discovered", inputSchema: { type: "object" } }] },
				});
			},
		});
		const transport = await connectedTransport();
		transport.onAuthError = async () => {
			refreshes++;
			return { Authorization: "Bearer synthetic-refreshed" };
		};
		try {
			await expect(transport.request<ToolList>("tools/list")).resolves.toEqual({
				tools: [{ name: "discovered", inputSchema: { type: "object" } }],
			});
			expect(refreshes).toBe(1);
		} finally {
			await transport.close();
		}
	});

	it.each(["before-dispatch", "before-refresh", "during-refresh", "during-refresh-reject", "after-response"])(
		"rejects an expired request owner at %s without credential or request replay",
		async phase => {
			let ownerCurrent = phase !== "before-dispatch";
			let posts = 0;
			let refreshes = 0;
			const refreshEntered = Promise.withResolvers<void>();
			const releaseRefresh = Promise.withResolvers<void>();
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (request.method !== "POST") return new Response(null, { status: 405 });
					const rpc = (await request.json()) as JsonRpcRequest;
					posts++;
					if (phase === "before-refresh" || phase === "after-response") ownerCurrent = false;
					if (phase === "after-response") {
						return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { state: "obsolete-owner" } });
					}
					return new Response("synthetic auth challenge", { status: 401 });
				},
			});
			const transport = await connectedTransport();
			transport.onAuthError = async () => {
				refreshes++;
				refreshEntered.resolve();
				await releaseRefresh.promise;
				if (phase === "during-refresh-reject") throw new Error("synthetic refresh failure");
				return { Authorization: "Bearer synthetic-refreshed" };
			};
			try {
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
					await withPendingGuard(refreshEntered.promise, "owner-fenced auth refresh");
					ownerCurrent = false;
					releaseRefresh.resolve();
				}
				const result = await withPendingGuard(outcome, "owner-fenced request");
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

describe("MCP Streamable HTTP transport timeouts", () => {
	it("keeps the request timeout active until a JSON response body is fully read", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse('{"jsonrpc":"2.0","id":"', {
					headers: { "Content-Type": "application/json" },
				});
			},
		});
		const transport = await connectedTransport(TIMEOUT_TEST_MS);

		await expect(withPendingGuard(transport.request("tools/list"), "request")).rejects.toMatchObject({
			transport: "http",
			stage: "decode",
			failure: "timeout",
			retryable: false,
			message: `Request timeout after ${TIMEOUT_TEST_MS}ms`,
		});
	});

	it("uses one deadline across delayed SSE headers and a stalled response body", async () => {
		// Real time is required here: fake timers do not drive Bun's fetch/socket
		// abort path, and elapsed time is the end-to-end contract under test.
		const timeoutMs = 250;
		const headerDelayMs = 160;
		server = Bun.serve({
			port: 0,
			async fetch() {
				await Bun.sleep(headerDelayMs);
				return stalledBodyResponse(": accepted\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const transport = await connectedTransport(timeoutMs);
		const startedAt = performance.now();

		try {
			await expect(withPendingGuard(transport.request("tools/list"), "SSE request")).rejects.toMatchObject({
				transport: "http",
				stage: "receive",
				failure: "timeout",
				retryable: false,
			});
			expect(performance.now() - startedAt).toBeLessThan(timeoutMs + 100);
		} finally {
			await transport.close();
		}
	});

	it.each(["deadline", "caller"] as const)("preserves %s-first JSON response failure precedence", async first => {
		vi.useFakeTimers();
		const caller = new AbortController();
		const callerReason = new DOMException("Synthetic caller cancellation", "AbortError");
		const bodyFailure = new SyntaxError("Synthetic interrupted JSON body");
		const bodyReadStarted = Promise.withResolvers<void>();
		const operationAborted = Promise.withResolvers<void>();
		let bodyController!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					bodyController = controller;
				},
				pull() {
					bodyReadStarted.resolve();
				},
			},
			{ highWaterMark: 0 },
		);
		const receiver = Object.assign(
			async (...[_input, init]: Parameters<typeof fetch>) => {
				if (init?.signal?.aborted) operationAborted.resolve();
				else init?.signal?.addEventListener("abort", () => operationAborted.resolve(), { once: true });
				return new Response(body, {
					headers: {
						"Content-Type": "application/json",
						"X-Request-Id": "synthetic-precedence",
					},
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(receiver);
		const transport = new HttpTransport({
			type: "http",
			url: "http://first-abort.invalid/mcp",
			timeout: REQUEST_TIMEOUT_MS,
		});
		try {
			await transport.connect();
			const outcome = transport.request("tools/list", undefined, { signal: caller.signal }).then(
				() => undefined,
				(error: unknown) => error,
			);
			await bodyReadStarted.promise;
			if (first === "deadline") vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
			else caller.abort(callerReason);
			await operationAborted.promise;
			if (first === "deadline") caller.abort(callerReason);
			else vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
			bodyController.error(bodyFailure);

			const error = await outcome;
			if (first === "deadline") {
				expect(error).toBeInstanceOf(MCPTransportError);
				expect(error).toMatchObject({
					transport: "http",
					stage: "decode",
					failure: "timeout",
					retryable: false,
					traceId: "synthetic-precedence",
				});
			} else {
				expect(error).toBe(callerReason);
			}
		} finally {
			bodyController.error(bodyFailure);
			try {
				await transport.close();
			} finally {
				fetchSpy.mockRestore();
				vi.useRealTimers();
			}
		}
	});

	it("keeps the notify timeout active while reading HTTP error bodies", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return stalledBodyResponse("partial failure body", {
					status: 500,
					headers: { "Content-Type": "text/plain" },
				});
			},
		});
		const transport = await connectedTransport(TIMEOUT_TEST_MS);

		await expect(withPendingGuard(transport.notify("notifications/initialized"), "notify")).rejects.toThrow(
			`Notify timeout after ${TIMEOUT_TEST_MS}ms`,
		);
	});

	it("close aborts and drains an in-flight SSE POST request", async () => {
		const requestReceived = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			fetch() {
				requestReceived.resolve();
				return stalledBodyResponse("", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		await transport.connect();

		const request = transport.request("tools/list");
		await requestReceived.promise;
		const closing = transport.close();

		const requestError = await withPendingGuard(request, "aborted request").then(
			() => undefined,
			error => error,
		);
		expect(requestError).toMatchObject({ name: "AbortError" });
		expect(postmortem.isExpectedCleanupError(requestError)).toBe(true);
		await withPendingGuard(closing, "transport close");
	});

	it("preserves caller cancellation when it wins a stalled SSE response", async () => {
		const requestReceived = Promise.withResolvers<void>();
		const caller = new AbortController();
		server = Bun.serve({
			port: 0,
			fetch() {
				requestReceived.resolve();
				return stalledBodyResponse(": accepted\n\n", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const transport = await connectedTransport(GUARD_TIMEOUT_MS);

		try {
			const request = transport.request("tools/list", undefined, { signal: caller.signal });
			await requestReceived.promise;
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;
			caller.abort();

			const error = await withPendingGuard(request, "caller-aborted SSE request").then(
				() => undefined,
				reason => reason,
			);
			expect(error).toMatchObject({ name: "AbortError" });
			expect(error).not.toBeInstanceOf(MCPTransportError);
		} finally {
			await transport.close();
		}
	});

	it("drains post-result SSE notifications and server requests after caller abort until transport close", async () => {
		const caller = new AbortController();
		const streamReady = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
		const bodyCancelled = Promise.withResolvers<void>();
		const replyReceived = Promise.withResolvers<unknown>();
		const receiver = Object.assign(
			async (...[input, init]: Parameters<typeof fetch>) => {
				const request =
					input instanceof Request
						? new Request(input, init as RequestInit)
						: new Request(String(input), init as RequestInit);
				const body = (await request.json()) as { id: string | number; method?: string };
				if (body.method === "tools/list") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								streamReady.resolve(controller);
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify({
											jsonrpc: "2.0",
											id: body.id,
											result: { tools: [{ name: "synthetic", inputSchema: { type: "object" } }] },
										})}\n\n`,
									),
								);
							},
							cancel() {
								bodyCancelled.resolve();
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				replyReceived.resolve(body);
				return new Response(null, { status: 202 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(receiver);
		const transport = new HttpTransport({
			type: "http",
			url: "http://post-result-drain.invalid/mcp",
			timeout: 0,
		});
		const notifications: { method: string; params: unknown }[] = [];
		const requests: { method: string; params: unknown }[] = [];
		transport.onNotification = (method, params) => notifications.push({ method, params });
		transport.onRequest = async (method, params) => {
			requests.push({ method, params });
			return { roots: [{ uri: "file:///synthetic", name: "synthetic" }] };
		};

		try {
			await transport.connect();
			const result = await transport.request("tools/list", undefined, { signal: caller.signal });
			expect(result).toEqual({ tools: [{ name: "synthetic", inputSchema: { type: "object" } }] });
			caller.abort();
			const stream = await streamReady.promise;
			stream.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/resources/updated",
						params: { uri: "file:///synthetic/drain-result" },
					})}\n\n` +
						`data: ${JSON.stringify({
							jsonrpc: "2.0",
							id: "trailing-roots",
							method: "roots/list",
							params: { _meta: { sequence: 1 } },
						})}\n\n`,
				),
			);

			const outcome = await Promise.race([
				replyReceived.promise.then(reply => ({ kind: "reply", reply })),
				bodyCancelled.promise.then(() => ({ kind: "cancelled" })),
			]);
			expect(outcome).toEqual({
				kind: "reply",
				reply: {
					jsonrpc: "2.0",
					id: "trailing-roots",
					result: { roots: [{ uri: "file:///synthetic", name: "synthetic" }] },
				},
			});

			stream.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/resources/updated",
						params: { uri: "file:///synthetic/obsolete" },
					})}\n\n` +
						`data: ${JSON.stringify({
							jsonrpc: "2.0",
							id: "obsolete-roots",
							method: "roots/list",
							params: { _meta: { sequence: 2 } },
						})}\n\n`,
				),
			);
			await Promise.all([transport.close(), bodyCancelled.promise]);
			expect(notifications).toEqual([
				{ method: "notifications/resources/updated", params: { uri: "file:///synthetic/drain-result" } },
			]);
			expect(requests).toEqual([{ method: "roots/list", params: { _meta: { sequence: 1 } } }]);
		} finally {
			try {
				await transport.close();
			} finally {
				fetchSpy.mockRestore();
			}
		}
	});

	it("refuses pre-result SSE notifications and server requests after request-owner retirement", async () => {
		let ownerCurrent = true;
		const streamReady = Promise.withResolvers<{
			stream: ReadableStreamDefaultController<Uint8Array>;
			id: string | number;
		}>();
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as { id: string | number; method?: string };
				if (body.method !== "tools/list") return new Response(null, { status: 202 });
				return new Response(
					new ReadableStream<Uint8Array>({
						start(stream) {
							streamReady.resolve({ stream, id: body.id });
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport(0);
		const notifications: { method: string; params: unknown }[] = [];
		const requests: { method: string; params: unknown }[] = [];
		transport.onNotification = (method, params) => notifications.push({ method, params });
		transport.onRequest = async (method, params) => {
			requests.push({ method, params });
			return { roots: [{ uri: "file:///synthetic/protected" }] };
		};

		try {
			const pending = transport.request("tools/list", undefined, { mcpOwnerCurrent: () => ownerCurrent }).then(
				result => ({ result, error: undefined }),
				error => ({ result: undefined, error }),
			);
			const { stream, id } = await streamReady.promise;
			ownerCurrent = false;
			stream.enqueue(
				encoder.encode(
					`data: ${JSON.stringify([
						{
							jsonrpc: "2.0",
							method: "notifications/resources/updated",
							params: { uri: "file:///synthetic/protected" },
						},
						{ jsonrpc: "2.0", id: "retired-roots", method: "roots/list", params: {} },
						{ jsonrpc: "2.0", id, result: { tools: [{ name: "protected", inputSchema: { type: "object" } }] } },
					])}\n\n`,
				),
			);

			const outcome = await pending;
			expect(outcome.error).toMatchObject({ name: "AbortError" });
			expect(outcome.result).toBeUndefined();
			expect(notifications).toEqual([]);
			expect(requests).toEqual([]);
		} finally {
			await transport.close();
		}
	});

	it("keeps draining an accepted notification stream past the POST deadline", async () => {
		const notificationReceived = Promise.withResolvers<void>();
		const sendNotification = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			fetch() {
				let cancelled = false;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode(": accepted\n\n"));
							void sendNotification.promise.then(() => {
								if (cancelled) return;
								try {
									controller.enqueue(
										encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'),
									);
									controller.close();
								} catch {
									// The negative path intentionally cancels the client stream.
								}
							});
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const transport = await connectedTransport(TIMEOUT_TEST_MS);
		transport.onNotification = method => {
			if (method === "notifications/progress") notificationReceived.resolve();
		};

		try {
			await transport.notify("notifications/initialized");
			// Let the former read timeout expire on the real fetch/body stream,
			// then prove the accepted response remains owned by the transport.
			await Bun.sleep(REQUEST_TIMEOUT_MS * 2);
			sendNotification.resolve();
			await withPendingGuard(notificationReceived.promise, "notification response drain");
		} finally {
			await transport.close();
		}
	}, 20_000);

	it("keeps an abandoned SSE request rejection observed after caller cancellation", async () => {
		const requestReceived = Promise.withResolvers<void>();
		const caller = new AbortController();
		server = Bun.serve({
			port: 0,
			fetch() {
				requestReceived.resolve();
				return stalledBodyResponse("", {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const transport = await connectedTransport();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			void transport.request("tools/list", undefined, { signal: caller.signal });
			await requestReceived.promise;
			caller.abort();
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			await transport.close();
		}
	});
});

describe("MCP Streamable HTTP protocol version header", () => {
	it("never lets a configured MCP-Protocol-Version reach the server", async () => {
		const seen: { pre: string | null; post: string | null } = { pre: null, post: null };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const body = req.headers.get("MCP-Protocol-Version");
				return Response.json({ jsonrpc: "2.0", id: 1, result: { seen: body } });
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: REQUEST_TIMEOUT_MS,
			headers: { "MCP-Protocol-Version": "1999-01-01" },
		});
		await transport.connect();

		// Pre-negotiation: configured header must be stripped, not leaked.
		seen.pre = await withPendingGuard(transport.request<{ seen: string | null }>("initialize"), "request").then(
			r => r.seen,
		);
		// Post-negotiation: the negotiated version wins over the configured one.
		transport.setProtocolVersion("2025-11-25");
		seen.post = await withPendingGuard(transport.request<{ seen: string | null }>("tools/list"), "request").then(
			r => r.seen,
		);

		expect(seen.pre).toBeNull();
		expect(seen.post).toBe("2025-11-25");
	});
});

describe("MCP Streamable HTTP POST response resumption", () => {
	it("reports a timeout when a resumed HTTP error body stalls", async () => {
		let posts = 0;
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					posts++;
					return new Response("id: stream-1\nretry: 0\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				return stalledBodyResponse("unavailable", { status: 503 });
			},
		});
		const transport = await connectedTransport(TIMEOUT_TEST_MS);
		try {
			await expect(
				withPendingGuard(transport.request("tools/call"), "stalled resume error body"),
			).rejects.toMatchObject({
				failure: "timeout",
				retryable: false,
			});
			expect(posts).toBe(1);
		} finally {
			await transport.close();
		}
	});

	it("bounds resumed-stream auth refresh by the original request deadline", async () => {
		const refresh = Promise.withResolvers<Record<string, string> | null>();
		let posts = 0;
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					posts++;
					return new Response("id: stream-1\nretry: 0\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				return new Response("expired", { status: 401 });
			},
		});
		const transport = await connectedTransport(TIMEOUT_TEST_MS);
		transport.onAuthError = () => refresh.promise;
		try {
			await expect(
				withPendingGuard(transport.request("tools/call"), "stalled resume auth refresh"),
			).rejects.toMatchObject({
				failure: "timeout",
				retryable: false,
			});
			expect(posts).toBe(1);
		} finally {
			refresh.resolve(null);
			await transport.close();
		}
	});

	it("resumes a closed response stream with Last-Event-ID after the requested retry delay", async () => {
		const observed: {
			lastEventId: string | null;
			protocolVersion: string | null;
			postClosedAt: number;
			resumedAt: number;
		} = { lastEventId: null, protocolVersion: null, postClosedAt: 0, resumedAt: 0 };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					observed.postClosedAt = performance.now();
					return new Response("id: stream-1\nretry: 20\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				observed.resumedAt = performance.now();
				observed.lastEventId = req.headers.get("Last-Event-ID");
				observed.protocolVersion = req.headers.get("MCP-Protocol-Version");
				return new Response(
					'id: stream-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"resumed","inputSchema":{"type":"object"}}]}}\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
		});
		await transport.connect();
		transport.setProtocolVersion("2025-11-25");

		await expect(withPendingGuard(transport.request<ToolList>("tools/list"), "request")).resolves.toEqual({
			tools: [{ name: "resumed", inputSchema: { type: "object" } }],
		});
		expect(observed.lastEventId).toBe("stream-1");
		expect(observed.protocolVersion).toBe("2025-11-25");
		expect(observed.resumedAt - observed.postClosedAt).toBeGreaterThanOrEqual(15);
	});
	it.each([undefined, false])(
		"refreshes auth on a 401 resume GET without replaying the POST (allowAuthRetry=%s)",
		async allowAuthRetry => {
			const observed = { posts: 0, gets: 0, auth: [] as (string | null)[], lastEventId: null as string | null };
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(req) {
					if (req.method === "POST") {
						observed.posts++;
						return new Response("id: stream-1\nretry: 10\ndata:\n\n", {
							headers: { "Content-Type": "text/event-stream" },
						});
					}
					observed.gets++;
					observed.auth.push(req.headers.get("Authorization"));
					observed.lastEventId = req.headers.get("Last-Event-ID");
					if (req.headers.get("Authorization") !== "Bearer fresh") {
						return new Response("expired", { status: 401 });
					}
					return new Response(
						'id: stream-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"resumed","inputSchema":{"type":"object"}}]}}\n\n',
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				},
			});
			if (!server) throw new Error("Test server was not started");
			const transport = new HttpTransport({
				type: "http",
				url: `http://127.0.0.1:${server.port}/mcp`,
				timeout: GUARD_TIMEOUT_MS,
				headers: { Authorization: "Bearer stale" },
			});
			transport.onAuthError = async () => ({ Authorization: "Bearer fresh" });
			await transport.connect();

			const tools = await withPendingGuard(
				transport.request<ToolList>("tools/list", undefined, { allowAuthRetry }),
				"request",
			);
			expect(tools).toEqual({ tools: [{ name: "resumed", inputSchema: { type: "object" } }] });
			// One POST only: replaying it after the server accepted the request
			// could double-execute a state-changing tool.
			expect(observed.posts).toBe(1);
			expect(observed.gets).toBe(2);
			expect(observed.auth).toEqual(["Bearer stale", "Bearer fresh"]);
			expect(observed.lastEventId).toBe("stream-1");
		},
	);

	it("does not replay an accepted POST when resume auth refresh throws", async () => {
		const observed = { posts: 0, gets: 0, authRefreshes: 0 };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					observed.posts++;
					if (observed.posts === 1) {
						return new Response("id: stream-1\nretry: 10\ndata:\n\n", {
							headers: { "Content-Type": "text/event-stream" },
						});
					}
					return Response.json({ jsonrpc: "2.0", id: observed.posts, result: { tools: [] } });
				}
				observed.gets++;
				return new Response("expired", { status: 401 });
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
			headers: { Authorization: "Bearer stale" },
		});
		transport.onAuthError = async () => {
			observed.authRefreshes++;
			if (observed.authRefreshes === 1) {
				throw Object.assign(new Error("refresh failed"), { status: 401 });
			}
			return { Authorization: "Bearer fresh" };
		};
		await transport.connect();

		await expect(withPendingGuard(transport.request<ToolList>("tools/list"), "request")).rejects.toThrow(
			"refresh failed",
		);
		expect(observed.posts).toBe(1);
		expect(observed.gets).toBe(1);
		expect(observed.authRefreshes).toBe(1);
	});

	it("resumes after an abrupt stream drop once an event ID exists", async () => {
		// Bun.serve cannot produce a genuine mid-body transport failure in-process
		// (stream errors surface as clean EOF client-side), so speak raw HTTP: a
		// chunked response without the terminal chunk, closed mid-body, makes the
		// client's body read throw.
		const observed = { posts: 0, lastEventId: null as string | null };
		const sseChunk = (payload: string): string =>
			`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n${payload.length.toString(16)}\r\n${payload}\r\n`;
		const pendingRequests = new WeakMap<object, string>();
		let closePrimingResponse: (() => void) | undefined;
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					const request = `${pendingRequests.get(socket) ?? ""}${new TextDecoder().decode(data)}`;
					const headerEnd = request.indexOf("\r\n\r\n");
					if (headerEnd < 0) {
						pendingRequests.set(socket, request);
						return;
					}
					const headers = request.slice(0, headerEnd);
					const contentLength = Number(/^Content-Length:\s*(\d+)/im.exec(headers)?.[1] ?? 0);
					if (request.length < headerEnd + 4 + contentLength) {
						pendingRequests.set(socket, request);
						return;
					}
					pendingRequests.delete(socket);
					if (headers.startsWith("POST")) {
						observed.posts++;
						closePrimingResponse = () => socket.end();
						socket.write(
							sseChunk('id: stream-1\nretry: 10\ndata: {"jsonrpc":"2.0","method":"notifications/primed"}\n\n'),
						);
						return;
					}
					if (!headers.startsWith("GET")) return;
					observed.lastEventId = /^Last-Event-ID:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? null;
					socket.write(
						`${sseChunk(
							'id: stream-2\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"resumed","inputSchema":{"type":"object"}}]}}\n\n',
						)}0\r\n\r\n`,
					);
					socket.end();
				},
			},
		});
		try {
			const transport = new HttpTransport({
				type: "http",
				url: `http://127.0.0.1:${listener.port}/mcp`,
				timeout: GUARD_TIMEOUT_MS,
			});
			// Disconnect only after the client observes the event ID; a same-packet FIN
			// can make Bun discard the priming event before its SSE parser sees it.
			transport.onNotification = method => {
				if (method !== "notifications/primed") return;
				if (!closePrimingResponse) throw new Error("Priming response was never opened");
				closePrimingResponse();
			};
			await transport.connect();

			const response = await withPendingGuard(transport.request<ToolList>("tools/list"), "request");
			expect(response).toEqual({ tools: [{ name: "resumed", inputSchema: { type: "object" } }] });
			expect(observed.posts).toBe(1);
			expect(observed.lastEventId).toBe("stream-1");
		} finally {
			listener.stop(true);
		}
	});

	it("never replays the POST when a resume GET stays unauthorized", async () => {
		const observed = { posts: 0, gets: 0, refreshes: 0 };
		server = Bun.serve({
			port: 0,
			fetch(req) {
				if (req.method === "POST") {
					observed.posts++;
					return new Response("id: stream-1\nretry: 10\ndata:\n\n", {
						headers: { "Content-Type": "text/event-stream" },
					});
				}
				observed.gets++;
				return new Response("expired", { status: 401 });
			},
		});
		if (!server) throw new Error("Test server was not started");
		const transport = new HttpTransport({
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: GUARD_TIMEOUT_MS,
			headers: { Authorization: "Bearer stale" },
		});
		// A live refresh would tempt #requestWithAuthRetry to re-POST if the
		// SSEResumeError identity were lost during normalization.
		transport.onAuthError = async () => {
			observed.refreshes++;
			return { Authorization: "Bearer fresh" };
		};
		await transport.connect();

		await expect(withPendingGuard(transport.request("tools/call"), "request")).rejects.toBeDefined();
		// The server accepted the POST once; auth refresh happens inside the resume
		// GET only, and the originating POST is never replayed.
		expect(observed.posts).toBe(1);
		expect(observed.gets).toBe(2);
		expect(observed.refreshes).toBe(1);
	});

	it("marks a clean accepted SSE EOF without an event ID as non-replayable", async () => {
		let posts = 0;
		server = Bun.serve({
			port: 0,
			fetch() {
				posts++;
				return new Response("", { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		const transport = await connectedTransport();

		await expect(withPendingGuard(transport.request("tools/call"), "request")).rejects.toMatchObject({
			transport: "http",
			stage: "receive",
			failure: "eof",
			retryable: false,
		});
		expect(posts).toBe(1);
	});
});

describe("MCP Streamable HTTP GET listener resumption", () => {
	it("resumes the long-lived GET stream with Last-Event-ID instead of reconnecting", async () => {
		const observed = { gets: 0, lastEventIds: [] as (string | null)[] };
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				if (req.method !== "GET") {
					return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
				}
				observed.gets++;
				observed.lastEventIds.push(req.headers.get("Last-Event-ID"));
				if (observed.gets === 1) {
					// Polling-style server: deliver one notification with an
					// event ID, then close the physical connection.
					return new Response(
						'id: poll-1\nretry: 10\ndata: {"jsonrpc":"2.0","method":"notifications/first"}\n\n',
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				const response = new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode('id: poll-2\ndata: {"jsonrpc":"2.0","method":"notifications/second"}\n\n'),
							);
							// Held open: the logical stream continues.
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
				return response;
			},
		});
		// This is a resumption test, not a deadline test. The 50ms request
		// fixture above gives the optional GET only 12ms to connect, so a busy
		// runner can abort it before any stream exists to resume.
		const transport = await connectedTransport(0);
		const notifications: string[] = [];
		let closed = false;
		const secondNotification = Promise.withResolvers<void>();
		transport.onNotification = method => {
			notifications.push(method);
			if (notifications.length === 2) secondNotification.resolve();
		};
		transport.onError = error => secondNotification.reject(error);
		transport.onClose = () => {
			closed = true;
			secondNotification.reject(new Error("Logical SSE listener closed before the resumed notification"));
		};

		try {
			await transport.startSSEListener();
			await withPendingGuard(secondNotification.promise, "resumed notification");

			expect(notifications).toEqual(["notifications/first", "notifications/second"]);
			expect(observed.lastEventIds).toEqual([null, "poll-1"]);
			// The resume replaced the manager-level reconnect: no close fired.
			expect(closed).toBe(false);
		} finally {
			await transport.close();
		}
	});
});
