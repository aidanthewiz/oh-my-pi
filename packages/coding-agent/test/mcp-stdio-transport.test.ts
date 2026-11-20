import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connectToServer } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import {
	resolveStdioSpawnCommand,
	StdioTransport,
	terminateStdioProcess,
	writeFrame,
} from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import type { MCPServerConnection, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { trackUnhandled } from "./helpers/rejection";

describe("resolveStdioSpawnCommand", () => {
	it("resolves bare Windows commands through PATHEXT and wraps .cmd shims with cmd.exe", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" serve --mcp"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("prefers a project-local .cmd shim over a same-named global one when no path segment is given", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-cwd-"));
		const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-global-"));
		try {
			const localShim = path.join(projectDir, "server.cmd");
			const globalShim = path.join(globalDir, "server.cmd");
			await Bun.write(localShim, "@echo off\r\nrem local\r\n");
			await Bun.write(globalShim, "@echo off\r\nrem global\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "server.cmd", args: ["serve"] },
				{
					cwd: projectDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: globalDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${localShim}" serve"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(projectDir);
			await removeWithRetries(globalDir);
		}
	});

	it("keeps PATH-resolved npx.cmd on the cmd.exe path so npm preserves stdio semantics", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-npx-"));
		try {
			const shim = path.join(tempDir, "npx.cmd");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"GOTO start",
					":find_dp0",
					"SET dp0=%~dp0",
					"EXIT /b",
					":start",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\node.exe" (',
					'  SET "_prog=%dp0%\\node.exe"',
					") ELSE (",
					'  SET "_prog=node"',
					"  SET PATHEXT=%PATHEXT:;.JS;=;%",
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "npx", args: ["-y", "mcp-gdb"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
					hostHasInheritableConsole: true,
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" -y mcp-gdb"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(false);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("still launches non-npx npm .cmd shims through node so stdio stays owned by the server process", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-codegraph-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			const entry = path.join(tempDir, "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"GOTO start",
					":find_dp0",
					"SET dp0=%~dp0",
					"EXIT /b",
					":start",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\node.exe" (',
					'  SET "_prog=%dp0%\\node.exe"',
					") ELSE (",
					'  SET "_prog=node"',
					"  SET PATHEXT=%PATHEXT:;.JS;=;%",
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\@colbymchenry\\codegraph\\npm-shim.js" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph.cmd", args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
					hostHasInheritableConsole: true,
				},
			);

			expect(result.cmd).toEqual(["node", entry, "serve", "--mcp"]);
			expect(result.windowsHide).toBe(false);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("keeps non-node cmd-shim wrappers on the cmd.exe path instead of mislaunching them via node", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-pyshim-"));
		try {
			const shim = path.join(tempDir, "pyserver.cmd");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\python.exe" (',
					'  SET "_prog=%dp0%\\python.exe"',
					") ELSE (",
					'  SET "_prog=python"',
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\pyserver\\cli.py" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "pyserver.cmd", args: ["serve"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" serve"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("resolves extension-less absolute Windows paths to the sibling .cmd shim", async () => {
		// Mirrors npm's Windows shim layout: bare `codegraph` (shebang script),
		// `codegraph.cmd` (cmd.exe wrapper), and `codegraph.ps1` siblings under
		// %AppData%\Roaming\npm. uv_spawn rejects the extensionless script;
		// the resolver must promote the bare absolute path to its `.cmd`
		// sibling so the launch succeeds (see #2174). The test rig pins
		// PATHEXT to a single lowercase extension so the candidate filename
		// matches the file we create on the case-sensitive test host.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-abs-"));
		try {
			const bare = path.join(tempDir, "codegraph");
			const shim = `${bare}.cmd`;
			await Bun.write(bare, "#!/bin/sh\n");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: bare, args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" serve --mcp"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("spawns a missing path-qualified Windows command directly instead of through cmd.exe", async () => {
		// cmd.exe would only print "not recognized" and close stdout; a direct spawn fails with ENOENT.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-missing-"));
		try {
			const missing = path.join(tempDir, "missing-server");
			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: missing, args: ["serve"] },
				{
					cwd: tempDir,
					env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe", PATH: "", PATHEXT: ".cmd" },
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([missing, "serve"]);
			expect(result.windowsVerbatimArguments).toBeUndefined();
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("wraps explicit Windows .cmd commands in an escaped cmd.exe command line", async () => {
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "codegraph.cmd", args: ["serve", "--mcp"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "C:\\Users\\me\\AppData\\Roaming\\npm",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		expect(result.cmd).toEqual([
			"C:\\Windows\\System32\\cmd.exe",
			"/d",
			"/e:ON",
			"/v:OFF",
			"/c",
			`""codegraph.cmd" serve --mcp"`,
		]);
		expect(result.windowsVerbatimArguments).toBe(true);
		expect(result.windowsHide).toBe(true);
		expect(result.detached).toBe(false);
	});

	it("routes unresolvable bare Windows commands through cmd.exe so PATHEXT can find a .cmd shim (#3250)", async () => {
		// Bun.spawn -> CreateProcess only appends `.exe` to extensionless names.
		// Commands shipped as `.cmd` shims (`npx`, `yarn`, most pnpm-installed
		// binaries on Windows) cannot be launched directly. When our PATH walk
		// finds nothing — empty PATH under a restricted parent, locked-down
		// shell, UNC mounts that reject `fs.access` — we must delegate to
		// cmd.exe so its native PATHEXT lookup runs. The legacy fallback
		// handed `Bun.spawn` the bare name and the subprocess died ~140ms
		// after spawn with ENOENT/EINVAL (issue #3250).
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "npx", args: ["-y", "cloakbrowser-mcp@latest"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		expect(result.cmd).toEqual([
			"C:\\Windows\\System32\\cmd.exe",
			"/d",
			"/e:ON",
			"/v:OFF",
			"/c",
			`""npx" -y cloakbrowser-mcp@latest"`,
		]);
		expect(result.windowsVerbatimArguments).toBe(true);
		expect(result.windowsHide).toBe(true);
		expect(result.detached).toBe(false);
	});

	it("escapes command-injection payloads in .cmd shim args instead of leaving them live for cmd.exe", async () => {
		// BatBadBut / CVE-2024-24576: cmd.exe re-parses the /c string and
		// expands variables before the shim's argv split, so a crafted arg such
		// as `"&calc.exe` or `%CMDCMDLINE:~-1%&calc.exe` could break out and run
		// an attacker command. The escaped line MUST keep each `&` inside quotes
		// and split every `%` with `%cd:~,%` (which expands to nothing), so no
		// live `%VAR%` reference or bare `&calc.exe` reaches cmd.exe.
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "npx", args: ['"&calc.exe', "%CMDCMDLINE:~-1%&calc.exe"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		const line = result.cmd.at(-1) ?? "";
		expect(line).toBe(`""npx" """&calc.exe" "%%cd:~,%CMDCMDLINE:~-1%%cd:~,%&calc.exe""`);
		// Every raw `%` is broken by an inserted `%cd:~,%`, so no substring
		// remains that cmd.exe would expand as `%…%` (the `~-1` extraction that
		// pulls a literal quote out of `%CMDCMDLINE%` can no longer fire).
		expect(line).not.toContain("%CMDCMDLINE:~-1%&");
		expect(line.split("&calc.exe").length - 1).toBe(2);
		expect(result.windowsVerbatimArguments).toBe(true);
	});

	it("rejects .cmd shim args containing characters that cannot round-trip through cmd.exe", async () => {
		for (const bad of ["a\0b", "a\rb", "a\nb"]) {
			await expect(
				resolveStdioSpawnCommand(
					{ type: "stdio", command: "npx", args: [bad] },
					{
						cwd: "C:\\project",
						env: {
							COMSPEC: "C:\\Windows\\System32\\cmd.exe",
							PATH: "",
							PATHEXT: ".COM;.EXE;.BAT;.CMD",
						},
						platform: "win32",
					},
				),
			).rejects.toThrow(/NUL, CR, or LF/);
		}
	});

	it("neutralizes percent syntax in the resolved .cmd path so cmd.exe launches the real shim", async () => {
		// A project/PATH directory can legally contain `%` on NTFS. cmd.exe
		// expands `%VAR%` across the whole /c string before launching the batch
		// file, so an un-escaped command token like C:\work\%TOKEN%\server.cmd
		// would resolve to a different path. The command token must be escaped
		// the same way arguments are.
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-cmdpct-"));
		const dir = path.join(base, "%TOKEN%");
		try {
			await fs.mkdir(dir, { recursive: true });
			const shim = path.join(dir, "server.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: shim, args: ["serve"] },
				{
					cwd: base,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: "",
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			const escapedShim = shim.replace("%TOKEN%", "%%cd:~,%TOKEN%%cd:~,%");
			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${escapedShim}" serve"`,
			]);
			// No live `%TOKEN%` reference survives for cmd.exe to expand.
			expect(result.cmd.at(-1)).not.toContain(`${path.join(base, "%TOKEN%")}`);
			expect(result.windowsVerbatimArguments).toBe(true);
		} finally {
			await removeWithRetries(base);
		}
	});

	it("rejects a resolved .cmd command path containing characters that cannot round-trip through cmd.exe", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ type: "stdio", command: "C:\\work\\ser\rver.cmd", args: ["serve"] },
				{
					cwd: "C:\\project",
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: "",
						PATHEXT: ".COM;.EXE;.BAT;.CMD",
					},
					platform: "win32",
				},
			),
		).rejects.toThrow(/command cannot contain NUL, CR, or LF/);
	});

	it("leaves non-Windows commands untouched", async () => {
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
			{ cwd: "/", env: {}, platform: "linux" },
		);

		expect(result.cmd).toEqual(["codegraph", "serve", "--mcp"]);
		expect(result.windowsHide).toBeUndefined();
		expect(result.detached).toBe(true);
	});

	it("keeps console-attached Windows cmd.exe wrapper chains out of CREATE_NO_WINDOW (#3567)", async () => {
		// The #3544 shape is `cmd.exe` → `node wrapper` → another console
		// launcher (`cmd.exe /C npx.cmd`, PowerShell, similar). If the OMP host
		// already owns a terminal console, `windowsHide: true` maps to
		// CREATE_NO_WINDOW and strips that inheritable console from the direct
		// hidden wrapper. Grandchildren then allocate fresh visible conhost
		// windows during startup or reconnect loops (#3567). Keep the tree
		// attached to OMP's console instead.
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "cmd.exe", args: ["/C", "node .codex\\mcp-wrapper.js"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
				hostHasInheritableConsole: true,
			},
		);

		expect(result.detached).toBe(false);
		expect(result.windowsHide).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// writeFrame — the seam that catches synchronous FileSink throws AND neutralizes
// asynchronous (Promise) rejections, so the async `notify` / `#sendResponse` /
// `request` paths never let an un-awaited broken-pipe rejection escape as a fatal
// unhandled rejection. See issue #1710 and its async follow-up.
// ---------------------------------------------------------------------------

describe("writeFrame", () => {
	it("writes and flushes, returning true on success", () => {
		const sink = {
			writes: [] as string[],
			flushed: 0,
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, '{"k":1}\n')).toBe(true);
		expect(sink.writes).toEqual(['{"k":1}\n']);
		expect(sink.flushed).toBe(1);
	});

	it("returns false when write() throws synchronously (broken pipe)", () => {
		const sink = {
			flushed: 0,
			write() {
				throw new Error("EPIPE: broken pipe, write");
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.flushed).toBe(0);
	});

	it("returns false when flush() throws after a successful write", () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				throw new Error("EPIPE: broken pipe, flush");
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.writes).toEqual(["anything\n"]);
	});

	it("returns true and neutralizes an asynchronous write rejection (broken pipe surfaced as a Promise)", async () => {
		const sink = {
			flushed: 0,
			write() {
				return Promise.reject(new Error("EPIPE: broken pipe, write"));
			},
			flush() {
				this.flushed++;
			},
		};

		const tracker = trackUnhandled();
		try {
			// No synchronous throw, so the frame is "accepted"; the async rejection
			// must be neutralized rather than escaping as an unhandled rejection.
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("returns true and neutralizes an asynchronous flush rejection", async () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				return Promise.reject(new Error("EPIPE: broken pipe, flush"));
			},
		};

		const tracker = trackUnhandled();
		try {
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("observes a rejected write even when flush throws synchronously", async () => {
		const tracker = trackUnhandled();
		try {
			expect(
				writeFrame(
					{
						write() {
							return Promise.reject(new Error("EPIPE: broken pipe, write"));
						},
						flush() {
							throw new Error("EPIPE: broken pipe, flush");
						},
					},
					"frame\n",
				),
			).toBe(false);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});
});

// ---------------------------------------------------------------------------
// StdioTransport.notify — end-to-end behavior against a real subprocess that
// exits before or while a notification is sent. Contract defended here:
//
//   1. notify() always settles — no unhandled rejection ever escapes when
//      the underlying FileSink observes a closed pipe.
//   2. A failed write tears the transport down (`onClose` fires) and surfaces
//      a rejection to the caller when the platform reports one synchronously.
//
// On platforms where the pipe accepts the write, read-loop EOF still closes the
// transport. The request/response parsing path is covered separately; this test
// intentionally avoids requiring subprocess stdout because Bun's test runner can
// hand stdout-writing child processes an unusable fd on some hosts.
// ---------------------------------------------------------------------------

describe("StdioTransport.notify", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("rejects synchronously when called before connect()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("rejects with 'Transport not connected' after close()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		await transport.connect();
		await transport.close();

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("does not surface unhandled rejections when the subprocess exits before notify settles", async () => {
		const tracker = trackUnhandled();
		const closed = Promise.withResolvers<void>();
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});
		transport.onClose = () => {
			closed.resolve();
		};

		try {
			await transport.connect();
			const notify = transport.notify("notifications/initialized").catch((error: unknown) => {
				expect(error).toBeInstanceOf(Error);
			});

			await closed.promise;
			await notify;
			await Promise.resolve();

			expect(tracker.capture()).toEqual([]);
			expect(transport.connected).toBe(false);
		} finally {
			tracker.release();
		}
	});
});

describe("StdioTransport request failure diagnostics", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("reports the subprocess exit code when it terminates before responding", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.stdin.once('data', () => process.exit(23)); process.stdin.resume()"],
			timeout: 1_000,
		});
		await transport.connect();
		const error = await transport.request("tools/list").then(
			() => undefined,
			reason => reason,
		);
		if (!(error instanceof MCPTransportError)) throw error;

		expect(error).toMatchObject({
			transport: "stdio",
			stage: "receive",
			failure: "eof",
			retryable: false,
			code: 23,
		});
		expect(error.message).toContain("exited with code 23");
	});

	it.skipIf(process.platform === "win32")(
		"reports the subprocess signal when it is killed before responding",
		async () => {
			transport = new StdioTransport({
				type: "stdio",
				command: "bun",
				args: [
					"-e",
					"process.stdin.once('data', () => process.kill(process.pid, 'SIGKILL')); process.stdin.resume()",
				],
				timeout: 1_000,
			});
			await transport.connect();
			const error = await transport.request("tools/list").then(
				() => undefined,
				reason => reason,
			);
			if (!(error instanceof MCPTransportError)) throw error;

			expect(error).toMatchObject({
				transport: "stdio",
				stage: "receive",
				failure: "eof",
				retryable: false,
				code: "SIGKILL",
			});
			expect(error.message).toContain("killed by SIGKILL");
		},
	);

	it("reports malformed subprocess JSON at the decode stage", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.stdin.once('data', () => console.log('{not-json')); process.stdin.resume()"],
			timeout: 1_000,
		});
		await transport.connect();

		await expect(transport.request("tools/list")).rejects.toMatchObject({
			transport: "stdio",
			stage: "decode",
			failure: "malformed_response",
			retryable: false,
		});
	});
});

describe("StdioTransport delivery safety", () => {
	let root: string;
	let connections: MCPServerConnection[];

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-delivery-"));
		connections = [];
	});

	afterEach(async () => {
		try {
			await Promise.all(connections.map(connection => connection.transport.close()));
		} finally {
			await removeWithRetries(root);
		}
	});

	async function connect(
		outcome: "exit" | "reply" | "hold",
		onNotification?: (method: string, params: unknown) => void,
	): Promise<MCPServerConnection> {
		const script = `
			import { Database } from "bun:sqlite";
			import { createInterface } from "node:readline";
			const db = new Database(${JSON.stringify(path.join(root, "actions.sqlite"))});
			db.run("CREATE TABLE IF NOT EXISTS actions (marker TEXT NOT NULL)");
			const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc: "2.0", id, result}) + "\\n");
			createInterface({input: process.stdin}).on("line", line => {
				const request = JSON.parse(line);
				if (request.method === "initialize") {
					reply(request.id, {
						protocolVersion: request.params.protocolVersion,
						capabilities: {tools: {}},
						serverInfo: {name: "stdio-delivery-fixture", version: "1"}
					});
				} else if (request.method === "tools/call") {
					const marker = request.params.arguments.marker;
					db.run("INSERT INTO actions (marker) VALUES (?)", [marker]);
					if (${JSON.stringify(outcome)} === "exit") {
						db.close();
						process.exit(23);
					}
					if (${JSON.stringify(outcome)} === "reply") {
						reply(request.id, {content: [{type: "text", text: "committed:" + marker}]});
					} else {
						process.stdout.write(JSON.stringify({
							jsonrpc: "2.0", method: "committed", params: {marker}
						}) + "\\n");
					}
				}
			});
		`;
		const config: MCPStdioServerConfig = {
			type: "stdio",
			command: process.execPath,
			args: ["--no-env-file", "-e", script],
			cwd: root,
			timeout: 2_000,
		};
		const connection = await connectToServer("stdio-delivery-fixture", config, { onNotification });
		connections.push(connection);
		return connection;
	}

	function actions(): unknown[] {
		const db = new Database(path.join(root, "actions.sqlite"), { readonly: true });
		try {
			return db.query("SELECT marker FROM actions ORDER BY rowid").all();
		} finally {
			db.close();
		}
	}

	const definition = {
		name: "commit",
		inputSchema: { type: "object" as const, properties: { marker: { type: "string" } }, required: ["marker"] },
	};

	it("surfaces a lost response without replaying an action committed before subprocess exit", async () => {
		const connection = await connect("exit");
		let reconnects = 0;
		const tool = new MCPTool(connection, definition, async () => {
			reconnects++;
			await connection.transport.close();
			return connect("reply");
		});

		const result = await withTimeout(
			tool.execute("lost-response", { marker: "charged" }, undefined, {} as never),
			1_000,
			new Error("Lost-response tool call did not settle"),
		);

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("MCP subprocess") }),
		]);
		expect(reconnects).toBe(0);
		expect(actions()).toEqual([{ marker: "charged" }]);
		expect(connection.transport.connected).toBe(false);
	});

	it("settles every pending request without permitting replay after subprocess EOF", async () => {
		const connection = await connect("exit");
		const payload = "x".repeat(1024 * 1024);
		const results = await withTimeout(
			Promise.allSettled([
				connection.transport.request("tools/call", { name: "commit", arguments: { marker: "first", payload } }),
				connection.transport.request("tools/call", { name: "commit", arguments: { marker: "second", payload } }),
			]),
			1_000,
			new Error("Pending requests did not settle on EOF"),
		);

		for (const result of results) {
			expect(result.status).toBe("rejected");
			if (result.status !== "rejected") throw new Error("Expected a lost-response rejection");
			expect(result.reason).toBeInstanceOf(MCPTransportError);
			expect(result.reason).toMatchObject({ transport: "stdio", retryable: false });
			expect(["eof", "reset"]).toContain(result.reason.failure);
		}
		expect(actions()).toEqual([{ marker: "first" }]);
		await connection.transport.close();
		expect(connection.transport.connected).toBe(false);
	});

	it("recovers a known pre-write disconnection and performs the action exactly once", async () => {
		const connection = await connect("reply");
		await connection.transport.close();
		let reconnects = 0;
		const tool = new MCPTool(connection, definition, async () => {
			reconnects++;
			return connect("reply");
		});

		const result = await tool.execute("pre-write", { marker: "once" }, undefined, {} as never);

		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "committed:once" }]);
		expect(reconnects).toBe(1);
		expect(actions()).toEqual([{ marker: "once" }]);
	});

	it.each(["write-reject", "flush-reject", "write-throw", "flush-throw"] as const)(
		"does not replay a committed action after %s",
		async failure => {
			const committed = Promise.withResolvers<void>();
			const spawnSpy = spyOn(Bun, "spawn");
			let connection: MCPServerConnection;
			let child: Subprocess<"pipe", "pipe", "pipe">;
			try {
				connection = await connect("hold", method => {
					if (method === "committed") committed.resolve();
				});
				child = spawnSpy.mock.results[0]?.value as Subprocess<"pipe", "pipe", "pipe">;
			} finally {
				spawnSpy.mockRestore();
			}
			const sink = child.stdin;
			const originalWrite = sink.write.bind(sink);
			const originalFlush = sink.flush.bind(sink);
			const error = Object.assign(new Error("ECONNRESET: response lost after commit"), { code: "ECONNRESET" });
			const sendSpy = failure.startsWith("write")
				? spyOn(sink, "write").mockImplementationOnce(chunk => {
						Promise.resolve(originalWrite(chunk)).catch(() => {});
						if (failure === "write-throw") {
							Promise.resolve(originalFlush()).catch(() => {});
							throw error;
						}
						return committed.promise.then(() => {
							throw error;
						});
					})
				: spyOn(sink, "flush").mockImplementationOnce(() => {
						Promise.resolve(originalFlush()).catch(() => {});
						if (failure === "flush-throw") throw error;
						return committed.promise.then(() => {
							throw error;
						});
					});
			const tracker = trackUnhandled();
			let reconnects = 0;
			const tool = new MCPTool(connection, definition, async () => {
				reconnects++;
				await connection.transport.close();
				return connect("reply");
			});
			try {
				const result = await withTimeout(
					tool.execute("send-failure", { marker: failure }, undefined, {} as never),
					1_000,
					new Error("Send failure did not settle"),
				);
				await withTimeout(committed.promise, 1_000, new Error("Child did not commit the action"));
				expect(result.isError).toBe(true);
				expect(reconnects).toBe(0);
				expect(actions()).toEqual([{ marker: failure }]);
				await connection.transport.close();
				expect(connection.transport.connected).toBe(false);
				expect(tracker.capture()).toEqual([]);
			} finally {
				sendSpy.mockRestore();
				tracker.release();
			}
		},
	);

	it("keeps caller cancellation authoritative after a committed action and settles remaining work on close", async () => {
		const committed = Promise.withResolvers<void>();
		let accepted = 0;
		const connection = await connect("hold", method => {
			if (method === "committed" && ++accepted === 2) committed.resolve();
		});
		const controller = new AbortController();
		const cancelled = connection.transport
			.request("tools/call", { name: "commit", arguments: { marker: "cancelled" } }, { signal: controller.signal })
			.then(
				() => undefined,
				error => error,
			);
		const pending = connection.transport
			.request("tools/call", {
				name: "commit",
				arguments: { marker: "pending" },
			})
			.then(
				() => undefined,
				error => error,
			);
		await withTimeout(committed.promise, 1_000, new Error("Child did not accept both pending requests"));
		const reason = new Error("ECONNRESET: caller cancelled");
		controller.abort(reason);
		expect(await withTimeout(cancelled, 1_000, new Error("Caller cancellation did not settle"))).toBe(reason);
		await connection.transport.close();
		expect(await pending).toMatchObject({ failure: "closed", retryable: false });
		expect(actions()).toEqual([{ marker: "cancelled" }, { marker: "pending" }]);
		expect(connection.transport.connected).toBe(false);
	});
});

describe("StdioTransport send acceptance", () => {
	let transport: StdioTransport | undefined;
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await transport?.close();
		if (child?.exitCode === null) child.kill();
		await child?.exited;
		transport = undefined;
		child = undefined;
	});

	for (const { operation, asynchronous, retryable } of [
		{ operation: "write", asynchronous: false, retryable: false },
		{ operation: "write", asynchronous: true, retryable: false },
		{ operation: "flush", asynchronous: false, retryable: false },
		{ operation: "flush", asynchronous: true, retryable: false },
	] as const) {
		it(`${asynchronous ? "asynchronous" : "synchronous"} ${operation} failures are ${retryable ? "retryable before dispatch" : "not replayable after acceptance"}`, async () => {
			child = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const spawn = vi.spyOn(Bun, "spawn").mockReturnValueOnce(child);
			transport = new StdioTransport({ type: "stdio", command: process.execPath, timeout: 100 });
			await transport.connect();
			spawn.mockRestore();
			const brokenPipe = Object.assign(new Error(`EPIPE: broken pipe, ${operation}`), { code: "EPIPE" });
			vi.spyOn(child.stdin, operation).mockImplementationOnce(() => {
				if (asynchronous) return Promise.reject(brokenPipe);
				throw brokenPipe;
			});

			await expect(transport.request("tools/list")).rejects.toMatchObject({
				transport: "stdio",
				stage: "send",
				failure: "eof",
				retryable,
				code: "EPIPE",
			});
		});
	}
});

// ---------------------------------------------------------------------------
// StdioTransport.close — authoritative resource teardown that must keep
// cleaning up the subprocess and read loop even when `#handleClose()` has
// already flipped `#connected` (read-loop EOF, or a notify() write failure
// in the connectToServer() failure path). See PR #1711 follow-up.
//
// Bun's parent-side stdout reader only sees EOF when the subprocess
// actually exits, so the "subprocess closed its stdout but stayed alive"
// state we'd love to test directly cannot be reproduced through a real
// subprocess on this platform. Instead we exercise the post-handleClose
// code path via the natural read-loop-EOF route and pair it with explicit
// idempotency checks; the reviewer-flagged leak surfaces on Windows where
// the notify() write actually throws.
// ---------------------------------------------------------------------------

describe("StdioTransport.close", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("completes cleanup when called after the read loop has already torn down", async () => {
		// Subprocess exits cleanly; the read loop sees EOF and fires
		// `#handleClose()`, flipping `#connected` to false. `close()` then
		// runs in exactly the state the reviewer flagged — `#connected`
		// already false, `#process` and `#readLoop` still set — and must
		// still null them out instead of early-returning.
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();

		// Wait for the read loop to observe EOF and fire #handleClose.
		for (let i = 0; i < 100 && transport.connected; i++) {
			await Bun.sleep(10);
		}
		expect(transport.connected).toBe(false);
		expect(closeCount).toBe(1);

		// Must not throw and must not re-fire onClose.
		await transport.close();
		expect(closeCount).toBe(1);

		// Second close is a no-op too — every resource is already released.
		await transport.close();
		expect(closeCount).toBe(1);
	});

	it("is idempotent — repeat close() calls fire onClose exactly once", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();
		await transport.close();
		await transport.close();
		await transport.close();

		expect(closeCount).toBe(1);
		expect(transport.connected).toBe(false);
	});

	// Regression for #5578: close() escalates SIGTERM to SIGKILL when the
	// subprocess ignores the former, so this must stay idempotent even when
	// the *first* close() had to run the full escalation path, not just the
	// already-covered "child exited before close()" and "child dies on plain
	// SIGTERM" cases above. POSIX-only: on Windows, `Subprocess.kill("SIGTERM")`
	// terminates the process immediately regardless of the handler, so the
	// child cannot trap it and the `elapsedMs >= 900` escalation-timing
	// assertion below would fail even though Windows `close()` behaves
	// correctly — same rationale as the `terminateStdioProcess` describe
	// block's platform skip in `stdio.test.ts`.
	it.skipIf(process.platform === "win32")(
		"is idempotent even when close() had to escalate to SIGKILL",
		async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-close-escalate-"));
			const scriptPath = path.join(tempDir, "child.mjs");
			const readyPath = path.join(tempDir, "ready");
			try {
				await fs.writeFile(
					scriptPath,
					[
						"import { writeFileSync } from 'node:fs';",
						"process.on('SIGTERM', () => {});",
						`writeFileSync(${JSON.stringify(readyPath)}, '1');`,
						"setInterval(() => {}, 60_000);",
					].join("\n"),
				);
				transport = new StdioTransport({
					type: "stdio",
					command: "bun",
					args: ["run", scriptPath],
				});

				await transport.connect();

				// Wait for the child to actually register its SIGTERM handler before
				// closing: closing too early races the child's startup and hits the
				// default (terminate) action instead of exercising the escalation
				// path this test defends.
				for (let i = 0; i < 100; i++) {
					try {
						await fs.access(readyPath);
						break;
					} catch {
						await Bun.sleep(20);
					}
				}

				const started = performance.now();
				await transport.close();
				const elapsedMs = performance.now() - started;
				// Escalation only fires after the SIGTERM grace window elapses.
				expect(elapsedMs).toBeGreaterThanOrEqual(900);

				// Repeat close() calls must not throw or attempt to re-signal a
				// process the first call already tore down.
				await expect(transport.close()).resolves.toBeUndefined();
				await expect(transport.close()).resolves.toBeUndefined();
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		},
		5000,
	);
});
describe("resolveStdioSpawnCommand", () => {
	it("hides Windows executable MCP servers when the host has no console", async () => {
		// Hidden so a console-app child does not allocate a visible window when
		// OMP is launched without a terminal console (#3536).
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32", hostHasInheritableConsole: false },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: true,
			detached: false,
		});
	});

	it("inherits an attached Windows console instead of forcing CREATE_NO_WINDOW", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "win32", hostHasInheritableConsole: true },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			windowsHide: false,
			detached: false,
		});
	});

	it("keeps Darwin stdio MCP servers attached so TCC Apple Events prompts can resolve", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "xcrun", args: ["mcpbridge"] },
				{ cwd: process.cwd(), env: {}, platform: "darwin" },
			),
		).resolves.toEqual({
			cmd: ["xcrun", "mcpbridge"],
			detached: false,
		});
	});

	it("detaches off-Windows MCP servers so terminal job-control signals cannot stop them", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ command: "server.exe", args: ["--stdio"] },
				{ cwd: process.cwd(), env: {}, platform: "linux" },
			),
		).resolves.toEqual({
			cmd: ["server.exe", "--stdio"],
			detached: true,
		});
	});
});

