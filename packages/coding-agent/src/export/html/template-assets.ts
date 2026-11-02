import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import templateHtml from "./template.html.txt" with { type: "text" };
import viewerJsPath from "./viewer.generated.js" with { type: "file" };
import viewerAsset from "./viewer.generated.json" with { type: "json" };

let cachedTemplate: string | undefined;

/** Resolve a Bun file-loader value without parsing Windows drive letters as URL schemes. */
export function resolveBundledHtmlAssetPath(assetPath: string, moduleDir: string = import.meta.dir): string {
	if (path.isAbsolute(assetPath) || path.win32.isAbsolute(assetPath)) return assetPath;
	return path.resolve(moduleDir, assetPath);
}

/** Compose the standalone export from the exact locally bundled viewer bytes. */
export function getTemplate(): string {
	if (cachedTemplate) return cachedTemplate;
	const viewer = fs.readFileSync(resolveBundledHtmlAssetPath(viewerJsPath));
	const digest = createHash("sha256").update(viewer).digest();
	if (
		viewer.byteLength !== viewerAsset.size ||
		viewerAsset.file !== `export-viewer-${digest.toString("hex")}.js` ||
		viewerAsset.integrity !== `sha256-${digest.toString("base64")}`
	) {
		throw new Error("Bundled export viewer does not match viewer.generated.json. Run bun run gen:export-viewer.");
	}
	const escaped = viewer.toString("utf8").replace(/<\/script/gi, match => `<\\/${match.slice(2)}`);
	cachedTemplate = templateHtml.replace("<viewer-script/>", () => `<script>${escaped}</script>`);
	return cachedTemplate;
}
