import { describe, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	type SkillDescriptionCompressor,
	SkillDescriptionCatalog,
	SkillDescriptionStore,
	createSkillDescriptionCompressor,
} from "../src/extensibility/skill-descriptions";
import type { Skill } from "../src/extensibility/skills";
import { buildSystemPrompt } from "../src/system-prompt";
import { CostGate } from "../src/session/cost-gate";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const original: Skill = {
	name: "browser-research",
	description:
		"Use when exploring interactive sites with JavaScript execution, authenticated sessions, and multi-step browser actions; do not use for static public web pages that can be read directly.",
	filePath: "/skills/browser-research/SKILL.md",
	baseDir: "/skills/browser-research",
	source: "test",
};

describe("system prompt skill descriptions", () => {
	it("renders an immediate bounded preview, deduplicates in-flight work, and holds a session snapshot", async () => {
		using temp = TempDir.createSync("omp-skill-description-");
		// Declared after `temp`, so it closes first and Windows can delete the file.
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		const { promise, resolve } = Promise.withResolvers<string>();
		const started = Promise.withResolvers<void>();
		let calls = 0;
		const compress: SkillDescriptionCompressor = {
			modelKey: () => "test/smol-a",
			compress: () => {
				calls++;
				started.resolve();
				return promise;
			},
		};
		const session = new SkillDescriptionCatalog({ store, compress });
		const preview = session.render([original, original])[0]?.description;
		expect(preview).toBeDefined();
		expect(preview!.length).toBeLessThanOrEqual(100);
		expect(preview).toEndWith("…");
		expect(preview).not.toBe(original.description);
		expect(calls).toBe(0);
		await started.promise;
		expect(calls).toBe(1);
		const concurrent = new SkillDescriptionCatalog({ store, compress });
		expect(concurrent.render([original])[0]?.description).toBe(preview);
		await Promise.resolve();
		expect(calls).toBe(1);
		expect(session.render([original])[0]?.description).toBe(preview);
		const before = await buildSystemPrompt({
			skills: [original],
			skillDescriptions: session,
			toolNames: ["read"],
			systemPromptTemplate: "{{#each skills}}- {{name}}: {{description}}{{/each}}",
		});
		expect(before.systemPrompt.join("\n")).toContain(`- ${original.name}: ${preview}`);

		const compressed = "Use for interactive or authenticated browser tasks; not static public pages.";
		resolve(compressed);
		await session.waitForPending();
		expect(session.render([original])[0]?.description).toBe(preview);
		const nextSession = new SkillDescriptionCatalog({ store });
		expect(nextSession.render([original])[0]?.description).toBe(compressed);
		const after = await buildSystemPrompt({
			skills: [original],
			skillDescriptions: nextSession,
			toolNames: ["read"],
			systemPromptTemplate: "{{#each skills}}- {{name}}: {{description}}{{/each}}",
		});
		expect(after.systemPrompt.join("\n")).toContain(`- ${original.name}: ${compressed}`);
	});

	it("misses on a changed full description rather than serving stale cached text", async () => {
		using temp = TempDir.createSync("omp-skill-description-change-");
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		let calls = 0;
		const first = new SkillDescriptionCatalog({
			store,
			compress: {
				modelKey: () => "test/smol-a",
				compress: async () => {
					calls++;
					return "Use for interactive browser tasks.";
				},
			},
		});
		first.render([original]);
		await first.waitForPending();
		const changed = { ...original, description: `${original.description} Also inspect accessibility trees.` };
		const next = new SkillDescriptionCatalog({
			store,
			compress: {
				modelKey: () => "test/smol-a",
				compress: async () => {
					calls++;
					return "Use for interactive browser and accessibility tasks.";
				},
			},
		});
		expect(next.render([changed])[0]?.description).not.toBe("Use for interactive browser tasks.");
		await next.waitForPending();
		expect(calls).toBe(2);
	});

	it("avoids repeating an unusable compression until the model changes", async () => {
		using temp = TempDir.createSync("omp-skill-description-invalid-");
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		let modelACalls = 0;
		const failed = new SkillDescriptionCatalog({
			store,
			compress: {
				modelKey: () => "test/smol-a",
				compress: async () => {
					modelACalls++;
					return "line one\nline two";
				},
			},
		});
		const preview = failed.render([original])[0]?.description;
		await failed.waitForPending();
		const sameModel = new SkillDescriptionCatalog({
			store,
			compress: {
				modelKey: () => "test/smol-a",
				compress: async () => {
					modelACalls++;
					return "Use for interactive sites; not static pages.";
				},
			},
		});
		expect(sameModel.render([original])[0]?.description).toBe(preview);
		await sameModel.waitForPending();
		expect(modelACalls).toBe(1);
		let modelBCalls = 0;
		const nextModel = new SkillDescriptionCatalog({
			store,
			compress: {
				modelKey: () => "test/smol-b",
				compress: async () => {
					modelBCalls++;
					return "Use for interactive sites; not static pages.";
				},
			},
		});
		nextModel.render([original]);
		await nextModel.waitForPending();
		expect(modelBCalls).toBe(1);
		expect(new SkillDescriptionCatalog({ store }).render([original])[0]?.description).toBe(
			"Use for interactive sites; not static pages.",
		);
	});

	it("retries a transport failure for the same model in a later session", async () => {
		using temp = TempDir.createSync("omp-skill-description-transport-");
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		const failed = new SkillDescriptionCatalog({
			store,
			compress: {
				modelKey: () => "test/smol-a",
				compress: async () => {
					throw new Error("synthetic transport failure");
				},
			},
		});
		const preview = failed.render([original])[0]?.description;
		await failed.waitForPending();
		const retry = new SkillDescriptionCatalog({
			store,
			compress: {
				modelKey: () => "test/smol-a",
				compress: async () => "Use for interactive sites; not static pages.",
			},
		});
		expect(retry.render([original])[0]?.description).toBe(preview);
		await retry.waitForPending();
		expect(new SkillDescriptionCatalog({ store }).render([original])[0]?.description).toBe(
			"Use for interactive sites; not static pages.",
		);
	});

	it("persists completed descriptions across store closure and reopening", async () => {
		using temp = TempDir.createSync("omp-skill-description-handle-");
		const dbPath = temp.join("skills.db");
		const store = SkillDescriptionStore.open(dbPath);
		try {
			const first = new SkillDescriptionCatalog({
				store,
				compress: {
					modelKey: () => "test/smol-a",
					compress: async () => "Use for interactive sites.",
				},
			});
			first.render([original]);
			await first.waitForPending();
			expect(new SkillDescriptionCatalog({ store }).render([original])[0]?.description).toBe(
				"Use for interactive sites.",
			);
		} finally {
			await store.close();
		}
		using reopened = SkillDescriptionStore.open(dbPath);
		expect(new SkillDescriptionCatalog({ store: reopened }).render([original])[0]?.description).toBe(
			"Use for interactive sites.",
		);
	});
});

