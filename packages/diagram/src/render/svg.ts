import type { Point, PositionedEdge, PositionedFigure, PositionedNode } from "../figure";
import type { Skin } from "../skin";
import type { EdgeRole, EdgeStyle, LegendItem, NodeKind } from "../spec";

const LABEL_GAP = 8;
const ELBOW_RADIUS = 8;

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function numberText(value: number): string {
	if (!Number.isFinite(value)) return "0";
	const rounded = Math.round(value * 100) / 100;
	return `${rounded}`;
}

function pointsWithoutDuplicates(points: Point[]): Point[] {
	const result: Point[] = [];
	for (const point of points) {
		if (result.length === 0 || result[result.length - 1].x !== point.x || result[result.length - 1].y !== point.y) {
			result.push(point);
		}
	}
	return result;
}

function orthogonalPath(points: Point[]): string {
	const clean = pointsWithoutDuplicates(points);
	if (clean.length === 0) return "";
	if (clean.length === 1) return `M ${numberText(clean[0].x)} ${numberText(clean[0].y)}`;

	let path = `M ${numberText(clean[0].x)} ${numberText(clean[0].y)}`;
	for (let index = 1; index < clean.length - 1; index += 1) {
		const previous = clean[index - 1];
		const point = clean[index];
		const next = clean[index + 1];
		const incomingHorizontal = previous.y === point.y;
		const outgoingHorizontal = point.y === next.y;
		if (incomingHorizontal === outgoingHorizontal) {
			path += ` L ${numberText(point.x)} ${numberText(point.y)}`;
			continue;
		}

		const incomingLength = Math.hypot(point.x - previous.x, point.y - previous.y);
		const outgoingLength = Math.hypot(next.x - point.x, next.y - point.y);
		const radius = incomingLength < ELBOW_RADIUS * 2 || outgoingLength < ELBOW_RADIUS * 2 ? 0 : ELBOW_RADIUS;
		if (radius < 0.01) {
			path += ` L ${numberText(point.x)} ${numberText(point.y)}`;
			continue;
		}

		const before = {
			x: point.x - ((point.x - previous.x) / incomingLength) * radius,
			y: point.y - ((point.y - previous.y) / incomingLength) * radius,
		};
		const after = {
			x: point.x + ((next.x - point.x) / outgoingLength) * radius,
			y: point.y + ((next.y - point.y) / outgoingLength) * radius,
		};
		path += ` L ${numberText(before.x)} ${numberText(before.y)} Q ${numberText(point.x)} ${numberText(point.y)} ${numberText(after.x)} ${numberText(after.y)}`;
	}
	const last = clean[clean.length - 1];
	path += ` L ${numberText(last.x)} ${numberText(last.y)}`;
	return path;
}

function roleColor(role: EdgeRole): string {
	if (role === "primary") return "accent";
	if (role === "link") return "link";
	return "muted";
}

function edgeWidth(role: EdgeRole, style: EdgeStyle): string {
	if (style === "dashed") return "1";
	if (style === "thick") return "2";
	return role === "primary" ? "1.4" : "1.2";
}

function edgeMarker(role: EdgeRole): string {
	if (role === "primary") return "arrow-primary";
	if (role === "link") return "arrow-link";
	return "arrow-default";
}

function edgeRun(edge: PositionedEdge): { horizontal: boolean; x: number; y: number; length: number } {
	let best = { horizontal: true, x: 0, y: 0, length: 0 };
	for (let index = 1; index < edge.points.length; index += 1) {
		const start = edge.points[index - 1];
		const end = edge.points[index];
		const horizontal = start.y === end.y;
		const length = horizontal ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y);
		if (length > best.length) {
			best = {
				horizontal,
				x: horizontal ? (start.x + end.x) / 2 : start.x,
				y: horizontal ? start.y : (start.y + end.y) / 2,
				length,
			};
		}
	}
	return best;
}

function edgeLabelMarkup(edge: PositionedEdge, label: string): string {
	const run = edgeRun(edge);
	const labelWidth = Math.max(18, label.length * 6.2);
	const position = edge.labelPosition ?? { x: run.x, y: run.y };
	const x = run.horizontal ? position.x : run.x + LABEL_GAP + labelWidth / 2;
	const y = run.horizontal ? run.y - LABEL_GAP - 2 : position.y + 3;
	const maskX = x - labelWidth / 2 - 4;
	const maskY = y - 11;
	return `<g class="edge-label"><rect x="${numberText(maskX)}" y="${numberText(maskY)}" width="${numberText(labelWidth + 8)}" height="14" fill="var(--paper)"/><text x="${numberText(x)}" y="${numberText(y)}" text-anchor="middle">${escapeXml(label.toUpperCase())}</text></g>`;
}

