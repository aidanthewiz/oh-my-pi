import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Loader, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "../../../../tui/test/helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "../../../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

withoutTerminalMultiplexer();

const cleanups: Array<() => void> = [];
const AGENT_START = { type: "agent_start" } as AgentSessionEvent;
const AGENT_END = { type: "agent_end", messages: [] } as AgentSessionEvent;

interface FocusedState {
	mainStreaming: boolean;
	viewStreaming: boolean;
	runId: string;
	phase: "running" | "idle" | "continuing";
	chromeRows: number;
}

interface FocusHarness {
	ctx: InteractiveModeContext;
	state: FocusedState;
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	controller: EventController;
}

function createContext(): FocusHarness {
	const state: FocusedState = {
		mainStreaming: false,
		viewStreaming: false,
		runId: "view-run-1",
		phase: "idle",
		chromeRows: 0,
	};
	const terminal = new VirtualTerminal(100, 30);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const ctx = createInteractiveModeContext({
		ui: composer.ui,
		composer,
		session: {
			get isStreaming() {
				return state.mainStreaming;
			},
			get isRunActive() {
				return state.mainStreaming;
			},
		},
		viewSession: {
			get isStreaming() {
				return state.viewStreaming;
			},
			get isRunActive() {
				return state.phase !== "idle";
			},
			get lifecycleState() {
				return { runId: state.runId, phase: state.phase };
			},
		},
	});
	const loaders: Loader[] = [];
	ctx.ensureLoadingAnimation = () => {
		if (ctx.loadingAnimation) return;
		const loader = new Loader(
			composer.ui,
			text => text,
			text => text,
			"WORKING",
		);
		loaders.push(loader);
		ctx.loadingAnimation = loader;
		ctx.statusContainer.addChild(loader);
	};
	composer.setRuntimeChildren(
		[
			ctx.chatContainer,
			{ render: () => Array.from({ length: state.chromeRows }, (_, i) => `CHROME${i}`) },
			ctx.statusContainer,
			new Text("EDITOR", 0, 0),
		],
		{ coveringChrome: [ctx.statusContainer] },
	);
	composer.start({ playWelcomeIntro: false });
	const controller = new EventController(ctx);
	cleanups.push(() => {
		controller.dispose();
		for (const loader of loaders) loader.stop();
		composer.stop();
	});
	return { ctx, state, terminal, scheduler, composer, controller };
}

async function beginFocusedRun(h: FocusHarness): Promise<Loader> {
	await h.scheduler.settle(h.terminal);
	h.state.phase = "running";
	h.state.viewStreaming = true;
	await h.controller.handleEvent(AGENT_START);
	h.state.chromeRows = 7;
	for (let i = 0; i < 80; i++) h.ctx.chatContainer.addChild({ render: () => [`ROW${i}`] });
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
	const loader = h.ctx.loadingAnimation;
	if (!loader) throw new Error("Expected the focused run's loader");
	return loader;
}

