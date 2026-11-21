import { describe, expect, it } from "bun:test";
import { type Answer, type Judge, type JudgmentRequest, type Questions, tokenUsage } from "@oh-my-pi/pi-ai";
import {
	candidateCharts,
	type ChartCandidate,
	chartQuestions,
	chosenChart,
	pickTableChart,
	readingQuestions,
} from "@oh-my-pi/pi-coding-agent/auto-graph/planner";
import type { ChainJudge, JudgeKind } from "@oh-my-pi/pi-coding-agent/judgment";
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

function choice(label: string, odds: number, rest: Record<string, number> = {}): Answer {
	return { type: "choice", choice: label, probabilities: { [label]: odds, ...rest }, confidence: odds };
}

function yes(odds: number): Answer {
	return { type: "noul", noul: odds };
}

function drawn(req: TableChartRequest, answers: Record<string, Answer>) {
	return candidateCharts(req, answers).flatMap(candidate => buildChart(req.table, candidate.plan) ?? []);
}

function choose(candidates: readonly ChartCandidate[], candidate: ChartCandidate) {
	const chart = chartQuestions(candidates, "chart").chart;
	if (chart?.type !== "choice") throw new Error("Missing chart choice");
	const key = Object.keys(chart.criteria)[candidates.indexOf(candidate)]!;
	const plan = chosenChart(candidates, { chart: choice(key, 1) });
	if (!plan) throw new Error("Missing chosen chart");
	return plan;
}

const ARMS = request([
	["arm", "pass", "latency", "$/task"],
	["opus48", "87%", "10.4 s", "$2.82"],
	["n12", "71%", "6.4 s", "$1.30"],
	["n8", "66%", "5.8 s", "$1.24"],
	["haiku", "37%", "8.5 s", "$0.72"],
]);

/** Lanes scored on results in different units, beside a sample size and a p-value. */
const LANES = request([
	["Lane", "Runs", "Median", "Runs with ≥10", "p vs baseline", "Median wall", "Median cost", "Median tokens"],
	["baseline", "8", "26.5", "6/8", "—", "12.3 min", "$0.68", "6.3M"],
	["steps", "7", "6", "3/7", "0.42", "8.7 min", "$0.63", "5.7M"],
	["jev", "3", "2", "1/3", "0.68", "8.8 min", "$0.82", "7.0M"],
]);
/** The judge's reading of {@link LANES}: every column a result but the sample size and the p-value. */
const LANE_RESULTS = {
	c1: yes(0.1),
	c2: yes(0.9),
	c3: yes(0.8),
	c4: yes(0.2),
	c5: yes(0.9),
	c6: yes(0.9),
	c7: yes(0.9),
};

/** Rows that are metrics of their own, compared across three builds. */
const BUILDS = request([
	["", "JIT", "AOT", "AOT + trim"],
	["Binary size (MB)", "260.4", "272.6", "226.3"],
	["Build time (s)", "35", "78", "128"],
	["Ready (ms)", "234", "183", "180"],
	["Peak RSS (MB)", "299", "234", "230"],
]);

describe("readingQuestions", () => {
	it("stops adding meaning questions once a wide table reaches 40", () => {
		const header = ["Repo", "Model", "Status", ...Array.from({ length: 30 }, (_, at) => `metric ${at + 1}`)];
		const rows = Array.from({ length: 9 }, (_, row) => [
			`repo-${Math.floor(row / 3)}`,
			`model-${row % 3}`,
			row % 2 ? "landed" : "pending",
			...Array.from({ length: 30 }, (_, at) => String((row + 1) * (at + 2))),
		]);
		const questions = readingQuestions(request([header, ...rows]));
		expect(Object.keys(questions).length).toBeLessThanOrEqual(40);
	});
});