function zoneMarkup(zone: PositionedFigure["zones"][number]): string {
	const label = zone.label.toUpperCase();
	const labelWidth = Math.max(26, label.length * 6.2);
	const labelX = zone.x + 8;
	const labelY = zone.y + 14;
	return `<g class="zone"><rect x="${numberText(zone.x)}" y="${numberText(zone.y)}" width="${numberText(zone.width)}" height="${numberText(zone.height)}" fill="var(--ink)" fill-opacity="0.02" stroke="var(--rule)" stroke-opacity="0.62" stroke-width="1.2" stroke-dasharray="6,4"/><rect x="${numberText(labelX - 4)}" y="${numberText(zone.y - 3)}" width="${numberText(labelWidth + 8)}" height="18" fill="var(--paper)"/><text x="${numberText(labelX)}" y="${numberText(labelY)}">${escapeXml(label)}</text></g>`;
}

function nodeStyle(kind: NodeKind, focal: boolean): { fill: string; stroke: string; opacity: string; dash: string } {
	if (focal) return { fill: "accentTint", stroke: "accent", opacity: "1", dash: "" };
	if (kind === "store") return { fill: "paper", stroke: "rule", opacity: "0.95", dash: "" };
	if (kind === "external") return { fill: "paper2", stroke: "link", opacity: "0.8", dash: "" };
	if (kind === "input") return { fill: "paper2", stroke: "muted", opacity: "0.82", dash: "" };
	if (kind === "optional") return { fill: "paper", stroke: "rule", opacity: "0.6", dash: "6,4" };
	return { fill: "paper2", stroke: "rule", opacity: "0.9", dash: "" };
}

function nodeMarkup(node: PositionedNode, figure: PositionedFigure): string {
	const overlay = figure.nodeOverlays[node.id] ?? { kind: "default" as const, focal: false, label: node.label };
	const style = nodeStyle(overlay.kind, overlay.focal);
	const label = overlay.label || node.label;
	const labelX = node.x + node.width / 2;
	const labelY = overlay.sublabel ? node.y + node.height / 2 - 2 : node.y + node.height / 2 + 4;
	const sublabel = overlay.sublabel
		? `<text class="node-sublabel" x="${numberText(labelX)}" y="${numberText(labelY + 14)}" text-anchor="middle">${escapeXml(overlay.sublabel)}</text>`
		: "";
	const badge = overlay.badge
		? `<text class="node-badge" x="${numberText(node.x + node.width - 8)}" y="${numberText(node.y + 13)}" text-anchor="end">${escapeXml(overlay.badge.toUpperCase())}</text>`
		: "";
	return `<g class="node"><rect x="${numberText(node.x)}" y="${numberText(node.y)}" width="${numberText(node.width)}" height="${numberText(node.height)}" fill="var(--${style.fill})" stroke="var(--${style.stroke})" stroke-opacity="${style.opacity}" stroke-width="${overlay.focal ? "1.4" : "1"}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/><text class="node-label${overlay.focal ? " focal" : ""}" x="${numberText(labelX)}" y="${numberText(labelY)}" text-anchor="middle">${escapeXml(label)}</text>${sublabel}${badge}</g>`;
}

function legendMarkup(items: LegendItem[], figureWidth: number, figureHeight: number): string {
	if (items.length === 0) return "";
	const y = figureHeight - 26;
	const slotWidth = figureWidth / items.length;
	const groups = items.map((item, index) => {
		const role = item.role ?? "default";
		const style = item.style ?? "solid";
		const startX = index * slotWidth;
		const endX = startX + Math.max(12, Math.min(56, slotWidth - 96));
		return `<g class="legend-item"><line x1="${numberText(startX + 16)}" y1="${numberText(y)}" x2="${numberText(endX + 16)}" y2="${numberText(y)}" stroke="var(--${roleColor(role)})" stroke-width="${edgeWidth(role, style)}"${style === "dashed" ? ' stroke-dasharray="4,3"' : ""} marker-end="url(#${edgeMarker(role)})"/><text x="${numberText(startX + 80)}" y="${numberText(y + 4)}">${escapeXml(item.label.toUpperCase())}</text></g>`;
	});
	return `<g class="legend"><line x1="0" y1="${numberText(figureHeight - 51)}" x2="${numberText(figureWidth)}" y2="${numberText(figureHeight - 51)}" stroke="var(--rule)" stroke-opacity="0.42" stroke-width="1"/>${groups.join("")}</g>`;
}