describe("skill compression request ownership", () => {
	function fixture() {
		const id = Bun.randomUUIDv7();
		const api = `skill-compression-${id}`;
		const provider = `skill-owner-${id}`;
		const temp = TempDir.createSync("omp-skill-request-");
		const auth = createInMemoryAuthStorage();
		const settings = Settings.isolated({ modelRoles: { smol: `${provider}/probe` } });
		const registry = new ModelRegistry(auth, temp.join("models.yml"), { settings });
		const journal = SessionManager.inMemory(temp.path());
		const gate = new CostGate(settings, 0, () => {});
		const started = Promise.withResolvers<void>();
		const control = {
			current: true,
			credentials: 0,
			calls: [] as string[],
			reply: Promise.resolve(),
		};
		registerCustomApi(
			api,
			model => {
				control.calls.push(`${model.provider}/${model.id}`);
				started.resolve();
				const stream = new AssistantMessageEventStream();
				void control.reply.then(() => {
					const message = createAssistantMessage("Use for interactive browser tasks.");
					message.api = model.api;
					message.provider = model.provider;
					message.model = model.id;
					message.usage.cost.total = 0.25;
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			id,
		);
		registry.registerProvider(provider, {
			api,
			baseUrl: "https://synthetic.invalid",
			apiKey: "synthetic-key",
			models: [
				{
					id: "probe",
					name: "Probe",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 4096,
					maxTokens: 1024,
				},
			],
		});
		const session: ToolSession = {
			cwd: journal.getCwd(),
			hasUI: false,
			settings,
			modelRegistry: registry,
			sessionManager: journal,
			costGate: gate,
			getSessionId: () => journal.getSessionId(),
			getSessionFile: () => journal.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			captureRequestOwner: () => ({
				isCurrent: () => control.current,
				bindCredential: () => control.current,
			}),
			getApiKey: () => {
				control.credentials++;
				return "synthetic-key";
			},
			prepareSimpleStreamOptions: options => options,
		};
		return {
			provider,
			settings,
			registry,
			session,
			journal,
			gate,
			control,
			started,
			compressor: createSkillDescriptionCompressor(registry, settings, { session }),
			async [Symbol.asyncDispose]() {
				unregisterCustomApis(id);
				await auth.close();
				await temp.remove();
				vi.restoreAllMocks();
			},
		};
	}

	it("does not turn an unconfigured, project-only, or fuzzy role into a paid request", async () => {
		await using f = fixture();
		f.settings.setModelRole("smol", undefined);
		f.settings.setModelRole("default", `${f.provider}/probe`);
		await expect(f.compressor.compress("skill", "description", "request")).rejects.toThrow("trusted configured");
		f.settings.setProjectModelRole("smol", `${f.provider}/probe`);
		await expect(f.compressor.compress("skill", "description", "request")).rejects.toThrow("trusted configured");
		f.settings.setModelRole("smol", "probe");
		await expect(f.compressor.compress("skill", "description", "request")).rejects.toThrow("trusted configured");
		expect(f.control.credentials).toBe(0);
		expect(f.control.calls).toEqual([]);
	});

	it("refuses a frozen session at the provider boundary without executing the provider", async () => {
		await using f = fixture();
		f.session.prepareSimpleStreamOptions = options => ({
			...options,
			beforeDispatch: () => {
				throw new Error("Session is frozen");
			},
		});
		await expect(f.compressor.compress("skill", "description", "request")).rejects.toThrow("frozen");
		expect(f.control.calls).toEqual([]);
		expect(f.gate.spent).toBe(0);
	});

	it("does not dispatch after credential resolution loses its captured owner", async () => {
		await using f = fixture();
		const started = Promise.withResolvers<void>();
		const credential = Promise.withResolvers<string>();
		f.session.getApiKey = () => async () => {
			started.resolve();
			return credential.promise;
		};
		const pending = f.compressor.compress("skill", "description", "request");
		await started.promise;
		f.control.current = false;
		credential.resolve("synthetic-key");
		await expect(pending).rejects.toThrow("credential changed");
		expect(f.control.calls).toEqual([]);
	});

	it("invalidates queued compression before a closing session can mint credentials", async () => {
		await using f = fixture();
		using temp = TempDir.createSync("omp-skill-queued-close-");
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		const catalog = new SkillDescriptionCatalog({ store, compress: f.compressor });
		catalog.render([original]);
		await catalog.drain();
		expect(f.control.credentials).toBe(0);
		expect(f.control.calls).toEqual([]);
		expect(f.journal.getEntries().filter(entry => entry.type === "model_usage")).toEqual([]);
	});

	it("drains accepted usage into the initiating journal before releasing transition custody", async () => {
		await using f = fixture();
		using temp = TempDir.createSync("omp-skill-owner-drain-");
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		const reply = Promise.withResolvers<void>();
		f.control.reply = reply.promise;
		const flushStarted = Promise.withResolvers<void>();
		const flushAllowed = Promise.withResolvers<void>();
		const originalFlush = f.journal.flush.bind(f.journal);
		vi.spyOn(f.journal, "flush").mockImplementation(async () => {
			await originalFlush();
			flushStarted.resolve();
			await flushAllowed.promise;
		});
		const catalog = new SkillDescriptionCatalog({ store, compress: f.compressor });
		const preview = catalog.render([original])[0]?.description;
		let draining: Promise<void> | undefined;
		try {
			await f.started.promise;
			f.control.current = false;
			let drained = false;
			draining = catalog.drain().then(() => {
				drained = true;
			});
			reply.resolve();
			await flushStarted.promise;
			expect(drained).toBe(false);
			expect(f.gate.spent).toBe(0.25);
			expect(
				f.journal
					.getEntries()
					.filter(entry => entry.type === "model_usage")
					.map(entry => ({
						purpose: entry.purpose,
						provider: entry.provider,
						cost: entry.usage.cost.total,
					})),
			).toEqual([{ purpose: "skill-description", provider: f.provider, cost: 0.25 }]);
			flushAllowed.resolve();
			await draining;
			expect(new SkillDescriptionCatalog({ store }).render([original])[0]?.description).toBe(preview);
			expect(f.control.calls).toEqual([`${f.provider}/probe`]);
		} finally {
			reply.resolve();
			flushAllowed.resolve();
			await draining;
		}
	});

	it("does not report drained custody when accepted usage could not be persisted", async () => {
		await using f = fixture();
		using temp = TempDir.createSync("omp-skill-usage-failure-");
		using store = SkillDescriptionStore.open(temp.join("skills.db"));
		const reply = Promise.withResolvers<void>();
		f.control.reply = reply.promise;
		vi.spyOn(f.journal, "flush").mockRejectedValue(new Error("journal unavailable"));
		const catalog = new SkillDescriptionCatalog({ store, compress: f.compressor });
		catalog.render([original]);
		try {
			await f.started.promise;
			reply.resolve();
			await expect(catalog.waitForPending()).rejects.toThrow("usage persistence failed");
			await expect(catalog.drain()).rejects.toThrow("usage persistence failed");
			expect(f.gate.spent).toBe(0.25);
		} finally {
			reply.resolve();
			await catalog.waitForPending().catch(() => {});
		}
	});
});
