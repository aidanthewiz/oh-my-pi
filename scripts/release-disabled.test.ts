import { expect, test } from "bun:test";
import * as path from "node:path";

test("Coreforce releases build native addons from fork sources", async () => {
	const workflow = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "cf-release.yml")).text();
	const binaryDownloadStart = workflow.indexOf("      - name: Download published macOS arm64 binary");
	const nativeVerifyStart = workflow.indexOf(
		"      - name: Verify published source-install native addon",
		binaryDownloadStart,
	);
	expect(binaryDownloadStart).toBeGreaterThanOrEqual(0);
	expect(nativeVerifyStart).toBeGreaterThan(binaryDownloadStart);
	const binaryDownloadStep = workflow.slice(binaryDownloadStart, nativeVerifyStart);

	expect(workflow).toContain(`bun scripts/bazel-natives.ts "\${targets[@]}"`);
	expect(workflow).not.toContain('npm view "@oh-my-pi/pi-natives-');
	expect(binaryDownloadStep).not.toContain("curl");
	expect(binaryDownloadStep).toContain(`GH_TOKEN: \${{ github.token }}`);
	expect(binaryDownloadStep).toContain('gh release download "$RELEASE_TAG"');
	expect(binaryDownloadStep).toContain('--repo "$GITHUB_REPOSITORY"');
	expect(binaryDownloadStep).toContain('--pattern "omp-darwin-arm64"');
	expect(workflow).toContain("Reclaim disk for large native builds");
	expect(workflow).toContain("if: matrix.target == 'win32-x64' || matrix.target == 'linux-x64'");
	expect(workflow).toContain("sudo rm -rf /usr/local/lib/android /opt/hostedtoolcache/CodeQL");
	expect(workflow).toContain("os: windows-11-arm");
	expect(workflow).toContain("bun scripts/bazel-natives.ts host --dest packages/natives/native");
	expect(workflow).toContain("Smoke binary (Windows ARM64)");
	for (const target of [
		"darwin-arm64",
		"darwin-x64-baseline",
		"linux-x64-baseline",
		"linux-x64-modern",
		"linux-arm64",
		"win32-x64-baseline",
		"win32-arm64",
	]) {
		expect(workflow).toContain(target);
	}
	expect(workflow).toContain(`coreforge-pi-natives-\${{ matrix.target }}-\${RELEASE_TAG}.tgz`);
	expect(workflow).toContain("pattern: native-*");
	expect(workflow).toContain("node -e 'require(\"./package/pi_natives.darwin-arm64.node\")'");
	expect(workflow).toContain("bun scripts/ci-release-checksums.ts release-assets/SHA256SUMS.txt");
	expect(workflow).toContain('--pattern "SHA256SUMS.txt"');
	expect(workflow).toContain("shasum -a 256 -c SHA256SUMS.verify");
});

test("relay image copies only existing root build inputs", async () => {
	const root = path.join(import.meta.dir, "..");
	const dockerfile = await Bun.file(path.join(root, "Dockerfile.relay")).text();
	const rootCopy = dockerfile.split("\n").find(line => line.startsWith("COPY ") && line.endsWith(" ./"));
	expect(rootCopy).toBeDefined();

	const sources = rootCopy?.slice("COPY ".length, -" ./".length).trim().split(/\s+/) ?? [];
	expect(sources.length).toBeGreaterThan(0);
	for (const source of sources) {
		expect(await Bun.file(path.join(root, source)).exists()).toBe(true);
	}
});

test("Coreforce keeps pull request caches reusable across branches", async () => {
	const root = path.join(import.meta.dir, "..");
	const releaseWorkflow = await Bun.file(path.join(root, ".github", "workflows", "cf-release.yml")).text();
	const verifyWorkflow = await Bun.file(path.join(root, ".github", "workflows", "cf-verify.yml")).text();

	const releaseRestoreIndex = releaseWorkflow.indexOf("- name: Restore Bazel native build cache");
	const releaseBuildIndex = releaseWorkflow.indexOf(
		"- name: Build native addon from Coreforge sources",
		releaseRestoreIndex,
	);
	const releaseSaveIndex = releaseWorkflow.indexOf("- name: Save Bazel native build cache", releaseBuildIndex);
	const releasePackageIndex = releaseWorkflow.indexOf("- name: Package source-built native addon", releaseSaveIndex);
	expect(releaseRestoreIndex).toBeGreaterThanOrEqual(0);
	expect(releaseBuildIndex).toBeGreaterThan(releaseRestoreIndex);
	expect(releaseSaveIndex).toBeGreaterThan(releaseBuildIndex);
	expect(releasePackageIndex).toBeGreaterThan(releaseSaveIndex);

	const verifyRestoreIndex = verifyWorkflow.indexOf("- name: Restore Bazel native build cache");
	const verifyBuildIndex = verifyWorkflow.indexOf(
		"- name: Build native addon from Coreforge sources",
		verifyRestoreIndex,
	);
	expect(verifyRestoreIndex).toBeGreaterThanOrEqual(0);
	expect(verifyBuildIndex).toBeGreaterThan(verifyRestoreIndex);
	expect(verifyWorkflow).not.toContain("- name: Save Bazel native build cache");
	expect(verifyWorkflow).not.toContain("coreforge-verify-bazel-");
	expect(verifyWorkflow).toContain("key: coreforge-bazel-v1-");
	expect(verifyWorkflow).toContain("needs.prepare.outputs.native_changed == 'true'");
});

