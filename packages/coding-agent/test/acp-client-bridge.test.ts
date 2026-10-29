import { describe, expect, it } from "bun:test";
import { createAcpClientBridge } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-client-bridge";
import {
	AgentSideConnection,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	RequestError,
	type RequestPermissionResponse,
} from "@oh-my-pi/pi-utils/acp";

const ALLOW_SELECTED: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow_once" } };
const TOOL_CALL = {
	toolCallId: "call-1",
	toolName: "bash",
	title: "echo hi",
	kind: "execute" as const,
	status: "pending" as const,
	rawInput: { command: "echo hi" },
};
const OPTIONS = [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" as const }];

function permissionBridge(requestPermission: Client["requestPermission"]) {
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const clientStream = ndJsonStream(toAgent.writable, toClient.readable);
	const agentStream = ndJsonStream(toClient.writable, toAgent.readable);
	const client = new ClientSideConnection(
		() => ({ requestPermission, sessionUpdate: () => {}, extMethod: () => ({}) }),
		clientStream,
	);
	const connection = new AgentSideConnection(
		() => ({
			initialize: params => ({ protocolVersion: params.protocolVersion }),
			newSession: () => ({ sessionId: "session-1" }),
			prompt: () => ({ stopReason: "end_turn" }),
			cancel: () => {},
		}),
		agentStream,
	);
	return {
		bridge: createAcpClientBridge(connection, "session-1", {}),
		connection,
		async close() {
			await connection.notify("_drain");
			await agentStream.writable.close();
			await client.closed;
			await clientStream.writable.close();
			await connection.closed;
		},
	};
}

describe("ACP client bridge permission requests", () => {
	it.each(["host abort", "admitted steering"] as const)(
		"terminates the wire dialog on %s and rejects its late allow",
		async source => {
			const started = Promise.withResolvers<AbortSignal | undefined>();
			const lateAllow = Promise.withResolvers<void>();
			const fixture = permissionBridge(async (params, options) => {
				if (params.toolCall.toolCallId === "call-1") {
					started.resolve(options?.signal);
					await lateAllow.promise;
				}
				return ALLOW_SELECTED;
			});
			try {
				const abort = new AbortController();
				const pending = fixture.bridge.requestPermission!(
					TOOL_CALL,
					OPTIONS,
					source === "host abort" ? abort.signal : undefined,
					source === "admitted steering" ? abort.signal : undefined,
				);
				const handlerSignal = await started.promise;
				abort.abort();
				await fixture.connection.request("_barrier");
				expect(handlerSignal?.aborted).toBe(true);
				lateAllow.resolve();
				await expect(pending).resolves.toEqual({ outcome: "cancelled" });
				await expect(
					fixture.bridge.requestPermission!({ ...TOOL_CALL, toolCallId: "next" }, OPTIONS),
				).resolves.toEqual({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
			} finally {
				lateAllow.resolve();
				await fixture.close();
			}
		},
	);

	it.each(["host abort", "admitted steering"] as const)(
		"does not open a permission dialog after pre-admitted %s",
		async source => {
			const opened: string[] = [];
			const fixture = permissionBridge(params => {
				opened.push(params.toolCall.toolCallId);
				return ALLOW_SELECTED;
			});
			try {
				const abort = new AbortController();
				abort.abort();
				await expect(
					fixture.bridge.requestPermission!(
						TOOL_CALL,
						OPTIONS,
						source === "host abort" ? abort.signal : undefined,
						source === "admitted steering" ? abort.signal : undefined,
					),
				).resolves.toEqual({ outcome: "cancelled" });
				await expect(
					fixture.bridge.requestPermission!({ ...TOOL_CALL, toolCallId: "next" }, OPTIONS),
				).resolves.toEqual({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
				expect(opened).toEqual(["next"]);
			} finally {
				await fixture.close();
			}
		},
	);

	it("does not grant permission when host abort races an allow response", async () => {
		const started = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<RequestPermissionResponse>();
		const fixture = permissionBridge(() => {
			started.resolve();
			return answer.promise;
		});
		try {
			const abort = new AbortController();
			const pending = fixture.bridge.requestPermission!(TOOL_CALL, OPTIONS, abort.signal);
			await started.promise;
			answer.resolve(ALLOW_SELECTED);
			abort.abort();
			await expect(pending).resolves.toEqual({ outcome: "cancelled" });
		} finally {
			answer.resolve(ALLOW_SELECTED);
			await fixture.close();
		}
	});

	it("preserves an ordinary permission answer when cancellation signals remain live", async () => {
		const fixture = permissionBridge(() => ALLOW_SELECTED);
		try {
			await expect(
				fixture.bridge.requestPermission!(
					TOOL_CALL,
					OPTIONS,
					new AbortController().signal,
					new AbortController().signal,
				),
			).resolves.toEqual({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
		} finally {
			await fixture.close();
		}
	});

	it("treats a peer cancellation response as cancellation, never as permission", async () => {
		const fixture = permissionBridge(() => {
			throw RequestError.requestCancelled();
		});
		try {
			await expect(fixture.bridge.requestPermission!(TOOL_CALL, OPTIONS)).resolves.toEqual({ outcome: "cancelled" });
		} finally {
			await fixture.close();
		}
	});

	it("preserves non-cancellation protocol failures", async () => {
		const fixture = permissionBridge(() => {
			throw RequestError.internalError({ reason: "dialog_unavailable" });
		});
		try {
			await expect(fixture.bridge.requestPermission!(TOOL_CALL, OPTIONS)).rejects.toMatchObject({
				code: -32603,
				data: { reason: "dialog_unavailable" },
			});
		} finally {
			await fixture.close();
		}
	});
});
