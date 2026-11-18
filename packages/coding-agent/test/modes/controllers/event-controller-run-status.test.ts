/**
 * The run status `EventController` publishes (title separator + OSC 7501
 * record): what a settled turn leaves behind.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

let writes: string[] = [];
let previousHeadless = false;
let ttyDescriptor: PropertyDescriptor | undefined;

function lastStatus(): runStatus.RunStatus {
	const frame = writes.findLast(value => value.startsWith("\x1b]7501;"));
	if (!frame) throw new Error("No terminal status was emitted");
	const fields = Object.fromEntries(
		frame
			.slice(7, -2)
			.split(":")
			.map(field => {
				const index = field.indexOf("=");
				return [field.slice(0, index), field.slice(index + 1)];
			}),
	);
	const { app: _app, ...status } = fields;
	if (status.msg) status.msg = Buffer.from(status.msg, "base64").toString("utf8");
	return status as runStatus.RunStatus;
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
	vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
	previousHeadless = setTerminalHeadless(false);
	ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	writes = [];
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(String(chunk));
		return true;
	});
	runStatus.initProgramStatus();
	runStatus.setProgramStatusEnabled(true);
	runStatus.setRunStatus({ state: "idle" });
	writes.length = 0;
});

afterEach(() => {
	runStatus.disposeProgramStatus();
	vi.restoreAllMocks();
	if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
	else Reflect.deleteProperty(process.stdout, "isTTY");
	setTerminalHeadless(previousHeadless);
	resetSettingsForTest();
});

const AGENT_START = { type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>;

function assistant(stopReason: "stop" | "error" | "aborted", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		errorMessage,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function agentEnd(messages: AssistantMessage[]): Extract<AgentSessionEvent, { type: "agent_end" }> {
	return { type: "agent_end", messages } as Extract<AgentSessionEvent, { type: "agent_end" }>;
}

describe("EventController run status at turn end", () => {
	it.each([
		["a finished turn leaves its result as done", [assistant("stop")], { state: "done" }],
		[
			"a failed turn reports error with the failure",
			[assistant("error", "429 overloaded")],
			{ state: "error", msg: "429 overloaded" },
		],
		["an interrupted turn goes back to idle", [assistant("aborted", "Interrupted by user")], { state: "idle" }],
		["a turn without a reply goes back to idle", [], { state: "idle" }],
	] satisfies [string, AssistantMessage[], runStatus.RunStatus][])("%s", async (_name, messages, expected) => {
		const controller = new EventController(createInteractiveModeContext());

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(agentEnd(messages));

		expect(lastStatus()).toEqual(expected);
	});

	it("keeps an unclassified retry completion from reporting a terminal error", async () => {
		const controller = new EventController(createInteractiveModeContext());
		await controller.handleEvent(AGENT_START);

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent(agentEnd([assistant("error", "overloaded")]));

		expect(lastStatus()).toEqual({ state: "idle" });
	});

	it.each([
		["error", [], { state: "error" }],
		["success", [assistant("error", "stale")], { state: "done" }],
		["aborted", [assistant("stop")], { state: "idle" }],
		["unknown", [assistant("stop")], { state: "idle" }],
	] as const)("reports retained %s instead of a pruned or stale transcript", async (outcome, messages, expected) => {
		const controller = new EventController(createInteractiveModeContext());
		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({ ...agentEnd([...messages]), outcome });
		expect(lastStatus()).toEqual(expected);
	});
});

describe("EventController settle with a queued compaction", () => {
	function queuedCompactionContext() {
		const ctx = createInteractiveModeContext();
		const runYieldCompaction = vi.fn();
		const restoreCompactionQueueToEditor = vi.fn();
		Object.assign(ctx, {
			yieldCompaction: { text: "/compact", sessionId: "session", leafId: null },
			runYieldCompaction,
			restoreCompactionQueueToEditor,
		});
		return { ctx, runYieldCompaction, restoreCompactionQueueToEditor };
	}

	it("runs it when the run yields", async () => {
		const { ctx, runYieldCompaction, restoreCompactionQueueToEditor } = queuedCompactionContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(agentEnd([assistant("stop")]));

		expect(runYieldCompaction).toHaveBeenCalledTimes(1);
		expect(restoreCompactionQueueToEditor).not.toHaveBeenCalled();
	});

	it("hands it back when the user stopped the run (loop-mode Esc aborts without restoring the queue)", async () => {
		const { ctx, runYieldCompaction, restoreCompactionQueueToEditor } = queuedCompactionContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(agentEnd([assistant("aborted", USER_INTERRUPT_LABEL)]));

		expect(runYieldCompaction).not.toHaveBeenCalled();
		expect(restoreCompactionQueueToEditor).toHaveBeenCalledTimes(1);
	});
});
