import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { compileFixture, environment, receipt, required, run, runCompiled } from "../lib.ts";
import { requiredSurfaces, selectVisualCaptures } from "../visual/contract.ts";
import { inside, inventory, materialize, sha256 } from "./materialize.ts";
import type { Domain, Mode } from "./materialize.ts";

type Json = Record<string, any>;
type Capture = { id: string; domain: Domain; file: string; sha256: string; bytes: number; displayed?: string };
const parseLines = (text: string): Json[] =>
	text.split("\n").flatMap(line => {
		try {
			const row = JSON.parse(line);
			return row && typeof row === "object" ? [row] : [];
		} catch {
			return [];
		}
	});
async function json(file: string, data: unknown) {
	await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function loopbackPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address !== "string" && address.port > 1024);
	await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
	return address.port;
}

export function validateObserved(
	spec: (typeof inventory)[number],
	result: Json,
	mode: Mode,
	manifest: Json,
	manifestHash: string,
) {
	assert.equal(result.nativeSha256, manifest.native.sha256);
	if (!("proof" in spec)) {
		assert.equal(result.schema, "CoreforgeFrozen19DomainProof");
		assert.equal(result.domain, "resultDomain" in spec ? spec.resultDomain : spec.id);
		assert.equal(result.complete, true);
		assert.equal(result.passed, true);
		assert.equal(result.mode, mode);
		assert.equal(result.version, manifest.version);
		assert([manifestHash, manifest.sourceDigest].includes(result.sourceDigest));
		assert.equal(result.cleanupVerified, true);
		assert.equal(result.fixtureRootRemoved, true);
		assert.equal(result.paidRequests, 0);
	} else {
		assert.equal(result.proof, spec.proof);
		assert.equal(result.status, "passed");
		assert.equal(result.compiled, mode === "compiled");
		assert.equal(result.sourceInputSha256, manifestHash);
		assert.equal(result.candidateVersion ?? result.version, manifest.version);
		if (spec.id === "title") {
			assert.equal(result.cleanup.complete, true);
			assert.equal(result.cleanup.rootRemoved, true);
			assert.equal(result.cleanup.fetchAttempts, 0);
			assert.equal(result.cleanup.ownedChildren, 0);
			assert.equal(result.cleanup.ownedServers, 0);
			assert.equal(result.observed.filter((row: Json) => row.case === "display").length, 12);
			assert.equal(result.observed.filter((row: Json) => row.case === "byte-boundary").length, 4);
		} else if (spec.id === "sol") {
			assert.equal(result.forbiddenNetworkAttempts, 0);
			assert.equal(result.cleanup.sessionsDisposed, true);
			assert.equal(result.cleanup.providerStatesClosed, true);
			assert.equal(result.cleanup.ownedHomeAndTmpRemoved, true);
			assert.equal(result.cleanup.realChildren, 0);
		} else {
			assert.equal(result.sourceDigest, manifest.sourceDigest);
			assert.equal(result.engineHead, manifest.engineHead);
			assert.equal(result.mergeHead, null);
			assert.equal(result.companionHead, null);
			assert.equal(result.privateRootRemoved, true);
			assert.equal(result.networkAttempts, 0);
			assert.equal(result.paidRequests, 0);
			if (spec.id === "restore") assert(result.loopbackRequests > 0);
			else {
				assert.equal(result.ownedListeners, 0);
				assert.equal(result.ownedWorkers, 0);
			}
		}
	}
	if ("cases" in spec) {
		assert.equal(result.cases.length, spec.cases);
		assert.equal(new Set(result.cases.map((row: Json) => row.id)).size, spec.cases);
		assert(
			result.cases.every(
				(row: Json) =>
					row.status === "passed" || ("proof" in spec && row.evidence && typeof row.evidence === "object"),
			),
		);
	}
}

