#!/usr/bin/env bun

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const receipts = path.resolve(Bun.env.QUALIFICATION_RECEIPT_DIR ?? "target/qualification-engine");
const sourceSha = Bun.env.SOURCE_SHA;
const mode = process.argv[2];
const platform = `${process.platform}-${process.arch}`;
const commands: { command: string[]; cwd: string; started: string; exitCode: number; log: string }[] = [];
const configKeys = [
	"RUSTUP_TOOLCHAIN",
	"RUSTC",
	"RUSTDOC",
	"RUSTFLAGS",
	"RUSTDOCFLAGS",
	"CARGO_BUILD_JOBS",
	"CARGO_TARGET_DIR",
	"CARGO_INCREMENTAL",
	"CARGO_PROFILE_DEV_DEBUG",
	"CARGO_PROFILE_TEST_DEBUG",
	"CARGO_PROFILE_DEV_STRIP",
	"CARGO_PROFILE_TEST_STRIP",
	"CARGO_PROFILE_CI_STRIP",
	"CARGO_PROFILE_RELEASE_STRIP",
	"OMP_TEST_CONCURRENCY",
	"OMP_TEST_SHARD",
	"OMP_TEST_TIMEOUT",
	"OMP_TEST_CHUNK_TIMEOUT",
	"RELEASE_TARGETS",
	"VERIFY_VERSION",
	"NATIVE_TARGETS",
	"NATIVE_SOURCE",
	"OMP_NATIVE_CARGO_PROFILE",
	"OMP_BAZEL_RC",
	"HOME",
	"TMPDIR",
	"CARGO_HOME",
	"RUSTUP_HOME",
] as const;
const generatedSources = [
	{
		sourcePath: "packages/coding-agent/src/cli/cf-version.generated.ts",
		artifactPath: "qualification-effective-source/cf-version.generated.ts",
	},
	{
		sourcePath: "packages/stats/src/embedded-client.generated.txt",
		artifactPath: "qualification-effective-source/embedded-client.generated.txt",
	},
] as const;

interface Fingerprint {
	path: string;
	sha256: string;
	size: number;
}
interface InputManifest {
	schemaVersion: number;
	sourceSha: string;
	platform: string;
	runId: string;
	runAttempt: string;
	files: Fingerprint[];
	generatedSources: readonly { sourcePath: string; artifactPath: string }[];
	effectiveSource: Record<string, unknown>;
	versions: Record<string, string>;
	config: Record<string, string | undefined>;
}
interface CargoTarget {
	name: string;
	kind: string[];
	test: boolean;
	doctest: boolean;
	required_features?: string[];
	"required-features"?: string[];
}
interface CargoPackage {
	id: string;
	name: string;
	targets: CargoTarget[];
}
interface CargoMetadata {
	target_directory: string;
	workspace_members: string[];
	packages: CargoPackage[];
}
interface NextestSuite {
	"package-id": string;
	"binary-name": string;
	"binary-path": string;
	kind: string;
	status: string;
	testcases: Record<string, unknown>;
}
interface RetiredRustExecutable {
	path: string;
	size: number;
	dev: number;
	ino: number;
}

