import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool, AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const batch = {
	context: "shared context",
	tasks: [
		{ name: "Alpha", agent: "task", task: "Do A." },
		{ name: "Beta", agent: "task", task: "Do B." },
	],
};
const partialJson = '{"context":"shared context","tasks":[{"name":"Alpha","agent":"task","task":"Do A."},';
const toolCall: AgentToolCall = { type: "toolCall", id: "streamed-batch", name: "task", arguments: {} };
const sink: SpeculativeOperationSink = {
	maxInFlight: 2,
	admit: async () => undefined,
	authorizeLaunch: async () => ({ allowed: true }),
	close: () => {},
};

function createSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("task batch dispatch boundary", () => {
	const managers: AsyncJobManager[] = [];
	const launched: string[] = [];
	const assignments: string[] = [];
	let allStarted: PromiseWithResolvers<void>;
	let firstStarted: PromiseWithResolvers<void>;
	const releases = new Map<string, PromiseWithResolvers<void>>();

	beforeEach(() => {
		allStarted = Promise.withResolvers<void>();
		firstStarted = Promise.withResolvers<void>();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			launched.push(id);
			firstStarted.resolve();
			assignments.push(options.assignment ?? "");
			if (launched.length === 2) allStarted.resolve();
			const release = Promise.withResolvers<void>();
			releases.set(id, release);
			options.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return makeResult(id);
		});
	});

	afterEach(async () => {
		for (const release of releases.values()) release.resolve();
		releases.clear();
		launched.length = 0;
		assignments.length = 0;
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("rejects the removed early-launch opt-in instead of silently ignoring it", () => {
		expect(() => Settings.isolated({ "task.speculativeLaunch": true })).toThrow(
			'Unknown setting "task.speculativeLaunch"',
		);
	});

	it("does not start writable runs for streamed, aborted, or invalid final calls", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession(manager));

		const stream = await (tool as AgentTool).speculation?.stream?.open({
			coordinator: sink,
			parentToolCallId: toolCall.id,
		});
		expect(stream).toBeUndefined();
		await stream?.update(toolCall, partialJson);
		if (stream) await firstStarted.promise;

		const invalid = {
			context: batch.context,
			tasks: [batch.tasks[0], { name: "alpha", agent: "task", task: "Duplicate name." }],
		};
		await stream?.discard("aborted before dispatch");
		const result = await tool.execute("invalid-batch", invalid);
		expect(textOf(result)).toContain("Duplicate task name");
		expect(launched).toEqual([]);
		expect(manager.getJob("Alpha")).toBeUndefined();
		const failedPreflight = {
			...batch,
			tasks: [batch.tasks[0], { ...batch.tasks[1], agent: "missing-agent" }],
		};
		const preflightResult = await tool.execute("invalid-preflight", failedPreflight);
		expect(textOf(preflightResult)).toContain('Unknown agent "missing-agent"');
		expect(launched).toEqual([]);
		expect(manager.getJob("Alpha")).toBeUndefined();
	});

	it("executes only the validated final arguments and starts each child once", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession(manager));
		const revised = {
			...batch,
			tasks: [{ ...batch.tasks[0], task: "Revised assignment." }, batch.tasks[1]],
		};
		const stream = await (tool as AgentTool).speculation?.stream?.open({
			coordinator: sink,
			parentToolCallId: toolCall.id,
		});
		await stream?.update(toolCall, partialJson);
		if (stream) await firstStarted.promise;
		await stream?.finalize({ toolCall, args: revised });
		const result = await tool.execute("valid-batch", revised);
		await allStarted.promise;
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(Object.fromEntries(launched.map((id, index) => [id, assignments[index]]))).toEqual({
			Alpha: "Revised assignment.",
			Beta: "Do B.",
		});
		expect(executorModule.runSubprocess).toHaveBeenCalledTimes(2);
		releases.get("Alpha")!.resolve();
		releases.get("Beta")!.resolve();
		await Promise.all([manager.getJob("Alpha")!.promise, manager.getJob("Beta")!.promise]);
	});
});
