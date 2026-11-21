/**
 * Contract (issue #10363): print mode is single-shot by default — it disposes
 * after its prompts, so a background job the run started never reaches the
 * model. With `async.printWake` print mode waits for the run to end: each job
 * result resumes the same run for another loop (a loop may start further jobs),
 * the session ends the run once nothing can resume it, and the text output is
 * the answer of the last loop.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { HeadlessShutdownCoordinator } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime as RuntimeActions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	cfgFeaturesUnexpectedStopDetection,
	cfgRetryBaseDelayMs,
	cfgRetryEnabled,
	cfgRetryMaxDelayMs,
	cfgRetryModelFallback,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncPrintWake } from "@oh-my-pi/pi-coding-agent/tools/settings";

const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];
const managers: AsyncJobManager[] = [];

async function sessionWithJobs(
	settings: Settings,
	jobCount: number,
	options: {
		jobsNeverFinish?: boolean;
		jobsStartedByFirstWake?: number;
		settleMs?: number;
		retryBackoff?: "prompt" | "follow-up";
		extensionSends?: "prompt" | "manual";
	} = {},
) {
	const manager = new AsyncJobManager({});
	managers.push(manager);
	AsyncJobManager.setInstance(manager);
	const gates: PromiseWithResolvers<void>[] = [];
	const jobs: ReturnType<AsyncJobManager["getAllJobs"]> = [];
	let started = false;
	let firstWakeStarted = false;
	let delivered = 0;
	let settling = false;
	let retryStarts = 0;
	const retryStarted = Promise.withResolvers<number>();
	const extensionRuntime: RuntimeActions | undefined = options.extensionSends ? new ExtensionRuntime() : undefined;
	let extensionSends = 0;
	const startJobs = (count: number): void => {
		for (let i = 0; i < count; i++) {
			const gate = Promise.withResolvers<void>();
			gates.push(gate);
			const number = gates.length;
			const id = manager.register(
				"bash",
				`print job ${number}`,
				async ({ signal }) => {
					const cancel = (): void => gate.resolve();
					signal.addEventListener("abort", cancel, { once: true });
					try {
						if (!signal.aborted) await gate.promise;
						// This real delay exposes platform timer overflow; fake timers cannot reproduce Bun's truncation.
						if (options.settleMs && !signal.aborted) await Bun.sleep(options.settleMs);
						return `PRINT_JOB_RESULT_${number}`;
					} finally {
						signal.removeEventListener("abort", cancel);
					}
				},
				{ id: `print-job-${number}`, ownerId: "Main" },
			);
			const job = manager.getJob(id);
			if (!job) throw new Error("Registered print job is missing");
			jobs.push(job);
		}
	};
	const mock = createMockModel({
		handler: context => {
			if (options.extensionSends === "prompt" && extensionRuntime && extensionSends === 0) {
				extensionSends++;
				extensionRuntime.sendMessage(
					{ customType: "print-deadline", content: "Real extension send before settlement", display: false },
					{ triggerTurn: false },
				);
			}
			const text = context.messages
				.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(part =>
								"text" in part && typeof part.text === "string" ? [part.text] : [],
							),
				)
				.join("\n");
			delivered = Math.max(0, ...Array.from(text.matchAll(/PRINT_JOB_RESULT_(\d+)/g), match => Number(match[1])));
			if (!started) {
				started = true;
				startJobs(jobCount);
				if (options.retryBackoff === "prompt") return { throw: "503 service unavailable: overloaded_error" };
				return { content: ["started"] };
			}
			if (delivered === 1 && !firstWakeStarted) {
				firstWakeStarted = true;
				startJobs(options.jobsStartedByFirstWake ?? 0);
			}
			if (options.retryBackoff === "follow-up") return { throw: "503 service unavailable: overloaded_error" };
			return { content: [`result ${delivered}`] };
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorages.push(authStorage);
	authStorage.keys.setRuntime("anthropic", "test-key");
	cfgCompactionEnabled.override(settings, false);
	cfgFeaturesUnexpectedStopDetection.override(settings, "none");
	cfgRetryEnabled.override(settings, true);
	cfgRetryModelFallback.override(settings, false);
	const retryDelayMs = options.extensionSends ? 10_000 : 1_000;
	cfgRetryBaseDelayMs.override(settings, retryDelayMs);
	cfgRetryMaxDelayMs.override(settings, retryDelayMs);
	const modelRegistry = new ModelRegistry(authStorage);
	const deadline = options.retryBackoff && !options.extensionSends ? Date.now() + 50 : undefined;
	const agent = new Agent({
		getApiKey: () => "test-key",
		deadline,
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const sessionManager = SessionManager.inMemory();
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		agentId: "Main",
		asyncJobManager: manager,
		extensionRunner: extensionRuntime
			? new ExtensionRunner(
					[],
					extensionRuntime,
					sessionManager.getCwd(),
					sessionManager,
					modelRegistry,
					undefined,
					settings,
				)
			: undefined,
	});
	sessions.push(session);
	const releaseNext = (): void => {
		if (!options.jobsNeverFinish) gates[delivered]?.resolve();
	};
	session.subscribe(event => {
		if (event.type === "auto_retry_start") {
			retryStarts++;
			retryStarted.resolve(Date.now());
		}
		if (event.type === "agent_pause" && settling && session.getLastAssistantMessage()?.stopReason === "stop") {
			releaseNext();
		}
	});
	const waitForRunEnd = session.waitForRunEnd.bind(session);
	vi.spyOn(session, "waitForRunEnd").mockImplementation(async () => {
		settling = true;
		releaseNext();
		await waitForRunEnd();
	});
	return {
		session,
		mock,
		deadline,
		statuses: () => jobs.map(job => job.status),
		retryStarts: () => retryStarts,
		retryStarted: retryStarted.promise,
		extensionRuntime,
		extensionSends: () => extensionSends,
	};
}

function captureStdout(): { lines: string[] } {
	const lines: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, cb?: (err?: Error) => void) => {
		lines.push(String(chunk));
		cb?.();
		return true;
	}) as never);
	vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
	return { lines };
}

afterEach(async () => {
	vi.useRealTimers();
	try {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const manager of managers.splice(0)) await manager.dispose();
		for (const authStorage of authStorages.splice(0)) await authStorage.close();
	} finally {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	}
});

describe("print mode async-result wake", () => {
	test("by default exits after the prompt and cancels its pending job", async () => {
		const { lines } = captureStdout();
		const { session, mock, statuses } = await sessionWithJobs(Settings.isolated(), 1);

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(lines.join("")).toBe("started\n");
		expect(mock.calls).toHaveLength(1);
		expect(statuses()).toEqual(["cancelled"]);
		expect(session.isDisposed).toBe(true);
	});

	test("retains a completed answer when only post-turn deadline checking is late", async () => {
		const { lines } = captureStdout();
		const { session, mock } = await sessionWithJobs(Settings.isolated(), 0);

		expect(await runPrintMode(session, { mode: "text", messages: ["go"], deadline: Date.now() - 1 })).toBe(0);

		expect(lines.join("")).toBe("started\n");
		expect(mock.calls).toHaveLength(1);
		expect(session.isDisposed).toBe(true);
	});

	test("with async.printWake, every job result wakes the owning session and the last answer is printed", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, mock, statuses } = await sessionWithJobs(settings, 2);

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(lines.join("")).toBe("result 2\n");
		expect(mock.calls).toHaveLength(3);
		expect(statuses()).toEqual(["completed", "completed"]);
		expect(session.isDisposed).toBe(true);
	});

	test("with async.printWake, a job started by a resumed loop is waited for and answers last", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, mock, statuses } = await sessionWithJobs(settings, 1, { jobsStartedByFirstWake: 1 });

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(lines.join("")).toBe("result 2\n");
		expect(mock.calls).toHaveLength(3);
		expect(statuses()).toEqual(["completed", "completed"]);
	});

	test("with async.printWake, a --max-time beyond the 32-bit timer range does not expire early", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, statuses } = await sessionWithJobs(settings, 1, { settleMs: 30 });

		const code = await runPrintMode(session, {
			mode: "text",
			messages: ["go"],
			deadline: Date.now() + 600 * 60 * 60 * 1000,
		});

		expect(code).toBe(0);
		expect(statuses()).toEqual(["completed"]);
		expect(lines.join("")).toBe("result 1\n");
	});

	test("with async.printWake, a run that never reached the model does not start background work", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, mock, statuses } = await sessionWithJobs(settings, 1);

		expect(await runPrintMode(session, { mode: "text", messages: [] })).toBe(0);

		expect(mock.calls).toHaveLength(0);
		expect(statuses()).toEqual([]);
		expect(lines.join("")).toBe("");
		expect(session.isDisposed).toBe(true);
	});

	test("with async.printWake, reaching --max-time while a job runs cancels it at once and fails the run", async () => {
		const { lines } = captureStdout();
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		}) as never);
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, mock, statuses } = await sessionWithJobs(settings, 1, { jobsNeverFinish: true });

		const code = await runPrintMode(session, { mode: "text", messages: ["go"], deadline: Date.now() + 50 });

		expect(code).toBe(1);
		expect(statuses()).toEqual(["cancelled"]);
		expect(mock.calls).toHaveLength(1);
		expect(session.isDisposed).toBe(true);
		expect(lines.join("")).toBe("");
		expect(stderr.join("")).toContain("--max-time reached before the run ended");
	});

	test("with async.printWake, an expired deadline admits no model or background work", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, mock, statuses } = await sessionWithJobs(settings, 1);

		const code = await runPrintMode(session, { mode: "text", messages: ["go"], deadline: Date.now() - 1 });

		expect(code).toBe(1);
		expect(mock.calls).toHaveLength(0);
		expect(statuses()).toEqual([]);
		expect(lines.join("")).toBe("");
	});

	test("with async.printWake, --max-time during a resumed loop's retry backoff still disposes and fails the run", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, mock, statuses, retryStarts, deadline } = await sessionWithJobs(settings, 1, {
			retryBackoff: "follow-up",
		});

		const code = await runPrintMode(session, { mode: "text", messages: ["go"], deadline });

		expect(code).toBe(1);
		expect(mock.calls).toHaveLength(2);
		expect(retryStarts()).toBe(1);
		expect(statuses()).toEqual(["completed"]);
		expect(session.isDisposed).toBe(true);
		expect(lines.join("")).toBe("");
	});

	test("with async.printWake, --max-time during the prompt turn's retry backoff with a job pending still disposes", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, mock, statuses, retryStarts, deadline } = await sessionWithJobs(settings, 1, {
			retryBackoff: "prompt",
		});

		const code = await runPrintMode(session, { mode: "text", messages: ["go"], deadline });

		expect({ code, calls: mock.calls.length, retries: retryStarts(), statuses: statuses() }).toEqual({
			code: 1,
			calls: 1,
			retries: 1,
			statuses: ["cancelled"],
		});
		expect(session.isDisposed).toBe(true);
		expect(lines.join("")).toBe("");
	});

	test("an initialized extension send cannot keep an expired retry and its owned job alive", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, mock, statuses, retryStarts, retryStarted, extensionSends } = await sessionWithJobs(
			settings,
			1,
			{ retryBackoff: "prompt", extensionSends: "prompt" },
		);
		const deadline = Date.now() + 1_000;
		const completion = runPrintMode(session, { mode: "json", messages: ["go"], deadline });
		const retryAt = await Promise.race([
			retryStarted,
			completion.then(() => {
				throw new Error("Print closed before the extension retry started");
			}),
		]);
		expect(retryAt).toBeLessThan(deadline);
		expect(session.isDisposed).toBe(false);
		expect(statuses()).toEqual(["running"]);

		expect(await completion).toBe(1);
		expect(mock.calls).toHaveLength(1);
		expect(retryStarts()).toBe(1);
		expect(extensionSends()).toBe(1);
		expect(statuses()).toEqual(["cancelled"]);
		expect(session.isDisposed).toBe(true);
		const events = lines.map(line => JSON.parse(line));
		expect(events.some(event => event.type === "auto_retry_start")).toBe(true);
		expect(events.filter(event => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(
			1,
		);
	});

	test("the same deadline remains armed when a real extension turn enters retry during the final drain", async () => {
		const { lines } = captureStdout();
		const settings = Settings.isolated();
		cfgAsyncPrintWake.override(settings, true);
		const { session, mock, retryStarts, retryStarted, extensionRuntime } = await sessionWithJobs(settings, 0, {
			retryBackoff: "follow-up",
			extensionSends: "manual",
		});
		if (!extensionRuntime) throw new Error("Expected an extension runtime");
		const catchup = session.waitForAdvisorCatchup.bind(session);
		vi.spyOn(session, "waitForAdvisorCatchup").mockImplementation(async (timeout, options) => {
			const settled = await catchup(timeout, options);
			extensionRuntime.sendUserMessage("Run the extension follow-up");
			await retryStarted;
			return settled;
		});
		const drainEntered = Promise.withResolvers<number>();
		const drain = HeadlessShutdownCoordinator.prototype.drain;
		vi.spyOn(HeadlessShutdownCoordinator.prototype, "drain").mockImplementation(
			function (this: HeadlessShutdownCoordinator) {
				if (retryStarts() > 0 && !session.isDisposed) drainEntered.resolve(Date.now());
				return drain.call(this);
			},
		);
		const deadline = Date.now() + 1_000;
		const completion = runPrintMode(session, { mode: "text", messages: ["go"], deadline });
		const enteredAt = await Promise.race([
			drainEntered.promise,
			completion.then(() => {
				throw new Error("Print closed before the extension drain started");
			}),
		]);
		expect(enteredAt).toBeLessThan(deadline);
		expect(mock.calls).toHaveLength(2);
		expect(retryStarts()).toBe(1);
		expect(session.isDisposed).toBe(false);

		expect(await completion).toBe(1);
		expect(mock.calls).toHaveLength(2);
		expect(session.isDisposed).toBe(true);
		expect(lines.join("")).toBe("started\n");
	});
});

/** A real AgentSession and AsyncJobManager: the first turn starts a background job and answers STARTED. */
describe("print mode async-result wake with a real session", () => {
	async function realSession(printWake: boolean) {
		const manager = new AsyncJobManager({});
		managers.push(manager);
		AsyncJobManager.setInstance(manager);
		manager.register(
			"bash",
			"unrelated owner's job",
			async ({ signal }) => {
				await new Promise<void>(resolve => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return "UNRELATED_OWNER_RESULT";
			},
			{ id: "foreign-job", ownerId: "Other" },
		);
		// The job finishes only once the first run is idle, so only the print-mode wait can deliver it.
		const firstRunIdle = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: context => {
				const resultDelivered = context.messages.some(message =>
					typeof message.content === "string"
						? message.content.includes("JOB_DONE_42")
						: message.content.some(part => part.type === "text" && part.text.includes("JOB_DONE_42")),
				);
				if (resultDelivered) return { content: ["JOB_DONE_42"] };
				manager.register(
					"bash",
					"echo JOB_DONE_42",
					async ({ signal }) => {
						const cancel = (): void => firstRunIdle.resolve();
						signal.addEventListener("abort", cancel, { once: true });
						try {
							if (!signal.aborted) await firstRunIdle.promise;
							return "JOB_DONE_42";
						} finally {
							signal.removeEventListener("abort", cancel);
						}
					},
					{ id: "print-job", ownerId: "Main" },
				);
				return { content: ["STARTED"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const settings = Settings.isolated();
		if (printWake) cfgAsyncPrintWake.override(settings, true);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			asyncJobManager: manager,
		});
		sessions.push(session);
		// Without the wake the job must still be running at dispose: keep its gate shut.
		if (printWake) {
			const waitForRunEnd = session.waitForRunEnd.bind(session);
			vi.spyOn(session, "waitForRunEnd").mockImplementation(async () => {
				firstRunIdle.resolve();
				await waitForRunEnd();
			});
		}
		return { session, mock, manager };
	}

	test("default disposal cancels only this session's job and preserves another owner's work", async () => {
		const { lines } = captureStdout();
		const { session, mock, manager } = await realSession(false);

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(lines.join("")).toBe("STARTED\n");
		expect(mock.calls).toHaveLength(1);
		expect(manager.getJob("print-job")?.status).toBe("cancelled");
		expect(manager.getJob("foreign-job")?.status).toBe("running");
	});

	test("async.printWake prints the owning session's answer without waiting on another owner's work", async () => {
		const { lines } = captureStdout();
		const { session, mock, manager } = await realSession(true);

		expect(await runPrintMode(session, { mode: "text", messages: ["go"] })).toBe(0);

		expect(lines.join("")).toBe("JOB_DONE_42\n");
		expect(mock.calls).toHaveLength(2);
		expect(manager.getJob("foreign-job")?.status).toBe("running");
	});
});
