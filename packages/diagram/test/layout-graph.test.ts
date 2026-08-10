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