function digest(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
async function fingerprint(relative: string): Promise<Fingerprint> {
	assert(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."), `Unsafe input path: ${relative}`);
	const bytes = await Bun.file(path.join(root, relative)).bytes();
	return { path: relative, sha256: digest(bytes), size: bytes.length };
}
async function json(file: string, data: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, `${JSON.stringify(data, null, 2)}\n`);
}
async function capture(command: string[]): Promise<string> {
	const child = Bun.spawn(command, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	assert.equal(code, 0, `${command.join(" ")}: ${stderr}`);
	return stdout.trimEnd();
}
async function identity(): Promise<void> {
	assert(sourceSha && /^[0-9a-f]{40}$/.test(sourceSha), "SOURCE_SHA must be the exact PR head SHA");
	assert.equal(await capture(["git", "rev-parse", "HEAD"]), sourceSha, "Checkout does not match PR head");
	assert(Bun.env.GITHUB_RUN_ID && Bun.env.GITHUB_RUN_ATTEMPT, "Missing hosted workflow run identity");
}
async function versions(): Promise<Record<string, string>> {
	return {
		bun: Bun.version,
		rustc: await capture(["rustc", "--version", "--verbose"]),
		cargo: await capture(["cargo", "--version"]),
		os: await capture(["uname", "-a"]),
		cc: await capture(["cc", "--version"]),
		...(process.platform === "darwin" ? { swiftc: await capture(["swiftc", "--version"]) } : {}),
	};
}
async function snapshot(label: string): Promise<Record<string, unknown>> {
	await identity();
	const tracked = (await capture(["git", "ls-files", "-z"])).split("\0").filter(Boolean).sort();
	const files: (Fingerprint | { path: string; missing: boolean })[] = [];
	for (const file of tracked) {
		try {
			files.push(await fingerprint(file));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") files.push({ path: file, missing: true });
			else throw error;
		}
	}
	if (label === "binary-effective") {
		await fs.mkdir(path.join(root, "qualification-effective-source"), { recursive: true });
		for (const file of generatedSources) {
			await fs.copyFile(path.join(root, file.sourcePath), path.join(root, file.artifactPath));
			const recorded = files.find(row => row.path === file.sourcePath);
			assert(recorded && "sha256" in recorded, `Missing generated source fingerprint: ${file.sourcePath}`);
			assert.equal(
				(await fingerprint(file.artifactPath)).sha256,
				recorded.sha256,
				`Generated resource changed while sealing: ${file.sourcePath}`,
			);
		}
	}
	const config = Object.fromEntries(configKeys.map(key => [key, Bun.env[key]]));
	const result = {
		sourceSha,
		label,
		platform,
		captured: new Date().toISOString(),
		trackedFilesSha256: digest(JSON.stringify(files)),
		files,
		trackedStatus: await capture(["git", "status", "--porcelain", "--untracked-files=no"]),
		config,
		bazelRc: Bun.env.OMP_BAZEL_RC ? await Bun.file(Bun.env.OMP_BAZEL_RC).text() : null,
		capacity: await capture(["df", "-k", root]),
		versions: await versions(),
	};
	await json(path.join(receipts, `${label}.json`), result);
	return result;
}
async function run(command: string[], cwd = root, outputFile?: string): Promise<string> {
	await fs.mkdir(receipts, { recursive: true });
	const log = path.join(receipts, `${mode}-${String(commands.length + 1).padStart(3, "0")}.log`);
	const entry = { command, cwd, started: new Date().toISOString(), exitCode: -1, log };
	commands.push(entry);
	await json(path.join(receipts, `${mode}-commands.json`), commands);
	console.log(`+ (${path.relative(root, cwd) || "."}) ${command.join(" ")}`);
	const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const file = Bun.file(log).writer();
	const chunks: Uint8Array[] = [];
	async function drain(stream: ReadableStream<Uint8Array>, stdout: boolean): Promise<void> {
		for await (const bytes of stream) {
			file.write(bytes);
			if (stdout && outputFile) chunks.push(bytes);
			else (stdout ? process.stdout : process.stderr).write(bytes);
		}
	}
	await Promise.all([drain(child.stdout, true), drain(child.stderr, false)]);
	entry.exitCode = await child.exited;
	await file.end();
	await json(path.join(receipts, `${mode}-commands.json`), commands);
	const output = Buffer.concat(chunks).toString();
	if (outputFile) await Bun.write(path.join(receipts, outputFile), output);
	assert.equal(entry.exitCode, 0, `Command failed; see ${log}: ${command.join(" ")}`);
	return output;
}
export async function retireRustExecutables(
	workspace: string,
	target: string,
	executables: readonly string[],
): Promise<RetiredRustExecutable[]> {
	for (const directory of [workspace, target]) {
		assert(path.isAbsolute(directory), `Absolute Cargo directory required: ${directory}`);
		assert.equal(await fs.realpath(directory), path.resolve(directory), `Ambiguous Cargo directory: ${directory}`);
	}
	assert(target.startsWith(workspace + path.sep), "Cargo target must belong to the qualification workspace");
	assert.equal(executables.length, new Set(executables).size, "Duplicate retired executable");
	const files: RetiredRustExecutable[] = [];
	for (const file of executables) {
		assert(path.isAbsolute(file) && file.startsWith(target + path.sep), `Executable escapes Cargo target: ${file}`);
		assert.equal(await fs.realpath(file), file, `Ambiguous Cargo executable: ${file}`);
		assert(!/\.(?:rlib|rmeta|a|so|dylib|dll|node)(?:\.\d+)*$/i.test(file), `Retain Cargo dependency: ${file}`);
		const stat = await fs.lstat(file);
		assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0, `Not an executable file: ${file}`);
		files.push({ path: file, size: stat.size, dev: stat.dev, ino: stat.ino });
	}
	const uid = process.getuid?.();
	assert(uid !== undefined, "Rust executable retirement requires a Unix qualification runner");
	for (const file of files) {
		const open: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync(
			["lsof", "-a", "-u", String(uid), "-Fpn", "--", file.path],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 10_000,
			},
		);
		assert(
			open.exitCode === 1 && open.stdout.length === 0 && open.stderr.length === 0,
			`Cargo executable is open or closure is unknown: ${file.path}\n${Buffer.from(open.stderr).toString()}`,
		);
	}
	for (const file of files) {
		const current = await fs.lstat(file.path);
		assert(
			current.isFile() && current.dev === file.dev && current.ino === file.ino && current.size === file.size,
			`Cargo executable changed before retirement: ${file.path}`,
		);
		await fs.unlink(file.path);
	}
	return files;
}

