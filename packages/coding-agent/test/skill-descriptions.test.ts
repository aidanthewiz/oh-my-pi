import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type SkillDescriptionCompressor,
	SkillDescriptionCatalog,
	SkillDescriptionStore,
} from "../src/extensibility/skill-descriptions";
import type { Skill } from "../src/extensibility/skills";
import { buildSystemPrompt } from "../src/system-prompt";

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
