/**
 * Contract: a collab guest mirrors lifecycle-relevant host events into the
 * local extension runner. The guest's own agent loop never runs, so the
 * session's extension-event path stays silent for the whole join — without
 * this mirror, extension-installed lifecycle integrations (e.g. Herdr's
 * pane-state reporter) never observe `agent_start`/`agent_end` and report a
 * stale pane state while the host is streaming or settles.
 *
 * A scripted host socket drives a real CollabGuestLink over the in-memory
 * relay, same contract as the other collab guest tests. Determinism uses the
 * same sentinel-`error`-frame barrier as guest-ui-request.test.ts: frames
 * apply strictly in arrival order, so a barrier after the event frames proves
 * they applied.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { MappedExtensionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/lifecycle-mirror";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { disposeTerminalTitleState, initTerminalTitleState } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { mockWindowsConsoleTitle } from "../terminal-title-test-utils";
import { refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface Harness {
	guest: CollabGuestLink;
	link: string;
	ctx: InteractiveModeContext;
	hostSocket: CollabSocket;
	/** Mock runner receiving the mirrored events; per-test overrides allowed. */
	runner: {
		hasHandlers: (type: string) => boolean;
		emit: (event: MappedExtensionEvent) => Promise<unknown>;
	};
	emitted: MappedExtensionEvent[];

	/** Deterministic apply-chain barrier via a sentinel `error` frame. */
	barrier(): Promise<void>;
	cleanup(): Promise<void>;
}

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		lifecycle: null,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

async function makeHarness(
	roomId: string,
	options: {
		isStreaming?: boolean;
		onLifecycle?: (event: MappedExtensionEvent) => void;
		hostSession?: AgentSession;
		guestSession?: AgentSession;
		guestContext?: InteractiveModeContext;
	} = {},
): Promise<Harness> {
	const roomKey = generateRoomKey();
	const cryptoKey = await importRoomKey(roomKey);
	let link = formatCollabLink("ws://localhost:8788", roomId, roomKey);

	const emitted: MappedExtensionEvent[] = [];
	const runner = {
		hasHandlers: () => true,
		emit: (event: MappedExtensionEvent) => {
			emitted.push(event);
			options.onLifecycle?.(event);
			return Promise.resolve();
		},
	};

	const errorWaiters = new Map<string, () => void>();
	let barrierSeq = 0;
	const barrier = (): Promise<void> => {
		const sentinel = `__barrier_${++barrierSeq}__`;
		const { promise, resolve } = Promise.withResolvers<void>();
		errorWaiters.set(sentinel, resolve);
		const socket = harness.hostSocket;
		socket.send({ t: "error", message: sentinel } as CollabFrame);
		return promise;
	};

	const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
	const hostOpen = Promise.withResolvers<void>();
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = frame => {
		if (frame.t === "hello") {
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
				state: {
					...makeState(),
					isStreaming: options.isStreaming ?? false,
					lifecycle: options.isStreaming ? { runId: "inferred-run", phase: "running" } : null,
				},
				agents: [],
				entryCount: 0,
			} as CollabFrame);
		}
	};
	if (!options.hostSession) {
		hostSocket.connect();
		await hostOpen.promise;
	}

	const ctx = (options.guestContext ?? {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			lifecycleState: null as AgentSession["lifecycleState"],
			setMirroredLifecycleState(state: AgentSession["lifecycleState"]) {
				this.lifecycleState = state;
			},
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
			extensionRunner: runner,
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		ensureLoadingAnimation: () => {},
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: (message: string) => {
			// The guest prefixes host error frames ("Collab host: <message>");
			// match the embedded sentinel.
			for (const [sentinel, waiter] of errorWaiters) {
				if (message.includes(sentinel)) {
					errorWaiters.delete(sentinel);
					waiter();
					return;
				}
			}
		},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve(), takeDisplaceableComponents: () => [] },
		syncRunningSubagentBadge: () => {},
		syncComposerShape: () => {},
		eventBus: new EventBus(),
	}) as unknown as InteractiveModeContext;
	if (options.guestSession) {
		ctx.session = options.guestSession;
		ctx.sessionManager = options.guestSession.sessionManager;
	}
	let host: CollabHost | undefined;
	if (options.hostSession) {
		const hostCtx = {
			...ctx,
			session: options.hostSession,
			sessionManager: options.hostSession.sessionManager,
			statusLine: {
				...ctx.statusLine,
				getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
			},
		} as unknown as InteractiveModeContext;
		host = new CollabHost(hostCtx);
		await host.start("ws://localhost:8788");
		link = host.link;
	}

	const guest = new CollabGuestLink(ctx);
	const harness: Harness = {
		guest,
		link,
		ctx,
		hostSocket,
		runner,
		emitted,
		barrier,
		cleanup: async () => {
			await harness.guest.leave("test cleanup").catch(() => {});
			hostSocket.close();
			await host?.stop("test cleanup");
		},
	};
	await guest.join(link);
	return harness;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.resetForTests();
	installInMemoryRelay();
});

