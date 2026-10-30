/**
 * Settled waits expose only current-turn agent payloads and retain job-generation ownership.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AsyncJobRunResult } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { buildJobResult } from "@oh-my-pi/pi-coding-agent/async/job-control";

const SELF_ID = "Main";

function makeSession(manager: AsyncJobManager): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "launch.enabled") return false;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	};
	// Structurally-partial test session: snapshot rendering only touches these fields.
	return stub as unknown as ToolSession;
}

/** Register a job that immediately settles with the given text + structured payload. */
function registerSettledJob(
	manager: AsyncJobManager,
	label: string,
	text: string,
	structured: StructuredSubagentOutput,
	agentId?: string,
): string {
	return manager.register("task", label, async () => ({ text, structured }), { ownerId: SELF_ID, agentId });
}

describe("wait structured output rendering", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a schema-valid result advertises the agent:// pointer instead of inlining JSON", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"ValidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true, count: 7 } },
			"ValidJob",
		);
		await manager.getJob(jobId)!.promise;

		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema valid");
		expect(text).toContain("full payload at agent://ValidJob");
		expect(text).toContain("fields via agent://ValidJob/<field>");
		// The truncated inline JSON block must not appear for a valid result.
		expect(text).not.toContain("```json");
	});

	test("a schema-invalid result keeps the truncated JSON preview alongside the pointer", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"InvalidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "invalid", data: { wrong: "shape" }, error: "missing field" },
			"InvalidJob",
		);
		await manager.getJob(jobId)!.promise;

		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema invalid: missing field");
		expect(text).toContain("full payload at agent://InvalidJob");
		expect(text).toContain("```json");
		expect(text).toContain('"wrong": "shape"');
	});

	test("a run that failed before yielding reports the provider error, not a schema verdict", async () => {
		// Production 2026-09-21: the delivery read `Structured output: schema
		// invalid: Anthropic stream envelope error: ...` with the half-streamed
		// prose as a JSON preview. No payload existed to judge.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const error = "Anthropic stream envelope error: stream ended before message_stop";
		const jobId = registerSettledJob(
			manager,
			"DeadStream",
			'<task-result status="failed (exit 1)">partial</task-result>',
			{ source: "agent", mode: "permissive", status: "unavailable", error },
			"DeadStream",
		);
		await manager.getJob(jobId)!.promise;

		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`Structured output: unavailable: ${error}`);
		expect(text).not.toContain("schema invalid");
		expect(text).not.toContain("schema unavailable");
		expect(text).not.toContain("full payload at");
		expect(text).not.toContain("```json");
	});

	test("advertises the disambiguated agentId, not the collision-suffixed job id", async () => {
		// A task job can reuse a vibe turn's job id, forcing the manager to
		// suffix `jobId` (e.g. `Foo` -> `Foo-2`) while the task's artifacts
		// are still written under its own agent id.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise: hangs } = Promise.withResolvers<AsyncJobRunResult>();
		manager.register("task", "collider", async () => hangs, { ownerId: SELF_ID, id: "Foo" });
		const jobId = registerSettledJob(
			manager,
			"Foo",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			"Foo",
		);
		expect(jobId).not.toBe("Foo");
		await manager.getJob(jobId)!.promise;
		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`full payload at agent://Foo,`);
	});

	test("a woken agent's suffixed turn job names the agent's agent:// and history:// handles", async () => {
		// Messaging a finished agent starts a new turn job; while the first
		// turn's job is retained, the manager suffixes the new one (`Quick-2`).
		// `agent://Quick-2` and `history://Quick-2` do not resolve, so the
		// completed block must name the agent's own id.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const first = manager.register("task", "Quick", async () => ({ text: "DONE1" }), {
			ownerId: SELF_ID,
			id: "Quick",
			agentId: "Quick",
		});
		await manager.getJob(first)!.promise;
		const jobId = manager.register("task", "Quick", async () => ({ text: "DONE2" }), {
			ownerId: SELF_ID,
			id: "Quick",
			agentId: "Quick",
		});
		expect(jobId).toBe("Quick-2");
		await manager.getJob(jobId)!.promise;
		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("### Quick-2 [task]");
		expect(text).toContain("Agent: agent://Quick, history://Quick");
		expect(text).not.toContain("agent://Quick-2");
	});

	test("a failed or cancelled turn job names only the agent's history:// handle", async () => {
		// A follow-up turn that fails without yielding leaves `Quick.md` holding
		// the previous turn's output, and a cancelled /tan clone is unregistered
		// with none, so `agent://` would answer with another turn's output or
		// not at all; only the transcript is this turn's record.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const first = manager.register("task", "Quick", async () => ({ text: "DONE1" }), {
			ownerId: SELF_ID,
			id: "Quick",
			agentId: "Quick",
		});
		await manager.getJob(first)!.promise;
		const failedId = manager.register(
			"task",
			"Quick",
			async () => {
				throw new Error("provider error");
			},
			{ ownerId: SELF_ID, id: "Quick", agentId: "Quick" },
		);
		expect(failedId).toBe("Quick-2");
		await manager.getJob(failedId)!.promise;
		const cancelledId = manager.register(
			"task",
			"/tan work",
			({ signal }) => {
				const { promise, reject } = Promise.withResolvers<string>();
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				return promise;
			},
			{ ownerId: SELF_ID, agentId: "Tan-1" },
		);
		expect(manager.cancel(cancelledId)).toBe(true);
		await manager.getJob(cancelledId)!.promise;
		const jobs = [manager.getJob(failedId)!, manager.getJob(cancelledId)!];
		expect(jobs.map(job => job.status)).toEqual(["failed", "cancelled"]);
		const result = buildJobResult(makeSession(manager), manager, "wait", jobs, []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Agent: history://Quick");
		expect(text).toContain("Agent: history://Tan-1");
		expect(text).not.toContain("agent://Quick");
		expect(text).not.toContain("agent://Tan-1");
	});

	test("a completed turn that published no output names only the agent's history:// handle", async () => {
		// A woken agent that neither yields nor reports a message result ends
		// its turn completed, but `finalizeRunResult` writes no new `Quick.md`,
		// so `agent://Quick` still holds the previous turn's output.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const first = manager.register("task", "Quick", async () => ({ text: "DONE1" }), {
			ownerId: SELF_ID,
			id: "Quick",
			agentId: "Quick",
		});
		await manager.getJob(first)!.promise;
		const jobId = manager.register(
			"task",
			"Quick",
			async () => ({ text: "chatted, no yield", agentOutputPublished: false }),
			{ ownerId: SELF_ID, id: "Quick", agentId: "Quick" },
		);
		expect(jobId).toBe("Quick-2");
		await manager.getJob(jobId)!.promise;
		expect(manager.getJob(jobId)!.status).toBe("completed");
		const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Agent: history://Quick");
		expect(text).not.toContain("agent://Quick");
	});

	test.each(["Quick", "Quick-2"])("unpublished structured job %s never points to a prior turn's payload", async id => {
		const manager = new AsyncJobManager({});
		try {
			const jobId = manager.publishCompleted(
				"task",
				"unpublished",
				{
					text: "current turn could not publish",
					agentOutputPublished: false,
					structured: { source: "agent", mode: "strict", status: "valid", data: { current: true } },
				},
				{ id, agentId: "Quick", ownerId: SELF_ID },
			);
			const result = buildJobResult(makeSession(manager), manager, "wait", [manager.getJob(jobId)!], []);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("history://Quick");
			expect(text).not.toContain("agent://Quick");
			expect(result.details?.jobs?.[0]?.agentOutputPublished).toBe(false);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	test("does not recover or consume a replacement job through a stale snapshot", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<AsyncJobRunResult>();
		try {
			const jobId = manager.register("task", "current owner", async () => pending.promise, {
				ownerId: SELF_ID,
				agentId: "CurrentAgent",
			});
			const current = manager.getJob(jobId)!;
			const stale = {
				...current,
				status: "completed" as const,
				agentId: "PriorAgent",
				resultText: "old generation report",
				structured: { source: "agent", mode: "strict", status: "valid", data: { old: true } } as const,
			};
			const result = buildJobResult(makeSession(manager), manager, "wait", [stale], []);
			expect(result.details?.jobs).toMatchObject([
				{ resultText: "old generation report", structured: { data: { old: true } } },
			]);
			expect(manager.isJobResultConsumed(jobId)).toBe(false);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("agent://PriorAgent");
			expect(text).not.toContain("agent://CurrentAgent");
			pending.resolve({ text: "new generation report" });
			await current.promise;
			const recovered = buildJobResult(makeSession(manager), manager, "wait", [current], []);
			expect(recovered.details?.jobs).toMatchObject([{ resultText: "new generation report" }]);
			expect(manager.isJobResultConsumed(jobId)).toBe(true);
			const repeated = buildJobResult(makeSession(manager), manager, "wait", [current], []);
			expect(repeated.details?.jobs?.[0]?.resultText).toBeUndefined();
			expect(repeated.details?.jobs?.[0]?.structured).toBeUndefined();
		} finally {
			pending.resolve({ text: "new generation report" });
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
});
