import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts, setJsEvalWorkerThreadForTests } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import type { ToolSession } from "../../src/tools";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": false,
			"task.enableLsp": true,
		}),
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
		getToolByName: () => undefined,
	} as ToolSession;
}

describe("JavaScript eval credential boundary", () => {
	afterEach(async () => {
		await disposeAllVmContexts();
		setJsEvalWorkerThreadForTests(false);
	});

	it.each([
		["subprocess", false],
		["worker fallback", true],
	] as const)("does not expose parent credentials in the %s", async (_mode, useWorker) => {
		using tempDir = TempDir.createSync("@omp-js-credential-boundary-");
		const key = `OMP_EVAL_${crypto.randomUUID().replaceAll("-", "")}_TOKEN`;
		const previous = Bun.env[key];
		Bun.env[key] = "parent-credential";
		setJsEvalWorkerThreadForTests(useWorker);
		try {
			const result = await executeJs(`return process.env[${JSON.stringify(key)}] ?? "absent";`, {
				cwd: tempDir.path(),
				sessionId: `js-credential-boundary:${crypto.randomUUID()}`,
				session: makeSession(tempDir.path()),
			});
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("absent");
		} finally {
			if (previous === undefined) delete Bun.env[key];
			else Bun.env[key] = previous;
		}
	});
});
