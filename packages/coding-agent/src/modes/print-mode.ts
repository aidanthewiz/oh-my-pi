/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `omp -p "prompt"` - text output
 * - `omp --mode json "prompt"` - JSON event stream
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { presentNarrationAsAnswer } from "@oh-my-pi/pi-ai/utils/narration";
import { $flag, logger, postmortem, sanitizeText } from "@oh-my-pi/pi-utils";
import { HINDSIGHT_NOTICE_SOURCE } from "../hindsight/state";
import type { MCPManager } from "../mcp/manager";
import { resolveMCPTimeoutMs } from "../mcp/timeout";
import { MNEMOPI_NOTICE_SOURCE } from "../mnemopi/embedding-notice";
import { type AgentSession, type AgentSessionEvent, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { toWireEvent } from "../session/loop-end-wire";
import { COST_GATE_NOTICE_SOURCE } from "../session/cost-gate";
import { CREDENTIAL_DISABLED_NOTICE_SOURCE } from "../session/credential-disabled-notice";
import { isSilentAbort } from "../session/messages";
import { flushTelemetryExport } from "../telemetry-export";
import { parseSlashCommand, parseSubcommand } from "../slash-commands/helpers/parse";
import type { SlashCommandRuntime } from "../slash-commands/types";
import { SPOTLIGHT_NOTICE_SOURCE } from "../spotlight/session";
import { reconnectMcpManagerServer } from "../mcp/oauth-reauth";
import {
	formatPersistenceDurabilityFailure,
	formatPersistenceFailure,
	formatPersistenceNotice,
} from "./persistence-failure";
import { HeadlessShutdownCoordinator, initializeExtensions } from "./runtime-init";

import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "../plan-mode/settings";
import { cfgAsyncPrintWake } from "../tools/settings";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Original CLI-authored prompts after initialMessage; never pipe, file, hook, or model-produced text. */
	messages?: string[];
	/** Untrusted merged first message, including stdin/@file content; never dispatch as a command. */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** If true, include thinking blocks in text output */
	printThoughts?: boolean;
	/** Whether the caller explicitly started the headless plan flow. */
	planYolo?: boolean;
	/** Manager returned by session creation; only print mode waits for its servers. */
	mcpManager?: MCPManager;
	/** Trusted local host consent for an original CLI-authored MCP browser-auth command. */
	allowMcpBrowserAuth?: boolean;
	/** `--max-time` deadline (epoch ms). It aborts running turns; the background-job wait enforces it itself. */
	deadline?: number;
}

/** Matches the longest built-in provider request deadline while bounding tool-loop stalls. */
export const PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Error exits cannot hold automation for the full normal drain budget. */
export const PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS = 30_000;
/** Largest setTimeout delay before 32-bit overflow (Node/Bun fire in ~1 ms past this). */
const MAX_TIMER_MS = 2_147_483_647;
/** Exit status of a run the cost gate stopped (`--max-cost` / `session.maxCost` reached). */
export const PRINT_MODE_COST_CAP_EXIT_CODE = 3;

/** Sanitize untrusted text (server names, errors) into one stderr-safe line. */
function singleLine(text: string): string {
	return sanitizeText(text).replace(/[\r\n\t]+/g, " ");
}

/** Drop the provider-opaque replay payload (e.g. encrypted reasoning items) before printing. */
function stripProviderPayload<T extends AgentMessage>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

/**
 * Shape an event for `--mode json` output.
 *
 * Removes two classes of bloat so transcripts grow linearly with conversation
 * size instead of quadratically (a single long turn used to re-serialize its
 * whole in-progress message on every streamed delta, producing multi-GB logs):
 * - `message_update` snapshots (`message`, `assistantMessageEvent.partial`,
 *   and the `done`/`error` payloads) are dropped; only the incremental delta
 *   is printed. The authoritative message follows in `message_end`.
 * - `providerPayload` is transport-native replay state, opaque and useless
 *   outside this process.
 * - Loop pauses and the run's end keep the JSON stream's per-loop `agent_end`
 *   shape (`isTerminal`, `yielded`, `awaitingAsyncWork`; see `loop-end-wire.ts`).
 */
