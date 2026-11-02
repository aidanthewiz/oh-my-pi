import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { scheduler } from "node:timers/promises";
import { type AssistantMessage, type OAuthCredential, registerCustomApi, unregisterCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { computeRepairRegion } from "@oh-my-pi/pi-coding-agent/edit/auto-repair";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CostCapError } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import type { ModelUsageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/** `count` functions, blank-line separated so each edited return line is its own hunk. */
function source(count: number, edit: (index: number) => string): string {
	return Array.from(
		{ length: count },
		(_, index) => `function f${index}() {\n\treturn compute(${index});\n}\n\nconst pad${index} = ${index};\n`,
	)
		.map((block, index) => block.replace(`return compute(${index});`, edit(index)))
		.join("\n");
}

describe("computeRepairRegion", () => {
	it.each([15, 16, 30])("isolates two broken hunks among %i edited hunks", hunks => {
		const prev = source(hunks, index => `return compute(${index});`);
		// Every hunk changes; hunks 4 and 11 each drop a closing paren.
		const next = source(hunks, index =>
			index === 4 || index === 11 ? `return computeNext(${index};` : `return computeNext(${index});`,
		);
		const region = computeRepairRegion({ path: "edited.ts", prev, next });
		expect(region).toBeDefined();
		expect(region!.brokenText).toContain("computeNext(4;");
		expect(region!.brokenText).toContain("computeNext(11;");
		expect(region!.referenceText).toContain("return compute(4);");
		expect(region!.referenceText).toContain("return compute(11);");
	});
});

const repairBefore = "const value = compute(1);\n";
const repairBroken = "const value = computeNext(1;\n";
const repairFixed = "const value = computeNext(1);";
const repairCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of repairCleanups.splice(0).reverse()) await cleanup();
});

function repairCredential(account: string): OAuthCredential {
	return {
		type: "oauth",
		access: `synthetic-access-${account}`,
		refresh: `synthetic-refresh-${account}`,
		expires: Date.now() + 60 * 60_000,
		accountId: account,
		email: `${account}@example.invalid`,
	};
}

