import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	releaseBinaries,
	type ReleaseIdentity,
	type ReleaseSmokeReceipt,
	smokeReleaseBinary,
	verifyReleaseSmoke,
} from "./ci-release-smoke";

const identity: ReleaseIdentity = {
	sourceSha: "1234567890abcdef1234567890abcdef12345678",
	releaseTag: "v18.22.2.1",
	runId: "12345",
	runAttempt: "2",
};
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-release-proof-"));
	roots.push(root);
	const assets = path.join(root, "assets");
	const receipts = path.join(root, "receipts");
	await fs.mkdir(assets);
	await fs.mkdir(receipts);
	return { root, assets, receipts };
}

async function completeFixture() {
	const fixturePaths = await fixture();
	for (const [target, name] of Object.entries(releaseBinaries)) {
		const bytes = Buffer.from(`signed final artifact ${target}`);
		await fs.writeFile(path.join(fixturePaths.assets, name), bytes);
		const receipt: ReleaseSmokeReceipt = {
			schemaVersion: 1,
			...identity,
			target: target as keyof typeof releaseBinaries,
			binary: { name, size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") },
			version: "coreforge/18.22.2.1",
			smokePassed: true,
		};
		await fs.writeFile(path.join(fixturePaths.receipts, `${target}.json`), JSON.stringify(receipt));
	}
	return fixturePaths;
}

async function changeReceipt(directory: string, patch: Record<string, unknown>) {
	const file = path.join(directory, "linux-x64.json");
	const receipt = JSON.parse(await fs.readFile(file, "utf8"));
	await fs.writeFile(file, JSON.stringify({ ...receipt, ...patch }));
}

describe("release publication integrity", () => {
	test("accepts the exact complete final artifact set", async () => {
		const { assets, receipts } = await completeFixture();
		const proof = await verifyReleaseSmoke(assets, receipts, identity);
		expect(proof.map(row => row.target).sort()).toEqual(
			(Object.keys(releaseBinaries) as (keyof typeof releaseBinaries)[]).sort(),
		);
	});

	test("rejects replacing a smoke-tested binary before publication", async () => {
		const { assets, receipts } = await completeFixture();
		await fs.writeFile(path.join(assets, "omp-linux-x64"), "replacement binary");
		await expect(verifyReleaseSmoke(assets, receipts, identity)).rejects.toThrow("Published bytes differ");
	});

	test("preserves successful producer receipts when only publication is retried", async () => {
		const { assets, receipts } = await completeFixture();
		await changeReceipt(receipts, { runAttempt: "1" });
		const proof = await verifyReleaseSmoke(assets, receipts, identity);
		expect(proof.find(receipt => receipt.target === "linux-x64")?.runAttempt).toBe("1");
	});

	test("rejects receipts from another workflow run", async () => {
		const { assets, receipts } = await completeFixture();
		await changeReceipt(receipts, { runId: "12344" });
		await expect(verifyReleaseSmoke(assets, receipts, identity)).rejects.toThrow("runId mismatch");
	});

	for (const runAttempt of ["3", "0", "-1", "01", "1.5", "1\n", 1]) {
		test(`rejects invalid or future producer attempt ${JSON.stringify(runAttempt)}`, async () => {
			const { assets, receipts } = await completeFixture();
			await changeReceipt(receipts, { runAttempt });
			await expect(verifyReleaseSmoke(assets, receipts, identity)).rejects.toThrow("producer runAttempt");
		});
	}

	test("rejects a failed smoke even when the artifact hashes match", async () => {
		const { assets, receipts } = await completeFixture();
		await changeReceipt(receipts, { smokePassed: false });
		await expect(verifyReleaseSmoke(assets, receipts, identity)).rejects.toThrow("Release smoke failed");
	});

	test("rejects an incomplete target set", async () => {
		const { assets, receipts } = await completeFixture();
		await fs.unlink(path.join(receipts, "win32-arm64.json"));
		await expect(verifyReleaseSmoke(assets, receipts, identity)).rejects.toThrow("exactly all eight targets");
	});
});

describe.skipIf(process.platform === "win32")("real release smoke invocation", () => {
	const target = `${process.platform}-${process.arch}` as keyof typeof releaseBinaries;

	test("runs the version and smoke commands and records the bytes actually exercised", async () => {
		const { root, assets } = await fixture();
		const marker = path.join(root, "smoke-ran");
		const file = path.join(assets, releaseBinaries[target]);
		await fs.writeFile(
			file,
			`#!/bin/sh\ncase "$1" in\n--version) printf 'coreforge/18.22.2.1\\n';;\n--smoke-test) printf smoke > ${JSON.stringify(marker)};;\n*) exit 19;;\nesac\n`,
			{ mode: 0o755 },
		);
		const receipt = await smokeReleaseBinary(target, assets, identity);
		expect(await fs.readFile(marker, "utf8")).toBe("smoke");
		expect(receipt.binary.sha256).toBe(new Bun.CryptoHasher("sha256").update(await fs.readFile(file)).digest("hex"));
		expect(receipt.version).toBe("coreforge/18.22.2.1");
	});

	test("rejects a stale embedded version before smoke", async () => {
		const { root, assets } = await fixture();
		const marker = path.join(root, "must-not-run");
		await fs.writeFile(
			path.join(assets, releaseBinaries[target]),
			`#!/bin/sh\ncase "$1" in\n--version) printf 'coreforge/18.22.2.0\\n';;\n--smoke-test) printf wrong > ${JSON.stringify(marker)};;\nesac\n`,
			{ mode: 0o755 },
		);
		await expect(smokeReleaseBinary(target, assets, identity)).rejects.toThrow("Expected release version");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test("retains an actual failing smoke command as failure", async () => {
		const { assets } = await fixture();
		await fs.writeFile(
			path.join(assets, releaseBinaries[target]),
			"#!/bin/sh\ncase \"$1\" in\n--version) printf 'coreforge/18.22.2.1\\n';;\n--smoke-test) exit 17;;\nesac\n",
			{ mode: 0o755 },
		);
		await expect(smokeReleaseBinary(target, assets, identity)).rejects.toThrow("failed (17)");
	});
});

describe.skipIf(process.platform === "win32")("published native verification", () => {
	async function runVerification(corruptArchive: boolean, missingNativeChecksum = false) {
		const { root, assets } = await fixture();
		const packageDirectory = path.join(root, "package");
		const tools = path.join(root, "tools");
		const work = path.join(root, "work");
		await Promise.all([fs.mkdir(packageDirectory), fs.mkdir(tools), fs.mkdir(work)]);
		const native = path.join(packageDirectory, "pi_natives.darwin-arm64.node");
		const archive = path.join(assets, `coreforge-pi-natives-darwin-arm64-${identity.releaseTag}.tgz`);
		const binary = path.join(assets, "omp-darwin-arm64");
		const tar = Bun.which("tar");
		if (!tar) throw new Error("Published native verification regression requires tar");
		async function packNative() {
			const child = Bun.spawn([tar!, "-czf", archive, "-C", root, "package"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			if (status !== 0) throw new Error(`Cannot create native fixture: ${stderr}`);
		}
		await fs.writeFile(native, "synthetic native fixture");
		await fs.writeFile(binary, "synthetic binary fixture");
		await packNative();
		const lines = await Promise.all(
			[binary, archive].map(async file => {
				const hash = new Bun.CryptoHasher("sha256").update(await fs.readFile(file)).digest("hex");
				return `${hash}  ${path.basename(file)}\n`;
			}),
		);
		await fs.writeFile(
			path.join(assets, "SHA256SUMS.txt"),
			(missingNativeChecksum ? [lines[0], lines[0]] : lines).join(""),
		);
		if (corruptArchive) {
			await fs.writeFile(native, "different valid archive with an unverified native payload");
			await packNative();
		}
		const loadMarker = path.join(root, "native-loaded");
		const extractMarker = path.join(root, "native-extracted");
		await fs.writeFile(
			path.join(tools, "gh"),
			`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = --pattern ]; then\nshift\ncp "$FIXTURE_ASSETS/$1" .\nexit $?\nfi\nshift\ndone\nexit 19\n`,
			{ mode: 0o755 },
		);
		await fs.writeFile(path.join(tools, "node"), '#!/bin/sh\nprintf loaded > "$NATIVE_LOAD_MARKER"\n', {
			mode: 0o755,
		});
		await fs.writeFile(
			path.join(tools, "tar"),
			`#!/bin/sh\nprintf extracted > "$NATIVE_EXTRACT_MARKER"\nexec ${JSON.stringify(tar)} "$@"\n`,
			{ mode: 0o755 },
		);
		const workflow = Bun.YAML.parse(
			await Bun.file(new URL("../.github/workflows/cf-release.yml", import.meta.url)).text(),
		) as { jobs: { verify_release: { steps: { name?: string; run?: string }[] } } };
		const steps = workflow.jobs.verify_release.steps;
		const binaryExecution = steps.findIndex(step => step.name === "Verify published macOS arm64 binary");
		if (binaryExecution < 0) throw new Error("Published binary execution step is missing");
		const shell = steps
			.slice(0, binaryExecution)
			.map(step => step.run ?? "")
			.join("\n");
		const child = Bun.spawn(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", shell], {
			cwd: work,
			env: {
				PATH: `${tools}:${process.env.PATH ?? "/usr/bin:/bin"}`,
				HOME: root,
				GITHUB_REPOSITORY: "fixture/repo",
				RELEASE_TAG: identity.releaseTag,
				FIXTURE_ASSETS: assets,
				NATIVE_LOAD_MARKER: loadMarker,
				NATIVE_EXTRACT_MARKER: extractMarker,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [status, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { status, stdout, stderr, loadMarker, extractMarker };
	}

	test("rejects changed downloaded native bytes before extraction or native loading", async () => {
		const { status, loadMarker, extractMarker } = await runVerification(true);
		expect(status).not.toBe(0);
		expect(await Bun.file(extractMarker).exists()).toBe(false);
		expect(await Bun.file(loadMarker).exists()).toBe(false);
	});

	test("rejects a missing native checksum even with two matching checksum lines", async () => {
		const { status, loadMarker, extractMarker } = await runVerification(false, true);
		expect(status).not.toBe(0);
		expect(await Bun.file(extractMarker).exists()).toBe(false);
		expect(await Bun.file(loadMarker).exists()).toBe(false);
	});

	test("extracts and loads the native addon after both published checksums pass", async () => {
		const { status, stderr, loadMarker, extractMarker } = await runVerification(false);
		expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
		expect(await fs.readFile(extractMarker, "utf8")).toBe("extracted");
		expect(await fs.readFile(loadMarker, "utf8")).toBe("loaded");
	});
});
