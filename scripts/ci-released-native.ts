#!/usr/bin/env bun

import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

interface Release {
	tagName?: unknown;
	isDraft?: unknown;
}

const NATIVE_INPUT_FILES = new Set([
	".bazelignore",
	".bazelrc",
	".bazelversion",
	"BUILD.bazel",
	"Cargo.lock",
	"Cargo.toml",
	"MODULE.bazel",
	"MODULE.bazel.lock",
	"rust-toolchain.toml",
	"packages/natives/package.json",
	"packages/natives/scripts/build-bindings.ts",
	"packages/natives/scripts/gen-enums.ts",
	"rustfmt.toml",
	"scripts/bazel-natives.ts",
	"scripts/host-detect.ts",
]);

export function isNativeBuildPath(relativePath: string): boolean {
	return (
		NATIVE_INPUT_FILES.has(relativePath) || relativePath.startsWith("bazel/") || relativePath.startsWith("crates/")
	);
}

export function selectLatestCoreforceRelease(packageVersion: string, releases: readonly Release[]): string | undefined {
	const prefix = `v${packageVersion}.`;
	let selected: { roll: number; tag: string } | undefined;
	for (const release of releases) {
		if (release.isDraft === true || typeof release.tagName !== "string" || !release.tagName.startsWith(prefix)) {
			continue;
		}
		const rollText = release.tagName.slice(prefix.length);
		if (!/^[1-9]\d*$/.test(rollText)) continue;
		const roll = Number(rollText);
		if (!Number.isSafeInteger(roll)) continue;
		if (!selected || roll > selected.roll) selected = { roll, tag: release.tagName };
	}
	return selected?.tag;
}

export function expectedChecksum(checksums: string, assetName: string): string {
	const matches = checksums
		.split("\n")
		.map(line => line.match(/^([0-9a-f]{64})  (.+)$/))
		.filter((match): match is RegExpMatchArray => match?.[2] === assetName);
	if (matches.length !== 1) {
		throw new Error(`expected one SHA256SUMS.txt entry for ${assetName}, found ${matches.length}`);
	}
	return matches[0][1];
}

async function run(command: readonly string[], cwd?: string): Promise<string> {
	const child = Bun.spawn(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${command[0]} exited ${exitCode}: ${stderr.trim() || "no error output"}`);
	}
	return stdout;
}

async function detectNativeChanges(base: string, head: string): Promise<void> {
	const output = await run(["git", "diff", "--name-only", "--no-renames", `${base}...${head}`]);
	const changed = output.split("\n").some(relativePath => isNativeBuildPath(relativePath));
	console.log(changed ? "true" : "false");
}

async function resolveRelease(packageVersion: string, releaseListPath: string, optional: boolean): Promise<void> {
	const releases = (await Bun.file(releaseListPath).json()) as Release[];
	const tag = selectLatestCoreforceRelease(packageVersion, releases);
	if (!tag) {
		if (optional) return;
		throw new Error(`no published Coreforce release extends v${packageVersion}`);
	}
	console.log(tag);
}

async function sha256(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(file).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

async function installRelease(
	tag: string,
	target: string,
	destination: string,
	downloadDirectory: string,
): Promise<void> {
	if (!/^v\d+\.\d+\.\d+\.[1-9]\d*$/.test(tag)) throw new Error(`invalid Coreforce release tag: ${tag}`);
	if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(target)) throw new Error(`unsupported native target: ${target}`);

	const assetName = `coreforge-pi-natives-${target}-${tag}.tgz`;
	const assetPath = path.join(downloadDirectory, assetName);
	const checksums = await Bun.file(path.join(downloadDirectory, "SHA256SUMS.txt")).text();
	const expected = expectedChecksum(checksums, assetName);
	const actual = await sha256(assetPath);
	if (actual !== expected) throw new Error(`${assetName} SHA-256 mismatch: expected ${expected}, got ${actual}`);

	const extractDirectory = await mkdtemp(path.join(tmpdir(), "coreforge-native-"));
	try {
		await run(["tar", "-xzf", assetPath, "-C", extractDirectory]);
		const packageDirectory = path.join(extractDirectory, "package");
		const nativeFiles = (await readdir(packageDirectory, { withFileTypes: true }))
			.filter(
				entry => entry.isFile() && entry.name.startsWith(`pi_natives.${target}`) && entry.name.endsWith(".node"),
			)
			.map(entry => entry.name)
			.sort();
		const expectedCount = target === "linux-x64" ? 2 : 1;
		if (nativeFiles.length !== expectedCount) {
			throw new Error(`expected ${expectedCount} ${target} native addon(s), found ${nativeFiles.length}`);
		}

		await mkdir(destination, { recursive: true });
		for (const nativeFile of nativeFiles) {
			await copyFile(path.join(packageDirectory, nativeFile), path.join(destination, nativeFile));
		}
		console.log(`Installed ${nativeFiles.join(", ")} from verified release ${tag}`);
	} finally {
		await rm(extractDirectory, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const [operation, ...args] = process.argv.slice(2);
	if (operation === "changed" && args.length === 2) {
		await detectNativeChanges(args[0], args[1]);
		return;
	}
	if (operation === "resolve" && args.length === 2) {
		await resolveRelease(args[0], args[1], false);
		return;
	}
	if (operation === "resolve-optional" && args.length === 2) {
		await resolveRelease(args[0], args[1], true);
		return;
	}
	if (operation === "install" && args.length === 4) {
		await installRelease(args[0], args[1], args[2], args[3]);
		return;
	}
	throw new Error(
		"usage: ci-released-native.ts changed <base> <head> | resolve <package-version> <release-list.json> | resolve-optional <package-version> <release-list.json> | install <tag> <target> <destination> <download-directory>",
	);
}

if (import.meta.main) await main();
