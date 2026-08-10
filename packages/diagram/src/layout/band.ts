import type { PositionedNode } from "@oh-my-pi/pi-utils";
import type { NodeOverlay, PositionedFigure } from "../figure";
import { resolveSkin } from "../skin";
import type { DiagramSpec } from "../spec";
import { LEGEND_BAND_HEIGHT } from "./graph";

const FIGURE_WIDTH = 640;
const BAND_X = 16;
const BAND_WIDTH = 608;
const BAND_HEIGHT = 64;
const VERTICAL_GAP = 16;
const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 16;

function makeNodeOverlays(spec: DiagramSpec): Record<string, NodeOverlay> {
	const overlays: Record<string, NodeOverlay> = {};
	for (const node of spec.nodes) {
		overlays[node.id] = {
			kind: node.kind ?? "default",
			focal: node.focal ?? false,
			label: node.label,
			sublabel: node.sublabel,
			badge: node.badge,
		};
	}
	return overlays;
}

function generatedDescription(spec: DiagramSpec): string {
	const count = spec.nodes.length;
	const noun = count === 1 ? "layer" : "layers";
	return `This layer stack contains ${count} ${noun}, from top to bottom: ${spec.nodes.map(node => node.label).join(", ")}.`;
}

/**
 * Lay out a layer stack as full-width horizontal bands.
 *
 * Nodes stay in spec order from top to bottom because a layer stack is ordered
 * by definition. Edges are ignored because stacking expresses containment and
 * connectors are meaningless for this layout family.
 */
export function layoutLayers(spec: DiagramSpec): PositionedFigure {
	const legend = spec.legend ?? [];
	const nodes: PositionedNode[] = spec.nodes.map((node, index) => ({
		id: node.id,
		label: node.label,
		shape: "rectangle",
		x: BAND_X,
		y: TOP_MARGIN + index * (BAND_HEIGHT + VERTICAL_GAP),
		width: BAND_WIDTH,
		height: BAND_HEIGHT,
	}));
	const baseHeight = TOP_MARGIN + spec.nodes.length * (BAND_HEIGHT + VERTICAL_GAP) - VERTICAL_GAP + BOTTOM_MARGIN;

	// Ordinary nodes intentionally carry each band so the SVG node renderer already supplies all styling and labels; do not add a band-specific renderer.
	return {
		title: spec.title,
		eyebrow: spec.eyebrow,
		standfirst: spec.standfirst,
		description: spec.description ?? generatedDescription(spec),
		skinId: resolveSkin(spec.skin).id,
		width: FIGURE_WIDTH,
		height: baseHeight + (legend.length > 0 ? LEGEND_BAND_HEIGHT : 0),
		nodes,
		edges: [],
		zones: [],
		legend,
		nodeOverlays: makeNodeOverlays(spec),
		edgeOverlays: {},
	};
}
