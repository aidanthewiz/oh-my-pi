import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runTitleDatabases } from "./databases";
import { environment, fingerprint, privateDirectory, receipt, required, run, sha256 } from "./lib";

const [scope, mode, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0);
assert(["domains", "controls", "sdk", "visual"].includes(scope!));
assert(["source", "compiled"].includes(mode!));
const checkout = await fs.realpath(process.cwd());
const sourceSha = required("CF_QUAL_SOURCE_SHA");
assert.match(sourceSha, /^[a-f0-9]{40}$/);
const event = JSON.parse(await fs.readFile(required("GITHUB_EVENT_PATH"), "utf8"));
assert.equal(event.pull_request.head.sha, sourceSha, "Qualification must bind the pull-request head, not a merge ref");
assert.equal(
	event.pull_request.head.repo.full_name,
	required("GITHUB_REPOSITORY"),
	"Only same-repository PR fixtures are admitted",
);
const artifact = JSON.parse(await fs.readFile(path.join(checkout, "qualification-inputs.json"), "utf8"));
assert.equal(artifact.schemaVersion, 1);
assert.equal(artifact.sourceSha, sourceSha);
assert.equal(artifact.platform, "linux-x64");
assert.equal(String(artifact.runId), required("GITHUB_RUN_ID"));
assert.equal(String(artifact.runAttempt), required("GITHUB_RUN_ATTEMPT"));
assert(Array.isArray(artifact.files) && artifact.files.length > 0);
for (const item of artifact.files) {
	assert(typeof item.path === "string" && !path.isAbsolute(item.path) && !item.path.split(/[\\/]/).includes(".."));
	const file = path.join(checkout, item.path);
	assert.equal(await fingerprint(file), item.sha256, `Artifact input changed: ${item.path}`);
	assert.equal((await fs.stat(file)).size, item.size);
}
const work = await fs.mkdtemp(path.join(os.tmpdir(), "cfq-"));
await fs.chmod(work, 0o700);
const output = path.resolve(required("CF_QUAL_OUTPUT"));
assert(!output.startsWith(checkout + path.sep) && !work.startsWith(checkout + path.sep));
const originalRustup = process.env.RUSTUP_HOME ?? (process.env.HOME ? path.join(process.env.HOME, ".rustup") : "");
const qualification = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("CF_QUAL_")));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {
	...qualification,
	CF_QUAL_CHECKOUT: checkout,
	CF_QUAL_WORK: work,
	CF_QUAL_OUTPUT: output,
	CF_QUAL_MODE: mode,
	CF_QUAL_RUSTUP_HOME: originalRustup,
	CF_QUAL_SYNTHETIC_ONLY: "1",
	PATH: qualification.CF_QUAL_TOOL_PATH!,
});
assert(process.env.PATH, "CF_QUAL_TOOL_PATH must identify installed public toolchains");
Object.assign(process.env, environment(work));
await Promise.all([privateDirectory(output), privateDirectory(required("HOME")), privateDirectory(required("TMPDIR"))]);
interface SourceFingerprint {
	path: string;
	sha256?: string;
	size?: number;
	missing?: true;
}
interface SourceObservation {
	head: string;
	records: SourceFingerprint[];
	commands: { argv: string[]; code: number }[];
}
const sourceSnapshotLabel = mode === "compiled" ? "binary-effective" : "native-effective";
const effectiveSource = artifact.effectiveSource[sourceSnapshotLabel];
assert.equal(effectiveSource.sourceSha, sourceSha);
assert.equal(effectiveSource.label, sourceSnapshotLabel);
assert(Array.isArray(effectiveSource.files) && effectiveSource.files.length > 0);
assert.equal(sha256(JSON.stringify(effectiveSource.files)), effectiveSource.trackedFilesSha256);
const overlays: { sourcePath: string; artifactPath: string; sha256: string }[] = [];
if (mode === "compiled") {
	const expectedOverlays = [
		{
			sourcePath: "packages/coding-agent/src/cli/cf-version.generated.ts",
			artifactPath: "qualification-effective-source/cf-version.generated.ts",
		},
		{
			sourcePath: "packages/stats/src/embedded-client.generated.txt",
			artifactPath: "qualification-effective-source/embedded-client.generated.txt",
		},
	];
	assert.deepEqual(artifact.generatedSources, expectedOverlays);
	for (const overlay of expectedOverlays) {
		const expected = effectiveSource.files.find((item: { path: string }) => item.path === overlay.sourcePath);
		assert(expected?.sha256, `Missing producer effective source: ${overlay.sourcePath}`);
		const supplied = path.join(checkout, overlay.artifactPath),
			target = path.join(checkout, overlay.sourcePath);
		assert.equal(await fingerprint(supplied), expected.sha256);
		await fs.copyFile(supplied, target);
		assert.equal(await fingerprint(target), expected.sha256);
		overlays.push({ ...overlay, sha256: expected.sha256 });
	}
}
async function observeTrackedSource(): Promise<SourceObservation> {
	const commands: SourceObservation["commands"] = [];
	const results = [];
	for (const argv of [
		["git", "rev-parse", "HEAD"],
		["git", "ls-files", "-z"],
	]) {
		const observed = spawnSync(argv[0]!, argv.slice(1), {
			cwd: checkout,
			env: environment(work),
			encoding: "utf8",
			timeout: 60_000,
			maxBuffer: 32 * 1024 ** 2,
		});
		assert.ifError(observed.error);
		assert.equal(observed.status, 0, observed.stderr);
		commands.push({ argv, code: observed.status! });
		results.push(observed.stdout);
	}
	const records: SourceFingerprint[] = [];
	for (const relative of results[1]!.split("\0").filter(Boolean).sort()) {
		assert(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."));
		try {
			const bytes = await fs.readFile(path.join(checkout, relative));
			records.push({ path: relative, sha256: sha256(bytes), size: bytes.length });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			records.push({ path: relative, missing: true });
		}
	}
	return { head: results[0]!.trim(), records, commands };
}
const sourceBefore = await observeTrackedSource();
assert.equal(sourceBefore.head, sourceSha);
assert.deepEqual(
	sourceBefore.records,
	effectiveSource.files,
	`Actual checkout differs from producer ${sourceSnapshotLabel}`,
);
const sourceDigest = sha256(JSON.stringify(sourceBefore.records));
assert.equal(sourceDigest, effectiveSource.trackedFilesSha256);
let passed = false;
try {
	const version = JSON.parse(await fs.readFile(path.join(checkout, "packages/natives/package.json"), "utf8")).version;
	process.env.CF_QUAL_VERSION = version;
	// The loader must first execute after private HOME, sealed overlays, and actual source verification.
	const nativeModule = await import(path.join(checkout, "packages/natives/native/index.js"));
	assert(nativeModule);
	const { nativeAddonStatus } = await import(path.join(checkout, "packages/natives/native/loader-state.js"));
	const native = nativeAddonStatus();
	assert(native && !native.stale);
	assert.equal(native.version, version);
	const nativeInput = artifact.files.find((item: { path: string }) => path.join(checkout, item.path) === native.path);
	assert(nativeInput, "Loaded addon is not an artifact input");
	const nativeCopy = path.join(work, path.basename(native.path));
	await fs.copyFile(native.path, nativeCopy);
	process.env.CF_QUAL_NATIVE_ORIGINAL = native.path;
	process.env.CF_QUAL_NATIVE_PATH = nativeCopy;
	process.env.CF_QUAL_NATIVE_SHA256 = nativeInput.sha256;
	assert.equal(await fingerprint(nativeCopy), nativeInput.sha256);
	const binaryRelative = "packages/coding-agent/binaries/omp-linux-x64";
	const binaryInput = artifact.files.find((item: { path: string }) => item.path === binaryRelative);
	assert(binaryInput, "Missing exact producer binary");
	const binary = path.join(work, "omp-linux-x64");
	await fs.copyFile(path.join(checkout, binaryRelative), binary);
	await fs.chmod(binary, 0o700);
	process.env.CF_QUAL_BINARY = binary;
	process.env.CF_QUAL_BINARY_SHA256 = binaryInput.sha256;
	assert.equal(await fingerprint(binary), binaryInput.sha256);
	const manifest = path.join(work, "source-inputs.json");
	await fs.writeFile(
		manifest,
		JSON.stringify(
			{
				schema: "CoreforgeCandidateSourceSnapshot",
				engineHead: sourceSha,
				mergeHead: null,
				companionHead: null,
				companionQualification: "excluded-by-user",
				records: sourceBefore.records,
				sourceDigest,
				sourceSnapshotLabel,
				version,
				native: { path: nativeCopy, sha256: nativeInput.sha256 },
				binary: { path: binary, sha256: binaryInput.sha256 },
				producer: {
					runId: artifact.runId,
					runAttempt: artifact.runAttempt,
					effectiveSource: artifact.effectiveSource,
					versions: artifact.versions,
					config: artifact.config,
				},
			},
			null,
			2,
		) + "\n",
		{ mode: 0o600 },
	);
	process.env.CF_QUAL_MANIFEST = manifest;
	process.env.CF_QUAL_SOURCE_MANIFEST = manifest;
	await fs.copyFile(manifest, path.join(output, "source-inputs.json"));
	await receipt(`inputs-${scope}-${mode}`, {
		kind: "verified-inputs",
		sourceSha,
		nativePath: native.path,
		binarySha256: binaryInput.sha256,
		bun: Bun.version,
		artifactManifestSha256: await fingerprint(path.join(checkout, "qualification-inputs.json")),
		environmentKeys: Object.keys(process.env).sort(),
		companionQualification: "excluded-by-user",
	});
	for (const overlay of overlays)
		await receipt(`effective-${scope}-${path.basename(overlay.sourcePath)}`, {
			kind: "producer-generated-source-overlay",
			verifyVersion: artifact.config.VERIFY_VERSION,
			...overlay,
		});
	await receipt(`source-before-${scope}-${mode}`, {
		kind: "observed-tracked-source",
		sourceSnapshotLabel,
		effectiveSourceDigest: sourceDigest,
		actualSourceDigest: sourceDigest,
		head: sourceBefore.head,
		fileCount: sourceBefore.records.length,
		commands: sourceBefore.commands,
		matchedProducer: true,
	});
	await run(
		[
			process.execPath,
			"--no-env-file",
			path.join(checkout, "scripts/qualification", scope!, "run.ts"),
			"--mode",
			mode!,
		],
		{ cwd: checkout, timeoutMs: 90 * 60_000 },
	);
	if (scope === "domains") await runTitleDatabases(mode!);
	passed = true;
} finally {
	try {
		const sourceAfter = await observeTrackedSource();
		const actualSourceDigestAfter = sha256(JSON.stringify(sourceAfter.records));
		const sourceUnchanged = sourceAfter.head === sourceSha && actualSourceDigestAfter === sourceDigest;
		await fs.writeFile(
			path.join(output, `source-audit-${scope}-${mode}.json`),
			JSON.stringify(
				{
					schema: "CoreforgeObservedTrackedSourceAudit",
					sourceSha,
					sourceSnapshotLabel,
					effectiveSourceDigest: effectiveSource.trackedFilesSha256,
					actualSourceDigestBefore: sourceDigest,
					actualSourceDigestAfter,
					sourceUnchanged,
					before: sourceBefore,
					after: sourceAfter,
				},
				null,
				2,
			) + "\n",
			{ mode: 0o600 },
		);
		if (process.env.CF_QUAL_NATIVE_SHA256 && process.env.CF_QUAL_BINARY_SHA256) {
			await receipt(`dispatch-${scope}-${mode}`, {
				kind: "runtime-dispatch",
				scope,
				mode,
				passed: passed && sourceUnchanged,
				sourceSnapshotLabel,
				effectiveSourceDigest: sourceDigest,
				actualSourceDigestAfter,
				sourceUnchanged,
				companionQualification: "excluded-by-user",
				manualVisualInspection: "unmet-parent-inspection-required",
			});
		}
		assert(sourceUnchanged, "Tracked source bytes or HEAD changed during consumer execution");
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}
