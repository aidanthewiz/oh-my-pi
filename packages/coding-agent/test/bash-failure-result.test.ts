import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { Shell } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	mock.restore();
});

let tempDir: TempDir;

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: tempDir.path(),
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
		...overrides,
	} as unknown as ToolSession;
}

beforeEach(async () => {
	resetSettingsForTest();
	tempDir = TempDir.createSync("@pi-bash-result-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
});

afterEach(() => {
	resetSettingsForTest();
	tempDir.removeSync();
});

describe("BashTool execution results", () => {
	it("resolves with an error result carrying execution details instead of throwing", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-fail", { command: "exit 3" });

		// A completed command that failed is a non-throwing error result so the
		// renderer keeps the wall time / timeout / exit-code footer.
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(3);
		expect(result.details?.timeoutSeconds).toBe(300);
		expect(typeof result.details?.wallTimeMs).toBe("number");

		// The LLM-facing text still states the exit code verbatim.
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Command exited with code 3");
	});

	it("returns a warning-state timeout result with one timeout notice", async () => {
		// Keep the real native subprocess timeout path, but compress its backend
		// deadline; BashTool must still report the user-facing one-second timeout.
		const realRun = Shell.prototype.run;
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			return realRun.call(this, { ...options, timeoutMs: 20 }, onChunk);
		});
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-timeout", { command: "sleep 3", timeout: 1 });

		expect(result.isError).toBe(true);
		expect(result.details?.timedOut).toBe(true);
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text.match(/\[Command timed out after 1 seconds\]/gu)).toHaveLength(1);
	});

	it("preserves the executor cancellation notice without classifying it as a timeout", async () => {
		const dispatched = Promise.withResolvers<void>();
		const realRun = Shell.prototype.run;
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			dispatched.resolve();
			return realRun.call(this, options, onChunk);
		});
		const tool = new BashTool(makeSession());
		const controller = new AbortController();
		const execution = tool.execute("call-cancel", { command: "sleep 3" }, controller.signal);
		await dispatched.promise;
		controller.abort();

		const error = await execution.catch(error => error);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message.match(/\[Command cancelled\]/gu)).toHaveLength(1);
		expect(message).not.toContain("Command aborted");
	});

	it("returns a success result with no exit-code detail for a zero exit", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-ok", { command: "printf hi" });

		expect(result.isError).toBeUndefined();
		expect(result.details?.exitCode).toBeUndefined();
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("hi");
		expect(text).not.toContain("Command exited with code");
	});

	it("links the raw artifact when the per-line column cap drops bytes", async () => {
		Settings.instance.set("tools.outputMaxColumns", 8);
		const artifactPath = path.join(tempDir.path(), "bash-column-cap.txt");
		const tool = new BashTool(
			makeSession({
				allocateOutputArtifact: async () => ({ path: artifactPath, id: "bash-column-cap" }),
			}),
		);

		const result = await tool.execute("call-column-cap", {
			command: "printf 'abcdefghijklmnopqrstuvwxyz\\n'",
		});
		const text = result.content.find(c => c.type === "text")?.text ?? "";

		expect(text).toContain("[raw output: artifact://bash-column-cap]");
		expect(await Bun.file(artifactPath).text()).toBe("abcdefghijklmnopqrstuvwxyz\n");
	});

	it("preserves final-stage output when a pipeline ends in head or tail", async () => {
		const tool = new BashTool(makeSession());

		for (const scenario of [
			{ command: "seq 1 5 | head -n2", expected: "1\n2" },
			{ command: "seq 1 5 | tail -n2", expected: "4\n5" },
		]) {
			const result = await tool.execute(`call-pipeline-${scenario.expected[0]}`, { command: scenario.command });
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			const stdout = text.replace(/\n\nWall time: \d+\.\d{2} seconds$/, "").trimEnd();

			expect(result.isError).toBeUndefined();
			expect(stdout).toBe(scenario.expected);
		}
	});
});
