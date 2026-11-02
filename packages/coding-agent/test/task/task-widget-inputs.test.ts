import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { TextTap } from "@oh-my-pi/pi-coding-agent/job-widgets/text-tap";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SpawnRun } from "@oh-my-pi/pi-coding-agent/task/spawn-run";
import { appendToolResult, createTaskWidgetInputs } from "@oh-my-pi/pi-coding-agent/task/widget-inputs";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

let manager: AsyncJobManager;
const agentId = "Bencher";

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	manager = new AsyncJobManager({ onJobComplete: () => {} });
});

afterEach(async () => {
	await manager.dispose({ timeoutMs: 1_000 });
	AgentRegistry.resetGlobalForTests();
});

function fixture() {
	const owner = AgentRegistry.global().register({
		id: agentId,
		displayName: agentId,
		kind: "sub",
		session: null,
		status: "parked",
	});
	const tools = new TextTap("tools", "finished calls");
	const progress: AgentProgress = {
		id: agentId,
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Measure throughput",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
	const inputs = createTaskWidgetInputs({
		manager,
		agentId,
		owner: () => owner,
		tools: () => tools,
		progress,
		intent: "compare decoders",
	});
	return { owner, tools, progress, inputs };
}

function child(id: string, sources: () => TextTap[]) {
	return manager.register("bash", id, async () => "done", {
		id,
		ownerId: agentId,
		widgetInputs: { sources, brief: () => ({ kind: "bash", command: "benchmark" }) },
	});
}

describe("task widget source lifetime", () => {
	it("retires replaced and removed sources without mixing their offset histories", () => {
		const { inputs } = fixture();
		const original = new TextTap("out", "old");
		original.append("OLD tok_s=186\n");
		let offered = [original];
		child("bench_1", () => offered);
		const first = inputs.sources()[1]!;
		expect(first.id).toBe("bench_1:out");
		expect(first.read(0).text).toContain("OLD tok_s=186");
		expect(inputs.sources()[1]).toBe(first);
		const replacement = new TextTap("out", "new");
		replacement.append("NEW tok_s=210\n");
		offered = [replacement];
		const second = inputs.sources()[1]!;
		expect(second).not.toBe(first);
		expect(first.read(0)).toEqual({ start: 0, end: 0, text: "", open: false });
		expect(second.read(0).text).toBe("NEW tok_s=210\n");
		offered = [];
		expect(inputs.sources().map(source => source.id)).toEqual(["tools"]);
		expect(second.read(0).open).toBe(false);
		expect(second.read(0).text).toBe("");
	});

	it("excludes prior-run jobs and refuses a successor generation with the same id", () => {
		const old = new TextTap("out", "historical");
		old.append("private old-run output");
		child("old", () => [old]);
		const { inputs } = fixture();
		const live = new TextTap("out", "current");
		live.append("current output");
		child("current", () => [live]);
		const currentSource = inputs.sources()[1]!;
		expect(inputs.sources().map(source => source.id)).toEqual(["tools", "current:out"]);
		AgentRegistry.global().register({
			id: agentId,
			displayName: agentId,
			kind: "sub",
			session: null,
			status: "parked",
		});
		child("successor", () => [new TextTap("out", "successor")]);
		expect(inputs.sources()).toEqual([]);
		expect(currentSource.read(0).text).toBe("");
		expect(currentSource.read(0).open).toBe(false);
	});

	it("bounds nested sources and retires sources displaced by a changed offered set", () => {
		const { inputs } = fixture();
		let offered = Array.from({ length: 90 }, (_, index) => new TextTap(`pipe:${index}`, "pipe"));
		child("pipeline", () => offered);
		const first = inputs.sources();
		expect(first).toHaveLength(64);
		const retired = first[1]!;
		offered = offered.slice(70);
		const next = inputs.sources();
		expect(next).toHaveLength(21);
		expect(next[1]!.id).toBe("pipeline:pipe:70");
		expect(retired.read(0).open).toBe(false);
	});

	it("keeps a bounded result tail and publishes live stage/watch without changing job authority", () => {
		const { inputs, tools, progress, owner } = fixture();
		appendToolResult(tools, { tool: "bash", text: `${"old".repeat(30_000)}BENCH tok_s=210`, isError: false });
		const tail = inputs.sources()[0]!.read(0);
		expect(tail.text).toContain("BENCH tok_s=210");
		expect(tail.text.length).toBeLessThan(65 * 1024);
		progress.stage = "measuring throughput";
		progress.watch = "tok_s, higher is better";
		expect(inputs.brief()).toMatchObject({
			stage: progress.stage,
			watch: progress.watch,
			intent: "compare decoders",
		});
		expect(owner.status).toBe("parked");
		tools.close();
		expect(inputs.sources()[0]!.read(tail.end)).toMatchObject({ text: "", open: false });
	});

	it.each([false, true])("closes a run source and releases its permit on settlement (failure=%s)", async failure => {
		let permits = 0;
		const gate = Promise.withResolvers<void>();
		const run = new SpawnRun(
			{
				acquire: async () => {
					permits++;
				},
				release: () => {
					permits--;
				},
			},
			async body => {
				body.tools.append("BENCH tok_s=210\n");
				await gate.promise;
				if (failure) throw new Error("benchmark failed");
				return {
					content: [{ type: "text", text: "done" }],
					details: { results: [], totalDurationMs: 1, projectAgentsDir: null } as TaskToolDetails,
				};
			},
		);
		await run.started;
		expect(permits).toBe(1);
		expect(run.tools.read(0).open).toBe(true);
		gate.resolve();
		if (failure) await expect(run.result).rejects.toThrow("benchmark failed");
		else await run.result;
		expect(permits).toBe(0);
		expect(run.tools.read(0)).toMatchObject({ text: "BENCH tok_s=210\n", open: false });
	});
});
