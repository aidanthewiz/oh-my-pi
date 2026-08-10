import { describe, expect, test } from "bun:test";
import { edgeKey, type PositionedFigure } from "../src/figure";
import { renderSvgDocument } from "../src/render/svg";
import { resolveSkin } from "../src/skin";

function fixture(legend = true): PositionedFigure {
	return {
		title: 'Ingress & "Egress"',
		eyebrow: "SYSTEM MAP",
		standfirst: "Offline architecture",
		description: "A graph showing < and & safely.",
		skinId: "soma-navy",
		width: 480,
		height: 260,
		nodes: [
			{ id: "a", label: "Input", shape: "rectangle", x: 32, y: 80, width: 160, height: 64 },
			{ id: "b", label: "Store", shape: "rectangle", x: 288, y: 80, width: 160, height: 64 },
		],
		edges: [
			{
				source: "a",
				target: "b",
				label: "writes",
				style: "solid",
				hasArrowStart: false,
				hasArrowEnd: true,
				points: [
					{ x: 192, y: 112 },
					{ x: 240, y: 112 },
					{ x: 240, y: 160 },
					{ x: 288, y: 160 },
				],
			},
		],
		zones: [{ id: "zone", label: "trust & zone", x: 16, y: 48, width: 448, height: 176, depth: 0 }],
		legend: legend ? [{ label: "Primary", role: "primary", style: "solid" }] : [],
		nodeOverlays: {
			a: { kind: "input", focal: true, label: 'A & < "' },
			b: { kind: "store", focal: false, label: "Store" },
		},
		edgeOverlays: {
			[edgeKey("a", "b", 0)]: { role: "primary", style: "solid", label: "writes" },
		},
	};
}

describe("renderSvgDocument", () => {
	test("renders a complete offline SVG document", () => {
		const html = renderSvgDocument(fixture(), resolveSkin("soma-navy"));
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect((html.match(/<svg\b/g) ?? []).length).toBe(1);
		expect((html.match(/<title\b/g) ?? []).length).toBe(2);
		expect((html.match(/<title\b[^>]*>/g) ?? []).filter(tag => tag.includes('id="fig-title"')).length).toBe(1);
		expect((html.match(/<desc\b/g) ?? []).length).toBe(1);
		expect(html).toContain('aria-labelledby="fig-title fig-desc"');
		expect(html).not.toMatch(/<script|<link|@import|rx=|shadow/i);
		expect((html.match(/http/g) ?? []).length).toBe(1);
		expect(html).not.toMatch(/url\((?!#)/);
		expect(html).toContain(resolveSkin("soma-navy").colors.accent);
		expect(html).toContain("TRUST &amp; ZONE");
	});

	test("uses only the selected skin palette", () => {
		const light = resolveSkin("soma-light");
		const dark = resolveSkin("soma-navy");
		const html = renderSvgDocument(fixture(false), light);
		expect(html).toContain(light.colors.accent);
		expect(html).toContain(light.colors.paper);
		for (const color of new Set(Object.values(dark.colors))) {
			if (!Object.values(light.colors).includes(color)) expect(html).not.toContain(color);
		}
	});
});