describe("candidateCharts", () => {
	it("keeps the original denominator when only the comparison is selected", () => {
		const req = request([
			["Metric", "Patched runtime", "Stock runtime"],
			["Time", "5 s", "10 s"],
			["Memory", "20 MB", "100 MB"],
			["Errors", "0", "9"],
		]);
		const candidate = candidateCharts(req, { c1: yes(0.9), c2: yes(0.1) }).find(
			candidate => candidate.plan.kind === "change",
		);
		if (!candidate) throw new Error("Missing baseline comparison");
		const spec = buildChart(req.table, candidate.plan)!;
		expect(spec.baseline).toBe("Stock runtime");
		expect(spec.series.map(series => series.name)).toEqual(["Patched runtime"]);
		expect(spec.series[0]!.points.map(point => point?.value)).toEqual([0.5, 0.2, 0]);
		expect(renderChartSvg(spec).match(/\baria-label="([^"]*)"/)?.[1]).toContain("Stock runtime");
	});

	it("keeps a selected variant against the baseline and excludes derived deltas", () => {
		const req = request([
			["Metric", "Patched runtime", "Stock runtime", "Warm runtime", "Delta"],
			["Time", "5 s", "10 s", "7 s", "−50%"],
			["Memory", "20 MB", "100 MB", "80 MB", "−80%"],
			["Errors", "0", "9", "3", "−100%"],
		]);
		const candidates = candidateCharts(req, { c3: yes(0.9), c4: yes(0.9) });
		const candidate = candidates.find(
			candidate => candidate.plan.kind === "change" && candidate.plan.series.includes(3),
		);
		if (!candidate) throw new Error("Missing selected variant comparison");
		const spec = buildChart(req.table, choose(candidates, candidate))!;
		expect(spec.baseline).toBe("Stock runtime");
		expect(spec.series.map(series => series.name)).toEqual(["Warm runtime"]);
		expect(spec.series[0]!.points.map(point => point?.value)).toEqual([0.7, 0.8, 1 / 3]);
		const unrefined = candidates.find(
			candidate =>
				candidate.plan.kind === "change" && candidate.plan.series.includes(1) && candidate.plan.series.includes(3),
		);
		if (!unrefined) throw new Error("Missing unrefined comparison");
		const original = buildChart(req.table, choose(candidates, unrefined))!;
		expect(original.series.map(series => series.name)).toEqual(["Patched runtime", "Warm runtime"]);
		expect(original.series.map(series => series.points[0]?.value)).toEqual([0.5, 0.7]);
	});

	it("projects selected independent baseline pairs without restoring rejected metrics", () => {
		const req = request([
			[
				"Workload",
				"Baseline latency",
				"Iter1 latency",
				"Baseline memory",
				"Iter1 memory",
				"Baseline cost",
				"Iter1 cost",
			],
			["alpha", "10 s", "5 s", "100 MB", "80 MB", "$2", "$1"],
			["beta", "20 s", "8 s", "240 MB", "120 MB", "$3", "$0.75"],
			["gamma", "30 s", "9 s", "400 MB", "100 MB", "$5", "$2"],
		]);
		const candidates = candidateCharts(req, {
			c1: yes(0.9),
			c2: yes(0.9),
			c3: yes(0.9),
			c4: yes(0.9),
			c5: yes(0.1),
			c6: yes(0.1),
		});
		const candidate = candidates[0];
		if (!candidate) throw new Error("Missing selected metric comparisons");
		const spec = buildChart(req.table, choose(candidates, candidate))!;
		expect(spec.kind).toBe("change");
		expect(spec.series.map(series => series.name)).toEqual(["Iter1 latency", "Iter1 memory"]);
		expect(spec.series.map(series => series.points.map(point => point?.value))).toEqual([
			[0.5, 0.4, 0.3],
			[0.8, 0.5, 0.25],
		]);
	});

	it("uses a selected arrow's own start instead of another condition", () => {
		const req = request([
			["Metric", "Patched runtime", "Stock runtime", "Observed move"],
			["Time", "5 s", "10 s", "20 s → 4 s"],
			["Memory", "20 MB", "100 MB", "80 MB → 40 MB"],
			["Errors", "0", "9", "8 → 2"],
		]);
		const candidates = candidateCharts(req, { c3: yes(0.9) });
		const candidate = candidates.find(
			candidate =>
				candidate.plan.series.length === 1 &&
				candidate.plan.series[0] === 3 &&
				buildChart(req.table, candidate.plan)?.kind === "change",
		);
		if (!candidate) throw new Error("Missing arrow comparison");
		const spec = buildChart(req.table, choose(candidates, candidate))!;
		expect(spec.kind).toBe("change");
		expect(spec.series[0]!.points.map(point => point?.value)).toEqual([0.2, 0.5, 0.25]);
	});

	it("leads with every result on its own scale and never divides unlike columns", () => {
		// Median, Median tokens and the p-value share a unit (bare numbers) but not a quantity.
		const charts = drawn(LANES, { ...LANE_RESULTS, k1: yes(0.2) });
		expect(charts[0]?.kind).toBe("multiples");
		expect(charts[0]?.series.map(series => series.name)).toEqual([
			"Median",
			"Runs with ≥10",
			"Median wall",
			"Median cost",
			"Median tokens",
		]);
		expect(charts.some(chart => chart.kind === "change")).toBe(false);
		// Only the judge reading them as one quantity under several conditions offers their factors.
		const alike = drawn(LANES, { ...LANE_RESULTS, k1: yes(0.9) });
		expect(alike.some(chart => chart.kind === "change" && chart.baseline === "Median")).toBe(true);
	});

	it("offers no chart once the judge sees none helping", () => {
		expect(candidateCharts(ARMS, { worth: yes(0.1) })).toEqual([]);
	});

	it("drops the chart when the judge names rows by the only number in the table", () => {
		const threads = request([
			["Thread", "State", "Owner"],
			["32", "open", "ana"],
			["1", "closed", "bo"],
			["40", "open", "cy"],
			["33", "merged", "di"],
		]);
		expect(candidateCharts(threads, { label: choice("Thread", 0.9) })).toEqual([]);
	});

	it("sets metric rows on no shared axis, and rows on one scale in no panel each", () => {
		const metrics = drawn(BUILDS, { metrics: yes(0.95), k1: yes(0.9) });
		expect(metrics.some(chart => chart.kind === "multiples" && chart.transposed)).toBe(true);
		expect(metrics.some(chart => chart.kind === "change")).toBe(true);
		expect(metrics.some(chart => chart.kind === "grouped")).toBe(false);
		const items = drawn(BUILDS, { metrics: yes(0.1), k1: yes(0.9) });
		expect(items.some(chart => chart.kind === "multiples" && chart.transposed)).toBe(false);
		expect(items.some(chart => chart.kind === "grouped")).toBe(true);
	});

	it("pairs two same-unit columns only as one quantity under two conditions", () => {
		const shells = request([
			["workload", "omp", "ksh93"],
			["string append", "70 ms", "335 ms"],
			["substitution", "4.4 ms", "19 ms"],
			["arrays", "153 ms", "2.8 s"],
			["pipes", "7 ms", "1.15 s"],
		]);
		expect(drawn(shells, { k1: yes(0.9) }).some(chart => chart.kind === "paired")).toBe(true);
		expect(drawn(shells, { k1: yes(0.2) }).some(chart => chart.kind === "paired")).toBe(false);
	});

	it("takes a measure's polarity from the judge only when it is sure, else from the unit", () => {
		const latency = ARMS.table.columns.findIndex(column => column.header === "latency");
		const [unsure] = candidateCharts(ARMS, { [`p${latency}`]: choice("higher", 0.6) });
		expect(unsure?.plan.polarity?.[latency]).toBe("lower");
		const [sure] = candidateCharts(ARMS, { [`p${latency}`]: choice("higher", 0.9) });
		expect(sure?.plan.polarity?.[latency]).toBe("higher");
	});
});

