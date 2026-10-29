import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, getEvalDocTopics } from "@oh-my-pi/pi-coding-agent/tools/eval";

import { cfgEvalPy } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";

function makeSession(opts: {
	spawns?: string | null;
	backends?: Record<string, boolean>;
	taskDepth?: number;
	maxRecursionDepth?: number;
}): ToolSession {
	const settings = Settings.isolated(opts.backends);
	if (opts.maxRecursionDepth !== undefined) cfgTaskMaxRecursionDepth.set(settings, opts.maxRecursionDepth);
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => opts.spawns ?? "*",
		taskDepth: opts.taskDepth,
		settings,
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

describe("eval documentation availability", () => {
	it("withholds agent documentation when spawning is forbidden", () => {
		expect(getEvalDocTopics({ py: true, js: true, spawns: false }).agents).toBeUndefined();
		expect(new EvalTool(makeSession({ spawns: "" })).docTopics().agents).toBeUndefined();
	});

	it("withholds agent documentation at the recursion limit", () => {
		const atCap = new EvalTool(makeSession({ taskDepth: 2, maxRecursionDepth: 2 }));
		const spawningDisabled = new EvalTool(makeSession({ taskDepth: 0, maxRecursionDepth: 0 }));
		for (const tool of [atCap, spawningDisabled]) {
			expect(tool.docTopics().agents).toBeUndefined();
		}
	});
});

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
		const session = makeSession({});
		const tool = new EvalTool(session);
		expect(wireLanguages(tool)).toEqual(["js", "py"]);
		cfgEvalPy.set(session.settings, false);
		expect(wireLanguages(tool)).toEqual(["js"]);
		expect(tool.examples.some(example => "call" in example && example.call.language === "py")).toBe(false);
		cfgEvalPy.set(session.settings, true);
		expect(wireLanguages(tool)).toEqual(["js", "py"]);
	});
});
