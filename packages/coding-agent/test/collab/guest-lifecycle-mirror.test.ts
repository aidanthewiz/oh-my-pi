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
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionLifecycleEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import type { MappedExtensionEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/lifecycle-mirror";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { PROPOSE_COMMAND_NAME } from "@oh-my-pi/pi-tui/tools/resolve";
import { cfgSpeechEnabled, cfgSpeechMode } from "@oh-my-pi/pi-coding-agent/tts/settings";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { cfgCompletionNotify, cfgErrorNotify } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { settings as runtimeSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";
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
		beforeGuestJoin?: () => Promise<void>;
		eventController?: EventController;
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
		pendingShellContainer: { clear: () => {} },
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
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: options.eventController ?? {
			dispatchSessionEvent: () => Promise.resolve(),
			drainSessionEvents: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		syncRunningSubagentBadge: () => {},
		syncComposerShape: () => {},
		syncExtensionLinks: () => {},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
		eventBus: new EventBus(),
	}) as unknown as InteractiveModeContext;
	const showError = ctx.showError.bind(ctx);
	ctx.showError = message => {
		for (const [sentinel, waiter] of errorWaiters) {
			if (message.includes(sentinel)) {
				errorWaiters.delete(sentinel);
				waiter();
				return;
			}
		}
		showError(message);
	};
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
	await options.beforeGuestJoin?.();
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
	it("distinguishes scheduled continuations from background waits in mirrored agent_end events", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-async-wait");
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "scheduled" } });
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "scheduled", messages: [], isTerminal: false },
			});
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "background" } });
			harness.hostSocket.send({
				t: "event",
				event: {
					type: "agent_end",
					runId: "background",
					messages: [],
					isTerminal: false,
					awaitingAsyncWork: true,
				},
			});
			await harness.barrier();
			const ends = harness.emitted.filter(event => event.type === "agent_end");
			expect(ends).toEqual([
				expect.objectContaining({ runId: "scheduled", willContinue: true }),
				expect.objectContaining({ runId: "background", willContinue: true, awaitingAsyncWork: true }),
			]);
			expect(ends[0]).not.toHaveProperty("awaitingAsyncWork");
		} finally {
			await harness.cleanup();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});

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
			await auth.close();
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
		cfgCompletionNotify.set(runtimeSettings, "on");
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
		const foregroundStarted = Promise.withResolvers<void>();
		const foregroundResponse = Promise.withResolvers<void>();
		let hostModelCalls = 0;
		const makeSession = (agentId: string, extensionRunner?: ExtensionRunner): AgentSession => {
			const mock = createMockModel({
				handler: async () => {
					if (agentId === "host-async-owner") {
						hostModelCalls++;
						foregroundStarted.resolve();
						await foregroundResponse.promise;
					}
					return { content: ["done"], stopReason: "stop" };
				},
			});
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
		const guestWithoutExtensions = makeSession("guest-without-extensions");
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
			syncRunningSubagentBadge: () => false,
			syncComposerShape: () => {},
			eventBus: bus,
		});
		const controller = new EventController(guestContext);
		const handleEvent = controller.handleEvent.bind(controller);
		const modelWorking = Promise.withResolvers<void>();
		let renderedBoundary = Promise.resolve();
		spyOn(controller, "handleEvent").mockImplementation(event => {
			renderedBoundary = handleEvent(event);
			if (event.type === "agent_start") void renderedBoundary.then(() => modelWorking.resolve());
			return renderedBoundary;
		});
		guestContext.eventController = controller;
		const notifications: Parameters<typeof TERMINAL.sendNotification>[0][] = [];
		const completedNotification = Promise.withResolvers<void>();
		const notificationSpy = spyOn(TERMINAL, "sendNotification").mockImplementation(notification => {
			notifications.push(notification);
			completedNotification.resolve();
		});
		const hostWork = Promise.withResolvers<string>();
		const localWork = Promise.withResolvers<string>();
		const originalSend = CollabSocket.prototype.send;
		let guestSocket: CollabSocket | undefined;
		let hostSocket: CollabSocket | undefined;
		let physicalPause: Extract<AgentSessionLifecycleEvent, { type: "agent_end" }> | undefined;
		let dropPause = false;
		const sendSpy = spyOn(CollabSocket.prototype, "send").mockImplementation(
			function (this: CollabSocket, wireFrame, peer) {
				const frame: CollabFrame = typeof wireFrame === "string" ? JSON.parse(wireFrame) : wireFrame;
				if (frame.t === "hello") guestSocket = this;
				if (dropPause && frame.t === "event" && frame.event.type === "agent_end") {
					physicalPause = frame.event;
					hostSocket = this;
					return true;
				}
				return originalSend.call(this, wireFrame, peer);
			},
		);
		const originalBroadcastAdvisory = CollabSocket.prototype.broadcastAdvisory;
		const advisorySpy = spyOn(CollabSocket.prototype, "broadcastAdvisory").mockImplementation(
			function (this: CollabSocket, wireFrame) {
				const frame: CollabFrame = typeof wireFrame === "string" ? JSON.parse(wireFrame) : wireFrame;
				if (dropPause && frame.t === "state" && frame.state.lifecycle?.phase === "continuing") return true;
				return originalBroadcastAdvisory.call(this, wireFrame);
			},
		);
		let snapshotApplied = Promise.withResolvers<void>();
		const renderSpy = spyOn(guestContext, "renderInitialMessages").mockImplementation(async () => {
			snapshotApplied.resolve();
		});
		const latePauseApplied = Promise.withResolvers<void>();
		const showError = guestContext.showError.bind(guestContext);
		const errorSpy = spyOn(guestContext, "showError").mockImplementation(message => {
			if (message.includes("__late_pause_applied__")) latePauseApplied.resolve();
			else showError(message);
		});
		let harness: Harness | undefined;
		let prompting: Promise<boolean> | undefined;
		try {
			jobs.register("bash", "held host background work", () => hostWork.promise, {
				id: "host-background",
				ownerId: "host-async-owner",
			});
			harness = await makeHarness("host-async-authority", {
				hostSession,
				guestSession,
				guestContext,
				beforeGuestJoin: async () => {
					prompting = hostSession.prompt("Finish the foreground while the background job is held.");
					await foregroundStarted.promise;
				},
			});
			if (!prompting) throw new Error("Host foreground did not start before guest join");
			await modelWorking.promise;
			if (!guestSocket?.onOpen) throw new Error("Missing guest reconnect handshake");
			snapshotApplied = Promise.withResolvers<void>();
			guestSocket.onOpen();
			await snapshotApplied.promise;
			expect(guestSession.lifecycleState).toEqual(hostSession.lifecycleState);
			expect(guestSession.lifecycleState?.phase).toBe("running");
			dropPause = true;
			foregroundResponse.resolve();
			await prompting;
			expect(hostSession.lifecycleState).toMatchObject({ phase: "continuing", awaitingAsyncWork: true });
			expect(guestSession.lifecycleState?.phase).toBe("running");
			expect(notifications).toEqual([]);
			dropPause = false;
			snapshotApplied = Promise.withResolvers<void>();
			guestSocket.onOpen();
			const observed = await paused.promise;
			await snapshotApplied.promise;
			await renderedBoundary;
			if (!observed) throw new Error("Host pause lost lifecycle ownership");
			expect(hostSession.wakeSources).toBeDefined();
			expect(guestSession.wakeSources).toBeUndefined();
			expect(hostSession.lifecycleState?.phase).toBe("continuing");
			expect(hostSession.lifecycleState).toEqual(observed);
			expect(pane).toBe("working");
			await renderedBoundary;
			expect(notifications).toEqual([]);

			snapshotApplied = Promise.withResolvers<void>();
			guestSocket.onOpen();
			await snapshotApplied.promise;
			expect(guestSession.lifecycleState).toEqual(hostSession.lifecycleState);
			await renderedBoundary;
			expect(notifications).toEqual([]);
			if (!physicalPause || !hostSocket) throw new Error("Missing intercepted physical async pause");
			expect(physicalPause.awaitingAsyncWork).toBe(true);
			originalSend.call(hostSocket, { t: "event", event: physicalPause });
			originalSend.call(hostSocket, { t: "event", event: physicalPause });
			originalSend.call(hostSocket, { t: "error", message: "__late_pause_applied__" });
			await latePauseApplied.promise;
			await renderedBoundary;
			expect(guestSession.lifecycleState).toEqual(hostSession.lifecycleState);
			expect(notifications).toEqual([]);
			expect(hostModelCalls).toBe(1);
			jobs.acknowledgeDeliveries(["host-background"]);
			jobs.cancel("host-background", { ownerId: "host-async-owner" });
			hostWork.resolve("cancelled without wake");
			await jobs.getJob("host-background")?.promise;
			await hostSession.waitForRunEnd();
			await completedNotification.promise;
			expect(hostSession.lifecycleState).toEqual({ runId: observed.runId, phase: "idle", outcome: "success" });
			expect(guestSession.lifecycleState).toEqual(hostSession.lifecycleState);
			expect(notifications).toEqual([expect.objectContaining({ type: "completion" })]);

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
			await guestSession.waitForRunEnd();
			expect(guestSession.lifecycleState).toEqual({ runId: localState.runId, phase: "idle", outcome: "success" });

			await harness.cleanup();
			guestContext.session = guestWithoutExtensions;
			guestContext.sessionManager = guestWithoutExtensions.sessionManager;
			harness = await makeHarness("notifications-without-extensions", {
				guestSession: guestWithoutExtensions,
				guestContext,
			});
			const sendState = (runId: string, phase: "continuing" | "idle"): void => {
				harness?.hostSocket.send({
					t: "state",
					state: {
						...makeState(),
						lifecycle: { runId, phase, ...(phase === "idle" ? { outcome: "success" as const } : {}) },
					},
				});
			};
			sendState("already-idle", "idle");
			await harness.barrier();
			await renderedBoundary;
			expect(notifications).toEqual([expect.objectContaining({ type: "completion" })]);

			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "older" } });
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "current" } });
			sendState("current", "continuing");
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "older", messages: [], isTerminal: true },
			});
			await harness.barrier();
			await renderedBoundary;
			expect(guestWithoutExtensions.lifecycleState).toEqual({ runId: "current", phase: "continuing" });
			expect(notifications).toEqual([expect.objectContaining({ type: "completion" })]);

			sendState("current", "idle");
			await harness.barrier();
			await renderedBoundary;
			expect(notifications).toEqual([
				expect.objectContaining({ type: "completion" }),
				expect.objectContaining({ type: "completion" }),
			]);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "current", messages: [], isTerminal: true },
			});
			await harness.barrier();
			await renderedBoundary;
			expect(notifications).toHaveLength(2);

			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "abandoned" } });
			sendState("abandoned", "continuing");
			await harness.barrier();
			await renderedBoundary;
			await harness.guest.leave("abandon host ownership");
			await renderedBoundary;
			expect(notifications).toHaveLength(2);
		} finally {
			foregroundResponse.resolve();
			jobs.acknowledgeDeliveries(["host-background", "local-background"]);
			jobs.cancelAll();
			hostWork.resolve("cancelled");
			localWork.resolve("cancelled");
			await harness?.cleanup();
			await guestSession.dispose();
			await guestWithoutExtensions.dispose();
			await hostSession.dispose();
			await auth.close();
			bus.clear();
			controller.dispose();
			sendSpy.mockRestore();
			advisorySpy.mockRestore();
			renderSpy.mockRestore();
			errorSpy.mockRestore();
			notificationSpy.mockRestore();
			resetSettingsForTest();
			homedirSpy.mockRestore();
			refreshDirsFromEnv();
			await home.remove();
		}
	});

	it.each(["error", "retry-error", "success", "aborted", "unknown"] as const)(
		"recovers a real host %s outcome once through the notification controller",
		async outcome => {
			const home = TempDir.createSync("@pi-guest-outcome-");
			const homedirSpy = spyOn(os, "homedir").mockReturnValue(home.path());
			refreshDirsFromEnv();
			resetSettingsForTest();
			await Settings.init({ inMemory: true });
			cfgCompletionNotify.set(runtimeSettings, "on");
			cfgErrorNotify.set(runtimeSettings, "on");
			await initTheme(false);
			const auth = await AuthStorage.create(":memory:");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Missing bundled test model");
			auth.keys.setRuntime(model.provider, "synthetic-key");
			const registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": outcome === "retry-error",
				"retry.modelFallback": false,
				"retry.baseDelayMs": 0,
				"retry.maxRetries": 1,
				"todo.enabled": false,
				"todo.reminders": false,
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);
			const response: MockResponse =
				outcome === "error" || outcome === "retry-error"
					? {
							stopReason: "error",
							stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
							errorMessage: "Refusal (cyber): Declined.",
						}
					: outcome === "aborted"
						? { stopReason: "aborted" }
						: { content: ["Completed offline"], stopReason: "stop" };
			const retryResponse = Promise.withResolvers<void>();
			let modelCalls = 0;
			const mock = createMockModel({
				handler: async () => {
					modelCalls++;
					if (outcome === "retry-error" && modelCalls === 1) {
						return { throw: "503 service unavailable: overloaded_error" };
					}
					if (outcome === "retry-error") await retryResponse.promise;
					return response;
				},
			});
			const hostSession = new AgentSession({
				agent: new Agent({
					getApiKey: () => "synthetic-key",
					initialState: { model, systemPrompt: [], tools: [], messages: [] },
					streamFn: mock.stream,
					convertToLlm,
				}),
				sessionManager: SessionManager.inMemory(home.path()),
				settings,
				modelRegistry: registry,
			});
			const guestSession = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] }, convertToLlm }),
				sessionManager: SessionManager.inMemory(home.path()),
				settings,
				modelRegistry: registry,
			});
			const guestContext = createInteractiveModeContext({
				session: guestSession,
				sessionManager: guestSession.sessionManager,
				settings,
				statusLine: { setCollabStatus: () => {}, resetActiveTime: () => {} },
				resetObserverRegistry: () => {},
				syncRunningSubagentBadge: () => false,
				syncComposerShape: () => {},
				eventBus: new EventBus(),
			});
			const controller = new EventController(guestContext);
			guestContext.eventController = controller;
			const recovered = Promise.withResolvers<void>();
			const retryStarted = Promise.withResolvers<void>();
			const renderedEvents: string[] = [];
			const handleEvent = controller.handleEvent.bind(controller);
			const controllerSpy = spyOn(controller, "handleEvent").mockImplementation(async event => {
				renderedEvents.push(event.type);
				await handleEvent(event);
				if (event.type === "auto_retry_start") retryStarted.resolve();
				if (event.type === "agent_end") recovered.resolve();
			});
			const notifications: Parameters<typeof TERMINAL.sendNotification>[0][] = [];
			const notificationSpy = spyOn(TERMINAL, "sendNotification").mockImplementation(notification => {
				notifications.push(notification);
			});
			const barrier = Promise.withResolvers<void>();
			const showErrorSpy = spyOn(guestContext, "showError").mockImplementation(message => {
				if (message.includes("__late_end_applied__")) barrier.resolve();
			});
			const originalSend = CollabSocket.prototype.send;
			let physical: Extract<AgentSessionLifecycleEvent, { type: "agent_end" }> | undefined;
			let hostSocket: CollabSocket | undefined;
			let guestSocket: CollabSocket | undefined;
			let disconnected = false;
			const sendSpy = spyOn(CollabSocket.prototype, "send").mockImplementation(
				function (this: CollabSocket, wireFrame, peer) {
					const frame: CollabFrame = typeof wireFrame === "string" ? JSON.parse(wireFrame) : wireFrame;
					if (frame.t === "hello") guestSocket = this;
					if (
						outcome === "retry-error" &&
						((frame.t === "event" && frame.event.type === "auto_retry_end") ||
							(disconnected && (frame.t === "event" || frame.t === "entry")))
					) {
						if (frame.t === "event" && frame.event.type === "agent_end") {
							physical = frame.event;
							hostSocket = this;
						}
						return true;
					}
					if (frame.t === "event" && frame.event.type === "agent_end") {
						physical = frame.event;
						hostSocket = this;
						return true;
					}
					return originalSend.call(this, wireFrame, peer);
				},
			);
			const originalBroadcastAdvisory = CollabSocket.prototype.broadcastAdvisory;
			const advisorySpy = spyOn(CollabSocket.prototype, "broadcastAdvisory").mockImplementation(
				function (this: CollabSocket, wireFrame) {
					const frame: CollabFrame = typeof wireFrame === "string" ? JSON.parse(wireFrame) : wireFrame;
					if (outcome === "retry-error" && disconnected && frame.t === "state") return true;
					if (outcome === "unknown" && frame.t === "state" && frame.state.lifecycle) {
						const { outcome: _outcome, ...lifecycle } = frame.state.lifecycle;
						return originalBroadcastAdvisory.call(this, { ...frame, state: { ...frame.state, lifecycle } });
					}
					return originalBroadcastAdvisory.call(this, wireFrame);
				},
			);
			let harness: Harness | undefined;
			try {
				harness = await makeHarness(`real-outcome-${outcome}`, { hostSession, guestSession, guestContext });
				const prompting = hostSession.prompt("Complete one offline turn.");
				if (outcome === "retry-error") {
					await retryStarted.promise;
					expect(notifications).toEqual([]);
					disconnected = true;
					retryResponse.resolve();
				}
				await prompting;
				await hostSession.waitForIdle();
				if (outcome === "retry-error") {
					expect(hostSession.lifecycleState?.phase).toBe("idle");
					expect(notifications).toEqual([]);
					disconnected = false;
					if (!guestSocket?.onOpen) throw new Error("Missing guest reconnect handshake");
					guestSocket.onOpen();
				}
				await recovered.promise;
				if (!physical || !hostSocket) throw new Error("Missing intercepted physical completion");
				if (outcome === "error" || outcome === "retry-error") {
					expect(physical.messages.findLast(message => message.role === "assistant")).toMatchObject({
						stopReason: "error",
						stopDetails: { type: "refusal" },
					});
					expect(
						guestSession.messages.some(
							message => message.role === "assistant" && message.stopDetails?.type === "refusal",
						),
					).toBe(false);
				}
				if (outcome === "unknown") {
					expect(guestSession.messages.findLast(message => message.role === "assistant")).toMatchObject({
						stopReason: "stop",
					});
				}
				const expected =
					outcome === "error" || outcome === "retry-error"
						? [expect.objectContaining({ type: "error" })]
						: outcome === "success"
							? [expect.objectContaining({ type: "completion" })]
							: [];
				expect(notifications).toEqual(expected);
				if (outcome === "retry-error") {
					expect(modelCalls).toBe(2);
					expect(renderedEvents.filter(type => type === "auto_retry_start")).toHaveLength(1);
					expect(renderedEvents).not.toContain("auto_retry_end");
					expect(guestContext.retryLoader).toBeUndefined();
				}
				expect(guestSession.lifecycleState).toEqual(
					outcome === "unknown"
						? { runId: physical.runId, phase: "idle" }
						: { runId: physical.runId, phase: "idle", outcome: outcome === "retry-error" ? "error" : outcome },
				);
				originalSend.call(hostSocket, { t: "event", event: physical });
				originalSend.call(hostSocket, { t: "event", event: physical });
				originalSend.call(hostSocket, { t: "error", message: "__late_end_applied__" });
				await barrier.promise;
				expect(notifications).toEqual(expected);
				expect(guestSession.lifecycleState).toEqual(hostSession.lifecycleState);
			} finally {
				retryResponse.resolve();
				await harness?.cleanup();
				await guestSession.dispose();
				await hostSession.dispose();
				controller.dispose();
				controllerSpy.mockRestore();
				notificationSpy.mockRestore();
				showErrorSpy.mockRestore();
				sendSpy.mockRestore();
				advisorySpy.mockRestore();
				await auth.close();
				resetSettingsForTest();
				homedirSpy.mockRestore();
				refreshDirsFromEnv();
				await home.remove();
			}
		},
	);

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
			harness.ctx.eventController.dispatchSessionEvent = async event => {
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
			await auth.close();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});

	it("does not start a local paid turn from a host plan approval after leaving", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		let lifecycleState: AgentSession["lifecycleState"] = null;
		const ctx = createInteractiveModeContext({
			session: {
				get lifecycleState() {
					return lifecycleState;
				},
				setMirroredLifecycleState(state) {
					lifecycleState = state;
				},
				switchSession: async () => true,
				newSession: async () => true,
			},
			statusLine: {
				setCollabStatus: () => {},
				resetActiveTime: () => {},
				markActivityStart: () => {},
				markActivityEnd: () => {},
			},
			resetObserverRegistry: () => {},
			syncRunningSubagentBadge: () => false,
			syncComposerShape: () => {},
		});
		const controller = new EventController(ctx);
		ctx.eventController = controller;
		const harness = await makeHarness("host-plan-local-turn", { guestContext: ctx });
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("mock", "synthetic-key");
		const manager = SessionManager.inMemory();
		const mock = createMockModel({ handler: () => ({ content: ["unexpected local execution"] }) });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "synthetic-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
				convertToLlm,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true }),
		});
		ctx.session = session;
		ctx.sessionManager = manager;
		const approval = Promise.withResolvers<void>();
		const executions: Promise<void>[] = [];
		ctx.handlePlanApproval = async () => {
			const execution = (async () => {
				await approval.promise;
				await session.prompt("HOST_PLAN_MUST_NOT_EXECUTE_LOCALLY", { synthetic: true });
			})();
			executions.push(execution);
			await execution;
		};
		try {
			harness.hostSocket.send({
				t: "event",
				event: {
					type: "tool_execution_end",
					toolCallId: "host-propose",
					toolName: "write",
					isError: false,
					result: {
						content: [{ type: "text", text: "Plan ready for approval." }],
						details: {
							xdev: {
								tool: PROPOSE_COMMAND_NAME,
								mode: "execute",
								args: { title: "host plan" },
								inner: { planFilePath: "local://host-plan.md", title: "host plan", planExists: true },
							},
						},
					},
				},
			} as CollabFrame);
			await harness.barrier();
			await controller.drainSessionEvents();
			await harness.guest.leave("host approval pending");
			approval.resolve();
			await Promise.all(executions);
			await session.waitForAdmittedSubmissions();
			await session.waitForIdle();
			expect(mock.calls).toEqual([]);
			expect(session.messages).toEqual([]);
		} finally {
			approval.resolve();
			await Promise.allSettled(executions);
			await harness.cleanup();
			await session.dispose();
			await auth.close();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			resetSettingsForTest();
		}
	});

	it("applies a mirrored stream tail in order through the event controller", async () => {
		// The controller reads global settings (speech) when it enqueues a stream delta.
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const controller = new EventController(createInteractiveModeContext());
		const updateGate = Promise.withResolvers<void>();
		const handled: string[] = [];
		const handleEvent = spyOn(controller, "handleEvent").mockImplementation(async (event: AgentSessionEvent) => {
			// A slow streaming rebuild: later events must queue behind it, not overtake it.
			if (event.type === "message_update") await updateGate.promise;
			handled.push(event.type);
		});
		const harness = await makeHarness("lifecycle-mirror-room-9", { eventController: controller });
		try {
			harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "stream-tail" } });
			await harness.barrier();
			await controller.dispatchSessionEvent({ type: "turn_start" } as AgentSessionEvent);
			handled.length = 0;
			const message: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "tok" }],
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
			harness.hostSocket.send({
				t: "event",
				event: {
					type: "message_update",
					message,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tok", partial: message },
				},
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message } } as CollabFrame);
			harness.hostSocket.send({
				t: "event",
				event: { type: "agent_end", runId: "stream-tail", messages: [message], isTerminal: true },
			} as CollabFrame);
			await harness.barrier();
			updateGate.resolve();
			// A trailing dispatch settles only after every event queued ahead of it.
			await controller.dispatchSessionEvent({ type: "turn_start" } as AgentSessionEvent);

			expect(handled.filter(type => type !== "message_start" && type !== "turn_start")).toEqual([
				"message_update",
				"message_end",
				"agent_end",
			]);
		} finally {
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});

	it("coalesces a mirrored message_update burst into one handled latest snapshot", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const controller = new EventController(createInteractiveModeContext());
		const handledUpdates: string[] = [];
		const handleEvent = spyOn(controller, "handleEvent").mockImplementation(async (event: AgentSessionEvent) => {
			if (event.type === "message_update") handledUpdates.push(messageText(event.message));
		});
		const harness = await makeHarness("lifecycle-mirror-room-10", { eventController: controller });
		// Hold the coalescing window open: only message_end may flush the burst.
		vi.useFakeTimers();
		try {
			for (const text of ["a", "ab", "abc"]) sendUpdate(harness, makeAssistant(text));
			harness.hostSocket.send({
				t: "event",
				event: { type: "message_end", message: makeAssistant("abc") },
			} as CollabFrame);
			await harness.barrier();
			await controller.dispatchSessionEvent({ type: "turn_start" } as AgentSessionEvent);

			expect(handledUpdates).toEqual(["abc"]);
		} finally {
			vi.useRealTimers();
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});

	for (const boundary of ["leave", "resync"] as const) {
		it(`settles queued host rendering before ${boundary} replaces the transcript`, async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
			await initTheme(false);
			const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
			const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
			const lookup = Promise.withResolvers<ReadonlyMap<string, string>>();
			const lookupStarted = Promise.withResolvers<void>();
			const drainStarted = Promise.withResolvers<void>();
			const replaced = Promise.withResolvers<void>();
			let activity = false;
			let replacement: AssistantMessageComponent;
			let armed = false;
			let lifecycleState: AgentSession["lifecycleState"] = null;
			const ctx = createInteractiveModeContext({
				session: {
					get lifecycleState() {
						return lifecycleState;
					},
					setMirroredLifecycleState(state) {
						lifecycleState = state;
					},
					switchSession: async () => true,
					newSession: async () => true,
				},
				statusLine: {
					setCollabStatus: () => {},
					resetActiveTime: () => {
						activity = false;
					},
					markActivityStart: () => {
						activity = true;
					},
					markActivityEnd: () => {
						activity = false;
					},
				},
				resolveAssistantMessageLinkHrefs: () => {
					lookupStarted.resolve();
					return lookup.promise;
				},
				resetObserverRegistry: () => {},
				syncRunningSubagentBadge: () => false,
				syncComposerShape: () => {},
			});
			ctx.renderInitialMessages = async () => {
				ctx.chatContainer.disposeChildren();
				replacement = new AssistantMessageComponent(makeAssistant(`${boundary} replacement`));
				ctx.chatContainer.addChild(replacement);
				if (armed) replaced.resolve();
			};
			const controller = new EventController(ctx);
			ctx.eventController = controller;
			const drain = controller.drainSessionEvents.bind(controller);
			const drainSpy = spyOn(controller, "drainSessionEvents").mockImplementation(() => {
				if (armed) drainStarted.resolve();
				return drain();
			});
			const harness = await makeHarness(`guest-render-ownership-${boundary}`, { guestContext: ctx });
			try {
				const message = makeAssistant("[held lookup](local://guest-ownership)");
				harness.hostSocket.send({ t: "event", event: { type: "message_start", message } });
				harness.hostSocket.send({ t: "event", event: { type: "message_end", message } });
				await lookupStarted.promise;
				const stale = makeAssistant("stale host row");
				harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "old-host-run" } });
				harness.hostSocket.send({ t: "event", event: { type: "message_start", message: stale } });
				harness.hostSocket.send({ t: "event", event: { type: "message_end", message: stale } });
				await harness.barrier();
				armed = true;
				let transition: Promise<void>;
				if (boundary === "leave") {
					transition = harness.guest.leave("held local lookup");
				} else {
					harness.hostSocket.send({
						t: "welcome",
						proto: COLLAB_PROTO,
						header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
						state: makeState(),
						agents: [],
						entryCount: 0,
					});
					transition = harness.barrier();
				}
				await Promise.race([drainStarted.promise, replaced.promise]);
				expect(ctx.collabGuest).toBe(harness.guest);
				lookup.resolve(new Map([["local://guest-ownership", "file:///synthetic-guest-ownership"]]));
				await transition;
				expect(ctx.collabGuest).toBe(boundary === "leave" ? undefined : harness.guest);
				await controller.dispatchSessionEvent({ type: "turn_start" });
				expect(ctx.chatContainer.children).toEqual([replacement!]);
				expect(ctx.chatContainer.render(100).join("\n")).toContain(`${boundary} replacement`);
				expect(ctx.chatContainer.render(100).join("\n")).not.toContain("stale host row");
				expect(activity).toBe(false);
				expect(ctx.streamingComponent).toBeUndefined();

				const current = makeAssistant("current owner row");
				if (boundary === "resync") {
					harness.hostSocket.send({ t: "event", event: { type: "agent_start", runId: "current-host-run" } });
					harness.hostSocket.send({ t: "event", event: { type: "message_start", message: current } });
					harness.hostSocket.send({ t: "event", event: { type: "message_end", message: current } });
					await harness.barrier();
					await controller.dispatchSessionEvent({ type: "turn_start" });
				} else {
					await controller.dispatchSessionEvent({ type: "agent_start" });
					await controller.dispatchSessionEvent({ type: "message_start", message: current });
					await controller.dispatchSessionEvent({ type: "message_end", message: current });
				}
				const transcript = ctx.chatContainer.render(100).join("\n");
				expect(transcript).toContain(`${boundary} replacement`);
				expect(transcript).toContain("current owner row");
				expect(transcript.indexOf(`${boundary} replacement`)).toBeLessThan(transcript.indexOf("current owner row"));
				expect(activity).toBe(true);
			} finally {
				lookup.resolve(new Map());
				await harness.cleanup();
				controller.resetTranscriptAnchors();
				drainSpy.mockRestore();
				writeSpy.mockRestore();
				renameSpy.mockRestore();
				resetSettingsForTest();
			}
		});
	}

	it("speaks the text of updates the host superseded", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cfgSpeechEnabled.set(settings, true);
		cfgSpeechMode.set(settings, "all");
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
		const spoken: string[] = [];
		const pushDelta = spyOn(vocalizer, "pushDelta").mockImplementation(text => {
			spoken.push(text);
		});
		const controller = new EventController(createInteractiveModeContext());
		const handleEvent = spyOn(controller, "handleEvent").mockResolvedValue(undefined);
		const harness = await makeHarness("lifecycle-mirror-room-12", { eventController: controller });
		try {
			const start = makeStreamed([]);
			harness.hostSocket.send({ t: "event", event: { type: "message_start", message: start } } as CollabFrame);
			const planned = makeStreamed([{ type: "thinking", thinking: "Plan" }]);
			harness.hostSocket.send({
				t: "event",
				event: {
					type: "message_update",
					message: planned,
					assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Plan", partial: planned },
				},
			} as CollabFrame);
			// The updates carrying " it" and "Hello" were superseded on the host's queue.
			const answered = makeStreamed([
				{ type: "thinking", thinking: "Plan it" },
				{ type: "text", text: "Hello world" },
			]);
			harness.hostSocket.send({
				t: "event",
				event: {
					type: "message_update",
					message: answered,
					assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " world", partial: answered },
				},
			} as CollabFrame);
			harness.hostSocket.send({ t: "event", event: { type: "message_end", message: answered } } as CollabFrame);
			await harness.barrier();

			expect(spoken).toEqual(["Plan", " it", "Hello", " world"]);
			// Extensions see the same reconstructed stream.
			const extensionDeltas = harness.emitted.flatMap(event =>
				event.type === "message_update" && "delta" in event.assistantMessageEvent
					? [event.assistantMessageEvent.delta]
					: [],
			);
			expect(extensionDeltas).toEqual(["Plan", " it", "Hello", " world"]);
		} finally {
			pushDelta.mockRestore();
			handleEvent.mockRestore();
			writeSpy.mockRestore();
			renameSpy.mockRestore();
			await harness.cleanup();
			resetSettingsForTest();
		}
	});
});

function makeAssistant(text: string): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		timestamp: 0,
	};
}

function makeStreamed(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		timestamp: 0,
	};
}

function messageText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function sendUpdate(harness: Harness, message: AgentMessage): void {
	if (message.role !== "assistant") return;
	harness.hostSocket.send({
		t: "event",
		event: {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: message },
		},
	} as CollabFrame);
}
