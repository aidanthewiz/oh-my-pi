import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { JobsSheet } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("/jobs in the native terminal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession;
	let mode: InteractiveMode;
	let wasNative: boolean;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-jobs-native-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			asyncJobManager: manager,
		});
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
		wasNative = isNativeRendering();
		setNativeRendering(true);
	});

	afterEach(async () => {
		setNativeRendering(wasNative);
		mode?.stop();
		HistoryStorage.close();
		vi.restoreAllMocks();
		manager.cancelAll();
		await manager.dispose({ timeoutMs: 1_000 });
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("opens the live jobs sheet listing the running job, leaves the transcript alone, and Esc closes it", async () => {
		const gate = Promise.withResolvers<string>();
		manager.register("bash", "cargo test --workspace", () => gate.promise);
		const transcript = [...mode.chatContainer.children];

		await mode.handleJobsCommand();

		const sheet = mode.ui.overlayStack.at(-1)?.component;
		expect(sheet).toBeInstanceOf(JobsSheet);
		expect(mode.ui.getFocused()).toBe(sheet ?? null);
		expect(Bun.stripANSI(sheet?.render(100).join("\n") ?? "")).toContain("cargo test --workspace");
		expect(mode.chatContainer.children).toEqual(transcript);

		sheet?.handleInput?.("\x1b");
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(mode.chatContainer.children).toEqual(transcript);
		gate.resolve("done");
	});
});
