import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { AgentLifecycleOutcome } from "@oh-my-pi/pi-wire";
import { AsyncJobManager } from "../src/async/job-manager";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AgentSession } from "../src/session/agent-session";
import type { AgentSessionEvent, AgentSessionLifecycleEvent } from "../src/session/agent-session-events";
import { AuthStorage } from "../src/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

test.each([
	{ phase: "running", asyncPause: false },
	{ phase: "async-paused", asyncPause: true },
])(
	"a delayed completion cannot settle a later $phase owner",
	async ({ asyncPause }) => {
		const endEntered = Promise.withResolvers<void>();
		const releaseEnd = Promise.withResolvers<void>();
		const oldEndDelivered = Promise.withResolvers<void>();
		const providerEntered = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		const finalEndDelivered = Promise.withResolvers<void>();
		const newerPauseDelivered = Promise.withResolvers<void>();
		const releaseJob = Promise.withResolvers<string>();
		const jobs = new AsyncJobManager({});
		const runtime = new ExtensionRuntime();
		const bus = new EventBus();
		const manager = SessionManager.inMemory();
		const authStorage = await AuthStorage.create(":memory:");
		let session: AgentSession | undefined;
		let firstPrompt: Promise<boolean> | undefined;
		let laterPrompt: Promise<void> | undefined;
		let activeRunId: string | undefined;
		let consumerWorking = false;
		const starts: string[] = [];
		const ends: string[] = [];
		try {
			const gate = await loadExtensionFromFactory(
				pi => {
					let completions = 0;
					pi.on("session_stop", async () => {
						if (++completions !== 1) return;
						endEntered.resolve();
						await releaseEnd.promise;
					});
				},
				manager.getCwd(),
				bus,
				runtime,
			);
			const consumer = await loadExtensionFromFactory(
				pi => {
					pi.on("agent_start", event => {
						starts.push(event.runId);
						activeRunId = event.runId;
						consumerWorking = true;
					});
					pi.on("agent_end", event => {
						ends.push(event.runId);
						if (event.runId === activeRunId) consumerWorking = event.willContinue === true;
						if (event.runId === starts[0]) oldEndDelivered.resolve();
						else finalEndDelivered.resolve();
					});
				},
				manager.getCwd(),
				bus,
				runtime,
			);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Missing bundled test model");
			authStorage.keys.setRuntime(model.provider, "synthetic-key");
			const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"retry.modelFallback": false,
				"todo.enabled": false,
				"todo.reminders": false,
			});
			const runner = new ExtensionRunner(
				[gate, consumer],
				runtime,
				manager.getCwd(),
				manager,
				registry,
				undefined,
				settings,
			);
			const responses = createMockModel({
				responses: [
					{
						stopReason: "error",
						stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
						errorMessage: "Refusal (cyber): Declined.",
					},
					{ content: ["later run finished"], stopReason: "stop" },
				],
			});
			let calls = 0;
			const agent = new Agent({
				getApiKey: () => "synthetic-key",
				initialState: { model, systemPrompt: [], tools: [], messages: [] },
				streamFn: async (requestedModel, context, options) => {
					if (++calls === 2) {
						providerEntered.resolve();
						await releaseProvider.promise;
					}
					return responses.stream(requestedModel, context, options);
				},
			});
			session = new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry: registry,
				extensionRunner: runner,
				agentId: "DelayedOwner",
				asyncJobManager: jobs,
			});
			const physicalEnds: Array<Extract<AgentSessionLifecycleEvent, { type: "agent_end" }>> = [];
			session.subscribeLifecycle(event => {
				if (event.type === "agent_end") {
					physicalEnds.push(event);
					if (event.awaitingAsyncWork) newerPauseDelivered.resolve();
				}
			});
			firstPrompt = session.prompt("Complete the first run.");
			await endEntered.promise;
			await agent.waitForIdle();
			if (asyncPause) {
				jobs.register("bash", "held newer-owner job", () => releaseJob.promise, {
					id: "newer-owner-job",
					ownerId: "DelayedOwner",
				});
			}
			laterPrompt = agent.prompt("Complete the later run.");
			await providerEntered.promise;
			expect(session.isStreaming).toBe(true);
			const newerRunId = session.lifecycleState?.runId;
			if (!newerRunId) throw new Error("Running loop lost lifecycle ownership");
			expect(newerRunId).not.toBe(starts[0]);
			expect(session.lifecycleState?.phase).toBe("running");
			expect(session.lifecycleState?.outcome).toBeUndefined();
			expect(session.lifecycleState?.awaitingAsyncWork).toBeUndefined();
			if (asyncPause) {
				releaseProvider.resolve();
				await newerPauseDelivered.promise;
				expect(session.lifecycleState?.runId).toBe(newerRunId);
				expect(session.lifecycleState?.phase).toBe("continuing");
				expect(session.lifecycleState?.awaitingAsyncWork).toBe(true);
			}
			releaseEnd.resolve();
			await oldEndDelivered.promise;
			expect(consumerWorking).toBe(true);
			expect(ends).toContain(starts[0]);
			expect(physicalEnds.find(event => event.runId === starts[0])?.outcome).toBe("error");
			expect(session.lifecycleState?.runId).toBe(newerRunId);
			expect(session.lifecycleState?.phase).toBe(asyncPause ? "continuing" : "running");
			expect(session.lifecycleState?.outcome).toBe(asyncPause ? "success" : undefined);
			expect(session.lifecycleState?.awaitingAsyncWork).toBe(asyncPause ? true : undefined);
			releaseProvider.resolve();
			await laterPrompt;
			await finalEndDelivered.promise;
			await firstPrompt;
			expect(consumerWorking).toBe(asyncPause);
			expect(ends).toContain(starts[1]);
			if (asyncPause) {
				jobs.acknowledgeDeliveries(["newer-owner-job"]);
				releaseJob.resolve("suppressed newer-owner result");
				await jobs.waitForOwnerJobs("DelayedOwner");
				await session.waitForRunEnd();
			}
			expect(session.isStreaming).toBe(false);
			expect(session.lifecycleState?.runId).toBe(newerRunId);
			expect(session.lifecycleState?.phase).toBe("idle");
			expect(session.lifecycleState?.outcome).toBe("success");
			expect(session.lifecycleState?.awaitingAsyncWork).toBeUndefined();
			expect(physicalEnds.find(event => event.runId === newerRunId)?.outcome).toBe("success");
		} finally {
			releaseEnd.resolve();
			releaseProvider.resolve();
			releaseJob.resolve("suppressed newer-owner result");
			try {
				try {
					await laterPrompt;
					await firstPrompt;
				} finally {
					await session?.dispose();
				}
			} finally {
				await authStorage.close();
				await jobs.dispose();
				bus.clear();
			}
		}
	},
	10_000,
);

