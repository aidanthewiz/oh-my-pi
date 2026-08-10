/**
 * Public surface.
 *
 * One layout feeds both backends, so a saved artifact can never structurally
 * disagree with its terminal preview.
 */
import { renderMermaidAsciiSafe } from "@oh-my-pi/pi-utils";
import type { PositionedFigure } from "./figure";
import { layoutLayers } from "./layout/band";
import { layoutGraph, specToMermaid } from "./layout/graph";
import { layoutMermaidFigure, type MermaidFigureMeta } from "./layout/mermaid";
import { type LintFinding, lintFigure } from "./lint";
import { renderSvgDocument, renderSvgFragment } from "./render/svg";
import type { Skin } from "./skin";
import { resolveSkin } from "./skin";
import { type DiagramSpec, parseSpec } from "./spec";

export type { EdgeOverlay, FigureZone, NodeOverlay, PositionedFigure } from "./figure";
export { edgeKey } from "./figure";
export { layoutLayers } from "./layout/band";
export { layoutGraph, specToMermaid } from "./layout/graph";
export { layoutMermaidFigure, type MermaidFigureMeta } from "./layout/mermaid";
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
	// `layers` is closed-form geometry; every other type routes through the shared
	// graph layout.
	const figure = spec.type === "layers" ? layoutLayers(spec) : layoutGraph(spec);

	return emit(figure, skin, spec.type === "layers" ? null : specToMermaid(spec));
}

/**
 * Render Mermaid source as a branded figure.
 *
 * The graph families the vendored parser understands lay out through the same
 * path as a typed spec, so shorthand is not limited to an ASCII preview. Semantic
 * overlays a spec would carry (node kind, focal, badges) are absent by design:
 * Mermaid cannot express them, so every node renders in the default treatment.
 */
export function renderMermaidDiagram(source: string, meta: MermaidFigureMeta): RenderedDiagram {
	const skin = resolveSkin(meta.skin);
	return emit(layoutMermaidFigure(source, meta), skin, source);
}

/** Shared lint-and-emit tail. `asciiSource` is null when no Mermaid form exists. */
function emit(figure: PositionedFigure, skin: Skin, asciiSource: string | null): RenderedDiagram {
	const findings = lintFigure(figure, skin);
	const errors = findings.filter(finding => finding.severity === "error");
	if (errors.length > 0) {
		throw new Error(`diagram invariants violated:\n${errors.map(e => `  - ${e.rule}: ${e.message}`).join("\n")}`);
	}

	return {
		html: renderSvgDocument(figure, skin),
		svg: renderSvgFragment(figure, skin),
		ascii: asciiSource === null ? null : renderMermaidAsciiSafe(asciiSource),
		findings,
		skinId: skin.id,
		width: figure.width,
		height: figure.height,
	};
}
