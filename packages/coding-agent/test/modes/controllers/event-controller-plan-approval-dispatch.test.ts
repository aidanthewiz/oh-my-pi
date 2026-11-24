import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { PROPOSE_COMMAND_NAME } from "@oh-my-pi/pi-tui/tools/resolve";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

type ToolExecutionEnd = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

const PLAN_DETAILS = { planFilePath: "local://demo-plan.md", title: "demo", planExists: true };

/**
 * A completed `propose <slug>` bash command: the run's tool-command record
 * carries the approval payload on its `inner` details.
 */
function proposeCommandEnd(exitCode = 0): ToolExecutionEnd {
	return {
		type: "tool_execution_end",
		toolCallId: "propose-1",
		toolName: "bash",
		isError: false,
		result: {
			content: [{ type: "text", text: "Plan ready for approval." }],
			details: {
				toolCommands: [
					{
						tool: PROPOSE_COMMAND_NAME,
						mode: "execute",
						exitCode,
						args: { title: "demo" },
						inner: PLAN_DETAILS,
					},
				],
			},
		},
	};
}

/** A direct `propose` call whose result details are the plan approval payload. */
function proposeToolEnd(): ToolExecutionEnd {
	return {
		type: "tool_execution_end",
		toolCallId: "propose-2",
		toolName: PROPOSE_COMMAND_NAME,
		isError: false,
		result: {
			content: [{ type: "text", text: "Plan ready for approval." }],
			details: PLAN_DETAILS,
		},
	};
}

describe("EventController plan-approval dispatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("renders an execution turn while plan approval remains unsettled", async () => {
		const executionTurn = Promise.withResolvers<void>();
		const ctx = createInteractiveModeContext({
			handlePlanApproval: () => executionTurn.promise,
		});
		const controller = new EventController(ctx);
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Approved execution is visible while running" }],
			api: "mock",
			provider: "mock",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		};
		try {
			await controller.dispatchSessionEvent(proposeCommandEnd());
			await controller.dispatchSessionEvent({ type: "agent_start" });
			await controller.dispatchSessionEvent({ type: "message_start", message });
			await controller.dispatchSessionEvent({ type: "message_end", message });
			expect(ctx.chatContainer.render(100).join("\n")).toContain("Approved execution is visible while running");
		} finally {
			executionTurn.resolve();
			await controller.drainSessionEvents();
			controller.resetTranscriptAnchors();
			ctx.chatContainer.disposeChildren();
		}
	});

	it("opens the plan approval overlay for a direct propose result", async () => {
		const handlePlanApproval = vi.fn(async () => {});
		const ctx = createInteractiveModeContext({
			session: { subscribe: () => () => {} },
			handlePlanApproval,
		});
		const controller = new EventController(ctx);

		await controller.handleEvent(proposeToolEnd());

		expect(handlePlanApproval).toHaveBeenCalledTimes(1);
		expect(handlePlanApproval).toHaveBeenCalledWith(PLAN_DETAILS);
	});

	it("does not open the plan approval overlay for a failed propose command", async () => {
		const handlePlanApproval = vi.fn(async () => {});
		const ctx = createInteractiveModeContext({
			session: { subscribe: () => () => {} },
			handlePlanApproval,
		});
		const controller = new EventController(ctx);

		await controller.handleEvent(proposeCommandEnd(1));

		expect(handlePlanApproval).not.toHaveBeenCalled();
	});
});