async function repairSession(options: { warmSmol?: boolean; loopFirst?: boolean; cap?: number } = {}) {
	const dir = TempDir.createSync("@pi-repair-authority-");
	const sourceId = `repair-${crypto.randomUUID()}`;
	const mainProvider = `${sourceId}-main`;
	const smolProvider = `${sourceId}-smol`;
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		sourceIdentity: sourceId,
		usageProviderResolver: () => undefined,
	});
	const registry = new ModelRegistry(auth, dir.join("models.yml"));
	let owner: AgentSession | undefined = undefined;
	repairCleanups.push(async () => {
		try {
			await owner?.dispose();
		} finally {
			registry.unregisterProvider(mainProvider);
			registry.unregisterProvider(smolProvider);
			unregisterCustomApi(`${mainProvider}-api`, sourceId);
			unregisterCustomApi(`${smolProvider}-api`, sourceId);
			await auth.close();
			dir[Symbol.dispose]();
		}
	});
	const journal = SessionManager.inMemory(dir.path());
	const sent: Array<{ provider: string; key: string | undefined }> = [];
	let afterDispatch: (() => void) | undefined;
	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = (model, _context, streamOptions) => {
		const output = new AssistantMessageEventStream();
		void (async () => {
			try {
				streamOptions?.signal?.throwIfAborted();
				await streamOptions?.onPayload?.({ repair: true }, model, streamOptions.signal);
				streamOptions?.signal?.throwIfAborted();
				const key = typeof streamOptions?.apiKey === "string" ? streamOptions.apiKey : undefined;
				sent.push({ provider: model.provider, key });
				if (model.provider !== smolProvider) throw new Error("Repair dispatched on the main provider");
				afterDispatch?.();
				const loop = options.loopFirst === true && sent.length === 1;
				const input = loop ? 100_000 : 50_000;
				const tokens = loop ? 100_000 : 25_000;
				const inputCost = (input * model.cost.input) / 1_000_000;
				const outputCost = (tokens * model.cost.output) / 1_000_000;
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [],
					usage: {
						input,
						output: tokens,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: input + tokens,
						cost: {
							input: inputCost,
							output: outputCost,
							cacheRead: 0,
							cacheWrite: 0,
							total: inputCost + outputCost,
						},
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				output.push({ type: "start", partial: message });
				if (loop) {
					const thinking = "Rechecking the unchanged repair candidate. ".repeat(100);
					message.content.push({ type: "thinking", thinking });
					output.push({ type: "thinking_start", contentIndex: 0, partial: message });
					output.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial: message });
				} else {
					message.content.push({ type: "text", text: repairFixed });
					output.push({ type: "text_start", contentIndex: 0, partial: message });
					output.push({ type: "text_delta", contentIndex: 0, delta: repairFixed, partial: message });
					output.push({ type: "text_end", contentIndex: 0, content: repairFixed, partial: message });
				}
				output.push({ type: "done", reason: "stop", message });
				output.end(message);
			} catch (error) {
				output.fail(error instanceof Error ? error : new Error(String(error)));
			}
		})();
		return output;
	};
	for (const provider of [mainProvider, smolProvider]) {
		registry.registerProvider(provider, {
			api: `${provider}-api`,
			baseUrl: "https://repair.example.invalid",
			oauth: {
				name: provider,
				login: async () => {
					throw new Error("Synthetic repair must not log in");
				},
				refreshToken: async () => {
					throw new Error("Unexpired synthetic repair must not refresh");
				},
				getApiKey: credentials => credentials.access,
			},
			streamSimple,
			models: [
				{
					id: "repair",
					name: "Isolated repair",
					reasoning: true,
					input: ["text"],
					cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_768,
					maxTokens: 8192,
				},
			],
		});
		registerCustomApi(`${provider}-api`, streamSimple, sourceId);
	}
	await auth.credentials.set(mainProvider, [repairCredential("main-a")]);
	await auth.credentials.set(smolProvider, [repairCredential("smol-a")]);
	const main = registry.find(mainProvider, "repair");
	const smol = registry.find(smolProvider, "repair");
	if (!main || !smol) throw new Error("Synthetic repair models were not registered");
	await registry.getApiKey(main, journal.getSessionId());
	if (options.warmSmol) await registry.getApiKey(smol, journal.getSessionId());
	const settings = Settings.isolated({
		"edit.mode": "replace",
		"edit.autoRepair.enabled": true,
		"async.enabled": false,
		"compaction.enabled": false,
		"todo.enabled": false,
		"secrets.enabled": false,
		"session.maxCost": options.cap ?? 2,
		modelRoles: { smol: `${smolProvider}/repair` },
	});
	const created = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage: auth,
		modelRegistry: registry,
		sessionManager: journal,
		settings,
		model: main,
		agentRegistry: new AgentRegistry(),
		agentId: sourceId,
		bindProcessState: false,
		toolNames: ["edit"],
		disableExtensionDiscovery: true,
		systemPrompt: ["Repair the isolated syntax fixture."],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	const { session } = created;
	owner = session;
	const credentialSessionId = session.agent.sessionId;
	if (!credentialSessionId) throw new Error("SDK did not assign the synthetic provider session");
	const tool = session.getToolByName("edit");
	if (!tool) throw new Error("SDK did not create the edit tool");
	const repairUsage = () =>
		journal
			.getEntries()
			.filter(
				(entry): entry is ModelUsageEntry => entry.type === "model_usage" && entry.purpose === "edit-auto-repair",
			);
	return {
		dir,
		auth,
		registry,
		journal,
		session,
		credentialSessionId,
		smol,
		smolProvider,
		mainProvider,
		sent,
		repairUsage,
		onDispatch(callback: () => void) {
			afterDispatch = callback;
		},
		async edit(name = "repair.ts", signal?: AbortSignal) {
			const path = dir.join(name);
			await Bun.write(path, repairBefore);
			return tool.execute(
				`repair-${name}`,
				{
					path,
					old_string: repairBefore.trimEnd(),
					new_string: repairBroken.trimEnd(),
				},
				signal,
			);
		},
	};
}

