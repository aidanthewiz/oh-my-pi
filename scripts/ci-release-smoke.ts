#!/usr/bin/env bun

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const releaseBinaries = {
	"darwin-arm64": "omp-darwin-arm64",
	"darwin-x64": "omp-darwin-x64",
	"linux-x64": "omp-linux-x64",
	"linux-arm64": "omp-linux-arm64",
	"linux-musl-x64": "omp-linux-musl-x64",
	"linux-musl-arm64": "omp-linux-musl-arm64",
	"win32-x64": "omp-windows-x64.exe",
	"win32-arm64": "omp-windows-arm64.exe",
} as const;

type Target = keyof typeof releaseBinaries;
export interface ReleaseIdentity {
	sourceSha: string;
	releaseTag: string;
	runId: string;
	runAttempt: string;
}
interface BinaryFingerprint {
	name: string;
	size: number;
	sha256: string;
}
export interface ReleaseSmokeReceipt extends ReleaseIdentity {
	schemaVersion: 1;
	target: Target;
	binary: BinaryFingerprint;
	version: string;
	smokePassed: true;
}

// This is the repository's existing pinned musl runtime, not an upstream image tag.
const muslImage = "oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a";

function validateIdentity(identity: ReleaseIdentity): void {
	assert(/^[0-9a-f]{40}$/.test(identity.sourceSha), "Invalid release source SHA");
	assert(/^v\d+\.\d+\.\d+\.[1-9]\d*$/.test(identity.releaseTag), "Invalid Coreforce release tag");
	assert(/^\d+$/.test(identity.runId) && /^[1-9]\d*$/.test(identity.runAttempt), "Missing release run identity");
}

function targetName(target: string): Target {
	assert(Object.hasOwn(releaseBinaries, target), `Unsupported release target: ${target}`);
	return target as Target;
}

async function fingerprint(file: string): Promise<BinaryFingerprint> {
	const stat = await fs.lstat(file);
	assert(stat.isFile() && stat.size > 0, `Missing regular release binary: ${file}`);
	const hash = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
	return { name: path.basename(file), size: stat.size, sha256: hash.digest("hex") };
}

async function run(command: string[], env: Record<string, string>): Promise<string> {
	const child = Bun.spawn(command, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const results = await Promise.allSettled([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	] as const);
	const values = results.map(result => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
	assert.equal(values[0], 0, `${command[0]} ${command.at(-1)} failed (${values[0]}): ${values[2]}`);
	return String(values[1]).trim();
}

export async function smokeReleaseBinary(
	targetValue: string,
	assetsDirectory: string,
	identity: ReleaseIdentity,
): Promise<ReleaseSmokeReceipt> {
	validateIdentity(identity);
	const target = targetName(targetValue);
	const arch = target.endsWith("arm64") ? "arm64" : "x64";
	assert.equal(process.arch, arch, `Release smoke requires a native ${arch} runner`);
	assert.equal(process.platform, target.split("-")[0], "Release smoke runner platform mismatch");
	const file = path.resolve(assetsDirectory, releaseBinaries[target]);
	const before = await fingerprint(file);
	if (process.platform !== "win32") await fs.chmod(file, 0o755);
	const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "cf-release-smoke-"));
	try {
		for (const directory of ["home", "data", "tmp"]) await fs.mkdir(path.join(runtime, directory), { mode: 0o700 });
		const env = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: path.join(runtime, "home"),
			USERPROFILE: path.join(runtime, "home"),
			LOCALAPPDATA: path.join(runtime, "data"),
			XDG_DATA_HOME: path.join(runtime, "data"),
			TMPDIR: path.join(runtime, "tmp"),
			TMP: path.join(runtime, "tmp"),
			TEMP: path.join(runtime, "tmp"),
			LANG: "C",
			LC_ALL: "C",
			TZ: "UTC",
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		};
		const command = target.startsWith("linux-musl-")
			? [
					"docker",
					"run",
					"--rm",
					"--network=none",
					"--read-only",
					"--cap-drop=ALL",
					"--security-opt=no-new-privileges",
					"--user",
					`${process.getuid!()}:${process.getgid!()}`,
					"--mount",
					`type=bind,source=${path.dirname(file)},target=/release,readonly`,
					"--mount",
					`type=bind,source=${runtime},target=/runtime`,
					"--env",
					"HOME=/runtime/home",
					"--env",
					"XDG_DATA_HOME=/runtime/data",
					"--env",
					"TMPDIR=/runtime/tmp",
					"--entrypoint",
					`/release/${path.basename(file)}`,
					muslImage,
				]
			: [file];
		const version = await run([...command, "--version"], env);
		assert(
			new RegExp(`^[^/\\s]+/${identity.releaseTag.slice(1).replaceAll(".", "\\.")}$`).test(version),
			`Expected release version ${identity.releaseTag}, received ${JSON.stringify(version)}`,
		);
		await run([...command, "--smoke-test"], env);
		assert.deepEqual(await fingerprint(file), before, "Release binary changed during smoke");
		return { schemaVersion: 1, ...identity, target, binary: before, version, smokePassed: true };
	} finally {
		await fs.rm(runtime, { recursive: true, force: true });
	}
}

