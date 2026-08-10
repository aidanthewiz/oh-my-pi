import { describe, expect, it } from "bun:test";
import { parseMermaid } from "../src/vendor/mermaid-ascii/parser";

describe("Mermaid edge parsing", () => {
	it.each([
		["flowchart LR\nA[One] --> B[Two]", 2, 1],
		["flowchart LR\nA[One]-->B[Two]", 2, 1],
		["flowchart LR\nA --> B", 2, 1],
		["flowchart LR\nA-->B", 2, 1],
	])("parses %s", (source, nodeCount, edgeCount) => {
		const graph = parseMermaid(source);

		expect(graph.nodes).toHaveLength(nodeCount);
		expect(graph.edges).toHaveLength(edgeCount);
	});

	it.each(["flowchart LR\nmy-node-->other", "flowchart LR\nmy-node --> other"])(
		"preserves hyphenated IDs in an unspaced edge: %s",
		source => {
			const graph = parseMermaid(source);
			expect([...graph.nodes.keys()]).toEqual(["my-node", "other"]);
			expect(graph.edges).toHaveLength(1);
			expect(graph.edges[0]).toMatchObject({ source: "my-node", target: "other" });
		},
	);

	it.each([
		["A-->|go|B", "solid", "go"],
		["A-.->B", "dotted", undefined],
		["A==>B", "thick", undefined],
	])("parses unspaced %s edges", (edge, style, label) => {
		const graph = parseMermaid(`flowchart LR\n${edge}`);

		expect(graph.nodes).toHaveLength(2);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0]).toMatchObject({ source: "A", target: "B", style, label });
	});

	it("parses state diagram transitions without spaces", () => {
		const graph = parseMermaid("stateDiagram-v2\ns1-->s2");
		expect([...graph.nodes.keys()]).toEqual(["s1", "s2"]);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0]).toMatchObject({ source: "s1", target: "s2" });
	});

	it.each(["A<-->B", "A<-.->B", "A<==>B"])("keeps start-arrow forms working: %s", edge => {
		const graph = parseMermaid(`flowchart LR\n${edge}`);

		expect(graph.nodes).toHaveLength(2);
		expect(graph.edges).toHaveLength(1);
	});
});
