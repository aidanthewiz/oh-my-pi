import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { watch } from "node:fs";
import { getHistoryDbPath } from "@oh-my-pi/pi-utils";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");

test("rejects an untrusted prediction method before touching state outside the agent directory", async () => {
	const root = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "omp-predict-ipc-"));
	const agentDir = path.join(root, "agent");
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\omp-predict-test-${process.pid}-${path.basename(root)}`
			: path.join(root, "p.sock");
	const escaped = path.join(root, "escaped");
	await fs.mkdir(agentDir);
	const proc = Bun.spawn(
		[
			process.execPath,
			"-e",
			"import { startTextPredictDaemonFromEnvironment } from './packages/coding-agent/src/predict/daemon.ts'; await startTextPredictDaemonFromEnvironment();",
		],
		{
			cwd: repoRoot,
			env: { ...process.env, OMP_TEXT_PREDICT_SOCKET: endpoint, OMP_TEXT_PREDICT_AGENT_DIR: agentDir },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let readyTimer: NodeJS.Timeout | undefined;
	try {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		const ready = (async () => {
			let output = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) throw new Error(`predictor daemon exited before readiness: ${output}`);
				output += decoder.decode(value, { stream: true });
				if (output.includes("omp text-predict listening on ")) return;
			}
		})();
		await Promise.race([
			ready,
			new Promise<never>((_, reject) => {
				readyTimer = setTimeout(() => reject(new Error("predictor daemon readiness timed out")), 5_000);
			}),
		]);
		const response = await new Promise<{ id: number; ok: boolean; error?: string }>((resolve, reject) => {
			const socket = net.createConnection(endpoint);
			let buffer = "";
			socket.setEncoding("utf8");
			socket.once("connect", () =>
				socket.write(
					`${JSON.stringify({ id: 1, op: "complete", method: process.platform === "win32" ? "..\\..\\escaped" : "../../escaped", before: "x", prefix: "y" })}\n`,
				),
			);
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				socket.destroy();
				resolve(JSON.parse(buffer.slice(0, end)));
			});
			socket.once("error", reject);
		});
		expect(response).toEqual({ id: 1, ok: false, error: "unsupported text prediction method" });
		expect(
			await fs.stat(escaped).then(
				() => true,
				() => false,
			),
		).toBe(false);
	} finally {
		clearTimeout(readyTimer);
		proc.kill();
		await proc.exited;
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("saves the learned history position with the model when shutdown overlaps ingestion", async () => {
	const root = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "omp-predict-save-"));
	const agentDir = path.join(root, "agent");
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\omp-predict-save-${process.pid}-${path.basename(root)}`
			: path.join(root, "p.sock");
	const signal = path.join(root, "observed");
	await fs.mkdir(agentDir);
	const history = new Database(getHistoryDbPath(agentDir));
	history.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT NOT NULL)");
	history.run("INSERT INTO history VALUES (1, 'alpha aardvark')");
	history.close();

	const proc = Bun.spawn(
		[
			process.execPath,
			"-e",
			`
			import { TextPredictor } from "@oh-my-pi/pi-natives";
			import { startTextPredictDaemonFromEnvironment } from "./packages/coding-agent/src/predict/daemon.ts";
			const observe = TextPredictor.prototype.observe;
			let batches = 0;
			TextPredictor.prototype.observe = async function(prompts) {
				await observe.call(this, prompts);
				if (++batches === 2) {
					await Bun.write(process.env.PREDICT_TEST_SIGNAL, "observed");
					await Bun.sleep(2_000);
				}
			};
			await startTextPredictDaemonFromEnvironment();
			`,
		],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				HOME: root,
				OMP_TEXT_PREDICT_SOCKET: endpoint,
				OMP_TEXT_PREDICT_AGENT_DIR: agentDir,
				PREDICT_TEST_SIGNAL: signal,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const send = (id: number, op: string, extra: Record<string, unknown> = {}) =>
		new Promise<{ id: number; ok: boolean }>((resolve, reject) => {
			const socket = net.createConnection(endpoint);
			let buffer = "";
			socket.setEncoding("utf8");
			socket.once("connect", () => socket.write(`${JSON.stringify({ id, op, ...extra })}\n`));
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				socket.destroy();
				resolve(JSON.parse(buffer.slice(0, end)));
			});
			socket.once("error", reject);
			socket.once("close", () => {
				if (!buffer.includes("\n")) reject(new Error(`prediction socket closed before ${op} response`));
			});
		});
	let watcher: ReturnType<typeof watch> | undefined;
	try {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		const ready = (async () => {
			let output = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) throw new Error(`predictor daemon exited before readiness: ${output}`);
				output += decoder.decode(value, { stream: true });
				if (output.includes("omp text-predict listening on ")) return true;
			}
		})();
		expect(await Promise.race([ready, Bun.sleep(5_000).then(() => false)])).toBe(true);
		expect(await send(1, "complete", { method: "ngram", before: "alpha", prefix: "a" })).toMatchObject({
			ok: true,
		});
		const nextHistory = new Database(getHistoryDbPath(agentDir));
		nextHistory.run("INSERT INTO history VALUES (2, 'beta baboon')");
		nextHistory.close();
		const observed = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("second prediction batch was not observed")), 5_000);
			watcher = watch(root, (_event, name) => {
				if (name !== "observed") return;
				clearTimeout(timeout);
				resolve();
			});
		});
		const sync = send(2, "sync");
		void sync.catch(() => {});
		await observed;
		void send(3, "shutdown").catch(() => {});
		expect(await Promise.race([proc.exited, Bun.sleep(8_000).then(() => -1)])).toBe(0);
		const cursor = await Bun.file(path.join(agentDir, "predict", "ngram", "cursor.json")).json();
		expect(cursor).toEqual({ historyId: 2 });
	} finally {
		watcher?.close();
		proc.kill();
		await proc.exited;
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);
