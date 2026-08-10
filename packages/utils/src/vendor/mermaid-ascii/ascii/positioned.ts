// ============================================================================
// ASCII renderer — positioned layout projection seam
//
// Projects the shared grid layout into SVG-friendly geometry without ELK.
// ============================================================================

import { parseMermaid } from "../parser";
import type { PositionedEdge, PositionedGraph, PositionedGroup, PositionedNode, Point } from "../types";
import { convertToAsciiGraph } from "./converter";
import { createMapping, lineToDrawing } from "./grid";
import type { AsciiConfig, AsciiGraph, AsciiSubgraph } from "./types";
import type { AsciiRenderOptions } from "./index";

/** Nominal monospace cell width in SVG user units. */
export const CELL_W = 8;

/** Nominal monospace cell height in SVG user units. */
export const CELL_H = 16;

const GRID_UNIT = 4;
const GRAPH_MARGIN = 16;

function projectNode(node: AsciiGraph["nodes"][number]): PositionedNode {
	const drawingCoord = node.drawingCoord ?? { x: 0, y: 0 };
	const width = node.drawing?.length ?? 1;
	const height = node.drawing?.[0]?.length ?? 1;
	return {
		id: node.name,
		label: node.displayLabel,
		shape: node.shape,
		x: Math.round((drawingCoord.x * CELL_W) / GRID_UNIT) * GRID_UNIT,
		y: Math.round((drawingCoord.y * CELL_H) / GRID_UNIT) * GRID_UNIT,
		width: Math.round((width * CELL_W) / GRID_UNIT) * GRID_UNIT,
		height: Math.round((height * CELL_H) / GRID_UNIT) * GRID_UNIT,
	};
}

function projectEdge(graph: AsciiGraph, edge: AsciiGraph["edges"][number]): PositionedEdge {
	const points = lineToDrawing(graph, edge.path).map(point => ({
		x: Math.round((point.x * CELL_W) / GRID_UNIT) * GRID_UNIT,
		y: Math.round((point.y * CELL_H) / GRID_UNIT) * GRID_UNIT,
	}));
	const labelLine = edge.labelLine.length > 0 ? lineToDrawing(graph, edge.labelLine) : [];
	const labelPosition: Point | undefined = labelLine.length > 0
		? {
			x: Math.round((((labelLine[0]!.x + labelLine[labelLine.length - 1]!.x) / 2) * CELL_W) / GRID_UNIT) * GRID_UNIT,
			y: Math.round((((labelLine[0]!.y + labelLine[labelLine.length - 1]!.y) / 2) * CELL_H) / GRID_UNIT) * GRID_UNIT,
		}
		: undefined;
	return {
		source: edge.from.name,
		target: edge.to.name,
		label: edge.text || undefined,
		style: edge.style,
		hasArrowStart: edge.hasArrowStart,
		hasArrowEnd: edge.hasArrowEnd,
		points,
		...(labelPosition ? { labelPosition } : {}),
	};
}

function projectGroup(sg: AsciiSubgraph): PositionedGroup {
	// Subgraph bounds are already drawing-coordinate cells; nodes and edges use grid indices.
	const minX = Math.round((sg.minX * CELL_W) / GRID_UNIT) * GRID_UNIT;
	const minY = Math.round((sg.minY * CELL_H) / GRID_UNIT) * GRID_UNIT;
	const maxX = Math.round((sg.maxX * CELL_W) / GRID_UNIT) * GRID_UNIT;
	const maxY = Math.round((sg.maxY * CELL_H) / GRID_UNIT) * GRID_UNIT;
	return {
		id: sg.id,
		label: sg.name,
		x: minX,
		y: minY,
		width: Math.max(GRID_UNIT, maxX - minX),
		height: Math.max(GRID_UNIT, maxY - minY),
		children: sg.children.map(projectGroup),
	};
}

/** Perpendicular separation between routes that would otherwise coincide. */
const FAN_STEP = 8;

/**
 * Separate routes that resolved to the same polyline.
 *
 * The router picks one best path per node pair, so parallel relationships all
 * receive identical geometry and render as a single connector carrying several
 * labels — the figure then silently contradicts its source. Each subsequent route
 * on a shared polyline is offset perpendicular to its own run so every
 * relationship stays independently traceable.
 *
 * Endpoints move with the run, which is why the offset is applied to every point
 * rather than to interior bends only: an endpoint left in place would reattach
 * the fanned route to the original edge and undo the separation.
 */