afterEach(() => {
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.resetForTests();
});

describe("collab guest extension lifecycle mirror", () => {
	it("mirrors a real session_stop continuation through host and guest links", async () => {
		const home = TempDir.createSync("@pi-guest-loop-transport-");
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(home.path());
		refreshDirsFromEnv();
		const auth = await AuthStorage.create(":memory:");
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Missing bundled test model");
		auth.keys.setRuntime(model.provider, "synthetic-key");
		const registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
		const makeSettings = (): Settings => {
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			return settings;
		};
		const hostSettings = makeSettings();
		const guestSettings = makeSettings();
		const hostManager = SessionManager.inMemory(home.path());
		const guestManager = SessionManager.inMemory(home.path());
		const hostRuntime = new ExtensionRuntime();
		const guestRuntime = new ExtensionRuntime();
		const bus = new EventBus();
		const hostEvents: MappedExtensionEvent[] = [];
		const guestEvents: MappedExtensionEvent[] = [];
		const publicBoundaries: string[] = [];
		const activeRuns = new Set<string>();
		const paneStates: string[] = [];
		let pane = "idle";
		let stopCalls = 0;
		let modelCalls = 0;
		const secondResponse = Promise.withResolvers<void>();
		const secondStart = Promise.withResolvers<void>();
		const continuing = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const hostExtension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_stop", () =>
					++stopCalls === 1 ? { continue: true, additionalContext: "Continue once." } : undefined,
				);
				pi.on("agent_start", event => {
					hostEvents.push(event);
				});
				pi.on("agent_end", event => {
					hostEvents.push(event);
				});
			},
			home.path(),
			bus,
			hostRuntime,
		);
		const guestExtension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_start", event => {
					guestEvents.push(event);
					activeRuns.add(event.runId);
					pane = "working";
					paneStates.push(pane);
					if (guestEvents.filter(item => item.type === "agent_start").length === 2) secondStart.resolve();
				});
				pi.on("turn_end", event => {
					guestEvents.push(event);
				});
				pi.on("agent_end", event => {
					guestEvents.push(event);
					activeRuns.delete(event.runId);
					pane = event.willContinue || activeRuns.size > 0 ? "working" : "idle";
					paneStates.push(pane);
					if (event.willContinue) continuing.resolve();
					else completed.resolve();
				});
			},
			home.path(),
			bus,
			guestRuntime,
		);
		const hostRunner = new ExtensionRunner(
			[hostExtension],
			hostRuntime,
			home.path(),
			hostManager,
			registry,
			undefined,
			hostSettings,
		);
		const guestRunner = new ExtensionRunner(
			[guestExtension],
			guestRuntime,
			home.path(),
			guestManager,
			registry,
			undefined,
			guestSettings,
		);
		const mock = createMockModel({
			handler: async () => {
				if (++modelCalls === 2) await secondResponse.promise;
				return { content: ["done"], stopReason: "stop" };
			},
		});
		const hostSession = new AgentSession({
			agent: new Agent({
				getApiKey: () => "synthetic-key",
				initialState: { model, systemPrompt: [], tools: [], messages: [] },
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager: hostManager,
			settings: hostSettings,
			modelRegistry: registry,
			extensionRunner: hostRunner,
		});
		const guestSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] }, convertToLlm }),
			sessionManager: guestManager,
			settings: guestSettings,
			modelRegistry: registry,
			extensionRunner: guestRunner,
		});
		hostSession.subscribe(event => {
			if (event.type === "agent_start" || event.type === "agent_end") publicBoundaries.push(event.type);
		});
		let harness: Harness | undefined;
		try {
			harness = await makeHarness("real-loop-transport", { hostSession, guestSession });
			const prompting = hostSession.prompt("Complete one continuation.");
			await continuing.promise;
			await secondStart.promise;
			expect(pane).toBe("working");
			expect(activeRuns.size).toBe(1);
			secondResponse.resolve();
			await prompting;
			await hostSession.waitForIdle();
			await completed.promise;
			const starts = guestEvents.filter(event => event.type === "agent_start");
			const ends = guestEvents.filter(event => event.type === "agent_end");
			expect(starts).toHaveLength(2);
			expect(starts[0].runId).not.toBe(starts[1].runId);
			expect(ends.map(event => event.runId)).toEqual(starts.map(event => event.runId));
			expect(starts.map(event => event.runId)).toEqual(
				hostEvents.filter(event => event.type === "agent_start").map(event => event.runId),
			);
			expect(ends.map(event => event.willContinue === true)).toEqual([true, false]);
			expect(guestEvents.filter(event => event.type === "turn_end").map(event => event.turnIndex)).toEqual([0, 0]);
			expect(paneStates).toEqual(["working", "working", "working", "idle"]);
			expect(pane).toBe("idle");
			expect(activeRuns.size).toBe(0);
			expect(publicBoundaries).toEqual(["agent_start", "agent_start", "agent_end"]);
			expect(hostSession.isStreaming).toBe(false);
			expect(stopCalls).toBe(2);
		} finally {
			secondResponse.resolve();
			await harness?.cleanup();
			await guestSession.dispose();
			await hostSession.dispose();
			auth.close();
			bus.clear();
			homedirSpy.mockRestore();
			refreshDirsFromEnv();
			await home.remove();
		}
	});

	it("keeps a host-owned async wait authoritative across guest completion and reconnect", async () => {
		const home = TempDir.createSync("@pi-guest-async-authority-");
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(home.path());
		refreshDirsFromEnv();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const auth = await AuthStorage.create(":memory:");
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Missing bundled test model");
		auth.keys.setRuntime(model.provider, "synthetic-key");
		const registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
		const jobs = new AsyncJobManager({});
		AsyncJobManager.setInstance(jobs);
		const bus = new EventBus();
		const runtime = new ExtensionRuntime();
		const manager = SessionManager.inMemory(home.path());
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const paused = Promise.withResolvers<AgentSession["lifecycleState"]>();
		let pane = "idle";
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", (event, ctx) => {
					if (!event.willContinue) return;
					const state = ctx.getLifecycleState();
					pane = state?.phase === "continuing" ? "working" : "idle";
					paused.resolve(state);
				});
			},
			home.path(),
			bus,
			runtime,
		);
		const runner = new ExtensionRunner([extension], runtime, home.path(), manager, registry, undefined, settings);
		const makeSession = (agentId: string, extensionRunner?: ExtensionRunner): AgentSession => {
			const mock = createMockModel({ handler: () => ({ content: ["done"], stopReason: "stop" }) });
			return new AgentSession({
				agent: new Agent({
					getApiKey: () => "synthetic-key",
					initialState: { model, systemPrompt: [], tools: [], messages: [] },
					streamFn: mock.stream,
					convertToLlm,
				}),
				agentId,
				asyncJobManager: jobs,
				sessionManager: extensionRunner ? manager : SessionManager.inMemory(home.path()),
				settings,
				modelRegistry: registry,
				extensionRunner,
			});
		};
		const hostSession = makeSession("host-async-owner");
		const guestSession = makeSession("guest-async-owner", runner);
		await initializeExtensions(guestSession, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});
		await initTheme(false);
		const guestContext = createInteractiveModeContext({
			session: guestSession,
			sessionManager: manager,
			settings,
			statusLine: { setCollabStatus: () => {}, resetActiveTime: () => {} },
			resetObserverRegistry: () => {},
			syncRunningSubagentBadge: () => {},
			syncComposerShape: () => {},
			eventBus: bus,
		});
		const controller = new EventController(guestContext);
		const handleEvent = controller.handleEvent.bind(controller);
		spyOn(controller, "handleEvent").mockImplementation(event =>
			event.type === "agent_start" || event.type === "agent_end" ? handleEvent(event) : Promise.resolve(),
		);
		guestContext.eventController = controller;
		const previousHeadless = setTerminalHeadless(false);
		const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const windowsTitle = mockWindowsConsoleTitle();
		windowsTitle.succeeds = true;
		const titles: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			const payload = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
			const title = /\x1b\]0;([\s\S]*?)\x07/.exec(payload)?.[1];
			if (title !== undefined) titles.push(title);
			return true;
		});
		initTerminalTitleState();
		const hostWork = Promise.withResolvers<string>();
		const localWork = Promise.withResolvers<string>();
		let harness: Harness | undefined;
		try {
			harness = await makeHarness("host-async-authority", { hostSession, guestSession, guestContext });
			jobs.register("bash", "held host background work", () => hostWork.promise, {
				id: "host-background",
				ownerId: "host-async-owner",
			});
			await hostSession.prompt("Finish the foreground while the background job is held.");
			const observed = await paused.promise;
			expect(hostSession.hasPendingAsyncWork()).toBe(true);
			expect(guestSession.hasPendingAsyncWork()).toBe(false);
			expect(hostSession.lifecycleState?.phase).toBe("continuing");
			expect(observed).toEqual(hostSession.lifecycleState);
			expect(pane).toBe("working");
			expect([...titles, ...windowsTitle.titles].at(-1)).toMatch(/^π > /);

			await harness.guest.leave("exercise continuing snapshot");
			harness.guest = new CollabGuestLink(guestContext);
			await harness.guest.join(harness.link);
			expect(guestSession.lifecycleState).toEqual(hostSession.lifecycleState);

			await harness.guest.leave("return to a local loop");
			guestSession.setMirroredLifecycleState({ runId: "previous-host", phase: "continuing" });
			jobs.register("bash", "held local background work", () => localWork.promise, {
				id: "local-background",
				ownerId: "guest-async-owner",
			});
			await guestSession.prompt("Finish this local foreground.");
			const localState = guestSession.lifecycleState;
			if (!localState) throw new Error("Local run lost lifecycle ownership");
			expect(localState.phase).toBe("continuing");
			expect(localState.runId).not.toBe("previous-host");
			jobs.acknowledgeDeliveries(["local-background"]);
			jobs.cancel("local-background", { ownerId: "guest-async-owner" });
			localWork.resolve("cancelled");
			await jobs.getJob("local-background")?.promise;
			await guestSession.settleAsyncWork();
			expect(guestSession.lifecycleState).toEqual({ runId: localState.runId, phase: "idle" });
		} finally {
			jobs.acknowledgeDeliveries(["host-background", "local-background"]);
			jobs.cancelAll();
			hostWork.resolve("cancelled");
			localWork.resolve("cancelled");
			await harness?.cleanup();
			await guestSession.dispose();
			await hostSession.dispose();
			auth.close();
			bus.clear();
			controller.dispose();
			disposeTerminalTitleState();
			stdoutSpy.mockRestore();
			windowsTitle.restore();
			if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			setTerminalHeadless(previousHeadless);
			resetSettingsForTest();
			homedirSpy.mockRestore();
			refreshDirsFromEnv();
			await home.remove();
		}
	});

	it("confirms an inferred start with the host ID and recovers a missed completion", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		let pane = "idle";
		let completionActions = 0;
		const activeRuns = new Set<string>();
		const settled = Promise.withResolvers<void>();
		const harness = await makeHarness("lifecycle-mirror-room-2", {
			isStreaming: true,
			onLifecycle: event => {
				if (event.type === "agent_start") {
					activeRuns.add(event.runId);
					pane = "working";
				}
				if (event.type === "agent_end") {
					completionActions++;
					activeRuns.delete(event.runId);
					pane = event.willContinue || activeRuns.size > 0 ? "working" : "idle";
					settled.resolve();
				}
			},
		});
		try {
			expect(pane).toBe("working");
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "inferred-run" } });
			await harness.barrier();
			expect([...activeRuns]).toEqual(["inferred-run"]);
			expect(harness.emitted.filter(event => event.type === "agent_start")).toHaveLength(1);
			harness.hostSocket.send({
				t: "state",
				state: { ...makeState(), lifecycle: { runId: "inferred-run", phase: "idle" } },
			});
			await settled.promise;
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "inferred-run", messages: [], isTerminal: true },
			});
			await harness.barrier();
			expect(completionActions).toBe(1);
			expect(pane).toBe("idle");
			expect(activeRuns.size).toBe(0);
			const end = harness.emitted.find(event => event.type === "agent_end");
			expect(end?.runId).toBe("inferred-run");
		} finally {
			await harness.cleanup();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});

	it("reconciles a different loop without confusing it with inferred confirmation", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const activeRuns = new Set<string>();
		const states: string[] = [];
		const completed = Promise.withResolvers<void>();
		const harness = await makeHarness("lifecycle-new-inferred-loop", {
			isStreaming: true,
			onLifecycle: event => {
				if (event.type === "agent_start") {
					activeRuns.add(event.runId);
					states.push("working");
				} else if (event.type === "agent_end") {
					activeRuns.delete(event.runId);
					states.push(event.willContinue || activeRuns.size > 0 ? "working" : "idle");
					if (!event.willContinue) completed.resolve();
				}
			},
		});
		try {
			harness.hostSocket.send({
				t: "state",
				state: { ...makeState(), isStreaming: true, lifecycle: { runId: "new-loop", phase: "running" } },
			});
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "new-loop" } });
			await harness.barrier();
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "new-loop", messages: [], isTerminal: true },
			});
			await completed.promise;
			expect(harness.emitted.filter(event => event.type === "agent_start").map(event => event.runId)).toEqual([
				"inferred-run",
				"new-loop",
			]);
			expect(harness.emitted.filter(event => event.type === "agent_end").map(event => event.runId)).toEqual([
				"inferred-run",
				"new-loop",
			]);
			expect(states).toEqual(["working", "working", "working", "idle"]);
			expect(activeRuns.size).toBe(0);
		} finally {
			await harness.cleanup();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});

	it("delivers an older completion once while the newer loop stays working across a snapshot", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const activeRuns = new Set<string>();
		const paneStates: string[] = [];
		const completed = Promise.withResolvers<void>();
		const harness = await makeHarness("lifecycle-delayed-completion", {
			onLifecycle: event => {
				if (event.type === "agent_start") {
					activeRuns.add(event.runId);
					paneStates.push("working");
				} else if (event.type === "agent_end") {
					activeRuns.delete(event.runId);
					paneStates.push(event.willContinue || activeRuns.size > 0 ? "working" : "idle");
					if (event.runId === "new") completed.resolve();
				}
			},
		});
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "old" } });
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "new" } });
			harness.hostSocket.send({
				t: "state",
				state: { ...makeState(), isStreaming: true, lifecycle: { runId: "new", phase: "running" } },
			});
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "old", messages: [], isTerminal: true },
			});
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "new", messages: [], isTerminal: true },
			});
			await completed.promise;
			expect(paneStates).toEqual(["working", "working", "working", "idle"]);
			expect(harness.emitted.filter(event => event.type === "agent_start").map(event => event.runId)).toEqual([
				"old",
				"new",
			]);
			expect(harness.emitted.filter(event => event.type === "agent_end").map(event => event.runId)).toEqual([
				"old",
				"new",
			]);
			expect(activeRuns.size).toBe(0);
		} finally {
			await harness.cleanup();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});

	it("recovers a continuation snapshot and closes its ownership on idle", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const activeRuns = new Set<string>();
		const states: string[] = [];
		const completed = Promise.withResolvers<void>();
		const harness = await makeHarness("lifecycle-continuing-snapshot", {
			onLifecycle: event => {
				if (event.type === "agent_start") {
					activeRuns.add(event.runId);
					states.push("working");
				} else if (event.type === "agent_end") {
					activeRuns.delete(event.runId);
					states.push(event.willContinue ? "working" : "idle");
					if (!event.willContinue) completed.resolve();
				}
			},
		});
		try {
			harness.hostSocket.send({
				t: "state",
				state: { ...makeState(), isStreaming: true, lifecycle: { runId: "paused", phase: "continuing" } },
			});
			await harness.barrier();
			harness.hostSocket.send({ t: "state", state: makeState() });
			await completed.promise;
			expect(states).toEqual(["working", "working", "idle"]);
			expect(harness.emitted.filter(event => event.type === "agent_start").map(event => event.runId)).toEqual([
				"paused",
			]);
			expect(harness.emitted.filter(event => event.type === "agent_end").map(event => event.runId)).toEqual([
				"paused",
				"paused",
			]);
			expect(activeRuns.size).toBe(0);
		} finally {
			await harness.cleanup();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});

	it("resets turn numbering on each agent_start like a local session", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-4");
		try {
			harness.runner.hasHandlers = type => type !== "turn_end";
			const assistantMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const runTurns = (): void => {
				harness.hostSocket.send({ t: "event", event: { type: "turn_start" } } as CollabFrame);
				harness.hostSocket.send({
					t: "event",
					event: { type: "turn_end", message: assistantMessage, toolResults: [] },
				} as CollabFrame);
			};
			// Two host prompts, two turns each: a local session numbers both
			// runs 0,1 — the mirror must not keep counting across agent_start.
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "first" } });
			runTurns();
			runTurns();
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "first", messages: [], isTerminal: true },
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "second" } });
			runTurns();
			runTurns();
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "second", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			const starts = harness.emitted.filter(event => event.type === "turn_start");
			expect(starts.map(event => event.turnIndex)).toEqual([0, 1, 0, 1]);
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("detaches message_end payloads from the transcript's live reference", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-5");
		try {
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "live" }],
				api: "mock",
				provider: "mock",
				model: "mock",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			let rendered: AgentMessage | undefined;
			harness.ctx.eventController.handleEvent = async event => {
				if (event.type === "message_end") rendered = event.message;
			};
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message } } as CollabFrame);
			await harness.barrier();

			const ends = harness.emitted.filter(event => event.type === "message_end");
			const delivered = ends[0].message;
			if (delivered.role !== "assistant" || delivered.content[0].type !== "text") {
				throw new Error("Expected assistant text notification");
			}
			delivered.content[0].text = "mutated by extension";
			if (rendered?.role !== "assistant" || rendered.content[0].type !== "text") {
				throw new Error("Expected rendered assistant text");
			}
			expect(rendered.content[0].text).toBe("live");
		} finally {
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("keeps terminal delivery behind a delayed start and survives its failure", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		// The mock runner resolves agent_start on an externally-gated promise;
		// unordered fire-and-forget would let the agent_end handler complete
		// first and relatch the pane to working after the host settled.
		const harness = await makeHarness("lifecycle-mirror-room-6");
		const gate = Promise.withResolvers<void>();
		try {
			const agentEndDelivered = Promise.withResolvers<void>();
			// Order in which handler delivery begins (runner.emit is invoked).
			const deliveryOrder: string[] = [];
			harness.runner.emit = (event: MappedExtensionEvent) => {
				deliveryOrder.push(event.type);
				if (event.type === "agent_start") {
					return gate.promise;
				}
				if (event.type === "agent_end") agentEndDelivered.resolve();
				return Promise.resolve(undefined);
			};
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "delayed" } });
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "delayed", messages: [], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();

			// The gated agent_start must hold agent_end back: emission is
			// chained, so agent_end's handler has not even started yet.
			expect(deliveryOrder).toEqual(["agent_start"]);
			gate.reject(new Error("expected start handler failure"));
			await agentEndDelivered.promise;
			expect(deliveryOrder).toEqual(["agent_start", "agent_end"]);
		} finally {
			gate.resolve();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
		}
	});

	it("drains delayed host handlers before releasing the guest paid-turn guard", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-8");
		const auth = await AuthStorage.create(":memory:");
		const runtime = new ExtensionRuntime();
		const manager = SessionManager.inMemory();
		const registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", async () => {
					started.resolve();
					await release.promise;
					pi.sendUserMessage("HOST_HANDLER_MUST_NOT_START_LOCAL_TURN");
				});
			},
			manager.getCwd(),
			new EventBus(),
			runtime,
		);
		const runner = new ExtensionRunner([extension], runtime, manager.getCwd(), manager, registry);
		const mock = createMockModel({ handler: () => ({ content: ["paid local turn"] }) });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: registry,
			extensionRunner: runner,
		});
		harness.ctx.session = session;
		harness.ctx.sessionManager = manager;
		new ExtensionUiController(harness.ctx).initializeHookRunner({} as ExtensionUIContext, false);
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "guarded" } });
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "guarded", messages: [], isTerminal: true },
			} as CollabFrame);
			await started.promise;
			const leaving = harness.guest.leave("mid-handler");
			await new Promise<void>(resolve => setImmediate(resolve));
			const guestOwnedDuringHandler = harness.ctx.collabGuest === harness.guest;
			release.resolve();
			await leaving;
			await session.waitForAdmittedSubmissions();
			await session.waitForIdle();
			expect(session.messages).toEqual([]);
			expect(mock.calls).toEqual([]);
			expect(guestOwnedDuringHandler).toBe(true);
			expect(harness.ctx.collabGuest).toBeUndefined();
		} finally {
			release.resolve();
			await harness.cleanup();
			await session.dispose();
			auth.close();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});
});
