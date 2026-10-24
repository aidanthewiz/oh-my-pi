/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/3031
 *
 * Mnemopi's local embedding provider used to `import("onnxruntime-node")` and
 * `import("fastembed")` directly inside `fastembed-runtime.ts`. With
 * `memory.backend: mnemopi` enabled on Windows that crashed Bun in two ways:
 *   - Standalone binary: NAPI `process.dlopen` constructor segfault at
 *     session start, before any prompt rendered.
 *   - NPM install: NAPI finalizer segfault at process teardown.
 *
 * The fix relocates the embeddings stack into a Bun.spawn child process
 * (`__omp_worker_mnemopi_embed`) owned by the machine-shared embedding server;
 * the agent hands `mnemopi.setLocalModelInitializer` a wrapper that round-trips
 * through that server, and the server `SIGKILL`s the child so the destructor
 * never runs in any address space. These tests pin the child's contract so a
 * future refactor cannot quietly re-introduce the crash.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createMnemopiEmbedSubprocess, spawnMnemopiEmbedWorker } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";

describe("issue #3031 — mnemopi embeddings live in an isolated subprocess", () => {
	it("ping/pongs through the spawned worker subprocess and tears it down cleanly", async () => {
		// `smokeTestMnemopiEmbedWorker` is the runtime probe wired into
		// `omp --smoke-test`. Run it in a child Bun process instead of this
		// Bun-test worker: the test runner owns its own IPC channel and can
		// starve nested Bun subprocess IPC on some Bun builds.
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const script =
			'const { smokeTestMnemopiEmbedWorker } = await import("@oh-my-pi/pi-coding-agent/mnemopi/embed-client"); await smokeTestMnemopiEmbedWorker({ timeoutMs: 15000 });';
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(`${stdout}${stderr}`).toBe("");
		expect(exitCode).toBe(0);
	}, 30_000);

	it("surfaces unexpected signal exits so in-flight callers don't await forever", async () => {
		// If the child dies from a signal we did NOT request — SIGSEGV from
		// onnxruntime's NAPI fault (the original Windows shutdown bug, now
		// relocated to the child), an OOM SIGKILL, or an operator `kill -9`
		// — the subprocess wrapper must fault every in-flight request via
		// the `errors` channel. Without this contract a `TinyTitleClient`-
		// style swallow would leave callers waiting forever on `await embed`.
		const sub = createMnemopiEmbedSubprocess();
		try {
			const { promise, resolve } = Promise.withResolvers<Error>();
			sub.errors.add(resolve);
			sub.proc.kill("SIGKILL");
			const err = await promise;
			expect(err.message).toMatch(/signal/i);
		} finally {
			try {
				sub.proc.kill("SIGKILL");
			} catch {}
			await sub.proc.exited;
		}
	}, 15_000);

	it("does not surface intentional terminate() SIGKILLs as worker errors", async () => {
		const worker = spawnMnemopiEmbedWorker();
		let errored = false;
		worker.onError(() => {
			errored = true;
		});
		await worker.terminate();
		expect(errored).toBe(false);
	}, 10_000);
});