function fanCoincidentEdges(edges: PositionedEdge[]): void {
	const seen = new Map<string, number>();
	for (const edge of edges) {
		const key = edge.points.map(point => `${point.x},${point.y}`).join(" ");
		const rank = seen.get(key) ?? 0;
		seen.set(key, rank + 1);
		if (rank === 0 || edge.points.length < 2) continue;

		// Alternate sides so a fan grows symmetrically about the original route.
		const magnitude = Math.ceil(rank / 2) * FAN_STEP;
		const offset = rank % 2 === 1 ? magnitude : -magnitude;
		const first = edge.points[0]!;
		const last = edge.points[edge.points.length - 1]!;
		const vertical = Math.abs(last.y - first.y) >= Math.abs(last.x - first.x);
		edge.points = edge.points.map(point =>
			vertical ? { x: point.x + offset, y: point.y } : { x: point.x, y: point.y + offset },
		);
		if (edge.labelPosition) {
			edge.labelPosition = vertical
				? { x: edge.labelPosition.x + offset, y: edge.labelPosition.y }
				: { x: edge.labelPosition.x, y: edge.labelPosition.y + offset };
		}
	}
}

/** Translate a group tree so nested children keep their parent's inset. */
function offsetGroup(group: PositionedGroup, offset: number): PositionedGroup {
	return {
		...group,
		x: group.x + offset,
		y: group.y + offset,
		children: group.children.map(child => offsetGroup(child, offset)),
	};
}

/**
 * Lay out a flowchart or state diagram and project its geometry for SVG consumers.
 *
 * The projection uses nominal 8x16 monospace cells so a 3x3 grid block maps to a readable box.
 */
export function layoutPositionedGraph(
	text: string,
	options: AsciiRenderOptions = {},
): PositionedGraph {
	const parsed = parseMermaid(text);
	if (options.direction) {
		parsed.direction = options.direction;
	}

	const config: AsciiConfig = {
		useAscii: options.useAscii ?? false,
		paddingX: options.paddingX ?? 5,
		paddingY: options.paddingY ?? 5,
		boxBorderPadding: options.boxBorderPadding ?? 1,
		graphDirection: parsed.direction === "LR" || parsed.direction === "RL" ? "LR" : "TD",
	};
	const graph = convertToAsciiGraph(parsed, config);
	createMapping(graph);

	// Content is inset by GRAPH_MARGIN on every side. Without the offset, a
	// group boundary at the layout origin sits exactly on the viewBox edge and
	// half of its stroke is clipped.
	const nodes = graph.nodes.map(node => {
		const projected = projectNode(node);
		return { ...projected, x: projected.x + GRAPH_MARGIN, y: projected.y + GRAPH_MARGIN };
	});
	const edges = graph.edges.map(edge => {
		const projected = projectEdge(graph, edge);
		return {
			...projected,
			points: projected.points.map(point => ({ x: point.x + GRAPH_MARGIN, y: point.y + GRAPH_MARGIN })),
			labelPosition: projected.labelPosition && {
				x: projected.labelPosition.x + GRAPH_MARGIN,
				y: projected.labelPosition.y + GRAPH_MARGIN,
			},
		};
	});
	fanCoincidentEdges(edges);
	const groups = graph.subgraphs
		.filter(sg => sg.parent === null)
		.map(sg => offsetGroup(projectGroup(sg), GRAPH_MARGIN));

	let maxX = 0;
	let maxY = 0;
	for (const node of nodes) {
		maxX = Math.max(maxX, node.x + node.width);
		maxY = Math.max(maxY, node.y + node.height);
	}
	for (const edge of edges) {
		for (const point of edge.points) {
			maxX = Math.max(maxX, point.x);
			maxY = Math.max(maxY, point.y);
		}
		if (edge.labelPosition) {
			maxX = Math.max(maxX, edge.labelPosition.x);
			maxY = Math.max(maxY, edge.labelPosition.y);
		}
	}
	for (const group of graph.subgraphs) {
		const groupMaxX = Math.round((group.maxX * CELL_W) / GRID_UNIT) * GRID_UNIT + GRAPH_MARGIN;
		const groupMaxY = Math.round((group.maxY * CELL_H) / GRID_UNIT) * GRID_UNIT + GRAPH_MARGIN;
		maxX = Math.max(maxX, groupMaxX);
		maxY = Math.max(maxY, groupMaxY);
	}

	return {
		// maxX/maxY already carry the leading inset, so only the trailing side is added.
		width: Math.max(GRID_UNIT, Math.round((maxX + GRAPH_MARGIN) / GRID_UNIT) * GRID_UNIT),
		height: Math.max(GRID_UNIT, Math.round((maxY + GRAPH_MARGIN) / GRID_UNIT) * GRID_UNIT),
		nodes,
		edges,
		groups,
	};
}
