/**
 * Contract: while joined as a collab guest, an extension reacting to a
 * mirrored host lifecycle event cannot start or queue a turn on the replica
 * session. The replica only mirrors the host; a local turn would run on the
 * guest's own model and credentials and diverge from the host transcript.
 *
 * Wiring under test is the production path: a real `AgentSession` + real
 * `ExtensionRunner`, extension actions bound by `ExtensionUiController`, and
 * the guest's `GuestLifecycleEmitter` feeding a mirrored `agent_end`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { GuestLifecycleEmitter } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/lifecycle-mirror";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

describe("collab guest extension turn guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-guest-ext-turn-guard-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		await authStorage.close();
		tempDir.removeSync();
	});

	it("refuses extension-initiated turns triggered by a mirrored agent_end, and allows them after leaving", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runtime = new ExtensionRuntime();

		// One-shot reaction per mirrored settle: the extension's own local turn
		// (after leaving) emits an agent_end too and must not re-trigger.
		let onAgentEnd: ((pi: ExtensionAPI, ctx: ExtensionContext) => void | Promise<void>) | undefined;
		let handled = Promise.withResolvers<void>();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", async (_event, extensionContext) => {
					const react = onAgentEnd;
					onAgentEnd = undefined;
					if (!react) return;
					await react(pi, extensionContext);
					handled.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"plan-mode-like",
		);
		const runner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		const mock = createMockModel({ provider: "openai", id: "gpt-test", handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 1,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const agentSession = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(),
			extensionRunner: runner,
			sideStreamFn: mock.stream,
		});
		session = agentSession;
		await agentSession.prompt("SEED_FIRST_TURN");
		await agentSession.waitForIdle();
		await agentSession.prompt("SEED_SECOND_TURN");
		await agentSession.waitForIdle();
		const baselineRequests = [...mock.calls];
		const baselineMessages = JSON.stringify(agentSession.messages);

		const errors: string[] = [];
		const ctx = createInteractiveModeContext({
			session: agentSession,
			sessionManager,
			settings,
			showStatus: () => {},
			showError: (message: string) => errors.push(message),
			syncComposerShape: () => {},
			syncExtensionLinks: () => {},
		});
		ctx.setCollabGuest(new CollabGuestLink(ctx));
		new ExtensionUiController(ctx).initializeHookRunner({} as ExtensionUIContext, false);

		const mirror = new GuestLifecycleEmitter();
		const mirrorHostRun = async (): Promise<void> => {
			const runId = Bun.randomUUIDv7();
			mirror.emit(runner, { type: "agent_start", runId });
			mirror.emit(runner, { type: "agent_end", runId, messages: [], isTerminal: true });
			await handled.promise;
			await mirror.drain();
			// Every turn-starting action is admitted synchronously; wait for any
			// admitted one to dispatch and its turn to finish.
			await agentSession.waitForAdmittedSubmissions();
			await agentSession.waitForIdle();
		};

		// Joined: plan-mode's "Execute" after the host settles, plus the other
		// turn-starting delivery modes.
		let blocked: PromiseSettledResult<unknown>[] = [];
		onAgentEnd = async (pi, extensionContext) => {
			pi.sendMessage({ customType: "plan-execute", content: "EXECUTE_PLAN", display: true }, { triggerTurn: true });
			pi.sendMessage(
				{ customType: "plan-followup", content: "FOLLOW_UP", display: false },
				{ deliverAs: "followUp" },
			);
			pi.sendMessage({ customType: "steer", content: "STEER", display: false }, { deliverAs: "steer" });
			pi.sendMessage({ customType: "aside", content: "ASIDE", display: false }, { deliverAs: "aside" });
			pi.sendUserMessage("USER_CONTINUE");
			blocked = await Promise.allSettled([
				extensionContext.runEphemeralTurn!({ promptText: "PAID_SIDE_TURN" }),
				extensionContext.compact(),
			]);
		};
		await mirrorHostRun();

		expect(mock.calls).toEqual(baselineRequests);
		expect(JSON.stringify(agentSession.messages)).toBe(baselineMessages);
		expect(errors).toEqual([]);
		expect(blocked.map(result => result.status)).toEqual(["rejected", "rejected"]);

		// Left the session: the same reaction now owns a real local turn.
		ctx.setCollabGuest(undefined);
		handled = Promise.withResolvers<void>();
		onAgentEnd = pi => {
			pi.sendMessage({ customType: "plan-execute", content: "EXECUTE_PLAN", display: true }, { triggerTurn: true });
		};
		await mirrorHostRun();

		expect(JSON.stringify(mock.calls.at(-1)!.context.messages)).toContain("EXECUTE_PLAN");
		expect(errors).toEqual([]);
	});
});
