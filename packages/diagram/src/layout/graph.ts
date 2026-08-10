import type { PositionedGraph, PositionedNode } from "@oh-my-pi/pi-utils";
import { layoutPositionedGraph } from "@oh-my-pi/pi-utils";
import { type EdgeOverlay, edgeKey, type FigureZone, type NodeOverlay, type PositionedFigure } from "../figure";
import { resolveSkin } from "../skin";
import type { DiagramNode, DiagramSpec, DiagramZone } from "../spec";

/** Reserved vertical band for a non-empty figure legend, in SVG user units. */
export const LEGEND_BAND_HEIGHT = 52;

function displayWidth(text: string): number {
	let widest = 0;
	for (const line of text.split(/\r?\n/)) {
		widest = Math.max(widest, Bun.stringWidth(line));
	}
	return widest;
}

/**
 * Characters that open, close, or retarget a Mermaid token. Specs accept
 * arbitrary text, so these are replaced before serialization: no accepted spec
 * may change the structure of the emitted graph. `<br/>` is inserted after
 * sanitization, so multi-line labels still break correctly.
 */
const MERMAID_SIGNIFICANT = /["'`|<>[\]{}()\\]/g;

function mermaidSafeLines(text: string): string[] {
	return text.split(/\r?\n/).map(line => line.replace(MERMAID_SIGNIFICANT, " "));
}

/**
 * Mermaid identifiers derived from spec order. Spec ids may contain characters
 * Mermaid reads as syntax, so they are never serialized; layout output is mapped
 * back through these before any caller sees it.
 */
function safeIds(spec: DiagramSpec): { nodes: Map<string, string>; zones: Map<string, string> } {
	const nodes = new Map<string, string>();
	for (const [index, node] of spec.nodes.entries()) nodes.set(node.id, `n${index}`);
	const zones = new Map<string, string>();
	for (const [index, zone] of (spec.zones ?? []).entries()) zones.set(zone.id, `z${index}`);
	return { nodes, zones };
}

/**
 * Mermaid receives one label; padding reserves room for the widest label,
 * sublabel, or badge the SVG backend draws into the same box.
 */
function paddedNodeLabel(node: DiagramNode): string {
	const lines = mermaidSafeLines(node.label);
	const width = Math.max(
		displayWidth(lines.join("\n")),
		displayWidth(node.sublabel ?? ""),
		displayWidth(node.badge ?? ""),
	);
	return lines.map(line => `${line}${" ".repeat(Math.max(0, width - Bun.stringWidth(line)))}`).join("<br/>");
}

function nodeLine(node: DiagramNode, nodeIds: Map<string, string>): string {
	return `${nodeIds.get(node.id)}["${paddedNodeLabel(node)}"]`;
}

function appendZoneLines(
	lines: string[],
	zone: DiagramZone,
	zones: DiagramZone[],
	nodes: DiagramNode[],
	ids: { nodes: Map<string, string>; zones: Map<string, string> },
): void {
	lines.push(`subgraph ${ids.zones.get(zone.id)} ["${mermaidSafeLines(zone.label).join(" ")}"]`);
	for (const node of nodes) {
		if (node.zone === zone.id) lines.push(nodeLine(node, ids.nodes));
	}
	for (const child of zones) {
		if (child.parent === zone.id) appendZoneLines(lines, child, zones, nodes, ids);
	}
	lines.push("end");
}

function appendStateZoneLines(
	lines: string[],
	zone: DiagramZone,
	zones: DiagramZone[],
	nodes: DiagramNode[],
	ids: { nodes: Map<string, string>; zones: Map<string, string> },
): void {
	lines.push(`state ${ids.zones.get(zone.id)!} {`);
	for (const node of nodes) {
		if (node.zone === zone.id) lines.push(`state "${paddedNodeLabel(node)}" as ${ids.nodes.get(node.id)!}`);
	}
	for (const child of zones) {
		if (child.parent === zone.id) appendStateZoneLines(lines, child, zones, nodes, ids);
	}
	lines.push("}");
}

/** Convert a typed diagram specification to the Mermaid source used by layout and ASCII rendering.
 *
 * The `style` field is not expressible for state figures, so it affects only SVG rendering, not the ASCII preview.
 */
export function specToMermaid(spec: DiagramSpec): string {
	const ids = safeIds(spec);
	if (spec.type === "state") {
		const lines = ["stateDiagram-v2"];
		if (spec.direction !== undefined) lines.push(`direction ${spec.direction}`);
		for (const node of spec.nodes) {
			if (node.zone === undefined) lines.push(`state "${paddedNodeLabel(node)}" as ${ids.nodes.get(node.id)!}`);
		}
		const zones = spec.zones ?? [];
		for (const zone of zones.filter(candidate => candidate.parent === undefined)) {
			appendStateZoneLines(lines, zone, zones, spec.nodes, ids);
		}
		for (const edge of spec.edges ?? []) {
			const label = edge.label === undefined ? "" : ` : ${mermaidSafeLines(edge.label).join(" ")}`;
			lines.push(`${ids.nodes.get(edge.from)!} --> ${ids.nodes.get(edge.to)!}${label}`);
		}
		return lines.join("\n");
	}
	const lines = [`flowchart ${spec.direction ?? "TD"}`];
	const zones = spec.zones ?? [];
	for (const zone of zones.filter(candidate => candidate.parent === undefined)) {
		appendZoneLines(lines, zone, zones, spec.nodes, ids);
	}
	for (const node of spec.nodes) {
		if (node.zone === undefined) lines.push(nodeLine(node, ids.nodes));
	}
	for (const edge of spec.edges ?? []) {
		const operator = edge.style === "dashed" ? "-.->" : edge.style === "thick" ? "==>" : "-->";
		const label = edge.label === undefined ? "" : `|${mermaidSafeLines(edge.label).join(" ")}|`;
		lines.push(`${ids.nodes.get(edge.from)} ${operator}${label} ${ids.nodes.get(edge.to)}`);
	}
	return lines.join("\n");
}

function appendFigureZone(
	zones: FigureZone[],
	group: PositionedGraph["groups"][number],
	zoneById: Map<string, DiagramZone>,
	specZoneId: Map<string, string>,
	depth: number,
): void {
	const id = specZoneId.get(group.id) ?? group.id;
	const specZone = zoneById.get(id);
	zones.push({
		id,
		label: specZone?.label ?? group.label,
		x: group.x,
		y: group.y,
		width: group.width,
		height: group.height,
		depth,
	});
	for (const child of group.children) appendFigureZone(zones, child, zoneById, specZoneId, depth + 1);
}

function makeNodeOverlays(spec: DiagramSpec): Record<string, NodeOverlay> {
	const overlays: Record<string, NodeOverlay> = {};
	for (const node of spec.nodes) {
		overlays[node.id] = {
			kind: node.kind ?? "default",
			focal: node.focal ?? false,
			label: node.label,
			sublabel: node.sublabel,
			badge: node.badge,
			zone: node.zone,
		};
	}
	return overlays;
}

function makeEdgeOverlays(spec: DiagramSpec): Record<string, EdgeOverlay> {
	const overlays: Record<string, EdgeOverlay> = {};
	const ordinals = new Map<string, number>();
	for (const edge of spec.edges ?? []) {
		const pair = `${edge.from}\u0000${edge.to}`;
		const ordinal = ordinals.get(pair) ?? 0;
		ordinals.set(pair, ordinal + 1);
		const overlay: EdgeOverlay = {
			role: edge.role ?? "default",
			style: edge.style ?? "solid",
		};
		if (edge.label !== undefined) overlay.label = edge.label;
		overlays[edgeKey(edge.from, edge.to, ordinal)] = overlay;
	}
	return overlays;
}

function generatedDescription(spec: DiagramSpec): string {
	const zones = spec.zones ?? [];
	const zoneText =
		zones.length === 0
			? "no zones"
			: `${zones.length} zone${zones.length === 1 ? "" : "s"}: ${zones.map(zone => zone.label).join(", ")}`;
	const focal = spec.nodes.find(node => node.focal === true);
	return `This diagram contains ${spec.nodes.length} node${spec.nodes.length === 1 ? "" : "s"}${focal ? `, with ${focal.label} as the focal node` : ""}, and ${zoneText}.`;
}

/** Lay out a typed diagram through the shared Mermaid positioned-graph engine. */
export function layoutGraph(spec: DiagramSpec): PositionedFigure {
	const ids = safeIds(spec);
	// Layout speaks synthetic Mermaid ids; overlays and every caller key on spec
	// ids, so results are translated back before leaving this function.
	const specNodeId = new Map([...ids.nodes].map(([specId, safeId]) => [safeId, specId]));
	const specZoneId = new Map([...ids.zones].map(([specId, safeId]) => [safeId, specId]));
	const graph = layoutPositionedGraph(specToMermaid(spec));
	const nodeById: Map<string, DiagramNode> = new Map(spec.nodes.map(node => [node.id, node]));
	const nodes: PositionedNode[] = graph.nodes.map(node => {
		const id = specNodeId.get(node.id) ?? node.id;
		return { ...node, id, label: nodeById.get(id)?.label ?? node.label };
	});
	const edges = graph.edges.map(edge => ({
		...edge,
		source: specNodeId.get(edge.source) ?? edge.source,
		target: specNodeId.get(edge.target) ?? edge.target,
	}));
	const zoneById: Map<string, DiagramZone> = new Map((spec.zones ?? []).map(zone => [zone.id, zone]));
	const zones: FigureZone[] = [];
	for (const group of graph.groups) appendFigureZone(zones, group, zoneById, specZoneId, 0);
	const legend = spec.legend ?? [];
	return {
		title: spec.title,
		eyebrow: spec.eyebrow,
		standfirst: spec.standfirst,
		description: spec.description ?? generatedDescription(spec),
		skinId: resolveSkin(spec.skin).id,
		width: graph.width,
		height: graph.height + (legend.length > 0 ? LEGEND_BAND_HEIGHT : 0),
		nodes,
		edges,
		zones,
		legend,
		nodeOverlays: makeNodeOverlays(spec),
		edgeOverlays: makeEdgeOverlays(spec),
	};
}
