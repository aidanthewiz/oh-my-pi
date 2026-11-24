import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { cfgShellPath } from "@oh-my-pi/pi-coding-agent/exec/settings";
import type {
	ExtensionRunner,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { closeDaemonClient, isolateDaemonForSmokeTest } from "@oh-my-pi/pi-coding-agent/daemon/client";
import { stopService } from "@oh-my-pi/pi-coding-agent/launch/services";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const DCG_ENV_KEYS = [
	"OMP_DCG_PATH",
	"OMP_DCG_VERSION",
	"OMP_DCG_BINARY_SHA256",
	"OMP_DCG_CONFIG",
	"OMP_DCG_CONFIG_SHA256",
	"PI_NO_PTY",
] as const;

describe.skipIf(process.platform === "win32")("DCG runtime approval", () => {
	let tempDir: string;
	let settings: Settings;
	let tool: BashTool;
	let session: ToolSession;
	let previousEnv: Record<string, string | undefined>;
	let cleanupDaemon: (() => Promise<void>) | undefined;

	beforeAll(async () => {
		previousEnv = Object.fromEntries(DCG_ENV_KEYS.map(key => [key, process.env[key]]));
		delete process.env.PI_NO_PTY;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dcg-runtime-"));
		cleanupDaemon = await isolateDaemonForSmokeTest();
		const dcgPath = path.join(tempDir, "dcg-ask.ts");
		const dcgProgram = `#!/usr/bin/env bun
const command = await Bun.stdin.text();
const expectedDialect = command.includes("expected-cmd")
	? "cmd"
	: command.includes("expected-ps") ? "ps" : "posix";
const expectedArgs = [
	"--robot", "test", "--stdin", "--agent", "omp", "--dialect", expectedDialect,
	"--format", "json", "--omp-bridge-output",
];
const actualArgs = process.argv.slice(2);
if (JSON.stringify(actualArgs) !== JSON.stringify(expectedArgs)) {
	console.error(\`unexpected arguments: \${JSON.stringify(actualArgs)}\`);
	process.exit(3);
}
if (command.includes("guard-virtual-cwd")) {
	if (!process.cwd().endsWith("/work")) {
		console.log(JSON.stringify({ decision: "deny", reason: "guard did not inspect the virtual directory's host path" }));
		process.exit(1);
	}
	console.log(JSON.stringify({ decision: "allow" }));
	process.exit(0);
}
if (command.includes("svc-deny")) {
	console.log(JSON.stringify({ decision: "deny", rule_id: "strict_service:deny", reason: "blocked service" }));
	process.exit(1);
}
if (command.includes("svc-allow")) {
	console.log(JSON.stringify({ decision: "allow" }));
	process.exit(0);
}
console.log(JSON.stringify({
	decision: "ask",
	rule_id: "strict_git:worktree-remove",
	reason: "git worktree remove deletes a linked working tree.",
}));
process.exit(1);
`;
		fs.writeFileSync(dcgPath, dcgProgram, { mode: 0o755 });
		const configPath = path.join(tempDir, "dcg.toml");
		const config = '[packs]\nenabled = ["strict_git"]\n';
		fs.writeFileSync(configPath, config);
		Object.assign(process.env, {
			OMP_DCG_PATH: dcgPath,
			OMP_DCG_VERSION: "0.6.7",
			OMP_DCG_BINARY_SHA256: createHash("sha256").update(dcgProgram).digest("hex"),
			OMP_DCG_CONFIG: configPath,
			OMP_DCG_CONFIG_SHA256: createHash("sha256").update(config).digest("hex"),
		});

		settings = Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"tools.approvalMode": "yolo",
		});
		session = {
			cwd: tempDir,
			hasUI: true,
			settings,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "dcg-runtime-test",
			getArtifactsDir: () => path.join(tempDir, "artifacts"),
		} as unknown as ToolSession;
		tool = new BashTool(session);
	});

	afterAll(async () => {
		await cleanupDaemon?.();
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		removeSyncWithRetries(tempDir);
	});

	function runner(
		select: (
			prompt: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		) => string | undefined,
	): ExtensionRunner {
		return {
			sessionId: "dcg-runtime-test",
			runScoped: <T>(fn: () => T): T => fn(),
			hasHandlers: () => false,
			hasUI: () => true,
			consumeToolCallEmitted: () => false,
			getUIContext: () => ({
				select: async (
					prompt: string,
					options: ExtensionUISelectItem[],
					dialogOptions?: ExtensionUIDialogOptions,
				) => select(prompt, options, dialogOptions),
			}),
		} as unknown as ExtensionRunner;
	}

	function headlessUi(): NonNullable<AgentToolContext["ui"]> {
		return {
			custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
				return new Promise<T>(resolve => {
					factory(
						{
							terminal: { columns: 80, rows: 24 },
							requestRender() {},
						},
						{},
						{},
						resolve,
					);
				});
			},
		} as unknown as NonNullable<AgentToolContext["ui"]>;
	}

	it("guards local embedded PTY commands as POSIX regardless of the external shell setting", async () => {
		for (const [shellName, dialect] of [
			["cmd.exe", "cmd"],
			["pwsh", "ps"],
		] as const) {
			const shellPath = path.join(tempDir, shellName);
			fs.writeFileSync(shellPath, "#!/bin/sh\n", { mode: 0o755 });
			const routeSettings = Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				shellPath,
				"tools.approvalMode": "yolo",
			});
			const routeSession = {
				cwd: tempDir,
				hasUI: true,
				settings: routeSettings,
				skills: [],
				getSessionFile: () => null,
				getSessionId: () => `dcg-${dialect}-test`,
				getArtifactsDir: () => path.join(tempDir, "artifacts"),
			} as unknown as ToolSession;
			const routeTool = new BashTool(routeSession);
			const approval = await routeTool.prepareRuntimeApproval(
				`dcg-${dialect}-call`,
				{ command: "printf native-posix", cwd: tempDir, pty: true },
				undefined,
				{ hasUI: true, ui: {} } as AgentToolContext,
			);
			expect(approval?.prompt).toContain("strict_git:worktree-remove");
		}
	});

	it("guards a URL working directory from its backed host path before executing", async () => {
		const localRoot = resolveLocalRoot({
			getArtifactsDir: () => path.join(tempDir, "artifacts"),
			getSessionId: () => "dcg-runtime-test",
		});
		fs.mkdirSync(path.join(localRoot, "work"), { recursive: true });

		const result = await tool.execute("virtual-cwd", {
			command: "printf guard-virtual-cwd",
			cwd: "local://work",
			pty: false,
		});
		expect(result.isError).toBeUndefined();
		expect(result.content.find(item => item.type === "text")?.text).toContain("guard-virtual-cwd");
	});

	it("refuses an unbacked virtual cwd when DCG cannot evaluate relative paths", async () => {
		await expect(
			tool.execute("virtual-cwd-unbacked", { command: "printf guard-virtual-cwd", cwd: "omp://", pty: false }),
		).rejects.toThrow("Destructive Command Guard cannot verify a working directory without host backing");
	});

	it("invalidates approval when the client terminal route changes before execution", async () => {
		const shellDir = path.join(tempDir, "route-change-shell");
		fs.mkdirSync(shellDir);
		const shellPath = path.join(shellDir, "cmd.exe");
		fs.writeFileSync(shellPath, "#!/bin/sh\n", { mode: 0o755 });
		const routeSettings = Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			shellPath,
			"tools.approvalMode": "yolo",
		});
		let clientBridge: ClientBridge | undefined = {
			capabilities: { terminal: true },
			createTerminal: async () => {
				throw new Error("reviewed client terminal must not be reached after its route changes");
			},
		};
		const marker = path.join(tempDir, "route-change-executed");
		const routeSession = {
			cwd: tempDir,
			hasUI: false,
			settings: routeSettings,
			skills: [],
			getClientBridge: () => clientBridge,
			getSessionFile: () => null,
			getSessionId: () => "dcg-route-change-test",
			getArtifactsDir: () => path.join(tempDir, "artifacts"),
		} as unknown as ToolSession;
		const routeTool = new BashTool(routeSession);
		const args: BashToolInput = {
			command: `printf expected-cmd > '${marker}'`,
			cwd: tempDir,
		};
		const toolCallId = "dcg-route-change-call";

		const approval = await routeTool.prepareRuntimeApproval(toolCallId, args);
		expect(approval?.prompt).toContain("strict_git:worktree-remove");
		routeTool.approveRuntimeApproval(toolCallId, args);
		clientBridge = undefined;

		await expect(routeTool.execute(toolCallId, args)).rejects.toThrow(
			"Bash execution route or shell changed after safety review",
		);
		expect(fs.existsSync(marker)).toBeFalse();
	});

	it("invalidates approval when the client terminal shell changes before execution", async () => {
		const shellDir = path.join(tempDir, "settings-change-shell");
		fs.mkdirSync(shellDir);
		const cmdPath = path.join(shellDir, "cmd.exe");
		const psPath = path.join(shellDir, "pwsh");
		fs.writeFileSync(cmdPath, "#!/bin/sh\n", { mode: 0o755 });
		fs.writeFileSync(psPath, "#!/bin/sh\n", { mode: 0o755 });
		const routeSettings = Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			shellPath: cmdPath,
			"tools.approvalMode": "yolo",
		});
		const clientBridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => {
				throw new Error("reviewed client terminal must not start with a different shell");
			},
		};
		const routeSession = {
			cwd: tempDir,
			hasUI: false,
			settings: routeSettings,
			skills: [],
			getClientBridge: () => clientBridge,
			getSessionFile: () => null,
			getSessionId: () => "dcg-shell-change-test",
			getArtifactsDir: () => path.join(tempDir, "artifacts"),
		} as unknown as ToolSession;
		const routeTool = new BashTool(routeSession);
		const args: BashToolInput = { command: "printf expected-cmd", cwd: tempDir };
		const toolCallId = "dcg-shell-change-call";

		const approval = await routeTool.prepareRuntimeApproval(toolCallId, args);
		expect(approval?.prompt).toContain("strict_git:worktree-remove");
		routeTool.approveRuntimeApproval(toolCallId, args);
		cfgShellPath.override(routeSettings, psPath);

		await expect(routeTool.execute(toolCallId, args)).rejects.toThrow(
			"Bash execution route or shell changed after safety review",
		);
	});

	it("runs a local PTY in the reviewed embedded shell, not the external shell setting", async () => {
		const marker = path.join(tempDir, "prepared-pty-shell");
		const externalMarker = path.join(tempDir, "unreviewed-external-shell");
		const shellDir = path.join(tempDir, "isolated-pty-shell");
		fs.mkdirSync(shellDir);
		const shellPath = path.join(shellDir, "pwsh");
		fs.writeFileSync(shellPath, `#!/bin/sh\nprintf external > '${externalMarker}'\nexit 0\n`, { mode: 0o755 });
		const routeSettings = Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			shellPath,
			"tools.approvalMode": "yolo",
		});
		const routeSession = {
			cwd: tempDir,
			hasUI: true,
			settings: routeSettings,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "dcg-isolated-pty-test",
			getArtifactsDir: () => path.join(tempDir, "artifacts"),
		} as unknown as ToolSession;
		const routeTool = new BashTool(routeSession);
		const ui = headlessUi();
		const context = { hasUI: true, ui } as AgentToolContext;
		const args: BashToolInput = { command: `printf embedded > '${marker}'`, cwd: tempDir, pty: true };
		const toolCallId = "dcg-isolated-pty-call";

		const approval = await routeTool.prepareRuntimeApproval(toolCallId, args, undefined, context);
		expect(approval?.prompt).toContain("strict_git:worktree-remove");
		routeTool.approveRuntimeApproval(toolCallId, args);
		await routeTool.execute(toolCallId, args, undefined, undefined, context);

		expect(fs.readFileSync(marker, "utf8")).toBe("embedded");
		expect(fs.existsSync(externalMarker)).toBe(false);
	});

	it("uses the native approval selector, notifies the terminal, and executes only after approval", async () => {
		const args: BashToolInput = {
			command: "printf runtime-approved > local://nested/result.txt",
			cwd: tempDir,
			timeout: 30,
		};
		const resultPath = path.join(tempDir, "artifacts", "local", "nested", "result.txt");
		const events: string[] = [];
		const sendNotification = spyOn(TERMINAL, "sendNotification").mockImplementation(() => {
			events.push("notification");
		});
		let review = "";
		const wrapped = new ExtensionToolWrapper(
			tool as unknown as AgentTool,
			runner((prompt, options, dialogOptions) => {
				events.push("selector");
				review = prompt;
				expect(options).toEqual(["Deny", "Approve once"]);
				expect(dialogOptions?.tuiStyle).toBe("destructive");
				expect(fs.existsSync(path.dirname(resultPath))).toBeFalse();
				return "Approve once";
			}),
		);

		try {
			await wrapped.execute("approved-call", args, undefined, undefined, {
				settings,
			} as AgentToolContext);
			expect(events).toEqual(["notification", "selector"]);
			expect(sendNotification).toHaveBeenCalledWith(
				expect.objectContaining({ type: "approval", urgency: "normal", actions: "focus" }),
			);
			expect(fs.readFileSync(resultPath, "utf8")).toBe("runtime-approved");
			expect(review).toContain("WARNING: This command requires explicit review before execution.");
			expect(review).toContain("strict_git:worktree-remove");
			expect(review).toContain("git worktree remove deletes a linked working tree.");
			expect(review).toContain(JSON.stringify(tempDir));
			expect(review).toContain(JSON.stringify(args.command));
			expect(review).toContain("newlines and control characters are escaped");
			expect(review).toContain("Only choose Approve once if this exact command is intended.");

			await expect(tool.execute("approved-call", args)).rejects.toThrow(/requires interactive approval/u);
		} finally {
			sendNotification.mockRestore();
		}
	});

	it("does not execute either command when review rejects changed input", async () => {
		const sendNotification = spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const originalPath = path.join(tempDir, "rejected-original.txt");
		const changedPath = path.join(tempDir, "rejected-changed.txt");
		const originalCommand = `printf original > ${JSON.stringify(originalPath)}`;
		const changedCommand = `printf changed > ${JSON.stringify(changedPath)}`;
		const args: BashToolInput = { command: originalCommand, cwd: tempDir };
		const reviews: string[] = [];
		const wrapped = new ExtensionToolWrapper(
			tool as unknown as AgentTool,
			runner(prompt => {
				reviews.push(prompt);
				if (reviews.length === 1) {
					args.command = changedCommand;
					return "Approve once";
				}
				return "Deny";
			}),
		);

		try {
			await expect(
				wrapped.execute("changed-denied-call", args, undefined, undefined, { settings } as AgentToolContext),
			).rejects.toThrow(/denied by user/u);
			expect(reviews).toHaveLength(2);
			expect(reviews[0]).toContain(JSON.stringify(originalCommand));
			expect(reviews[1]).toContain(JSON.stringify(changedCommand));
			expect(fs.existsSync(originalPath)).toBeFalse();
			expect(fs.existsSync(changedPath)).toBeFalse();
		} finally {
			sendNotification.mockRestore();
		}
	});

	it("executes only changed input after its separate approval", async () => {
		const sendNotification = spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const originalPath = path.join(tempDir, "approved-original.txt");
		const changedPath = path.join(tempDir, "approved-changed.txt");
		const originalCommand = `printf original > ${JSON.stringify(originalPath)}`;
		const changedCommand = `printf changed > ${JSON.stringify(changedPath)}`;
		const args: BashToolInput = { command: originalCommand, cwd: tempDir };
		const reviews: string[] = [];
		const wrapped = new ExtensionToolWrapper(
			tool as unknown as AgentTool,
			runner(prompt => {
				reviews.push(prompt);
				if (reviews.length === 1) args.command = changedCommand;
				return "Approve once";
			}),
		);

		try {
			await wrapped.execute("changed-approved-call", args, undefined, undefined, {
				settings,
			} as AgentToolContext);
			expect(reviews).toHaveLength(2);
			expect(reviews[0]).toContain(JSON.stringify(originalCommand));
			expect(reviews[1]).toContain(JSON.stringify(changedCommand));
			expect(fs.existsSync(originalPath)).toBeFalse();
			expect(fs.readFileSync(changedPath, "utf8")).toBe("changed");
		} finally {
			sendNotification.mockRestore();
		}
	});

	it("does not execute after a denied or cancelled native approval", async () => {
		const sendNotification = spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		try {
			for (const selection of ["Deny", undefined]) {
				const args: BashToolInput = { command: "printf must-not-run", cwd: tempDir };
				const wrapped = new ExtensionToolWrapper(
					tool as unknown as AgentTool,
					runner(() => selection),
				);

				await expect(
					wrapped.execute(`denied-call-${String(selection)}`, args, undefined, undefined, {
						settings,
					} as AgentToolContext),
				).rejects.toThrow(/denied by user/u);
				await expect(tool.execute(`denied-call-${String(selection)}`, args)).rejects.toThrow(
					/requires interactive approval/u,
				);
			}
		} finally {
			sendNotification.mockRestore();
		}
	});

	it("honors disabled approval notifications without skipping the review", async () => {
		const silentSettings = Settings.isolated({
			"approval.notify": "off",
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"tools.approvalMode": "yolo",
		});
		const sendNotification = spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		let prompted = false;
		const wrapped = new ExtensionToolWrapper(
			tool as unknown as AgentTool,
			runner((_prompt, options) => {
				prompted = true;
				expect(options).toEqual(["Deny", "Approve once"]);
				return "Deny";
			}),
		);

		try {
			await expect(
				wrapped.execute("silent-call", { command: "printf must-not-run", cwd: tempDir }, undefined, undefined, {
					settings: silentSettings,
				} as AgentToolContext),
			).rejects.toThrow(/denied by user/u);
			expect(prompted).toBeTrue();
			expect(sendNotification).not.toHaveBeenCalled();
		} finally {
			sendNotification.mockRestore();
		}
	});

	it("fails closed when runtime approval has no interactive UI", async () => {
		const args: BashToolInput = { command: "printf headless-must-not-run", cwd: tempDir };
		const headlessRunner = {
			hasHandlers: () => false,
			hasUI: () => false,
			consumeToolCallEmitted: () => false,
		} as unknown as ExtensionRunner;
		const wrapped = new ExtensionToolWrapper(tool as unknown as AgentTool, headlessRunner);

		await expect(
			wrapped.execute("headless-call", args, undefined, undefined, { settings } as AgentToolContext),
		).rejects.toThrow(/runtime approval but no interactive UI/u);
	});
	it("blocks a denied named service before the broker can launch it", async () => {
		const marker = path.join(tempDir, "denied-service-started");
		const args: BashToolInput = {
			command: `printf svc-deny > '${marker}'`,
			cwd: tempDir,
			name: "denied-service",
			pty: false,
		};

		await expect(tool.prepareRuntimeApproval("service-deny", args)).rejects.toThrow(
			"Command blocked by Destructive Command Guard (strict_service:deny)",
		);
		await expect(tool.execute("service-deny", args)).rejects.toThrow(
			"Command blocked by Destructive Command Guard (strict_service:deny)",
		);
		expect(fs.existsSync(marker)).toBeFalse();
	});

	it("requires exact approval for named services and supervises an approved process", async () => {
		const args: BashToolInput = {
			command: "printf svc-ask; sleep 20",
			cwd: tempDir,
			name: "approved-service",
			pty: false,
			ready: { log: "svc-ask", timeout: 5 },
		};
		const approval = await tool.prepareRuntimeApproval("service-ask", args);
		expect(approval?.prompt).toContain("named service");
		expect(approval?.prompt).toContain("svc-ask");
		await expect(tool.execute("service-ask", args)).rejects.toThrow(/requires interactive approval/u);

		const reviewed = await tool.prepareRuntimeApproval("service-ask-approved", args);
		expect(reviewed?.prompt).toContain("strict_git:worktree-remove");
		tool.approveRuntimeApproval("service-ask-approved", args);
		try {
			const result = await tool.execute("service-ask-approved", args);
			expect(result.details?.service).toMatchObject({ name: "approved-service", ready: true, timedOut: false });
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("svc-ask") });
		} finally {
			await stopService(session, "approved-service").catch(() => undefined);
			await closeDaemonClient();
		}
	});

	it("starts services with one reviewed shell prefix and the prepared shell environment", async () => {
		const prefixMarker = path.join(tempDir, "service-prefix-count");
		const envMarker = path.join(tempDir, "service-shell-environment");
		const serviceSettings = Settings.isolated({ "launch.enabled": true, "bashInterceptor.enabled": false });
		const shell = serviceSettings.getShellConfig();
		const shellConfig = spyOn(serviceSettings, "getShellConfig").mockReturnValue({
			...shell,
			shell: "/bin/sh",
			args: ["-c"],
			prefix: `printf p >> '${prefixMarker}';`,
			env: { ...shell.env, PI_BASH_PREFIX_TEST: "prepared" },
		});
		const serviceSession = { ...session, settings: serviceSettings } as ToolSession;
		const serviceTool = new BashTool(serviceSession);
		try {
			const result = await serviceTool.execute("service-prefix", {
				command: `printf '%s' "$PI_BASH_PREFIX_TEST" > '${envMarker}'; printf svc-allow; sleep 20`,
				cwd: tempDir,
				name: "prefix-once-service",
				pty: false,
				ready: { log: "svc-allow", timeout: 5 },
			});
			expect(result.details?.service).toMatchObject({ ready: true, timedOut: false });
			expect(fs.readFileSync(prefixMarker, "utf8")).toBe("p");
			expect(fs.readFileSync(envMarker, "utf8")).toBe("prepared");
		} finally {
			await stopService(serviceSession, "prefix-once-service").catch(() => undefined);
			await closeDaemonClient();
			shellConfig.mockRestore();
		}
	});

	it("invalidates a service approval when its name or readiness changes", async () => {
		const marker = path.join(tempDir, "changed-service-started");
		const mutations: Array<(args: BashToolInput) => void> = [
			args => {
				args.name = "changed-service-name";
			},
			args => {
				args.ready!.log = "changed";
			},
		];
		for (const [index, mutate] of mutations.entries()) {
			const args: BashToolInput = {
				command: `printf svc-ask > '${marker}'`,
				cwd: tempDir,
				name: "reviewed-service",
				pty: false,
				ready: { log: "svc-ask" },
			};
			const id = `service-fingerprint-${index}`;
			expect(await tool.prepareRuntimeApproval(id, args)).toBeDefined();
			tool.approveRuntimeApproval(id, args);
			mutate(args);
			await expect(tool.execute(id, args)).rejects.toThrow(/requires interactive approval/u);
			expect(fs.existsSync(marker)).toBeFalse();
		}
	});

	it("rejects caller-provided environment fields before Bash can launch a command or service", async () => {
		const marker = path.join(tempDir, "preloaded-service-started");
		for (const name of [undefined, "preloaded-service"]) {
			const args = {
				command: `printf svc-allow > '${marker}'`,
				cwd: tempDir,
				name,
				pty: false,
				env: { BASH_ENV: marker },
			};
			await expect(tool.prepareRuntimeApproval("service-preload", args)).rejects.toThrow(
				"Bash no longer accepts an env parameter.",
			);
			await expect(tool.execute("service-preload", args)).rejects.toThrow(
				"Bash no longer accepts an env parameter.",
			);
			expect(fs.existsSync(marker)).toBeFalse();
		}
	});

	it("applies custom bash interceptor rules to named services", async () => {
		const interceptorSettings = Settings.isolated({
			"launch.enabled": true,
			"bashInterceptor.enabled": true,
			"bashInterceptor.patterns": [{ pattern: "^printf svc-allow", tool: "bash", message: "Custom service block" }],
		});
		const interceptorSession = { ...session, settings: interceptorSettings } as ToolSession;
		const interceptorTool = new BashTool(interceptorSession);
		const args: BashToolInput = { command: "printf svc-allow", cwd: tempDir, name: "blocked-service", pty: false };
		try {
			await expect(
				interceptorTool.execute("service-interceptor", args, undefined, undefined, {
					toolNames: ["bash"],
				} as AgentToolContext),
			).rejects.toThrow("Custom service block");
		} finally {
			await stopService(interceptorSession, "blocked-service").catch(() => undefined);
			await closeDaemonClient();
		}
	});

	it("starts a DCG-allowed service and reports its readiness and output", async () => {
		const args: BashToolInput = {
			command: "printf svc-allow; sleep 20",
			cwd: tempDir,
			name: "allowed-service",
			pty: false,
			ready: { log: "svc-allow", timeout: 5 },
		};
		try {
			const result = await tool.execute("service-allow", args);
			expect(result.details?.service).toMatchObject({ name: "allowed-service", ready: true, timedOut: false });
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("svc-allow") });
		} finally {
			await stopService(session, "allowed-service").catch(() => undefined);
			await closeDaemonClient();
		}
	});
});
