import { afterEach, describe, expect, test, vi } from "bun:test";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

type Command = { id: string; type: string; sdpOffer?: string };

function harness() {
	const encoder = new TextEncoder();
	const exited = Promise.withResolvers<number>();
	const commands: Command[] = [];
	let output!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	const eof = () => {
		if (!closed) {
			closed = true;
			output.close();
		}
		exited.resolve(0);
	};
	const proc: RpcAgentProcess = {
		stdin: {
			write(data) {
				commands.push(JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)));
				return 0;
			},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				output = controller;
				controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready" })}\n`));
			},
		}),
		peekStderr: () => "synthetic RPC process",
		kill: eof,
		exited: exited.promise,
	};
	return {
		client: new RpcClient({ spawn: () => proc }),
		commands,
		eof,
		respond(command: Command, outcome: { data?: unknown; error?: string } = {}) {
			output.enqueue(
				encoder.encode(
					`${JSON.stringify({
						type: "response",
						id: command.id,
						command: command.type,
						success: outcome.error === undefined,
						...outcome,
					})}\n`,
				),
			);
		},
	};
}

afterEach(() => vi.useRealTimers());

describe("RpcClient live_connect completion", () => {
	test("accepts the exact SDP answer after 80 seconds without replaying signaling", async () => {
		vi.useFakeTimers();
		const h = harness();
		try {
			await h.client.start();
			let settled = false;
			const observed = h.client.liveConnect("v=0 synthetic offer").then(
				value => {
					settled = true;
					return value;
				},
				error => {
					settled = true;
					return error;
				},
			);
			vi.advanceTimersByTime(80_000);
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(settled).toBe(false);
			expect(h.commands.map(command => command.type)).toEqual(["live_connect"]);
			const answer = { voice: "sol", sdpAnswer: "v=0\r\nsynthetic answer\r\n" };
			h.respond(h.commands[0]!, { data: answer });
			expect(await observed).toEqual(answer);
			expect(h.commands.map(command => command.type)).toEqual(["live_connect"]);
		} finally {
			await h.client.stop();
		}
	});

	test("allows liveStop during startup and preserves the terminal server failure", async () => {
		vi.useFakeTimers();
		const h = harness();
		try {
			await h.client.start();
			const observed = h.client.liveConnect("v=0 pending offer").catch(error => error);
			const stopped = h.client.liveStop();
			expect(h.commands.map(command => command.type)).toEqual(["live_connect", "live_stop"]);
			h.respond(h.commands[1]!);
			await stopped;
			vi.advanceTimersByTime(80_000);
			h.respond(h.commands[0]!, { error: "Synthetic startup retired" });
			expect((await observed).message).toBe("Synthetic startup retired");
			expect(h.commands.map(command => command.type)).toEqual(["live_connect", "live_stop"]);
		} finally {
			await h.client.stop();
		}
	});

	test.each(["stop", "eof"] as const)("settles a pending SDP operation on %s", async ending => {
		vi.useFakeTimers();
		const h = harness();
		try {
			await h.client.start();
			const observed = h.client.liveConnect("v=0 pending offer").catch(error => error);
			if (ending === "stop") await h.client.stop();
			else h.eof();
			const error = await observed;
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toMatch(ending === "stop" ? /Client stopped/ : /ended|exited/);
			expect(h.commands.map(command => command.type)).toEqual(["live_connect"]);
		} finally {
			await h.client.stop();
		}
	});

	test("retains the ordinary deadline for unrelated commands", async () => {
		vi.useFakeTimers();
		const h = harness();
		try {
			await h.client.start();
			const observed = h.client.getState().catch(error => error);
			vi.advanceTimersByTime(30_000);
			expect((await observed).message).toContain("Timeout waiting for response to get_state");
		} finally {
			await h.client.stop();
		}
	});
});
