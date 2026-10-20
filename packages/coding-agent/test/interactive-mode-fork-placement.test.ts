import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pool-scope";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { CleanseCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/cleanse-command-controller";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { OmfgController } from "@oh-my-pi/pi-coding-agent/modes/controllers/omfg-controller";
import * as ternKind from "@oh-my-pi/pi-coding-agent/tools/browser/tern/kind";
import { TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { TerminalLaunchRequest } from "../src/subprocess/terminal-launch";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("InteractiveMode fork placement bridge", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let originalAgentDir: string;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-fork-placement-");
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		setAgentDir(originalAgentDir);
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it.each([
		["an in-place fork tears down", undefined, 1],
		["a pane fork keeps", "pane", 0],
	] as const)("%s the current session's side controllers", async (_label, placement, disposals) => {
		const btwDispose = vi.spyOn(BtwController.prototype, "dispose");
		const omfgDispose = vi.spyOn(OmfgController.prototype, "dispose");
		const cleanseDispose = vi.spyOn(CleanseCommandController.prototype, "dispose");
		vi.spyOn(CommandController.prototype, "handleForkCommand").mockResolvedValue();

		await mode.handleForkCommand(placement);

		expect(btwDispose).toHaveBeenCalledTimes(disposals);
		expect(omfgDispose).toHaveBeenCalledTimes(disposals);
		expect(cleanseDispose).toHaveBeenCalledTimes(disposals);
	});

	it("flushes deferred Bash output into an independent fork without replacing its unpooled source owner", async () => {
		await session.sessionManager.ensureOnDisk();
		Object.defineProperty(session, "isStreaming", { configurable: true, value: true });
		session.recordBashResult("owned-completed-command", {
			output: "completed-before-fork",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 21,
			outputLines: 1,
			outputBytes: 21,
		});
		Reflect.deleteProperty(session, "isStreaming");
		const originalId = session.sessionId;
		const originalFile = session.sessionManager.getSessionFile();
		const opened: { child?: SessionManager } = {};
		const launchTerminal = vi.fn(async (request: TerminalLaunchRequest) => {
			const source = request.command.at(-1);
			if (!source) throw new Error("Expected the persisted source path");
			opened.child = await SessionManager.forkFrom(
				source,
				request.cwd,
				path.join(tempDir.path(), "children"),
				undefined,
				{ suppressBreadcrumb: true, repairInterruptedTail: true },
			);
			return { multiplexer: request.multiplexer, placement: request.placement };
		});
		const error = vi.spyOn(mode, "showError").mockImplementation(() => {});
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		const controller = new CommandController(mode, {
			environment: () => ({ TMUX: "owned-fixture", TMUX_PANE: "%1" }),
			launchTerminal,
			resolveCliEntryCmd: () => ["owned-entry"],
			getActiveProfile: () => undefined,
			argv: () => [],
		});
		try {
			await controller.handleForkCommand("pane");
			expect(error).not.toHaveBeenCalled();
			if (!opened.child) throw new Error("Expected an independently owned fork");
			expect(opened.child.getSessionId()).not.toBe(originalId);
			expect(opened.child.getSessionFile()).not.toBe(originalFile);
			const inheritedBash = opened.child
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "bashExecution");
			expect(inheritedBash).toMatchObject({
				type: "message",
				message: { role: "bashExecution", command: "owned-completed-command", output: "completed-before-fork" },
			});
			expect(session.sessionId).toBe(originalId);
			expect(session.sessionManager.getSessionFile()).toBe(originalFile);
		} finally {
			await opened.child?.close();
		}
	});

	it("refuses cross-process forks governed by real OAuth pools even after their leases are released", async () => {
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "pooled"));
		const scope = SessionAccountPoolScope.create(session.modelRegistry, { anthropic: [] }, manager.getSessionId());
		if (!scope) throw new Error("Expected an explicit account-pool scope");
		const pooled = new AgentSession({
			agent: new Agent({ initialState: { model: session.model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: scope.registry(session.modelRegistry),
			accountPoolScope: scope,
		});
		const pooledMode = new InteractiveMode(pooled, "test");
		const error = vi.spyOn(pooledMode, "showError").mockImplementation(() => {});
		const launchTerminal = vi.fn(async (request: TerminalLaunchRequest) => ({
			multiplexer: request.multiplexer,
			placement: request.placement,
		}));
		const controller = new CommandController(pooledMode, {
			environment: () => ({ TMUX: "owned-fixture", TMUX_PANE: "%1" }),
			launchTerminal,
			resolveCliEntryCmd: () => ["owned-entry"],
			argv: () => [],
		});
		try {
			await manager.ensureOnDisk();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected the owned source transcript");
			const source = await Bun.file(file).text();
			await controller.handleForkCommand("pane");
			scope.release();
			await controller.handleForkCommand("window");
			expect(launchTerminal).not.toHaveBeenCalled();
			expect(error.mock.calls).toHaveLength(2);
			for (const [message] of error.mock.calls) expect(message).toContain("account-pool policy");
			expect(await Bun.file(file).text()).toBe(source);
		} finally {
			pooledMode.stop();
			await pooled.dispose();
		}
	});

	it.each(["active", "released", "unpooled"] as const)(
		"keeps %s account policy across a bare fork inside Tern",
		async policy => {
			const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "tern-sessions"));
			const scope =
				policy === "unpooled"
					? undefined
					: SessionAccountPoolScope.create(session.modelRegistry, { anthropic: [] }, manager.getSessionId());
			authStorage.keys.setRuntime("anthropic", "owned-runtime-key");
			const forkSession = new AgentSession({
				agent: new Agent({
					initialState: { model: session.model, systemPrompt: ["Test"], tools: [], messages: [] },
				}),
				sessionManager: manager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: scope?.registry(session.modelRegistry) ?? session.modelRegistry,
				accountPoolScope: scope,
			});
			const forkMode = new InteractiveMode(
				forkSession,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				new Composer({ terminal: new VirtualTerminal() }),
			);
			const warning = vi.spyOn(forkMode, "showWarning").mockImplementation(() => {});
			vi.spyOn(forkMode, "showError").mockImplementation(() => {});
			vi.spyOn(ternKind, "resolveTernPane").mockReturnValue({
				socketPath: path.join(tempDir.path(), "never-connected.sock"),
				pane: 7,
			});
			const connect = vi.spyOn(TernSocketClient.prototype, "connect").mockResolvedValue();
			vi.spyOn(TernSocketClient.prototype, "supports").mockReturnValue(true);
			const transportFork = vi.spyOn(TernSocketClient.prototype, "fork").mockResolvedValue(9);
			vi.spyOn(TernSocketClient.prototype, "close").mockImplementation(() => {});
			try {
				manager.appendMessage({ role: "user", content: "owned Tern transcript", timestamp: 1 });
				await manager.ensureOnDisk();
				const sourceFile = manager.getSessionFile();
				if (!sourceFile) throw new Error("Expected the durable source transcript");
				const source = await Bun.file(sourceFile).text();
				const sourceId = forkSession.sessionId;
				if (policy === "released") scope?.release();
				let failure: unknown;
				try {
					await forkMode.handleForkCommand();
				} catch (error) {
					failure = error;
				}
				if (policy === "unpooled") {
					expect(failure).toBeUndefined();
					expect(transportFork).toHaveBeenCalledTimes(1);
					expect(forkSession.sessionId).toBe(sourceId);
					expect(manager.getSessionFile()).toBe(sourceFile);
				} else {
					expect(connect).not.toHaveBeenCalled();
					expect(transportFork).not.toHaveBeenCalled();
					expect(warning).toHaveBeenCalledTimes(1);
					if (policy === "active") {
						expect(failure).toBeUndefined();
						expect(forkSession.sessionId).not.toBe(sourceId);
						expect(manager.getSessionFile()).not.toBe(sourceFile);
					}
					if (!forkSession.model) throw new Error("Expected the inherited model");
					const credentials = await forkSession.modelRegistry.getApiKeyAndHeaders(forkSession.model);
					expect(credentials.ok).toBe(false);
				}
				expect(await Bun.file(sourceFile).text()).toBe(source);
			} finally {
				forkMode.stop();
				await forkSession.dispose();
			}
		},
	);
});