describe("pickTableChart", () => {
	it("asks an on-device judge only which chart, over the charts of the local reading", async () => {
		const asked: Questions[] = [];
		const local: Judge = {
			label: "local",
			judge: async <Q extends Questions>(request: JudgmentRequest<Q>) => {
				asked.push(request.questions);
				const answers: Record<string, Answer> = { chart: choice("B", 0.9, { A: 0.05 }) };
				return { api: "local", provider: "local", model: "tiny", answers, usage: tokenUsage(0, 0) } as never;
			},
		};
		const judge = {
			withCandidate: <T>(run: (candidate: Judge, kind: JudgeKind) => Promise<T>) => run(local, "local"),
		} as unknown as ChainJudge;
		const plan = await pickTableChart(LANES, judge);
		expect(asked.map(questions => Object.keys(questions))).toEqual([["chart"]]);
		expect(plan?.series).toEqual(candidateCharts(LANES, {})[1]!.plan.series);
	});
});

describe("chosenChart", () => {
	const charts = candidateCharts(LANES, { ...LANE_RESULTS, k1: yes(0.9) });

	it("keeps the first candidate unless another clearly leads it", () => {
		expect(chosenChart(charts, { chart: choice("B", 0.41, { A: 0.4 }) })?.series).toEqual(charts[0]!.plan.series);
		expect(chosenChart(charts, { chart: choice("B", 0.6, { A: 0.3 }) })?.series).toEqual(charts[1]!.plan.series);
	});

	it("draws no chart on none, unless the first round was sure one helps", () => {
		const none = { chart: choice("none", 0.6, { A: 0.3 }) };
		expect(chosenChart(charts, none)).toBeNull();
		expect(chosenChart(charts, none, { worth: yes(0.5) })).toBeNull();
		expect(chosenChart(charts, none, { worth: yes(0.8) })?.series).toEqual(charts[0]!.plan.series);
	});
});
