/**
 * Public surface.
 *
 * One layout feeds both backends, so a saved artifact can never structurally
 * disagree with its terminal preview.
 */
import { renderMermaidAsciiSafe } from "@oh-my-pi/pi-utils";
import { layoutGraph, specToMermaid } from "./layout/graph";
import { type LintFinding, lintFigure } from "./lint";
import { renderSvgDocument, renderSvgFragment } from "./render/svg";
import { resolveSkin } from "./skin";
import { type DiagramSpec, parseSpec } from "./spec";

export type { EdgeOverlay, FigureZone, NodeOverlay, PositionedFigure } from "./figure";
export { edgeKey } from "./figure";
export { layoutGraph, specToMermaid } from "./layout/graph";
export type { LintFinding } from "./lint";
export { lintFigure } from "./lint";
export { renderSvgDocument, renderSvgFragment } from "./render/svg";
export type { Skin, SkinColors } from "./skin";
export { DEFAULT_SKIN_ID, resolveSkin, SKINS } from "./skin";
export * from "./spec";

export interface RenderedDiagram {
	/** Standalone HTML document with inline SVG. Self-contained and offline. */
	html: string;
	/** Standalone `.svg` document with skin tokens declared on the svg element. */
	svg: string;
	/** Terminal preview. Null when the shorthand does not parse. */
	ascii: string | null;
	/** Invariant findings. Errors mean the figure was rejected before emit. */
	findings: LintFinding[];
	skinId: string;
	width: number;
	height: number;
}

/**
 * Validate, lay out, lint, and emit. Throws on an invalid spec or on any
 * error-severity invariant, so a violation fails loudly rather than producing a
 * subtly wrong figure.
 */
export function renderDiagram(input: unknown): RenderedDiagram {
	const spec: DiagramSpec = parseSpec(input);
	const skin = resolveSkin(spec.skin);
	const figure = layoutGraph(spec);

	const findings = lintFigure(figure, skin);
	const errors = findings.filter(finding => finding.severity === "error");
	if (errors.length > 0) {
		throw new Error(`diagram invariants violated:\n${errors.map(e => `  - ${e.rule}: ${e.message}`).join("\n")}`);
	}

	return {
		html: renderSvgDocument(figure, skin),
		svg: renderSvgFragment(figure, skin),
		ascii: renderMermaidAsciiSafe(specToMermaid(spec)),
		findings,
		skinId: skin.id,
		width: figure.width,
		height: figure.height,
	};
}
