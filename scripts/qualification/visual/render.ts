import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { required } from "../lib";
import { requiredSurfaces } from "./contract";
import type { Mode, VisualInputs } from "./contract";

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const checkout = required("CF_QUAL_CHECKOUT");
const outputRoot = await fs.realpath(required("CF_QUAL_OUTPUT"));
const mode = required("CF_QUAL_MODE") as Mode;
assert(mode === "source" || mode === "compiled");
const output = path.join(outputRoot, "visual", mode);
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const manifestBytes = await fs.readFile(required("CF_QUAL_MANIFEST"));
const manifest = JSON.parse(manifestBytes.toString());
await fs.writeFile(path.join(output, "renderer-source-inputs.json"), manifestBytes, { mode: 0o600, flag: "wx" });
assert.equal(manifest.schema, "CoreforgeCandidateSourceSnapshot");
assert.equal(manifest.engineHead, required("CF_QUAL_SOURCE_SHA"));
assert.equal(manifest.native.sha256, required("CF_QUAL_NATIVE_SHA256"));
assert.equal(sha(JSON.stringify(manifest.records)), manifest.sourceDigest);
const binding = {
	sourceSha: manifest.engineHead,
	sourceDigest: manifest.sourceDigest,
	nativeSha256: manifest.native.sha256,
	manifestSha256: sha(manifestBytes),
	version: manifest.version,
	binary: manifest.binary,
};
const domainRoot = process.env.CF_QUAL_DOMAIN_OUTPUT_ROOT
	? await fs.realpath(path.join(required("CF_QUAL_DOMAIN_OUTPUT_ROOT"), mode))
	: outputRoot;
const inputFile = path.join(domainRoot, "domains", mode, "visual-inputs.json");
let inputs: VisualInputs;
try {
	inputs = JSON.parse(await fs.readFile(inputFile, "utf8"));
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	await fs.writeFile(
		path.join(output, "index.json"),
		JSON.stringify(
			{
				schema: "CoreforgeQualificationVisualArtifacts",
				mode,
				...binding,
				complete: false,
				results: [],
				unmet: [{ prerequisite: inputFile, reason: "Current-head domain captures were not produced" }],
				parentInspectionRequired: true,
				manualInspectionPassed: false,
			},
			null,
			2,
		) + "\n",
		{ mode: 0o600, flag: "wx" },
	);
	process.exit(0);
}
assert.equal(inputs.schema, "CoreforgeQualificationVisualInputs");
assert.equal(inputs.mode, mode);
for (const key of ["sourceSha", "nativeSha256"] as const) assert.equal(inputs[key], binding[key]);
if (domainRoot === outputRoot) assert.equal(inputs.manifestSha256, binding.manifestSha256);
else {
	const producerBytes = await fs.readFile(path.join(domainRoot, "source-inputs.json"));
	assert.equal(sha(producerBytes), inputs.manifestSha256, "Downloaded domain manifest must match its actual producer");
	const producer = JSON.parse(producerBytes.toString());
	assert.equal(producer.schema, manifest.schema);
	assert.equal(producer.engineHead, manifest.engineHead);
	assert.equal(producer.sourceDigest, manifest.sourceDigest);
	assert.equal(sha(JSON.stringify(producer.records)), producer.sourceDigest);
	assert.equal(producer.native.sha256, manifest.native.sha256);
	assert.equal(producer.binary.sha256, manifest.binary.sha256);
	assert.equal(producer.version, manifest.version);
}
assert(Array.isArray(inputs.captures));
assert.equal(new Set(inputs.captures.map(capture => `${capture.domain}/${capture.id}`)).size, inputs.captures.length);

// The qualification checkout is selected at runtime, independently of the script location.
const load = (relative: string) => import(pathToFileURL(path.join(checkout, relative)).href);
const { setTerminalHeadless } = await load("packages/utils/src/env.ts");
setTerminalHeadless(true);
const { rasterizeSvg } = await load("packages/natives/native/index.js");
const { nativeAddonStatus } = await load("packages/natives/native/loader-state.js");
const native = nativeAddonStatus();
assert(native && !native.stale, "Current native addon required");
assert.equal(native.version, manifest.version);
assert.equal(native.packageVersion, manifest.version);
assert.equal(sha(await fs.readFile(native.path)), binding.nativeSha256);
const entry = await fs.realpath(Bun.resolveSync("kitty-vt-wasm", path.join(checkout, "packages/tui/test")));
const emulatorRoot = path.dirname(entry);
const emulatorFiles = await Promise.all(
	["index.js", "terminal.js", "cells.js", "screen.js", "wasm.js", "events.js", "input.js", "kitty-vt.wasm"].map(
		async file => ({
			file: path.join(emulatorRoot, file),
			sha256: sha(await fs.readFile(path.join(emulatorRoot, file))),
		}),
	),
);
const { KittyTerminal, loadModuleSync } = await import(pathToFileURL(entry).href);
const wasm = loadModuleSync(path.join(emulatorRoot, "kitty-vt.wasm"));
const fontFiles: { file: string; sha256: string }[] = [];
async function inventoryFonts(directory: string): Promise<void> {
	let entries;
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) await inventoryFonts(file);
		else if (/\.(ttf|otf|ttc)$/i.test(entry.name)) fontFiles.push({ file, sha256: sha(await fs.readFile(file)) });
	}
}
for (const directory of [
	"/usr/share/fonts",
	"/usr/local/share/fonts",
	path.join(required("HOME"), ".fonts"),
	path.join(required("HOME"), ".local/share/fonts"),
])
	await inventoryFonts(directory);