/** Render a positioned figure as a self-contained, offline HTML document. */
export function renderSvgDocument(figure: PositionedFigure, skin: Skin): string {
	const width = figure.width;
	const height = figure.height;
	const colors = skin.colors;
	const css = `:root{--page:${colors.page};--paper:${colors.paper};--paper2:${colors.paper2};--grid:${colors.grid};--ink:${colors.ink};--ink2:${colors.ink2};--muted:${colors.muted};--soft:${colors.soft};--rule:${colors.rule};--accent:${colors.accent};--accentTint:${colors.accentTint};--link:${colors.link};--danger:${colors.danger};--sans:${skin.fonts.sans};--mono:${skin.fonts.mono}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--page);color:var(--ink);font-family:var(--sans)}.figure-page{width:min(100%,${numberText(width)}px);box-sizing:border-box;padding:40px}.figure-chrome{margin-bottom:24px}.eyebrow,.node-badge,.zone text,.legend text{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase}.eyebrow{color:var(--rule);font-weight:700}.figure-chrome h1{margin:8px 0 0;color:var(--ink);font:600 28px/1.15 var(--sans)}.standfirst{margin:10px 0 0;color:var(--soft);font-size:14px;line-height:1.45}.diagram-svg{display:block;width:100%;height:auto}.node-label{fill:var(--ink);font:600 12px var(--sans)}.node-label.focal{fill:var(--accent)}.node-sublabel{fill:var(--soft);font:9px var(--mono)}.node-badge{fill:var(--rule);font-size:8px}.zone text{fill:var(--rule);font-weight:700}.edge-label{fill:var(--muted);font:9px var(--mono);letter-spacing:.08em}.legend text{fill:var(--muted);font-size:9px;font-weight:600}`;
	const ordinals = new Map<string, number>();
	const edgeMarkup = figure.edges
		.map(edge => {
			const pair = `${edge.source}\u0000${edge.target}`;
			const ordinal = ordinals.get(pair) ?? 0;
			ordinals.set(pair, ordinal + 1);
			const overlay = figure.edgeOverlays[`${edge.source}\u0000${edge.target}\u0000${ordinal}`] ?? {
				role: "default" as const,
				style: "solid" as const,
			};
			const color = roleColor(overlay.role);
			const marker = edgeMarker(overlay.role);
			const labels = overlay.label ?? edge.label;
			return `<g class="edge"><path d="${orthogonalPath(edge.points)}" fill="none" stroke="var(--${color})" stroke-width="${edgeWidth(overlay.role, overlay.style)}"${overlay.style === "dashed" ? ' stroke-dasharray="4,3"' : ""}${edge.hasArrowStart ? ` marker-start="url(#${marker})"` : ""}${edge.hasArrowEnd ? ` marker-end="url(#${marker})"` : ""}/>${labels ? edgeLabelMarkup(edge, labels) : ""}</g>`;
		})
		.join("");
	const zones = figure.zones.map(zoneMarkup).join("");
	const nodes = figure.nodes.map(node => nodeMarkup(node, figure)).join("");
	const legend = legendMarkup(figure.legend, width, height);
	const svg = `<svg class="diagram-svg" role="img" aria-labelledby="fig-title fig-desc" viewBox="0 0 ${numberText(width)} ${numberText(height)}" xmlns="http://www.w3.org/2000/svg"><title id="fig-title">${escapeXml(figure.title)}</title><desc id="fig-desc">${escapeXml(figure.description)}</desc><defs><pattern id="grid" width="${numberText(skin.gridSize)}" height="${numberText(skin.gridSize)}" patternUnits="userSpaceOnUse"><path d="M ${numberText(skin.gridSize)} 0 L 0 0 0 ${numberText(skin.gridSize)}" fill="none" stroke="var(--grid)" stroke-width="1"/></pattern><marker id="arrow-default" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 8 4 L 0 8 Z" fill="var(--muted)"/></marker><marker id="arrow-primary" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 8 4 L 0 8 Z" fill="var(--accent)"/></marker><marker id="arrow-link" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 8 4 L 0 8 Z" fill="var(--link)"/></marker></defs><rect x="0" y="0" width="${numberText(width)}" height="${numberText(height)}" fill="var(--paper)"/><rect x="0" y="0" width="${numberText(width)}" height="${numberText(height)}" fill="url(#grid)"/>${zones}${edgeMarkup}${nodes}${legend}</svg>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeXml(figure.title)}</title><style>${css}</style></head><body><main class="figure-page">${figure.eyebrow ? `<div class="eyebrow">${escapeXml(figure.eyebrow)}</div>` : ""}${figure.title ? `<div class="figure-chrome"><h1>${escapeXml(figure.title)}</h1>${figure.standfirst ? `<p class="standfirst">${escapeXml(figure.standfirst)}</p>` : ""}</div>` : ""}${svg}</main></body></html>`;
}