export function printableEvent(sessionEvent: AgentSessionEvent): unknown {
	const event = toWireEvent(sessionEvent);
	switch (event.type) {
		case "tool_stream_update":
			return { type: event.type, toolCallId: event.toolCallId, toolName: event.toolName };
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "done" || streamEvent.type === "error") {
				return {
					type: "message_update",
					assistantMessageEvent: { type: streamEvent.type, reason: streamEvent.reason },
				};
			}
			const { partial: _partial, ...rest } = streamEvent;
			return { type: "message_update", assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end":
			return { ...event, message: stripProviderPayload(event.message) };
		case "turn_end":
			return {
				...event,
				message: stripProviderPayload(event.message),
				toolResults: event.toolResults.map(stripProviderPayload),
			};
		case "agent_end":
			return { ...event, messages: event.messages.map(stripProviderPayload) };
		default:
			return event;
	}
}

/**
 * Serialized print-mode stdout.
 *
 * process.stdout.write is fire-and-forget: a large final record (e.g. a
 * multi-MB agent_end) can be dropped when the process exits before the pipe
 * drains, truncating the record mid-line while the process still exits 0.
 * Each line waits on the previous write's completion callback so records stay
 * ordered and honor backpressure; shutdown blocks on {@link drained}. Same
 * truncation class as issue #5309 (issue #7635).
 */
class SerialStdout {
	#tail: Promise<void> = Promise.resolve();

	writeLine(text: string): void {
		this.#tail = this.#tail.then(() => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			process.stdout.write(text, err => {
				if (err) reject(err);
				else resolve();
			});
			return promise;
		});
	}

	/** Settles once every line written so far has drained; rejects with the first write error. */
	drained(): Promise<void> {
		return this.#tail;
	}
}

