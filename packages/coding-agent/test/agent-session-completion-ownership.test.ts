import { expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

test("a delayed completion cannot settle a later run still waiting for its provider", async () => {
	const endEntered = Promise.withResolvers<void>();
	const releaseEnd = Promise.withResolvers<void>();
	const oldEndDelivered = Promise.withResolvers<void>();
	const providerEntered = Promise.withResolvers<void>();
	const releaseProvider = Promise.withResolvers<void>();
	const finalEndDelivered = Promise.withResolvers<void>();
	const runtime = new ExtensionRuntime();
	const bus = new EventBus();
	const manager = SessionManager.inMemory();
	const authStorage = await AuthStorage.create(":memory:");
	let session: AgentSession | undefined;
	let laterPrompt: Promise<boolean> | undefined;
	let activeRunId: string | undefined;
	let consumerWorking = false;
	const starts: string[] = [];
	const ends: string[] = [];
	try {
		const gate = await loadExtensionFromFactory(
			pi => {
				let completions = 0;
				pi.on("agent_end", async () => {
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
					if (ends.length === 1) oldEndDelivered.resolve();
					else finalEndDelivered.resolve();
				});
			},
			manager.getCwd(),
			bus,
			runtime,
		);
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Missing bundled test model");
		authStorage.keys.setRuntime(model.provider, "synthetic-key");
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
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
				{ content: ["first run finished"], stopReason: "stop" },
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
		});
		await session.prompt("Complete the first run.");
		await endEntered.promise;
		laterPrompt = session.prompt("Complete the later run.");
		await providerEntered.promise;
		expect(session.isStreaming).toBe(true);
		releaseEnd.resolve();
		await oldEndDelivered.promise;
		expect(consumerWorking).toBe(true);
		expect(ends[0]).toBe(starts[0]);
		expect(ends[0]).not.toBe(starts[1]);
		releaseProvider.resolve();
		await laterPrompt;
		await finalEndDelivered.promise;
		expect(consumerWorking).toBe(false);
		expect(ends[1]).toBe(starts[1]);
		expect(session.isStreaming).toBe(false);
	} finally {
		releaseEnd.resolve();
		releaseProvider.resolve();
		try {
			try {
				await laterPrompt;
			} finally {
				await session?.dispose();
			}
		} finally {
			authStorage.close();
			bus.clear();
		}
	}
}, 10_000);