export async function executeDomains(options: { mode: Mode; domain?: Domain; backend?: string; url?: string }) {
	const { mode, domain, backend, url } = options;
	assert(["source", "compiled"].includes(mode));
	const checkout = required("CF_QUAL_CHECKOUT"),
		privateWork = required("CF_QUAL_WORK"),
		output = required("CF_QUAL_OUTPUT");
	for (const directory of [checkout, privateWork, output]) {
		assert(path.isAbsolute(directory));
		assert.equal(await fs.realpath(directory), directory);
	}
	assert(!inside(checkout, privateWork) && privateWork !== checkout && !inside(privateWork, checkout));
	assert(!inside(checkout, output) && output !== checkout);
	const sourceSha = required("CF_QUAL_SOURCE_SHA"),
		nativeSha256 = required("CF_QUAL_NATIVE_SHA256");
	assert.match(sourceSha, /^[a-f0-9]{40}$/);
	assert.match(nativeSha256, /^[a-f0-9]{64}$/);
	const manifestBytes = await fs.readFile(required("CF_QUAL_MANIFEST")),
		manifest: Json = JSON.parse(manifestBytes.toString());
	const manifestSha256 = sha256(manifestBytes);
	assert.equal(manifest.schema, "CoreforgeCandidateSourceSnapshot");
	assert.equal(manifest.engineHead, sourceSha);
	assert.equal(manifest.companionHead, null);
	assert.equal(manifest.mergeHead, null);
	assert(Array.isArray(manifest.records) && manifest.records.length > 0);
	assert.equal(sha256(JSON.stringify(manifest.records)), manifest.sourceDigest);
	assert.equal(manifest.native.sha256, nativeSha256);
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
	assert.equal(sha256(await fs.readFile(required("CF_QUAL_NATIVE_PATH"))), nativeSha256);
	if (backend) {
		assert.equal(domain, "title");
		assert(["sqlite", "postgres", "mysql", "redis"].includes(backend));
		if (backend !== "sqlite") {
			assert(url, "--url is required for an explicit loopback database fixture");
			const endpoint = new URL(url);
			assert.equal(endpoint.hostname, "127.0.0.1");
			assert.equal(endpoint.protocol, backend === "postgres" ? "postgres:" : backend + ":");
			assert(Number(endpoint.port) > 1024 && Number(endpoint.port) < 65536);
		}
	} else assert.equal(url, undefined);
	const selected = inventory.filter(row => !domain || row.id === domain);
	assert(selected.length > 0);
	const modeOutput = path.join(output, "domains", mode);
	await fs.mkdir(modeOutput, { recursive: true, mode: 0o700 });
	const captures: Capture[] = [],
		observations: Json[] = [];
	try {
		for (const spec of selected) {
			const label = spec.id + (backend ? "-" + backend : "");
			const work = await fs.mkdtemp(path.join(privateWork, "domain-" + label + "-"));
			await fs.chmod(work, 0o700);
			const resultDirectory = path.join(modeOutput, label);
			await fs.mkdir(resultDirectory, { mode: 0o700 });
			const authored = await materialize({ checkout, work });
			const entrypoint = authored.fixtures.find(row => row.id === spec.id)!.entrypoint;
			await json(path.join(resultDirectory, "effective-sources.json"), {
				...authored,
				companionQualification: "excluded",
			});
			const localManifest = path.join(work, "source.json");
			await fs.writeFile(localManifest, manifestBytes, { flag: "wx", mode: 0o600 });
			const env = environment(work);
			for (const key of ["HOME", "TMPDIR"]) {
				assert(env[key] && inside(work, env[key]));
				await fs.mkdir(env[key], { recursive: true, mode: 0o700 });
				await fs.chmod(env[key], 0o700);
			}
			delete env.PI_COMPILED;
			const marker = "cfqual_" + randomUUID().replaceAll("-", "");
			Object.assign(env, {
				CF_QUAL_CHECKOUT: checkout,
				CF19_RUNTIME_ROOT: work,
				CF19_MARKER: marker,
				CF_UPSTREAM_CANDIDATE_VERSION: manifest.version,
				CF_UPSTREAM_ENGINE_HEAD: sourceSha,
				CF_UPSTREAM_MERGE_HEAD: ["accounting", "restore", "approval"].includes(spec.id) ? "null" : "",
				V1890_SOURCE_INPUT_MANIFEST: localManifest,
				V1890_SOURCE_INPUT_SHA256: manifestSha256,
				V1890_NATIVE_SHA256: nativeSha256,
				PI_NO_TITLE: "1",
				...(mode === "compiled" ? { PI_COMPILED: "true" } : {}),
				...(backend ? { TITLE_PROOF_DB_ADAPTER: backend, TITLE_PROOF_DB_URL: url ?? "" } : {}),
			});
			if (spec.id === "restore") env.CF_UPSTREAM_RESTORE_LOOPBACK_PORT = String(await loopbackPort());
			const wrapper = path.join(work, "entry.ts"),
				consumer = path.join(work, `${label}-${mode}-consumer`);
			const cli = path.join(checkout, "packages/coding-agent/src/cli.ts");
			const nativeIndex = path.join(checkout, "packages/natives/native/index.js");
			const nativeState = path.join(checkout, "packages/natives/native/loader-state.js");
			// These generated imports intentionally exercise isolated module-loading and worker-dispatch boundaries.
			await fs.writeFile(
				wrapper,
				`import assert from 'node:assert/strict';import fs from 'node:fs';import{createHash}from'node:crypto';
if(process.argv[2]?.startsWith('__omp_worker_')){const{runCli}=await import(${JSON.stringify(cli)});if(process.env.PI_COMPILED!=='true'&&Bun.isMainThread)await runCli(process.argv.slice(2));}
else{await import(${JSON.stringify(nativeIndex)});const{nativeAddonStatus}=await import(${JSON.stringify(nativeState)});const native=nativeAddonStatus();assert(native&&!native.stale);assert.equal(native.version,${JSON.stringify(manifest.version)});assert.equal(native.packageVersion,${JSON.stringify(manifest.version)});const loaded=fs.realpathSync(native.path);const digest=()=>createHash('sha256').update(fs.readFileSync(loaded)).digest('hex');assert.equal(digest(),${JSON.stringify(nativeSha256)});${mode === "compiled" ? `assert(loaded.startsWith(${JSON.stringify(work + path.sep)}));` : ""}
const module=await import(${JSON.stringify(entrypoint)});${"invoke" in spec ? `console.log(JSON.stringify(await module.${spec.invoke}()));` : ""}
assert.equal(nativeAddonStatus()?.path,native.path);assert.equal(digest(),${JSON.stringify(nativeSha256)});console.log(JSON.stringify({schema:'CoreforgeQualificationDomainCompleted',domain:${JSON.stringify(spec.id)},mode:${JSON.stringify(mode)},nativeSha256:digest(),importedAndReturned:true}));}\n`,
				{ flag: "wx", mode: 0o600 },
			);
			if (mode === "compiled") await compileFixture(wrapper, consumer);
			const execution = await (mode === "compiled"
				? runCompiled([consumer], { cwd: work, env, timeoutMs: 420_000, allowFailure: true })
				: run([process.execPath, "--no-env-file", wrapper], {
						cwd: work,
						env,
						timeoutMs: 420_000,
						allowFailure: true,
					}));
			await fs.writeFile(path.join(resultDirectory, "stdout.log"), execution.stdout, { flag: "wx", mode: 0o600 });
			await fs.writeFile(path.join(resultDirectory, "stderr.log"), execution.stderr, { flag: "wx", mode: 0o600 });
			await json(path.join(resultDirectory, "execution.json"), execution);
			assert.equal(execution.code, 0, execution.stderr || execution.stdout);
			const lines = parseLines(execution.stdout),
				completed = lines.findLast(row => row.schema === "CoreforgeQualificationDomainCompleted");
			assert(completed?.importedAndReturned);
			assert.equal(completed.domain, spec.id);
			assert.equal(completed.mode, mode);
			assert.equal(completed.nativeSha256, nativeSha256);
			const result = lines.findLast(row =>
				"proof" in spec ? row.proof === spec.proof : row.schema === "CoreforgeFrozen19DomainProof",
			);
			assert(result);
			validateObserved(spec, result, mode, manifest, manifestSha256);
			if (backend) {
				const database = result.observed.find((row: Json) => row.case === "actual-database")?.result;
				assert.equal(database?.adapter, backend);
				assert.equal(database.status, "passed");
				assert.equal(database.cleanup.fixtureRemoved, true);
				assert.equal(database.cleanup.clientsClosed, true);
			}
			const artifacts = path.join(resultDirectory, "artifacts");
			await fs.mkdir(artifacts, { mode: 0o700 });
			for (const [index, artifact] of (result.artifacts ?? []).entries()) {
				assert(inside(work, artifact.file));
				assert.equal(await fs.realpath(artifact.file), artifact.file);
				const stat = await fs.lstat(artifact.file);
				assert(stat.isFile() && !stat.isSymbolicLink());
				const bytes = await fs.readFile(artifact.file);
				assert.equal(sha256(bytes), artifact.sha256);
				if (artifact.bytes !== undefined) assert.equal(bytes.length, artifact.bytes);
				const name = path.basename(artifact.file).replaceAll(marker + "-", "");
				const file = path.join(artifacts, index + "-" + name);
				await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
				artifact.originalFile = artifact.file;
				artifact.file = file;
				if (artifact.kind === "ansi" || artifact.kind === "actual-component-ansi")
					captures.push({
						id: spec.id + "/" + name,
						domain: spec.id,
						file,
						sha256: sha256(bytes),
						bytes: bytes.length,
					});
			}
			if (spec.id === "title")
				for (const display of result.observed.filter(
					(row: Json) => row.case === "display" && row.native === false,
				)) {
					assert.equal(typeof display.ansi, "string");
					const bytes = Buffer.from(display.ansi);
					const id = "title/" + display.preset + "-" + display.icons,
						file = path.join(artifacts, display.preset + "-" + display.icons + ".ansi");
					await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
					captures.push({
						id,
						domain: "title",
						file,
						sha256: sha256(bytes),
						bytes: bytes.length,
						displayed: display.grid,
					});
				}
			await json(path.join(resultDirectory, "observed.json"), { ...result, companionQualification: "excluded" });
			observations.push({
				domain: spec.id,
				backend: backend ?? null,
				resultFile: path.join(resultDirectory, "observed.json"),
				mode,
				status: "passed",
			});
		}
		if (!domain && !backend) {
			assert.equal(observations.length, 12);
			const selection = selectVisualCaptures(captures);
			for (const [id, count] of Object.entries(requiredSurfaces))
				assert.equal(selection.captures.filter(row => row.domain === id).length, count);
			await json(path.join(modeOutput, "visual-inputs.json"), {
				schema: "CoreforgeQualificationVisualInputs",
				mode,
				sourceSha,
				nativeSha256,
				manifestSha256,
				...selection,
			});
		}
		await receipt("domains-" + mode + (domain ? "-" + domain : "") + (backend ? "-" + backend : ""), {
			complete: true,
			mode,
			sourceSha,
			nativeSha256,
			manifestSha256,
			observations,
			companionQualification: "excluded",
		});
		return observations;
	} catch (error) {
		await receipt("domains-" + mode + (domain ? "-" + domain : "") + (backend ? "-" + backend : ""), {
			complete: false,
			mode,
			sourceSha,
			nativeSha256,
			manifestSha256,
			observations,
			error: String(error),
			companionQualification: "excluded",
		});
		throw error;
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2),
		values = new Map<string, string>();
	assert(args.length % 2 === 0, "Expected --mode source|compiled [--domain ID] [--backend ADAPTER] [--url URL]");
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i]!,
			value = args[i + 1]!;
		assert(["--mode", "--domain", "--backend", "--url"].includes(key) && !values.has(key));
		values.set(key, value);
	}
	const mode = values.get("--mode");
	assert(mode === "source" || mode === "compiled");
	const domain = values.get("--domain");
	assert(!domain || inventory.some(row => row.id === domain));
	await executeDomains({
		mode,
		domain: domain as Domain | undefined,
		backend: values.get("--backend"),
		url: values.get("--url"),
	});
}