async function nativeFiles(): Promise<string[]> {
	return [...new Bun.Glob("packages/natives/native/**/*").scanSync({ cwd: root, onlyFiles: true })].sort();
}
async function makeInputs(target: string): Promise<void> {
	assert.equal(target, platform, "Input artifacts must be produced on their execution platform");
	await identity();
	const native = await nativeFiles();
	const addons = native.filter(file => file.endsWith(".node"));
	assert(addons.length > 0, "Missing packaged native addon");
	const binary = `packages/coding-agent/binaries/omp-${target}`;
	const files = [
		...native,
		binary,
		"LICENSE",
		"THIRD-PARTY-NOTICES.txt",
		"packages/coding-agent/LICENSE",
		"packages/coding-agent/THIRD-PARTY-NOTICES.txt",
		"packages/natives/LICENSE",
		"packages/natives/THIRD-PARTY-NOTICES.txt",
	];
	files.push(...generatedSources.map(file => file.artifactPath));
	const effectiveSource: Record<string, unknown> = {};
	for (const label of ["native-effective", "binary-effective"]) {
		effectiveSource[label] = await Bun.file(path.join(receipts, `${label}.json`)).json();
	}
	effectiveSource["post-build"] = await snapshot("post-build");
	const manifest: InputManifest = {
		schemaVersion: 1,
		sourceSha: sourceSha!,
		platform: target,
		runId: Bun.env.GITHUB_RUN_ID!,
		runAttempt: Bun.env.GITHUB_RUN_ATTEMPT!,
		files: await Promise.all(files.map(fingerprint)),
		effectiveSource,
		generatedSources,
		versions: await versions(),
		config: Object.fromEntries(configKeys.map(key => [key, Bun.env[key]])),
	};
	await json(path.join(root, "qualification-inputs.json"), manifest);
	await json(path.join(receipts, "qualification-inputs.json"), manifest);
}
async function verifyInputs(target: string, sha: string | undefined): Promise<InputManifest> {
	await identity();
	assert.equal(sha, sourceSha, "Requested input identity differs from SOURCE_SHA");
	assert.equal(target, platform, "Artifact platform differs from the executing host");
	const manifest: InputManifest = await Bun.file(path.join(root, "qualification-inputs.json")).json();
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.sourceSha, sourceSha);
	assert.equal(manifest.platform, target);
	assert.equal(manifest.runId, Bun.env.GITHUB_RUN_ID);
	const consumerAttempt = Bun.env.GITHUB_RUN_ATTEMPT!;
	assert(
		/^[1-9]\d*$/.test(consumerAttempt) && consumerAttempt.trim() === consumerAttempt,
		"Invalid qualification consumer runAttempt",
	);
	assert(
		typeof manifest.runAttempt === "string" &&
			/^[1-9]\d*$/.test(manifest.runAttempt) &&
			manifest.runAttempt.trim() === manifest.runAttempt &&
			BigInt(manifest.runAttempt) <= BigInt(consumerAttempt),
		"Invalid or future qualification producer runAttempt",
	);
	assert(
		manifest.effectiveSource["native-effective"] && manifest.effectiveSource["binary-effective"],
		"Missing effective producer input snapshots",
	);
	const required = [`packages/coding-agent/binaries/omp-${target}`, "LICENSE", "THIRD-PARTY-NOTICES.txt"];
	required.push(...generatedSources.map(file => file.artifactPath));
	assert.deepEqual(manifest.generatedSources, generatedSources, "Unexpected generated resource overlay mapping");
	const names = manifest.files.map(file => file.path);
	assert.equal(names.length, new Set(names).size, "Duplicate artifact input");
	for (const name of required) assert(names.includes(name), `Missing artifact input: ${name}`);
	assert(
		names.some(name => name.startsWith("packages/natives/native/") && name.endsWith(".node")),
		"Missing native fingerprint",
	);
	for (const expected of manifest.files)
		assert.deepEqual(await fingerprint(expected.path), expected, `Artifact input changed: ${expected.path}`);
	const binarySource = manifest.effectiveSource["binary-effective"] as { files: Fingerprint[] };
	for (const generated of generatedSources) {
		const source = binarySource.files.find(file => file.path === generated.sourcePath);
		const overlay = manifest.files.find(file => file.path === generated.artifactPath);
		assert(source && overlay, `Missing bound generated resource: ${generated.sourcePath}`);
		assert.equal(
			overlay.sha256,
			source.sha256,
			`Generated resource does not match binary inputs: ${generated.sourcePath}`,
		);
	}
	assert.deepEqual(
		await nativeFiles(),
		names.filter(name => name.startsWith("packages/natives/native/")).sort(),
		"Unmanifested native file",
	);
	await fs.chmod(path.join(root, `packages/coding-agent/binaries/omp-${target}`), 0o755);
	await json(path.join(receipts, "verified-inputs.json"), manifest);
	return manifest;
}
async function packedLicense(): Promise<void> {
	const staging = await fs.mkdtemp(path.join(Bun.env.TMPDIR ?? "/tmp", "engine-pack-"));
	try {
		const consumer = path.join(staging, "consumer");
		const modules = path.join(consumer, "node_modules");
		await fs.cp(path.join(root, "node_modules"), modules, { recursive: true, verbatimSymlinks: true });
		for (const name of ["utils", "ai", "catalog", "tui"]) {
			const source = path.join(root, "packages", name);
			const destination = path.join(modules, "@oh-my-pi", `pi-${name}`);
			await fs.rm(destination, { recursive: true, force: true });
			await fs.cp(source, destination, {
				recursive: true,
				verbatimSymlinks: true,
				filter: file => !path.relative(source, file).split(path.sep).includes("node_modules"),
			});
		}
		const sandbox = (command: string[]): string[] => {
			if (process.platform === "linux")
				return [
					"bwrap",
					"--die-with-parent",
					"--unshare-user",
					"--unshare-pid",
					"--unshare-net",
					"--ro-bind",
					"/",
					"/",
					"--bind",
					staging,
					staging,
					"--tmpfs",
					root,
					"--dev",
					"/dev",
					"--proc",
					"/proc",
					"--chdir",
					consumer,
					"--",
					...command,
				];
			assert.equal(process.platform, "darwin");
			return [
				"/usr/bin/sandbox-exec",
				"-p",
				`(version 1)(allow default)(deny network*)(deny file-read* (subpath ${JSON.stringify(root)}))(deny file-write* (subpath ${JSON.stringify(root)}))`,
				...command,
			];
		};
		const packageProof = [];
		for (const name of ["natives", "coding-agent"]) {
			const destination = path.join(staging, name);
			await fs.mkdir(destination);
			await run(
				[process.execPath, "pm", "pack", "--ignore-scripts", "--destination", destination],
				path.join(root, "packages", name),
			);
			const archives = (await fs.readdir(destination)).filter(file => file.endsWith(".tgz"));
			assert.equal(archives.length, 1);
			const archiveBytes = await Bun.file(path.join(destination, archives[0])).bytes();
			const extracted = path.join(destination, "unpacked");
			await new Bun.Archive(archiveBytes).extract(extracted);
			const installed = path.join(modules, "@oh-my-pi", `pi-${name}`);
			await fs.rm(installed, { recursive: true, force: true });
			await fs.rename(path.join(extracted, "package"), installed);
			for (const legal of ["LICENSE", "THIRD-PARTY-NOTICES.txt"]) {
				assert.equal(
					await Bun.file(path.join(installed, legal)).text(),
					await Bun.file(path.join(root, "packages", name, legal)).text(),
				);
			}
			packageProof.push({
				name,
				archiveSha256: digest(archiveBytes),
				manifest: await Bun.file(path.join(installed, "package.json")).json(),
			});
		}
		await run(
			sandbox([
				process.execPath,
				"--no-env-file",
				"-e",
				'try { await Bun.file(process.argv[1]).text(); process.exit(31); } catch (error) { if (!["EACCES", "EPERM", "ENOENT"].includes(error.code)) throw error; }',
				path.join(root, "package.json"),
			]),
			consumer,
		);
		const output = await run(
			sandbox([
				process.execPath,
				"--no-env-file",
				path.join(modules, "@oh-my-pi/pi-coding-agent/src/cli.ts"),
				"--license",
			]),
			consumer,
			"packed-license.txt",
		);
		const sections = await Promise.all(
			[
				"packages/coding-agent/LICENSE",
				"packages/coding-agent/THIRD-PARTY-NOTICES.txt",
				"packages/natives/THIRD-PARTY-NOTICES.txt",
			].map(async file => (await Bun.file(path.join(root, file)).text()).trimEnd()),
		);
		assert(output.endsWith(`${sections.join("\n\n")}\n`), "Packed CLI omitted required legal sections");
		await json(path.join(receipts, "packed-packages.json"), packageProof);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}
function normalizeLicenseParagraphs(text: string): string {
	return text
		.replaceAll("\r\n", "\n")
		.replace(/\n(?:[ \t]*\n)+/g, "\n\n")
		.trim();
}

async function legal(): Promise<void> {
	const notice = (await Bun.file(path.join(root, "THIRD-PARTY-NOTICES.txt")).text()).replaceAll("\r\n", "\n");
	const normalizedNotice = normalizeLicenseParagraphs(notice);
	for (const file of ["packages/natives/THIRD-PARTY-NOTICES.txt"]) {
		assert.equal(
			(await Bun.file(path.join(root, file)).text()).replaceAll("\r\n", "\n"),
			notice,
			`Notice copy diverged: ${file}`,
		);
	}
	const embedded = await Bun.file(
		path.join(root, "packages/coding-agent/src/tools/browser/relay/extension.generated.json"),
	).json();
	const payload: unknown = embedded.files?.["THIRD-PARTY-NOTICES.txt"];
	const embeddedNotice =
		typeof payload === "string"
			? payload
			: payload && typeof payload === "object" && "base64" in payload && typeof payload.base64 === "string"
				? Buffer.from(payload.base64, "base64").toString("utf8")
				: undefined;
	assert.equal(embeddedNotice?.replaceAll("\r\n", "\n"), notice, "Embedded extension notice missing or diverged");
	const sourceLicenses = [
		"crates/builtins/LICENSE",
		"crates/natives/src/hpatch/LICENSE.HDiffPatch",
		"crates/natives/src/syntaxes/NOTICE",
		"crates/vendor/cranelift-codegen/LICENSE",
		"crates/vendor/cranelift-codegen/COREFORGE-PATCHES.md",
	];
	for (const file of sourceLicenses) {
		assert(
			notice.includes((await Bun.file(path.join(root, file)).text()).replaceAll("\r\n", "\n").trimEnd()),
			`Source license payload missing: ${file}`,
		);
	}
	const targets = [
		"aarch64-apple-darwin",
		"x86_64-apple-darwin",
		"x86_64-unknown-linux-gnu",
		"aarch64-unknown-linux-gnu",
		"x86_64-unknown-linux-musl",
		"aarch64-unknown-linux-musl",
		"x86_64-pc-windows-msvc",
		"aarch64-pc-windows-msvc",
	];
	const union = new Set<string>();
	for (const target of targets) {
		const graph = await run(
			[
				"cargo",
				"tree",
				"--locked",
				"--workspace",
				"--edges",
				"normal,build",
				"--prefix",
				"none",
				"--format",
				"{p}",
				"--target",
				target,
			],
			root,
			`legal-${target}.txt`,
		);
		for (const [, name, version] of graph.matchAll(/^([\w-]+) v(\S+)(?: |$)/gm)) union.add(`${name}@${version}`);
	}
	assert(union.size > 0, "Empty release dependency graph");
	const attributedFile = path.join(receipts, "rust-attribution.json");
	await run([
		"cargo",
		"about",
		"generate",
		"--config",
		"about.toml",
		"--manifest-path",
		"Cargo.toml",
		"--workspace",
		"--locked",
		"--fail",
		...targets.flatMap(target => ["--target", target]),
		"--format",
		"json",
		"--output-file",
		attributedFile,
	]);
	const attribution: { licenses: { text: string; used_by: { crate: { name: string; version: string } }[] }[] } =
		await Bun.file(attributedFile).json();
	const attributed = new Set<string>();
	for (const license of attribution.licenses) {
		const uses = license.used_by.filter(use => union.has(`${use.crate.name}@${use.crate.version}`));
		if (!uses.length) continue;
		assert(
			normalizedNotice.includes(normalizeLicenseParagraphs(license.text)),
			"Current cargo-about license payload missing from notices",
		);
		for (const use of uses) {
			const id = `${use.crate.name}@${use.crate.version}`;
			assert(
				notice.includes(`- ${use.crate.name} ${use.crate.version}`),
				`Missing release crate attribution: ${id}`,
			);
			attributed.add(id);
		}
	}
	assert.deepEqual(
		[...union].filter(id => !attributed.has(id)),
		[],
		"Unattributed release Rust dependencies",
	);
	const lock = createRequire(import.meta.url)("json5").parse(await Bun.file(path.join(root, "bun.lock")).text()) as {
		packages: Record<string, [string, ...unknown[]]>;
	};
	const inventoryStart = notice.indexOf("BUN / NPM DEPENDENCY INVENTORY");
	const inventoryEnd = notice.indexOf("SCOPED NON-PERMISSIVE PACKAGES", inventoryStart);
	assert(inventoryStart >= 0 && inventoryEnd > inventoryStart, "Missing npm notice inventory");
	const npm = new Set(
		[...notice.slice(inventoryStart, inventoryEnd).matchAll(/^- (.+?) (\S+) — (.+)$/gm)].map(
			([, name, version]) => `${name}@${version}`,
		),
	);
	const lockedNpm = new Set<string>();
	for (const [spec] of Object.values(lock.packages)) {
		if (spec.includes("@workspace:")) continue;
		const separator = spec.lastIndexOf("@");
		const id = `${spec.slice(0, separator)}@${spec.slice(separator + 1)}`;
		assert(npm.has(id), `Locked npm dependency missing from notices: ${id}`);
		lockedNpm.add(id);
	}
	const bundledStart = notice.indexOf("BUNDLED/DISTRIBUTED (", inventoryStart);
	const externalStart = notice.indexOf("RUNTIME-EXTERNAL ROOT-LOCK DEPENDENCIES (", bundledStart);
	assert(bundledStart >= 0 && externalStart > bundledStart, "Missing bundled npm classification");
	for (const [, name, version] of notice.slice(bundledStart, externalStart).matchAll(/^- (.+?) (\S+) — (.+)$/gm)) {
		assert(notice.includes(`- ${name}@${version}: `), `Bundled package license payload missing: ${name}@${version}`);
	}
	await json(path.join(receipts, "legal-provenance.json"), {
		sourceSha,
		targets,
		rustUnion: [...union].sort(),
		attributed: [...attributed].sort(),
		lockedNpm: [...lockedNpm].sort(),
		sourceLicenses: await Promise.all(sourceLicenses.map(fingerprint)),
		inputs: await Promise.all(
			["Cargo.toml", "Cargo.lock", "bun.lock", "about.toml", "THIRD-PARTY-NOTICES.txt"].map(fingerprint),
		),
	});
}

function validateTypescriptShard(): void {
	if (mode === "typescript-tests") {
		const shard = Bun.env.OMP_TEST_SHARD;
		assert(
			shard === "1/3" || shard === "2/3" || shard === "3/3",
			"typescript-tests requires OMP_TEST_SHARD to be exactly 1/3, 2/3, or 3/3",
		);
	} else if (mode === "typescript" || mode === "typescript-smoke") {
		assert.equal(Bun.env.OMP_TEST_SHARD, undefined, `${mode} requires OMP_TEST_SHARD to be unset`);
	}
}

async function typescript(partition: "typescript" | "typescript-tests" | "typescript-smoke"): Promise<void> {
	if (partition === "typescript") await run(["bun", "run", "ci:check:full"]);
	if (partition !== "typescript-smoke") await run(["bun", "run", "ci:test:ts"]);
	if (partition === "typescript-tests") return;
	await run(["bun", "run", "ci:test:smoke"]);
	const binary = path.join(root, `packages/coding-agent/binaries/omp-${platform}`);
	for (const args of [["--version"], ["--help"], ["stats", "--help"], ["--smoke-test"], ["--license"]])
		await run([binary, ...args]);
	await packedLicense();
}
async function rust(): Promise<void> {
	if (process.platform === "linux") await legal();
	const metadata: CargoMetadata = JSON.parse(
		await run(["cargo", "metadata", "--locked", "--no-deps", "--format-version=1"], root, "cargo-metadata.json"),
	);
	const packages = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
	assert.equal(packages.length, metadata.workspace_members.length, "Incomplete workspace metadata");
	const targets = packages.flatMap(pkg =>
		pkg.targets.filter(target => target.test).map(target => ({ package: pkg.name, packageId: pkg.id, ...target })),
	);
	assert(targets.length > 0, "No declared workspace test targets");
	const testFlags = ["--locked", "--profile", "ci"];
	const retired: { label: string; files: Awaited<ReturnType<typeof retireRustExecutables>>; capacity: string }[] = [];
	const retire = async (label: string, executables: string[]) => {
		const files = await retireRustExecutables(root, metadata.target_directory, executables);
		retired.push({ label, files, capacity: await capture(["df", "-k", metadata.target_directory]) });
		await json(path.join(receipts, "rust-retired-executables.json"), retired);
	};
	await run(["cargo", "fmt", "--all", "--", "--check"]);
	await run(["bun", "scripts/run-rs-task.ts", "lint:rs"]);
	for (const pkg of packages) {
		for (const example of pkg.targets.filter(target => target.kind.includes("example"))) {
			const required = example["required-features"] ?? [];
			const output = await run(
				[
					"cargo",
					"build",
					...testFlags,
					"--package",
					pkg.name,
					"--example",
					example.name,
					...(required.length ? ["--features", required.join(",")] : []),
					"--message-format=json",
				],
				root,
				`example-${pkg.name}-${example.name}.jsonl`,
			);
			const artifacts = output
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line));
			const built = artifacts.filter(
				artifact =>
					artifact.reason === "compiler-artifact" &&
					artifact.package_id === pkg.id &&
					artifact.target.name === example.name &&
					artifact.target.kind.includes("example"),
			);
			assert(built.length > 0, `Missing compiled example: ${pkg.name}/${example.name}`);
			await retire(
				`example-${pkg.name}-${example.name}`,
				built.flatMap(artifact => (artifact.executable ? [artifact.executable] : [])),
			);
		}
	}
	const libKinds = new Set(["lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"]);
	const libraries = targets.filter(target => target.kind.some(kind => libKinds.has(kind)));
	const shards: { label: string; targets: typeof targets; selection: string[] }[] = [];
	if (libraries.length)
		shards.push({ label: "workspace-libraries", targets: libraries, selection: ["--workspace", "--lib"] });
	for (const target of targets.filter(item => !libraries.includes(item))) {
		const flag = target.kind.includes("bin")
			? "--bin"
			: target.kind.includes("test")
				? "--test"
				: target.kind.includes("example")
					? "--example"
					: target.kind.includes("bench")
						? "--bench"
						: undefined;
		assert(flag, `Unmapped declared test target: ${target.package}/${target.name} ${target.kind}`);
		const requiredFeatures = target["required-features"] ?? target.required_features ?? [];
		shards.push({
			label: `${target.package}-${target.kind.join("-")}-${target.name}`,
			targets: [target],
			selection: [
				"--package",
				target.package,
				flag,
				target.name,
				...(requiredFeatures.length ? ["--features", requiredFeatures.join(",")] : []),
			],
		});
	}
	assert.equal(shards.flatMap(shard => shard.targets).length, targets.length, "Incomplete Rust shard coverage");
	await json(path.join(receipts, "rust-target-plan.json"), {
		packages: packages.map(pkg => pkg.name),
		targets,
		shards,
		doctestExclusions: {
			napi: "cargo test --doc overrides doctest=false and includes unsupported N-API examples",
		},
	});
	const completed = [];
	for (const shard of shards) {
		const args = [...testFlags, ...shard.selection];
		const plan = JSON.parse(
			await run(
				["cargo", "nextest", "list", ...args, "--message-format=json"],
				root,
				`${shard.label}-nextest-plan.json`,
			),
		);
		const suites = Object.values(plan["rust-suites"]) as NextestSuite[];
		for (const target of shard.targets) {
			const matches = suites.filter(
				suite =>
					suite["package-id"] === target.packageId &&
					suite["binary-name"] === target.name &&
					(target.kind.includes(suite.kind) ||
						(suite.kind === "lib" && target.kind.some(kind => libKinds.has(kind)))),
			);
			assert.equal(matches.length, 1, `Missing or duplicated declared target: ${target.package}/${target.name}`);
			assert.equal(matches[0].status, "listed", `Target was not listed: ${target.package}/${target.name}`);
		}
		assert.equal(suites.length, shard.targets.length, `Unexpected target in ${shard.label}`);
		await run([
			"cargo",
			"nextest",
			"run",
			...args,
			"--test-threads=2",
			"--status-level=fail",
			"--final-status-level=fail",
			"--no-fail-fast",
			"--no-tests=pass",
		]);
		const log = await Bun.file(commands.at(-1)!.log).text();
		const summary = [...log.matchAll(/Summary[^\n]*?(\d+) tests? run[^\n]*/g)].at(-1);
		if (plan["test-count"] > 0) {
			assert(summary, `Missing nextest execution summary: ${shard.label}`);
			const skipped = Number(summary[0].match(/(\d+) skipped/)?.[1] ?? 0);
			assert.equal(
				Number(summary[1]) + skipped,
				plan["test-count"],
				`Listed cases were not all executed: ${shard.label}`,
			);
		}
		completed.push({ label: shard.label, targets: shard.targets, testCount: plan["test-count"] });
		await json(path.join(receipts, "rust-completed.json"), completed);
		await retire(
			shard.label,
			suites.map(suite => suite["binary-path"]),
		);
	}
	await run(["cargo", "test", ...testFlags, "--doc", "--workspace", "--exclude", "napi", "--", "--test-threads=2"]);
}