describe("edit repair OAuth authority", () => {
	it("dispatches the first repair on a distinct OAuth smol provider without prior affinity", async () => {
		const fixture = await repairSession();
		expect(
			fixture.auth.oauth.accounts(fixture.smolProvider, fixture.credentialSessionId).some(account => account.active),
		).toBe(false);

		await fixture.edit();

		expect(fixture.sent).toEqual([{ provider: fixture.smolProvider, key: "synthetic-access-smol-a" }]);
		expect(await Bun.file(fixture.dir.join("repair.ts")).text()).toBe(repairFixed);
		expect(fixture.session.costGate.spent).toBeCloseTo(0.2);
		expect(fixture.repairUsage().map(entry => entry.usage.cost.total)).toEqual([0.2]);
	});

	it.each(["credential replacement", "account replacement", "source replacement", "session replacement"] as const)(
		"refuses a first OAuth repair after concurrent %s",
		async replacement => {
			const fixture = await repairSession();
			const selected = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const resolveCredential = fixture.registry.getApiKeyWithCredentialForProvider.bind(fixture.registry);
			const selection = spyOn(fixture.registry, "getApiKeyWithCredentialForProvider").mockImplementation(
				async (provider, sessionId, options) => {
					const credential = await resolveCredential(provider, sessionId, options);
					if (provider === fixture.smolProvider) {
						selected.resolve();
						await release.promise;
					}
					return credential;
				},
			);
			const pending = fixture.edit();
			try {
				await Promise.race([
					selected.promise,
					pending.then(() => {
						throw new Error("Repair completed before OAuth selection");
					}),
				]);
				if (replacement === "credential replacement") {
					await fixture.auth.credentials.set(fixture.smolProvider, [repairCredential("replacement")]);
				} else if (replacement === "account replacement") {
					await fixture.auth.credentials.set(fixture.smolProvider, [
						repairCredential("smol-a"),
						repairCredential("smol-b"),
					]);
					const other = fixture.auth.oauth
						.accounts(fixture.smolProvider)
						.find(account => account.accountId === "smol-b");
					if (!other) throw new Error("Missing synthetic alternate account");
					expect(
						fixture.auth.sessions.pin(fixture.smolProvider, fixture.credentialSessionId, other.credentialId),
					).toBe(true);
				} else if (replacement === "source replacement") {
					await fixture.auth.replaceStore(new SqliteAuthCredentialStore(new Database(":memory:")), {
						sourceIdentity: `replacement-${crypto.randomUUID()}`,
					});
					await fixture.auth.credentials.set(fixture.mainProvider, [repairCredential("main-a")]);
					await fixture.auth.credentials.set(fixture.smolProvider, [repairCredential("smol-a")]);
				} else {
					await fixture.session.newSession();
				}
			} finally {
				release.resolve();
				try {
					await pending;
				} finally {
					selection.mockRestore();
				}
			}
			expect(fixture.sent).toEqual([]);
			expect(fixture.session.costGate.spent).toBe(0);
			expect(fixture.repairUsage()).toEqual([]);
			expect(await Bun.file(fixture.dir.join("repair.ts")).text()).toBe(repairBroken);
		},
	);
});

