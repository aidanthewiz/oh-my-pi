import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { encodeNativeFrame, NativeFrameReader } from "../../src/tools/browser/relay/native-host";
import { waitForRelayExtension } from "../../src/tools/browser/relay/probe";
import { ToolAbortError } from "../../src/tools/tool-errors";
import type { FromNativeHost, ToNativeHost } from "../../../browser-relay/extension/messages";

const packageDir = path.resolve(import.meta.dir, "../..");
const cli = path.join(packageDir, "src/cli.ts");

async function within<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function isolatedEnv(home: string, profile: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
		HOME: home,
		USERPROFILE: home,
		PI_CONFIG_DIR: ".omp",
		OMP_PROFILE: profile,
		OMP_DAEMON_DIR: path.join(home, "daemon"),
		XDG_CONFIG_HOME: path.join(home, "config"),
		XDG_STATE_HOME: path.join(home, "state"),
		XDG_CACHE_HOME: path.join(home, "cache"),
		TMPDIR: path.join(home, "tmp"),
		TMP: path.join(home, "tmp"),
		TEMP: path.join(home, "tmp"),
	};
}

interface Host {
	url: string;
	endpointFile: string;
	process: Bun.Subprocess<"pipe", "pipe", "pipe">;
	close(): Promise<number | null>;
}

