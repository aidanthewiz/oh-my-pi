#!/usr/bin/env bun
/**
 * Build the standalone share page served at `GET /s/<id>`.
 * The embedded viewer fetches and decrypts the blob using the URL fragment key.
 */
import * as path from "node:path";
import { getTemplate } from "../src/export/html/template-assets";

const outPath = process.argv[2];
if (!outPath) {
	console.error("usage: bun scripts/generate-share-viewer.ts <output.html>");
	process.exit(2);
}

const html = getTemplate()
	.replace("<theme-vars/>", "")
	.replace(
		'<script id="session-data" type="application/json">{{SESSION_DATA}}</script>',
		'<script id="session-data" type="application/json" data-source="share"></script>',
	);

if (html.includes("{{SESSION_DATA}}")) throw new Error("session-data placeholder survived substitution");

await Bun.write(outPath, html);
console.log(`Generated ${path.resolve(outPath)} (${(html.length / 1024).toFixed(0)} KB)`);
