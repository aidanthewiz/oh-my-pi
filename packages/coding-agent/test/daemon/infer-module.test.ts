/**
 * The daemon `infer` module against a real isolated daemon and a fake JSONL
 * worker (`test/fixtures/fake-jsonl-worker.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { daemonClient } from "../../src/daemon/client";
import { InferConnection, type InferParams } from "../../src/daemon/modules/infer";
import { type DaemonClient, type DaemonTunnel, GLOBAL_SCOPE, type UnitPolicy } from "../../src/daemon/protocol";
import { IsolatedDaemon, isAlive, waitFor } from "../fixtures/daemon-harness";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures");
const WORKER = path.join(FIXTURES, "fake-jsonl-worker.ts");
const PENDING_REPLY_CLIENT = path.join(FIXTURES, "infer-pending-reply-client.ts");
const PACKAGE_ROOT = path.join(import.meta.dir, "..", "..");
const TEST_TIMEOUT_MS = 60_000;

interface Reply {
	type: string;
	id?: string;
	text?: string;
	step?: number;
	value?: string | null;
	pid?: number;
	error?: string;
}

/** Client end of one infer tunnel: JSONL requests out, every reply recorded in arrival order. */
class InferTunnel {
	readonly replies: Reply[] = [];
	readonly closed: Promise<string | null>;
	readonly #tunnel: DaemonTunnel;

	constructor(tunnel: DaemonTunnel) {
		this.#tunnel = tunnel;
		const { promise, resolve } = Promise.withResolvers<string | null>();
		this.closed = promise;
		const decoder = new TextDecoder();
		let buffered = "";
		tunnel.start(
			chunk => {
				buffered += decoder.decode(chunk, { stream: true });
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline).trim();
					buffered = buffered.slice(newline + 1);
					if (line) this.replies.push(JSON.parse(line) as Reply);
					newline = buffered.indexOf("\n");
				}
			},
			reason => resolve(reason),
		);
	}

	send(request: Record<string, unknown>): void {
		this.#tunnel.send(`${JSON.stringify(request)}\n`);
	}

	repliesFor(id: string): Reply[] {
		return this.replies.filter(reply => reply.id === id);
	}

	/** The terminal (non-`progress`) reply for `id`. */
	final(id: string): Promise<Reply> {
		return waitFor(() => this.repliesFor(id).find(reply => reply.type !== "progress"), `reply ${id}`);
	}

	close(): void {
		this.#tunnel.close();
	}
}

function workerParams(worker: InferParams["worker"]): InferParams {
	return {
		worker,
		label: `fake ${worker} worker`,
		application: process.execPath,
		args: [WORKER],
		cwd: FIXTURES,
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? os.tmpdir() },
	};
}

async function openInfer(
	client: DaemonClient,
	key: string,
	params: InferParams,
	policy?: Partial<UnitPolicy>,
): Promise<{ unitId: string; lease: string }> {
	const { unit, lease } = await client.open({
		kind: "infer",
		scope: GLOBAL_SCOPE,
		key,
		label: params.label,
		params,
		policy,
	});
	return { unitId: unit.id, lease: lease! };
}

async function isListed(client: DaemonClient, unitId: string): Promise<boolean> {
	const { units } = await client.request({ op: "list", kind: "infer" });
	return units.some(unit => unit.id === unitId);
}

