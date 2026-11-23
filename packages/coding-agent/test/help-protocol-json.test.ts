import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolDocTopic, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { DEFAULT_MAX_LINES } from "@oh-my-pi/pi-tui/tools/streaming-output";

function text(result: AgentToolResult<unknown>): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

function topicFixture(topics: Record<string, AgentToolDocTopic>) {
	let approvals = 0;
	let executions = 0;
	const tool: AgentTool = {
		name: "topic_fixture",
		label: "Topic Fixture",
		description: "Documentation topic fixture",
		parameters: type({}),
		docTopics: () => topics,
		approval: () => {
			approvals++;
			return "exec";
		},
		async execute() {
			executions++;
			throw new Error("Documentation must not execute its tool");
		},
	};
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
		getToolByName: name => (name === tool.name ? tool : undefined),
	};
	return { read: new ReadTool(session), calls: () => ({ approvals, executions }) };
}

describe("help:// structured topics", () => {
	it("returns complete stable JSON without document formatting or paging", async () => {
		const value = {
			z: { text: "complete JSON value\n".repeat(20_000) },
			a: [{ pattern: "^[0-9]+$", minimum: 1, maximum: 9, additionalProperties: false }],
		};
		const topics: Record<string, AgentToolDocTopic> = { data: { format: "json", value } };
		const fixture = topicFixture(topics);
		const first = await fixture.read.execute("json-topic", { path: "help://topic_fixture/data" });
		expect(first.details).toMatchObject({ shape: "value", contentType: "application/json" });
		expect(JSON.parse(text(first))).toEqual(value);
		expect(first.details?.meta?.truncation).toBeUndefined();
		topics.data = {
			format: "json",
			value: {
				a: [{ additionalProperties: false, maximum: 9, minimum: 1, pattern: "^[0-9]+$" }],
				z: value.z,
			},
		};
		const reordered = await fixture.read.execute("reordered-json-topic", { path: "help://topic_fixture/data" });
		expect(text(reordered)).toBe(text(first));
		expect(fixture.calls()).toEqual({ approvals: 0, executions: 0 });
	});

	it("retains string topics as bounded documents", async () => {
		const markdown = [
			"# MARKDOWN_BEGIN",
			...Array.from({ length: DEFAULT_MAX_LINES + 20 }, () => "x"),
			"MARKDOWN_END",
		].join("\n");
		const fixture = topicFixture({ guide: markdown });
		const result = await fixture.read.execute("markdown-topic", { path: "help://topic_fixture/guide" });
		expect(result.details?.shape).not.toBe("value");
		expect(result.details?.contentType).toBe("text/plain");
		expect(text(result)).toContain("MARKDOWN_BEGIN");
		expect(text(result)).not.toContain("MARKDOWN_END");
		expect(result.details?.meta?.truncation?.truncatedBy).toBe("lines");
		expect(fixture.calls()).toEqual({ approvals: 0, executions: 0 });
	});

	it("withholds serialization failures and their private causes without invoking tools", async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const throwing = Object.defineProperty({}, "private", {
			enumerable: true,
			get() {
				throw new Error("private schema serialization cause");
			},
		});
		for (const value of [undefined, 1n, cyclic, throwing]) {
			const fixture = topicFixture({ data: { format: "json", value } });
			let failure: unknown;
			try {
				await fixture.read.execute("invalid-json-topic", { path: "help://topic_fixture/data" });
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(ToolError);
			expect((failure as Error).message).not.toContain("private schema serialization cause");
			expect(Object.hasOwn(failure as Error, "cause")).toBe(false);
			expect(fixture.calls()).toEqual({ approvals: 0, executions: 0 });
		}
	});
});
