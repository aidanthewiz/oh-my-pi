import * as fs from "node:fs";
import * as path from "node:path";
import { getTemplate, resolveBundledHtmlAssetPath } from "../../src/export/html/template-assets";
import viewerPath from "../../src/export/html/viewer.generated.js" with { type: "file" };

const html = getTemplate();
const removalIndex = process.argv.indexOf("--remove-assets-after-first-use");
if (removalIndex !== -1) {
	const root = process.argv[removalIndex + 1];
	const rootDirectory = root ? fs.realpathSync(root) : undefined;
	if (
		!rootDirectory ||
		rootDirectory !== fs.realpathSync(import.meta.dir) ||
		path.basename(rootDirectory) !== "cached"
	) {
		throw new Error("Asset removal requires the disposable cached probe directory");
	}
	const asset = resolveBundledHtmlAssetPath(viewerPath);
	if (fs.realpathSync(path.dirname(asset)) !== rootDirectory) {
		throw new Error("Viewer is outside the disposable probe directory");
	}
	fs.rmSync(asset);
	if (getTemplate() !== html) throw new Error("Cached template changed after asset removal");
}
process.stdout.write(html);
