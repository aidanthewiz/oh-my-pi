import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
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
const command = process.argv.slice(4).join(" ");
console.log(JSON.stringify({
	schema_version: 1,
	dcg_version: "0.6.7",
	robot_mode: true,
	command,
	decision: "ask",
	rule_id: "strict_git:worktree-remove",
	reason: "git worktree remove deletes a linked working tree.",
	agent: { detected: "pi" },
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

	function runner(select: (prompt: string, options: string[]) => string | undefined): ExtensionRunner {
		return {
			sessionId: "dcg-runtime-test",
			runScoped: <T>(fn: () => T): T => fn(),
			hasHandlers: () => false,
			hasUI: () => true,
			consumeToolCallEmitted: () => false,
			getUIContext: () => ({
				select: async (prompt: string, options: string[]) => select(prompt, options),
			}),
		} as unknown as ExtensionRunner;
	}

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
			runner((prompt, options) => {
				events.push("selector");
				review = prompt;
				expect(options).toEqual(["Deny", "Approve once"]);
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
