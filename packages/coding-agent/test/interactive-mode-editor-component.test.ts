import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { dispatchReportIssueDevice } from "@oh-my-pi/pi-coding-agent/tools/report-tool-issue";
import { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class TestModalEditor extends CustomEditor {}

class RenderCountingTUI extends TUI {
	renderCount = 0;

	override render(width: number): readonly string[] {
		this.renderCount++;
		return super.render(width);
	}
}

async function expectTwoDirectShimmerFrames(
	tui: RenderCountingTUI,
	terminal: VirtualTerminal,
	writes: readonly string[],
	keyword: string,
): Promise<void> {
	const renderCount = tui.renderCount;
	const viewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	const bufferPosition = terminal.getBufferPosition();
	const scrollback = terminal
		.getScrollBuffer()
		.slice(0, bufferPosition.baseY)
		.map(row => Bun.stripANSI(row).trimEnd());
	const cursor = terminal.getCursor();
	const writesBeforeFirstPhase = writes.length;

	expect(viewport.join("\n")).toContain(keyword);
	expect(bufferPosition.baseY).toBeGreaterThan(0);

	vi.advanceTimersByTime(CustomEditor.SHIMMER_FRAME_MS);
	await terminal.flush();
	const firstPhaseWrites = writes.slice(writesBeforeFirstPhase);
	expect(firstPhaseWrites.length).toBeGreaterThan(0);
	expect(firstPhaseWrites.join("")).toContain("\x1b[38");

	const writesBeforeSecondPhase = writes.length;
	vi.advanceTimersByTime(CustomEditor.SHIMMER_FRAME_MS);
	await terminal.flush();
	const secondPhaseWrites = writes.slice(writesBeforeSecondPhase);
	expect(secondPhaseWrites.length).toBeGreaterThan(0);
	expect(secondPhaseWrites.join("")).toContain("\x1b[38");
	expect(secondPhaseWrites.join("")).not.toBe(firstPhaseWrites.join(""));

	expect(tui.renderCount).toBe(renderCount);
	expect(terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd())).toEqual(viewport);
	expect(terminal.getBufferPosition()).toEqual(bufferPosition);
	expect(
		terminal
			.getScrollBuffer()
			.slice(0, bufferPosition.baseY)
			.map(row => Bun.stripANSI(row).trimEnd()),
	).toEqual(scrollback);
	expect(terminal.getCursor()).toEqual(cursor);
}

describe("InteractiveMode editor and report handoff", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("defers /report consent until the agent is idle", async () => {
		vi.useFakeTimers();
		await mode.init({ suppressWelcomeIntro: true });
		const prompt = vi.spyOn(mode, "showHookSelector").mockResolvedValue("Prepare /report");

		const { result } = await dispatchReportIssueDevice(
			{} as ToolSession,
			"read: selector parse dropped trailing line",
		);

		expect(prompt).not.toHaveBeenCalled();
		expect(result.content[0]).toEqual({
			type: "text",
			text: "Coreforge report saved for review when the agent is idle. Nothing was filed.",
		});

		const submittedPromise = mode.getUserInput();
		vi.advanceTimersByTime(999);
		await Promise.resolve();
		expect(prompt).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		const submitted = await submittedPromise;

		expect(prompt).toHaveBeenCalledWith(
			expect.stringContaining("Nothing is filed until you approve the issue draft."),
			["Prepare /report", "Dismiss"],
		);
		expect(submitted).toMatchObject({
			text: "/report read: selector parse dropped trailing line",
			display: false,
			streamingBehavior: "followUp",
			cancelled: false,
			started: true,
		});
	});

	it("continues draining queued consents while the agent remains idle", async () => {
		vi.useFakeTimers();
		await mode.init({ suppressWelcomeIntro: true });
		const prompt = vi
			.spyOn(mode, "showHookSelector")
			.mockResolvedValueOnce("Dismiss")
			.mockResolvedValueOnce("Prepare /report");

		await dispatchReportIssueDevice({} as ToolSession, "read: first failure");
		await dispatchReportIssueDevice({} as ToolSession, "bash: second failure");

		const submittedPromise = mode.getUserInput();
		vi.advanceTimersByTime(1_000);
		await Promise.resolve();
		await Promise.resolve();
		expect(prompt).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(999);
		expect(prompt).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);

		const submitted = await submittedPromise;
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(submitted.text).toBe("/report bash: second failure");
	});

	it("direct-writes focused shimmer frames without disturbing terminal state before or after replacement", async () => {
		const terminal = new VirtualTerminal(80, 8, 1_000);
		terminal.write(Array.from({ length: 12 }, (_unused, index) => `seed-${index}\r\n`).join(""));
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation((data: string) => {
			writes.push(data);
			write(data);
		});
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(terminal, true, { renderScheduler: scheduler });
		const initialEditor = mode.editor;
		let replacementEditor: CustomEditor | undefined;

		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		vi.useFakeTimers();
		setSystemTime(0);
		try {
			mode.ui = tui;
			initialEditor.setUseTerminalCursor(true);
			initialEditor.magicKeywordsEnabledOverride = true;
			initialEditor.setText("please orchestrate this draft");
			tui.addChild(mode.editorContainer);
			tui.setFocus(initialEditor);
			tui.start();
			await scheduler.drain(terminal);

			await expectTwoDirectShimmerFrames(tui, terminal, writes, "orchestrate");
			initialEditor.setShimmerRepaintHandler(undefined);

			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			replacementEditor = mode.editor;
			replacementEditor.magicKeywordsEnabledOverride = true;
			replacementEditor.setText("please workflowz this draft");
			await scheduler.drain(terminal);

			await expectTwoDirectShimmerFrames(tui, terminal, writes, "workflowz");
		} finally {
			initialEditor.setShimmerRepaintHandler(undefined);
			replacementEditor?.setShimmerRepaintHandler(undefined);
			tui.stop();
			await terminal.flush();
			vi.useRealTimers();
			setSystemTime();
		}
	});
});
