import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const [outputArgument, sourceSha, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert(outputArgument && sourceSha);
assert.match(sourceSha, /^[a-f0-9]{40}$/);
const output = await fs.realpath(outputArgument);
const visual = path.join(output, "visual");
const unmet: string[] = [];
const receipts: object[] = [];
let complete = false;
try {
	const inventory = JSON.parse(await fs.readFile(path.join(visual, "comparisons.json"), "utf8"));
	assert.equal(inventory.schema, "CoreforgeQualificationVisualComparisons");
	assert.equal(inventory.sourceSha, sourceSha);
	const baseline = JSON.parse(await fs.readFile(path.join(visual, "goldens", "manifest.json"), "utf8"));
	assert.equal(baseline.schema, "CoreforgeHistoricalVisualReferences");
	assert.equal(baseline.historicalReferenceOnly, true);
	assert.equal(baseline.currentQualificationClaimed, false);
	assert.equal(baseline.historicalPassReused, false);
	assert.equal(baseline.images.length, 40);
	assert.match(baseline.sourceSha, /^[a-f0-9]{40}$/);
	assert.match(baseline.mergeHead, /^[a-f0-9]{40}$/);
	assert.match(baseline.sourceDigest, /^[a-f0-9]{64}$/);
	assert.match(baseline.sourceManifest.sha256, /^[a-f0-9]{64}$/);
	assert.equal(inventory.runtimeArtifactsComplete, true);
	assert.equal(inventory.images.length, 40, "Require every actual source and compiled capture");
	assert.equal(new Set(inventory.images.map((row: { key: string }) => row.key)).size, 40);
	for (const image of inventory.images) {
		for (const kind of ["current", "peer", "golden"]) {
			const artifact = image[kind];
			if (!artifact?.file || !artifact.sha256) {
				unmet.push(`${image.key}: ${kind} image or provenance is unavailable`);
				continue;
			}
			assert(!path.isAbsolute(artifact.file) && !artifact.file.split(/[\\/]/).includes(".."));
			const file = path.join(visual, artifact.file);
			assert.equal(await fs.realpath(file), file);
			const bytes = await fs.readFile(file);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
			assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
			if (kind === "golden")
				assert(
					baseline.images.some(
						(item: { file: string; sha256: string; mode: string; domain: string; id: string }) =>
							artifact.file === `goldens/${item.file}` &&
							item.sha256 === artifact.sha256 &&
							item.mode === image.mode &&
							item.domain === image.domain &&
							item.id === image.id,
					),
				);
			receipts.push({ key: image.key, kind, file: artifact.file, sha256: artifact.sha256, bytes: bytes.length });
		}
	}
	complete = unmet.length === 0;
} catch (error) {
	unmet.push(String(error));
}
await fs.writeFile(
	path.join(output, "visual-gate.json"),
	JSON.stringify(
		{
			schema: "CoreforgeQualificationVisualGate",
			sourceSha,
			runtimeArtifactsComplete: complete,
			passed: complete,
			qualificationComplete: false,
			observed: receipts,
			unmet,
			manualInspectionPassed: false,
			manualInspection:
				"Parent must inspect current, historical golden, and peer images; generation and historical attestations do not establish current acceptance.",
			golden:
				"Forty exact historical PNG references preserve old source/merge/native/renderer/emulator provenance. Historical font identities are unrecorded; no physical pixel equivalence is claimed.",
		},
		null,
		2,
	) + "\n",
	{ mode: 0o600 },
);
assert(complete, `Visual qualification is unmet:\n${unmet.join("\n")}`);
