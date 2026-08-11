import type { PositionedFigure } from "./figure";
import type { Skin } from "./skin";

const HEX_COLOR = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;
const RGB_COMPONENT = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d|(?:100|[1-9]?\\d)%)";
const RGB_COLOR = new RegExp(`^rgb\\(\\s*${RGB_COMPONENT}\\s*,\\s*${RGB_COMPONENT}\\s*,\\s*${RGB_COMPONENT}\\s*\\)$`);
const RGBA_COLOR = new RegExp(
	`^rgba\\(\\s*${RGB_COMPONENT}\\s*,\\s*${RGB_COMPONENT}\\s*,\\s*${RGB_COMPONENT}\\s*,\\s*(?:0|1|0?\\.\\d+|100%)\\s*\\)$`,
);

/** A deterministic emit-time finding for a positioned diagram figure. */
export interface LintFinding {
	rule: string;
	severity: "error" | "warning";
	message: string;
}

/**
 * Checks positioned geometry and skin values before a backend emits an artifact.
 *
 * All applicable findings are returned so callers can report the complete set.
 */
export function lintFigure(figure: PositionedFigure, skin: Skin): LintFinding[] {
	const findings: LintFinding[] = [];
	const focalCount = figure.nodes.reduce(
		(count, node) => count + (figure.nodeOverlays[node.id]?.focal === true ? 1 : 0),
		0,
	);
	if (focalCount > 2) {
		findings.push({
			rule: "accent-budget",
			severity: "error",
			message: `Figure has ${focalCount} focal nodes; at most 2 are allowed.`,
		});
	}

	if (figure.nodes.length >= 10) {
		findings.push({
			rule: "node-budget",
			severity: figure.nodes.length > 14 ? "error" : "warning",
			message: `Figure has ${figure.nodes.length} nodes; figures at 10 or more nodes should be split.`,
		});
	}

	for (const edge of figure.edges) {
		for (let index = 1; index < edge.points.length; index += 1) {
			const previous = edge.points[index - 1];
			const current = edge.points[index];
			if (previous.x !== current.x && previous.y !== current.y) {
				findings.push({
					rule: "orthogonal-connectors",
					severity: "error",
					message: `Edge ${edge.source}->${edge.target} has a diagonal segment ${index - 1} from (${previous.x},${previous.y}) to (${current.x},${current.y}).`,
				});
			}
		}
	}

	for (const node of figure.nodes) {
		const misaligned: string[] = [];
		if (node.x % 4 !== 0) misaligned.push("x");
		if (node.y % 4 !== 0) misaligned.push("y");
		if (node.width % 4 !== 0) misaligned.push("width");
		if (node.height % 4 !== 0) misaligned.push("height");
		if (misaligned.length > 0) {
			findings.push({
				rule: "grid-alignment",
				severity: "warning",
				message: `Node ${node.id} has ${misaligned.join(", ")} not divisible by 4.`,
			});
		}
	}

	for (const zone of figure.zones) {
		const zoneRight = zone.x + zone.width;
		const zoneBottom = zone.y + zone.height;
		for (const node of figure.nodes) {
			const nodeRight = node.x + node.width;
			const nodeBottom = node.y + node.height;
			const overlaps = node.x < zoneRight && nodeRight > zone.x && node.y < zoneBottom && nodeBottom > zone.y;
			const contained = node.x >= zone.x && node.y >= zone.y && nodeRight <= zoneRight && nodeBottom <= zoneBottom;
			if (overlaps && !contained) {
				findings.push({
					rule: "zone-containment",
					severity: "error",
					message: `Node ${node.id} straddles zone ${zone.id} boundary.`,
				});
			}
		}
	}

	// A straddle check alone cannot see the worst failure: a node sitting wholly
	// inside the wrong zone, or a zone collapsed to a sliver beside its members.
	// Declared membership is the only ground truth for that, so it is compared
	// against final geometry here.
	const zoneById: Record<string, PositionedFigure["zones"][number]> = {};
	for (const zone of figure.zones) zoneById[zone.id] = zone;
	for (const node of figure.nodes) {
		const declared = figure.nodeOverlays[node.id]?.zone;
		if (declared === undefined) continue;
		const zone = zoneById[declared];
		if (zone === undefined) {
			findings.push({
				rule: "zone-membership",
				severity: "error",
				message: `Node ${node.id} declares zone ${declared}, which the layout did not produce.`,
			});
			continue;
		}
		const contained =
			node.x >= zone.x &&
			node.y >= zone.y &&
			node.x + node.width <= zone.x + zone.width &&
			node.y + node.height <= zone.y + zone.height;
		if (!contained) {
			findings.push({
				rule: "zone-membership",
				severity: "error",
				message: `Node ${node.id} declares zone ${declared} but renders outside it.`,
			});
		}
	}

	for (const zone of figure.zones) {
		// A zone narrower or shorter than a single grid step cannot enclose anything
		// and is the signature of a collapsed bounding box.
		if (zone.width <= 8 || zone.height <= 8) {
			findings.push({
				rule: "zone-bounds",
				severity: "error",
				message: `Zone ${zone.id} collapsed to ${zone.width}x${zone.height} and encloses nothing.`,
			});
		}
	}

	// Overlapping boundaries are legible but ambiguous: a reader cannot tell which
	// zone a node in the intersection belongs to. Placement, not the box, decides
	// this, so it is reported rather than corrected.
	for (let i = 0; i < figure.zones.length; i++) {
		for (let j = i + 1; j < figure.zones.length; j++) {
			const a = figure.zones[i]!;
			const b = figure.zones[j]!;
			if (a.id === b.id) continue;
			const nested = a.depth !== b.depth;
			const intersects = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
			if (intersects && !nested) {
				findings.push({
					rule: "zone-overlap",
					severity: "warning",
					message: `Zones ${a.id} and ${b.id} overlap, so membership in the intersection is ambiguous.`,
				});
			}
		}
	}

	const routes = new Map<string, string>();
	for (const edge of figure.edges) {
		const key = edge.points.map(point => `${point.x},${point.y}`).join(" ");
		const previous = routes.get(key);
		if (previous !== undefined) {
			findings.push({
				rule: "duplicate-edge-path",
				severity: "error",
				message: `Edges ${previous} and ${edge.source}->${edge.target} share one route, so they cannot be told apart.`,
			});
		} else {
			routes.set(key, `${edge.source}->${edge.target}`);
		}
	}

	for (const [edgeId, overlay] of Object.entries(figure.edgeOverlays)) {
		if (overlay.label !== undefined && overlay.label.length > 14) {
			findings.push({
				rule: "label-length",
				severity: "warning",
				message: `Edge overlay ${edgeId} label is ${overlay.label.length} characters; labels longer than 14 characters can collide with connectors.`,
			});
		}
	}

	if (figure.nodes.length === 0) {
		findings.push({
			rule: "empty-figure",
			severity: "error",
			message: "Figure has zero nodes.",
		});
	}

	for (let firstIndex = 0; firstIndex < figure.nodes.length; firstIndex += 1) {
		const first = figure.nodes[firstIndex];
		const firstRight = first.x + first.width;
		const firstBottom = first.y + first.height;
		for (let secondIndex = firstIndex + 1; secondIndex < figure.nodes.length; secondIndex += 1) {
			const second = figure.nodes[secondIndex];
			const secondRight = second.x + second.width;
			const secondBottom = second.y + second.height;
			if (first.x < secondRight && firstRight > second.x && first.y < secondBottom && firstBottom > second.y) {
				findings.push({
					rule: "overlapping-nodes",
					severity: "error",
					message: `Nodes ${first.id} and ${second.id} intersect.`,
				});
			}
		}
	}

	for (const [role, color] of Object.entries(skin.colors)) {
		if (!HEX_COLOR.test(color) && !RGB_COLOR.test(color) && !RGBA_COLOR.test(color)) {
			findings.push({
				rule: "palette-closure",
				severity: "error",
				message: `Skin color role ${role} has invalid color value ${color}.`,
			});
		}
	}

	findings.sort((left, right) => {
		const severityOrder = Number(right.severity === "error") - Number(left.severity === "error");
		if (severityOrder !== 0) return severityOrder;
		return left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0;
	});
	return findings;
}
