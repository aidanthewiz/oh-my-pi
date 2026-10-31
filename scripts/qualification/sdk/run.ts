import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { environment, receipt, required, run } from "../lib.ts";

const [flag, mode, ...extra] = process.argv.slice(2);
assert(
	flag === "--mode" && (mode === "source" || mode === "compiled") && extra.length === 0,
	"usage: run.ts --mode source|compiled",
);
const checkout = await realpath(required("CF_QUAL_CHECKOUT"));
const work = await realpath(required("CF_QUAL_WORK"));
assert(
	!path
		.relative(checkout, work)
		.split(path.sep)
		.every(part => part !== ".."),
	"SDK work must be outside the checkout",
);
await mkdir(path.join(work, `sdk-${mode}`), { mode: 0o700 });
const runtime = path.join(work, `sdk-${mode}`);
const env = environment(runtime);
const digest = async (file: string) =>
	createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
const manifestPath = required("CF_QUAL_MANIFEST");
const manifestHash = await digest(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const binary = await realpath(required("CF_QUAL_BINARY"));
const sourceSha = required("CF_QUAL_SOURCE_SHA");
const nativeSha = required("CF_QUAL_NATIVE_SHA256");
assert.equal(manifest.schema, "CoreforgeCandidateSourceSnapshot");
assert.equal(manifest.engineHead, sourceSha);
assert.equal(manifest.native.sha256, nativeSha);
assert.equal(manifest.version, required("CF_QUAL_VERSION"));
assert.equal(manifest.sourceDigest, createHash("sha256").update(JSON.stringify(manifest.records)).digest("hex"));
const native = path.resolve(checkout, manifest.native.path);
const binaryHash = await digest(binary);
assert.equal(binaryHash, manifest.binary.sha256);
assert.equal(await digest(native), nativeSha);
const result: {
	complete: boolean;
	mode: string;
	binding: unknown;
	commands: unknown[];
	launches: { consumer: string }[];
	error?: string;
} = {
	complete: false,
	mode,
	binding: {
		sourceSha,
		nativeSha,
		native,
		binary,
		binarySha256: binaryHash,
		manifestPath,
		manifestSha256: manifestHash,
		sourceDigest: manifest.sourceDigest,
		version: manifest.version,
	},
	commands: [],
	launches: [],
};
const save = () => receipt(`sdk-${mode}`, result);
async function command(
	id: string,
	argv: string[],
	cwd = checkout,
	extra: Record<string, string> = {},
	timeoutMs = 180_000,
) {
	const started = new Date().toISOString();
	try {
		const observed = await run(argv, {
			cwd,
			env: { ...env, ...extra, CF_QUAL_SDK_CONSUMER: id },
			timeoutMs,
			allowFailure: true,
		});
		result.commands.push({ id, started, cwd, ...observed });
		await save();
		assert.equal(observed.code, 0, `${id}: ${observed.stderr}\n${observed.stdout}`);
		return observed;
	} catch (error) {
		result.error = `${id}: ${String(error)}`;
		await save();
		throw error;
	}
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
try {
	assert.equal((await command("source-head", ["git", "rev-parse", "HEAD"])).stdout.trim(), sourceSha);
	const realBun = process.execPath;
	await command("bun-version", [realBun, "--version"]);
	await command("python-version", ["python3", "--version"]);
	await command("go-version", ["go", "version"]);
	await command("rust-version", ["rustc", "--version"], checkout, { RUSTUP_HOME: required("CF_QUAL_RUSTUP_HOME") });
	await command("cargo-version", ["cargo", "--version"], checkout, { RUSTUP_HOME: required("CF_QUAL_RUSTUP_HOME") });
	await command("race-c-compiler", ["cc", "--version"]);
	await command("process-probe", ["pgrep", "--version"]);
	const bin = path.join(runtime, "bin");
	await mkdir(bin, { mode: 0o700 });
	const launches = path.join(runtime, "engine-launches.jsonl");
	await writeFile(launches, "", { flag: "wx", mode: 0o600 });
	const launcher = path.join(bin, "bun");
	const cli = "packages/coding-agent/src/cli.ts";
	const target = mode === "compiled" ? [binary] : [realBun, path.join(checkout, cli)];
	const launchRecord = JSON.stringify({ mode, sourceSha, nativeSha, binarySha256: binaryHash, argvPrefix: target });
	await writeFile(
		launcher,
		[
			"#!/bin/sh",
			`if [ "$1" = ${quote(cli)} ] || [ "$1" = ${quote(path.join(checkout, cli))} ]; then`,
			"  shift",
			`  printf '%s%s%s\\n' ${quote('{"consumer":"')} "$CF_QUAL_SDK_CONSUMER" ${quote('",' + launchRecord.slice(1))} >> ${quote(launches)}`,
			`  exec ${target.map(quote).join(" ")} "$@"`,
			"fi",
			`exec ${quote(realBun)} "$@"`,
			"",
		].join("\n"),
		{ flag: "wx", mode: 0o700 },
	);
	await chmod(launcher, 0o700);
	Object.assign(env, {
		PATH: `${bin}${path.delimiter}${env.PATH}`,
		CF_QUAL_CHECKOUT: checkout,
		CF_QUAL_MODE: mode,
		CF_QUAL_SDK_RUNTIME: runtime,
		CF_QUAL_REAL_BUN: realBun,
		CF_QUAL_SDK_LAUNCHER: launcher,
		BUN_OPTIONS: "--no-env-file",
		OMP_NO_ENV_FILE: "1",
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONPYCACHEPREFIX: path.join(runtime, "python-cache"),
		PYTHONPATH: path.join(checkout, "sdk/python/omp-rpc/src"),
		PIP_CONFIG_FILE: "/dev/null",
		PIP_DISABLE_PIP_VERSION_CHECK: "1",
		PIP_CACHE_DIR: path.join(runtime, "pip-cache"),
		GOCACHE: path.join(runtime, "go-cache"),
		GOMODCACHE: path.join(runtime, "go-mod"),
		GOPROXY: "https://proxy.golang.org",
		GOSUMDB: "sum.golang.org",
		GOTOOLCHAIN: "local",
		GOTELEMETRY: "off",
		GOMAXPROCS: "2",
		CGO_ENABLED: "1",
		CARGO_HOME: path.join(runtime, "cargo-home"),
		CARGO_TARGET_DIR: path.join(runtime, "cargo-target"),
		CARGO_BUILD_JOBS: "2",
		CARGO_INCREMENTAL: "0",
		CARGO_PROFILE_DEV_DEBUG: "0",
		CARGO_PROFILE_TEST_DEBUG: "0",
		RUSTUP_HOME: required("CF_QUAL_RUSTUP_HOME"),
	});
	await command("python-venv", ["python3", "-m", "venv", path.join(runtime, "venv")]);
	const python = path.join(runtime, "venv/bin/python");
	await command(
		"python-public-dependencies",
		[python, "-m", "pip", "--isolated", "install", "--index-url", "https://pypi.org/simple", "pytest==8.4.2"],
		checkout,
		{},
		600_000,
	);
	await command(
		"python-sdk-tests",
		[python, "-m", "pytest", "-v", "-p", "no:cacheprovider", "sdk/python/omp-rpc/tests"],
		checkout,
		{},
		600_000,
	);
	await command(
		"python-real-consumer",
		[python, path.join(import.meta.dir, "python-consumer.py")],
		checkout,
		{},
		180_000,
	);
	await command(
		"typescript-real-consumer",
		[realBun, path.join(import.meta.dir, "typescript-consumer.ts")],
		checkout,
		{},
		180_000,
	);
	await command(
		"go-sdk-race-and-real-consumers",
		["go", "test", "-count=1", "-p", "2", "-race", "-v", "./..."],
		path.join(checkout, "sdk/go/omp-rpc"),
		{ OMP_RPC_SMOKE: "1" },
		900_000,
	);
	const rust = ["--manifest-path", "sdk/rust/omp-rpc/Cargo.toml", "--locked"];
	await command("rust-public-dependencies", ["cargo", "fetch", ...rust], checkout, {}, 600_000);
	await command("rust-sdk-tests", ["cargo", "test", ...rust], checkout, {}, 900_000);
	await command(
		"rust-real-consumers",
		["cargo", "test", ...rust, "--test", "smoke", "--", "--ignored", "--nocapture", "--test-threads=1"],
		checkout,
		{},
		300_000,
	);
	result.launches = (await readFile(launches, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
	for (const consumer of [
		"python-real-consumer",
		"typescript-real-consumer",
		"go-sdk-race-and-real-consumers",
		"rust-real-consumers",
	]) {
		assert(
			result.launches.some(launch => launch.consumer === consumer),
			`${consumer} did not use the bound engine launcher`,
		);
	}
	assert.equal(await digest(native), nativeSha);
	assert.equal(await digest(binary), binaryHash);
	assert.equal(await digest(manifestPath), manifestHash);
	assert.equal((await command("source-head-after", ["git", "rev-parse", "HEAD"])).stdout.trim(), sourceSha);
	result.complete = true;
} catch (error) {
	result.error = String(error);
	throw error;
} finally {
	const launchLog = await readFile(path.join(runtime, "engine-launches.jsonl"), "utf8").catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return "";
			throw error;
		},
	);
	result.launches = launchLog
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
	await save();
}
