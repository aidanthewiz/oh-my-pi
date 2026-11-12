import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, AppendOnlyContextManager } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { USER_AWAIT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-awaits";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { cfgSessionMaxCost } from "@oh-my-pi/pi-coding-agent/session/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg } from "./utilities";

const cleanup: Array<() => Promise<void>> = [];
let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

async function setup(): Promise<void> {
	sharedDir = TempDir.createSync("@pi-new-session-boundary-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
}

async function teardown(): Promise<void> {
	await authStorage.close();
	sharedDir.removeSync();
}

async function createHarness(options?: {
	trackWaits?: boolean;
	extension?: {
		name: string;
		register: (api: ExtensionAPI) => void;
	};
}): Promise<{ agent: Agent; session: AgentSession; sessionManager: SessionManager; agentRegistry: AgentRegistry }> {
	const tempDir = TempDir.createSync("@pi-new-session-boundary-");
	const cwd = tempDir.path();
	const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const agent = new Agent({
		initialState: {
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});
	let extensionRunner: ExtensionRunner | undefined;
	if (options?.extension) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			options.extension.register,
			cwd,
			new EventBus(),
			runtime,
			options.extension.name,
		);
		extensionRunner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
	}
	const agentRegistry = new AgentRegistry();
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
		extensionRunner,
		agentId: options?.trackWaits ? "Main" : undefined,
		agentRegistry,
	});
	if (options?.trackWaits) agentRegistry.register({ id: "Main", displayName: "Main", kind: "main", session });
	cleanup.push(async () => {
		await session.dispose();
		tempDir.removeSync();
	});
	return { agent, session, sessionManager, agentRegistry };
}