describe("edit repair internal attempt accounting", () => {
	it("charges guarded thinking-loop failures and the successful repair once on the originating journal leaf", async () => {
		const fixture = await repairSession({ warmSmol: true, loopFirst: true });
		const origin = fixture.journal.appendMessage({
			role: "user",
			content: "Repair this edit",
			timestamp: Date.now(),
		});
		let successor: string | undefined;
		fixture.onDispatch(() => {
			successor ??= fixture.journal.appendCustomEntry("repair-concurrent-leaf", {});
		});

		await fixture.edit();

		expect(fixture.sent).toEqual([
			{ provider: fixture.smolProvider, key: "synthetic-access-smol-a" },
			{ provider: fixture.smolProvider, key: "synthetic-access-smol-a" },
		]);
		expect(await Bun.file(fixture.dir.join("repair.ts")).text()).toBe(repairFixed);
		expect(fixture.session.costGate.spent).toBeCloseTo(0.8);
		const usage = fixture.repairUsage();
		expect(usage.map(entry => entry.stopReason)).toEqual(["error", "stop"]);
		expect(usage.map(entry => entry.usage.cost.total)).toEqual([expect.closeTo(0.6), expect.closeTo(0.2)]);
		expect(usage.map(entry => entry.parentId)).toEqual([origin, origin]);
		expect(usage.reduce((total, entry) => total + entry.usage.cost.total, 0)).toBeCloseTo(0.8);
		if (successor === undefined) throw new Error("Concurrent repair leaf was not created");
		expect(fixture.journal.getLeafId()).toBe(successor);
	});

	it("refuses the next unsent internal repair attempt when a guarded failure crosses the cap", async () => {
		const fixture = await repairSession({ warmSmol: true, loopFirst: true, cap: 0.5 });

		await fixture.edit();
		await fixture.edit("next-repair.ts");

		expect(fixture.sent).toEqual([{ provider: fixture.smolProvider, key: "synthetic-access-smol-a" }]);
		expect(fixture.session.costGate.spent).toBeCloseTo(0.6);
		expect(() => fixture.session.costGate.admit()).toThrow(CostCapError);
		expect(fixture.repairUsage().map(entry => [entry.stopReason, entry.usage.cost.total])).toEqual([
			["error", expect.closeTo(0.6)],
		]);
		expect(await Bun.file(fixture.dir.join("repair.ts")).text()).toBe(repairBroken);
		expect(await Bun.file(fixture.dir.join("next-repair.ts")).text()).toBe(repairBroken);
	});

	it("retains completed repair spend and originating journal ownership when cancelled during internal backoff", async () => {
		const fixture = await repairSession({ warmSmol: true, loopFirst: true });
		const origin = fixture.journal.appendMessage({
			role: "user",
			content: "Repair then cancel",
			timestamp: Date.now(),
		});
		let successor: string | undefined;
		fixture.onDispatch(() => {
			successor ??= fixture.journal.appendCustomEntry("repair-cancel-successor", {});
		});
		const controller = new AbortController();
		const wait = scheduler.wait.bind(scheduler);
		let backoffReached = false;
		const backoff = spyOn(scheduler, "wait").mockImplementation((delay, options) => {
			const pending = wait(delay, options);
			if (delay === 500 && options?.signal && !backoffReached) {
				backoffReached = true;
				queueMicrotask(() => controller.abort(new Error("Synthetic repair cancellation")));
			}
			return pending;
		});
		try {
			await fixture.edit("repair.ts", controller.signal);
		} finally {
			backoff.mockRestore();
		}

		expect(backoffReached).toBe(true);
		expect(controller.signal.aborted).toBe(true);
		expect(fixture.sent).toEqual([{ provider: fixture.smolProvider, key: "synthetic-access-smol-a" }]);
		expect(fixture.session.costGate.spent).toBeCloseTo(0.6);
		const usage = fixture.repairUsage();
		expect(usage.map(entry => [entry.stopReason, entry.parentId, entry.usage.cost.total])).toEqual([
			["error", origin, expect.closeTo(0.6)],
		]);
		if (successor === undefined) throw new Error("Concurrent cancelled-repair leaf was not created");
		expect(fixture.journal.getLeafId()).toBe(successor);
		expect(await Bun.file(fixture.dir.join("repair.ts")).text()).toBe(repairBroken);
	});
});
