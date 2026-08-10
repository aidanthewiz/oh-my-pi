/**
 * Diagram spec.
 *
 * The typed spec is the real input: the engine owns layout, so a figure is
 * consistent by construction rather than by a model obeying prose rules. Mermaid
 * source is accepted as shorthand for the families its parser can express.
 *
 * Node and edge vocabulary is deliberately semantic (`kind`, `role`, `emphasis`)
 * rather than visual. Callers never choose colors; the skin does.
 */
import { type } from "arktype";

/**
 * Node treatment. Semantic, so one skin change restyles every figure.
 * `store`, `external`, `input`, and `optional` differ only in fill and stroke
 * weight; `default` is the ordinary service box.
 */
export const nodeKindSchema = type("'default'|'store'|'external'|'input'|'optional'");

/** Connector meaning. `primary` is the accented path; `link` is inbound/external. */
export const edgeRoleSchema = type("'default'|'primary'|'link'");

export const edgeStyleSchema = type("'solid'|'dashed'|'thick'");

export const diagramNodeSchema = type({
	id: type("string").describe("unique node id, referenced by edges"),
	label: type("string").describe("human-readable name, sentence case"),
	"sublabel?": type("string").describe("technical detail: port, protocol, engine"),
	"kind?": nodeKindSchema,
	"badge?": type("string").describe("short tag: store kind, tier, owner"),
	"zone?": type("string").describe("id of the containing zone"),
	"focal?": type("boolean").describe("mark as focal; budgeted by the lint"),
});

export const diagramEdgeSchema = type({
	from: type("string").describe("source node id"),
	to: type("string").describe("target node id"),
	"label?": type("string").describe("short uppercase annotation, 14 chars or fewer"),
	"role?": edgeRoleSchema,
	"style?": edgeStyleSchema,
});

/** Nested labelled boundary group: network boundary, trust zone, tenant, tier. */
export const diagramZoneSchema = type({
	id: type("string").describe("unique zone id"),
	label: type("string").describe("boundary label, rendered as an eyebrow"),
	"parent?": type("string").describe("id of the enclosing zone"),
});

export const legendItemSchema = type({
	label: type("string").describe("what this connector means"),
	"role?": edgeRoleSchema,
	"style?": edgeStyleSchema,
});

/**
 * Figure types. `architecture`, `flowchart`, and `state` share the graph layout
 * (placement plus orthogonal routing); `layers` is a closed-form stack of bands
 * and ignores `edges`.
 */
export const diagramTypeSchema = type("'architecture'|'flowchart'|'state'|'layers'");

export const diagramSpecSchema = type({
	type: diagramTypeSchema,
	title: type("string").describe("figure title"),
	"eyebrow?": type("string").describe("uppercase kicker above the title"),
	"standfirst?": type("string").describe("one or two sentences of context"),
	"description?": type("string").describe("accessible description; falls back to a generated summary"),
	"skin?": type("string").describe("skin id; defaults to soma-navy"),
	"direction?": type("'TD'|'LR'").describe("primary flow direction"),
	nodes: diagramNodeSchema.array().atLeastLength(1),
	"edges?": diagramEdgeSchema.array(),
	"zones?": diagramZoneSchema.array(),
	"legend?": legendItemSchema.array(),
	"+": "reject",
});

export type NodeKind = typeof nodeKindSchema.infer;
export type EdgeRole = typeof edgeRoleSchema.infer;
export type EdgeStyle = typeof edgeStyleSchema.infer;
export type DiagramNode = typeof diagramNodeSchema.infer;
export type DiagramEdge = typeof diagramEdgeSchema.infer;
export type DiagramZone = typeof diagramZoneSchema.infer;
export type LegendItem = typeof legendItemSchema.infer;
export type DiagramType = typeof diagramTypeSchema.infer;
export type DiagramSpec = typeof diagramSpecSchema.infer;

/**
 * Validate a spec and resolve cross-references the schema cannot express:
 * duplicate ids, edges naming unknown nodes, and zone parents forming a cycle.
 * Returns the spec so callers can use it directly.
 */
export function parseSpec(input: unknown): DiagramSpec {
	const spec = diagramSpecSchema(input);
	if (spec instanceof type.errors) throw new Error(`invalid diagram spec: ${spec.summary}`);

	const nodeIds = new Set<string>();
	for (const node of spec.nodes) {
		if (nodeIds.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
		nodeIds.add(node.id);
	}

	const zoneIds = new Set<string>();
	for (const zone of spec.zones ?? []) {
		if (zoneIds.has(zone.id)) throw new Error(`duplicate zone id: ${zone.id}`);
		zoneIds.add(zone.id);
	}

	for (const node of spec.nodes) {
		if (node.zone !== undefined && !zoneIds.has(node.zone)) {
			throw new Error(`node ${node.id} references unknown zone: ${node.zone}`);
		}
	}

	for (const edge of spec.edges ?? []) {
		if (!nodeIds.has(edge.from)) throw new Error(`edge references unknown node: ${edge.from}`);
		if (!nodeIds.has(edge.to)) throw new Error(`edge references unknown node: ${edge.to}`);
	}

	// Zone nesting must be a forest. A cycle would make bounds computation
	// non-terminating, so reject it here rather than in layout.
	for (const zone of spec.zones ?? []) {
		const seen = new Set<string>([zone.id]);
		let parent = zone.parent;
		while (parent !== undefined) {
			if (seen.has(parent)) throw new Error(`zone parent cycle at: ${zone.id}`);
			if (!zoneIds.has(parent)) throw new Error(`zone ${zone.id} references unknown parent: ${parent}`);
			seen.add(parent);
			parent = (spec.zones ?? []).find(candidate => candidate.id === parent)?.parent;
		}
	}

	return spec;
}
