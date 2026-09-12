import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionRunner,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolInput } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const DCG_ENV_KEYS = [
	"OMP_DCG_PATH",
	"OMP_DCG_VERSION",
	"OMP_DCG_BINARY_SHA256",
	"OMP_DCG_CONFIG",
	"OMP_DCG_CONFIG_SHA256",
] as const;

describe.skipIf(process.platform === "win32")("DCG runtime approval", () => {
	let tempDir: string;
	let settings: Settings;
	let tool: BashTool;
	let previousEnv: Record<string, string | undefined>;

	beforeAll(() => {
		previousEnv = Object.fromEntries(DCG_ENV_KEYS.map(key => [key, process.env[key]]));
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dcg-runtime-"));
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
		const session = {
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

	afterAll(() => {
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

	it("selects the configured shell dialect for local PTY execution", async () => {
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
				{ command: `printf expected-${dialect}`, cwd: tempDir, pty: true },
				undefined,
				{ hasUI: true, ui: {} } as AgentToolContext,
			);
			expect(approval?.prompt).toContain("strict_git:worktree-remove");
		}
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
		routeSettings.override("shellPath", psPath);

		await expect(routeTool.execute(toolCallId, args)).rejects.toThrow(
			"Bash execution route or shell changed after safety review",
		);
	});

	it("starts a local PTY with the isolated session shell reviewed by DCG", async () => {
		const marker = path.join(tempDir, "prepared-pty-shell");
		const shellDir = path.join(tempDir, "isolated-pty-shell");
		fs.mkdirSync(shellDir);
		const shellPath = path.join(shellDir, "pwsh");
		fs.writeFileSync(shellPath, `#!/bin/sh\nprintf prepared > '${marker}'\nexit 0\n`, { mode: 0o755 });
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
		const args: BashToolInput = { command: "printf expected-ps", cwd: tempDir, pty: true };
		const toolCallId = "dcg-isolated-pty-call";

		const approval = await routeTool.prepareRuntimeApproval(toolCallId, args, undefined, context);
		expect(approval?.prompt).toContain("strict_git:worktree-remove");
		routeTool.approveRuntimeApproval(toolCallId, args);
		await routeTool.execute(toolCallId, args, undefined, undefined, context);

		expect(fs.readFileSync(marker, "utf8")).toBe("prepared");
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
			expect(sendNotification).toHaveBeenCalledWith({
				title: "Oh My Pi",
				body: "Tool approval required",
				type: "approval",
				urgency: "normal",
				actions: "focus",
			});
			expect(fs.readFileSync(resultPath, "utf8")).toBe("runtime-approved");
			expect(review).toContain("strict_git:worktree-remove");
			expect(review).toContain("git worktree remove deletes a linked working tree.");
			expect(review).toContain(JSON.stringify(tempDir));
			expect(review).toContain(JSON.stringify(`printf runtime-approved > '${resultPath}'`));
			expect(review).toContain("newlines and control characters are escaped");

			await expect(tool.execute("approved-call", args)).rejects.toThrow(/requires interactive approval/u);
		} finally {
			sendNotification.mockRestore();
		}
	});

	it("invalidates approval when the execution input changes during review", async () => {
		const sendNotification = spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		const args: BashToolInput = { command: "printf original-command", cwd: tempDir };
		const wrapped = new ExtensionToolWrapper(
			tool as unknown as AgentTool,
			runner(() => {
				args.command = "printf changed-command";
				return "Approve once";
			}),
		);

		try {
			await expect(
				wrapped.execute("changed-call", args, undefined, undefined, { settings } as AgentToolContext),
			).rejects.toThrow(/requires interactive approval/u);
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
});
