import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const contextFiles = [
	{ path: "/profile/AGENTS.md", content: "Global baseline." },
	{ path: "/repo/AGENTS.md", content: "Repository override.", depth: 1 },
	{ path: "/repo/pkg/.claude/CLAUDE.md", content: "Package override.", depth: 0 },
];

function createResult(): SingleResult {
	return {
		index: 0,
		id: "ContextTask",
		agent: "task",
		agentSource: "bundled",
		task: "Review configuration",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	};
}

function createSession(batch: boolean): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": batch,
		"task.isolation.enabled": false,
	});
	return {
		cwd: "/tmp",
		settings,
		contextFiles,
		hasUI: false,
		enableLsp: false,
		suppressSpawnAdvisory: true,
		getSessionSpawns: () => "*",
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getSessionId: () => "parent-session",
	} as unknown as ToolSession;
}

describe("TaskTool context inheritance", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("inherits the ordered global baseline and local overrides by default", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());
		const tool = await TaskTool.create(createSession(false));

		await tool.execute("tool-call", {
			agent: "task",
			name: "ContextTask",
			task: "Review configuration",
		});

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		expect(runSubprocessSpy.mock.calls[0]?.[0].contextFiles).toBe(contextFiles);
	});

	it("lets the orchestrator choose inherited or context-agnostic agents per batch item", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(createResult());
		const tool = await TaskTool.create(createSession(true));

		await tool.execute("tool-call", {
			agent: "task",
			context: "Shared batch context.",
			tasks: [
				{ name: "Inherited", task: "Use project conventions", contextFilePolicy: "inherit" },
				{ name: "Fresh", task: "Start fresh", contextFilePolicy: "none" },
			],
		});

		expect(runSubprocessSpy).toHaveBeenCalledTimes(2);
		const contextsByAssignment = new Map(
			runSubprocessSpy.mock.calls.map(([options]) => [options.assignment, options.contextFiles]),
		);
		expect(contextsByAssignment.get("Use project conventions")).toBe(contextFiles);
		expect(contextsByAssignment.get("Start fresh")).toEqual([]);
	});
});
