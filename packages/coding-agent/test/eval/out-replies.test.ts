import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { disposePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { $which, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { AsyncJobManager } from "../../src/async";
import { jsBackend } from "../../src/eval";
import { ToolAbortError } from "../../src/tools/tool-errors";

let temp: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	temp = TempDir.createSync("@eval-out-replies-");
	setAgentDir(path.join(temp.path(), "agent"));
});

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	// The tools opened `<agentDir>/agent.db`; Windows cannot delete an open database.
	AgentStorage.close();
	temp.removeSync();
});

/** A top-level TUI session (where `out://` replies are on) exposing the real `write` and `bash` tools to eval. */
function makeSession(): ToolSession {
	const id = `out-replies-${crypto.randomUUID()}`;
	const tools = new Map<string, Tool>();
	const session: ToolSession = {
		cwd: temp.path(),
		hasUI: false,
		tuiTranscript: true,
		skills: [],
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => id,
		getEvalSessionId: () => id,
		getToolByName: name => tools.get(name),
	};
	tools.set("write", new WriteTool(session));
	tools.set("bash", new BashTool(session));
	return session;
}

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

const CELLS = {
	js: "await tool.write({ path: 'out://', content: '## First' }); await tool.bash({ command: 'printf second > out://' })",
	py: "await tool.write({'path': 'out://', 'content': '## First'})\nawait tool.bash({'command': 'printf second > out://'})",
};

describe("eval replies through out://", () => {
	for (const language of ["js", "py"] as const) {
		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: carries bridged writes and bash redirects to out:// as replies, live and in the result`,
			async () => {
				const frames: (EvalToolDetails | undefined)[] = [];
				const result = await new EvalTool(makeSession()).execute(
					"call",
					{ language, code: CELLS[language] },
					undefined,
					update => frames.push(update.details),
				);
				expect(result.isError).not.toBe(true);
				expect(result.details?.replies).toEqual(["## First", "second"]);
				// The first reply reaches the card before the cell finishes.
				expect(frames.some(details => details?.replies?.length === 1)).toBe(true);
			},
		);
	}

	it("refuses a bridged reply where nothing would draw it", async () => {
		const session = makeSession();
		const call = callSessionTool("write", { path: "out://", content: "unseen" }, { session });
		await expect(call).rejects.toThrow("do not reach the user");
	});

	it.each([
		{ depth: 1, enabled: true, content: "private child result", error: /Subagents cannot reply/ },
		{ depth: 0, enabled: false, content: "disabled reply", error: /out:\/\/ is off/ },
		{ depth: 0, enabled: true, content: "  ", error: /non-empty/ },
		{ depth: 0, enabled: true, content: "x".repeat(64 * 1024 + 1), error: /capped at/ },
	])("never publishes a refused reply: depth=$depth enabled=$enabled", async ({ depth, enabled, content, error }) => {
		const session = makeSession();
		session.taskDepth = depth;
		session.settings = Settings.isolated({ "out.enabled": enabled });
		const replies: string[] = [];
		await expect(
			callSessionTool("write", { path: "out://", content }, { session, onReply: text => replies.push(text) }),
		).rejects.toThrow(error);
		expect(replies).toEqual([]);
	});

	it("keeps foreground replies but refuses an abort-insensitive completion after caller cancellation", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const lateReply = Promise.withResolvers<unknown>();
		const execute = vi.spyOn(jsBackend, "execute").mockImplementation(async (_code, options) => {
			options.onReply?.("foreground reply");
			entered.resolve();
			await release.promise;
			try {
				options.onReply?.("late reply");
				lateReply.resolve(undefined);
			} catch (error) {
				lateReply.resolve(error);
			}
			return {
				output: "",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				artifactId: undefined,
				totalLines: 0,
				totalBytes: 0,
				outputLines: 0,
				outputBytes: 0,
				displayOutputs: [],
			};
		});
		const manager = new AsyncJobManager({});
		const session = makeSession();
		session.asyncJobManager = manager;
		session.settings = Settings.isolated({
			"eval.autoBackground.enabled": true,
			"eval.autoBackground.thresholdMs": 60_000,
			"eval.autoProvision": false,
		});
		const controller = new AbortController();
		const frames: (EvalToolDetails | undefined)[] = [];
		const completion = new EvalTool(session)
			.execute("cancelled-call", { language: "js", code: "await slowTool()" }, controller.signal, update =>
				frames.push(update.details),
			)
			.then(
				() => undefined,
				error => error,
			);
		try {
			await entered.promise;
			controller.abort();
			expect(await completion).toBeInstanceOf(ToolAbortError);
			release.resolve();
			expect(await lateReply.promise).toBeInstanceOf(ToolAbortError);
			expect(frames.some(frame => frame?.replies?.includes("foreground reply"))).toBe(true);
			expect(frames.flatMap(frame => frame?.replies ?? [])).not.toContain("late reply");
		} finally {
			controller.abort();
			release.resolve();
			await completion;
			await manager.dispose();
			execute.mockRestore();
		}
	});
});
