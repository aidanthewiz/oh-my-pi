import { layoutPositionedGraph, type PositionedEdge, type PositionedGraph } from "@oh-my-pi/pi-utils";
import { type EdgeOverlay, edgeKey, type FigureZone, type NodeOverlay, type PositionedFigure } from "../figure";
import { resolveSkin } from "../skin";
import type { EdgeStyle } from "../spec";

/** Metadata used to brand a raw Mermaid graph as a diagram figure. */
export interface MermaidFigureMeta {
	title: string;
	eyebrow?: string;
	standfirst?: string;
	description?: string;
	skin?: string;
	direction?: "TD" | "LR";
}

function overlayStyle(style: PositionedEdge["style"]): EdgeStyle {
	// The vendored Mermaid vocabulary is solid|dotted|thick; diagram overlays use solid|dashed|thick.
	switch (style) {
		case "dotted":
			return "dashed";
		case "thick":
			return "thick";
		case "solid":
			return "solid";
		default:
			return "solid";
	}
}

function appendZone(zones: FigureZone[], group: PositionedGraph["groups"][number], depth: number): void {
	zones.push({
		id: group.id,
		label: group.label,
		x: group.x,
		y: group.y,
		width: group.width,
		height: group.height,
		depth,
	});
	for (const child of group.children) appendZone(zones, child, depth + 1);
}

function generatedDescription(nodeCount: number, zones: FigureZone[]): string {
	const nodeWord = nodeCount === 1 ? "node" : "nodes";
	const zoneText =
		zones.length === 0
			? "no zones"
			: `${zones.length} zone${zones.length === 1 ? "" : "s"} labeled ${zones.map(zone => zone.label).join(", ")}`;
	return `This diagram contains ${nodeCount} ${nodeWord} and ${zoneText}.`;
}

/**
 * Lay out raw Mermaid flowchart or state source as a branded positioned figure.
 * The vendored parser accepts flowchart and state sources. Other Mermaid families
 * throw, and this error is surfaced to the caller instead of producing an empty figure.
 */
export function layoutMermaidFigure(source: string, meta: MermaidFigureMeta): PositionedFigure {
	const graph = layoutPositionedGraph(source, meta.direction ? { direction: meta.direction } : {});
	const nodeOverlays: Record<string, NodeOverlay> = {};
	// Mermaid cannot express node kind, focal, badge, or sublabel, so every node uses the default treatment.
	for (const node of graph.nodes) {
		nodeOverlays[node.id] = {
			kind: "default",
			focal: false,
			label: node.label,
		};
	}

	const edgeOverlays: Record<string, EdgeOverlay> = {};
	const ordinals = new Map<string, number>();
	for (const edge of graph.edges) {
		const pair = `${edge.source}\u0000${edge.target}`;
		const ordinal = ordinals.get(pair) ?? 0;
		ordinals.set(pair, ordinal + 1);
		const overlay: EdgeOverlay = {
			role: "default",
			style: overlayStyle(edge.style),
		};
		if (edge.label !== undefined) overlay.label = edge.label;
		edgeOverlays[edgeKey(edge.source, edge.target, ordinal)] = overlay;
	}

	const zones: FigureZone[] = [];
	for (const group of graph.groups) appendZone(zones, group, 0);

	return {
		title: meta.title,
		eyebrow: meta.eyebrow,
		standfirst: meta.standfirst,
		description: meta.description ?? generatedDescription(graph.nodes.length, zones),
		skinId: resolveSkin(meta.skin).id,
		width: graph.width,
		height: graph.height,
		nodes: graph.nodes,
		edges: graph.edges,
		zones,
		legend: [],
		nodeOverlays,
		edgeOverlays,
	};
}
