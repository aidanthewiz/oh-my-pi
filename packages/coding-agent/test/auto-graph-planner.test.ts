import { describe, expect, it } from "bun:test";
import type { Answer } from "@oh-my-pi/pi-ai";
import { judgeRequest, planFromAnswers } from "@oh-my-pi/pi-coding-agent/auto-graph/planner";
import { buildChart, planChart } from "@oh-my-pi/pi-tui/charts/chart-plan";
import { renderChartSvg } from "@oh-my-pi/pi-tui/charts/chart-svg";
import { analyzeTable } from "@oh-my-pi/pi-tui/charts/table-data";
import type { TableChartRequest } from "@oh-my-pi/pi-tui/chat/table-chart";

/** A smart-mode request for a table given as rows of cells, header first. */
function request(rows: string[][]): TableChartRequest {
	const [header, ...body] = rows;
	const table = analyzeTable(header!, body);
	const guess = planChart(table);
	if (!guess) throw new Error("fixture draws no chart");
	const markdown = [header!, header!.map(() => "---"), ...body].map(cells => `| ${cells.join(" | ")} |`).join("\n");
	return { markdown, table, guess };
}

function choice(label: string, odds: number): Answer {
	return { type: "choice", choice: label, probabilities: { [label]: odds }, confidence: odds };
}

const ARMS = request([
	["arm", "pass", "latency", "$/task"],
	["opus48", "87%", "10.4 s", "$2.82"],
	["n12", "71%", "6.4 s", "$1.30"],
	["n8", "66%", "5.8 s", "$1.24"],
	["haiku", "37%", "8.5 s", "$0.72"],
]);

describe("judgeRequest", () => {
	it("stops adding meaning questions once a wide table reaches 25", () => {
		const header = ["Repo", "Model", "Status", ...Array.from({ length: 12 }, (_, at) => `metric ${at + 1}`)];
		const rows = Array.from({ length: 9 }, (_, row) => [
			`repo-${Math.floor(row / 3)}`,
			`model-${row % 3}`,
			row % 2 ? "landed" : "pending",
			...Array.from({ length: 12 }, (_, at) => String((row + 1) * (at + 2))),
		]);
		const { questions } = judgeRequest(request([header, ...rows]));
		expect(Object.keys(questions).length).toBeLessThanOrEqual(25);
		expect(questions.kind?.type).toBe("choice");
	});

	it("offers a kind only where the table's data can draw it", () => {
		const kinds = (req: TableChartRequest) => {
			const { kind } = judgeRequest(req).questions;
			return kind?.type === "choice" ? Object.keys(kind.criteria) : [];
		};
		const budgets = request([
			["Measure", "Result", "Budget"],
			["First paint", "11.0 ms", "≤ 120 ms"],
			["Scroll frame", "0.13 ms", "≤ 4 ms"],
			["Keystroke", "0.12 ms", "≤ 2 ms"],
			["Allocations", "7,246", "≤ 0"],
		]);
		expect(kinds(budgets)).toContain("bullet");
		expect(kinds(ARMS)).not.toContain("bullet");
		expect(kinds(ARMS)).toContain("bar");
	});
});