describe("AgentSession.newSession boundary", () => {
	beforeAll(setup);
	afterAll(teardown);
	afterEach(async () => {
		while (cleanup.length > 0) {
			const run = cleanup.pop();
			if (run) await run();
		}
	});

	it("invalidates a primed append-only context so pre-/new bytes never reach the next turn", async () => {
		const { agent, session } = await createHarness();
		const appendOnlyContext = new AppendOnlyContextManager();
		agent.setAppendOnlyContext(appendOnlyContext);
		appendOnlyContext.syncMessages([
			{ role: "user", content: "previous conversation" },
			{ role: "assistant", content: "previous answer" },
		]);
		appendOnlyContext.build({ systemPrompt: ["Test"], messages: [], tools: [] }, { intentTracing: false });
		expect(appendOnlyContext.log.length).toBeGreaterThan(0);
		expect(appendOnlyContext.prefix.built).toBe(true);

		expect(await session.newSession()).toBe(true);

		expect(appendOnlyContext.log.length).toBe(0);
		expect(appendOnlyContext.prefix.built).toBe(false);
	});

	it("tracks provider routing identity to the new local session, not the previous conversation", async () => {
		const { session, sessionManager } = await createHarness();
		const previousSessionId = session.sessionId;

		expect(await session.newSession()).toBe(true);

		expect(session.sessionId).not.toBe(previousSessionId);
		expect(session.sessionId).toBe(sessionManager.getSessionId());
	});

	it.each(["reset", "new"] as const)(
		"retires %s conversation waits without settling outgoing dialogs",
		async boundary => {
			const { session, agentRegistry } = await createHarness({ trackWaits: true });
			await session.goalRuntime.createGoal({ objective: "Original objective" });
			const oldDecision = Promise.withResolvers<void>();
			const oldDialog = session.waitForUser(() => oldDecision.promise).catch(error => error);
			const decision = Promise.withResolvers<void>();
			let dialog: Promise<void> | undefined;
			const failure = new Error("Outgoing dialog rejected");
			try {
				expect(session.goalRuntime.buildContinuationPrompt()).toBeUndefined();
				if (boundary === "reset") expect(await session.resetSessionContext()).toBeDefined();
				else expect(await session.newSession()).toBe(true);
				await session.goalRuntime.dropGoal();
				const replacement = await session.goalRuntime.createGoal({ objective: "Replacement objective" });
				expect(session.isWaitingForUser).toBe(false);
				expect(session.goalRuntime.buildContinuationPrompt()).toContain("Replacement objective");
				if (boundary === "reset") {
					expect(agentRegistry.awaits.blocksOn("Main", USER_AWAIT_ID, Date.now())).toBe(true);
				}

				dialog = session.waitForUser(() => decision.promise);
				oldDecision.reject(failure);
				expect(await oldDialog).toBe(failure);
				expect(session.isWaitingForUser).toBe(true);
				expect(agentRegistry.awaits.blocksOn("Main", USER_AWAIT_ID, Date.now())).toBe(true);
				expect(session.goalRuntime.buildContinuationPrompt()).toBeUndefined();
				expect(session.getGoalModeState()).toMatchObject({
					enabled: true,
					goal: { id: replacement.goal.id, status: "active" },
				});
				decision.resolve();
				await dialog;
				expect(session.isWaitingForUser).toBe(false);
				expect(agentRegistry.awaits.blocksOn("Main", USER_AWAIT_ID, Date.now())).toBe(false);
				expect(session.goalRuntime.buildContinuationPrompt()).toContain("Replacement objective");
			} finally {
				oldDecision.resolve();
				decision.resolve();
				await oldDialog;
				await dialog;
			}
		},
	);

	it("does not pause a replacement queued before an original dialog rejects", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let armed = false;
		const { session } = await createHarness({
			trackWaits: true,
			extension: {
				name: "queued-goal-replacement",
				register: api =>
					api.on("goal_updated", async event => {
						if (armed && event.goal?.objective === "Original objective") {
							armed = false;
							entered.resolve();
							await release.promise;
						}
					}),
			},
		});
		await session.goalRuntime.createGoal({ objective: "Original objective" });
		const decision = Promise.withResolvers<void>();
		const dialog = session.waitForUser(() => decision.promise).catch(error => error);
		armed = true;
		const accounting = session.goalRuntime.onBudgetMutated(100);
		await entered.promise;
		const replacement = session.goalRuntime.replaceGoal({ objective: "Replacement objective" });
		const failure = new Error("Consent rejected");
		try {
			decision.reject(failure);
			await Promise.resolve();
			expect(session.isWaitingForUser).toBe(true);
			expect(session.goalRuntime.buildContinuationPrompt()).toBeUndefined();
			release.resolve();
			await accounting;
			const next = await replacement;
			expect(await dialog).toBe(failure);
			expect(session.getGoalModeState()).toMatchObject({
				enabled: true,
				goal: { id: next.goal.id, objective: "Replacement objective", status: "active" },
			});
			expect(session.goalRuntime.buildContinuationPrompt()).toContain("Replacement objective");
		} finally {
			release.resolve();
			decision.resolve();
			await accounting;
			await replacement;
			await dialog;
		}
	});

	it.each(["idle", "reset", "new", "dispose"] as const)(
		"retains a rejected goal-event pause until %s drainage settles",
		async boundary => {
			const rejected = Promise.withResolvers<void>();
			const pauseEntered = Promise.withResolvers<void>();
			const releasePause = Promise.withResolvers<void>();
			const failure = new Error("Consent rejected");
			let rejection: unknown;
			const harness = await createHarness({
				trackWaits: true,
				extension: {
					name: "reentrant-goal-dialog",
					register: api =>
						api.on("goal_updated", async event => {
							if (event.goal?.status === "active") {
								try {
									await session.waitForUser(() => Promise.reject(failure));
								} catch (error) {
									rejection = error;
								}
								rejected.resolve();
							} else if (event.goal?.status === "paused") {
								pauseEntered.resolve();
								await releasePause.promise;
							}
						}),
				},
			});
			const session = harness.session;
			const creating = session.goalRuntime.createGoal({ objective: "Requires consent" });
			let idle = false;
			let settling: Promise<void> | undefined;
			try {
				await rejected.promise;
				await pauseEntered.promise;
				await creating;
				expect(rejection).toBe(failure);
				expect(session.getGoalModeState()).toMatchObject({ enabled: false, goal: { status: "paused" } });
				expect(session.isWaitingForUser).toBe(true);
				expect(harness.agentRegistry.awaits.blocksOn("Main", USER_AWAIT_ID, Date.now())).toBe(true);
				const draining =
					boundary === "idle"
						? session.waitForIdle()
						: boundary === "reset"
							? session.resetSessionContext()
							: boundary === "new"
								? session.newSession()
								: session.dispose();
				settling = draining.then(() => {
					idle = true;
				});
				const eventTurn = Promise.withResolvers<void>();
				setImmediate(eventTurn.resolve);
				await eventTurn.promise;
				expect(idle).toBe(false);
				expect(session.goalRuntime.buildContinuationPrompt()).toBeUndefined();
			} finally {
				releasePause.resolve();
				await creating;
				await settling;
			}
			expect(session.isWaitingForUser).toBe(false);
			expect(harness.agentRegistry.awaits.blocksOn("Main", USER_AWAIT_ID, Date.now())).toBe(false);
			expect(idle).toBe(true);
		},
	);

	it.each(["idle", "reset"] as const)(
		"reports reentrant pause persistence failure during %s drainage",
		async boundary => {
			const failure = new Error("Goal pause persistence failed");
			const harness = await createHarness({
				trackWaits: true,
				extension: {
					name: "reentrant-goal-persistence",
					register: api =>
						api.on("goal_updated", async event => {
							if (event.goal?.status === "active") {
								await session.waitForUser(() => Promise.reject(new Error("Consent rejected"))).catch(() => {});
							}
						}),
				},
			});
			const session = harness.session;
			const appendMode = harness.sessionManager.appendModeChange.bind(harness.sessionManager);
			const persist = spyOn(harness.sessionManager, "appendModeChange").mockImplementation((...args) => {
				if (args[0] === "goal_paused") throw failure;
				return appendMode(...args);
			});
			try {
				await session.goalRuntime.createGoal({ objective: "Requires consent" });
				const error = await (boundary === "idle" ? session.waitForIdle() : session.resetSessionContext()).catch(
					error => error,
				);
				expect(error).toBeInstanceOf(AggregateError);
				expect((error as AggregateError).errors).toEqual([failure]);
				expect(session.isWaitingForUser).toBe(false);
				expect(harness.agentRegistry.awaits.blocksOn("Main", USER_AWAIT_ID, Date.now())).toBe(false);
			} finally {
				persist.mockRestore();
			}
		},
	);

	it("propagates ordinary dialog pause failure to both its caller and transition drainage", async () => {
		const { session, sessionManager } = await createHarness({ trackWaits: true });
		await session.goalRuntime.createGoal({ objective: "Requires consent" });
		const failure = new Error("Goal pause persistence failed");
		const appendMode = sessionManager.appendModeChange.bind(sessionManager);
		const persist = spyOn(sessionManager, "appendModeChange").mockImplementation((...args) => {
			if (args[0] === "goal_paused") throw failure;
			return appendMode(...args);
		});
		try {
			const dialog = session.waitForUser(() => Promise.reject(new Error("Consent rejected")));
			await expect(dialog).rejects.toBe(failure);
			const error = await session.resetSessionContext().catch(error => error);
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([failure]);
			expect(session.isWaitingForUser).toBe(false);
		} finally {
			persist.mockRestore();
		}
	});

	it("keeps unpersisted tree spend when reloading the same session", async () => {
		const { session, sessionManager } = await createHarness();
		cfgSessionMaxCost.override(session.settings, 1);
		session.costGate.record(1);
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected current session file");

		expect(await session.switchSession(sessionFile)).toBe(true);

		expect(session.costGate.check()).toMatchObject({ spent: 1, cap: 1 });
		expect(() => session.costGate.admit()).toThrow("Cost cap reached");
	});

	it("restores the outgoing budget and pending wait when a loaded session switch rolls back", async () => {
		const { agent, session, sessionManager, agentRegistry } = await createHarness({ trackWaits: true });
		cfgSessionMaxCost.override(session.settings, 1);
		session.costGate.record(1);
		await sessionManager.ensureOnDisk();
		const previousId = sessionManager.getSessionId();
		const previousFile = sessionManager.getSessionFile();
		if (!previousFile) throw new Error("Expected current session file");
		const target = SessionManager.create(sessionManager.getCwd(), path.dirname(previousFile));
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await target.close();
		const decision = Promise.withResolvers<void>();
		const dialog = session.waitForUser(() => decision.promise);
		const replace = spyOn(agent, "replaceMessages").mockImplementationOnce(() => {
			throw new Error("Target context rejected");
		});
		try {
			await expect(session.switchSession(targetFile)).rejects.toThrow("Target context rejected");
			expect(sessionManager.getSessionId()).toBe(previousId);
			expect(session.costGate.check()).toMatchObject({ spent: 1, cap: 1 });
			expect(() => session.costGate.admit()).toThrow("Cost cap reached");
			expect(session.isWaitingForUser).toBe(true);
			expect(agentRegistry.awaits.blocksOn("Main", USER_AWAIT_ID, Date.now())).toBe(true);
		} finally {
			replace.mockRestore();
			decision.resolve();
			await dialog;
		}
		expect(session.isWaitingForUser).toBe(false);
		expect(agentRegistry.awaits.blocksOn("Main", USER_AWAIT_ID, Date.now())).toBe(false);
	});

	it("retires the outgoing budget once a new transcript commits even if its prompt refresh fails", async () => {
		const { session, sessionManager } = await createHarness();
		cfgSessionMaxCost.override(session.settings, 1);
		session.costGate.record(1);
		const previousId = sessionManager.getSessionId();
		const refresh = spyOn(session, "refreshBaseSystemPrompt").mockRejectedValueOnce(new Error("Refresh failed"));
		try {
			await expect(session.newSession()).rejects.toThrow("Refresh failed");
			expect(sessionManager.getSessionId()).not.toBe(previousId);
			expect(session.costGate.spent).toBe(0);
			expect(session.costGate.check()).toBeUndefined();
		} finally {
			refresh.mockRestore();
		}
	});

	it("keeps the /delete successor lazy so quitting leaves no empty session", async () => {
		const { session, sessionManager } = await createHarness();
		await sessionManager.ensureOnDisk();
		const droppedSessionFile = sessionManager.getSessionFile();
		expect(droppedSessionFile).toBeDefined();
		expect(fs.existsSync(droppedSessionFile!)).toBe(true);

		expect(await session.newSession({ drop: true })).toBe(true);

		expect(fs.existsSync(droppedSessionFile!)).toBe(false);
		const successorSessionFile = sessionManager.getSessionFile();
		expect(successorSessionFile).toBeDefined();
		expect(successorSessionFile).not.toBe(droppedSessionFile);
		expect(sessionManager.isSessionOnDisk()).toBe(false);
		expect(fs.existsSync(successorSessionFile!)).toBe(false);

		// A zero-turn quit must not materialize the successor either.
		await session.dispose();
		expect(fs.existsSync(successorSessionFile!)).toBe(false);
	});

	it("keeps old-session messages out of the new session when notifications finish late", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { agent, session, sessionManager } = await createHarness({
			extension: {
				name: "block-old-message-persistence",
				register: pi => {
					pi.on("message_end", async () => {
						reached.resolve();
						await release.promise;
					});
				},
			},
		});
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "previous conversation answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
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

		agent.emitExternalEvent({ type: "message_end", message });
		try {
			await reached.promise;
			expect(await session.newSession()).toBe(true);
			const newSessionFile = sessionManager.getSessionFile();
			if (!newSessionFile) throw new Error("Expected persisted new session file");
			release.resolve();
			await session.settleInFlightMessagePersistence();
			await sessionManager.flush();

			expect(JSON.stringify(sessionManager.getEntries())).not.toContain("previous conversation answer");
			const reopened = await SessionManager.open(newSessionFile);
			try {
				expect(JSON.stringify(reopened.getEntries())).not.toContain("previous conversation answer");
			} finally {
				await reopened.close();
			}
		} finally {
			release.resolve();
		}
	});

	for (const transition of ["new", "fork", "branch", "btw"] as const) {
		it(`keeps ${transition} unavailable through before/after hooks and exposes only the final context`, async () => {
			const beforeReached = Promise.withResolvers<void>();
			const beforeRelease = Promise.withResolvers<void>();
			const afterReached = Promise.withResolvers<void>();
			const afterRelease = Promise.withResolvers<void>();
			const reconcileReached = Promise.withResolvers<void>();
			const reconcileRelease = Promise.withResolvers<void>();
			const { session, sessionManager, agent } = await createHarness({
				extension: {
					name: `gate-${transition}-readiness`,
					register: pi => {
						const before = async () => {
							beforeReached.resolve();
							await beforeRelease.promise;
						};
						const after = async () => {
							afterReached.resolve();
							await afterRelease.promise;
						};
						pi.on("session_before_switch", before);
						pi.on("session_before_branch", before);
						pi.on("session_switch", after);
						pi.on("session_branch", after);
					},
				},
			});
			sessionManager.appendMessage({ role: "user", content: "ancestor", timestamp: 1 });
			const entryId = sessionManager.appendMessage({ role: "user", content: "branch point", timestamp: 2 });
			agent.replaceMessages(sessionManager.buildSessionContext().messages);
			await sessionManager.flush();
			const previousId = sessionManager.getSessionId();
			session.setSessionBeforeSwitchReconciler(async () => {
				reconcileReached.resolve();
				await reconcileRelease.promise;
			});
			const operation =
				transition === "new"
					? session.newSession()
					: transition === "fork"
						? session.fork()
						: transition === "branch"
							? session.branch(entryId)
							: session.branchFromBtw("side question", assistantMsg("side answer"), entryId, previousId);
			try {
				await beforeReached.promise;
				expect(session.isSessionTransitioning).toBe(true);
				let ready = false;
				const waiting = session.waitForSessionTransition().then(() => {
					ready = true;
					return { id: sessionManager.getSessionId(), messages: [...session.messages] };
				});
				beforeRelease.resolve();
				await reconcileReached.promise;
				expect(sessionManager.getSessionId()).toBe(previousId);
				expect(session.sessionId).toBe(previousId);
				expect(agent.sessionId).toBe(previousId);
				expect(session.isSessionTransitioning).toBe(true);
				expect(ready).toBe(false);
				expect(session.messages).toEqual(sessionManager.buildSessionContext().messages);
				reconcileRelease.resolve();
				await afterReached.promise;
				expect(sessionManager.getSessionId()).not.toBe(previousId);
				expect(session.isSessionTransitioning).toBe(true);
				expect(ready).toBe(false);
				afterRelease.resolve();
				await operation;
				const observed = await waiting;
				expect(session.isSessionTransitioning).toBe(false);
				expect(observed.id).toBe(sessionManager.getSessionId());
				const expectedTexts =
					transition === "new"
						? []
						: transition === "branch"
							? ["ancestor"]
							: transition === "fork"
								? ["ancestor", "branch point"]
								: ["ancestor", "branch point", "side question", "side answer"];
				expect(
					observed.messages.map(message => {
						const content = "content" in message ? message.content : undefined;
						return typeof content === "string"
							? content
							: content
									?.filter(part => part.type === "text")
									.map(part => part.text)
									.join("");
					}),
				).toEqual(expectedTexts);
			} finally {
				beforeRelease.resolve();
				reconcileRelease.resolve();
				afterRelease.resolve();
				await operation;
			}
		});
	}

	it("waits through full switch rollback before exposing the restored session", async () => {
		const { session, sessionManager, agent } = await createHarness();
		const target = await createHarness();
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		agent.replaceMessages(sessionManager.buildSessionContext().messages);
		const originalId = sessionManager.getSessionId();
		target.sessionManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await target.sessionManager.ensureOnDisk();
		await target.sessionManager.flush();
		const targetFile = target.sessionManager.getSessionFile();
		if (!targetFile) throw new Error("Expected persisted target session");
		const adopted = Promise.withResolvers<void>();
		const failAdoption = Promise.withResolvers<void>();
		const rollbackReached = Promise.withResolvers<void>();
		const rollbackRelease = Promise.withResolvers<void>();
		session.setSessionSwitchReconciler(async () => {
			rollbackReached.resolve();
			await rollbackRelease.promise;
		});
		let firstCwdChange = true;
		const failure = new Error("settings adoption failed");
		const operation = session.switchSession(targetFile, {
			onCwdChange: async () => {
				if (!firstCwdChange) return true;
				firstCwdChange = false;
				adopted.resolve();
				await failAdoption.promise;
				throw failure;
			},
		});
		try {
			await adopted.promise;
			expect(sessionManager.getSessionId()).toBe(target.sessionManager.getSessionId());
			expect(session.isSessionTransitioning).toBe(true);
			let ready = false;
			const waiting = session.waitForSessionTransition().then(() => {
				ready = true;
			});
			failAdoption.resolve();
			await rollbackReached.promise;
			expect(sessionManager.getSessionId()).toBe(originalId);
			expect(session.isSessionTransitioning).toBe(true);
			expect(ready).toBe(false);
			rollbackRelease.resolve();
			await expect(operation).rejects.toBe(failure);
			await waiting;
			expect(session.isSessionTransitioning).toBe(false);
			expect(session.messages).toEqual([{ role: "user", content: "source", timestamp: 1 }]);
		} finally {
			failAdoption.resolve();
			rollbackRelease.resolve();
			await operation.catch(() => {});
		}
	});

	it("keeps the outer transition pending after an awaited reset finishes inside its hook", async () => {
		const resetFinished = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const { session } = await createHarness({
			extension: {
				name: "nested-reset-readiness",
				register: pi => {
					pi.on("session_switch", async () => {
						await session.resetSessionContext();
						resetFinished.resolve();
						await releaseHook.promise;
					});
				},
			},
		});
		const operation = session.newSession();
		try {
			await resetFinished.promise;
			expect(session.isSessionTransitioning).toBe(true);
			let ready = false;
			const waiting = session.waitForSessionTransition().then(() => {
				ready = true;
			});
			await Promise.resolve();
			expect(ready).toBe(false);
			releaseHook.resolve();
			await operation;
			await waiting;
			expect(session.isSessionTransitioning).toBe(false);
		} finally {
			releaseHook.resolve();
			await operation;
		}
	});

	it("keeps an in-place reset unavailable until system-prompt refresh finishes", async () => {
		const { session, sessionManager, agent } = await createHarness();
		sessionManager.appendMessage({ role: "user", content: "discard", timestamp: 1 });
		agent.replaceMessages(sessionManager.buildSessionContext().messages);
		const originalId = sessionManager.getSessionId();
		const refreshReached = Promise.withResolvers<void>();
		const refreshRelease = Promise.withResolvers<void>();
		const refresh = spyOn(session, "refreshBaseSystemPrompt").mockImplementation(async () => {
			refreshReached.resolve();
			await refreshRelease.promise;
		});
		const operation = session.resetSessionContext();
		try {
			await refreshReached.promise;
			expect(session.isSessionTransitioning).toBe(true);
			let ready = false;
			const waiting = session.waitForSessionTransition().then(() => {
				ready = true;
			});
			await Promise.resolve();
			expect(ready).toBe(false);
			refreshRelease.resolve();
			expect(await operation).toEqual({ droppedCount: 1 });
			await waiting;
			expect(session.isSessionTransitioning).toBe(false);
			expect(sessionManager.getSessionId()).toBe(originalId);
			expect(session.messages).toEqual([]);
		} finally {
			refreshRelease.resolve();
			await operation;
			refresh.mockRestore();
		}
	});

	it("releases readiness after a tree hook cancels without moving the leaf", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, sessionManager } = await createHarness({
			extension: {
				name: "cancel-tree-readiness",
				register: pi => {
					pi.on("session_before_tree", async () => {
						reached.resolve();
						await release.promise;
						return { cancel: true };
					});
				},
			},
		});
		const root = sessionManager.appendMessage({ role: "user", content: "ancestor", timestamp: 1 });
		const leaf = sessionManager.appendMessage({ role: "user", content: "leaf", timestamp: 2 });
		const operation = session.navigateTree(root);
		try {
			await reached.promise;
			expect(session.isSessionTransitioning).toBe(true);
			const waiting = session.waitForSessionTransition();
			release.resolve();
			expect(await operation).toMatchObject({ cancelled: true });
			await waiting;
			expect(session.isSessionTransitioning).toBe(false);
			expect(sessionManager.getLeafId()).toBe(leaf);
		} finally {
			release.resolve();
			await operation;
		}
	});

	it("reports the replacement identity to session_switch extensions before /new returns", async () => {
		let reported:
			| {
					reason: string;
					sessionId: string;
					sessionFile: string | undefined;
			  }
			| undefined;
		const { session, sessionManager } = await createHarness({
			extension: {
				name: "observe-new-session",
				register: pi => {
					pi.on("session_switch", (event, ctx) => {
						reported = {
							reason: event.reason,
							sessionId: ctx.sessionManager.getSessionId(),
							sessionFile: ctx.sessionManager.getSessionFile(),
						};
					});
				},
			},
		});
		const previousSessionId = sessionManager.getSessionId();

		expect(await session.newSession()).toBe(true);

		expect(reported?.reason).toBe("new");
		expect(reported?.sessionId).toBe(sessionManager.getSessionId());
		expect(reported?.sessionId).not.toBe(previousSessionId);
		const reportedFile = reported?.sessionFile;
		if (!reportedFile) throw new Error("Expected session_switch to report a persisted session file");
		expect(await Bun.file(reportedFile).exists()).toBe(true);
	});
});
