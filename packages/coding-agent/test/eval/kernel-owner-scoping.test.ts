import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { resolveJsKernelIdentity } from "../../src/eval/js";
import { EvalRunner, type EvalRunnerHost } from "../../src/session/eval-runner";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";

function evalSession(manager: SessionManager, owner: string): ToolSession {
	const runner = new EvalRunner({ sessionManager: manager } as EvalRunnerHost, { kernelOwnerId: owner });
	return {
		cwd: manager.getCwd(),
		settings: Settings.isolated(),
		getSessionFile: () => manager.getSessionFile() ?? null,
		getEvalSessionId: () => runner.getSessionId(),
		getEvalKernelOwnerId: () => runner.getKernelOwnerId(),
	} as ToolSession;
}

describe("session-owned eval kernels", () => {
	afterEach(async () => {
		await disposeAllVmContexts();
	});

	it("keeps in-memory siblings separate across a reset without losing the parent's state", async () => {
		using tempDir = TempDir.createSync("@omp-js-session-isolation-");
		const cwd = tempDir.path();
		const parent = evalSession(SessionManager.inMemory(cwd), "parent");
		const child = evalSession(SessionManager.inMemory(cwd), "child");
		const run = (session: ToolSession, code: string, reset = false) => {
			const identity = resolveJsKernelIdentity(session);
			return executeJs(code, {
				cwd,
				sessionId: identity.sessionKey,
				kernelOwnerId: identity.ownerId,
				session,
				reset,
			});
		};

		await run(parent, "var parentOnly = 41;");
		expect((await run(child, "return typeof parentOnly;")).output.trim()).toBe("undefined");
		await run(child, "var childOnly = 7;");
		expect((await run(child, "return typeof childOnly;", true)).output.trim()).toBe("undefined");
		expect((await run(parent, "return parentOnly + 1;")).output.trim()).toBe("42");
	});
});