fontFiles.sort((a, b) => a.file.localeCompare(b.file));
assert(fontFiles.length > 0, "Hosted runner must install terminal fonts before native rasterization");
let deniedAttempts = 0;
const deny = () => {
	deniedAttempts++;
	throw new Error("Captured-ANSI renderer forbids network and child processes");
};
globalThis.fetch = Object.assign(deny, { preconnect: deny }) as typeof fetch;
Bun.spawn = deny as typeof Bun.spawn;
Bun.spawnSync = deny as typeof Bun.spawnSync;
const normalize = (value: string) =>
	value
		.replaceAll("\x1b[?2026h", "")
		.replaceAll("\x1b[?2026l", "")
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/(?<!\r)\n/g, "\r\n");
const escape = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const hex = (value: number) => `#${value.toString(16).padStart(6, "0")}`;
const results = [];
for (const capture of inputs.captures) {
	assert(Object.hasOwn(requiredSurfaces, capture.domain));
	assert(/^[a-zA-Z0-9][a-zA-Z0-9._+/-]*$/.test(capture.id));
	assert(path.isAbsolute(capture.file));
	let captureFile = capture.file;
	if (domainRoot !== outputRoot) {
		const marker = `${path.sep}domains${path.sep}${mode}${path.sep}`;
		const offset = capture.file.lastIndexOf(marker);
		assert(offset >= 0, "Downloaded capture must have an owned domain-relative path");
		captureFile = path.join(domainRoot, "domains", mode, capture.file.slice(offset + marker.length));
	}
	assert(captureFile.startsWith(domainRoot + path.sep));
	assert.equal(await fs.realpath(captureFile), captureFile);
	assert((await fs.lstat(captureFile)).isFile());
	const rawBytes = await fs.readFile(captureFile);
	assert.equal(sha(rawBytes), capture.sha256);
	assert.equal(rawBytes.length, capture.bytes);
	const raw = rawBytes.toString("utf8"),
		capturedRows = raw.split("\n");
	const columns =
		capture.columns ??
		(capture.domain === "async-media"
			? 108
			: Math.max(1, ...capturedRows.map(row => Bun.stringWidth(Bun.stripANSI(row)))));
	const rows =
		capture.rows ??
		(capture.domain === "approval"
			? Math.max(10, capturedRows.length + 2)
			: Math.min(90, Math.max(14, capturedRows.length + 2)));
	assert(Number.isSafeInteger(columns) && columns > 0);
	assert(Number.isSafeInteger(rows) && rows > 0);
	const terminal = KittyTerminal.createSync({ columns, rows, scrollback: 1000, wasm, onOutput() {}, onEvent() {} });
	try {
		terminal.write(normalize(raw));
		const screen = Array.from({ length: rows }, (_, y) => terminal.line(y).trimEnd());
		const expectedRows =
			capture.expectedRows ??
			(capture.domain === "async-media"
				? []
				: capturedRows.map(row => Bun.stripANSI(row).trimEnd()).filter(Boolean));
		for (const row of expectedRows) assert(screen.includes(row), `Captured ANSI replay lost row: ${row}`);
		if (capture.displayed !== undefined)
			assert(
				screen.some(row => row.includes(capture.displayed!)),
				"Captured title missing from replay",
			);
		const color = (value: { rgb: number } | { index: number } | null, fallback: number): number =>
			value === null ? fallback : "rgb" in value ? value.rgb : terminal.paletteColor(value.index);
		const fgDefault = color(terminal.defaultFg, 0xdddddd),
			bgDefault = color(terminal.defaultBg, 0);
		const width = columns * 10,
			height = rows * 20;
		const svg = [
			`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${hex(bgDefault)}"/>`,
		];
		const cells = [],
			glyphs = [];
		for (let y = 0; y < rows; y++)
			for (let x = 0; x < columns; x++) {
				const cell = terminal.cell(x, y);
				assert(cell);
				cells.push(cell);
				let fg = color(cell.fg, fgDefault),
					bg = color(cell.bg, bgDefault);
				if (cell.reverse) [fg, bg] = [bg, fg];
				svg.push(`<rect x="${x * 10}" y="${y * 20}" width="10" height="20" fill="${hex(bg)}"/>`);
				if (cell.wideTrail || !cell.ch) continue;
				const glyph = cell.ch + cell.combining.join("");
				assert(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(glyph));
				glyphs.push(
					`<text x="${x * 10}" y="${y * 20 + 16}" font-family="Menlo,DejaVu Sans Mono,monospace" font-size="16" font-weight="${cell.bold ? 700 : 400}" font-style="${cell.italic ? "italic" : "normal"}" fill="${hex(fg)}" opacity="${cell.dim ? 0.5 : 1}" textLength="${cell.wide ? 20 : 10}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${escape(glyph)}</text>`,
				);
				if (cell.underline)
					glyphs.push(
						`<path d="M${x * 10} ${y * 20 + 18}h${cell.wide ? 20 : 10}" stroke="${hex(color(cell.decorationFg, fg))}"/>`,
					);
				if (cell.strikethrough)
					glyphs.push(`<path d="M${x * 10} ${y * 20 + 10}h${cell.wide ? 20 : 10}" stroke="${hex(fg)}"/>`);
			}
		const svgBytes = Buffer.from([...svg, ...glyphs, "</svg>"].join(""));
		const png = Buffer.from(await rasterizeSvg(svgBytes, width, height, 1, { widthPx: 10, heightPx: 20 }));
		assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
		assert.equal(png.readUInt32BE(16), width);
		assert.equal(png.readUInt32BE(20), height);
		const stem = `${capture.domain}-${capture.id.replaceAll("/", "-").replaceAll("+", "-")}`;
		const artifacts = [];
		for (const [extension, bytes] of [
			["ansi", rawBytes],
			["cells.json", Buffer.from(JSON.stringify(cells))],
			["svg", svgBytes],
			["png", png],
		] as const) {
			const file = `${stem}.${extension}`;
			await fs.writeFile(path.join(output, file), bytes, { mode: 0o600, flag: "wx" });
			artifacts.push({ file, sha256: sha(bytes), bytes: bytes.length });
		}
		results.push({
			id: capture.id,
			domain: capture.domain,
			mode,
			capture,
			resolvedCaptureFile: captureFile,
			columns,
			rows,
			screen,
			artifacts,
		});
	} finally {
		terminal.dispose();
	}
}
assert.equal(deniedAttempts, 0);
const unmet: unknown[] = [...(inputs.unmet ?? [])];
for (const [domain, expected] of Object.entries(requiredSurfaces)) {
	const actual = results.filter(row => row.domain === domain).length;
	if (actual !== expected)
		unmet.push({ domain, expected, actual, reason: "Required real runtime capture coverage is incomplete" });
}
const capturedInputBytes = await fs.readFile(inputFile);
const producerManifestBytes =
	domainRoot === outputRoot ? manifestBytes : await fs.readFile(path.join(domainRoot, "source-inputs.json"));