if (import.meta.main) {
	let passed = false;
	let failure: string | undefined;
	try {
		validateTypescriptShard();
		await identity();
		if (mode === "snapshot") {
			assert(/^[a-z-]+$/.test(process.argv[3] ?? ""), "Missing snapshot label");
			await snapshot(process.argv[3]);
		} else if (mode === "build-binary") {
			await run(["bun", "run", "ci:release:build-binaries"]);
		} else if (mode === "build-native") {
			assert(process.argv.length > 3, "Missing native build targets");
			await run(["bun", "scripts/bazel-natives.ts", ...process.argv.slice(3)]);
		} else if (mode === "inputs") await makeInputs(process.argv[3]);
		else if (mode === "verify-inputs") await verifyInputs(process.argv[3], process.argv[4]);
		else if (mode === "typescript" || mode === "typescript-tests" || mode === "typescript-smoke" || mode === "rust") {
			await verifyInputs(platform, sourceSha);
			const before = await snapshot("suite-effective");
			if (mode === "rust") await rust();
			else await typescript(mode);
			const after = await snapshot("suite-after");
			assert.deepEqual(after.files, before.files, "Qualification changed tracked source inputs");
			await verifyInputs(platform, sourceSha);
		} else throw new Error(`Unknown engine qualification mode: ${mode}`);
		passed = true;
	} catch (error) {
		failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
		throw error;
	} finally {
		await json(path.join(receipts, `result-${mode ?? "missing"}.json`), {
			sourceSha,
			platform,
			mode,
			passed,
			runId: Bun.env.GITHUB_RUN_ID,
			runAttempt: Bun.env.GITHUB_RUN_ATTEMPT,
			commands,
			error: failure,
		});
	}
}
