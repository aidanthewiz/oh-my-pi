import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type } from "@oh-my-pi/omptype";
import type { Component } from "@oh-my-pi/pi-tui";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-control";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { Settings } from "../../../src/config/settings";
import {
	PauseScreenComponent,
	type PauseScreenHost,
	type PauseWorkStatus,
	renderPauseScreen,
	runPauseScreen,
} from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

// Strip SGR colors so assertions see visible text only.
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

interface FakeHost {
	host: PauseScreenHost;
	shown: Component[];
	statuses: string[];
	requestCount(): number;
	hiddenCount(): number;
	waitForRender(predicate: () => boolean): Promise<void>;
}
function makeHost(rows = 24): FakeHost {
	const shown: Component[] = [];
	const statuses: string[] = [];
	let hidden = 0;
	let requests = 0;
	let rendered = Promise.withResolvers<void>();
	const host: PauseScreenHost = {
		ui: {
			showOverlay(component) {
				shown.push(component);
				return {
					hide: () => {
						hidden++;
					},
					setHidden() {},
					isHidden: () => false,
				};
			},
			setFocus() {},
			requestRender() {
				requests++;
				const previous = rendered;
				rendered = Promise.withResolvers<void>();
				previous.resolve();
			},
			terminal: { rows },
		},
		showStatus(message) {
			statuses.push(message);
		},
	};
	return {
		host,
		shown,
		statuses,
		requestCount: () => requests,
		hiddenCount: () => hidden,
		async waitForRender(predicate) {
			while (!predicate()) await rendered.promise;
		},
	};
}

const sessionFixtures: Array<{ session: AgentSession; auth: AuthStorage; release: () => void; runs: Promise<void>[] }> =
	[];

