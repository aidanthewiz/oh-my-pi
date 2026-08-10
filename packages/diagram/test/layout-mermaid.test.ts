import { describe, expect, test } from "bun:test";
import { edgeKey } from "../src/figure";
import { layoutMermaidFigure } from "../src/layout/mermaid";

describe("Mermaid diagram layout", () => {
	test("brands flowcharts with nodes, edges, overlays, and zones", () => {
		const figure = layoutMermaidFigure(
			`flowchart TD
  subgraph Services
    A[Alpha] --> B[Beta]
    B -.-> C[Gamma]
  end`,
			{ title: "Service flow" },
		);

		expect(figure.nodes).toHaveLength(3);
		expect(figure.edges).toHaveLength(2);
		expect(figure.zones).toHaveLength(1);
		expect(figure.zones[0]?.label).toBe("Services");
		expect(Object.keys(figure.nodeOverlays)).toHaveLength(3);
		expect(Object.keys(figure.edgeOverlays)).toHaveLength(2);
		for (const overlay of Object.values(figure.nodeOverlays)) {
			expect(overlay.focal).toBe(false);
		}
		expect(figure.edgeOverlays[edgeKey("B", "C", 0)]?.style).toBe("dashed");
	});

	test("keeps parallel Mermaid edges distinct", () => {
		const figure = layoutMermaidFigure(
			`flowchart LR
  A[Alpha] --> B[Beta]
  A --> B`,
			{ title: "Parallel flow" },
		);

		expect(figure.edgeOverlays[edgeKey("A", "B", 0)]).toBeDefined();
		expect(figure.edgeOverlays[edgeKey("A", "B", 1)]).toBeDefined();
		expect(edgeKey("A", "B", 0)).not.toBe(edgeKey("A", "B", 1));
	});

	test("generates accessible prose and preserves supplied description", () => {
		const generated = layoutMermaidFigure("flowchart TD\n A[Alpha]", { title: "Generated" });
		expect(generated.description).toContain("1 node");
		expect(generated.description.length).toBeGreaterThan(0);

		const supplied = layoutMermaidFigure("flowchart TD\n A[Alpha]", {
			title: "Supplied",
			description: "A supplied accessible description.",
		});
		expect(supplied.description).toBe("A supplied accessible description.");
	});

	test("throws for unsupported Mermaid families", () => {
		expect(() => layoutMermaidFigure('pie title X\n  "A" : 1', { title: "Unsupported" })).toThrow();
	});
});
