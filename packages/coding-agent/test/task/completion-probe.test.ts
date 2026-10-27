import { describe, expect, it, vi } from "bun:test";
import { setInteractiveHost } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import type { AgentSession } from "../../src/session/agent-session";
import type { EphemeralTurnResult } from "../../src/session/agent-session-types";
import { SessionManager } from "../../src/session/session-manager";
import { isCompletionProbeEnabled, startCompletionProbe } from "../../src/task/completion-probe";

async function advance(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function probeSession(runEphemeralTurn: AgentSession["runEphemeralTurn"]): AgentSession {
	return {
		isStreaming: true,
		agent: { state: {} },
		sessionManager: SessionManager.inMemory("/test"),
		runEphemeralTurn,
	} as unknown as AgentSession;
}

describe("subagent completion probing", () => {
	it("requires an interactive UI parent and excludes nested and disabled runs", () => {
		const previous = setInteractiveHost(true);
		try {
			const enabled = Settings.isolated({ "task.completionProbe": true });
			expect(isCompletionProbeEnabled(enabled, 0, true)).toBe(true);
			expect(isCompletionProbeEnabled(enabled, 0, false)).toBe(false);
			expect(isCompletionProbeEnabled(enabled, 1, true)).toBe(false);
			expect(isCompletionProbeEnabled(Settings.isolated({ "task.completionProbe": false }), 0, true)).toBe(false);
			setInteractiveHost(false);
			expect(isCompletionProbeEnabled(enabled, 0, true)).toBe(false);
		} finally {
			setInteractiveHost(previous);
		}
	});

	it("backs off successive estimates and repeats the hourly delay until cancelled", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const estimates: number[] = [];
		let turn = 0;
		const session = probeSession(
			async () =>
				({
					replyText: `${++turn * 10}%`,
					assistantMessage: { usage: { cost: { total: 0.02 } } },
				}) as EphemeralTurnResult,
		);
		try {
			startCompletionProbe({
				session: () => session,
				signal: controller.signal,
				onEstimate: estimate => estimates.push(estimate.percent),
			});
			for (const minutes of [2, 5, 10, 30, 60, 60]) {
				const before = estimates.length;
				await advance(minutes * 60_000 - 1);
				expect(estimates.length).toBe(before);
				await advance(1);
				expect(estimates).toEqual(Array.from({ length: before + 1 }, (_, i) => (i + 1) * 10));
			}
			controller.abort();
			await advance(60 * 60_000);
			expect(estimates).toEqual([10, 20, 30, 40, 50, 60]);
		} finally {
			controller.abort();
			vi.useRealTimers();
		}
	});

	it("does not overlap probes or publish an in-flight reply after cancellation", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const reply = Promise.withResolvers<EphemeralTurnResult>();
		let requests = 0;
		const estimates: number[] = [];
		const session = probeSession(async () => {
			requests++;
			return reply.promise;
		});
		try {
			startCompletionProbe({
				session: () => session,
				signal: controller.signal,
				onEstimate: estimate => estimates.push(estimate.percent),
			});
			await advance(2 * 60_000);
			await advance(60 * 60_000);
			expect(requests).toBe(1);
			controller.abort();
			reply.resolve({ replyText: "80%", assistantMessage: {} } as EphemeralTurnResult);
			await advance(60 * 60_000);
			expect(estimates).toEqual([]);
			expect(requests).toBe(1);
		} finally {
			controller.abort();
			vi.useRealTimers();
		}
	});
});
