import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "arktype";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import * as taskDiscovery from "./discovery";
import { TaskTool } from "./index";
import type { AgentDefinition } from "./types";
import { getTaskSchema } from "./types";

const factFinderAgent = {
	name: "fact-finder",
	description: "Find facts.",
	systemPrompt: "Find facts.",
	source: "project",
} satisfies AgentDefinition;

const oracleAgent = {
	name: "oracle",
	description: "Answer hard questions.",
	systemPrompt: "Answer hard questions.",
	source: "bundled",
} satisfies AgentDefinition;

function makeSession(spawns: string): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.isolation.mode": "none",
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => spawns,
	};
}

describe("task spawn policy surfaces", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the first allowed spawn as the schema default", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "fact-finder" });
		const parsed = schema({ task: "check" });

		expect(parsed).toEqual({ agent: "fact-finder", task: "check" });
	});

	it("accepts per-spawn context inheritance policy in flat and batch schemas", () => {
		const flat = getTaskSchema({ isolationEnabled: false, batchEnabled: false });
		expect(flat({ task: "start fresh", contextFilePolicy: "none" })).toEqual({
			agent: "task",
			task: "start fresh",
			contextFilePolicy: "none",
		});

		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		expect(
			batch({
				context: "shared",
				tasks: [
					{ task: "inherit", contextFilePolicy: "inherit" },
					{ task: "fresh", contextFilePolicy: "none" },
				],
			}),
		).toEqual({
			context: "shared",
			tasks: [
				{ agent: "task", task: "inherit", contextFilePolicy: "inherit" },
				{ agent: "task", task: "fresh", contextFilePolicy: "none" },
			],
		});
		expect(flat({ task: "invalid", contextFilePolicy: "sometimes" })).toBeInstanceOf(type.errors);
	});

	it("filters the agent list to the restricted spawn policy in the description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [factFinderAgent, oracleAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("fact-finder"));
		const description = tool.description;

		expect(description).toContain("### fact-finder");
		expect(description).not.toContain("### oracle");
	});
});
