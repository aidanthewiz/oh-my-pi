import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { environment, receipt, required, run } from "../lib";
import { requiredSurfaces } from "./contract";
import historicalGoldens from "./goldens/manifest.json" with { type: "json" };
import type { Mode } from "./contract";

interface Artifact {
	file: string;
	sha256: string;
	bytes: number;
}
interface Image {
	id: string;
	domain: string;
	mode: Mode;
	artifacts: Artifact[];
}
interface Index {
	schema: string;
	mode: Mode;
	sourceSha: string;
	sourceDigest: string;
	nativeSha256: string;
	manifestSha256: string;
	complete: boolean;
	results: Image[];
	unmet: unknown[];
}
interface Comparison {
	key: string;
	mode: Mode;
	domain: string;
	id: string;
	current: { file: string; sha256: string; artifacts: Artifact[] };
	golden: {
		status: string;
		provenance: string;
		reason: string;
		file: string;
		sha256: string;
		report: number;
		caseIndex: number;
		pngBytesIdentical: boolean;
	};
	peer: {
		status: string;
		mode: Mode;
		file?: string;
		sha256?: string;
		reason?: string;
		pngBytesIdentical?: boolean;
		cellsIdentical?: boolean;
	};
	manualInspectionPassed: boolean;
}

const [flag, mode, ...extra] = process.argv.slice(2);
assert.equal(flag, "--mode");
assert(mode === "source" || mode === "compiled");
assert.equal(extra.length, 0);
const checkout = await fs.realpath(required("CF_QUAL_CHECKOUT"));
const work = await fs.realpath(required("CF_QUAL_WORK"));
assert(work !== checkout && !work.startsWith(checkout + path.sep), "CF_QUAL_WORK must be outside the checkout");
const root = path.resolve(required("CF_QUAL_OUTPUT"));
assert(path.isAbsolute(required("CF_QUAL_OUTPUT")));
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const output = path.join(root, "visual");
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const childWork = await fs.mkdtemp(path.join(work, `visual-${mode}-`));
const manifestFile = required("CF_QUAL_MANIFEST");
const manifestBytes = await fs.readFile(manifestFile);
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
const manifest = JSON.parse(manifestBytes.toString());
assert.equal(manifest.schema, "CoreforgeCandidateSourceSnapshot");
assert.equal(manifest.engineHead, required("CF_QUAL_SOURCE_SHA"));
assert.equal(manifest.native.sha256, required("CF_QUAL_NATIVE_SHA256"));
const binding = {
	sourceSha: manifest.engineHead,
	sourceDigest: manifest.sourceDigest,
	nativeSha256: manifest.native.sha256,
	manifestSha256,
};
const env = {
	...environment(childWork),
	CF_QUAL_CHECKOUT: checkout,
	CF_QUAL_WORK: work,
	CF_QUAL_OUTPUT: root,
	CF_QUAL_SOURCE_SHA: required("CF_QUAL_SOURCE_SHA"),
	CF_QUAL_NATIVE_SHA256: required("CF_QUAL_NATIVE_SHA256"),
	CF_QUAL_BINARY: required("CF_QUAL_BINARY"),
	CF_QUAL_MANIFEST: manifestFile,
	CF_QUAL_MODE: mode,
};
if (process.env.CF_QUAL_DOMAIN_OUTPUT_ROOT)
	Object.assign(env, { CF_QUAL_DOMAIN_OUTPUT_ROOT: required("CF_QUAL_DOMAIN_OUTPUT_ROOT") });
