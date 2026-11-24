import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as natives from "@oh-my-pi/pi-natives";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode restart authorization and source startup", () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restart-owned-"));
		for (const directory of ["neutral", "initial-project", "hostile-project"]) {
			await fs.mkdir(path.join(root, directory));
		}
		await Bun.write(path.join(root, "initial-project", "overlay.yml"), "defaultThinkingLevel: high\n");
		await Bun.write(path.join(root, "initial-project", "managed.yml"), "defaultThinkingLevel: low\n");
		await Bun.write(path.join(root, "hostile-project", "overlay.yml"), "defaultThinkingLevel: medium\n");
		await Bun.write(path.join(root, "hostile-project", "managed.yml"), "defaultThinkingLevel: high\n");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function runRestart(policy: "unpooled" | "active" | "released", spawn = false) {
		const hostileMarker = path.join(root, "hostile-preload-ran");
		const trustedMarker = path.join(root, "trusted-preload-runs");
		const trustedPreload = path.join(root, "trusted.mjs");
		const envShimMarker = path.join(root, "env-shim-ran");
		const fakeBin = path.join(root, "hostile-bin");
		await fs.mkdir(fakeBin);
		if (process.platform !== "win32") {
			const envShim = path.join(fakeBin, "env");
			const quotedMarker = `'${envShimMarker.replaceAll("'", "'\\''")}'`;
			await Bun.write(envShim, `#!/bin/sh\n: > ${quotedMarker}\nexit 91\n`);
			await fs.chmod(envShim, 0o700);
		}
		const initialFile = path.join(root, "initial.json");
		const replacementFile = path.join(root, "replacement.json");
		const cwd = path.join(root, "initial-project");
		const neutral = path.join(root, "neutral");
		const shim = path.resolve(import.meta.dir, "../scripts/omp.ts");
		const observer = `
if (existsSync(${JSON.stringify(initialFile)})) {
	const startup = { cwd: process.cwd(), launchCwd: process.env.OMP_LAUNCH_CWD, runtimeArgs: process.execArgv, argv: process.argv.slice(2), dotenv: process.env.OMP_RESTART_HOSTILE_DOTENV, pid: process.pid };
	// This test observes startup before loading the controlled settings consumer.
	await import(${JSON.stringify(shim)});
	const { parseArgs } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/cli/args.ts"))});
	const parsed = parseArgs(process.argv.slice(2));
	const effectiveCwd = parsed.cwd ?? process.cwd();
	const { Settings } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/config/settings.ts"))});
	const { cfgDefaultThinkingLevel } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/session/settings.ts"))});
	const settings = await Settings.loadReadOnly({ cwd: effectiveCwd, configFiles: parsed.config });
	writeFileSync(${JSON.stringify(replacementFile)}, JSON.stringify({ ...startup, effectiveCwd, thinking: cfgDefaultThinkingLevel.get(settings) }));
	process.exit(0);
}`;
		await Bun.write(
			trustedPreload,
			`import { appendFileSync, existsSync, writeFileSync } from "node:fs"; appendFileSync(${JSON.stringify(trustedMarker)}, "x"); ${observer}`,
		);
		await Bun.write(
			path.join(root, "hostile-project", "hostile.mjs"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(hostileMarker)}, "project preload executed");`,
		);
		await Bun.write(path.join(root, "hostile-project", "bunfig.toml"), 'preload = ["./hostile.mjs"]\n');
		await Bun.write(path.join(root, "hostile-project", ".env"), "OMP_RESTART_HOSTILE_DOTENV=project-dotenv-loaded\n");
		const child = Bun.spawn(
			[
				process.execPath,
				"--smol",
				"--cwd",
				neutral,
				"--no-env-file",
				"--preload",
				trustedPreload,
				"--preload",
				shim,
				path.join(import.meta.dir, "helpers/restart-driver.ts"),
				"--cwd",
				cwd,
				"--config",
				"./overlay.yml",
				"--session-dir",
				"./stale-session-directory",
			],
			{
				cwd: neutral,
				env: {
					HOME: root,
					PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
					GIT_OPTIONAL_LOCKS: "0",
					OMP_LAUNCH_CWD: cwd,
					OMP_MANAGED_CONFIG_FILE: "./managed.yml",
					OMP_RESTART_TEST_ROOT: root,
					OMP_RESTART_TEST_POLICY: policy,
					OMP_RESTART_TEST_SPAWN: spawn ? "1" : "0",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20000,
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
		return {
			initial: await Bun.file(initialFile).json(),
			replacement: await Bun.file(replacementFile)
				.json()
				.catch(() => undefined),
			returned: await Bun.file(path.join(root, "returned.json"))
				.json()
				.catch(() => undefined),
			hostileRan: await Bun.file(hostileMarker).exists(),
			envShimRan: await Bun.file(envShimMarker).exists(),
			trustedRuns: (await Bun.file(trustedMarker).text()).length,
		};
	}

	it.each(["active", "released"] as const)(
		"refuses a real %s OAuth pool before teardown or process replacement",
		async policy => {
			const result = await runRestart(policy);
			expect(result.replacement).toBeUndefined();
			expect(result.returned).toMatchObject({
				isDisposed: false,
				isShuttingDown: false,
				sessionId: result.initial.sessionId,
				unchangedTranscript: true,
				credentialsAllowed: false,
			});
			expect(result.returned.errors).toHaveLength(1);
			expect(result.trustedRuns).toBe(1);
			expect(result.hostileRan).toBe(false);
			expect(result.envShimRan).toBe(false);
		},
		25000,
	);

	it.each([false, true])(
		"preserves trusted startup, moved cwd, resume and managed settings with spawn fallback=%s",
		async spawn => {
			const result = await runRestart("unpooled", spawn);
			expect(result.returned).toBeUndefined();
			expect(result.hostileRan).toBe(false);
			expect(result.envShimRan).toBe(false);
			expect(result.trustedRuns).toBe(2);
			expect(result.replacement.dotenv).toBeUndefined();
			expect(result.replacement.cwd).not.toBe(path.join(root, "hostile-project"));
			expect(result.replacement.launchCwd).toBe(path.join(root, "hostile-project"));
			expect(result.replacement.effectiveCwd).toBe(path.join(root, "hostile-project"));
			expect(result.initial.managedConfigFile).toBe(path.join(root, "initial-project", "managed.yml"));
			expect(result.initial.thinking).toBe("low");
			expect(result.replacement.thinking).toBe("low");
			expect(result.replacement.runtimeArgs).toContain("--smol");
			const parsed = parseArgs(result.replacement.argv);
			expect(parsed.resume).toBe(path.resolve(result.initial.sessionFile));
			expect(parsed.cwd).toBe(path.join(root, "hostile-project"));
			expect(path.isAbsolute(parsed.sessionDir!)).toBe(true);
			const transcript = (await Bun.file(result.initial.sessionFile).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(
				transcript.some(
					entry =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						entry.message.content === "owned restart transcript",
				),
			).toBe(true);
			if (spawn || process.platform === "win32") expect(result.replacement.pid).not.toBe(result.initial.pid);
			else expect(result.replacement.pid).toBe(result.initial.pid);
		},
		25000,
	);
});

describe("InteractiveMode restart", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession | undefined;
	let originalArgv: string[];

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-restart-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		originalArgv = process.argv;
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "persona sessions"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.argv = originalArgv;
		await session?.dispose();
		session = undefined;
		await sessionManager.close();
		await authStorage.close();
		closeModelCache();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	async function restart(argv: string[]): Promise<string[]> {
		const modelRegistry = new ModelRegistry(authStorage, undefined, { cacheDbPath: tempDir.join("models.db") });
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = () => {};
		mode.ui.terminal.drainInput = async () => {};
		process.argv = [originalArgv[0], originalArgv[1], ...argv];
		// Stop only at the process replacement boundary; teardown and argv production run for real.
		const exec = vi.spyOn(natives, "execReplace").mockImplementation(() => undefined as never);
		const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({ exited: Promise.resolve(0) } as never);
		vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		vi.spyOn(postmortem, "drainStdout").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		await mode.restart();
		const command = process.platform === "win32" ? spawn.mock.calls[0]?.[0] : exec.mock.calls[0]?.[1];
		if (!Array.isArray(command)) throw new Error("expected replacement command");
		return command;
	}

	it("resumes an explicitly opened persona journal without rediscovering its ID", async () => {
		sessionManager.appendMessage({ role: "user", content: "initial request", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			content: [{ type: "text", text: "saved answer" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			timestamp: 2,
		});
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const transcript = sessionManager.buildSessionContext().messages;
		await sessionManager.close();
		sessionManager = await SessionManager.open(file);
		const command = await restart([
			"--session",
			file,
			"--model",
			"anthropic/claude-sonnet-4-5",
			"--append-system-prompt",
			"persona prompt",
			"--skills",
			"/office/skills",
			"-e",
			"/office/extension.ts",
			"--model",
			"openai-codex/gpt-6.1-sol:high",
			"initial request",
		]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.model).toBe("openai-codex/gpt-6.1-sol:high");
		expect(parsed.messages).toEqual([]);
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(file);
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual(transcript);
		} finally {
			await resumed.close();
		}
	});

	it("resumes a journal created in a flag-looking relative directory", async () => {
		using relativeDir = TempDir.createSync("-omp-restart-");
		await sessionManager.close();
		sessionManager = SessionManager.create(tempDir.path(), relativeDir.path());
		sessionManager.appendMessage({ role: "user", content: "saved request", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", `--session-dir=${relativeDir.path()}`]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(file));
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual([
				{ role: "user", content: "saved request", timestamp: 1 },
			]);
		} finally {
			await resumed.close();
		}
	});

	it("does not resume a journal that has never materialized", async () => {
		const file = sessionManager.getSessionFile();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", "initial request"]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.resume).toBeUndefined();
		expect(parsed.messages).toEqual([]);
		expect(sessionManager.isSessionOnDisk()).toBe(false);
		if (!file) throw new Error("expected allocated journal path");
		expect(await Bun.file(file).exists()).toBe(false);
	});
});
