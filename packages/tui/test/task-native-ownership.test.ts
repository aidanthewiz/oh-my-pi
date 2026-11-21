import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { TspProps } from "@oh-my-pi/pi-wire";
import { ToolExecutionComponent, type ToolExecutionUi } from "../src/chat/tool-execution";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { isNativeRendering, setNativeRendering } from "../src/native/state";
import type { ToolRenderResult } from "../src/tools/renderer";
import { taskToolRenderer, type AgentProgress, type SingleResult, type TaskToolDetails } from "../src/tools/task";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";

const opts = { expanded: true, isPartial: true };
const cx: DescribeContext = {
	cols: 80,
	reduceMotion: true,
	dark: true,
	supports: () => true,
	feature: () => true,
};

function progress(id: string, durationMs: number, extra: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "synthetic task",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs,
		...extra,
	};
}

function result(id: string, extra: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "synthetic task",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 10000,
		tokens: 0,
		requests: 0,
		...extra,
	};
}

function snapshot(progressRows: AgentProgress[] = [], results: SingleResult[] = []): ToolRenderResult<TaskToolDetails> {
	return { content: [], details: { projectAgentsDir: null, results, totalDurationMs: 0, progress: progressRows } };
}

function allNodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	const found: NativeNode[] = [];
	for (const child of children ?? []) {
		if ("k" in child) found.push(child, ...allNodes(child.c));
	}
	return found;
}

function cardAgents(card: ToolExecutionComponent): NativeNode[] {
	return allNodes([card.describe(cx)]).filter(item => item.k === "agent");
}

function agentProps(agent: NativeNode | undefined): TspProps<"agent"> {
	if (!agent || agent.k !== "agent" || !agent.p) throw new Error("Fixture did not render an agent node");
	return agent.p;
}

function withCards(inspect: (create: () => ToolExecutionComponent, now: (value: number) => void) => void): void {
	const wasNative = isNativeRendering();
	let currentTime = 100000;
	const clock = spyOn(Date, "now").mockImplementation(() => currentTime);
	const cards: ToolExecutionComponent[] = [];
	const ui: ToolExecutionUi = {
		requestRender() {},
		requestComponentRender() {},
		resetDisplay() {},
	};
	setNativeRendering(true);
	try {
		inspect(
			() => {
				const card = new ToolExecutionComponent("task", {}, {}, undefined, ui);
				cards.push(card);
				card.setArgsComplete();
				card.setExpanded(true);
				return card;
			},
			value => {
				currentTime = value;
			},
		);
	} finally {
		for (const card of cards) card.dispose();
		clock.mockRestore();
		setNativeRendering(wasNative);
	}
}

function renderedAgents(value: ToolRenderResult<TaskToolDetails>, nowMs: number): NativeNode[] {
	const view = taskToolRenderer.describeResult(value, { ...opts, renderContext: { nowMs } });
	return allNodes(view?.body).filter(item => item.k === "agent");
}

describe("task native card lifetimes and literal assignments", () => {
	let theme: Theme;
	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
	});

	it("[TuiChat-task-completed-root] does not inherit the age of a completed card with the same agent id", () => {
		withCards((create, now) => {
			const first = create();
			first.updateResult(snapshot([progress("TuiChatCompletedRoot", 10000)]), true);
			expect(agentProps(cardAgents(first)[0]).stats?.age).toBe(10000);
			now(110000);
			first.updateResult(snapshot([], [result("TuiChatCompletedRoot")]), false);
			expect(agentProps(cardAgents(first)[0]).stats?.took).toBe(10000);
			now(200000);
			const second = create();
			second.updateResult(snapshot([progress("TuiChatCompletedRoot", 1000)]), true);
			expect(agentProps(cardAgents(second)[0]).stats?.age).toBe(1000);
		});
	});

	it("[TuiChat-task-live-roots] keeps independent live ages for cards receiving the same immutable snapshot and clock", () => {
		withCards((create, now) => {
			const first = create();
			const second = create();
			first.updateResult(snapshot([progress("TuiChatLiveRoots", 10000)]), true);
			expect(agentProps(cardAgents(first)[0]).stats?.age).toBe(10000);
			now(200000);
			const shared = snapshot([progress("TuiChatLiveRoots", 1000)]);
			first.updateResult(shared, true);
			second.updateResult(shared, true);
			expect(agentProps(cardAgents(first)[0]).stats?.age).toBe(110000);
			expect(agentProps(cardAgents(second)[0]).stats?.age).toBe(1000);
		});
	});

	it("[TuiChat-task-immutable-lifetime] retains an existing card's earliest start across zero and stale duration snapshots", () => {
		withCards((create, now) => {
			const card = create();
			card.updateResult(snapshot([progress("TuiChatImmutableLifetime", 1000)]), true);
			expect(agentProps(cardAgents(card)[0]).stats?.age).toBe(1000);
			now(102000);
			card.updateResult(snapshot([progress("TuiChatImmutableLifetime", 0)]), true);
			expect(agentProps(cardAgents(card)[0]).stats?.age).toBe(3000);
			now(103000);
			card.updateResult(snapshot([progress("TuiChatImmutableLifetime", 1000)]), true);
			expect(agentProps(cardAgents(card)[0]).stats?.age).toBe(4000);
		});
	});

	it("[TuiChat-task-nested-ancestry] keeps repeated child ids independent beneath distinct parents in one card", () => {
		withCards((create, now) => {
			const card = create();
			const value = (left: number, right: number) =>
				snapshot([
					progress("TuiChatLeft", 10000, {
						inflightTaskDetails: snapshot([progress("TuiChatRepeatedChild", left)]).details,
					}),
					progress("TuiChatRight", 1000, {
						index: 1,
						inflightTaskDetails: snapshot([progress("TuiChatRepeatedChild", right)]).details,
					}),
				]);
			const childAges = () =>
				cardAgents(card)
					.filter(item => item.key === "TuiChatRepeatedChild")
					.map(item => agentProps(item).stats?.age);
			card.updateResult(value(10000, 1000), true);
			expect(childAges()).toEqual([10000, 1000]);
			now(102000);
			card.updateResult(value(0, 0), true);
			expect(childAges()).toEqual([12000, 3000]);
		});
	});

	it("[TuiChat-task-unowned-renderer] uses supplied durations for independent renderer calls without a card lifetime", () => {
		expect(agentProps(renderedAgents(snapshot([progress("TuiChatUnowned", 10000)]), 100000)[0]).stats?.age).toBe(
			10000,
		);
		expect(agentProps(renderedAgents(snapshot([progress("TuiChatUnowned", 1000)]), 200000)[0]).stats?.age).toBe(1000);
	});
});
