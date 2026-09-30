import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
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
