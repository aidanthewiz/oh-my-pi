import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents, parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { isBundledSeance } from "@oh-my-pi/pi-coding-agent/task/seance";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord } from "@oh-my-pi/pi-utils";

let taskSchemaSessionIndex = 0;
const bundledSeance = loadBundledAgents().find(agent => isBundledSeance(agent))!;

function createSession(
	options: {
		parentSpawns?: string;
		disabledAgents?: string[];
		planMode?: boolean;
		settings?: Record<string, unknown>;
	} = {},
): ToolSession {
	return {
		cwd: `/tmp/task-schema-${taskSchemaSessionIndex++}`,
		hasUI: false,
		settings: Settings.isolated({
			"task.isolation.enabled": false,
			"task.batch": false,
			"task.disabledAgents": options.disabledAgents ?? [],
			...options.settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.parentSpawns ?? "*",
		getPlanModeState: () => ({ enabled: options.planMode ?? false }),
	} as unknown as ToolSession;
}

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields while accepting a caller
// `outputSchema` and its validation mode. The batch shape (`tasks[]` + shared
// `context`) is gated by the `task.batch` setting (default on, covered by
// test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it.each([false, true])("advertises only the source task.steps selects (batch=%s)", batchEnabled => {
		// Enabled first: the disabled schema must not reuse the enabled one from the cache.
		for (const steps of [true, false]) {
			const schema = getTaskSchema({ batchEnabled, isolationEnabled: false, steps });
			const item = steps
				? { steps: ["Add the parser.", "Wire it in."], solutionSpace: "one defined change" }
				: { task: "Add the parser.", solutionSpace: "one defined change" };
			const parsed = schema(batchEnabled ? { context: "shared context", tasks: [item] } : item);
			if (parsed instanceof type.errors) throw new Error(parsed.summary);
			expect(parsed).toMatchObject(batchEnabled ? { tasks: [item] } : item);
			const wire = schema.toJsonSchema();
			const tasks = isRecord(wire.properties) ? wire.properties.tasks : undefined;
			const itemWire = batchEnabled && isRecord(tasks) ? tasks.items : wire;
			if (!isRecord(itemWire)) throw new Error("Expected an object schema for task input");
			expect(itemWire.required).toContain(steps ? "steps" : "task");
			expect(itemWire.properties).not.toHaveProperty(steps ? "task" : "steps");
		}
	});

	it("removes eval tool names from the wire shape when eval.tools.enabled is off", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
			evalToolsEnabled: false,
		});
		const parsed = schema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			tools: ["word_count"],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && !(parsed instanceof type.errors)) {
			expect("tools" in parsed).toBe(false);
		}
	});

	it("retains caller outputSchema, schemaMode, and eval tool names while stripping stale keys", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const parsed = taskSchema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "c",
			outputSchema,
			schemaMode: "strict",
			tools: ["word_count"],
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.outputSchema).toEqual(outputSchema);
			expect(parsed.schemaMode).toBe("strict");
			expect(parsed.tools).toEqual(["word_count"]);
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});
});

describe("task schema per-call model field", () => {
	it("advertises model only as one string when per-call model is enabled", () => {
		for (const batchEnabled of [false, true]) {
			for (const isolationEnabled of [false, true]) {
				const schema = getTaskSchema({ batchEnabled, isolationEnabled });
				const wireSchema = JSON.stringify(schema.toJsonSchema());
				expect(wireSchema).not.toContain('"model"');
				const perCall = JSON.stringify(
					getTaskSchema({ batchEnabled, isolationEnabled, perCallModel: true }).toJsonSchema(),
				);
				expect(perCall).toContain('"model":{"type":"string"}');
			}
		}
	});

	it("advertises fields only when bundled seance is spawnable", async () => {
		const discovery = vi
			.spyOn(discoveryModule, "discoverAgents")
			.mockResolvedValue({ agents: [bundledSeance], projectAgentsDir: null });

		const allowed = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		expect(JSON.stringify(allowed.parameters.toJsonSchema())).toContain('"sourceSession"');

		const policyDenied = await TaskTool.create(createSession({ parentSpawns: "task" }));
		expect(JSON.stringify(policyDenied.parameters.toJsonSchema())).not.toContain('"sourceSession"');

		const agentDisabled = await TaskTool.create(
			createSession({ parentSpawns: "task,seance", disabledAgents: ["seance"] }),
		);
		expect(JSON.stringify(agentDisabled.parameters.toJsonSchema())).not.toContain('"sourceSession"');

		discovery.mockResolvedValue({ agents: [], projectAgentsDir: null });
		const absentFromCatalogue = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		expect(JSON.stringify(absentFromCatalogue.parameters.toJsonSchema())).not.toContain('"sourceSession"');

		const customSeance = parseAgent(
			"project-seance.md",
			`---
name: seance
description: Custom historical agent.
---
Custom prompt.`,
			"project",
		);
		expect(isBundledSeance(customSeance)).toBe(false);
		discovery.mockResolvedValue({ agents: [customSeance], projectAgentsDir: null });
		const overridden = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		expect(JSON.stringify(overridden.parameters.toJsonSchema())).not.toContain('"sourceSession"');
	});

	it("hides seance fields in plan mode while retaining per-call model validation", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [bundledSeance],
			projectAgentsDir: null,
		});
		const planMode = await TaskTool.create(createSession({ parentSpawns: "task,seance", planMode: true }));
		const planSchema = JSON.stringify(planMode.parameters.toJsonSchema());
		expect(planSchema).not.toContain('"sourceSession"');
		expect(planSchema).not.toContain("seance");
		expect(planSchema).not.toContain('"model"');

		const ordinary = await TaskTool.create(createSession({ parentSpawns: "task,seance" }));
		const ordinarySchema = JSON.stringify(ordinary.parameters.toJsonSchema());
		expect(ordinarySchema).toContain('"sourceSession"');
		expect(ordinarySchema).toContain('"model"');
	});
	it.each([
		["off", false],
		["eval", false],
		["on", true],
	] as const)("advertises model only when task.perCallModel allows task calls (%s)", async (mode, advertised) => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession({ settings: { "task.perCallModel": mode } }));
		expect(JSON.stringify(tool.parameters.toJsonSchema()).includes('"model"')).toBe(advertised);
	});
	afterEach(() => vi.restoreAllMocks());
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function executeText(params: unknown, agents: AgentDefinition[] = []): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "scout" });
		expect(text).toContain("Missing `task`");
	});

	it.each([
		{
			label: "both task and steps",
			params: { agent: "scout", task: "Map auth.", steps: ["Map auth."] },
			refusal: "takes `task` or `steps`, not both",
		},
		{ label: "empty steps", params: { agent: "scout", steps: [] }, refusal: "invalid `steps`" },
		{ label: "a blank step", params: { agent: "scout", steps: ["Map auth.", "  "] }, refusal: "invalid `steps`" },
	])("refuses $label", async ({ params, refusal }) => {
		expect(await executeText({ ...params, solutionSpace: "c" })).toContain(refusal);
	});
	it("rejects a model override for an ordinary task while task.perCallModel is off", async () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: false,
		});
		const params = {
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "focused inspection",
			model: "anthropic/claude-sonnet-4-5",
		};
		expect(schema(params) instanceof type.errors).toBe(false);
		const scout = loadBundledAgents().find(agent => agent.name === "scout");
		if (!scout) throw new Error("Expected the bundled scout agent");
		expect(await executeText(params, [scout])).toContain("task.perCallModel: off");
	});
});
