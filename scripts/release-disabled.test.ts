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
	expect(workflow).toContain("Reclaim disk for Windows native cross-build");
	expect(workflow).toContain("if: matrix.target == 'win32-x64'");
	expect(workflow).toContain("sudo rm -rf /usr/local/lib/android /opt/hostedtoolcache/CodeQL");
	for (const target of [
		"darwin-arm64",
		"darwin-x64-baseline",
		"linux-x64-baseline",
		"linux-x64-modern",
		"linux-arm64",
		"win32-x64-baseline",
	]) {
		expect(workflow).toContain(target);
	}
	expect(workflow).toContain(`coreforge-pi-natives-\${{ matrix.target }}-\${RELEASE_TAG}.tgz`);
	expect(workflow).toContain("pattern: native-*");
	expect(workflow).toContain("node -e 'require(\"./package/pi_natives.darwin-arm64.node\")'");
});

test("Coreforce allocates a release tag only after every build succeeds", async () => {
	const workflow = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "cf-release.yml")).text();
	const prepareStart = workflow.indexOf("  prepare:");
	const buildStart = workflow.indexOf("  build:", prepareStart);
	const verifyAssetsStart = workflow.indexOf("  verify_release_assets:", buildStart);
	const releaseStart = workflow.indexOf("  release:", verifyAssetsStart);
	const verifyStart = workflow.indexOf("  verify_release:", releaseStart);
	const prepareJob = workflow.slice(prepareStart, buildStart);
	const buildJob = workflow.slice(buildStart, verifyAssetsStart);
	const releaseJob = workflow.slice(releaseStart, verifyStart);

	expect(prepareStart).toBeGreaterThanOrEqual(0);
	expect(buildStart).toBeGreaterThan(prepareStart);
	expect(verifyAssetsStart).toBeGreaterThan(buildStart);
	expect(releaseStart).toBeGreaterThan(buildStart);
	expect(verifyStart).toBeGreaterThan(releaseStart);
	expect(prepareJob).not.toContain("git push origin");
	expect(prepareJob).toContain("resuming unpublished release tag $TAG");
	expect(buildJob).toContain("uses: actions/upload-artifact@");
	expect(releaseJob).toContain("needs: [prepare, build]");

	const downloadIndex = releaseJob.lastIndexOf("uses: actions/download-artifact@");
	const tagIndex = releaseJob.indexOf("- name: Create immutable release tag");
	const publishIndex = releaseJob.indexOf('gh release create "$RELEASE_TAG"');
	expect(downloadIndex).toBeGreaterThanOrEqual(0);
	expect(tagIndex).toBeGreaterThan(downloadIndex);
	expect(publishIndex).toBeGreaterThan(tagIndex);
	expect(releaseJob).toContain('git push origin "$RELEASE_SHA:refs/tags/$RELEASE_TAG"');
});

test("Coreforce pull requests dry-run release assets without publishing", async () => {
	const workflow = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "cf-release.yml")).text();
	const prepareStart = workflow.indexOf("  prepare:");
	const buildStart = workflow.indexOf("  build:", prepareStart);
	const verifyAssetsStart = workflow.indexOf("  verify_release_assets:", buildStart);
	const releaseStart = workflow.indexOf("  release:", verifyAssetsStart);
	const verifyReleaseStart = workflow.indexOf("  verify_release:", releaseStart);
	const prepareJob = workflow.slice(prepareStart, buildStart);
	const buildJob = workflow.slice(buildStart, verifyAssetsStart);
	const verifyAssetsJob = workflow.slice(verifyAssetsStart, releaseStart);
	const releaseJob = workflow.slice(releaseStart, verifyReleaseStart);

	expect(workflow).toContain("  pull_request:\n    branches:\n      - coreforge");
	expect(workflow).toContain("permissions:\n  contents: read\n  pull-requests: read");
	expect(prepareJob).toContain('if [ "$EVENT_NAME" = "pull_request" ]; then');
	expect(prepareJob).toContain(`echo "release_tag=v\${PKG}.0"`);
	expect(prepareJob).toContain('echo "publish=false"');
	expect(prepareJob).toContain('echo "publish=true"');
	expect(buildJob).toContain("if: needs.prepare.outputs.should_release == 'true'");
	expect(buildJob).toContain("if: github.event_name == 'push'");
	expect(verifyAssetsJob).toContain("needs.prepare.outputs.publish != 'true'");
	expect(verifyAssetsJob).toContain("bun --cwd=packages/browser-relay run build");
	expect(verifyAssetsJob).toContain("test -s packages/browser-relay/dist/coreforge-browser-relay-extension.zip");
	expect(releaseJob).toContain("permissions:\n      contents: write");
	expect(releaseJob).toContain("needs.prepare.outputs.publish == 'true'");
});