beforeAll(async () => {
	await initTheme(false);
});
beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("focused agent_end ownership", () => {
	it("keeps the actual newer loader and prevents idle chrome retirement after a stale end", async () => {
		const h = createContext();
		const loader = await beginFocusedRun(h);
		const visibleTranscript = h.terminal
			.getScrollBuffer()
			.map(row => row.trim())
			.filter(row => /^ROW\d+$/.test(row));

		await h.controller.handleEvent(AGENT_END);
		await h.scheduler.advance(h.terminal, 300);

		expect(h.ctx.loadingAnimation).toBe(loader);
		expect(h.ctx.statusContainer.children).toContain(loader);
		expect(loader.debugState().running).toBe(true);
		expect(
			h.terminal
				.getScrollBuffer()
				.map(row => row.trim())
				.filter(row => /^ROW\d+$/.test(row)),
		).toEqual(visibleTranscript);
		expect(h.terminal.getViewport().some(row => row.includes("WORKING"))).toBe(true);
		expect(h.terminal.getViewport().map(row => row.trim())).toContain("CHROME6");

		// The current end is legitimate even while its prompt is still unwinding.
		h.state.phase = "idle";
		await h.controller.handleEvent(AGENT_END);
		await h.scheduler.advance(h.terminal, 300);
		expect(h.ctx.loadingAnimation).toBeUndefined();
		expect(loader.debugState().running).toBe(false);
		expect(h.ctx.statusContainer.children).not.toContain(loader);
		const viewport = h.terminal.getViewport().map(row => row.trim());
		expect(viewport).toContain("ROW79");
		expect(viewport).toContain("CHROME0");
		expect(viewport).toContain("CHROME6");
		expect(viewport).toContain("EDITOR");
		expect(viewport.some(row => row.includes("WORKING"))).toBe(false);
	});

	for (const phase of ["idle", "continuing"] as const) {
		it(`preserves continuing work and retires an idle viewed loader while main runs (${phase})`, async () => {
			const h = createContext();
			const loader = await beginFocusedRun(h);
			h.state.mainStreaming = true;
			h.state.phase = phase;
			await h.controller.handleEvent(
				phase === "idle"
					? AGENT_END
					: {
							type: "agent_pause",
							messages: [],
							yielded: false,
							awaiting: false,
						},
			);
			await h.scheduler.advance(h.terminal, 300);
			if (phase === "idle") {
				expect(h.ctx.loadingAnimation).toBeUndefined();
				expect(h.ctx.statusContainer.children).not.toContain(loader);
				expect(loader.debugState().running).toBe(false);
				expect(h.terminal.getViewport().some(row => row.includes("WORKING"))).toBe(false);
			} else {
				expect(h.ctx.loadingAnimation).toBe(loader);
				expect(loader.debugState().running).toBe(true);
			}
		});
	}

	it("does not remove unrelated status work when the completed view has no loader", async () => {
		const h = createContext();
		h.state.mainStreaming = true;
		h.state.phase = "idle";
		const status = new Text("MAIN-STATUS", 0, 0);
		h.ctx.statusContainer.addChild(status);
		await h.controller.handleEvent(AGENT_END);
		expect(h.ctx.statusContainer.children).toContain(status);
	});

	for (const replacement of ["runId", "start", "view-generation", "view"] as const) {
		it(`does not tear down current work after a model-switch await changes ${replacement}`, async () => {
			const h = createContext();
			const loader = await beginFocusedRun(h);
			h.state.phase = "idle";
			h.state.viewStreaming = false;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			h.ctx.flushPendingModelSwitch = async () => {
				entered.resolve();
				await release.promise;
			};
			const ending = h.controller.handleEvent(AGENT_END);
			await entered.promise;
			if (replacement === "runId") h.state.runId = "view-run-2";
			if (replacement === "view-generation") h.controller.resetTranscriptAnchors();
			if (replacement === "view") {
				Object.defineProperty(h.ctx, "viewSession", {
					value: Object.create(h.ctx.viewSession),
					configurable: true,
				});
			}
			h.state.phase = "running";
			h.state.viewStreaming = true;
			if (replacement === "start" || replacement === "view-generation") await h.controller.handleEvent(AGENT_START);
			release.resolve();
			await ending;
			expect(h.ctx.loadingAnimation).toBe(loader);
			expect(h.ctx.statusContainer.children).toContain(loader);
			expect(loader.debugState().running).toBe(true);
		});
	}

	it("drops an old view's end when initialization resumes after reattachment", async () => {
		const h = createContext();
		const loader = await beginFocusedRun(h);
		h.state.phase = "idle";
		h.state.viewStreaming = false;
		h.ctx.isInitialized = false;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		h.ctx.init = async () => {
			entered.resolve();
			await release.promise;
		};
		const ending = h.controller.handleEvent(AGENT_END);
		await entered.promise;
		h.controller.resetTranscriptAnchors();
		h.ctx.isInitialized = true;
		h.state.runId = "reattached-run";
		h.state.phase = "running";
		h.state.viewStreaming = true;
		await h.controller.handleEvent(AGENT_START);
		release.resolve();
		await ending;
		expect(h.ctx.loadingAnimation).toBe(loader);
		expect(loader.debugState().running).toBe(true);
	});

	it("flushes command output at a nonterminal settle without retiring the continuing run", async () => {
		const h = createContext();
		const loader = await beginFocusedRun(h);
		h.state.phase = "continuing";
		h.state.viewStreaming = false;
		const pending = Promise.withResolvers<void>();
		h.ctx.viewSession.waitForIdle = () => pending.promise;
		h.ctx.flushPendingCommandOutput = () => h.ctx.chatContainer.addChild(new Text("COMMAND", 0, 0));
		await h.controller.handleEvent({ type: "agent_pause", messages: [], yielded: false, awaiting: false });
		expect(h.ctx.loadingAnimation).toBe(loader);
		expect(h.ctx.chatContainer.children.some(child => child.render(100).some(row => row.includes("COMMAND")))).toBe(
			true,
		);
		h.controller.resetTranscriptAnchors();
		pending.resolve();
	});
});
