import { describe, expect, test } from "bun:test";
import { renderDiagram } from "../src";
import { layoutLayers } from "../src/layout/band";
import { LEGEND_BAND_HEIGHT } from "../src/layout/graph";
import { type DiagramSpec, parseSpec } from "../src/spec";

const baseSpec: DiagramSpec = parseSpec({
	type: "layers",
	title: "Platform layers",
	eyebrow: "ABSTRACTION",
	standfirst: "From the foundation to the user experience.",
	nodes: [
		{ id: "foundation", label: "Foundation", sublabel: "runtime", badge: "CORE" },
		{ id: "services", label: "Services", kind: "store" },
		{ id: "applications", label: "Applications", focal: true },
		{ id: "experience", label: "Experience", kind: "external" },
	],
	edges: [{ from: "foundation", to: "services", label: "CONTAINS" }],
});

describe("diagram layer layout", () => {
	test("stacks full-width nodes in spec order and ignores edges", () => {
		const figure = layoutLayers(baseSpec);

		expect(figure.nodes).toHaveLength(4);
		expect(figure.edges).toHaveLength(0);
		expect(figure.zones).toHaveLength(0);
		expect(Object.keys(figure.nodeOverlays)).toHaveLength(4);
		expect(figure.edgeOverlays).toEqual({});
		expect(figure.nodes.map(node => node.id)).toEqual(baseSpec.nodes.map(node => node.id));
		expect(figure.nodes.every(node => node.x === 16 && node.width === 608)).toBe(true);
		expect(figure.nodes.every(node => node.height === 64)).toBe(true);
		expect(
			figure.nodes.every(
				(node, index) => index === 0 || node.y > figure.nodes[index - 1].y + figure.nodes[index - 1].height,
			),
		).toBe(true);
		expect(
			figure.nodes.every(node => [node.x, node.y, node.width, node.height].every(value => value % 4 === 0)),
		).toBe(true);
		expect(figure.nodeOverlays.applications?.focal).toBe(true);
		expect(figure.description).toContain("Foundation, Services, Applications, Experience");
	});

	test("reserves the same legend band as graph layouts", () => {
		const withoutLegend = layoutLayers(baseSpec);
		const withLegend = layoutLayers({
			...baseSpec,
			legend: [{ label: "Contains", role: "default", style: "solid" }],
		});

		expect(withLegend.height - withoutLegend.height).toBe(LEGEND_BAND_HEIGHT);
	});

	test("renders every layer label without error findings", () => {
		const rendered = renderDiagram(baseSpec);

		for (const node of baseSpec.nodes) expect(rendered.html).toContain(node.label);
		expect(rendered.findings.filter(finding => finding.severity === "error")).toHaveLength(0);
	});
});
