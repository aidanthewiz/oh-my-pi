import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { reportToolIssue } from "@oh-my-pi/pi-coding-agent/tools/report-tool-issue";
import { TempDir } from "@oh-my-pi/pi-utils";

class TestModalEditor extends CustomEditor {}

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
		await authStorage?.close();
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
		const prompt = vi
			.spyOn(ExtensionUiController.prototype, "showCollabAwareSelector")
			.mockResolvedValue("Prepare /report");

		await reportToolIssue({} as ToolSession, "read: selector parse dropped trailing line");

		expect(prompt).not.toHaveBeenCalled();

		const submittedPromise = mode.getUserInput();
		vi.advanceTimersByTime(999);
		await Promise.resolve();
		expect(prompt).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		const submitted = await submittedPromise;

		expect(submitted).toMatchObject({
			text: "/report read: selector parse dropped trailing line",
			display: false,
			streamingBehavior: "followUp",
			cancelled: false,
			started: true,
		});
	});

	for (const firstChoice of ["Dismiss", undefined] as const) {
		it(`continues draining queued consents after ${firstChoice ?? "cancellation"} while the agent remains idle`, async () => {
			vi.useFakeTimers();
			await mode.init({ suppressWelcomeIntro: true });
			const firstAnswer = Promise.withResolvers<string | undefined>();
			const prompt = vi
				.spyOn(ExtensionUiController.prototype, "showCollabAwareSelector")
				.mockImplementationOnce(() => firstAnswer.promise)
				.mockResolvedValueOnce("Prepare /report");

			await reportToolIssue({} as ToolSession, "read: first failure");
			await reportToolIssue({} as ToolSession, "bash: second failure");

			const submittedPromise = mode.getUserInput();
			vi.advanceTimersByTime(1_000);
			expect(prompt).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1_000);
			expect(prompt).toHaveBeenCalledTimes(1);

			firstAnswer.resolve(firstChoice);
			await nextTurn();
			vi.advanceTimersByTime(999);
			expect(prompt).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1);

			const submitted = await submittedPromise;
			expect(prompt).toHaveBeenCalledTimes(2);
			expect(submitted.text).toBe("/report bash: second failure");
		});
	}

	it("exposes the active editor factory while replacing the editor", () => {
		const firstFactory = (_tui: unknown, editorTheme: ConstructorParameters<typeof TestModalEditor>[0]) =>
			new TestModalEditor(editorTheme);
		mode.setEditorComponent(firstFactory);

		expect(mode.getEditorComponent()).toBe(firstFactory);

		let previousFactory: unknown;
		const secondFactory = (_tui: unknown, editorTheme: ConstructorParameters<typeof TestModalEditor>[0]) => {
			previousFactory = mode.getEditorComponent();
			return new TestModalEditor(editorTheme);
		};
		mode.setEditorComponent(secondFactory);

		expect(previousFactory).toBe(firstFactory);
		expect(mode.getEditorComponent()).toBe(secondFactory);

		mode.setEditorComponent(undefined);
		expect(mode.getEditorComponent()).toBeUndefined();
	});

	it("keeps the startup submit gate on an editor swapped in before init lifts it", () => {
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		expect(mode.editor.disableSubmit).toBe(true);

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
		expect(mode.editor.disableSubmit).toBe(true);

		mode.editor.disableSubmit = false;
		mode.setEditorComponent(undefined);
		expect(mode.editor.disableSubmit).toBe(false);
	});
});
