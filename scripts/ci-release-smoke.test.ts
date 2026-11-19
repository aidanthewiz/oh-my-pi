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

	test("rejects receipts from another workflow attempt", async () => {
		const { assets, receipts } = await completeFixture();
		await changeReceipt(receipts, { runAttempt: "1" });
		await expect(verifyReleaseSmoke(assets, receipts, identity)).rejects.toThrow("runAttempt mismatch");
	});

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
