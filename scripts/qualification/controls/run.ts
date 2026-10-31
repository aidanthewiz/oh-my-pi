import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import net from "node:net";
import * as path from "node:path";
import { compileFixture, environment, receipt, required, run, runCompiled } from "../lib.ts";
import { adaptFixture } from "./adapt.ts";
import { fixtures, prerequisites } from "./inventory.ts";

export { fixtures, prerequisites } from "./inventory.ts";

async function reservePort(): Promise<number> {
	const server = net.createServer();
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert(address && typeof address !== "string");
		return address.port;
	} finally {
		if (server.listening)
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
	}
}

function record(value: unknown): Record<string, unknown> {
	assert(value !== null && typeof value === "object" && !Array.isArray(value), "Expected observed JSON object");
	return value as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
	assert(Array.isArray(value), "Expected observed case rows");
	return value.map(record);
}

function labels(value: unknown, key: string): string[] {
	return rows(value).map(row => {
		const label = row[key];
		assert.equal(typeof label, "string");
		return label as string;
	});
}

function observedReport(stdout: string, id: string): Record<string, unknown> {
	const fixture = fixtures.find(row => row.id === id)!;
	const starts = [0, ...[...stdout.matchAll(/\n(?=\{)/g)].map(match => match.index! + 1)];
	for (const at of starts.reverse()) {
		try {
			const parsed = record(JSON.parse(stdout.slice(at)));
			if (
				id === "browser"
					? parsed.proof === "post95-v18122-r1-browser-runtime"
					: parsed.schema === ("schema" in fixture ? fixture.schema : "")
			)
				return parsed;
		} catch {
			/* Commands can emit diagnostics before the final JSON document. */
		}
	}
	throw new Error(`Missing actual ${id} behavior report`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	assert(argv.length === 2 && argv[0] === "--mode" && ["source", "compiled"].includes(argv[1]!));
	const mode = argv[1]!;
	assert.equal(required("CF_QUAL_SYNTHETIC_ONLY"), "1", "Explicit synthetic-only admission is required");
	const checkout = await fs.realpath(required("CF_QUAL_CHECKOUT"));
	const work = await fs.realpath(required("CF_QUAL_WORK"));
	assert(
		path.isAbsolute(checkout) && path.isAbsolute(work) && work !== checkout && !work.startsWith(checkout + path.sep),
	);
	assert.match(required("CF_QUAL_SOURCE_SHA"), /^[a-f0-9]{40}$/);
	assert.match(required("CF_QUAL_NATIVE_SHA256"), /^[a-f0-9]{64}$/);
	const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	const manifestBytes = await fs.readFile(required("CF_QUAL_MANIFEST"));
	const manifest = JSON.parse(manifestBytes.toString());
	assert.equal(manifest.schema, "CoreforgeCandidateSourceSnapshot");
	assert.equal(manifest.engineHead, required("CF_QUAL_SOURCE_SHA"));
	assert.equal(manifest.native.sha256, required("CF_QUAL_NATIVE_SHA256"));
	assert.equal(hash(JSON.stringify(manifest.records)), manifest.sourceDigest);
	const nativePath = await fs.realpath(required("CF_QUAL_NATIVE_PATH"));
	assert(nativePath.startsWith(work + path.sep));
	assert.equal(hash(await fs.readFile(nativePath)), manifest.native.sha256);
	const output = await fs.realpath(required("CF_QUAL_OUTPUT"));
	const root = await fs.mkdtemp(path.join(work, `controls-${mode}-`));
	const observations: unknown[] = [];
	let executedCommands = 0;
	let failure: unknown;
	await receipt(`controls-${mode}`, {
		kind: "independent-controls",
		mode,
		complete: false,
		passed: false,
		executed: false,
		inventory: fixtures,
		prerequisites,
	});
	try {
		for (const fixture of fixtures) {
			const variants = "variants" in fixture ? fixture.variants : [""];
			for (const variant of variants) {
				const label = `${fixture.id}${variant ? `-${variant}` : ""}`;
				const dir = path.join(root, label);
				await fs.mkdir(dir, { mode: 0o700 });
				const env = environment(dir);
				for (const target of [env.HOME!, env.TMPDIR!]) await fs.mkdir(target, { recursive: true, mode: 0o700 });
				const owner = JSON.stringify({ id: randomUUID(), pid: process.pid, label, mode });
				await fs.writeFile(path.join(dir, ".owner"), owner, { flag: "wx", mode: 0o600 });
				const localManifest = path.join(dir, "manifest.json");
				await fs.writeFile(localManifest, manifestBytes, { flag: "wx", mode: 0o600 });
				const templateFile = fixture.file + ".txt";
				const raw = await fs.readFile(path.join(import.meta.dirname, "raw", templateFile), "utf8");
				assert.equal(hash(raw), fixture.sha256, `${fixture.id} retained authority changed`);
				const adapted = adaptFixture(fixture.id, raw, checkout);
				const entry = path.join(dir, `fixture.${fixture.file.endsWith(".ts") ? "ts" : "mjs"}`);
				await fs.writeFile(entry, adapted, { flag: "wx", mode: 0o600 });
				const executable = path.join(dir, `consumer-${label}`);
				if (mode === "compiled") await compileFixture(entry, executable);
				const binding = {
					mode,
					version: required("CF_QUAL_VERSION"),
					engineHead: manifest.engineHead,
					mergeHead: manifest.mergeHead,
					sourceManifestCopy: localManifest,
					shippingManifestCopy: localManifest,
					sourceManifestSha256: hash(manifestBytes),
					shippingManifestSha256: hash(manifestBytes),
					sourceDigest: manifest.sourceDigest,
					nativeSha256: manifest.native.sha256,
					shippingBinarySha256: manifest.binary.sha256,
					owner,
					work: dir,
					home: env.HOME,
					engine: checkout,
					variant: "current",
				};
				const bindingFile = path.join(dir, "binding.json");
				let args: string[];
				if (fixture.id === "provider" || fixture.id === "broker") {
					await fs.writeFile(
						bindingFile,
						JSON.stringify({
							schema:
								fixture.id === "provider"
									? "CoreforgePost95V18122ProviderRuntimeBinding"
									: "CoreforgeBrokerRefreshRuntimeBinding",
							...binding,
						}),
						{ flag: "wx", mode: 0o600 },
					);
					args = fixture.id === "provider" ? [bindingFile, mode] : [bindingFile];
				} else if (fixture.id === "browser") {
					const chromium = await fs.realpath(required("CF_QUAL_CHROMIUM"));
					assert(path.isAbsolute(chromium) && !chromium.startsWith(checkout + path.sep));
					const browserOutput = path.join(output, `controls-${mode}-${label}-${path.basename(root)}`);
					await fs.writeFile(
						bindingFile,
						JSON.stringify({
							schema: "CoreforgePost95V18122BrowserRuntimeContext",
							binding,
							work: dir,
							home: env.HOME,
							tmp: env.TMPDIR,
							profile: path.join(dir, "profile"),
							executable: chromium,
							executableSha256: hash(await fs.readFile(chromium)),
							fixturePort: await reservePort(),
							output: browserOutput,
							label,
							owner,
						}),
						{ flag: "wx", mode: 0o600 },
					);
					Object.assign(env, {
						PUPPETEER_EXECUTABLE_PATH: chromium,
						MAC_CHROMIUM_TMPDIR: env.TMPDIR,
						CFFIXED_USER_HOME: env.HOME,
					});
					args = [bindingFile];
				} else if (fixture.id === "auth" || fixture.id === "auth-adjacent")
					args = [localManifest, String(await reservePort()), ...(variant ? [variant] : [])];
				else if (fixture.id === "mcp") args = [localManifest];
				else args = [];
				Object.assign(env, {
					PI_NATIVES_DIR: path.dirname(nativePath),
					CF_REVIEW_RUNTIME_ROOT: work,
					CF_UPSTREAM_CANDIDATE_VERSION: required("CF_QUAL_VERSION"),
					V1890_SOURCE_INPUT_MANIFEST: localManifest,
					V1890_SOURCE_INPUT_SHA256: hash(manifestBytes),
					V1890_NATIVE_SHA256: manifest.native.sha256,
					...(fixture.id === "stream" ? { CF_REVIEW_RELAY_PORT: String(await reservePort()) } : {}),
				});
				const command =
					mode === "compiled" ? [executable, ...args] : [process.execPath, "--no-env-file", entry, ...args];
				const result = await (mode === "compiled" ? runCompiled : run)(command, {
					cwd: dir,
					env,
					timeoutMs: 240_000,
					allowFailure: true,
				});
				executedCommands++;
				const observed = observedReport(result.stdout, fixture.id);
				observations.push({ id: fixture.id, variant, code: result.code, observed });
				await receipt(`controls-${mode}-${label}`, {
					kind: "independent-control",
					mode,
					fixture: fixture.id,
					variant,
					templateFile,
					authoritySha256: fixture.sha256,
					adaptedSha256: hash(adapted),
					executed: true,
					code: result.code,
					observed,
					passed: false,
				});
				assert.equal(result.code, 0, result.stderr || result.stdout);
				let actual: string[];
				if (fixture.id === "provider" || fixture.id === "broker") {
					assert.equal(observed.complete, true);
					assert.equal(observed.consumerInvariantsSatisfied, true);
					assert.equal(observed.cleanupVerified, true);
					actual = labels(observed.observations, "label");
				} else if (fixture.id === "browser") {
					const cleanup = record(observed.cleanup);
					assert.equal(observed.status, "passed");
					assert.equal(cleanup.processExited, true);
					assert.equal(cleanup.privateProfileRemoved, true);
					actual = labels(observed.rows, "id");
				} else if (fixture.id === "auth" || fixture.id === "auth-adjacent") {
					assert.equal(observed.complete, true);
					assert.equal(observed.fixtureRemoved, true);
					assert.equal(observed.unexpectedNetwork, 0);
					assert(
						rows(observed.results).every(row => Object.values(record(row.checks)).every(value => value === true)),
					);
					actual = labels(observed.results, "label");
				} else if (fixture.id === "mcp") {
					assert.equal(observed.complete, true);
					assert.equal(observed.fixtureRemoved, true);
					assert.equal(observed.unexpectedNetwork, 0);
					const checks = record(observed.checks);
					assert(Object.values(checks).every(value => value === true));
					actual = Object.keys(checks);
				} else {
					assert.equal(observed.passed, true);
					assert.equal(observed.cleanupVerified, true);
					assert.equal(observed.fixtureRootRemoved, true);
					assert.equal(observed.compiled, mode === "compiled");
					actual = labels(observed.cases, "id");
				}
				assert.deepEqual(actual, [...fixture.cases], `${label} must preserve every actual case`);
				await receipt(`controls-${mode}-${label}`, {
					kind: "independent-control",
					mode,
					fixture: fixture.id,
					variant,
					templateFile,
					authoritySha256: fixture.sha256,
					adaptedSha256: hash(adapted),
					executed: true,
					code: result.code,
					actual,
					observed,
					passed: true,
				});
			}
		}
	} catch (error) {
		failure = error;
	}
	await receipt(`controls-${mode}`, {
		kind: "independent-controls",
		mode,
		complete: !failure,
		passed: !failure,
		executed: executedCommands > 0,
		executedCommands,
		inventory: fixtures,
		prerequisites,
		observations,
		workspace: root,
		...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}),
	});
	if (failure) throw failure;
}

if (import.meta.main) await main();
