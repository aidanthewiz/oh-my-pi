import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { TernError } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { WebKitHost, WebKitUnavailableError } from "@oh-my-pi/pi-coding-agent/tools/browser/webkit/host";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createFakeHost, type FakeHost, isProcessAlive } from "./webkit-fake-host";

let fake: FakeHost | undefined;
let host: WebKitHost | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	await host?.close();
	host = undefined;
	await fake?.remove();
	fake = undefined;
});

describe("WebKitHost", () => {
	it("greets a child process over its standard streams and correlates its answers by id", async () => {
		fake = await createFakeHost();
		host = await WebKitHost.launch(fake.executable);
		// The welcome's ops arrived through stdout: native DOM reads are on for this host.
		expect(host.client.supports("dom")).toBe(true);

		const [first, second, missing] = await Promise.all([
			host.client.request({ op: "echo", value: "one" }),
			host.client.request({ op: "echo", value: { nested: [2] } }),
			host.client.request({ op: "missing", block: 9 }).catch((error: unknown) => error),
		]);
		expect(first).toEqual({ echo: "one" });
		expect(second).toEqual({ echo: { nested: [2] } });
		expect(missing).toBeInstanceOf(TernError);
		expect((missing as TernError).kind).toBe("not_found");
		expect(await fake.requests()).toEqual([
			{ op: "echo", value: "one" },
			{ op: "echo", value: { nested: [2] } },
			{ op: "missing", block: 9 },
		]);

		// Closing ends the host's input, which is how it is told to exit.
		const pid = await fake.pid();
		await host.close();
		expect(await fake.sawEndOfInput()).toBe(true);
		expect(isProcessAlive(pid)).toBe(false);
	});

	it("fails pending and later requests as a dropped connection when the child exits", async () => {
		fake = await createFakeHost();
		host = await WebKitHost.launch(fake.executable);
		const pending = host.client.request({ op: "hang" }).catch((error: unknown) => error);
		const dying = host.client.request({ op: "die" }).catch((error: unknown) => error);

		for (const failure of [await pending, await dying]) {
			expect(failure).toBeInstanceOf(TernError);
			expect((failure as TernError).kind).toBe("closed");
			expect((failure as TernError).message).toContain("exited with code 7");
		}
		expect(host.client.connected).toBe(false);
		const later = await host.client.request({ op: "state", block: 1 }).catch((error: unknown) => error);
		expect((later as TernError).kind).toBe("closed");
	});

	it("reports a host that exits before greeting, or cannot be started, as unavailable", async () => {
		fake = await createFakeHost("exit-on-hello");
		const exited = await WebKitHost.launch(fake.executable).catch((error: unknown) => error);
		expect(exited).toBeInstanceOf(WebKitUnavailableError);
		expect((exited as Error).message).toContain("exited with code 3");

		const absent = await WebKitHost.launch(`${fake.dir}/no-such-host`).catch((error: unknown) => error);
		expect(absent).toBeInstanceOf(WebKitUnavailableError);
	});

	it("waits for a host that greets after a socket peer's limit, as on a first launch on macOS", async () => {
		fake = await createFakeHost("late-welcome");
		vi.useFakeTimers();
		try {
			const launching = WebKitHost.launch(fake.executable);
			vi.advanceTimersByTime(11_000);
			await fake.welcome();
			host = await launching;
			expect(host.client.connected).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a host that never answers the greeting as unavailable", async () => {
		fake = await createFakeHost("late-welcome");
		vi.useFakeTimers();
		try {
			const launching = WebKitHost.launch(fake.executable).catch((error: unknown) => error);
			vi.advanceTimersByTime(60_000);
			const failure = await launching;
			expect(failure).toBeInstanceOf(WebKitUnavailableError);
			expect((failure as Error).message).toContain("did not answer the greeting in time");
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops a host still starting when its open is abandoned", async () => {
		fake = await createFakeHost("late-welcome");
		const controller = new AbortController();
		const launching = WebKitHost.launch(fake.executable, undefined, controller.signal).catch(
			(error: unknown) => error,
		);
		while (!(await fake.pid())) await Bun.sleep(10);
		const pid = await fake.pid();
		controller.abort();
		expect(await launching).toBeInstanceOf(ToolAbortError);
		expect(isProcessAlive(pid)).toBe(false);
	});

	it("kills a host that keeps running after its input closed", async () => {
		fake = await createFakeHost("ignore-eof");
		host = await WebKitHost.launch(fake.executable);
		const pid = await fake.pid();
		await host.close();
		expect(await fake.sawEndOfInput()).toBe(true);
		expect(isProcessAlive(pid)).toBe(false);
	}, 15_000);

	it.skipIf(process.platform === "win32")(
		"drains a retired viewer without losing its replacement, then awaits every owned child on close",
		async () => {
			fake = await createFakeHost();
			const arrived = Promise.withResolvers<number>();
			const release = Promise.withResolvers<void>();
			let hold = true;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const pid = Number(new URL(request.url).searchParams.get("pid"));
					if (hold) {
						hold = false;
						arrived.resolve(pid);
						await release.promise;
					}
					return new Response("released");
				},
			});
			const script = path.join(fake.dir, "viewer.cjs");
			const executable = path.join(fake.dir, "ABView");
			const pids = path.join(fake.dir, "viewer-pids");
			await Bun.write(
				script,
				`const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(pids)}, String(process.pid) + "\\n");
process.stdout.write(JSON.stringify({ ready: { mach: "test-" + process.pid } }) + "\\n");
process.stdin.resume();
process.stdin.on("end", async () => {
	await fetch(${JSON.stringify(String(server.url))} + "?pid=" + process.pid);
	process.exit(0);
});
`,
			);
			await Bun.write(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`);
			await fs.chmod(executable, 0o755);
			let hiding: Promise<void> | undefined;
			try {
				host = await WebKitHost.launch(fake.executable, executable);
				const supports = host.client.supports.bind(host.client);
				spyOn(host.client, "supports").mockImplementation(op => op === "present" || supports(op));
				await host.show(1, "first");
				hiding = host.hide(1);
				const retiredPid = await arrived.promise;
				await host.show(2, "second");
				release.resolve();
				await hiding;
				expect(isProcessAlive(retiredPid)).toBe(false);
				expect(host.isShown(2)).toBe(true);
				await host.close();
				expect(isProcessAlive(await fake.pid())).toBe(false);
				const viewerPids = (await Bun.file(pids).text()).trim().split(String.fromCharCode(10)).map(Number);
				expect(viewerPids).toHaveLength(2);
				for (const pid of viewerPids) expect(isProcessAlive(pid)).toBe(false);
			} finally {
				release.resolve();
				await hiding?.catch(() => undefined);
				await host?.close();
				server.stop(true);
			}
		},
		15_000,
	);
});