let execution;
try {
	execution = await run([process.execPath, "--no-env-file", path.join(import.meta.dir, "render.ts")], {
		cwd: checkout,
		env,
		timeoutMs: 1_800_000,
		allowFailure: true,
	});
} finally {
	await fs.rm(childWork, { recursive: true, force: true });
}
const indexes: Partial<Record<Mode, Index>> = {};
const indexReferences = [];
for (const channel of ["source", "compiled"] as const) {
	const file = path.join(output, channel, "index.json");
	try {
		const bytes = await fs.readFile(file),
			index: Index = JSON.parse(bytes.toString());
		assert.equal(index.schema, "CoreforgeQualificationVisualArtifacts");
		assert.equal(index.mode, channel);
		for (const key of ["sourceSha", "nativeSha256"] as const)
			assert.equal(index[key], binding[key], `Stale visual ${channel} ${key}`);
		const rendererSnapshotBytes = await fs.readFile(path.join(output, channel, "renderer-source-inputs.json"));
		assert.equal(createHash("sha256").update(rendererSnapshotBytes).digest("hex"), index.manifestSha256);
		const rendererSnapshot = JSON.parse(rendererSnapshotBytes.toString());
		const effectiveLabel = channel === "compiled" ? "binary-effective" : "native-effective";
		assert.equal(rendererSnapshot.engineHead, binding.sourceSha);
		assert.equal(rendererSnapshot.native.sha256, binding.nativeSha256);
		assert.equal(rendererSnapshot.sourceSnapshotLabel, effectiveLabel);
		assert.equal(rendererSnapshot.sourceDigest, index.sourceDigest);
		assert.equal(
			createHash("sha256").update(JSON.stringify(rendererSnapshot.records)).digest("hex"),
			index.sourceDigest,
		);
		assert.deepEqual(rendererSnapshot.records, manifest.producer.effectiveSource[effectiveLabel].files);
		for (const image of index.results)
			for (const artifact of image.artifacts) {
				assert.equal(path.basename(artifact.file), artifact.file);
				const artifactFile = path.join(output, channel, artifact.file);
				assert.equal(await fs.realpath(artifactFile), artifactFile);
				const artifactBytes = await fs.readFile(artifactFile);
				assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), artifact.sha256);
				assert.equal(artifactBytes.length, artifact.bytes);
			}
		indexes[channel] = index;
		indexReferences.push({
			file: `${channel}/index.json`,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			manifestSha256: index.manifestSha256,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
const goldenManifestBytes = await fs.readFile(path.join(import.meta.dir, "goldens", "manifest.json"));
assert.equal(
	createHash("sha256").update(goldenManifestBytes).digest("hex"),
	"03caf1aacaac4e15373a353344f9aa4233043675c096b52ebf8383674889e61d",
);
assert.equal(historicalGoldens.schema, "CoreforgeHistoricalVisualReferences");
assert.equal(historicalGoldens.historicalReferenceOnly, true);
assert.equal(historicalGoldens.images.length, 40);
await fs.mkdir(path.join(output, "goldens"), { recursive: true, mode: 0o700 });
for (const asset of [
	...historicalGoldens.images,
	{
		file: "manifest.json",
		sha256: createHash("sha256").update(goldenManifestBytes).digest("hex"),
		bytes: goldenManifestBytes.length,
	},
]) {
	assert.equal(path.basename(asset.file), asset.file);
	const bytes = await fs.readFile(path.join(import.meta.dir, "goldens", asset.file));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
	assert.equal(bytes.length, asset.bytes);
	const target = path.join(output, "goldens", asset.file);
	try {
		assert.equal(
			createHash("sha256")
				.update(await fs.readFile(target))
				.digest("hex"),
			asset.sha256,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
	}
}
const golden = {
	status: "available-historical-uninspected",
	provenance: "goldens/manifest.json",
	manifestSha256: createHash("sha256").update(goldenManifestBytes).digest("hex"),
	imagesAvailable: true,
	historicalReferenceOnly: true,
	currentQualificationClaimed: false,
	historicalPassReused: false,
	independentlyGeneratedFromCurrentHead: false,
	reason:
		"Exact historical runtime rasters are comparison references, not evidence that the current head passed. Historical font file identities were not recorded.",
	version: historicalGoldens.version,
	sourceSha: historicalGoldens.sourceSha,
	mergeHead: historicalGoldens.mergeHead,
	sourceManifest: historicalGoldens.sourceManifest,
	sourceDigest: historicalGoldens.sourceDigest,
	nativeSha256: historicalGoldens.nativeSha256,
	images: historicalGoldens.images,
	manualInspectionPassed: false,
};
const comparisons: Comparison[] = [];
for (const channel of ["source", "compiled"] as const) {
	const peerMode = channel === "source" ? "compiled" : "source";
	for (const image of indexes[channel]?.results ?? []) {
		const peer = indexes[peerMode]?.results.find(
			candidate => candidate.domain === image.domain && candidate.id === image.id,
		);
		const png = image.artifacts.find(artifact => artifact.file.endsWith(".png"));
		const cells = image.artifacts.find(artifact => artifact.file.endsWith(".cells.json"));
		const peerPng = peer?.artifacts.find(artifact => artifact.file.endsWith(".png"));
		const peerCells = peer?.artifacts.find(artifact => artifact.file.endsWith(".cells.json"));
		assert(png && cells);
		const reference = historicalGoldens.images.find(
			candidate => candidate.mode === channel && candidate.domain === image.domain && candidate.id === image.id,
		);
		assert(reference, `Historical golden case identity missing: ${channel}/${image.domain}/${image.id}`);
		comparisons.push({
			key: `${channel}/${image.domain}/${image.id}`,
			mode: channel,
			domain: image.domain,
			id: image.id,
			current: { file: `${channel}/${png.file}`, sha256: png.sha256, artifacts: image.artifacts },
			golden: {
				status: golden.status,
				provenance: golden.provenance,
				reason: golden.reason,
				file: `goldens/${reference.file}`,
				sha256: reference.sha256,
				report: reference.report,
				caseIndex: reference.index,
				pngBytesIdentical: png.sha256 === reference.sha256,
			},
			peer:
				peerPng && peerCells
					? {
							status: "available-uninspected",
							mode: peerMode,
							file: `${peerMode}/${peerPng.file}`,
							sha256: peerPng.sha256,
							pngBytesIdentical: png.sha256 === peerPng.sha256,
							cellsIdentical: cells.sha256 === peerCells.sha256,
						}
					: {
							status: "unmet",
							mode: peerMode,
							reason: "Matching independently captured runtime channel has not produced an artifact",
						},
			manualInspectionPassed: false,
		});
	}
}
const unmet: unknown[] = [
	{
		scope: "manual-inspection",
		reason: "Parent must actually open current, historical golden, and independent peer images after CI",
	},
	{
		scope: "physical-terminal",
		reason:
			"Kitty VT cells/native SVG rasterization do not establish physical terminal, font, or native media protocol pixels",
	},
];
for (const channel of ["source", "compiled"] as const) {
	if (!indexes[channel]) unmet.push({ scope: channel, reason: "Current visual artifact index is absent" });
	else unmet.push(...indexes[channel]!.unmet.map(item => ({ mode: channel, detail: item })));
}
for (const row of comparisons)
	if (row.peer.status === "unmet") unmet.push({ scope: "peer", key: row.key, reason: row.peer.reason });
const inventory = {
	schema: "CoreforgeQualificationVisualComparisons",
	...binding,
	complete: false,
	runtimeArtifactsComplete: indexes.source?.complete === true && indexes.compiled?.complete === true,
	requiredSurfacesPerMode: requiredSurfaces,
	indexes: indexReferences,
	images: comparisons,
	unmet,
	parentInspectionRequired: true,
	manualInspectionPassed: false,
	physicalTerminalClaimed: false,
	pixelEquivalenceClaimed: false,
};
await fs.writeFile(path.join(output, "golden.json"), JSON.stringify(golden, null, 2) + "\n", { mode: 0o600 });
await fs.writeFile(
	path.join(output, "peer.json"),
	JSON.stringify(
		{
			...binding,
			comparisons: comparisons.map(row => ({ key: row.key, current: row.current, peer: row.peer })),
			manualInspectionPassed: false,
		},
		null,
		2,
	) + "\n",
	{ mode: 0o600 },
);
await fs.writeFile(path.join(output, "comparisons.json"), JSON.stringify(inventory, null, 2) + "\n", { mode: 0o600 });
const escape = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const rows = comparisons
	.map(
		row =>
			`<section><h2>${escape(row.key)}</h2><div class="pair"><figure><a href="${escape(row.current.file)}"><img src="${escape(row.current.file)}" alt="Current ${escape(row.key)}"></a><figcaption>Current ${escape(row.current.sha256)}</figcaption></figure><figure><a href="${escape(row.golden.file)}"><img src="${escape(row.golden.file)}" alt="Historical golden ${escape(row.key)}"></a><figcaption>Historical reference ${escape(row.golden.sha256)}</figcaption></figure>${row.peer.file ? `<figure><a href="${escape(row.peer.file)}"><img src="${escape(row.peer.file)}" alt="Peer ${escape(row.key)}"></a><figcaption>Peer ${escape(row.peer.sha256!)}</figcaption></figure>` : "<p>Peer: unmet</p>"}</div><p>Historical PNG byte identity: ${row.golden.pngBytesIdentical}. Byte differences are not automatically failures or approvals. Manual inspection: unmet.</p><p>${row.current.artifacts.map(artifact => `<a href="${escape(`${row.mode}/${artifact.file}`)}">${escape(artifact.file)}</a>`).join(" · ")}</p></section>`,
	)
	.join("\n");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Current-head terminal visual artifacts</title><style>body{font:16px sans-serif;margin:2rem;background:#eee;color:#111}section{border-top:1px solid #aaa;padding:1rem 0}.pair{display:flex;flex-wrap:wrap;gap:1rem}figure{margin:0;max-width:100%;overflow:auto}img{display:block;max-width:none}figcaption{font:12px monospace;overflow-wrap:anywhere}a{color:#154b91}</style><h1>Terminal visual artifacts: inspection required</h1><p>Source ${escape(binding.sourceSha)} · native ${escape(binding.nativeSha256)}</p><p>No automated or manual visual acceptance is claimed. Current images replay real captured ANSI through Kitty VT and the current native rasterizer. Current font and emulator identities are in each mode index.</p><p>Forty hash-verified historical PNGs provide reference images, not current-head passing evidence. Historical version ${escape(golden.version)}, source ${escape(golden.sourceSha)}, native ${escape(golden.nativeSha256)}. Historical font file identities were not recorded; font and physical-terminal equivalence remain unproven.</p><p><a href="comparisons.json">Comparison inventory</a> · <a href="golden.json">Historical golden provenance</a> · <a href="goldens/manifest.json">Historical source and report identities</a> · <a href="peer.json">Peer inventory</a></p><pre>${escape(JSON.stringify(unmet, null, 2))}</pre>${rows}</html>`;
await fs.writeFile(path.join(output, "index.html"), html, { mode: 0o600 });
for (const channel of ["source", "compiled"] as const)
	if (indexes[channel])
		await fs.writeFile(
			path.join(output, channel, "index.html"),
			'<!doctype html><meta charset="utf-8"><a href="../index.html">Current, golden, and peer comparison index</a>\n',
			{ mode: 0o600 },
		);
await receipt(`visual-${mode}`, {
	...binding,
	execution,
	runtimeArtifactsProduced: indexes[mode]?.complete === true,
	complete: false,
	manualInspectionPassed: false,
	artifacts: {
		index: "visual/index.html",
		inventory: "visual/comparisons.json",
		golden: "visual/golden.json",
		peer: "visual/peer.json",
	},
	unmet,
});
assert.equal(execution.code, 0, execution.stderr);
assert.equal(indexes[mode]?.complete, true, `Current ${mode} visual captures incomplete; see visual/comparisons.json`);