const outcomeCases: Array<{ label: string; response: MockResponse; outcome: AgentLifecycleOutcome }> = [
	{ label: "successful", response: { content: ["finished"] }, outcome: "success" },
	{
		label: "refused",
		response: {
			stopReason: "error",
			stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
			errorMessage: "Refusal (cyber): Declined.",
		},
		outcome: "error",
	},
	{
		label: "aborted",
		response: { content: ["partial"], stopReason: "aborted", errorMessage: USER_INTERRUPT_LABEL },
		outcome: "aborted",
	},
];

test.each(outcomeCases)(
	"$label outcome survives a suppressed background wake and resets with its owner",
	async ({ response, outcome }) => {
		const authStorage = await AuthStorage.create(":memory:");
		const jobs = new AsyncJobManager({});
		const releaseJob = Promise.withResolvers<string>();
		const providerEntered = Promise.withResolvers<void>();
		const releaseProvider = Promise.withResolvers<void>();
		const firstProviderEntered = Promise.withResolvers<void>();
		const releaseFirstProvider = Promise.withResolvers<void>();
		let session: AgentSession | undefined;
		let nextPrompt: Promise<boolean> | undefined;
		let aborting: Promise<void> | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Missing bundled test model");
			authStorage.keys.setRuntime(model.provider, "synthetic-key");
			const mock = createMockModel({
				responses: [
					async () => {
						if (outcome === "aborted") {
							firstProviderEntered.resolve();
							await releaseFirstProvider.promise;
						}
						return response;
					},
					async () => {
						providerEntered.resolve();
						await releaseProvider.promise;
						return { content: ["next owner finished"] };
					},
				],
			});
			const agent = new Agent({
				getApiKey: () => "synthetic-key",
				initialState: { model, systemPrompt: [], tools: [], messages: [] },
				streamFn: mock.stream,
			});
			const manager = SessionManager.inMemory();
			session = new AgentSession({
				agent,
				sessionManager: manager,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": false,
					"retry.modelFallback": false,
					"todo.enabled": false,
					"todo.reminders": false,
				}),
				modelRegistry: new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true }),
				agentId: "OutcomeOwner",
				asyncJobManager: jobs,
			});
			const physicalEnds: Array<Extract<AgentSessionLifecycleEvent, { type: "agent_end" }>> = [];
			const publicEnds: Array<Extract<AgentSessionEvent, { type: "agent_end" }>> = [];
			const publicPauses: Array<Extract<AgentSessionEvent, { type: "agent_pause" }>> = [];
			session.subscribeLifecycle(event => {
				if (event.type === "agent_end") physicalEnds.push(event);
			});
			session.subscribe(event => {
				if (event.type === "agent_end") publicEnds.push(event);
				if (event.type === "agent_pause") publicPauses.push(event);
			});
			jobs.register("bash", "held synthetic job", () => releaseJob.promise, {
				id: "outcome-job",
				ownerId: "OutcomeOwner",
			});

			const prompting = session.prompt("Settle while the background job remains held.");
			if (outcome === "aborted") {
				await firstProviderEntered.promise;
				aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
				releaseFirstProvider.resolve();
			}
			await prompting;
			await aborting;
			const owner = session.lifecycleState;
			if (!owner) throw new Error("Settled loop lost its owner");
			expect(owner.outcome).toBe(outcome);
			expect(owner.phase).toBe(outcome === "aborted" ? "idle" : "continuing");
			expect(owner.awaitingAsyncWork).toBe(outcome === "aborted" ? undefined : true);
			expect(physicalEnds[0]?.runId).toBe(owner.runId);
			expect(physicalEnds[0]?.outcome).toBe(outcome);
			expect(physicalEnds[0]?.awaitingAsyncWork).toBe(outcome === "aborted" ? undefined : true);
			if (outcome === "aborted") {
				expect(publicEnds[0]?.outcome).toBe(outcome);
				expect(publicPauses).toEqual([]);
			} else {
				expect(publicEnds).toEqual([]);
				expect(publicPauses).toMatchObject([{ runId: owner.runId, outcome, awaiting: true }]);
			}
			if (outcome === "error") {
				expect(agent.state.messages.some(message => message.role === "assistant")).toBe(false);
				expect(
					manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant"),
				).toBe(false);
			}

			jobs.acknowledgeDeliveries(["outcome-job"]);
			releaseJob.resolve("suppressed synthetic result");
			await jobs.waitForOwnerJobs("OutcomeOwner");
			await session.waitForRunEnd();
			expect(session.lifecycleState?.runId).toBe(owner.runId);
			expect(session.lifecycleState?.phase).toBe("idle");
			expect(session.lifecycleState?.outcome).toBe(outcome);
			expect(session.lifecycleState?.awaitingAsyncWork).toBeUndefined();
			expect(mock.calls).toHaveLength(1);
			expect(physicalEnds).toHaveLength(1);
			expect(publicEnds).toHaveLength(1);

			nextPrompt = session.prompt("Start a new owner.");
			await providerEntered.promise;
			const nextRunId = session.lifecycleState?.runId;
			expect(nextRunId).not.toBe(owner.runId);
			expect(session.lifecycleState?.phase).toBe("running");
			expect(session.lifecycleState?.outcome).toBeUndefined();
			expect(session.lifecycleState?.awaitingAsyncWork).toBeUndefined();
			releaseProvider.resolve();
			await nextPrompt;
			expect(session.lifecycleState?.runId).toBe(nextRunId);
			expect(session.lifecycleState?.phase).toBe("idle");
			expect(session.lifecycleState?.outcome).toBe("success");
			expect(session.lifecycleState?.awaitingAsyncWork).toBeUndefined();
			expect(physicalEnds[1]?.outcome).toBe("success");
			expect(publicEnds[1]?.outcome).toBe("success");
			await session.newSession();
			expect(session.lifecycleState).toBeNull();
		} finally {
			releaseFirstProvider.resolve();
			await aborting;
			releaseProvider.resolve();
			releaseJob.resolve("suppressed synthetic result");
			try {
				await nextPrompt;
			} finally {
				try {
					await session?.dispose();
				} finally {
					await jobs.dispose();
					await authStorage.close();
				}
			}
		}
	},
	10_000,
);
