import { describe, expect, it } from "bun:test";
import {
	AgentSideConnection,
	type AnyMessage,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	RequestError,
	RpcConnection,
	schema,
} from "../src/acp";

function transportPair() {
	const leftToRight = new TransformStream<Uint8Array, Uint8Array>();
	const rightToLeft = new TransformStream<Uint8Array, Uint8Array>();
	const left = ndJsonStream(leftToRight.writable, rightToLeft.readable);
	const clientMessages: AnyMessage[] = [];
	return {
		left: {
			readable: left.readable,
			writable: new WritableStream<AnyMessage>({
				async write(message) {
					clientMessages.push(message);
					const writer = left.writable.getWriter();
					try {
						await writer.write(message);
					} finally {
						writer.releaseLock();
					}
				},
				close: () => left.writable.close(),
				abort: reason => left.writable.abort(reason),
			}),
		},
		right: ndJsonStream(rightToLeft.writable, leftToRight.readable),
		clientMessages,
	};
}

describe("ACP JSON-RPC transport", () => {
	it("round-trips requests, notifications, and errors", async () => {
		const pair = transportPair();
		const updates: unknown[] = [];
		const updateReceived = Promise.withResolvers<void>();
		const client: Client = {
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			sessionUpdate: async update => {
				updates.push(update);
				updateReceived.resolve();
			},
		};
		const clientConnection = new ClientSideConnection(() => client, pair.left);
		const agentConnection = new AgentSideConnection(
			connection => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: async () => ({ sessionId: "session-1" }),
				prompt: async params => {
					if (params.prompt.length === 0) throw RequestError.invalidParams({ field: "prompt" });
					await connection.requestPermission({
						sessionId: params.sessionId,
						toolCall: { toolCallId: "tool-1" },
						options: [],
					});
					return { stopReason: "end_turn" };
				},
				cancel: async () => {},
			}),
			pair.right,
		);

		await expect(clientConnection.initialize({ protocolVersion: 1, clientCapabilities: {} })).resolves.toEqual({
			protocolVersion: 1,
		});
		await agentConnection.sessionUpdate({ sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } });
		await updateReceived.promise;
		expect(updates).toHaveLength(1);
		await expect(
			clientConnection.prompt({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "nested request" }],
			}),
		).resolves.toEqual({ stopReason: "end_turn" });
		await expect(clientConnection.prompt({ sessionId: "session-1", prompt: [] })).rejects.toMatchObject({
			code: -32602,
			data: { field: "prompt" },
		});
	});

	it("correlates out-of-order responses", async () => {
		const requests = new TransformStream<AnyMessage, AnyMessage>();
		const responses = new TransformStream<AnyMessage, AnyMessage>();
		const connection = new RpcConnection(
			{ writable: requests.writable, readable: responses.readable },
			() => undefined,
		);
		const reader = requests.readable.getReader();
		const writer = responses.writable.getWriter();
		const first = connection.request<string>("first");
		const second = connection.request<string>("second");
		const firstMessage = await reader.read();
		const secondMessage = await reader.read();
		if (firstMessage.done || secondMessage.done || !("id" in firstMessage.value) || !("id" in secondMessage.value))
			throw new Error("Expected requests");
		await writer.write({ jsonrpc: "2.0", id: secondMessage.value.id, result: "two" });
		await writer.write({ jsonrpc: "2.0", id: firstMessage.value.id, result: "one" });
		await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"]);
		reader.releaseLock();
		writer.releaseLock();
	});

	it("decodes split and batched NDJSON frames", async () => {
		const bytes = new TransformStream<Uint8Array, Uint8Array>();
		const output = new TransformStream<Uint8Array, Uint8Array>();
		const stream = ndJsonStream(output.writable, bytes.readable);
		const writer = bytes.writable.getWriter();
		const reader = stream.readable.getReader();
		await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0","method":"a","par'));
		await writer.write(new TextEncoder().encode('ams":{}}\n{"jsonrpc":"2.0","method":"b"}\n'));
		expect(await reader.read()).toMatchObject({ value: { method: "a", params: {} } });
		expect(await reader.read()).toMatchObject({ value: { method: "b" } });
		writer.releaseLock();
		reader.releaseLock();
	});
	it("drains accepted inbound requests before resolving closed on clean EOF", async () => {
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const sessionStarted = Promise.withResolvers<void>();
		const releaseSession = Promise.withResolvers<void>();
		const connection = new RpcConnection(
			{ writable: outbound.writable, readable: inbound.readable },
			async method => {
				if (method === "initialize") return { protocolVersion: 1 };
				if (method === "session/new") {
					sessionStarted.resolve();
					await releaseSession.promise;
					return { sessionId: "session-1" };
				}
				throw RequestError.methodNotFound(method);
			},
		);
		const writer = inbound.writable.getWriter();
		const reader = outbound.readable.getReader();
		await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
		await writer.write({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
		await sessionStarted.promise;
		await writer.close();

		const initialize = await reader.read();
		expect(initialize.done).toBe(false);
		expect(initialize.value).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });

		const closedBeforeDrain = await Promise.race([
			connection.closed.then(() => true),
			new Promise<boolean>(resolve => setTimeout(() => resolve(false), 25)),
		]);
		expect(closedBeforeDrain).toBe(false);

		releaseSession.resolve();
		const created = await reader.read();
		expect(created.done).toBe(false);
		expect(created.value).toEqual({ jsonrpc: "2.0", id: 2, result: { sessionId: "session-1" } });
		await connection.closed;
		reader.releaseLock();
	});

	it("still fail-fast closes on read errors without waiting for inbound handlers", async () => {
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const started = Promise.withResolvers<void>();
		const hold = Promise.withResolvers<void>();
		const connection = new RpcConnection({ writable: outbound.writable, readable: inbound.readable }, async () => {
			started.resolve();
			await hold.promise;
			return {};
		});
		const writer = inbound.writable.getWriter();
		await writer.write({ jsonrpc: "2.0", id: 1, method: "slow" });
		await started.promise;
		await writer.abort(new Error("broken pipe"));
		await connection.closed;
		hold.resolve();
	});

	it("matches the SDK error-code fixtures", () => {
		expect([
			RequestError.parseError().toErrorResponse(),
			RequestError.invalidRequest().toErrorResponse(),
			RequestError.methodNotFound("missing").toErrorResponse(),
			RequestError.invalidParams().toErrorResponse(),
			RequestError.internalError().toErrorResponse(),
			RequestError.requestCancelled().toErrorResponse(),
			RequestError.authRequired().toErrorResponse(),
			RequestError.resourceNotFound("file:///missing").toErrorResponse(),
			RequestError.sessionBusy("Agent is already processing.", { reason: "session_busy" }).toErrorResponse(),
		]).toEqual([
			{ code: -32700, message: "Parse error" },
			{ code: -32600, message: "Invalid request" },
			{ code: -32601, message: '"Method not found": missing', data: { method: "missing" } },
			{ code: -32602, message: "Invalid params" },
			{ code: -32603, message: "Internal error" },
			{ code: -32800, message: "Request cancelled" },
			{ code: -32000, message: "Authentication required" },
			{ code: -32002, message: "Resource not found: file:///missing", data: { uri: "file:///missing" } },
			{ code: -32003, message: "Agent is already processing.", data: { reason: "session_busy" } },
		]);
	});

	it("requestCancellable rejects the pending entry, notifies $/cancel_request, and ignores late responses", async () => {
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const connection = new RpcConnection({ writable: outbound.writable, readable: inbound.readable }, async () => {
			throw RequestError.methodNotFound("unused");
		});
		const reader = outbound.readable.getReader();
		const writer = inbound.writable.getWriter();

		const { promise, cancel } = connection.requestCancellable<{ outcome: unknown }>("session/request_permission", {
			sessionId: "session-1",
		});

		// The request frame goes out with a fresh id.
		const requestFrame = await reader.read();
		expect(requestFrame.value).toMatchObject({ jsonrpc: "2.0", method: "session/request_permission" });
		const requestId = (requestFrame.value as { id: number }).id;

		cancel();

		// The promise rejects as request-cancelled …
		const error = await promise.then(
			() => undefined,
			(rejection: unknown) => rejection,
		);
		expect(error).toBeInstanceOf(RequestError);
		expect((error as RequestError).code).toBe(-32800);

		// … the peer is told via $/cancel_request …
		const cancelFrame = await reader.read();
		expect(cancelFrame.value).toEqual({
			jsonrpc: "2.0",
			method: "$/cancel_request",
			params: { requestId },
		});

		// … and a late response for the dropped entry is ignored rather than
		// rejecting anything or throwing on an unknown id.
		await writer.write({
			jsonrpc: "2.0",
			id: requestId,
			result: { outcome: { outcome: "selected", optionId: "x" } },
		});
		await Bun.sleep(0);
		expect(connection.signal.aborted).toBe(false);

		// A second cancel is a no-op — the entry is already gone.
		cancel();
		await Bun.sleep(0);
		await connection.close();
		reader.releaseLock();
		writer.releaseLock();
	});

	it("requestPermissionWithCancel ends the client's inbound handler via its abort signal", async () => {
		// The receiving half of a cancelled elicit: `cancel()` used to only
		// drop the sender's pending entry and send `$/cancel_request` — the
		// client-side handler (a dialog) never learned about it and held the
		// clean-EOF drain until the 30 s timeout. The handler now receives the
		// request's abort signal, ends on it, and its late response is
		// suppressed on the agent side.
		const pair = transportPair();
		const handlerStarted = Promise.withResolvers<void>();
		const handlerEnded = Promise.withResolvers<void>();
		let handlerSignal: AbortSignal | undefined;
		const client: Client = {
			requestPermission(_params, options) {
				handlerSignal = options?.signal;
				handlerStarted.resolve();
				const gate = Promise.withResolvers<void>();
				if (options?.signal?.aborted) gate.resolve();
				else options?.signal?.addEventListener("abort", () => gate.resolve(), { once: true });
				return gate.promise.then(() => {
					handlerEnded.resolve();
					return { outcome: { outcome: "cancelled" as const } };
				});
			},
			sessionUpdate: async () => {},
		};
		const _clientConnection = new ClientSideConnection(() => client, pair.left);
		const agentConnection = new AgentSideConnection(
			connection => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: async () => ({ sessionId: "session-1" }),
				prompt: async () => {
					void connection;
					return { stopReason: "end_turn" };
				},
				cancel: async () => {},
			}),
			pair.right,
		);

		const { promise, cancel } = agentConnection.requestPermissionWithCancel({
			sessionId: "session-1",
			toolCall: { toolCallId: "tool-1" },
			options: [],
		});
		await handlerStarted.promise;
		expect(handlerSignal).toBeDefined();

		// Agent-side cancellation must reach the handler through its signal…
		cancel();
		await handlerEnded.promise;

		// …and reject the elicit as request-cancelled; the handler's late
		// response for the dropped id is ignored (covered by the sender-side
		// test above), so nothing throws on either side.
		const error = await promise.then(
			() => undefined,
			(rejection: unknown) => rejection,
		);
		expect(error).toBeInstanceOf(RequestError);
		expect((error as RequestError).code).toBe(-32800);
	});

	it("answers a peer $/cancel_request with -32800 on the wire when the dispatcher honors cancellation", async () => {
		// ACP v1 spec: a cancelled inbound request must still receive a
		// response. The transport aborts the handler and writes the
		// `-32800` error itself, so a client that cancels its elicit is
		// never left waiting on a handler that may never settle.
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const handlerAborted = Promise.withResolvers<void>();
		const connection = new RpcConnection(
			{ writable: outbound.writable, readable: inbound.readable },
			async (_method: string, _params: unknown, _notification: boolean, signal?: AbortSignal) => {
				// A handler that parks until its abort signal fires: only the
				// transport's own response can settle the exchange.
				signal?.addEventListener("abort", () => handlerAborted.resolve(), { once: true });
				await handlerAborted.promise;
				return {};
			},
			{ honorsInboundCancellation: method => method === "session/request_permission" },
		);
		const writer = inbound.writable.getWriter();
		const reader = outbound.readable.getReader();
		await writer.write({ jsonrpc: "2.0", id: 41, method: "session/request_permission" });
		await writer.write({
			jsonrpc: "2.0",
			method: "$/cancel_request",
			params: { requestId: 41 },
		});
		const response = (await reader.read()).value as { id: number; error?: { code: number } };
		expect(response.id).toBe(41);
		expect(response.error?.code).toBe(-32800);
		// The handler was aborted by the cancellation, not just answered around.
		await handlerAborted.promise;
		await connection.close();
		writer.releaseLock();
		reader.releaseLock();
	});

	it("keeps an agent request running and answers with its real result after a peer $/cancel_request", async () => {
		// The agent side's handlers never observe a cancel signal (prompts
		// are cancelled through `session/cancel`). Answering `-32800` there
		// would tell the client its prompt was cancelled while the turn kept
		// streaming, and drop the real stop reason.
		const inbound = new TransformStream<AnyMessage, AnyMessage>();
		const outbound = new TransformStream<AnyMessage, AnyMessage>();
		const finishPrompt = Promise.withResolvers<void>();
		const promptStarted = Promise.withResolvers<void>();
		const _agentConnection = new AgentSideConnection(
			() => ({
				initialize: params => ({ protocolVersion: params.protocolVersion }),
				newSession: async () => ({ sessionId: "session-1" }),
				prompt: async () => {
					promptStarted.resolve();
					await finishPrompt.promise;
					return { stopReason: "end_turn" };
				},
				cancel: async () => {},
			}),
			{ writable: outbound.writable, readable: inbound.readable },
		);
		const writer = inbound.writable.getWriter();
		const reader = outbound.readable.getReader();
		await writer.write({
			jsonrpc: "2.0",
			id: 7,
			method: "session/prompt",
			params: { sessionId: "session-1", prompt: [{ type: "text", text: "hi" }] },
		});
		await promptStarted.promise;
		await writer.write({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: 7 } });
		finishPrompt.resolve();
		const response = (await reader.read()).value;
		expect(response).toEqual({ jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } });
		writer.releaseLock();
		reader.releaseLock();
	});

	it("retains real write, terminal, and extension outcomes after unsupported cancellation", async () => {
		const pair = transportPair();
		const release = Promise.withResolvers<void>();
		const allStarted = Promise.withResolvers<void>();
		let started = 0;
		const markStarted = () => {
			if (++started === 3) allStarted.resolve();
		};
		const files = new Map<string, string>();
		const terminals: string[] = [];
		const client = new ClientSideConnection(
			() => ({
				requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
				sessionUpdate: () => {},
				async writeTextFile(params) {
					markStarted();
					await release.promise;
					files.set(params.path, params.content);
				},
				async createTerminal() {
					markStarted();
					await release.promise;
					terminals.push("terminal-1");
					return { terminalId: "terminal-1" };
				},
				async extMethod(method) {
					if (method === "_barrier") return {};
					markStarted();
					await release.promise;
					throw RequestError.invalidParams({ reason: "extension_refused" });
				},
			}),
			pair.left,
		);
		const agent = new RpcConnection(pair.right, () => undefined);
		const completed = Promise.allSettled([
			agent.request("fs/write_text_file", { sessionId: "s", path: "/file", content: "written" }),
			agent.request("terminal/create", { sessionId: "s", command: "held" }),
			agent.request("_extension/action", {}),
		]);
		try {
			await allStarted.promise;
			for (const requestId of [0, 1, 2]) {
				await agent.notify("$/cancel_request", { requestId });
				await agent.notify("$/cancel_request", { requestId });
			}
			await agent.request("_barrier");
			expect(pair.clientMessages.filter(message => "id" in message && message.id !== 3)).toEqual([]);
			expect(files.has("/file")).toBe(false);
			expect(terminals).toEqual([]);

			release.resolve();
			expect(await completed).toMatchObject([
				{ status: "fulfilled", value: {} },
				{ status: "fulfilled", value: { terminalId: "terminal-1" } },
				{ status: "rejected", reason: { code: -32602, data: { reason: "extension_refused" } } },
			]);
			expect(files.get("/file")).toBe("written");
			expect(terminals).toEqual(["terminal-1"]);
			expect(
				pair.clientMessages.filter(message => "id" in message && [0, 1, 2].includes(Number(message.id))),
			).toHaveLength(3);
		} finally {
			release.resolve();
			await agent.notify("_drain");
			await pair.right.writable.close();
			await client.closed;
			await pair.left.writable.close();
			await agent.closed;
		}
	});

	it("answers permission cancellation once and ignores a late allow without affecting the next dialog", async () => {
		const pair = transportPair();
		const started = Promise.withResolvers<AbortSignal | undefined>();
		const lateAllow = Promise.withResolvers<void>();
		const handlerReturned = Promise.withResolvers<void>();
		const client = new ClientSideConnection(
			() => ({
				async requestPermission(params, options) {
					if (params.toolCall.toolCallId === "late") {
						started.resolve(options?.signal);
						await lateAllow.promise;
						handlerReturned.resolve();
					}
					return { outcome: { outcome: "selected", optionId: "allow_once" } };
				},
				sessionUpdate: () => {},
				extMethod: () => ({}),
			}),
			pair.left,
		);
		const agent = new RpcConnection(pair.right, () => undefined);
		const first = agent.request("session/request_permission", {
			sessionId: "s",
			toolCall: { toolCallId: "late" },
			options: [],
		});
		const rejected = first.catch(error => error);
		try {
			const signal = await started.promise;
			await agent.notify("$/cancel_request", { requestId: 0 });
			expect(await rejected).toMatchObject({ code: -32800 });
			expect(signal?.aborted).toBe(true);
			await agent.notify("$/cancel_request", { requestId: 0 });
			lateAllow.resolve();
			await handlerReturned.promise;
			await agent.request("_barrier");
			expect(pair.clientMessages.filter(message => "id" in message && message.id === 0)).toEqual([
				{ jsonrpc: "2.0", id: 0, error: RequestError.requestCancelled({ requestId: 0 }).toErrorResponse() },
			]);
			await expect(
				agent.request("session/request_permission", {
					sessionId: "s",
					toolCall: { toolCallId: "next" },
					options: [],
				}),
			).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
		} finally {
			lateAllow.resolve();
			await agent.notify("_drain");
			await pair.right.writable.close();
			await client.closed;
			await pair.left.writable.close();
			await agent.closed;
		}
	});

	it("aborts a permission signal on hard close and rejects the peer's pending request on disconnect", async () => {
		const pair = transportPair();
		const started = Promise.withResolvers<AbortSignal | undefined>();
		const handlerEnded = Promise.withResolvers<void>();
		const client = new RpcConnection(
			pair.left,
			async (_method, _params, _notification, signal) => {
				started.resolve(signal);
				await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
				handlerEnded.resolve();
				return { outcome: { outcome: "selected", optionId: "allow_once" } };
			},
			{ honorsInboundCancellation: method => method === "session/request_permission" },
		);
		const agent = new RpcConnection(pair.right, () => undefined);
		const pending = agent.request("session/request_permission", {});
		const rejected = pending.catch(error => error);
		const signal = await started.promise;
		client.close(new Error("host disconnected"));
		expect(signal?.aborted).toBe(true);
		await handlerEnded.promise;
		await pair.left.writable.close();
		expect(await rejected).toMatchObject({ message: "Connection closed" });
		await agent.closed;
		await pair.right.writable.close();
		expect(pair.clientMessages).toEqual([]);
	});

	it("aborts permission signals on clean EOF, suppresses late allow, and still drains held writes", async () => {
		const pair = transportPair();
		const permissionStarted = Promise.withResolvers<AbortSignal | undefined>();
		const permissionAborted = Promise.withResolvers<void>();
		const writeStarted = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		let wrote = false;
		const client = new ClientSideConnection(
			() => ({
				async requestPermission(_params, options) {
					permissionStarted.resolve(options?.signal);
					await new Promise<void>(resolve =>
						options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
					permissionAborted.resolve();
					return { outcome: { outcome: "selected", optionId: "allow_once" } };
				},
				sessionUpdate: () => {},
				async writeTextFile() {
					writeStarted.resolve();
					await releaseWrite.promise;
					wrote = true;
				},
			}),
			pair.left,
		);
		const agent = new RpcConnection(pair.right, () => undefined);
		const permission = agent.request("session/request_permission", {
			sessionId: "s",
			toolCall: { toolCallId: "eof" },
			options: [],
		});
		const rejected = permission.catch(error => error);
		const write = agent.request("fs/write_text_file", { sessionId: "s", path: "/file", content: "held" });
		const signal = await permissionStarted.promise;
		await writeStarted.promise;
		await agent.notify("_drain");
		await pair.right.writable.close();
		await permissionAborted.promise;
		expect(signal?.aborted).toBe(true);
		expect(await rejected).toMatchObject({ code: -32800 });
		expect(wrote).toBe(false);
		expect(client.signal.aborted).toBe(false);
		releaseWrite.resolve();
		await expect(write).resolves.toEqual({});
		expect(wrote).toBe(true);
		await client.closed;
		expect(pair.clientMessages.filter(message => "id" in message && message.id === 0)).toEqual([
			{ jsonrpc: "2.0", id: 0, error: RequestError.requestCancelled({ requestId: 0 }).toErrorResponse() },
		]);
		await pair.left.writable.close();
		await agent.closed;
	});
});

describe("ACP runtime schemas", () => {
	it("accepts valid protocol vectors", () => {
		expect(schema.zNewSessionResponse.safeParse({ sessionId: "s" }).success).toBe(true);
		expect(schema.zPromptResponse.safeParse({ stopReason: "end_turn" }).success).toBe(true);
		expect(
			schema.zSessionNotification.safeParse({
				sessionId: "s",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
			}).success,
		).toBe(true);
	});

	it("rejects malformed protocol vectors", () => {
		expect(schema.zNewSessionResponse.safeParse({ sessionId: 4 }).success).toBe(false);
		expect(schema.zPromptResponse.safeParse({ stopReason: "done" }).success).toBe(false);
		expect(
			schema.zSessionNotification.safeParse({
				sessionId: "s",
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text" } },
			}).success,
		).toBe(false);
	});
});
