import { describe, expect, it } from "bun:test";
import { layoutPositionedGraph } from "../src/mermaid-ascii";

describe("layoutPositionedGraph", () => {
	it("projects nodes and routed edges onto a 4px grid", () => {
		const graph = layoutPositionedGraph("graph LR\n  A[Alpha] --> B[Beta]");

		expect(graph.nodes).toHaveLength(2);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0]?.points.length).toBeGreaterThanOrEqual(2);
		expect(graph.width).toBeGreaterThan(0);
		expect(graph.height).toBeGreaterThan(0);
		for (const node of graph.nodes) {
			expect(node.x % 4).toBe(0);
			expect(node.y % 4).toBe(0);
			expect(node.width % 4).toBe(0);
			expect(node.height % 4).toBe(0);
		}
	});

	it("projects subgraph bounds around member nodes", () => {
		const graph = layoutPositionedGraph(`graph TD
  subgraph Group
    A[Alpha] --> B[Beta]
  end`);
		const group = graph.groups[0];

		expect(group).toBeDefined();
		expect(group?.children).toEqual([]);
		for (const node of graph.nodes) {
			expect(node.x).toBeGreaterThanOrEqual(group!.x);
			expect(node.y).toBeGreaterThanOrEqual(group!.y);
			expect(node.x + node.width).toBeLessThanOrEqual(group!.x + group!.width);
			expect(node.y + node.height).toBeLessThanOrEqual(group!.y + group!.height);
		}
	});
});
