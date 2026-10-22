/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/9908
 *
 * Every omp process used to spawn its own `__omp_worker_mnemopi_embed` child
 * and keep the embedding model resident for the whole process lifetime
 * (0.8–1.6 GB per session). Embeddings now go through one machine-shared
 * server per (model, cache dir) that exits once idle. Native transport tests
 * use pings and a synthetic child, without loading or downloading a model.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import {
	MnemopiEmbedClient,
	mnemopiEmbedLaunch,
	mnemopiEmbedServerName,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import {
	MNEMOPI_EMBED_CACHE_DIR_ENV,
	MNEMOPI_EMBED_IDLE_MS_ENV,
	MNEMOPI_EMBED_MODEL_ENV,
	MNEMOPI_EMBED_SOCKET_ENV,
	MNEMOPI_EMBED_TAG_ENV,
	type MnemopiEmbedServerRequest,
	type MnemopiEmbedServerResponse,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";
import {
	connectSharedWorker,
	type SharedWorkerLaunch,
	spawnDetached,
	type SpawnedWorker,
} from "@oh-my-pi/pi-coding-agent/subprocess/shared-worker";
import { type RefCountedWorkerHandle, workerEnvFromParent } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";

const MODEL = "fast-bge-small-en-v1.5";

async function request(
	handle: RefCountedWorkerHandle<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse>,
	message: MnemopiEmbedServerRequest,
): Promise<MnemopiEmbedServerResponse> {
	const result = Promise.withResolvers<MnemopiEmbedServerResponse>();
	const unsubscribeMessage = handle.onMessage(response => {
		if (response.id === message.id) result.resolve(response);
	});
	const unsubscribeError = handle.onError(result.reject);
	// Bound a real native connection failure; this is not a scheduling delay.
	const timer = setTimeout(() => result.reject(new Error(`No reply for ${message.id}`)), 5_000);
	try {
		handle.send(message);
		return await result.promise;
	} finally {
		clearTimeout(timer);
		unsubscribeMessage();
		unsubscribeError();
	}
}

describe("issue #9908 — one embedding server per model, freed once idle", () => {
	it("serves every client from a single server process that exits after the idle window", async () => {
		const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-embed-9908-"));
		const spawned: SpawnedWorker[] = [];
		const base = mnemopiEmbedLaunch(MODEL, {
			[MNEMOPI_EMBED_IDLE_MS_ENV]: "1200",
			[MNEMOPI_EMBED_CACHE_DIR_ENV]: path.join(runtimeDir, "cache"),
		});
		const launch: SharedWorkerLaunch = {
			...base,
			async spawn(endpoint, logPath) {
				const worker = await base.spawn(endpoint, logPath);
				spawned.push(worker);
				return worker;
			},
		};
		const name = mnemopiEmbedServerName(MODEL, path.join(runtimeDir, "cache"));
		try {
			const sessionA = await connectSharedWorker<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse>(
				launch,
				runtimeDir,
				name,
			);
			const sessionB = await connectSharedWorker<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse>(
				launch,
				runtimeDir,
				name,
			);
			expect(spawned).toHaveLength(1);

			await sessionA.terminate();
			const server = spawned[0]!;
			// Detached owners need a reference while the test awaits their exit.
			server.proc.ref();
			// The detached server has its own clock; fake timers cannot drive its idle window.
			for (let index = 0; index < 8; index++) {
				await Bun.sleep(250);
				expect(await request(sessionB, { type: "ping", id: `keepalive-${index}` })).toMatchObject({
					type: "pong",
					id: `keepalive-${index}`,
				});
				expect(server.proc.exitCode).toBeNull();
			}
			await sessionB.terminate();
			expect(await server.proc.exited).toBe(0);
			if (process.platform !== "win32") {
				await expect(fs.stat(ipcEndpoint(runtimeDir, name))).rejects.toMatchObject({ code: "ENOENT" });
			}
		} finally {
			for (const worker of spawned) worker.proc.kill();
			await fs.rm(runtimeDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("rejects another model or cache before spawning a child and retains its admitted pair", async () => {
		const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-embed-identity-"));
		const cacheDir = path.join(runtimeDir, "cache");
		const childPidsPath = path.join(runtimeDir, "children.jsonl");
		const host = path.join(runtimeDir, "host.ts");
		await fs.mkdir(cacheDir);
		await fs.writeFile(
			host,
			`import { appendFileSync } from "node:fs";
import { declareWorkerHostEntry } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/worker-host.ts"))};
import { startMnemopiEmbedServerFromEnvironment } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/mnemopi/embed-server.ts"))};
declareWorkerHostEntry();
if (process.argv[2] === "__omp_worker_mnemopi_embed") {
	appendFileSync(${JSON.stringify(childPidsPath)}, JSON.stringify(process.pid) + "\\n");
	process.on("message", async request => {
		if (request.type === "init") process.send({ type: "ready", id: request.id });
		else if (request.type === "embed") {
			// This child has its own clock and must outlive the server's idle window.
			await Bun.sleep(1600);
			process.send({ type: "vectors", id: request.id, vectors: request.texts.map(text => [text.length, process.pid]) });
		}
	});
	await Promise.withResolvers().promise;
} else {
	await startMnemopiEmbedServerFromEnvironment();
}
`,
		);
		const spawned: SpawnedWorker[] = [];
		const launch: SharedWorkerLaunch = {
			label: "synthetic embedding identity",
			tag: "identity-v1",
			async spawn(endpoint, logPath) {
				const worker = spawnDetached(
					[process.execPath, "--no-env-file", host],
					runtimeDir,
					workerEnvFromParent({
						[MNEMOPI_EMBED_SOCKET_ENV]: endpoint,
						[MNEMOPI_EMBED_MODEL_ENV]: MODEL,
						[MNEMOPI_EMBED_CACHE_DIR_ENV]: cacheDir,
						[MNEMOPI_EMBED_TAG_ENV]: "identity-v1",
						[MNEMOPI_EMBED_IDLE_MS_ENV]: "1200",
					}),
					logPath,
				);
				worker.proc.ref();
				spawned.push(worker);
				return worker;
			},
		};
		let session: RefCountedWorkerHandle<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse> | undefined;
		let client: MnemopiEmbedClient | undefined;
		try {
			session = await connectSharedWorker(launch, runtimeDir, mnemopiEmbedServerName(MODEL, cacheDir));
			for (const call of [
				{ type: "embed" as const, id: "wrong-model", model: "another-model", cacheDir, texts: ["denied"] },
				{ type: "init" as const, id: "wrong-cache", model: MODEL, cacheDir: path.join(runtimeDir, "other-cache") },
			]) {
				expect(await request(session, call)).toMatchObject({ type: "error", id: call.id });
				await expect(fs.stat(childPidsPath)).rejects.toMatchObject({ code: "ENOENT" });
			}
			const connection = session;
			client = new MnemopiEmbedClient(() => connection);
			const relativeCache = path.relative(process.cwd(), cacheDir);
			expect(await client.load(MODEL, relativeCache)).toBeUndefined();
			const vectors = await client.embed(MODEL, `${cacheDir}/../cache`, ["owned"], undefined);
			const childPid = JSON.parse((await fs.readFile(childPidsPath, "utf8")).trim()) as number;
			expect(vectors).toEqual([[5, childPid]]);
			expect(childPid).not.toBe(spawned[0]!.proc.pid);
			const closed = Promise.withResolvers<Error>();
			session.onError(closed.resolve);
			session.send({ type: "shutdown", id: "stop" });
			await closed.promise;
			expect(await spawned[0]!.proc.exited).toBe(0);
			expect(() => process.kill(childPid, 0)).toThrow();
		} finally {
			try {
				session?.send({ type: "shutdown", id: "cleanup" });
			} catch {
				// Shutdown already closed this native connection.
			}
			await client?.terminate();
			await session?.terminate();
			await Promise.all(spawned.map(worker => worker.proc.exited));
			await fs.rm(runtimeDir, { recursive: true, force: true });
		}
	}, 30_000);
});