test("Coreforce allocates a release tag only after every build succeeds", async () => {
	const workflow = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "cf-release.yml")).text();
	const prepareStart = workflow.indexOf("  prepare:");
	const buildStart = workflow.indexOf("  build:", prepareStart);
	const releaseStart = workflow.indexOf("  release:", buildStart);
	const verifyStart = workflow.indexOf("  verify_release:", releaseStart);
	const prepareJob = workflow.slice(prepareStart, buildStart);
	const buildJob = workflow.slice(buildStart, releaseStart);
	const releaseJob = workflow.slice(releaseStart, verifyStart);

	expect(prepareStart).toBeGreaterThanOrEqual(0);
	expect(buildStart).toBeGreaterThan(prepareStart);
	expect(releaseStart).toBeGreaterThan(buildStart);
	expect(verifyStart).toBeGreaterThan(releaseStart);
	expect(prepareJob).not.toContain("git push origin");
	expect(prepareJob).toContain("resuming unpublished release tag $TAG");
	expect(buildJob).toContain("uses: actions/upload-artifact@");
	expect(releaseJob).toContain("needs: [prepare, build]");

	const downloadIndex = releaseJob.lastIndexOf("uses: actions/download-artifact@");
	const checksumIndex = releaseJob.indexOf("- name: Generate release checksums");
	const tagIndex = releaseJob.indexOf("- name: Create immutable release tag");
	const publishIndex = releaseJob.indexOf('gh release create "$RELEASE_TAG"');
	expect(downloadIndex).toBeGreaterThanOrEqual(0);
	expect(checksumIndex).toBeGreaterThan(downloadIndex);
	expect(tagIndex).toBeGreaterThan(checksumIndex);
	expect(tagIndex).toBeGreaterThan(downloadIndex);
	expect(publishIndex).toBeGreaterThan(tagIndex);
	expect(releaseJob).toContain('git push origin "$RELEASE_SHA:refs/tags/$RELEASE_TAG"');
});

test("Coreforce pull requests dry-run release assets without write permissions", async () => {
	const releaseWorkflow = await Bun.file(
		path.join(import.meta.dir, "..", ".github", "workflows", "cf-release.yml"),
	).text();
	const verifyWorkflow = await Bun.file(
		path.join(import.meta.dir, "..", ".github", "workflows", "cf-verify.yml"),
	).text();
	const releaseMatrixStart = releaseWorkflow.indexOf("      matrix:\n        include:");
	const releaseMatrixEnd = releaseWorkflow.indexOf("    steps:", releaseMatrixStart);
	const verifyMatrixStart = verifyWorkflow.indexOf("      matrix:\n        include:");
	const verifyMatrixEnd = verifyWorkflow.indexOf("    steps:", verifyMatrixStart);

	expect(releaseMatrixStart).toBeGreaterThanOrEqual(0);
	expect(releaseMatrixEnd).toBeGreaterThan(releaseMatrixStart);
	expect(verifyMatrixStart).toBeGreaterThanOrEqual(0);
	expect(verifyMatrixEnd).toBeGreaterThan(verifyMatrixStart);
	expect(verifyWorkflow.slice(verifyMatrixStart, verifyMatrixEnd)).toBe(
		releaseWorkflow.slice(releaseMatrixStart, releaseMatrixEnd),
	);
	expect(verifyWorkflow).toContain("  pull_request:\n    branches:\n      - coreforge");
	expect(verifyWorkflow).toContain("permissions:\n  contents: read");
	expect(verifyWorkflow).not.toMatch(/^\s+contents: write$/m);
	expect(verifyWorkflow).not.toContain("git push origin");
	expect(verifyWorkflow).not.toContain("gh release create");
	expect(verifyWorkflow).toContain("Detect native source changes");
	expect(verifyWorkflow).toContain("ci-released-native.ts changed");
	expect(verifyWorkflow).toContain("Install verified released native addon");
	expect(verifyWorkflow).toContain("bun scripts/ci-released-native.ts install");
	expect(verifyWorkflow).toContain(`bun scripts/bazel-natives.ts "\${targets[@]}"`);
	expect(verifyWorkflow).toContain("needs.prepare.outputs.native_changed == 'true'");
	expect(verifyWorkflow).toContain("run: bun run ci:release:build-binaries");
	expect(verifyWorkflow).toContain("os: windows-11-arm");
	expect(verifyWorkflow).toContain("bun scripts/bazel-natives.ts host --dest packages/natives/native");
	expect(verifyWorkflow).toContain("Smoke binary (Windows ARM64)");
	expect(releaseWorkflow.slice(0, releaseWorkflow.indexOf("jobs:"))).not.toContain("pull_request:");
	expect(releaseWorkflow).toContain("permissions:\n      contents: write");
});

test("Coreforce workflows use the root packageManager Bun version", async () => {
	const root = path.join(import.meta.dir, "..");
	const manifest = (await Bun.file(path.join(root, "package.json")).json()) as { packageManager?: string };
	const bunVersion = manifest.packageManager?.match(/^bun@(.+)$/)?.[1];
	expect(bunVersion).toBeDefined();

	for (const workflowName of ["cf-release.yml", "cf-verify.yml", "relay.yml"]) {
		const workflow = await Bun.file(path.join(root, ".github", "workflows", workflowName)).text();
		const configuredVersions = [...workflow.matchAll(/bun-version:\s*"([^"]+)"/g)].map(match => match[1]);
		expect(configuredVersions.length).toBeGreaterThan(0);
		expect(configuredVersions.every(version => version === bunVersion)).toBe(true);
	}
});