describe("daemon infer module", () => {
	let daemon: IsolatedDaemon;
	const tunnels: InferTunnel[] = [];

	beforeEach(async () => {
		daemon = await IsolatedDaemon.create();
	});

	afterEach(async () => {
		for (const tunnel of tunnels.splice(0)) tunnel.close();
		await daemon.dispose();
	});

	/** The isolated daemon of this test, started on first use. */
	async function startDaemon(): Promise<DaemonClient> {
		const client = await daemonClient();
		daemon.track(client.welcome.daemon.pid);
		return client;
	}

	async function attach(client: DaemonClient, unitId: string): Promise<InferTunnel> {
		const tunnel = new InferTunnel(await client.attach(unitId));
		tunnels.push(tunnel);
		return tunnel;
	}

	it(
		"closing an embedding connection kills its last idle child without reporting an unexpected exit",
		async () => {
			await startDaemon();
			const reply = Promise.withResolvers<number>();
			const errors: Error[] = [];
			const connection = new InferConnection<{ type: string; id: string }, Reply>(
				async () => ({ key: "embed:intentional-close", params: workerParams("embed"), policy: { idleMs: 0 } }),
				message => {
					if (message.pid !== undefined) reply.resolve(message.pid);
				},
				error => {
					errors.push(error);
					reply.reject(error);
				},
			);
			try {
				connection.send({ type: "pid", id: "pid" });
				const pid = await reply.promise;
				daemon.track(pid);
				expect(isAlive(pid)).toBe(true);
				await connection.close();
				await waitFor(() => !isAlive(pid), "intentionally released embedding worker to stop");
				expect(errors).toEqual([]);
			} finally {
				await connection.close();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"rejects another embedding model or cache before spawning its admitted worker",
		async () => {
			const client = await startDaemon();
			const params = workerParams("embed");
			const cacheDir = path.join(daemon.dir, "cache");
			params.embedding = { model: "synthetic-model", cacheDir };
			const { unitId } = await openInfer(client, "embed:binding", params);
			const tunnel = await attach(client, unitId);
			for (const request of [
				{ type: "embed", id: "model", model: "other-model", cacheDir },
				{ type: "init", id: "cache", model: "synthetic-model", cacheDir: path.join(daemon.dir, "other") },
			]) {
				tunnel.send(request);
				expect((await tunnel.final(request.id)).error).toContain("model/cache mismatch");
				expect((await client.request({ op: "describe", unit: unitId })).unit.pids).toEqual([]);
			}
			tunnel.send({ type: "embed", id: "admitted", model: "synthetic-model", cacheDir: `${cacheDir}/../cache` });
			expect((await tunnel.final("admitted")).error).not.toContain("model/cache mismatch");
			tunnel.send({ type: "pid", id: "pid" });
			const pid = (await tunnel.final("pid")).pid!;
			daemon.track(pid);
			expect(isAlive(pid)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"shares one embedding child and preserves an in-flight request beyond the last lease's idle window",
		async () => {
			const client = await startDaemon();
			const params = workerParams("embed");
			const first = await openInfer(client, "embed:shared-idle", params, { idleMs: 100 });
			const second = await openInfer(client, "embed:shared-idle", params, { idleMs: 100 });
			expect(second.unitId).toBe(first.unitId);
			const a = await attach(client, first.unitId);
			const b = await attach(client, second.unitId);
			a.send({ type: "pid", id: "a" });
			b.send({ type: "pid", id: "b" });
			const pid = (await a.final("a")).pid!;
			daemon.track(pid);
			expect((await b.final("b")).pid).toBe(pid);
			a.close();
			await client.release(first.lease);
			// The daemon owns this platform-clock timer in another process; fake test clocks cannot advance it.
			await Bun.sleep(150);
			expect(isAlive(pid)).toBe(true);
			b.send({ type: "hold", id: "busy" });
			await waitFor(() => b.repliesFor("busy")[0], "worker to hold the request");
			await client.release(second.lease);
			await Bun.sleep(150);
			expect(isAlive(pid)).toBe(true);
			b.send({ type: "finish", id: "release" });
			await b.final("busy");
			await waitFor(async () => !(await isListed(client, first.unitId)), "embedding child to idle-stop");
			expect(isAlive(pid)).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"routes overlapping replies with identical client ids only to the tunnel that asked",
		async () => {
			const client = await startDaemon();
			const { unitId } = await openInfer(client, "embed:routing", workerParams("embed"));
			const a = await attach(client, unitId);
			const b = await attach(client, unitId);
			// Same client-side id on both tunnels; A's reply comes back after B's.
			a.send({ type: "echo", id: "1", text: "for A", delayMs: 300 });
			b.send({ type: "echo", id: "1", text: "for B", delayMs: 0 });
			expect((await a.final("1")).text).toBe("for A");
			expect((await b.final("1")).text).toBe("for B");
			// The worker answers in order, so a misrouted reply would have arrived before these pongs.
			a.send({ type: "ping", id: "after" });
			b.send({ type: "ping", id: "after" });
			await a.final("after");
			await b.final("after");
			expect(a.replies).toEqual([
				{ type: "text", id: "1", text: "for A" },
				{ type: "pong", id: "after" },
			]);
			expect(b.replies).toEqual([
				{ type: "text", id: "1", text: "for B" },
				{ type: "pong", id: "after" },
			]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"streams `progress` replies to the client before the final reply",
		async () => {
			const client = await startDaemon();
			const { unitId } = await openInfer(client, "tiny:progress", workerParams("tiny"));
			const tunnel = await attach(client, unitId);
			tunnel.send({ type: "steps", id: "load", count: 3 });
			await tunnel.final("load");
			expect(tunnel.repliesFor("load")).toEqual([
				{ type: "progress", id: "load", step: 0 },
				{ type: "progress", id: "load", step: 1 },
				{ type: "progress", id: "load", step: 2 },
				{ type: "text", id: "load", text: "done" },
			]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"fails every in-flight request when a tiny worker dies, then ends the unit",
		async () => {
			const client = await startDaemon();
			const { unitId } = await openInfer(client, "tiny:crash", workerParams("tiny"));
			const a = await attach(client, unitId);
			const b = await attach(client, unitId);
			a.send({ type: "pid", id: "pid" });
			const pid = (await a.final("pid")).pid!;
			daemon.track(pid);
			a.send({ type: "hang", id: "stuck-a" });
			b.send({ type: "hang", id: "stuck-b" });
			await waitFor(() => a.repliesFor("stuck-a")[0], "worker to receive A's request");
			await waitFor(() => b.repliesFor("stuck-b")[0], "worker to receive B's request");

			process.kill(pid, "SIGKILL");

			const failedA = await a.final("stuck-a");
			const failedB = await b.final("stuck-b");
			expect(failedA.type).toBe("error");
			expect(failedA.error).toContain("exited");
			expect(failedB.type).toBe("error");
			await a.closed;
			await b.closed;
			await waitFor(async () => !(await isListed(client, unitId)), "tiny unit to leave the board");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"fails in-flight requests when an embed worker dies and respawns it on the next request",
		async () => {
			const client = await startDaemon();
			const { unitId } = await openInfer(client, "embed:crash", workerParams("embed"));
			const tunnel = await attach(client, unitId);
			tunnel.send({ type: "pid", id: "pid-1" });
			const firstPid = (await tunnel.final("pid-1")).pid!;
			daemon.track(firstPid);
			tunnel.send({ type: "hang", id: "stuck" });
			await waitFor(() => tunnel.repliesFor("stuck")[0], "worker to receive the request");

			process.kill(firstPid, "SIGKILL");

			const failed = await tunnel.final("stuck");
			expect(failed.type).toBe("error");
			tunnel.send({ type: "pid", id: "pid-2" });
			const secondPid = (await tunnel.final("pid-2")).pid!;
			daemon.track(secondPid);
			expect(secondPid).not.toBe(firstPid);
			expect(isAlive(secondPid)).toBe(true);
			expect(await isListed(client, unitId)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"does not stay busy after a tunnel closes mid-request: an idleMs 0 unit stops once unleased",
		async () => {
			const client = await startDaemon();
			const { unitId, lease } = await openInfer(client, "tiny:abandoned", workerParams("tiny"), { idleMs: 0 });
			const tunnel = await attach(client, unitId);
			tunnel.send({ type: "hang", id: "never-answered" });
			await waitFor(() => tunnel.repliesFor("never-answered")[0], "worker to receive the request");
			await client.release(lease);
			// Unleased but busy: the in-flight request holds the unit.
			const { unit } = await client.request({ op: "describe", unit: unitId });
			expect(unit.state).not.toBe("exited");

			tunnel.close();

			await waitFor(async () => !(await isListed(client, unitId)), "abandoned unit to idle-stop");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs the worker with exactly the client-supplied env, not the daemon's",
		async () => {
			const client = await startDaemon();
			const params = workerParams("embed");
			params.env.FAKE_INFER_MARKER = "from-client";
			const { unitId } = await openInfer(client, "embed:env", params);
			const tunnel = await attach(client, unitId);
			tunnel.send({ type: "env", id: "marker", name: "FAKE_INFER_MARKER" });
			tunnel.send({ type: "env", id: "daemon-dir", name: "OMP_DAEMON_DIR" });
			expect((await tunnel.final("marker")).value).toBe("from-client");
			// The daemon itself runs with OMP_DAEMON_DIR set; it must not leak into the worker.
			expect((await tunnel.final("daemon-dir")).value).toBeNull();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"issue #12067: a short-lived client stays alive for its pending reply, then exits on its own",
		async () => {
			// Start the isolated daemon here so the child only connects to it.
			await startDaemon();
			const env: Record<string, string> = {};
			for (const name in process.env) {
				const value = process.env[name];
				if (value !== undefined) env[name] = value;
			}
			env.FAKE_JSONL_WORKER = WORKER;
			const child = Bun.spawn([process.execPath, PENDING_REPLY_CLIENT], {
				cwd: PACKAGE_ROOT,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect({ exitCode, signal: child.signalCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({
					exitCode: 0,
					signal: null,
					stderr: "",
				});
				expect(JSON.parse(stdout.trim())).toEqual({ type: "text", id: "late", text: "reply after delay" });
			} finally {
				clearTimeout(deadline);
				if (child.exitCode === null) child.kill("SIGKILL");
			}
		},
		TEST_TIMEOUT_MS,
	);
});