/**
 * Run in print (single-shot) mode.
 *
 * Sends prompts, writes the selected output format, disposes the session, and
 * returns the process exit code for the completed turn.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<number> {
	const stdout = new SerialStdout();
	// A signal (SIGINT/SIGTERM/SIGHUP) landing mid-turn drives the exit code
	// through postmortem (130/143/129). Record the reason so the aborted-response
	// branch below never races that with its own ordinary failure status.
	let signalReason: postmortem.Reason | undefined;
	const builtinAbort = new AbortController();
	const cancelSignalTeardown = postmortem.register("print-mode-session", async reason => {
		signalReason = reason;
		builtinAbort.abort(reason);
		// Join stdout only after dispose: event forwarding stays live through its
		// bounded run drain, so a tool settling there still enqueues its terminal
		// record. Postmortem exits once this callback settles (issue #18450).
		try {
			await session.dispose({ reason, mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
		} catch (error) {
			// The disposal failure stays primary; a write error behind it is secondary.
			await stdout.drained().catch(() => {});
			throw error;
		}
		await stdout.drained();
	});
	try {
		return await runPrintModeCore(session, options, stdout, () => signalReason !== undefined, builtinAbort.signal);
	} finally {
		builtinAbort.abort("Print mode closed");
		cancelSignalTeardown();
	}
}

async function runPrintModeCore(
	session: AgentSession,
	options: PrintModeOptions,
	stdout: SerialStdout,
	signalTeardownActive: () => boolean,
	builtinSignal: AbortSignal,
): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts, planYolo = false } = options;
	session.disableStopTimeTodoReminders();

	// Emit session header for JSON mode
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			stdout.writeLine(`${JSON.stringify(header)}\n`);
		}
	}

	// `plan.defaultOnStartup` opens fresh *interactive* sessions in plan mode so a
	// human can review the plan before it executes. Headless print mode has no
	// surface to review, approve, or exit a plan from, and the turn carries no
	// deterministic way out of plan mode — the model must voluntarily emit a valid
	// `xd://propose` execute-dispatch, and when it does not the run strands until
	// the deadline (issue #8272). So do not honor the startup default here; the
	// supported headless plan flow is `--plan-yolo` (auto-approve → implement),
	// which is wired independently through the prewalk coordinator.
	const planStartupIgnored =
		cfgPlanDefaultOnStartup.get(session.settings) &&
		cfgPlanEnabled.get(session.settings) &&
		session.sessionManager.buildSessionContext().messages.length === 0 &&
		!session.sessionManager.getEntries().some(entry => entry.type === "mode_change") &&
		!planYolo;
	if (planStartupIgnored) {
		process.stderr.write(
			"Note: plan.defaultOnStartup is ignored in print mode (no interactive surface to review the plan). Use --plan-yolo for a headless plan flow.\n",
		);
	}

	// process.stderr.write is fire-and-forget as well: a diagnostic buffered
	// behind a backpressured pipe would still be undelivered when runPrintMode
	// returns, and the caller drains stdout only. Serialize the persistence
	// diagnostics and await the tail before returning.
	let stderrTail: Promise<void> = Promise.resolve();
	const writeStderrLine = (line: string): void => {
		stderrTail = stderrTail
			.then(async () => {
				if (process.stderr.write(`${line}\n`)) return;
				const { promise, resolve } = Promise.withResolvers<void>();
				// A closed stream never emits `drain`; resolve on error/close too so
				// an undeliverable diagnostic cannot strand the tail.
				const settle = (): void => {
					process.stderr.off("drain", settle);
					process.stderr.off("error", settle);
					process.stderr.off("close", settle);
					resolve();
				};
				process.stderr.on("drain", settle);
				process.stderr.on("error", settle);
				process.stderr.on("close", settle);
				await promise;
			})
			// A stderr that throws (EPIPE) must not poison the tail: it would skip
			// every later diagnostic and reject the awaited tail below.
			.catch(() => {});
	};
	// Route slash input through the shared dispatcher so builtins run locally
	// (e.g. `/mcp reauth <name>` opens the browser) instead of prompting the
	// model with the literal text. Unknown or non-slash input falls through to
	// the model; a `{ prompt }` residual is forwarded. Diagnostics go to stderr
	// so stdout stays pure model output (critical in JSON mode).
	// Each dispatch captures the current session ownership.
	const mcpManager = options.mcpManager;
	const builtinRuntimeFor = (): SlashCommandRuntime => {
		const sessionManager = session.sessionManager;
		const sessionId = session.sessionId;
		const model = session.model;
		const modelRegistry = session.modelRegistry;
		const authStorage = modelRegistry?.authStorage;
		const credentialPool = authStorage?.credentials;
		const isCurrent = (): boolean =>
			!builtinSignal.aborted &&
			session.sessionManager === sessionManager &&
			session.sessionId === sessionId &&
			session.model === model &&
			session.modelRegistry === modelRegistry &&
			modelRegistry?.authStorage === authStorage &&
			authStorage?.credentials === credentialPool;
		return {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			output: writeStderrLine,
			refreshCommands: () => {},
			reloadPlugins: () => Promise.resolve(),
			mcpManager,
			signal: builtinSignal,
			isCurrent,
			allowMcpBrowserAuth: options.allowMcpBrowserAuth === true,
			reconnectMcpServer: mcpManager
				? async (name, selected, committedConfig) => {
						if (!isCurrent()) return undefined;
						const state = await reconnectMcpManagerServer(mcpManager, name, selected, committedConfig, {
							signal: builtinSignal,
							isCurrent,
						});
						if (state && isCurrent()) {
							// Print mode wires no tools-changed callback; refresh the
							// session binding so later prompts see the recovered tools.
							await session.refreshMCPTools(mcpManager.getTools());
						}
						if (!isCurrent()) return undefined;
						return state;
					}
				: undefined,
			// `/retry` only schedules its continuation (`session.retry()` posts a
			// post-prompt task) and returns before the retried turn streams: hold
			// the dispatch open until the session is idle — same pairing as the
			// ACP runtime — or the next CLI-authored message would prompt ~1ms
			// later and race the just-scheduled turn it should follow.
			keepTurnOpenUntilIdle: async () => {
				await session.waitForIdle();
			},
		};
	};
	// Whether a dispatched command consumed an input but failed (usage error,
	// unknown server, refused operation). Print mode is automation surface: a
	// failed `/mcp reauth` must not exit 0, or scripts treat a failed
	// reauthorization as success.
	let builtinFailed = false;
	// Scheduled work may produce output, but only a new assistant belongs to this invocation.
	let hasAgentWork = false;
	const previousAssistant = session.getLastAssistantMessage();
	let costCapRefusalBeforeTurn = session.costCapRefusal;
	// The print-mode-dispatched commands. Only commands whose runtime hooks
	// are real in the headless runtime belong here: each runs a session API
	// (`/mcp reauth` engine, `session.compact`, `session.handoff`,
	// `session.retry`). Commands whose hooks would be stubs
	// (`/reload-plugins` and friends) stay undispatched, and so does
	// `/stats`: its dashboard server is in-process (`Bun.serve` inside this
	// one-shot run), so launching it would open a browser tab that dies with
	// the process and report a success the run cannot deliver. Keeping the
	// process alive until the dashboard closes is a separate design
	// decision; until then `/stats` keeps the historic prompt-the-literal
	// behavior of every undispatched command.
	// Matched with the dispatcher's own parser, so `/compact:focus` and
	// `/compact focus` are treated alike; `/mcp` dispatches only `reauth`.
	const PRINT_DISPATCHED_COMMANDS: Record<string, true> = { compact: true, handoff: true, retry: true };
	/**
	 * Dispatch a CLI-authored message as a local command, if it is one.
	 * Only CLI-authored input (`messages`, the positional/-p args) is ever
	 * dispatched. The merged stdin/@file `initialMessage` is attacker-shaped
	 * end to end — `curl … | omp "summarize"` must never run a slash payload
	 * from the pipe as a command — so it always prompts the model as text.
	 * Commands outside the dispatched list keep the historic behavior of
	 * prompting the model with the literal text. Returns whether the message
	 * was consumed locally.
	 */
	const dispatchCliMessage = async (message: string): Promise<boolean> => {
		const parsed = parseSlashCommand(message);
		const dispatched =
			parsed !== null &&
			(parsed.name === "mcp"
				? parseSubcommand(parsed.args).verb === "reauth"
				: Object.hasOwn(PRINT_DISPATCHED_COMMANDS, parsed.name));
		if (!dispatched) return false;
		try {
			await session.loadDeferredExtensions();
		} catch (error) {
			extensionFailure = true;
			extensionShutdownRequested = true;
			writeStderrLine(
				`Extension readiness failed: ${singleLine(error instanceof Error ? error.message : String(error))}`,
			);
			return true;
		}
		if (session.isDisposed || extensionShutdownRequested || signalTeardownActive()) return true;
		if (parsed.name !== "mcp" && !(await prepareAgentTurn())) return true;
		const runtime = builtinRuntimeFor();
		const { executeAcpBuiltinSlashCommand } = await import("../slash-commands/acp-builtins");
		if (session.isDisposed || extensionShutdownRequested || signalTeardownActive() || runtime.isCurrent?.() === false)
			return true;
		const refusalBeforeCommand = session.costCapRefusal;
		const result = await executeAcpBuiltinSlashCommand(message, runtime);
		// The allow-list only matches registered commands, so `false` (not a
		// command) and a `{ prompt }` residual cannot occur; stay defensive.
		if (result === false || "prompt" in result) return false;
		if (result.failed) builtinFailed = true;
		// Scheduling is not credit admission; the session owns the actual retry preflight.
		if (result.agentInvoked) {
			hasAgentWork = true;
			costCapRefusalBeforeTurn = refusalBeforeCommand;
		}
		// A recovery command may have repaired a server the strict gate
		// failed on, so the gate re-evaluates before the next model turn.
		return true;
	};

	let extensionFailure = false;
	let extensionSendsObserved = false;
	let extensionShutdownRequested = false;
	const extensionSends = new HeadlessShutdownCoordinator({
		isShutdownRequested: () => false,
		performShutdown: async () => {},
	});
	const drainExtensionWork = async (): Promise<void> => {
		if (!extensionSendsObserved || asyncWaitExpired || builtinSignal.aborted || session.isDisposed) return;
		if (cfgAsyncPrintWake.get(session.settings) && deadlineTimer === undefined) armDeadline();
		do {
			if (await expires(extensionSends.drain())) {
				asyncWaitExpired = true;
				return;
			}
			if (builtinSignal.aborted || session.isDisposed) return;
			if (await expires(session.waitForIdle())) {
				asyncWaitExpired = true;
				return;
			}
		} while (extensionSends.hasPendingTasks);
	};

	// Discriminates a store failure from any other dispose rejection below.
	let persistenceFailure: Error | undefined;
	session.sessionManager.onPersistenceError(error => {
		persistenceFailure = error;
		writeStderrLine(formatPersistenceFailure(error.message));
	});
	session.sessionManager.onPersistenceNotice(notice => {
		writeStderrLine(`Warning: ${formatPersistenceNotice(notice)}`);
	});

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		if (event.type === "agent_start") hasAgentWork = true;
		// In JSON mode, output all events
		if (mode === "json") {
			stdout.writeLine(`${JSON.stringify(printableEvent(event))}\n`);
		} else if (
			event.type === "notice" &&
			(event.source === CREDENTIAL_DISABLED_NOTICE_SOURCE ||
				event.source === COST_GATE_NOTICE_SOURCE ||
				event.source === HINDSIGHT_NOTICE_SOURCE ||
				event.source === MNEMOPI_NOTICE_SOURCE ||
				event.source === SPOTLIGHT_NOTICE_SOURCE)
		) {
			// Text mode renders no session notices, but an automatic sign-out must not stay
			// hidden behind a sibling account that quietly answers the prompt, a run must
			// say when it crossed its cost thresholds, a memory failure must not pass
			// as an answer that used memories, and Spotlight must say when it lost its
			// credential and fell back to unranked cuts.
			writeStderrLine(event.source === COST_GATE_NOTICE_SOURCE ? event.message : `Warning: ${event.message}`);
		} else if (event.type === "auto_retry_start") {
			// Text mode shows only `Working...` while a turn runs; a turn stuck retrying
			// (offline, an outage) must say why instead of looking like a slow answer.
			writeStderrLine(`Retrying (${event.attempt}/${event.maxAttempts}): ${singleLine(event.errorMessage)}`);
		}
	});

	await initializeExtensions(session, {
		mode: mode === "json" ? "json" : "print",
		trackExtensionSend: task => {
			extensionSendsObserved = true;
			extensionSends.track(task);
		},
		onShutdown: () => {
			extensionShutdownRequested = true;
		},
		reportSendError: (action, err) => {
			extensionFailure = true;
			writeStderrLine(
				`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${singleLine(err.message)}`,
			);
		},
		reportRuntimeError: err => {
			extensionFailure = true;
			writeStderrLine(`Extension error (${singleLine(err.extensionPath)}): ${singleLine(err.error)}`);
		},
	});

	const timeoutMs = resolveMCPTimeoutMs();
	const strict = $flag("OMP_MCP_REQUIRE_READY");
	let strictMCPFailure = false;
	// Warn once per unavailable server across evaluations: readiness is
	// re-evaluated after a dispatched recovery command, and a still-broken
	// server must not repeat its warning on every pass.
	const warnedUnavailable = new Set<string>();
	/** Await manager startup and bind its current tool set; report unavailable server names. */
	const evaluateReadiness = async (): Promise<string[]> => {
		if (!options.mcpManager) return [];
		const readiness = await options.mcpManager.waitForStartup(timeoutMs);
		// The manager's initial callback may have fired before SDK wiring, or a
		// reconnect may have fired it without awaiting the session mutation.
		// Refresh is serialized by AgentSession, so turn one sees the final snapshot.
		await session.refreshMCPTools(options.mcpManager.getTools());
		const unavailable: string[] = [];
		for (const name of readiness.pending) {
			const server = singleLine(name);
			unavailable.push(server);
			if (warnedUnavailable.has(server)) continue;
			warnedUnavailable.add(server);
			const after = timeoutMs > 0 ? ` after ${timeoutMs}ms` : "";
			writeStderrLine(`Warning: MCP server "${server}" not ready${after}; its tools are unavailable for this run.`);
		}
		for (const { name, error } of readiness.failed) {
			const server = singleLine(name);
			unavailable.push(server);
			if (warnedUnavailable.has(server)) continue;
			warnedUnavailable.add(server);
			writeStderrLine(
				`Warning: MCP server "${server}" failed to connect: ${singleLine(error)}; its tools are unavailable for this run.`,
			);
		}
		return unavailable;
	};
	let unavailable: string[] = [];
	const reportStrictFailure = (): void => {
		if (strictMCPFailure) return;
		writeStderrLine(`Error: MCP servers not ready: ${unavailable.join(", ")}`);
		strictMCPFailure = true;
	};

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};
	const prepareAgentTurn = async (): Promise<boolean> => {
		if (extensionShutdownRequested || signalTeardownActive()) return false;
		unavailable = await evaluateReadiness();
		if (extensionShutdownRequested || signalTeardownActive()) return false;
		if (strict && unavailable.length > 0) {
			reportStrictFailure();
			return false;
		}
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		return true;
	};
	const { deadline } = options;
	let deadlineReached: PromiseWithResolvers<true> | undefined;
	// setTimeout overflows past 2^31-1 ms and fires in ~1 ms (#12375), and `--max-time 600h`
	// is valid: wait in bounded slices and recheck the absolute deadline after each one.
	let deadlineTimer: NodeJS.Timeout | undefined;
	const armDeadline = (): void => {
		if (deadline === undefined || builtinSignal.aborted) return;
		if (!deadlineReached) {
			deadlineReached = Promise.withResolvers<true>();
			builtinSignal.addEventListener("abort", () => clearTimeout(deadlineTimer), { once: true });
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) deadlineReached.resolve(true);
		else deadlineTimer = setTimeout(armDeadline, Math.min(remaining, MAX_TIMER_MS));
	};
	// Dispose cancels the jobs and retry recovery; an abandoned wait then resolves or rejects unobserved.
	const expires = async (work: Promise<unknown>): Promise<boolean> => {
		if (!deadlineReached) {
			await work;
			return false;
		}
		if (!(await Promise.race([work.then(() => false), deadlineReached.promise]))) return false;
		work.catch(() => {});
		return true;
	};
	let asyncWaitExpired = false;
	const promptTurn = async (text: string, images?: PrintModeOptions["initialImages"]): Promise<void> => {
		if (!(await prepareAgentTurn())) return;
		if (cfgAsyncPrintWake.get(session.settings)) {
			if (deadlineTimer === undefined) armDeadline();
			if (deadline !== undefined && Date.now() >= deadline) {
				asyncWaitExpired = true;
				return;
			}
		}
		costCapRefusalBeforeTurn = session.costCapRefusal;
		const admission = logger.time("print:prompt", () =>
			images !== undefined ? session.prompt(text, { images }) : session.prompt(text),
		);
		if (cfgAsyncPrintWake.get(session.settings) && (await expires(admission))) {
			asyncWaitExpired = true;
			return;
		}
		const admitted = await admission;
		if (admitted) hasAgentWork = true;
		await drainExtensionWork();
	};

	if (!extensionShutdownRequested && initialMessage !== undefined) {
		await promptTurn(initialMessage, initialImages);
	}
	for (const message of messages) {
		if (asyncWaitExpired || strictMCPFailure || extensionShutdownRequested || signalTeardownActive()) break;
		if (await dispatchCliMessage(message)) {
			await drainExtensionWork();
			continue;
		}
		await promptTurn(message);
	}
	// A run with no model turn (every input consumed locally, or none) still
	// reports strict unreadiness: `OMP_MCP_REQUIRE_READY=1 omp -p '/mcp reauth
	// foo'` that failed to repair its server exits with the strict error, not
	// only the builtin's own failure.
	if (strict && !hasAgentWork && !strictMCPFailure) {
		unavailable = await evaluateReadiness();
		if (unavailable.length > 0) reportStrictFailure();
	}
	if (!asyncWaitExpired) await drainExtensionWork();

	// Opt-in (`async.printWake` / `--wait-async`): background jobs the run started
	// would otherwise be cancelled by dispose. Keep the process alive until owned
	// jobs, child agents, peer deliveries and their resulting loops retire.
	if (!asyncWaitExpired && hasAgentWork && !strictMCPFailure && cfgAsyncPrintWake.get(session.settings)) {
		if (deadlineTimer === undefined) armDeadline();
		asyncWaitExpired = (await expires(session.waitForRunEnd())) && session.isRunActive;
		if (asyncWaitExpired) {
			writeStderrLine("Error: --max-time reached before the run ended; any running jobs were cancelled.");
		}
	}

	// From this point onward a late blocker must be recorded without starting a
	// primary turn whose response print mode would never emit.
	session.prepareForHeadlessAdvisorDrain();
	// Past --max-time a follow-up turn can still sit in retry backoff, which this wait
	// includes and only dispose cancels: skip it so teardown can run.
	if (!asyncWaitExpired) await session.waitForIdle();

	// Read via the session accessor, not the raw state tail: a classifier
	// refusal is pruned from active context at settle, and an aborted turn
	// can trail synthetic tool results — both would hide the terminal
	// assistant message (and its error) from a last-element read.
	const currentAssistant = hasAgentWork ? session.getLastAssistantMessage() : undefined;
	const assistantMsg = currentAssistant !== previousAssistant ? currentAssistant : undefined;
	const costCapped = !strictMCPFailure && session.costCapRefusal !== costCapRefusalBeforeTurn;
	// The terminal stop reason decides the process exit code in every output
	// mode: `--mode json` used to report success for the same turn-fatal error
	// text mode exits 1 on (issue #11498). Silent aborts (plan-mode compaction
	// transitions) and aborts initiated by signal teardown stay non-fatal here;
	// postmortem owns the signal-specific exit code (130/143/129).
	const terminalFailure =
		!strictMCPFailure &&
		!costCapped &&
		assistantMsg !== undefined &&
		(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
		!isSilentAbort(assistantMsg) &&
		!signalTeardownActive();
	const deadlineInterruptedTurn =
		hasAgentWork &&
		!costCapped &&
		!signalTeardownActive() &&
		options.deadline !== undefined &&
		Date.now() >= options.deadline &&
		(assistantMsg === undefined || assistantMsg.stopReason === "aborted");
	if (deadlineInterruptedTurn && !terminalFailure && !asyncWaitExpired) {
		writeStderrLine("Error: --max-time reached before the model turn completed.");
	}

	// In text mode, output the final response. A terminal failure prints only
	// the error line below; JSON mode already emitted the assistant message and
	// stop reason through the event subscription.
	if (
		mode === "text" &&
		!terminalFailure &&
		!strictMCPFailure &&
		!asyncWaitExpired &&
		!costCapped &&
		!deadlineInterruptedTurn
	) {
		if (assistantMsg) {
			if (
				assistantMsg.errorMessage &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted"
			) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}

			// Output text content; narration the provider returned as thinking is part of the reply.
			for (const content of presentNarrationAsAnswer(assistantMsg).content) {
				if (content.type === "text") {
					stdout.writeLine(`${sanitizeText(content.text)}\n`);
				} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
					stdout.writeLine(`${sanitizeText(content.thinking)}\n`);
				}
			}
		}
		session.setTextOutputCommitted(true);
	}

	// A turn-fatal exit cannot hold automation for the full normal drain budget. A run
	// past --max-time skips the drain entirely: its jobs are still live until dispose.
	if (!strictMCPFailure && !asyncWaitExpired && !deadlineInterruptedTurn) {
		// Print mode's drain budget covers a fallback-chain switch; the reviewer's
		// verdict is the point of a headless advisor run, so wait through recovery,
		// and wait on `strict` reviewers past the budget like every primary boundary.
		await session.waitForAdvisorCatchup(
			terminalFailure || costCapped
				? PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS
				: PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS,
			{ waitThroughRecovery: true, strictWithoutDeadline: true },
		);
	}
	await drainExtensionWork();
	if (asyncWaitExpired) {
		writeStderrLine("Error: --max-time reached before background work settled; any running jobs were cancelled.");
	}
	// Error spans must reach the exporter; the postmortem `exit` handler can't await.
	if (terminalFailure) await flushTelemetryExport();

	// Block shutdown until every serialized stdout write (including the final
	// agent_end and late JSON advisor events) has drained; process.exit would
	// otherwise discard the buffered tail and truncate the last record.
	await stdout.drained();
	// Dispose before returning the status instead of hard-exiting ahead of it:
	// the awaited `dispose()` runs the browser reaper (releaseTabsForOwner), so
	// an OMP-owned Chromium cannot survive the exit (issue #5643).
	//
	// A latched store failure rethrows from `dispose()`; report it as lost
	// durability rather than letting it escape as a raw fatal dump.
	let durabilityFailure = false;
	try {
		await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
	} catch (error) {
		if (!persistenceFailure || error !== persistenceFailure) throw error;
		durabilityFailure = true;
		// The store is still failing at teardown, so this is the moment the
		// transcript stops being retryable and becomes lost.
		writeStderrLine(formatPersistenceDurabilityFailure(persistenceFailure.message));
		await stderrTail;
	}

	await extensionSends.drain();
	await stdout.drained();
	// Text mode reports the terminal failure on stderr exactly as before: same
	// line, same ordering after dispose, without terminating the process here.
	if (mode === "text" && terminalFailure && assistantMsg) {
		const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
		if (!process.stderr.write(`${errorLine}\n`)) {
			const { promise, resolve } = Promise.withResolvers<void>();
			process.stderr.once("drain", resolve);
			await promise;
		}
	}

	await stderrTail;
	if (
		terminalFailure ||
		durabilityFailure ||
		strictMCPFailure ||
		extensionFailure ||
		builtinFailed ||
		asyncWaitExpired ||
		deadlineInterruptedTurn
	)
		return 1;
	return costCapped ? PRINT_MODE_COST_CAP_EXIT_CODE : 0;
}
