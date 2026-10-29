import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function printSession(cwd: string, prompts: string[]): AgentSession {
	return {
		extensionRunner: undefined,
		subscribe: () => () => {},
		loadDeferredExtensions: async () => {},
		settings: Settings.isolated(),
		sessionManager: {
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
			getCwd: () => cwd,
			onPersistenceError: () => () => {},
			onPersistenceNotice: () => () => {},
		},
		disableStopTimeTodoReminders: () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForIdle: async () => {},
		setTextOutputCommitted: () => {},
		waitForAdvisorCatchup: async () => true,
		prompt: async (text: string) => {
			prompts.push(text);
			return true;
		},
		getLastAssistantMessage: () => undefined,
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("print mode builtin exit codes", () => {
	test("exits 1 when the dispatched reauth fails, 0 for other slash input", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-builtin-"));
		const stderrLines: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderrLines.push(String(chunk));
			return true;
		}) as never);
		const prompts: string[] = [];
		const session = printSession(cwd, prompts);

		try {
			// A failed reauth (unknown server) consumes the input and reports
			const failure = await runPrintMode(session, {
				mode: "text",
				messages: ["/mcp reauth no-such-server-9f3a"],
			});
			expect(failure).toBe(1);
			expect(stderrLines.join("")).toContain("not found");
			expect(prompts).toEqual([]);

			stderrLines.length = 0;
			prompts.length = 0;
			// Slash input outside the reauth allow-list keeps the historic
			// behavior: it prompts the model with the literal text instead of
			// running locally.
			const success = await runPrintMode(session, { mode: "text", messages: ["/mcp help"] });
			expect(success).toBe(0);
			expect(prompts).toEqual(["/mcp help"]);
			expect(stderrLines.join("")).not.toContain("/mcp list");
		} finally {
			stderrSpy.mockRestore();
			vi.restoreAllMocks();
			await removeWithRetries(cwd);
		}
	});

	test("never dispatches the merged stdin/@file message as a command", async () => {
		// Security: `curl … | omp "summarize"` merges the pipe into
		// `initialMessage`; a slash-shaped payload there (e.g. a persisted
		// `/mcp add`) must reach the model as text, never run as a command.
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-stdin-"));
		const stderrLines: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderrLines.push(String(chunk));
			return true;
		}) as never);
		const prompts: string[] = [];
		const session = printSession(cwd, prompts);
		// Allow-listed *and* reauth-shaped: the trust boundary must hold even
		// for the one command print mode dispatches — a pipe controls this
		// text end to end, so it must reach the model verbatim.
		const injected = "/mcp reauth evil";

		try {
			const exit = await runPrintMode(session, { mode: "text", initialMessage: injected });
			// The payload prompted the model verbatim; nothing ran locally.
			expect(prompts).toEqual([injected]);
			expect(exit).toBe(0);
			expect(stderrLines.join("")).not.toContain("not found");
		} finally {
			stderrSpy.mockRestore();
			vi.restoreAllMocks();
			await removeWithRetries(cwd);
		}
	});

	test("counts a builtin-started turn (/retry) as admitted and prints its answer", async () => {
		// `/retry` consumes the input but schedules a real agent turn
		// (`agentInvoked`); that turn's answer belongs to this run, so it is
		// printed — not suppressed as a stale persisted turn — and its stop
		// reason decides the exit status.
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-retry-"));
		const stdoutLines: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: unknown,
			callback?: (err?: Error | null) => void,
		) => {
			stdoutLines.push(String(chunk));
			callback?.(null);
			return true;
		}) as never);
		const retriedAnswer = {
			role: "assistant",
			content: [{ type: "text", text: "retried answer" }],
			stopReason: "stop",
			timestamp: Date.now(),
		} as never;
		const prompts: string[] = [];
		let retried = false;
		const session = {
			extensionRunner: undefined,
			loadDeferredExtensions: async () => {},
			subscribe: () => () => {},
			settings: Settings.isolated(),
			sessionManager: {
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
				getCwd: () => cwd,
				onPersistenceError: () => () => {},
				onPersistenceNotice: () => () => {},
			},
			disableStopTimeTodoReminders: () => {},
			prepareForHeadlessAdvisorDrain: () => {},
			waitForIdle: async () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			prompt: async (text: string) => {
				prompts.push(text);
			},
			retry: async () => {
				retried = true;
				return true;
			},
			getLastAssistantMessage: () => (retried ? retriedAnswer : undefined),
			dispose: async () => {},
		} as unknown as AgentSession;

		try {
			const exit = await runPrintMode(session, { mode: "text", messages: ["/retry"] });
			expect(exit).toBe(0);
			// The input was consumed locally (no new prompt)…
			expect(prompts).toEqual([]);
			// …and the retried turn's answer was printed as this run's answer.
			expect(stdoutLines.join("")).toContain("retried answer");
		} finally {
			stdoutSpy.mockRestore();
			vi.restoreAllMocks();
			await removeWithRetries(cwd);
		}
	});
	test.each(["compact", "handoff"])(
		"reports an inline /%s provider failure even when a later prompt succeeds",
		async command => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-maintenance-"));
			const stderr: string[] = [];
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
				stderr.push(String(chunk));
				return true;
			}) as never);
			const prompts: string[] = [];
			const session = printSession(cwd, prompts);
			Object.assign(session, {
				compact: async () => {
					throw new Error("provider refused maintenance");
				},
				handoff: async () => {
					throw new Error("provider refused maintenance");
				},
			});
			try {
				expect(await runPrintMode(session, { mode: "text", messages: [`/${command}`, "next prompt"] })).toBe(1);
				expect(prompts).toEqual(["next prompt"]);
				expect(stderr.join("")).toContain("provider refused maintenance");
			} finally {
				stderrSpy.mockRestore();
				await removeWithRetries(cwd);
			}
		},
	);

	test.each(["stop", "error"])(
		"does not reuse a persisted %s answer when retry produces no new assistant",
		async stopReason => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-stale-"));
			const stdout: string[] = [];
			const stderr: string[] = [];
			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
				chunk: unknown,
				done?: () => void,
			) => {
				stdout.push(String(chunk));
				done?.();
				return true;
			}) as never);
			const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
				stderr.push(String(chunk));
				return true;
			}) as never);
			const session = printSession(cwd, []);
			const oldAssistant = {
				role: "assistant",
				content: [{ type: "text", text: "old answer" }],
				stopReason,
				errorMessage: stopReason === "error" ? "old failure" : undefined,
			} as never;
			session.getLastAssistantMessage = () => oldAssistant;
			session.retry = async () => true;
			try {
				expect(await runPrintMode(session, { mode: "text", messages: ["/retry"] })).toBe(0);
				expect(stdout.join("")).toBe("");
				expect(stderr.join("")).not.toContain("old failure");
			} finally {
				stdoutSpy.mockRestore();
				stderrSpy.mockRestore();
				await removeWithRetries(cwd);
			}
		},
	);

	test("does not treat a locally handled prompt as an admitted assistant turn", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-handled-"));
		const stdout: string[] = [];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, done?: () => void) => {
			stdout.push(String(chunk));
			done?.();
			return true;
		}) as never);
		const session = printSession(cwd, []);
		session.prompt = async () => false;
		session.getLastAssistantMessage = () =>
			({
				role: "assistant",
				content: [{ type: "text", text: "old answer" }],
				stopReason: "error",
				errorMessage: "old failure",
			}) as never;
		try {
			expect(await runPrintMode(session, { mode: "text", initialMessage: "handled" })).toBe(0);
			expect(stdout.join("")).toBe("");
		} finally {
			stdoutSpy.mockRestore();
			await removeWithRetries(cwd);
		}
	});
});
