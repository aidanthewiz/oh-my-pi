import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

import { cfgEvalPy } from "@oh-my-pi/pi-coding-agent/eval/settings";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
	} as unknown as ToolSession;
}

function wireLanguages(tool: EvalTool): string[] {
	const wire = toolWireSchema(tool as unknown as AiTool) as {
		properties?: { language?: { enum?: string[]; const?: string } };
	};
	const language = wire.properties?.language;
	return Array.isArray(language?.enum)
		? [...language.enum].sort()
		: typeof language?.const === "string"
			? [language.const]
			: [];
}

describe("eval tool dynamic schema", () => {
	// resolveEvalBackends lets PI_* env flags override settings; neutralize them per-test
	// so the schema is driven purely by the isolated settings (and restore to avoid leaks).
	const EVAL_ENV_FLAGS = ["PI_PY", "PI_JS"] as const;
	let savedEnv: Record<string, string | undefined>;
	beforeEach(() => {
		savedEnv = {};
		for (const flag of EVAL_ENV_FLAGS) {
			savedEnv[flag] = Bun.env[flag];
			delete Bun.env[flag];
		}
	});
	afterEach(() => {
		for (const flag of EVAL_ENV_FLAGS) {
			const prior = savedEnv[flag];
			if (prior === undefined) delete Bun.env[flag];
			else Bun.env[flag] = prior;
		}
	});

	it("follows eval.py changes made after construction on the next schema read", () => {
		const session = makeSession();
		const tool = new EvalTool(session);
		expect(wireLanguages(tool)).toEqual(["js", "py"]);
		cfgEvalPy.set(session.settings, false);
		expect(wireLanguages(tool)).toEqual(["js"]);
		expect(tool.examples.some(example => "call" in example && example.call.language === "py")).toBe(false);
		cfgEvalPy.set(session.settings, true);
		expect(wireLanguages(tool)).toEqual(["js", "py"]);
	});
});