async function makePauseSession(agentId: string, jobs?: AsyncJobManager) {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const executed: string[] = [];
	const marker: AgentTool = {
		name: "pause-marker",
		label: "Pause marker",
		description: "Record execution after the live pause boundary resumes",
		parameters: type({}),
		approval: "read",
		execute: async () => {
			executed.push(agentId);
			return { content: [{ type: "text", text: "Recorded resumed work" }] };
		},
	};
	const mock = createMockModel({
		responses: [
			async () => {
				started.resolve();
				await released.promise;
				return { content: [{ type: "toolCall" as const, name: marker.name, arguments: {} }] };
			},
			{ content: ["resumed"] },
		],
	});
	const agent = new Agent({ initialState: { model: mock.model, tools: [marker] }, streamFn: mock.stream });
	const auth = await AuthStorage.create(":memory:");
	const session = new AgentSession({
		agent,
		agentId,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
		asyncJobManager: jobs,
	});
	const runs: Promise<void>[] = [];
	sessionFixtures.push({ session, auth, release: released.resolve, runs });
	return {
		session,
		async start() {
			runs.push(agent.prompt("work"));
			await started.promise;
		},
		releaseToPause() {
			released.resolve();
		},
		executed,
	};
}
describe("pause screen", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(async () => {
		agentPauseGate.resume();
		setNativeRendering(false);
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		for (const fixture of sessionFixtures.splice(0)) {
			fixture.session.agent.abort();
			fixture.release();
			await Promise.allSettled(fixture.runs);
			await fixture.session.dispose();
			await fixture.auth.close();
		}
	});

	describe("renderPauseScreen", () => {
		it("shows both outstanding counters in the compact ANSI layout while either is positive", () => {
			const lines = renderPauseScreen(48, 12, 3_000, undefined, {
				unsettledTurns: 4,
				unfinishedJobs: 12,
			});
			const text = lines.map(stripAnsi).join("\n");
			expect(lines).toHaveLength(12);
			expect(text).toContain("Pausing — waiting for work to settle");
			expect(text).toContain("Unsettled turns: 4");
			expect(text).toContain("Unfinished jobs: 12");
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(48);
		});
		it("keeps active work counts and resume visible on a five-row compact screen with a session name", () => {
			const lines = renderPauseScreen(48, 5, 3_000, "Long compact session name", {
				unsettledTurns: 1,
				unfinishedJobs: 1,
			});
			const text = lines.map(stripAnsi).join("\n");
			expect(lines).toHaveLength(5);
			expect(text).toContain("Pausing — waiting for work to settle");
			expect(text).toContain("Unsettled turns: 1");
			expect(text).toContain("Unfinished jobs: 1");
			expect(text).toContain("Long compact session name");
			expect(text).toContain("to resume");
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(48);
		});

		it("combines both active counters into one labeled row at three rows", () => {
			const lines = renderPauseScreen(48, 3, 3_000, undefined, {
				unsettledTurns: 1,
				unfinishedJobs: 1,
			});
			const visibleLines = lines.map(stripAnsi);
			expect(lines).toHaveLength(3);
			expect(visibleLines[0]).toContain("Pausing — waiting for work to settle");
			expect(visibleLines[1]).toContain("Turns: 1 · Jobs: 1");
			expect(visibleLines[2]).toContain("to resume");
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(48);
		});

		it("retains active counts and a resume hint in one- and two-row fallbacks", () => {
			for (const height of [1, 2]) {
				const lines = renderPauseScreen(48, height, 3_000, undefined, {
					unsettledTurns: 1,
					unfinishedJobs: 2,
				});
				const text = lines.map(stripAnsi).join("\n");
				expect(lines).toHaveLength(height);
				expect(text).toContain("T:1");
				expect(text).toContain("J:2");
				expect(text).toContain("to resume");
				for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(48);
			}
		});

		it("keeps abbreviated active counts and resume visible on a 16-column one-row screen", () => {
			const lines = renderPauseScreen(16, 1, 3_000, undefined, {
				unsettledTurns: 1,
				unfinishedJobs: 2,
			});
			const text = lines.map(stripAnsi).join("\n");
			expect(lines).toHaveLength(1);
			expect(text).toContain("T1");
			expect(text).toContain("J2");
			expect(text).toContain("resume");
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(16);
		});

		it("keeps resume visible without counters on a settled 16-column one-row screen", () => {
			const lines = renderPauseScreen(16, 1, 3_000);
			const text = lines.map(stripAnsi).join("\n");
			expect(lines).toHaveLength(1);
			expect(text).toContain("resume");
			expect(text).not.toMatch(/\bT:?\d|\bJ:?\d/);
			for (const line of lines) expect(Bun.stringWidth(stripAnsi(line))).toBeLessThanOrEqual(16);
		});

		it("drops to the compact card on small terminals", () => {
			const lines = renderPauseScreen(40, 10, 3_000);
			expect(lines.length).toBe(10);
			const text = lines.map(stripAnsi).join("\n");
			expect(text).toContain("▌▌ P A U S E D");
			expect(text).toContain("paused for 0:03");
			expect(text).not.toContain("█".repeat(5)); // no room for the big glyph
		});

		it("paints the full scene with glyph, title, explainer, hours clock, and resume hint", () => {
			const lines = renderPauseScreen(80, 24, 3_725_000).map(stripAnsi);
			const text = lines.join("\n");
			expect(lines).toHaveLength(24);
			expect(text).toContain("█".repeat(5));
			expect(text).toContain("P A U S E D");
			expect(text).toContain("Main agent, subagents, and advisor");
			expect(text).toContain("Paused — ready to suspend");
			expect(text).toContain("paused for 1:02:05");
			expect(text).toContain("— resume");
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
		});
	});
	it("stops waiting only after live turns park and advisor work is parked or yielded", async () => {
		const root = await makePauseSession("Main");
		const child = await makePauseSession("Main/worker");
		const stale = await makePauseSession("Main/stale-worker");
		await root.start();
		await child.start();
		const advisorStatus = {
			name: "Review",
			status: "running" as const,
			yielded: false,
			backlog: 1,
			isPaused: false,
		};
		vi.spyOn(root.session, "getAdvisorStatusOverview").mockImplementation(() => ({
			configured: true,
			advisors: [advisorStatus],
		}));
		for (const [id, session] of [
			["Main/worker", child.session],
			["Main/stale-worker", stale.session],
		] as const) {
			AgentRegistry.global().register({ id, displayName: id, kind: "sub", status: "running", session });
		}
		const { host, shown, waitForRender } = makeHost();
		const runtime: TuiSlashCommandRuntime = {
			draftDetached: true,
			ctx: createInteractiveModeContext({
				session: root.session,
				sessionManager: root.session.sessionManager,
				settings: root.session.settings,
				ui: {
					showOverlay: host.ui.showOverlay,
					requestRender: host.ui.requestRender,
					terminal: host.ui.terminal,
				},
				showStatus: host.showStatus,
			}),
		};
		const pause = BUILTIN_CONTROL_SLASH_COMMANDS.find(command => command.name === "pause");
		if (!pause?.handleTui) throw new Error("expected /pause TUI handler");
		const running = pause.handleTui({ name: "pause", args: "", text: "/pause" }, runtime);
		const component = shown[0];
		if (!(component instanceof PauseScreenComponent)) throw new Error("expected /pause screen");
		const screen = () => component.render(80).map(stripAnsi).join("\n");
		try {
			expect(screen()).toContain("Unsettled turns: 3");
			expect(screen()).toContain("Unfinished jobs: 0");
			root.releaseToPause();
			advisorStatus.yielded = true;
			await waitForRender(() => root.session.agent.isPaused);
			expect(root.executed).toEqual([]);
			expect(screen()).toContain("Unsettled turns: 1");
			child.releaseToPause();
			await waitForRender(() => child.session.agent.isPaused);
			expect(child.executed).toEqual([]);
			expect(screen()).not.toContain("Unsettled turns:");
			expect(screen()).not.toContain("Unfinished jobs:");
			advisorStatus.yielded = false;
			await waitForRender(() => screen().includes("Unsettled turns: 1"));
			expect(screen()).toContain("Unsettled turns: 1");
			advisorStatus.isPaused = true;
			await waitForRender(() => !screen().includes("Unsettled turns:"));
			expect(screen()).not.toContain("Unsettled turns:");
			expect(screen()).not.toContain("Unfinished jobs:");
		} finally {
			component.handleInput("\r");
			await running;
		}
	});

	it("counts child advisor backlog and pre-live, retired, and non-task jobs without double-counting a live task", async () => {
		const jobs = new AsyncJobManager({});
		const root = await makePauseSession("Main", jobs);
		const child = await makePauseSession("Main/parked", jobs);
		await child.start();
		const childAdvisor = { name: "Review", status: "running" as const, yielded: false, backlog: 1, isPaused: false };
		vi.spyOn(child.session, "getAdvisorStatusOverview").mockImplementation(() => ({
			configured: true,
			advisors: [childAdvisor],
		}));
		AgentRegistry.global().register({
			id: "Main/parked",
			displayName: "parked",
			kind: "sub",
			status: "running",
			session: child.session,
		});
		AgentRegistry.global().register({
			id: "Main/starting",
			displayName: "starting",
			kind: "sub",
			status: "running",
			session: null,
		});
		const releases = Array.from({ length: 3 }, () => Promise.withResolvers<string>());
		const task = jobs.register("task", "parked", () => releases[0]!.promise, {
			ownerId: "Main",
			agentId: "Main/parked",
		});
		const starting = jobs.register("task", "starting", () => releases[1]!.promise, {
			ownerId: "Main",
			agentId: "Main/starting",
		});
		const bash = jobs.register("bash", "shell", () => releases[2]!.promise, {
			ownerId: "Main",
		});
		const { host, shown, waitForRender } = makeHost();
		const runtime: TuiSlashCommandRuntime = {
			draftDetached: true,
			ctx: createInteractiveModeContext({
				session: root.session,
				sessionManager: root.session.sessionManager,
				settings: root.session.settings,
				ui: {
					showOverlay: host.ui.showOverlay,
					requestRender: host.ui.requestRender,
					terminal: host.ui.terminal,
				},
				showStatus: host.showStatus,
			}),
		};
		const pause = BUILTIN_CONTROL_SLASH_COMMANDS.find(command => command.name === "pause");
		if (!pause?.handleTui) throw new Error("expected /pause TUI handler");
		const done = pause.handleTui({ name: "pause", args: "", text: "/pause" }, runtime);
		const component = shown[0];
		if (!(component instanceof PauseScreenComponent)) throw new Error("expected /pause screen");
		const screen = () => component.render(80).map(stripAnsi).join("\n");
		try {
			child.releaseToPause();
			await waitForRender(() => child.session.agent.isPaused);
			expect(child.executed).toEqual([]);
			expect(screen()).toContain("Unsettled turns: 1");
			expect(screen()).toContain("Unfinished jobs: 2");
			AgentRegistry.global().unregister("Main/parked");
			await waitForRender(() => screen().includes("Unfinished jobs: 3"));
			expect(screen()).toContain("Unsettled turns: 0");
			expect(screen()).toContain("Unfinished jobs: 3");
			jobs.cancel(starting);
			jobs.cancel(bash);
			await waitForRender(() => screen().includes("Unfinished jobs: 1"));
			expect(screen()).toContain("Unfinished jobs: 1");
			jobs.cancel(task);
			await waitForRender(() => !screen().includes("Unfinished jobs:"));
			expect(screen()).not.toContain("Unsettled turns:");
			expect(screen()).not.toContain("Unfinished jobs:");
		} finally {
			component.handleInput("\r");
			await done;
			for (const release of releases) release.resolve("done");
			await Promise.all([task, starting, bash].map(id => jobs.getJob(id)?.promise));
			await jobs.dispose();
		}
	});

	describe("native sheet", () => {
		// Every described node, depth-first (components inside are not walked).
		const nodes = (root: NativeChild): NativeNode[] => {
			if (!("k" in root)) return [];
			return [root, ...(root.c ?? []).flatMap(nodes)];
		};
		const texts = (root: NativeNode): string =>
			nodes(root)
				.map(n => {
					const p = n.p as { text?: string; spans?: { t: string }[] } | undefined;
					return p?.text ?? p?.spans?.map(s => s.t).join("") ?? "";
				})
				.join("\n");
		const countRoles: Record<string, true> = {
			"omp.pause.unsettled-turn-count": true,
			"omp.pause.unfinished-job-count": true,
		};
		const countNodes = (root: NativeChild): NativeNode[] =>
			nodes(root).filter(n => countRoles[(n.p as { role?: string } | undefined)?.role ?? ""] === true);
		const wireNodes = (root: TspNode): TspNode[] => [root, ...(root.c ?? []).flatMap(wireNodes)];
		const wireCountNodes = (root: TspNode): TspNode[] =>
			wireNodes(root).filter(n => countRoles[(n.p as { role?: string } | undefined)?.role ?? ""] === true);

		it("shows outstanding status and counts in semantic text nodes", () => {
			const { host } = makeHost();
			const sheet = new PauseScreenComponent(
				{ ...host, sessionName: "Credit backpressure" },
				{ getWorkStatus: () => ({ unsettledTurns: 0, unfinishedJobs: 2 }) },
			);
			const root = sheet.describe();
			const shown = texts(root);
			expect(shown).toContain("Credit backpressure");
			expect(shown).toContain("Pausing — waiting for work to settle");
			expect(shown).toContain("Unsettled turns: 0");
			expect(shown).toContain("Unfinished jobs: 2");
		});

		it("hides both counter rows at zero and restores them on late work in both layouts", async () => {
			vi.useFakeTimers();
			setNativeRendering(false);
			const work: PauseWorkStatus = { unsettledTurns: 0, unfinishedJobs: 1 };
			const { host, requestCount } = makeHost(24);
			const sheet = new PauseScreenComponent(host, { getWorkStatus: () => work });
			const layouts = () => [80, 48].map(width => sheet.render(width).map(stripAnsi).join("\n"));
			const counters = ["Unsettled turns:", "Unfinished jobs:"];
			for (const text of layouts()) {
				expect(text).toContain("Pausing — waiting for work to settle");
				for (const counter of counters) expect(text).toContain(counter);
			}

			const running = sheet.run();
			try {
				work.unfinishedJobs = 0;
				vi.advanceTimersByTime(1_000);
				const zeroLayouts = layouts();
				for (const zero of zeroLayouts) {
					expect(zero).toContain("Paused — ready to suspend");
					for (const counter of counters) expect(zero).not.toContain(counter);
					expect(zero).toContain("paused for");
					expect(zero).toContain("resume");
				}
				const rendersAtZero = requestCount();

				work.unsettledTurns = 1;
				vi.advanceTimersByTime(1_000);
				for (const lateWork of layouts()) {
					expect(lateWork).toContain("Pausing — waiting for work to settle");
					expect(lateWork).toContain("Unsettled turns: 1");
					expect(lateWork).toContain("Unfinished jobs: 0");
				}
				expect(requestCount()).toBeGreaterThan(rendersAtZero);
			} finally {
				sheet.handleInput("\r");
				sheet.dispose();
				await running;
			}
		});

		it("invalidates the cached native tree and deletes and restores counter rows as counts change", async () => {
			vi.useFakeTimers();
			setNativeRendering(true);
			const work: PauseWorkStatus = { unsettledTurns: 0, unfinishedJobs: 1 };
			const { host, requestCount } = makeHost();
			const sheet = new PauseScreenComponent(host, { getWorkStatus: () => work });
			const context: DescribeContext = {
				cols: 80,
				reduceMotion: false,
				dark: true,
				supports: () => true,
				feature: () => true,
			};
			const reconciler = new Reconciler("pause");
			const document = new TspDocument("pause");
			const regions = { main: [], dock: [], layer: [sheet] };
			let sequence = 0;
			const reconcile = () => {
				const ops = reconciler.reconcile(regions, context);
				expect(document.applyFrame({ sf: document.surface, s: ++sequence, ops })).toEqual([]);
				return ops;
			};
			const initial = sheet.describe();
			expect(sheet.describe()).toBe(initial);
			reconcile();
			const initialCountIds = wireCountNodes(document.snapshot()).map(n => n.id);
			expect(initialCountIds).toHaveLength(2);

			const running = sheet.run();
			const requestsBeforeZero = requestCount();
			try {
				work.unfinishedJobs = 0;
				vi.advanceTimersByTime(1_000);
				const zero = sheet.describe();
				const zeroOps = reconcile();
				expect(zero).not.toBe(initial);
				expect(texts(zero)).toContain("Paused — ready to suspend");
				const zeroNodes = nodes(zero);
				expect(zeroNodes.some(n => n.k === "elapsed")).toBe(true);
				const zeroButtons = zeroNodes.filter(n => (n.p as { role?: string } | undefined)?.role === "omp.btn");
				expect(zeroButtons).toHaveLength(1);
				expect(zeroButtons[0]!.p).toMatchObject({ tone: "accent", actions: { click: "resume" } });
				expect(countNodes(zero)).toHaveLength(0);
				expect(wireCountNodes(document.snapshot())).toHaveLength(0);
				for (const id of initialCountIds) expect(zeroOps).toContainEqual(["del", id]);
				expect(requestCount()).toBeGreaterThan(requestsBeforeZero);
				const requestsAtZero = requestCount();

				vi.advanceTimersByTime(1_000);
				expect(sheet.describe()).toBe(zero);
				expect(requestCount()).toBe(requestsAtZero);

				work.unsettledTurns = 1;
				vi.advanceTimersByTime(1_000);
				const lateWork = sheet.describe();
				const lateWorkOps = reconcile();
				expect(lateWork).not.toBe(zero);
				expect(texts(lateWork)).toContain("Pausing — waiting for work to settle");
				expect(countNodes(lateWork)).toHaveLength(2);
				expect(wireCountNodes(document.snapshot())).toHaveLength(2);
				expect(
					lateWorkOps.flatMap(op => (op[0] === "add" ? wireCountNodes(op[4]) : [])).map(n => n.p?.role),
				).toEqual(expect.arrayContaining(["omp.pause.unsettled-turn-count", "omp.pause.unfinished-job-count"]));
				expect(texts(lateWork)).toContain("Unsettled turns: 1");
				expect(texts(lateWork)).toContain("Unfinished jobs: 0");
				const buttons = wireNodes(document.snapshot()).filter(
					n => (n.p as { role?: string } | undefined)?.role === "omp.btn",
				);
				expect(buttons).toHaveLength(1);
				expect(buttons[0]!.p).toMatchObject({ tone: "accent", actions: { click: "resume" } });
				expect(requestCount()).toBeGreaterThan(requestsAtZero);
			} finally {
				sheet.handleInput("\r");
				sheet.dispose();
				await running;
			}
		});

		it("resumes from the Resume button", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host); // shows the sheet synchronously, before its first await
			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleNativeEvent({ type: "action", key: "actions/resume", act: "resume", mods: [] });
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});
	});

	describe("runPauseScreen", () => {
		it("engages the gate for the screen's lifetime and releases it on escape", async () => {
			const { host, shown, statuses, hiddenCount } = makeHost();
			expect(agentPauseGate.paused).toBe(false);

			const run = runPauseScreen(host);
			await Bun.sleep(1);
			expect(agentPauseGate.paused).toBe(true);
			expect(shown.length).toBe(1);

			const component = shown[0];
			expect(component).toBeInstanceOf(PauseScreenComponent);
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x1b"); // escape → resume
			}
			await run;

			expect(agentPauseGate.paused).toBe(false);
			expect(hiddenCount()).toBe(1);
			expect(statuses.some(message => message.includes("Resumed after"))).toBe(true);
		});

		it("treats ctrl+c as resume, never as abort-and-stay-paused", async () => {
			const { host, shown } = makeHost();
			const run = runPauseScreen(host);
			await Bun.sleep(1);

			const component = shown[0];
			if (component instanceof PauseScreenComponent) {
				component.handleInput("\x03"); // ctrl+c
			}
			await run;
			expect(agentPauseGate.paused).toBe(false);
		});

		it("releases the owned gate when reading the initial work snapshot fails", async () => {
			const { host, shown } = makeHost();
			await expect(
				runPauseScreen(host, {
					getWorkStatus() {
						throw new Error("snapshot failed");
					},
				}),
			).rejects.toThrow("snapshot failed");
			expect(shown).toEqual([]);
			expect(agentPauseGate.paused).toBe(false);
		});

		it("releases the owned gate when overlay creation or teardown fails", async () => {
			for (const phase of ["creation", "teardown"]) {
				const { host } = makeHost();
				host.ui.showOverlay = component => {
					if (phase === "creation") throw new Error(phase);
					if (component instanceof PauseScreenComponent) component.handleInput("\r");
					return {
						hide() {
							throw new Error(phase);
						},
						setHidden() {},
						isHidden: () => false,
					};
				};
				await expect(runPauseScreen(host)).rejects.toThrow(phase);
				expect(agentPauseGate.paused).toBe(false);
			}
		});

		it("is a no-op when the gate is already engaged elsewhere", async () => {
			agentPauseGate.pause();
			const { host, shown } = makeHost();
			await runPauseScreen(host); // must resolve immediately, not park
			expect(shown.length).toBe(0);
			expect(agentPauseGate.paused).toBe(true); // foreign pause not stolen
		});
	});
});
