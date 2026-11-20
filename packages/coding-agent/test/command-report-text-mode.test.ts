import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const ROWS = 32;

function screen(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

describe("text-mode command reports on a real terminal core", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-command-report-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(120, ROWS);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		await authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function mountTranscript(rows: number): Promise<string> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		for (let i = 0; i < rows; i++) mode.chatContainer.addChild(new Text(`TRANSCRIPT ${i}`, 0, 0));
		mode.ui.requestRender();
		const last = `TRANSCRIPT ${rows - 1}`;
		await term.waitForRender(() => screen(term).includes(last));
		return last;
	}

	async function runCommand(command: string, shown: string): Promise<void> {
		term.sendInput(command);
		await term.waitForRender(() => screen(term).some(row => row.includes(command)));
		term.sendInput("\r");
		await term.waitForRender(() => screen(term).some(row => row.includes(shown)));
	}

	it.each([5, 40])(
		"opens `/changelog full` as a scrollable full-screen page and Esc returns to the untouched screen (%i transcript rows)",
		async rows => {
			const last = await mountTranscript(rows);
			const before = screen(term);
			await runCommand("/changelog full", "Full Changelog");
			expect(screen(term).some(row => row.includes(last))).toBe(false);
			const page = screen(term).join("\n");
			term.sendInput("\x1b[6~");
			await term.waitForRender(() => screen(term).join("\n") !== page);
			expect(screen(term).some(row => row.includes("Full Changelog"))).toBe(true);

			term.sendInput("\x1b");
			await term.waitForRender(() => !screen(term).some(row => row.includes("Full Changelog")));
			expect(screen(term).indexOf(last)).toBe(before.indexOf(last));
			// Nothing of the page reached the main screen, and no transcript row was duplicated.
			const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			expect(buffer.filter(row => row === last)).toHaveLength(1);
			expect(buffer.some(row => row.includes("Full Changelog"))).toBe(false);
		},
	);

	it("shows a report that fits above the editor like /btw and Esc takes it away", async () => {
		const last = await mountTranscript(40);
		const lastRow = screen(term).indexOf(last);
		await runCommand("/tools", "Available Tools");
		// Inline: the transcript stays on the main screen, only covered from below.
		expect(screen(term).some(row => row.startsWith("TRANSCRIPT"))).toBe(true);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes("Available Tools")));
		expect(screen(term).indexOf(last)).toBe(lastRow);
	});

	it.each([
		[120, 12],
		[28, ROWS],
	])("focuses an inline report when shrinking to %ix%i and preserves its unsent draft", async (columns, rows) => {
		await mountTranscript(40);
		const draft = "unsent draft [Image #1]";
		const images = [{ type: "image" as const, mimeType: "image/png", data: "c3ludGhldGlj" }];
		mode.editor.pendingImages = images;
		mode.editor.pendingImageLinks = ["artifact://report-image"];
		mode.editor.imageLinks = mode.editor.pendingImageLinks;
		mode.editor.setText(draft);
		const blocks = [...mode.chatContainer.children];
		const entries = session.sessionManager.getEntries();
		const body = new Text(
			Array.from({ length: 14 }, (_, i) => `REPORT_ENTRY_${i.toString().padStart(2, "0")} ${".".repeat(40)}`).join(
				"\n",
			),
			0,
			0,
		);
		mode.showCommandReport({ title: "Resize report", body });
		await term.waitForRender(() => screen(term).some(row => row.includes("REPORT_ENTRY_13")));
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.reportContainer.children).toHaveLength(1);

		term.resize(columns, rows);
		await term.waitForRender(() => mode.ui.hasOverlay() && mode.reportContainer.children.length === 0);
		const report = mode.ui.getFocused();
		expect(report).not.toBe(mode.editor);
		term.sendInput("\x1b[F");
		await term.waitForRender(() => screen(term).some(row => row.includes("REPORT_ENTRY_13")));
		term.sendInput("\x1b[H");
		await term.waitForRender(() => screen(term).some(row => row.includes("REPORT_ENTRY_00")));
		term.sendInput("\x1b[6~");
		await term.waitForRender(() => !screen(term).some(row => row.includes("REPORT_ENTRY_00")));
		term.sendInput("x");
		term.resize(120, ROWS);
		await term.waitForRender();
		expect(mode.ui.getFocused()).toBe(report);
		term.sendInput(rows === 12 ? "\x1b" : "\x03");
		await term.waitForRender(() => !mode.ui.hasOverlay());
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.editor.getText()).toBe(draft);
		expect(mode.editor.pendingImages).toEqual(images);
		expect(mode.editor.pendingImageLinks).toEqual(["artifact://report-image"]);
		expect(mode.chatContainer.children).toEqual(blocks);
		expect(session.sessionManager.getEntries()).toEqual(entries);
		expect(session.messages).toEqual([]);

		mode.showCommandReport({ title: "Reopened report", body });
		await term.waitForRender(() => screen(term).some(row => row.includes("Reopened report")));
		expect(mode.ui.getFocused()).toBe(mode.editor);
		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes("Reopened report")));
		term.resize(columns, rows);
		await term.waitForRender();
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(mode.editor.getText()).toBe(draft);
	});

	it.each([
		["/mcp help", "MCP Server Management"],
		["/mcp list", "MCP Servers"],
		["/ssh help", "SSH Host Management"],
		["/ssh list", "SSH Hosts"],
	])("`%s` reports outside the transcript and Esc takes it away", async (command, title) => {
		const last = await mountTranscript(40);
		const lastRow = screen(term).indexOf(last);
		const blocks = mode.chatContainer.children.length;
		await runCommand(command, title);
		expect(mode.chatContainer.children).toHaveLength(blocks);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes(title)));
		expect(screen(term).indexOf(last)).toBe(lastRow);
		const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row));
		expect(buffer.some(row => row.includes(title))).toBe(false);
	});
});