async function startHost(home: string, profile: string): Promise<Host> {
	const env = isolatedEnv(home, profile);
	const cwd = path.join(home, profile);
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(env.TMPDIR!, { recursive: true });
	const locations = Bun.spawnSync(
		[
			process.execPath,
			"--no-env-file",
			"-e",
			'import { getBrowserRelayDir, getBrowserRelayInstallRegistryFile } from "@oh-my-pi/pi-utils/dirs"; console.log(JSON.stringify([getBrowserRelayDir(), getBrowserRelayInstallRegistryFile()]));',
		],
		{ cwd: packageDir, env },
	);
	if (locations.exitCode !== 0) throw new Error(locations.stderr.toString());
	const [relayDir, registry] = JSON.parse(locations.stdout.toString()) as string[];
	for (const location of [relayDir!, registry!]) {
		const relative = path.relative(home, location);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`Native-host fixture escaped its private home: ${location}`);
		}
	}
	const child = Bun.spawn([process.execPath, "--no-env-file", cli, "browser-relay", "native-host"], {
		cwd,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const linked = Promise.withResolvers<void>();
	const decoder = new NativeFrameReader();
	let frameError: unknown;
	const output = (async () => {
		try {
			for await (const chunk of child.stdout) {
				for (const frame of decoder.push(chunk)) {
					if ((frame as FromNativeHost).t === "linked") linked.resolve();
				}
			}
		} catch (error) {
			frameError = error;
			linked.reject(error);
		}
	})();
	const stderr = new Response(child.stderr).text();
	let closing: Promise<number | null> | undefined;
	const close = () =>
		(closing ??= (async () => {
			try {
				if (child.exitCode === null) child.stdin.end();
				await within(child.exited, 15_000, "Native host did not exit after its owning port closed");
			} catch (error) {
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
				throw error;
			} finally {
				await output;
				await stderr;
			}
			if (frameError) throw frameError;
			return child.exitCode;
		})());
	try {
		child.stdin.write(encodeNativeFrame({ t: "link", extensionId: "a".repeat(32) }));
		await within(
			Promise.race([
				linked.promise,
				child.exited.then(async code => {
					throw new Error(`Native host exited ${code}: ${await stderr}`);
				}),
			]),
			15_000,
			"Native host did not link its owning port",
		);
		const discovery = path.join(path.dirname(registry!), "endpoints");
		const name = (await fs.readdir(discovery)).find(candidate => candidate.startsWith(`${child.pid}-`));
		if (!name) throw new Error("Linked native host did not publish its own endpoint");
		const port = Number(name.slice(name.lastIndexOf("-") + 1));
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid native-host endpoint port");
		const url = `http://127.0.0.1:${port}`;
		const hello: ToNativeHost = {
			t: "relay",
			line: JSON.stringify({
				t: "hello",
				instanceId: profile,
				userAgent: "test",
				browserVersion: "Chrome/test",
				discardedTabsProtocol: 1,
				tabs: [],
				attachedTabIds: [],
			}),
		};
		child.stdin.write(encodeNativeFrame(hello));
		expect(await waitForRelayExtension(url)).toBe("ready");
		return { url, endpointFile: path.join(discovery, name), process: child, close };
	} catch (error) {
		await close();
		throw error;
	}
}

async function withHosts(
	run: (home: string, start: (profile: string) => Promise<Host>) => Promise<void>,
): Promise<void> {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-host-process-"));
	const hosts: Host[] = [];
	try {
		await run(home, async profile => {
			const host = await startHost(home, profile);
			hosts.push(host);
			return host;
		});
	} finally {
		const results = await Promise.allSettled(hosts.map(host => host.close()));
		await fs.rm(home, { recursive: true, force: true });
		const failures = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
		if (failures.length) throw new AggregateError(failures, "Native-host process cleanup failed");
	}
}

describe("native relay process ownership", () => {
	it("keeps independent browser hosts alive across projects and removes only the closed owner's endpoint", async () => {
		await withHosts(async (_home, start) => {
			const first = await start("first-project");
			const second = await start("second-project");
			expect(second.url).not.toBe(first.url);
			expect(await first.close()).toBe(0);
			expect(await waitForRelayExtension(first.url)).toBe("unreachable");
			expect(await fs.stat(first.endpointFile).catch(() => undefined)).toBeUndefined();
			expect(await waitForRelayExtension(second.url)).toBe("ready");
			expect(await second.close()).toBe(0);
			expect(await fs.stat(second.endpointFile).catch(() => undefined)).toBeUndefined();
		});
	}, 60_000);

	it("loses its listening socket when its native host is killed, without another process keeping it alive", async () => {
		await withHosts(async (_home, start) => {
			const host = await start("killed-owner");
			host.process.kill("SIGKILL");
			await within(host.process.exited, 5_000, "Killed native host did not exit");
			expect(await waitForRelayExtension(host.url)).toBe("unreachable");
		});
	}, 60_000);
});

it("preserves cancellation while a private relay is still answering its readiness probe", async () => {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch() {
			entered.resolve();
			await released.promise;
			return new Response("ready");
		},
	});
	const controller = new AbortController();
	try {
		const pending = waitForRelayExtension(`http://127.0.0.1:${server.port}`, controller.signal);
		await entered.promise;
		controller.abort(new Error("synthetic readiness cancellation"));
		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
		released.resolve();
		expect((await fetch(`http://127.0.0.1:${server.port}`)).status).toBe(200);
	} finally {
		released.resolve();
		server.stop(true);
	}
});

it("bypasses an explicit HTTP proxy for the private loopback readiness endpoint", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-proxy-"));
	await fs.mkdir(path.join(home, "tmp"));
	let proxyHits = 0;
	let relayHits = 0;
	const relay = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			relayHits++;
			return new Response("waiting", { status: 503 });
		},
	});
	const proxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			proxyHits++;
			return new Response("proxy", { status: 502 });
		},
	});
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"-e",
			`import { probeCdpResponse } from ${JSON.stringify(path.join(packageDir, "src/tools/browser/attach.ts"))}; console.log(JSON.stringify(await probeCdpResponse(${JSON.stringify(`http://127.0.0.1:${relay.port}`)}, { timeoutMs: 2000 })));`,
		],
		{
			cwd: packageDir,
			env: {
				...isolatedEnv(home, "proxy"),
				HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
				http_proxy: `http://127.0.0.1:${proxy.port}`,
				NO_PROXY: "",
				no_proxy: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code, stderr).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ status: 503, body: "waiting" });
		expect(relayHits).toBe(1);
		expect(proxyHits).toBe(0);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		relay.stop(true);
		proxy.stop(true);
		await fs.rm(home, { recursive: true, force: true });
	}
});
