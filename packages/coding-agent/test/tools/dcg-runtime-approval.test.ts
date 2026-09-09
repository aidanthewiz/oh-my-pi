import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
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

	function runner(input: (prompt: string) => string | undefined): ExtensionRunner {
		return {
			sessionId: "dcg-runtime-test",
			runScoped: <T>(fn: () => T): T => fn(),
			hasHandlers: () => false,
			hasUI: () => true,
			consumeToolCallEmitted: () => false,
			getUIContext: () => ({ input: async (prompt: string) => input(prompt) }),
		} as unknown as ExtensionRunner;
	}

	it("shows the exact expanded execution and defers filesystem writes until confirmation", async () => {
		const args: BashToolInput = {
			command: "printf runtime-approved > local://nested/result.txt",
			cwd: tempDir,
			timeout: 30,
		};
		const resultPath = path.join(tempDir, "artifacts", "local", "nested", "result.txt");
		let review = "";
		const wrapped = new ExtensionToolWrapper(
			tool as unknown as AgentTool,
			runner(prompt => {
				review = prompt;
				expect(fs.existsSync(path.dirname(resultPath))).toBeFalse();
				return prompt.match(/Type (RUN \d{4}) to execute/u)?.[1];
			}),
		);

		await wrapped.execute("approved-call", args, undefined, undefined, {
			settings,
		} as AgentToolContext);
		expect(fs.readFileSync(resultPath, "utf8")).toBe("runtime-approved");
		expect(review).toContain("strict_git:worktree-remove");
		expect(review).toContain("git worktree remove deletes a linked working tree.");
		expect(review).toContain(JSON.stringify(tempDir));
		expect(review).toContain(JSON.stringify(`printf runtime-approved > '${resultPath}'`));
		expect(review).toContain("newlines and control characters are escaped");

		await expect(tool.execute("approved-call", args)).rejects.toThrow(/requires interactive approval/u);
	});

	it("invalidates approval when the execution input changes during review", async () => {
		const args: BashToolInput = { command: "printf original-command", cwd: tempDir };
		const wrapped = new ExtensionToolWrapper(
			tool as unknown as AgentTool,
			runner(prompt => {
				args.command = "printf changed-command";
				return prompt.match(/Type (RUN \d{4}) to execute/u)?.[1];
			}),
		);

		await expect(
			wrapped.execute("changed-call", args, undefined, undefined, { settings } as AgentToolContext),
		).rejects.toThrow(/requires interactive approval/u);
	});

	it("does not execute after a missing or incorrect confirmation challenge", async () => {
		const args: BashToolInput = { command: "printf must-not-run", cwd: tempDir };
		const wrapped = new ExtensionToolWrapper(
			tool as unknown as AgentTool,
			runner(() => "RUN 0000"),
		);

		await expect(
			wrapped.execute("denied-call", args, undefined, undefined, { settings } as AgentToolContext),
		).rejects.toThrow(/denied by user/u);
		await expect(tool.execute("denied-call", args)).rejects.toThrow(/requires interactive approval/u);
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