describe("planFromAnswers", () => {
	it.each([
		{ name: "both reordered conditions", columns: [1, 2], headers: ["Patched runtime", "Stock runtime"] },
		{ name: "only the comparison", columns: [1], headers: ["Patched runtime", "Stock runtime"] },
		{ name: "bare after-only values", columns: [1], headers: ["After", "Before"] },
	])("keeps the original denominator when selecting $name", ({ columns, headers }) => {
		const req = request([
			["Metric", ...headers],
			["Time", "5 s", "10 s"],
			["Memory", "20 MB", "100 MB"],
			["Errors", "0", "9"],
			["Total", "8 s", "20 s"],
		]);
		const answers: Record<string, Answer> = { kind: choice("change", 0.9) };
		for (const column of columns) answers[`c${column}`] = { type: "noul", noul: 0.9 };
		const plan = planFromAnswers(req, answers)!;
		const spec = buildChart(req.table, plan)!;
		expect(spec.baseline).toBe(headers[1]);
		expect(spec.categories).toEqual(["Time", "Memory", "Errors", "Total"]);
		expect(spec.series.map(series => series.name)).toEqual([headers[0]]);
		expect(spec.series[0]!.points.map(point => point?.value)).toEqual([0.5, 0.2, 0, 0.4]);
		expect(renderChartSvg(spec).match(/\baria-label="([^"]*)"/)?.[1]).toContain(headers[1]!);
	});

	it("keeps a selected variant against the same baseline without plotting derived deltas", () => {
		const req = request([
			["Metric", "Patched runtime", "Stock runtime", "Warm runtime", "Delta"],
			["Time", "5 s", "10 s", "7 s", "−50%"],
			["Memory", "20 MB", "100 MB", "80 MB", "−80%"],
			["Errors", "0", "9", "3", "−100%"],
		]);
		const plan = planFromAnswers(req, {
			kind: choice("change", 0.9),
			c3: { type: "noul", noul: 0.9 },
			c4: { type: "noul", noul: 0.9 },
		})!;
		const spec = buildChart(req.table, plan)!;
		expect(spec.baseline).toBe("Stock runtime");
		expect(spec.series.map(series => series.name)).toEqual(["Warm runtime"]);
		expect(spec.series[0]!.points.map(point => point?.value)).toEqual([0.7, 0.8, 1 / 3]);
	});

	it("uses an explicitly selected arrow's own start instead of another condition", () => {
		const req = request([
			["Metric", "Patched runtime", "Stock runtime", "Observed move"],
			["Time", "5 s", "10 s", "20 s → 4 s"],
			["Memory", "20 MB", "100 MB", "80 MB → 40 MB"],
			["Errors", "0", "9", "8 → 2"],
		]);
		const plan = planFromAnswers(req, { kind: choice("change", 0.9), c3: { type: "noul", noul: 0.9 } })!;
		const spec = buildChart(req.table, plan)!;
		expect(spec.series[0]!.points.map(point => point?.value)).toEqual([0.2, 0.5, 0.25]);
	});

	it("does not turn unrelated selected measures into baseline factors", () => {
		const req = request([
			["Project", "Reads", "Writes"],
			["alpha", "17", "3"],
			["beta", "41", "8"],
			["gamma", "23", "12"],
		]);
		const plan = planFromAnswers(req, { kind: choice("grouped", 0.9), c2: { type: "noul", noul: 0.9 } })!;
		const spec = buildChart(req.table, plan)!;
		expect(spec.baseline).toBeUndefined();
		expect(spec.series.map(series => series.name)).toEqual(["Writes"]);
		expect(spec.series[0]!.points.map(point => point?.value)).toEqual([3, 8, 12]);
	});

	it("draws no chart when the judge picks none", () => {
		expect(planFromAnswers(ARMS, { kind: choice("none", 0.9) })).toBeNull();
	});

	it("takes a measure's polarity from the judge only when it is sure, else from the header", () => {
		const latency = ARMS.table.columns.findIndex(column => column.header === "latency");
		const unsure = planFromAnswers(ARMS, { [`p${latency}`]: choice("higher", 0.6) });
		expect(unsure?.polarity?.[latency]).toBe("lower");
		const sure = planFromAnswers(ARMS, { [`p${latency}`]: choice("higher", 0.9) });
		expect(sure?.polarity?.[latency]).toBe("higher");
	});

	it("drops the chart when the judge names rows by the only number in the table", () => {
		const threads = request([
			["Thread", "State", "Owner"],
			["32", "open", "ana"],
			["1", "closed", "bo"],
			["40", "open", "cy"],
			["33", "merged", "di"],
		]);
		expect(planFromAnswers(threads, { label: choice("State", 0.9) })).not.toBeNull();
		expect(planFromAnswers(threads, { label: choice("Thread", 0.9) })).toBeNull();
	});
});
