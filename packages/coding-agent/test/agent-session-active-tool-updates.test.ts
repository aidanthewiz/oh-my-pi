/**
 * Focus rebuilds replay `AgentSession.activeToolExecutionUpdates()` to restore a
 * live task board (#10446). Blocking results supersede snapshots; returned
 * running results retain them for background replay, including frames that
 * settle before the initial running result returns. Mixed blocking+async calls
 * can report a settled subset while blocking work continues. Logical session
 * transitions must clear every snapshot.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function taskUpdate(state: "running" | "completed" | "failed", toolCallId = "task-1"): AgentEvent {
	return {
		type: "tool_execution_update",
		toolCallId,
		toolName: "task",
		args: {},
		partialResult: {
			content: [{ type: "text", text: `Task ${state}` }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 5,
				progress: [],
				async: { state, jobId: "job-1", type: "task" },
			},
		},
	} satisfies AgentEvent;
}

function taskEnd(state: "running" | "completed" | "failed", toolCallId = "task-1"): AgentEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "task",
		result: {
			content: [{ type: "text", text: `Task ${state}` }],
			details: { async: { state, jobId: "job-1", type: "task" } },
		},
	} satisfies AgentEvent;
}

describe("AgentSession.activeToolExecutionUpdates cache lifecycle", () => {
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) await authStorage.close();
	});

	async function makeSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
	}

	it("retains a settled async subset until its mixed task call ends", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskUpdate("running"));
		session.agent.emitExternalEvent(taskUpdate("completed"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["task-1"]);

		session.agent.emitExternalEvent(taskEnd("completed"));
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);
	});

	it("retains a terminal background snapshot after the original task call returned", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskEnd("running"));
		session.agent.emitExternalEvent(taskUpdate("completed"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["task-1"]);
	});

	it("retains an early terminal job frame when its initial running result arrives afterward", async () => {
		session = await makeSession();
		session.agent.emitExternalEvent({
			type: "tool_execution_update",
			toolCallId: "early-bash",
			toolName: "bash",
			args: { command: "exit 7" },
			partialResult: {
				content: [{ type: "text", text: "final stdout" }],
				details: { exitCode: 7, async: { state: "failed", jobId: "job-early", type: "bash" } },
			},
		});
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "early-bash",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "still running" }],
				details: { async: { state: "running", jobId: "job-early", type: "bash" } },
			},
		});
		expect(session.activeToolExecutionUpdates().map(event => event.partialResult)).toEqual([
			{
				content: [{ type: "text", text: "final stdout" }],
				details: { exitCode: 7, async: { state: "failed", jobId: "job-early", type: "bash" } },
			},
		]);
	});

	it("retains Eval progress until a blocking result supersedes it", async () => {
		session = await makeSession();
		const progress = {
			content: [{ type: "text" as const, text: "Eval output before return" }],
			details: { async: { state: "running", jobId: "eval-job", type: "eval" } },
		};
		session.agent.emitExternalEvent({
			type: "tool_execution_update",
			toolCallId: "eval-call",
			toolName: "eval",
			args: {},
			partialResult: progress,
		});
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "eval-call",
			toolName: "eval",
			result: {
				content: [{ type: "text", text: "Eval running" }],
				details: { async: { state: "running", jobId: "eval-job", type: "eval" } },
			},
		});
		expect(session.activeToolExecutionUpdates().map(event => event.partialResult)).toEqual([progress]);
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: "eval-call",
			toolName: "eval",
			result: { content: [{ type: "text", text: "Authoritative blocking output" }], details: {} },
		});
		expect(session.activeToolExecutionUpdates()).toEqual([]);
	});

	it("rejects late background frames after synchronous disposal begins", async () => {
		session = await makeSession();
		session.agent.emitExternalEvent(taskUpdate("running", "late-call"));
		session.beginDispose();
		const before = structuredClone(session.activeToolExecutionUpdates());
		const delivered: AgentEvent[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_update") delivered.push(event);
		});
		try {
			session.agent.emitExternalEvent(taskUpdate("completed", "late-call"));
			await session.settleInFlightMessagePersistence();
			expect(session.activeToolExecutionUpdates()).toEqual(before);
			expect(delivered).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	it("clears snapshots across a new session", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskUpdate("running", "cached-call"));
		session.agent.emitExternalEvent(taskEnd("running", "returned-call"));
		expect(session.activeToolExecutionUpdates()).toHaveLength(1);

		expect(await session.newSession()).toBe(true);
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);

		session.agent.emitExternalEvent(taskUpdate("completed", "returned-call"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["returned-call"]);
	});
});
