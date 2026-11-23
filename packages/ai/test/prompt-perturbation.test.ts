import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as catalogPolicy from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import poolText from "../src/prompts/perturbation-pool.json.txt" with { type: "text" };
import { perturbContext, perturbPromptText, resetPromptPerturbation } from "../src/prompts/perturbation";
import type { Context } from "../src/types";

const pool: { entries: { source: string; variants: string[]; manual?: boolean }[] } = JSON.parse(poolText);

const sample = pool.entries.find(entry => !entry.manual && entry.source.startsWith("`todo`"));
if (!sample) throw new Error("pool lost the todo guidance line");

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("bundled fixture model missing");

const savedPerturbation = process.env.OMP_PROMPT_PERTURBATION;

beforeEach(() => {
	delete process.env.OMP_PROMPT_PERTURBATION;
	resetPromptPerturbation();
});

afterEach(() => {
	if (savedPerturbation === undefined) delete process.env.OMP_PROMPT_PERTURBATION;
	else process.env.OMP_PROMPT_PERTURBATION = savedPerturbation;
	resetPromptPerturbation();
	vi.restoreAllMocks();
});

function optIn(enabled: boolean): void {
	vi.spyOn(catalogPolicy, "resolveCatalogPolicy").mockReturnValue({ promptPerturbation: enabled });
}

const sampleContext: Context = { systemPrompt: [sample.source], messages: [] };

describe("per-install prompt perturbation", () => {
	it("replaces a pooled source with one of its committed variants, stably within the process", () => {
		const first = perturbPromptText(sample.source);
		const second = perturbPromptText(sample.source);
		expect(first).not.toBe(sample.source);
		expect(sample.variants).toContain(first);
		expect(second).toBe(first);
	});

	it("leaves text that matches no pooled source untouched", () => {
		const text = "An arbitrary sentence that no pool entry could have authored.";
		expect(perturbPromptText(text)).toBe(text);
	});

	it("rewrites system blocks and tool descriptions but preserves tool identity and schemas", () => {
		const parameters = { type: "object", properties: {} } as const;
		optIn(true);
		const context = perturbContext(model, {
			systemPrompt: [sample.source, "Kept as-is."],
			messages: [],
			tools: [{ name: "read", description: sample.source, parameters }],
		});
		expect(context.systemPrompt?.[0]).not.toBe(sample.source);
		expect(context.systemPrompt?.[1]).toBe("Kept as-is.");
		expect(context.tools?.[0]?.description).not.toBe(sample.source);
		expect(context.tools?.[0]?.name).toBe("read");
		expect(context.tools?.[0]?.parameters).toBe(parameters);
	});

	it("sends the original prose unless the model opts in through its KDL policy", () => {
		optIn(false);
		expect(perturbContext(model, sampleContext)).toBe(sampleContext);
	});

	it("lets OMP_PROMPT_PERTURBATION override the KDL policy in both directions", () => {
		optIn(false);
		process.env.OMP_PROMPT_PERTURBATION = "1";
		expect(perturbContext(model, sampleContext).systemPrompt?.[0]).not.toBe(sample.source);
		optIn(true);
		process.env.OMP_PROMPT_PERTURBATION = "0";
		expect(perturbContext(model, sampleContext)).toBe(sampleContext);
	});
});
