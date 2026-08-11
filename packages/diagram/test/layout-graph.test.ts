import { describe, expect, test } from "bun:test";
import { layoutPositionedGraph } from "@oh-my-pi/pi-utils";
import { edgeKey } from "../src/figure";
import { LEGEND_BAND_HEIGHT, layoutGraph, specToMermaid } from "../src/layout/graph";
import { type DiagramSpec, parseSpec } from "../src/spec";

const baseSpec: DiagramSpec = parseSpec({
	type: "architecture",
	title: "Request path",
	nodes: [
		{ id: "client", label: "Client", focal: true },
		{ id: "api", label: "API", sublabel: "HTTPS", zone: "edge" },
		{ id: "store", label: "Store", kind: "store", zone: "edge" },
	],
	edges: [
		{ from: "client", to: "api", role: "primary", label: "REQUEST" },
		{ from: "api", to: "store", style: "dashed", label: "READ" },
	],
	zones: [{ id: "edge", label: "Edge services" }],
});

describe("diagram graph layout", () => {
	test("converts specs through the shared Mermaid layout path", () => {
		const source = specToMermaid(baseSpec);
		expect(source).toContain("flowchart TD");
		expect(() => layoutPositionedGraph(source)).not.toThrow();

		const figure = layoutGraph(baseSpec);
		expect(figure.nodes).toHaveLength(3);
		expect(figure.edges).toHaveLength(2);
		expect(figure.zones).toHaveLength(1);
		expect(Object.keys(figure.nodeOverlays)).toHaveLength(3);
		expect(Object.keys(figure.edgeOverlays)).toHaveLength(2);
	});

	test("keeps parallel edge overlays distinct", () => {
		const spec = parseSpec({
			...baseSpec,
			edges: [
				{ from: "client", to: "api", label: "A" },
				{ from: "client", to: "api", label: "B" },
			],
		});
		const figure = layoutGraph(spec);
		expect(figure.edgeOverlays[edgeKey("client", "api", 0)]?.label).toBe("A");
		expect(figure.edgeOverlays[edgeKey("client", "api", 1)]?.label).toBe("B");
	});

	test("generates accessible prose and reserves the legend band", () => {
		const withoutLegend = layoutGraph(baseSpec);
		const withLegend = layoutGraph({
			...baseSpec,
			legend: [{ label: "Primary", role: "primary" }],
		});
		expect(withoutLegend.description.length).toBeGreaterThan(0);
		expect(withLegend.height - withoutLegend.height).toBe(LEGEND_BAND_HEIGHT);
	});

	test("survives Mermaid metacharacters in ids and labels without losing structure", () => {
		// Ids and label text are caller-supplied. Serializing them verbatim let a
		// `|`, `]`, or `"` close a token early and silently drop or retarget nodes
		// and edges, so ids are synthesized and label text is sanitized.
		const spec = parseSpec({
			type: "architecture",
			title: "Hostile input",
			nodes: [
				{ id: "svc:a b", label: 'Alpha ["x"]', sublabel: "a|b" },
				{ id: "svc-->b", label: "Beta {y}", badge: "(z)" },
				{ id: "plain", label: "Gamma", zone: "zone|1" },
			],
			edges: [
				{ from: "svc:a b", to: "svc-->b", label: "A|B]C" },
				{ from: "svc-->b", to: "plain" },
			],
			zones: [{ id: "zone|1", label: 'Zone ["one"]' }],
		});

		const source = specToMermaid(spec);
		// No raw spec id may reach the Mermaid grammar.
		expect(source).not.toContain("svc:a b");
		expect(source).not.toContain("svc-->b");
		expect(source).not.toContain("zone|1");

		const figure = layoutGraph(spec);
		expect(figure.nodes).toHaveLength(3);
		expect(figure.edges).toHaveLength(2);
		expect(figure.zones).toHaveLength(1);

		// Positioned output and overlays are keyed by the original spec ids.
		expect(figure.nodes.map(node => node.id).sort()).toEqual(["plain", "svc-->b", "svc:a b"]);
		expect(figure.zones[0]?.id).toBe("zone|1");
		expect(figure.zones[0]?.label).toBe('Zone ["one"]');
		expect(figure.edgeOverlays[edgeKey("svc:a b", "svc-->b", 0)]?.label).toBe("A|B]C");

		// Real label text is preserved for rendering, not the sanitized form.
		expect(figure.nodeOverlays["svc:a b"]?.label).toBe('Alpha ["x"]');
		expect(figure.nodes.find(node => node.id === "svc:a b")?.label).toBe('Alpha ["x"]');
	});
});

test("emits state diagrams through the shared layout path", () => {
	const spec = parseSpec({
		type: "state",
		title: "Lifecycle",
		direction: "LR",
		nodes: [
			{ id: "idle", label: "Idle", zone: "runtime" },
			{ id: "running", label: "Running", zone: "runtime" },
			{ id: "done", label: "Done" },
		],
		edges: [
			{ from: "idle", to: "running", label: "start" },
			{ from: "running", to: "done", label: "finish" },
		],
		zones: [{ id: "runtime", label: "Runtime" }],
	});

	const source = specToMermaid(spec);
	expect(source.startsWith("stateDiagram-v2")).toBe(true);
	expect(source).toContain("direction LR");
	expect(source).not.toContain("flowchart");
	expect(() => layoutPositionedGraph(source)).not.toThrow();

	const figure = layoutGraph(spec);
	expect(figure.nodes).toHaveLength(3);
	expect(figure.edges).toHaveLength(2);
	expect(figure.zones).toHaveLength(1);
	expect(figure.nodes.map(node => node.label).sort()).toEqual(["Done", "Idle", "Running"]);
	const runtime = figure.zones[0]!;
	const idle = figure.nodes.find(node => node.id === "idle")!;
	expect(runtime.id).toBe("runtime");
	expect(runtime.label).toBe("Runtime");
	expect(runtime.width).toBeGreaterThan(idle.width);
	expect(runtime.height).toBeGreaterThan(idle.height);
	expect(idle.x).toBeGreaterThanOrEqual(runtime.x);
	expect(idle.y).toBeGreaterThanOrEqual(runtime.y);
	expect(idle.x + idle.width).toBeLessThanOrEqual(runtime.x + runtime.width);
	expect(idle.y + idle.height).toBeLessThanOrEqual(runtime.y + runtime.height);
	expect(figure.edges.map(edge => edge.label)).toEqual(["start", "finish"]);
	expect(figure.edgeOverlays[edgeKey("idle", "running", 0)]?.label).toBe("start");
	expect(figure.edgeOverlays[edgeKey("running", "done", 0)]?.label).toBe("finish");
});

test("sanitizes Mermaid metacharacters in state ids", () => {
	const spec = parseSpec({
		type: "state",
		title: "Hostile state input",
		nodes: [
			{ id: "state|one", label: "One", zone: "zone{a}" },
			{ id: "state-->two", label: "Two" },
		],
		edges: [{ from: "state|one", to: "state-->two", label: "advance" }],
		zones: [{ id: "zone{a}", label: "Zone" }],
	});

	const source = specToMermaid(spec);
	expect(source).not.toContain("state|one");
	expect(source).not.toContain("state-->two");
	expect(source).not.toContain("zone{a}");

	const figure = layoutGraph(spec);
	expect(figure.nodes).toHaveLength(2);
	expect(figure.edges).toHaveLength(1);
	expect(figure.zones).toHaveLength(1);
	expect(figure.nodes.map(node => node.id).sort()).toEqual(["state-->two", "state|one"]);
});