assert.equal(sha(producerManifestBytes), inputs.manifestSha256);
await fs.writeFile(path.join(output, "capture-inputs.json"), capturedInputBytes, { mode: 0o600, flag: "wx" });
await fs.writeFile(path.join(output, "producer-source-inputs.json"), producerManifestBytes, {
	mode: 0o600,
	flag: "wx",
});
await fs.writeFile(
	path.join(output, "index.json"),
	JSON.stringify(
		{
			schema: "CoreforgeQualificationVisualArtifacts",
			mode,
			...binding,
			complete: unmet.length === 0,
			input: { file: "capture-inputs.json", originalFile: inputFile, sha256: sha(capturedInputBytes) },
			producerSnapshot: { file: "producer-source-inputs.json", sha256: sha(producerManifestBytes) },
			renderer: { file: "scripts/qualification/visual/render.ts", sha256: sha(await fs.readFile(import.meta.path)) },
			native: { ...native, sha256: binding.nativeSha256 },
			emulatorFiles,
			fontFiles,
			results,
			unmet,
			rendererExecutionChannel: "Source-only renderer of actual source/compiled domain captures",
			normalization:
				"Strip synchronized-paint and OSC controls; expand bare LF to CRLF; replay remaining ANSI through Kitty VT cells",
			parentInspectionRequired: true,
			manualInspectionPassed: false,
			physicalTerminalClaimed: false,
			nativeProtocolPixelsClaimed: false,
			pixelEquivalenceClaimed: false,
		},
		null,
		2,
	) + "\n",
	{ mode: 0o600, flag: "wx" },
);
