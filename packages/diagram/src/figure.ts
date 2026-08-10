/**
 * Positioned figure: the single hand-off between layout and every backend.
 *
 * Geometry reuses the positioned-graph types the vendored Mermaid renderer
 * already declares, so there is exactly one positioned model in the engine
 * rather than a parallel one per backend. Semantic overlays carry what the
 * Mermaid model cannot express (node kind, badge, sublabel, focal, edge role)
 * and are keyed by node or edge identity so a backend can style without
 * re-deriving anything.
 */
import type { Point, PositionedEdge, PositionedGraph, PositionedNode } from "@oh-my-pi/pi-utils";
import type { DiagramSpec, EdgeRole, EdgeStyle, LegendItem, NodeKind } from "./spec";

/** Per-node semantics the positioned graph does not carry. */
export interface NodeOverlay {
	kind: NodeKind;
	focal: boolean;
	label: string;
	sublabel?: string;
	badge?: string;
}

/** Per-edge semantics the positioned graph does not carry. */
export interface EdgeOverlay {
	role: EdgeRole;
	style: EdgeStyle;
	label?: string;
}

/** A laid-out boundary group with resolved pixel bounds. */
export interface FigureZone {
	id: string;
	label: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Nesting depth, so a backend can vary wash strength without recursing. */
	depth: number;
}

export interface PositionedFigure {
	/** Figure chrome. */
	title: string;
	eyebrow?: string;
	standfirst?: string;
	/** Accessible description; layout generates one when the spec omits it. */
	description: string;
	skinId: string;
	/** Geometry in SVG user units. */
	width: number;
	height: number;
	nodes: PositionedNode[];
	edges: PositionedEdge[];
	zones: FigureZone[];
	legend: LegendItem[];
	/** Keyed by `PositionedNode.id`. */
	nodeOverlays: Record<string, NodeOverlay>;
	/** Keyed by `edgeKey(edge)`. */
	edgeOverlays: Record<string, EdgeOverlay>;
}

/**
 * Stable identity for an edge overlay. Source and target alone are ambiguous
 * when a spec declares parallel edges, so the ordinal disambiguates.
 */
export function edgeKey(source: string, target: string, ordinal: number): string {
	return `${source}\u0000${target}\u0000${ordinal}`;
}

/** Layout entrypoint implemented per family. */
export type LayoutFn = (spec: DiagramSpec) => PositionedFigure;

export type { Point, PositionedEdge, PositionedGraph, PositionedNode };