it("removes project dotenv values while preserving explicit server env", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-env-boundary-"));
	const projectKey = `OMP_MCP_PROJECT_SECRET_${Date.now()}`;
	const projectSecret = "project-controlled-mcp-secret";
	const explicitKey = `OMP_MCP_EXPLICIT_VALUE_${Date.now()}`;
	const explicitSecret = "explicit-server-secret";
	const outputPath = path.join(cwd, "child-env.json");
	const previous = Bun.env[projectKey];
	await Bun.write(path.join(cwd, ".env"), `${projectKey}=${projectSecret}\n`);
	Bun.env[projectKey] = projectSecret;
	const transport = new StdioTransport({
		command: process.execPath,
		args: [
			"-e",
			`await Bun.write(${JSON.stringify(outputPath)}, JSON.stringify(process.env)); await Bun.sleep(60_000);`,
		],
		cwd,
		env: { [explicitKey]: explicitSecret },
	});

	try {
		await transport.connect();
		// The external child exposes readiness only through its output file; fake timers cannot drive its process.
		for (let attempt = 0; attempt < 100 && !(await Bun.file(outputPath).exists()); attempt++) {
			await Bun.sleep(20);
		}
		const childEnv = JSON.parse(await Bun.file(outputPath).text()) as Record<string, string | undefined>;
		expect(childEnv[projectKey]).toBeUndefined();
		expect(childEnv[explicitKey]).toBe(explicitSecret);
	} finally {
		await transport.close();
		if (previous === undefined) delete Bun.env[projectKey];
		else Bun.env[projectKey] = previous;
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

it("does not let explicit server env reopen managed dotenv loading", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-managed-env-boundary-"));
	const agentDir = path.join(cwd, "agent");
	const outputPath = path.join(cwd, "child-env.json");
	const secretKey = `OMP_MCP_MANAGED_SECRET_${Date.now()}`;
	const projectKey = `OMP_MCP_PROJECT_ONLY_${Date.now()}`;
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(path.join(agentDir, ".env"), `${secretKey}=managed-profile-secret\n`);
	await Bun.write(path.join(cwd, ".env"), `${projectKey}=project-dotenv\n`);
	const envModuleUrl = new URL("../../utils/src/env.ts", import.meta.url).href;
	const script = [
		`const { $env } = await import(${JSON.stringify(envModuleUrl)});`,
		`await Bun.write(${JSON.stringify(outputPath)}, JSON.stringify({ secret: $env[${JSON.stringify(secretKey)}], projectValue: process.env[${JSON.stringify(projectKey)}], sentinel: process.env.OMP_NO_ENV_FILE, noEnvFile: process.execArgv.includes("--no-env-file") }));`,
		"await Bun.sleep(60_000);",
	].join("\n");
	const transport = new StdioTransport({
		command: process.execPath,
		args: ["-e", script],
		cwd,
		env: {
			BUN_OPTIONS: "",
			OMP_NO_ENV_FILE: "0",
			OMP_PROFILE: "",
			PI_CODING_AGENT_DIR: agentDir,
			PI_PROFILE: "",
		},
	});

	try {
		await transport.connect();
		for (let attempt = 0; attempt < 100 && !(await Bun.file(outputPath).exists()); attempt++) {
			await Bun.sleep(20);
		}
		expect(await Bun.file(outputPath).exists()).toBeTrue();
		const childEnv = JSON.parse(await Bun.file(outputPath).text()) as {
			secret?: string;
			projectValue?: string;
			sentinel?: string;
			noEnvFile?: boolean;
		};
		expect(childEnv.secret).toBeUndefined();
		expect(childEnv.sentinel).toBe("1");
		expect(childEnv.projectValue).toBeUndefined();
		expect(childEnv.noEnvFile).toBe(true);
	} finally {
		await transport.close();
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

it("passes immutable AWS metadata only to the managed proxy after runtime cleanup", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-aws-stdio-"));
	const managedOutput = path.join(root, "managed.json");
	const genericOutput = path.join(root, "generic.json");
	const transportUrl = new URL("../src/mcp/transports/stdio.ts", import.meta.url).href;
	const captureChildEnvironment = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env));";
	const trusted = {
		configFile: path.join(root, "trusted-config"),
		sharedCredentialsFile: path.join(root, "trusted-credentials"),
		profile: "trusted-profile",
		region: "us-gov-west-1",
		executable: path.join(root, "trusted-aws"),
	};
	const untrusted = {
		OMP_OPERATIONAL_AWS_CONFIG_FILE: path.join(root, "project-config"),
		OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: path.join(root, "project-credentials"),
		OMP_OPERATIONAL_AWS_PROFILE: "project-profile",
		OMP_OPERATIONAL_AWS_REGION: "eu-west-1",
		OMP_OPERATIONAL_AWS_EXECUTABLE: path.join(root, "project-aws"),
		OMP_OPERATIONAL_AWS_HOME_DIRECTORY: path.join(root, "project-home"),
		AWS_ACCESS_KEY_ID: "config-access-key",
		AWS_SECRET_ACCESS_KEY: "config-secret-key",
	};
	await Bun.write(
		path.join(root, ".env"),
		`${Object.entries(untrusted)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}\n`,
	);
	// The spawned transport has no readiness protocol. This integration probe waits for its actual output file.
	const script = [
		`const { StdioTransport } = await import(${JSON.stringify(transportUrl)});`,
		`const capture = ${JSON.stringify(captureChildEnvironment)};`,
		`const managedOutput = ${JSON.stringify(managedOutput)};`,
		`const genericOutput = ${JSON.stringify(genericOutput)};`,
		`const untrusted = ${JSON.stringify(untrusted)};`,
		"for (const key of Object.keys(process.env)) { if (key.startsWith('OMP_OPERATIONAL_AWS_')) delete process.env[key]; }",
		"const waitFor = async output => { for (let attempt = 0; attempt < 100 && !(await Bun.file(output).exists()); attempt++) await Bun.sleep(10); if (!(await Bun.file(output).exists())) throw new Error('child did not capture its environment'); };",
		"const managed = new StdioTransport({ command: process.execPath, args: ['-e', capture, managedOutput], cwd: process.cwd(), env: untrusted }, { preserveOperationalAws: true });",
		"await managed.connect(); await waitFor(managedOutput); await managed.close();",
		"const generic = new StdioTransport({ command: process.execPath, args: ['-e', capture, genericOutput], cwd: process.cwd(), env: untrusted });",
		"await generic.connect(); await waitFor(genericOutput); await generic.close();",
		"process.stdout.write(JSON.stringify({ managed: JSON.parse(await Bun.file(managedOutput).text()), generic: JSON.parse(await Bun.file(genericOutput).text()) }));",
	].join("\n");
	const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
		cwd: root,
		env: {
			...process.env,
			HOME: root,
			OMP_OPERATIONAL_AWS_CONFIG_FILE: trusted.configFile,
			OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: trusted.sharedCredentialsFile,
			OMP_OPERATIONAL_AWS_PROFILE: trusted.profile,
			OMP_OPERATIONAL_AWS_REGION: trusted.region,
			OMP_OPERATIONAL_AWS_EXECUTABLE: trusted.executable,
			AWS_ACCESS_KEY_ID: "ambient-access-key",
			AWS_SECRET_ACCESS_KEY: "ambient-secret-key",
			AWS_SESSION_TOKEN: "ambient-session-token",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout) as {
			managed: Record<string, string | undefined>;
			generic: Record<string, string | undefined>;
		};
		expect(result.managed).toMatchObject({
			OMP_OPERATIONAL_AWS_CONFIG_FILE: trusted.configFile,
			OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: trusted.sharedCredentialsFile,
			OMP_OPERATIONAL_AWS_PROFILE: trusted.profile,
			OMP_OPERATIONAL_AWS_REGION: trusted.region,
			OMP_OPERATIONAL_AWS_EXECUTABLE: trusted.executable,
			OMP_OPERATIONAL_AWS_HOME_DIRECTORY: root,
		});
		for (const key of [
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_SESSION_TOKEN",
			"AWS_PROFILE",
			"AWS_REGION",
		]) {
			expect(result.managed[key]).toBeUndefined();
		}
		for (const key of [
			"OMP_OPERATIONAL_AWS_CONFIG_FILE",
			"OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE",
			"OMP_OPERATIONAL_AWS_PROFILE",
			"OMP_OPERATIONAL_AWS_REGION",
			"OMP_OPERATIONAL_AWS_EXECUTABLE",
			"OMP_OPERATIONAL_AWS_HOME_DIRECTORY",
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_SESSION_TOKEN",
			"AWS_PROFILE",
			"AWS_REGION",
		]) {
			expect(result.generic[key]).toBeUndefined();
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

// Regression for #3945: request() awaited stdin.write/flush, so a child that
// stops draining stdin would park the async fn past the timeout timer and past
// `return promise`, orphaning the deferred rejection and hanging the caller
// forever. `sleep` is POSIX-only, so the check is scoped to non-Windows hosts.
describe.skipIf(process.platform === "win32")("StdioTransport request write stall", () => {
	it("rejects with the timeout error when the child never drains stdin", async () => {
		const timeoutMs = 100;
		const orphaned: Error[] = [];
		const captureOrphan = (reason: unknown) => {
			if (reason instanceof Error) orphaned.push(reason);
		};
		process.on("unhandledRejection", captureOrphan);

		// `sleep 60` accepts a stdin pipe but never reads it; a 1 MB payload
		// overruns the OS pipe buffer plus any FileSink JS-side buffering, so
		// Bun's write() returns a Promise that only settles if the child reads.
		const transport = new StdioTransport({
			command: "sleep",
			args: ["60"],
			timeout: timeoutMs,
		});

		try {
			await transport.connect();

			const bigParam = "x".repeat(1024 * 1024);
			const started = performance.now();
			const outcome = await transport.request("tools/call", { name: "noop", arguments: { blob: bigParam } }).then(
				() => ({ kind: "resolved" as const }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			);
			const elapsedMs = performance.now() - started;

			expect(outcome.kind).toBe("rejected");
			if (outcome.kind !== "rejected") return;
			if (!(outcome.error instanceof Error)) {
				throw new Error(`expected Error rejection, got ${String(outcome.error)}`);
			}
			expect(outcome.error.message).toContain(`Request timeout after ${timeoutMs}ms`);
			// Generous ceiling: bare rejection latency plus room for slow CI. The
			// pre-fix behavior was an unbounded hang, not a slightly-late reject.
			expect(elapsedMs).toBeLessThan(timeoutMs + 1500);
			expect(orphaned).toEqual([]);
		} finally {
			process.off("unhandledRejection", captureOrphan);
			await transport.close();
		}
	}, 8000);

	it("settles caller cancellation while a write is blocked by an unread pipe", async () => {
		const transport = new StdioTransport({
			command: "sleep",
			args: ["60"],
			timeout: 0,
		});
		const tracker = trackUnhandled();
		try {
			await transport.connect();
			const controller = new AbortController();
			const pending = transport.request(
				"tools/call",
				{ name: "commit", arguments: { payload: "x".repeat(1024 * 1024) } },
				{ signal: controller.signal },
			);
			const reason = new Error("Caller cancelled a blocked write");
			controller.abort(reason);
			await expect(withTimeout(pending, 1_000, new Error("Blocked write ignored cancellation"))).rejects.toBe(
				reason,
			);
			await transport.close();
			expect(transport.connected).toBe(false);
			expect(tracker.capture()).toEqual([]);
		} finally {
			await transport.close();
			tracker.release();
		}
	}, 8000);
});

// `kill(pid, 0)` succeeds for a zombie too: a grandchild whose parent (the
// killed leader) is gone sits as <defunct> until whatever reaps orphans
// (init/subreaper) gets around to it — which can lag on some hosts. A
// zombie already received and honored the group SIGKILL; it is just not
// harvested yet, so treating it as "still alive" would make the group-kill
// assertions below flaky rather than testing what they claim to test.
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
	const state = result.stdout.toString().trim();
	return result.exitCode === 0 && state.length > 0 && !state.startsWith("Z");
}

// Regression for #5578: `close()` used a bare `this.#process.kill()` (direct
// SIGTERM, no wait, no escalate, no process-group signal), so a detached
// session-leader child (or a grandchild it spawned) that ignores/traps
// SIGTERM survived host exit and became an orphan pinned to PID 1 on Linux.
// `sleep`/`bun`/POSIX signal semantics are exercised directly here rather
// than through `StdioTransport.connect()`, because `connect()` derives
// `detached` from `resolveStdioSpawnCommand()`, which is tied to the host's
// real `process.platform` — a POSIX detached session cannot be reproduced
// end-to-end through `connect()` on a non-Linux dev/CI host, but a real
// detached process group can still be spawned directly on any POSIX host.
describe.skipIf(process.platform === "win32")("terminateStdioProcess", () => {
	const TEST_TERM_GRACE_MS = 50;
	it("escalates a detached child that traps SIGTERM to SIGKILL", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stdio-kill-solo-"));
		const scriptPath = path.join(tempDir, "child.mjs");
		const readyPath = path.join(tempDir, "ready");
		await fs.writeFile(
			scriptPath,
			[
				"import { writeFileSync } from 'node:fs';",
				"process.on('SIGTERM', () => {});",
				`writeFileSync(${JSON.stringify(readyPath)}, '1');`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);
		const proc = Bun.spawn([process.execPath, scriptPath], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		try {
			// Wait for the child to actually register its SIGTERM handler before
			// signaling it: signaling too early races the child's startup and
			// hits the default (terminate) action instead of exercising the trap.
			for (let i = 0; i < 100; i++) {
				try {
					await fs.access(readyPath);
					break;
				} catch {
					await Bun.sleep(20);
				}
			}

			const started = performance.now();
			await terminateStdioProcess(proc, true, process.platform, TEST_TERM_GRACE_MS);
			await proc.exited;
			const elapsedMs = performance.now() - started;

			expect(proc.signalCode).toBe("SIGKILL");
			// The injected test grace preserves the production transition without
			// making this subprocess boundary test sleep for the full 1s window.
			expect(elapsedMs).toBeGreaterThanOrEqual(TEST_TERM_GRACE_MS - 15);
		} finally {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 5000);

	it("reaches a SIGTERM-trapping grandchild through the group SIGKILL, not just the direct child", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stdio-group-kill-"));
		const grandchildScriptPath = path.join(tempDir, "grandchild.mjs");
		const parentScriptPath = path.join(tempDir, "parent.mjs");
		const grandchildPidPath = path.join(tempDir, "grandchild.pid");

		// Grandchild also traps SIGTERM, so only an unrestricted SIGKILL to the
		// whole group — not a signal to the direct (parent) child alone — can
		// reach and stop it.
		await fs.writeFile(
			grandchildScriptPath,
			[
				"import { writeFileSync } from 'node:fs';",
				"process.on('SIGTERM', () => {});",
				`writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);
		await fs.writeFile(
			parentScriptPath,
			[
				"process.on('SIGTERM', () => {});",
				`Bun.spawn([process.execPath, ${JSON.stringify(grandchildScriptPath)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);

		const proc = Bun.spawn([process.execPath, parentScriptPath], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});

		try {
			// Polls real wall-clock time rather than an event/promise: the
			// grandchild process is a real external OS process writing to a real
			// file, with no in-process signal this test can `await` directly.
			let grandchildPid: number | undefined;
			for (let i = 0; i < 100 && grandchildPid === undefined; i++) {
				try {
					grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);
				} catch {
					await Bun.sleep(20);
				}
			}
			if (grandchildPid === undefined) throw new Error("grandchild never reported its pid");
			expect(processExists(grandchildPid)).toBe(true);

			await terminateStdioProcess(proc, true, process.platform, TEST_TERM_GRACE_MS);
			await proc.exited;
			expect(proc.signalCode).toBe("SIGKILL");

			// The group SIGKILL is delivered to every member simultaneously, but
			// give the kernel a brief window to finish reaping before asserting.
			let grandchildAlive = processExists(grandchildPid);
			for (let i = 0; i < 25 && grandchildAlive; i++) {
				await Bun.sleep(20);
				grandchildAlive = processExists(grandchildPid);
			}
			expect(grandchildAlive).toBe(false);
		} finally {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 8000);

	it("still reaps a SIGTERM-trapping grandchild after the detached leader exits cooperatively", async () => {
		// Regression: the leader exiting within the SIGTERM grace window used to
		// be treated as proof the whole process group was gone, so `close()`
		// returned early and never delivered a group SIGKILL — leaving exactly
		// the orphaned grandchild this change is meant to reap. Unlike the
		// group-SIGKILL test above, the leader here does NOT trap SIGTERM, so
		// it exits promptly on its own; only the grandchild ignores signals.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stdio-leader-exit-group-kill-"));
		const grandchildScriptPath = path.join(tempDir, "grandchild.mjs");
		const parentScriptPath = path.join(tempDir, "parent.mjs");
		const grandchildPidPath = path.join(tempDir, "grandchild.pid");

		await fs.writeFile(
			grandchildScriptPath,
			[
				"import { writeFileSync } from 'node:fs';",
				"process.on('SIGTERM', () => {});",
				`writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);
		// No SIGTERM handler here: the default action (terminate) fires as soon
		// as the group SIGTERM lands, well inside TERM_GRACE_MS.
		await fs.writeFile(
			parentScriptPath,
			[
				`Bun.spawn([process.execPath, ${JSON.stringify(grandchildScriptPath)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });`,
				"setInterval(() => {}, 60_000);",
			].join("\n"),
		);

		const proc = Bun.spawn([process.execPath, parentScriptPath], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});

		try {
			let grandchildPid: number | undefined;
			for (let i = 0; i < 100 && grandchildPid === undefined; i++) {
				try {
					grandchildPid = Number.parseInt(await fs.readFile(grandchildPidPath, "utf8"), 10);
				} catch {
					await Bun.sleep(20);
				}
			}
			if (grandchildPid === undefined) throw new Error("grandchild never reported its pid");
			expect(processExists(grandchildPid)).toBe(true);

			const started = performance.now();
			await terminateStdioProcess(proc, true, process.platform, TEST_TERM_GRACE_MS);
			await proc.exited;
			const elapsedMs = performance.now() - started;

			// The leader exits on the initial SIGTERM (no trap), so this must not
			// block for the ~1s TERM grace window before sweeping the group.
			expect(elapsedMs).toBeLessThan(700);

			let grandchildAlive = processExists(grandchildPid);
			for (let i = 0; i < 25 && grandchildAlive; i++) {
				await Bun.sleep(20);
				grandchildAlive = processExists(grandchildPid);
			}
			expect(grandchildAlive).toBe(false);
		} finally {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	}, 8000);

	it("never attempts a process-group signal when the transport did not spawn detached", async () => {
		const proc = Bun.spawn(["bun", "-e", "await Bun.sleep(60_000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: false,
		});
		const killSpy = spyOn(process, "kill");
		try {
			await terminateStdioProcess(proc, false);
			await proc.exited;

			// Only the direct-child `Subprocess.kill()` path may run; the global
			// `process.kill()` (used exclusively for the negative-pid group
			// signal) must never be reached.
			expect(killSpy).not.toHaveBeenCalled();
		} finally {
			killSpy.mockRestore();
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}, 5000);
});

describe.skipIf(process.platform === "win32")("StdioTransport.close teardown", () => {
	it("closes a well-behaved child promptly without escalating to SIGKILL", async () => {
		const transport = new StdioTransport({
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});
		try {
			await transport.connect();
			const started = performance.now();
			await transport.close();
			const elapsedMs = performance.now() - started;

			// No SIGTERM trap => the child dies almost immediately; close() must
			// not block for the full ~1s TERM grace window before returning.
			expect(elapsedMs).toBeLessThan(700);
		} finally {
			await transport.close();
		}
	}, 5000);
});