export async function verifyReleaseSmoke(
	assetsDirectory: string,
	receiptsDirectory: string,
	identity: ReleaseIdentity,
): Promise<ReleaseSmokeReceipt[]> {
	validateIdentity(identity);
	const targets = Object.keys(releaseBinaries) as Target[];
	assert.deepEqual(
		(await fs.readdir(receiptsDirectory)).sort(),
		targets.map(target => `${target}.json`).sort(),
		"Release smoke receipts must cover exactly all eight targets",
	);
	const receipts: ReleaseSmokeReceipt[] = [];
	for (const target of targets) {
		const file = path.join(receiptsDirectory, `${target}.json`);
		assert((await fs.lstat(file)).isFile(), `Receipt is not a regular file: ${target}`);
		const receipt: ReleaseSmokeReceipt = JSON.parse(await fs.readFile(file, "utf8"));
		assert.equal(receipt.schemaVersion, 1, "Unknown release smoke schema");
		for (const key of ["sourceSha", "releaseTag", "runId", "runAttempt"] as const)
			assert.equal(receipt[key], identity[key], `Release smoke ${key} mismatch: ${target}`);
		assert.equal(receipt.target, target, "Release smoke target mismatch");
		assert.equal(receipt.smokePassed, true, `Release smoke failed: ${target}`);
		assert.equal(receipt.version.split("/").length, 2, `Malformed release version: ${target}`);
		assert.equal(receipt.version.split("/")[1], identity.releaseTag.slice(1), `Release version mismatch: ${target}`);
		assert.deepEqual(
			await fingerprint(path.join(assetsDirectory, releaseBinaries[target])),
			receipt.binary,
			`Published bytes differ from smoke-tested bytes: ${target}`,
		);
		receipts.push(receipt);
	}
	return receipts;
}

if (import.meta.main) {
	const [mode, targetOrAssets, assetsOrReceipts, destination] = process.argv.slice(2);
	const identity: ReleaseIdentity = {
		sourceSha: process.env.SOURCE_SHA ?? "",
		releaseTag: process.env.RELEASE_TAG ?? "",
		runId: process.env.GITHUB_RUN_ID ?? "",
		runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
	};
	if (mode === "smoke" && targetOrAssets && assetsOrReceipts && destination) {
		const receipt = await smokeReleaseBinary(targetOrAssets, assetsOrReceipts, identity);
		await fs.mkdir(destination, { recursive: true });
		await fs.writeFile(path.join(destination, `${receipt.target}.json`), `${JSON.stringify(receipt, null, 2)}\n`, {
			flag: "wx",
		});
	} else if (mode === "verify" && targetOrAssets && assetsOrReceipts && destination) {
		const receipts = await verifyReleaseSmoke(targetOrAssets, assetsOrReceipts, identity);
		await fs.writeFile(destination, `${JSON.stringify({ schemaVersion: 1, ...identity, receipts }, null, 2)}\n`, {
			flag: "wx",
		});
	} else {
		throw new Error(
			"Usage: ci-release-smoke.ts smoke <target> <assets> <receipts> | verify <assets> <receipts> <manifest>",
		);
	}
}
