import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Extension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { cfgExtensionAssistantTextRenderers } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgTuiAutoGraph } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgPlanDefaultOnStartup } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StreamPublisher } from "@oh-my-pi/pi-coding-agent/stream/publisher";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const toolCallId = "call-reply";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage,
		timestamp: 1,
	};
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

describe("tool reply transcript ownership and renderer invalidation", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let runner: ExtensionRunner;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		temp = TempDir.createSync("@pi-reply-replay-");
		await Settings.init({ inMemory: true, cwd: temp.path() });
		HistoryStorage.close();
		HistoryStorage.open(path.join(temp.path(), "history.db"));
		auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const sessionManager = SessionManager.create(temp.path(), temp.path());
		await sessionManager.setSessionName("Reply replay fixture", "user");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		vi.spyOn(session, "prewarmModelConnection").mockImplementation(() => {});
		vi.spyOn(StreamPublisher, "connectLazy").mockResolvedValue(null);
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const terminal = new VirtualTerminal(120, 32);
		mode = new InteractiveMode(
			session,
			"test",
			() => {},
			undefined,
			undefined,
			new EventBus(),
			new Composer({ terminal }),
		);
		cfgTuiAutoGraph.set(mode.settings, "off");
		cfgPlanDefaultOnStartup.set(mode.settings, false);
		cfgExtensionAssistantTextRenderers.set(mode.settings, true);
		const extension: Extension = {
			path: "/test/reply-renderer.ts",
			resolvedPath: "/test/reply-renderer.ts",
			handlers: new Map(),
			tools: new Map(),
			assistantThinkingRenderers: [],
			assistantTextRenderers: [({ text }) => text.replace("now", "NOW")],
			transcriptPresenters: [],
			linkSchemes: [],
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			messageRenderers: new Map(),
			composerShapes: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		runner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			temp.path(),
			sessionManager,
			registry,
			undefined,
			mode.settings,
		);
		Object.defineProperty(session, "extensionRunner", { configurable: true, get: () => runner });
		await mode.init({ suppressWelcomeIntro: true });
		await nextTurn();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		HistoryStorage.close();
		await auth?.close();
		vi.restoreAllMocks();
		temp?.removeSync();
		resetSettingsForTest();
	});

	const chat = () =>
		mode.chatContainer
			.render(120)
			.map(row => Bun.stripANSI(row))
			.join("\n");
	const copies = (marker: string) => chat().split(marker).length - 1;
	const update = (replies: string[]): AgentSessionEvent => ({
		type: "tool_execution_update",
		toolCallId,
		toolName: "bash",
		args: { command: ":" },
		partialResult: {
			content: [{ type: "text", text: "synthetic output" }],
			details: { replies },
		},
	});

	async function start() {
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		await mode.eventController.handleEvent({
			type: "tool_execution_start",
			toolCallId,
			toolName: "bash",
			args: { command: ":" },
		});
	}

	function persist(replies: string[], running = false) {
		session.sessionManager.appendMessage({
			...assistant(""),
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: ":" } }],
			stopReason: "toolUse",
		});
		session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "synthetic output" }],
			details: { replies, ...(running ? { async: { state: "running", jobId: "synthetic-job" } } : {}) },
			isError: false,
			timestamp: 2,
		});
	}

	it.each([false, true])(
		"R140TuiHost1: replays each reply once around queued completion (partial=%s)",
		async partial => {
			await start();
			const replies = ["reply_alpha now.", "reply_beta now."];
			if (partial) await mode.eventController.handleEvent(update(replies));
			expect(copies("reply_alpha NOW.")).toBe(partial ? 1 : 0);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const blocker = update([]);
			const controller = mode.eventController;
			const handle = controller.handleEvent.bind(controller);
			const held = vi.spyOn(controller, "handleEvent").mockImplementation(async event => {
				if (event === blocker) {
					entered.resolve();
					await release.promise;
				}
				await handle(event);
			});
			const blocked = controller.dispatchSessionEvent(blocker);
			let completion: Promise<void> | undefined;
			try {
				await entered.promise;
				completion = controller.dispatchSessionEvent({
					type: "tool_execution_end",
					toolCallId,
					toolName: "bash",
					result: { content: [{ type: "text", text: "synthetic output" }], details: { replies } },
					isError: false,
				});
				persist(replies);
				const history = JSON.stringify(session.sessionManager.getEntries());
				for (let pass = 0; pass < 2; pass++) {
					mode.rebuildChatFromMessages();
					expect(copies("reply_alpha NOW.")).toBe(1);
					expect(copies("reply_beta NOW.")).toBe(1);
					expect(chat().indexOf("reply_alpha")).toBeLessThan(chat().indexOf("reply_beta"));
				}
				expect(JSON.stringify(session.sessionManager.getEntries())).toBe(history);
			} finally {
				release.resolve();
				try {
					await Promise.all([blocked, completion]);
				} finally {
					held.mockRestore();
				}
			}
			expect(copies("reply_alpha NOW.")).toBe(1);
			expect(copies("reply_beta NOW.")).toBe(1);
			expect(mode.pendingTools.has(toolCallId)).toBe(false);
		},
	);

	it("R140TuiHost1: preserves unreplayed replies and suppressed running snapshots", async () => {
		await start();
		await mode.eventController.handleEvent(update(["live_alpha now."]));
		mode.rebuildChatFromMessages();
		expect(copies("live_alpha NOW.")).toBe(1);
		persist(["live_alpha now."], true);
		mode.rebuildChatFromMessages();
		expect(copies("live_alpha NOW.")).toBe(1);
		await mode.eventController.handleEvent(update(["live_alpha now.", "live_beta now."]));
		mode.rebuildChatFromMessages();
		expect(copies("live_alpha NOW.")).toBe(1);
		expect(copies("live_beta NOW.")).toBe(1);
		expect(chat().indexOf("live_alpha")).toBeLessThan(chat().indexOf("live_beta"));
		expect(mode.pendingTools.has(toolCallId)).toBe(true);
	});

	it("R140TuiHost1: permits the same call id to draw fresh replies after transcript reset", async () => {
		await start();
		await mode.eventController.handleEvent(update(["old_turn now."]));
		mode.eventController.resetTranscriptAnchors();
		mode.chatContainer.clear();
		await start();
		await mode.eventController.handleEvent(update(["reused_id now."]));
		expect(copies("reused_id NOW.")).toBe(1);
		expect(chat()).not.toContain("old_turn");
	});

	it.each(["setting", "suspension"])(
		"R140TuiHost2: refreshes live replies immediately after renderer %s",
		async change => {
			await mode.renderInitialMessages();
			await start();
			await mode.eventController.handleEvent(update(["literal_live now."]));
			expect(copies("literal_live NOW.")).toBe(1);
			if (change === "setting") cfgExtensionAssistantTextRenderers.set(mode.settings, false);
			else runner.setSuspendedExtensions(() => true);
			await nextTurn();
			expect(copies("literal_live now.")).toBe(1);
			expect(chat()).not.toContain("literal_live NOW.");
			expect(mode.pendingTools.has(toolCallId)).toBe(true);
			await mode.eventController.handleEvent(update(["literal_live now.", "next_live now."]));
			expect(copies("literal_live now.")).toBe(1);
			expect(copies("next_live now.")).toBe(1);
			expect(chat().indexOf("literal_live")).toBeLessThan(chat().indexOf("next_live"));
			if (change === "setting") cfgExtensionAssistantTextRenderers.set(mode.settings, true);
			else runner.setSuspendedExtensions(() => false);
			await nextTurn();
			expect(copies("literal_live NOW.")).toBe(1);
			expect(copies("next_live NOW.")).toBe(1);
			expect(chat()).not.toContain("literal_live now.");
		},
	);

	it.each(["initial", "replacement"])(
		"R140TuiHost2: changes settings at a real %s replay yield without duplicating its suffix",
		async replay => {
			if (replay === "replacement") await mode.renderInitialMessages();
			const messages = Array.from({ length: 65 }, (_, index) =>
				assistant(`unique_${index.toString().padStart(3, "0")} now.`),
			);
			for (const message of messages) session.sessionManager.appendMessage(message);
			const history = JSON.stringify(session.sessionManager.getEntries());
			const incremental = mode.renderSessionContextIncrementally.bind(mode);
			let changed = false;
			mode.renderSessionContextIncrementally = (context, options, chunk) =>
				incremental(context, options, () => {
					chunk?.();
					if (changed) return;
					changed = true;
					cfgExtensionAssistantTextRenderers.set(mode.settings, false);
				});
			try {
				await mode.renderInitialMessages();
			} finally {
				mode.renderSessionContextIncrementally = incremental;
			}
			expect(changed).toBe(true);
			const rendered = chat();
			let previous = -1;
			for (let index = 0; index < messages.length; index++) {
				const marker = `unique_${index.toString().padStart(3, "0")} now.`;
				expect(rendered.split(marker).length - 1).toBe(1);
				const position = rendered.indexOf(marker);
				expect(position).toBeGreaterThan(previous);
				previous = position;
			}
			expect(rendered).not.toContain("NOW");
			expect(JSON.stringify(session.sessionManager.getEntries())).toBe(history);
		},
	);
});
