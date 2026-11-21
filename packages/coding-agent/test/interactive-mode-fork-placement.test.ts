import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pool-scope";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import * as ternKind from "@oh-my-pi/pi-coding-agent/tools/browser/tern/kind";
import { TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { TerminalLaunchRequest } from "../src/subprocess/terminal-launch";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { type FakeAnswer, startFakeDaemon } from "./tools/tern-fake-daemon";
import { assistantMsg } from "./utilities";

class ObservedSideStream extends AssistantMessageEventStream {
	constructor(private readonly onTextConsumed: () => void) {
		super();
	}

	override async *[Symbol.asyncIterator]() {
		const iterator = super[Symbol.asyncIterator]();
		for (;;) {
			const next = await iterator.next();
			if (next.done) return;
			yield next.value;
			if (next.value.type === "text_delta") this.onTextConsumed();
		}
	}
}

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
		await authStorage?.close();
		setAgentDir(originalAgentDir);
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	async function openPersistedBtwHistory(target: InteractiveMode) {
		const artifacts = target.sessionManager.getArtifactsDir();
		if (!artifacts) throw new Error("Expected persisted side-session artifacts");
		const history = await BtwHistoryStore.open(artifacts);
		await history.upsert({
			id: "retained-topic",
			leafId: target.sessionManager.getLeafId(),
			question: "retained-side-question",
			answer: "retained-side-answer",
			status: "complete",
			createdAt: 1,
			updatedAt: 2,
		});
		await target.handleBtwCommand("");
		const focus = target.ui.getFocused();
		if (!focus) throw new Error("Expected BTW history focus");
		expect(target.ui.hasOverlay()).toBe(true);
		expect(focus.render(80).join("\n")).toContain("retained-side-question");
		return focus;
	}

	it("copies a live BTW partial checkpoint and captured leaf without cancelling a rejected fork", async () => {
		mode.stop();
		const registry = session.modelRegistry;
		const model = session.model;
		await session.dispose();
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "partial-sessions"));
		manager.appendMessage({ role: "user", content: "partial-parent", timestamp: 1 });
		await manager.ensureOnDisk();
		const sourceId = manager.getSessionId();
		const sourceArtifacts = manager.getArtifactsDir();
		const capturedLeaf = manager.getLeafId();
		if (!sourceArtifacts || !capturedLeaf) throw new Error("Expected persisted parent and captured leaf");
		const release = Promise.withResolvers<void>();
		const partialConsumed = Promise.withResolvers<void>();
		let transportFinished = Promise.resolve();
		let signal: AbortSignal | undefined;
		const message = assistantMsg("partial-answer");
		authStorage.keys.setRuntime("anthropic", "synthetic-offline-key");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Offline test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
				streamFn: () => {
					throw new Error("Primary inference forbidden");
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "advisor.enabled": false, "async.enabled": false }),
			modelRegistry: registry,
			memoryEnabled: false,
			sideStreamFn: (_model, _context, options) => {
				signal = options?.signal;
				const stream = new ObservedSideStream(partialConsumed.resolve);
				stream.push({ type: "text_delta", contentIndex: 0, delta: "partial-answer", partial: message });
				const finish = () => stream.push({ type: "done", reason: "stop", message });
				signal?.addEventListener("abort", finish, { once: true });
				transportFinished = release.promise.then(() => {
					finish();
					signal?.removeEventListener("abort", finish);
				});
				return stream;
			},
		});
		const composer = new Composer({ terminal: new VirtualTerminal(80, 24) });
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, composer);
		vi.spyOn(ternKind, "resolveTernPane").mockReturnValue(null);
		try {
			await mode.handleBtwCommand("owned partial question");
			await partialConsumed.promise;
			expect(mode.btwContainer.render(80).join("\n")).toContain("partial-answer");
			expect(session.isStreaming).toBe(false);
			expect(signal?.aborted).toBe(false);
			session.setSessionBeforeSwitchReconciler(async () => {
				throw new Error("rejected partial fork");
			});
			await expect(mode.handleForkCommand()).rejects.toThrow("rejected partial fork");
			expect(session.sessionId).toBe(sourceId);
			expect(signal?.aborted).toBe(false);
			expect(mode.btwContainer.render(80).join("\n")).toContain("partial-answer");
			session.setSessionBeforeSwitchReconciler(null);
			await mode.handleForkCommand();
			expect(session.sessionId).not.toBe(sourceId);
			const parent = (await BtwHistoryStore.open(sourceArtifacts)).getRecords();
			const child = (await BtwHistoryStore.open(manager.getArtifactsDir() ?? undefined)).getRecords();
			expect(parent[0]).toMatchObject({
				question: "owned partial question",
				answer: "partial-answer",
				leafId: capturedLeaf,
				status: "cancelled",
			});
			expect(child[0]).toMatchObject({
				id: parent[0]?.id,
				question: "owned partial question",
				answer: "partial-answer",
				leafId: capturedLeaf,
				status: "interrupted",
			});
		} finally {
			release.resolve();
			await transportFinished;
			try {
				await mode.prepareSessionSwitch();
			} finally {
				mode.stop();
				composer.stop();
				await session.dispose();
				await manager.close();
			}
		}
	}, 15_000);

	it.each(["answer", "history"] as const)(
		"retires outgoing input handlers but preserves incoming %s owners",
		async surface => {
			mode.stop();
			const registry = session.modelRegistry;
			const model = session.model;
			await session.dispose();
			const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "hook-sessions"));
			manager.appendMessage({ role: "user", content: "hook-parent", timestamp: 1 });
			await manager.ensureOnDisk();
			const sourceId = manager.getSessionId();
			if (surface === "history") {
				const history = await BtwHistoryStore.open(manager.getArtifactsDir() ?? undefined);
				await history.upsert({
					id: "hook-history",
					question: "copied history question",
					answer: "copied history answer",
					leafId: manager.getLeafId(),
					status: "complete",
					createdAt: 1,
					updatedAt: 2,
				});
			}
			let cancelFork = true;
			let switchedId: string | undefined;
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				api => {
					api.on("session_start", (_event, ctx) => {
						ctx.ui.onTerminalInput(data => (data === "x" ? { data: "z" } : undefined));
					});
					api.on("session_before_switch", (event, ctx) => {
						if (event.reason !== "fork") return;
						ctx.ui.onTerminalInput(data => (data === "w" ? { data: "q" } : undefined));
						if (cancelFork) return { cancel: true };
					});
					api.on("session_switch", async (event, ctx) => {
						if (event.reason !== "fork") return;
						switchedId = ctx.sessionManager.getSessionId();
						ctx.ui.onTerminalInput(data => (data === "x" ? { data: "y" } : undefined));
						if (surface === "answer") await mode.handleBtwCommand("incoming side question");
						await mode.handleBtwCommand("");
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"fork-owner-regression",
			);
			const runner = new ExtensionRunner([extension], runtime, tempDir.path(), manager, registry);
			const release = Promise.withResolvers<void>();
			let transportFinished = Promise.resolve();
			const incomingSaved = Promise.withResolvers<void>();
			void incomingSaved.promise.catch(() => {});
			const upsert = BtwHistoryStore.prototype.upsert;
			vi.spyOn(BtwHistoryStore.prototype, "upsert").mockImplementation(
				async function (this: BtwHistoryStore, record) {
					await upsert.call(this, record);
					if (record.question !== "incoming side question") return;
					if (record.status === "complete") incomingSaved.resolve();
					else if (record.status === "cancelled" || record.status === "error") {
						incomingSaved.reject(new Error(`Incoming BTW was persisted as ${record.status}`));
					}
				},
			);
			authStorage.keys.setRuntime("anthropic", "synthetic-offline-key");
			session = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Offline test"],
						tools: [],
						messages: manager.buildSessionContext().messages,
					},
					streamFn: () => {
						throw new Error("Primary inference forbidden");
					},
				}),
				sessionManager: manager,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"advisor.enabled": false,
					"async.enabled": false,
				}),
				modelRegistry: registry,
				memoryEnabled: false,
				extensionRunner: runner,
				sideStreamFn: (_model, _context, options) => {
					const stream = new AssistantMessageEventStream();
					const partial = assistantMsg("incoming-partial");
					const complete = assistantMsg("incoming-partial survived");
					stream.push({ type: "text_delta", contentIndex: 0, delta: "incoming-partial", partial });
					const abort = () => stream.push({ type: "done", reason: "stop", message: partial });
					options?.signal?.addEventListener("abort", abort, { once: true });
					transportFinished = release.promise.then(() => {
						stream.push({ type: "text_delta", contentIndex: 0, delta: " survived", partial: complete });
						stream.push({ type: "done", reason: "stop", message: complete });
						options?.signal?.removeEventListener("abort", abort);
					});
					return stream;
				},
			});
			const terminal = new VirtualTerminal(80, 24);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({ terminal, tuiOptions: { renderScheduler: scheduler } });
			mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, composer);
			vi.spyOn(ternKind, "resolveTernPane").mockReturnValue(null);
			const debugPath = process.env.OMP_TUI_DEBUG;
			delete process.env.OMP_TUI_DEBUG;
			try {
				composer.start({ playWelcomeIntro: false });
				await mode.initHooksAndCustomTools();
				const input = new Input();
				composer.setRuntimeChildren([input]);
				composer.ui.setFocus(input);
				terminal.sendInput("x");
				expect(input.getValue()).toBe("z");
				input.setValue("");
				await mode.handleForkCommand();
				expect(session.sessionId).toBe(sourceId);
				terminal.sendInput("x");
				terminal.sendInput("w");
				expect(input.getValue()).toBe("zq");
				input.setValue("");
				cancelFork = false;
				await mode.handleForkCommand();
				expect(session.sessionId).not.toBe(sourceId);
				expect(switchedId).toBe(session.sessionId);
				expect(mode.ui.hasOverlay()).toBe(true);
				const incomingSurface = mode.ui.getFocused();
				if (!incomingSurface?.handleInput) throw new Error("Expected the incoming BTW history surface");
				expect(incomingSurface.render(80).join("\n")).toContain(
					surface === "answer" ? "incoming side question" : "copied history question",
				);
				release.resolve();
				if (surface === "answer") await incomingSaved.promise;
				const records = (await BtwHistoryStore.open(manager.getArtifactsDir() ?? undefined)).getRecords();
				expect(
					records.find(
						record =>
							record.question === (surface === "answer" ? "incoming side question" : "copied history question"),
					),
				).toMatchObject({
					answer: surface === "answer" ? "incoming-partial survived" : "copied history answer",
					status: "complete",
					leafId: manager.getLeafId(),
				});
				incomingSurface.handleInput("\x1b");
				composer.ui.setFocus(input);
				terminal.sendInput("x");
				terminal.sendInput("w");
				expect(input.getValue()).toBe("yw");
				await scheduler.settle(terminal);
			} finally {
				release.resolve();
				await transportFinished;
				try {
					await mode.prepareSessionSwitch();
				} finally {
					mode.stop();
					composer.stop();
					await session.dispose();
					await manager.close();
					if (debugPath === undefined) delete process.env.OMP_TUI_DEBUG;
					else process.env.OMP_TUI_DEBUG = debugPath;
				}
			}
		},
		15_000,
	);

	it("preserves the original BTW sheet and running turn across accepted, declined and unconfirmed Tern forks", async () => {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const provider = createMockModel({
			handler: async () => {
				started.resolve();
				await finish.promise;
				return { content: ["original-turn-completed"] };
			},
		});
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "streaming"));
		manager.appendMessage({ role: "user", content: "original-parent", timestamp: 1 });
		await manager.ensureOnDisk();
		authStorage.keys.setRuntime("anthropic", "synthetic-offline-key");
		const streaming = new AgentSession({
			agent: new Agent({
				initialState: {
					model: session.model,
					systemPrompt: ["Offline test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
				getApiKey: () => "synthetic-offline-key",
				streamFn: provider.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"advisor.enabled": false,
				"async.enabled": false,
				"prewalk.enabled": false,
			}),
			modelRegistry: session.modelRegistry,
			memoryEnabled: false,
		});
		const streamingMode = new InteractiveMode(
			streaming,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(80, 24) }),
		);
		let answer: FakeAnswer = { ok: { block: 9 } };
		const daemon = await startFakeDaemon(
			() => {
				throw new Error("Unexpected browser operation");
			},
			{ welcome: { ops: ["fork"] }, fork: () => answer },
		);
		vi.spyOn(ternKind, "resolveTernPane").mockReturnValue({ socketPath: daemon.socketPath, pane: 5 });
		let turn: Promise<boolean> | undefined;
		let child: SessionManager | undefined;
		try {
			const focus = await openPersistedBtwHistory(streamingMode);
			const originalId = manager.getSessionId();
			const originalFile = manager.getSessionFile();
			if (!originalFile) throw new Error("Expected persisted parent");
			turn = streaming.prompt("continue original");
			await started.promise;
			await streaming.flushToDisk();
			const snapshot = await Bun.file(originalFile).text();
			for (const result of [
				{ ok: { block: 9 } },
				{ error: { kind: "not_agent", message: "synthetic decline" } },
				{ error: { kind: "protocol", message: "synthetic unconfirmed reply" } },
			]) {
				answer = result;
				await streamingMode.handleForkCommand();
				expect(streamingMode.ui.hasOverlay()).toBe(true);
				expect(streamingMode.ui.getFocused()).toBe(focus);
				expect(focus.render(80).join("\n")).toContain("retained-side-question");
				expect(manager.getSessionId()).toBe(originalId);
				expect(manager.getSessionFile()).toBe(originalFile);
				expect(streaming.isStreaming).toBe(true);
				expect(await Bun.file(originalFile).text()).toBe(snapshot);
			}
			expect(daemon.forks.map(request => request.op)).toEqual([{ block: 5 }, { block: 5 }, { block: 5 }]);
			child = await SessionManager.forkFrom(
				originalFile,
				tempDir.path(),
				path.join(tempDir.path(), "children"),
				undefined,
				{ suppressBreadcrumb: true, copyArtifacts: false },
			);
			finish.resolve();
			await turn;
			await streaming.flushToDisk();
			expect(streaming.messages.some(message => JSON.stringify(message).includes("original-turn-completed"))).toBe(
				true,
			);
			expect(
				child
					.buildSessionContext()
					.messages.some(message => JSON.stringify(message).includes("original-turn-completed")),
			).toBe(false);
			expect(manager.getSessionId()).toBe(originalId);
		} finally {
			finish.resolve();
			await turn;
			await daemon.close();
			streamingMode.stop();
			await streaming.dispose();
			await child?.close();
		}
	});

	it("cleans up BTW history only after a successful in-place fork, not an idle external fork or rejected switch", async () => {
		mode.stop();
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(80, 24) }),
		);
		session.sessionManager.appendMessage({ role: "user", content: "idle-parent", timestamp: 1 });
		await session.sessionManager.ensureOnDisk();
		const focus = await openPersistedBtwHistory(mode);
		const sourceId = session.sessionId;
		const sourceFile = session.sessionFile;
		const sourceArtifacts = session.sessionManager.getArtifactsDir();
		if (!sourceFile || !sourceArtifacts) throw new Error("Expected persisted parent");
		await session.flushToDisk();
		const snapshot = await Bun.file(sourceFile).text();
		const daemon = await startFakeDaemon(
			() => {
				throw new Error("Unexpected browser operation");
			},
			{ welcome: { ops: ["fork"] }, fork: () => ({ ok: { block: 9 } }) },
		);
		const tern = vi.spyOn(ternKind, "resolveTernPane").mockReturnValue({ socketPath: daemon.socketPath, pane: 5 });
		try {
			await mode.handleForkCommand();
			expect(mode.ui.hasOverlay()).toBe(true);
			expect(mode.ui.getFocused()).toBe(focus);
			expect(session.sessionId).toBe(sourceId);
			tern.mockReturnValue(null);
			session.setSessionBeforeSwitchReconciler(async () => {
				throw new Error("synthetic rejected switch");
			});
			await expect(mode.handleForkCommand()).rejects.toThrow("synthetic rejected switch");
			expect(mode.ui.hasOverlay()).toBe(true);
			expect(mode.ui.getFocused()).toBe(focus);
			expect(session.sessionId).toBe(sourceId);
			expect(await Bun.file(sourceFile).text()).toBe(snapshot);
			session.setSessionBeforeSwitchReconciler(null);
			await mode.handleForkCommand();
			expect(session.sessionId).not.toBe(sourceId);
			expect(mode.ui.hasOverlay()).toBe(false);
			expect(mode.ui.getFocused()).not.toBe(focus);
			const originalHistory = await BtwHistoryStore.open(sourceArtifacts);
			const forkHistory = await BtwHistoryStore.open(session.sessionManager.getArtifactsDir() ?? undefined);
			expect(originalHistory.getRecords().map(record => record.answer)).toEqual(["retained-side-answer"]);
			expect(forkHistory.getRecords()).toEqual(originalHistory.getRecords());
		} finally {
			session.setSessionBeforeSwitchReconciler(null);
			await daemon.close();
		}
	});

	it("preserves the BTW sheet when an in-memory fork is a no-op", async () => {
		const memory = new AgentSession({
			agent: new Agent({ initialState: { model: session.model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: session.modelRegistry,
			memoryEnabled: false,
		});
		const memoryMode = new InteractiveMode(
			memory,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(80, 24) }),
		);
		vi.spyOn(ternKind, "resolveTernPane").mockReturnValue(null);
		try {
			await memoryMode.handleBtwCommand("");
			const focus = memoryMode.ui.getFocused();
			if (!focus) throw new Error("Expected history focus");
			const sourceId = memory.sessionId;
			await memoryMode.handleForkCommand();
			expect(memory.sessionId).toBe(sourceId);
			expect(memory.sessionFile).toBeUndefined();
			expect(memoryMode.ui.hasOverlay()).toBe(true);
			expect(memoryMode.ui.getFocused()).toBe(focus);
		} finally {
			memoryMode.stop();
			await memory.dispose();
		}
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
