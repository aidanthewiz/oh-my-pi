import * as fs from "node:fs";
import * as path from "node:path";
import templateCssPath from "./template.css" with { type: "file" };
import templateHtmlPath from "./template.html" with { type: "file" };
import templateJsPath from "./template.js" with { type: "file" };
import toolViewsJsPath from "./tool-views.generated.js" with { type: "file" };

let cachedTemplate: string | undefined;

/** Resolve a Bun file-loader value without parsing Windows drive letters as URL schemes. */
export function resolveBundledHtmlAssetPath(assetPath: string, moduleDir: string = import.meta.dir): string {
	if (path.isAbsolute(assetPath) || path.win32.isAbsolute(assetPath)) return assetPath;
	return path.resolve(moduleDir, assetPath);
}

/** Compose the standalone export template: minified CSS, tool renderers, and viewer JS inlined. */
export function getTemplate(): string {
	if (cachedTemplate) return cachedTemplate;
	const templateCss = fs.readFileSync(resolveBundledHtmlAssetPath(templateCssPath), "utf8");
	const templateHtml = fs.readFileSync(resolveBundledHtmlAssetPath(templateHtmlPath as unknown as string), "utf8");
	const templateJs = fs.readFileSync(resolveBundledHtmlAssetPath(templateJsPath), "utf8");
	const toolViewsJs = fs.readFileSync(resolveBundledHtmlAssetPath(toolViewsJsPath), "utf8");
	const minifiedCss = templateCss
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{}:;,])\s*/g, "$1")
		.trim();
	cachedTemplate = templateHtml
		.replace("<template-css/>", () => `<style>${minifiedCss}</style>`)
		.replace("<template-tool-views/>", () => `<script>${toolViewsJs}</script>`)
		.replace("<template-js/>", () => `<script>${templateJs}</script>`);
	return cachedTemplate;
}
