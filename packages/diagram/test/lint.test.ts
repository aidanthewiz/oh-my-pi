import { describe, expect, it } from "bun:test";
import type { PositionedFigure } from "../src/figure";
import { lintFigure } from "../src/lint";
import { SKINS, type Skin } from "../src/skin";

const skin = SKINS["soma-navy"];

function makeFigure(nodeCount = 3): PositionedFigure {
	const nodes = Array.from({ length: nodeCount }, (_, index) => ({
		id: `node-${index}`,
		label: `Node ${index}`,
		shape: "rectangle" as const,
		x: index * 200,
		y: 0,
		width: 160,
		height: 64,
	}));
	return {
		title: "Test figure",
		description: "Test figure description",
		skinId: skin.id,
		width: Math.max(nodeCount * 200, 160),
		height: 64,
		nodes,
		edges: [],
		zones: [],
		legend: [],
		nodeOverlays: Object.fromEntries(
			nodes.map(node => [node.id, { kind: "default", focal: false, label: node.label }]),
		),
		edgeOverlays: {},
	};
}

function findingsFor(figure: PositionedFigure, rule: string, customSkin: Skin = skin) {
	return lintFigure(figure, customSkin).filter(finding => finding.rule === rule);
}

describe("lintFigure", () => {
	it("returns no findings for a clean three-node figure", () => {
		expect(lintFigure(makeFigure(), skin)).toEqual([]);
	});

	it("reports three focal nodes and does not report the rule for a clean figure", () => {
		const figure = makeFigure();
		for (const node of figure.nodes) figure.nodeOverlays[node.id].focal = true;
		const findings = findingsFor(figure, "accent-budget");
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ rule: "accent-budget", severity: "error" });
		expect(findings[0].message).toContain("3");
		expect(findingsFor(makeFigure(), "accent-budget")).toEqual([]);
	});

	it("warns at ten nodes and errors above fourteen, but stays quiet for a clean figure", () => {
		expect(findingsFor(makeFigure(10), "node-budget")[0]).toMatchObject({ severity: "warning" });
		expect(findingsFor(makeFigure(15), "node-budget")[0]).toMatchObject({ severity: "error" });
		expect(findingsFor(makeFigure(), "node-budget")).toEqual([]);
	});

	it("reports diagonal connector segments and not orthogonal segments", () => {
		const figure = makeFigure();
		figure.edges.push({
			source: "node-0",
			target: "node-1",
			style: "solid",
			hasArrowStart: false,
			hasArrowEnd: true,
			points: [
				{ x: 160, y: 32 },
				{ x: 200, y: 64 },
			],
		});
		const findings = findingsFor(figure, "orthogonal-connectors");
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ rule: "orthogonal-connectors", severity: "error" });
		expect(findings[0].message).toContain("node-0->node-1");
		const clean = makeFigure();
		clean.edges.push({
			source: "node-0",
			target: "node-1",
			style: "solid",
			hasArrowStart: false,
			hasArrowEnd: true,
			points: [
				{ x: 160, y: 32 },
				{ x: 200, y: 32 },
			],
		});
		expect(findingsFor(clean, "orthogonal-connectors")).toEqual([]);
	});

	it("reports grid misalignment and not aligned geometry", () => {
		const figure = makeFigure();
		figure.nodes[0].x = 2;
		expect(findingsFor(figure, "grid-alignment")).toHaveLength(1);
		expect(findingsFor(figure, "grid-alignment")[0].severity).toBe("warning");
		expect(findingsFor(makeFigure(), "grid-alignment")).toEqual([]);
	});

	it("reports nodes straddling zone bounds and not contained nodes", () => {
		const figure = makeFigure();
		figure.zones.push({ id: "zone-1", label: "Zone", x: 0, y: 0, width: 128, height: 64, depth: 0 });
		expect(findingsFor(figure, "zone-containment")).toHaveLength(1);
		expect(findingsFor(figure, "zone-containment")[0].severity).toBe("error");
		expect(findingsFor(makeFigure(), "zone-containment")).toEqual([]);
	});

	it("reports long edge overlay labels and not short labels", () => {
		const figure = makeFigure();
		figure.edgeOverlays["edge-1"] = { role: "default", style: "solid", label: "long connector label" };
		expect(findingsFor(figure, "label-length")).toHaveLength(1);
		expect(findingsFor(figure, "label-length")[0].severity).toBe("warning");
		const clean = makeFigure();
		clean.edgeOverlays["edge-1"] = { role: "default", style: "solid", label: "short" };
		expect(findingsFor(clean, "label-length")).toEqual([]);
	});

	it("reports empty figures and not populated figures", () => {
		expect(findingsFor(makeFigure(0), "empty-figure")[0]).toMatchObject({ rule: "empty-figure", severity: "error" });
		expect(findingsFor(makeFigure(), "empty-figure")).toEqual([]);
	});

	it("reports intersecting node boxes and not separated boxes", () => {
		const figure = makeFigure();
		figure.nodes[1].x = 128;
		expect(findingsFor(figure, "overlapping-nodes")).toHaveLength(1);
		expect(findingsFor(figure, "overlapping-nodes")[0].severity).toBe("error");
		expect(findingsFor(makeFigure(), "overlapping-nodes")).toEqual([]);
	});

	it("reports invalid skin colors and not valid palette values", () => {
		const invalidSkin: Skin = { ...skin, colors: { ...skin.colors, accent: "not-a-color" } };
		const findings = findingsFor(makeFigure(), "palette-closure", invalidSkin);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ rule: "palette-closure", severity: "error" });
		expect(findings[0].message).toContain("accent");
		expect(findingsFor(makeFigure(), "palette-closure")).toEqual([]);
	});

	it("orders findings with errors first and rules alphabetically", () => {
		const figure = makeFigure(0);
		const invalidSkin: Skin = { ...skin, colors: { ...skin.colors, accent: "invalid" } };
		const first = lintFigure(figure, invalidSkin);
		const second = lintFigure(figure, invalidSkin);
		expect(first).toEqual(second);
		expect(first.map(finding => finding.rule)).toEqual(["empty-figure", "palette-closure"]);
	});
});
