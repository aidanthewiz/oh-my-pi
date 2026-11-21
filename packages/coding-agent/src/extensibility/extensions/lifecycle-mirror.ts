/**
 * Shared wire-session-event → extension-event mapping plus the collab-guest
 * lifecycle mirror built on it.
 *
 * A collab guest renders host activity through the ordinary event pipeline,
 * but its own agent loop never runs, so `AgentSession`'s
 * `#emitExtensionEvent` path stays silent for the whole join. Lifecycle
 * integrations installed as extensions (e.g. Herdr's pane-state reporter)
 * therefore never see `agent_start`/`agent_end` and report a stale state for
 * the guest's pane. The mapping below is the single owner of that wire-event
 * → extension-event translation — `AgentSession.#emitExtensionEvent` calls it
 * for its own events and the guest's {@link GuestLifecycleEmitter} calls it
 * for mirrored host events, so neither side can drift from the other.
 *
 * Session-only event types that never travel on the collab wire
 * (`retry_fallback_*`, `ttsr_triggered`, `todo_reminder`, `goal_updated`, …)
 * are mapped here too, so the session's copy stays complete; the guest
 * simply never sees those events (see `WIRE_AGENT_EVENT_TYPES` in
 * `collab/host.ts`).
 *
 * Extensions keep one `agent_end` per stopped model loop: the session's
 * `agent_pause` (a loop stop inside a run) maps to `agent_end` with
 * `willContinue` (and `awaitingAsyncWork` when only outside work resumes the
 * run), the session's `agent_end` (the run's end) to a plain `agent_end`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentLifecycleState, AgentSessionEvent, AgentSessionLifecycleEvent } from "../../session/agent-session";
import type { ExtensionRunner } from "./runner";
import type {
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	RetryFallbackAppliedEvent,
	RetryFallbackSucceededEvent,
	TodoReminderEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TtsrTriggeredEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "./types";
import type { GoalUpdatedEvent } from "../shared-events";

/**
 * Clone one top-level notification field without ever returning an object
 * owned by the live session. Most values take the lossless structured-clone
 * path. If a third-party metadata object contains functions or other
 * unsupported values, JSON sanitization drops those values; a cyclic/non-JSON
 * value finally degrades to a descriptive string rather than retaining a
 * shared mutable reference.
 */
function cloneNotificationField(value: unknown): unknown {
	try {
		return structuredClone(value);
	} catch {}
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return JSON.parse(json) as unknown;
	} catch {}
	return String(value);
}

/** Build a detached, notification-only snapshot of an `AgentMessage`. */
function cloneMessageNotification(message: AgentMessage): AgentMessage {
	const snapshot: Record<PropertyKey, unknown> = {};
	for (const key of Reflect.ownKeys(message)) {
		const descriptor = Object.getOwnPropertyDescriptor(message, key);
		if (!descriptor?.enumerable) continue;
		snapshot[key] = cloneNotificationField(Reflect.get(message, key));
	}
	return snapshot as unknown as AgentMessage;
}

/** Extension events `extensionEventFromSessionEvent` maps onto. */
export type MappedExtensionEvent =
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent
	| RetryFallbackAppliedEvent
	| RetryFallbackSucceededEvent
	| TtsrTriggeredEvent
	| TodoReminderEvent
	| GoalUpdatedEvent;
/**
 * Map a session event onto the extension event `AgentSession` emits for it
 * (see `#emitExtensionEvent` there). Returns `null` for events with no
 * extension counterpart, so callers skip the runner entirely instead of
 * emitting a no-op.
 *
 * @param event Session event (locally emitted or mirrored over the collab wire).
 * @param turnIndex Zero-based turn counter the caller owns; `AgentSession`
 *   resets it on `agent_start`, the collab guest's {@link GuestLifecycleEmitter}
 *   does the same for its mirrored stream.
 */
export function extensionEventFromSessionEvent(
	event: AgentSessionEvent | AgentSessionLifecycleEvent,
	turnIndex: number,
	runId: string,
): MappedExtensionEvent | null {
	switch (event.type) {
		case "agent_start":
			return { type: "agent_start", runId };
		case "agent_pause":
			return {
				type: "agent_end",
				runId,
				messages: event.messages,
				willContinue: true,
				...(event.awaiting ? { awaitingAsyncWork: true } : {}),
			};
		case "agent_end":
			return {
				type: "agent_end",
				runId,
				messages: event.messages,
				...("isTerminal" in event && !event.isTerminal ? { willContinue: true } : {}),
				...("awaitingAsyncWork" in event && event.awaitingAsyncWork ? { awaitingAsyncWork: true } : {}),
			};
		case "turn_start":
			return { type: "turn_start", turnIndex, timestamp: Date.now() };
		case "turn_end":
			return {
				type: "turn_end",
				turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
		case "message_start":
			return { type: "message_start", message: event.message };
		case "message_update":
			return { type: "message_update", message: event.message, assistantMessageEvent: event.assistantMessageEvent };
		case "message_end": {
			// `message_end` is a notification, not a context-rewrite hook. Detach its
			// payload so an async observer that mutates the event after an `await`
			// cannot race the owner's use of the same reference — locally that is
			// mid-run maintenance, on a collab guest it is the transcript the same
			// object is rendered from.
			const messageEnd: MessageEndEvent = {
				type: "message_end",
				message: cloneMessageNotification(event.message),
			};
			return messageEnd;
		}
		case "tool_execution_start": {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
			};
			return extensionEvent;
		}
		case "tool_execution_update": {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			return extensionEvent;
		}
		case "tool_execution_end": {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError ?? false,
			};
			return extensionEvent;
		}
		case "auto_compaction_start":
			return { type: "auto_compaction_start", reason: event.reason, action: event.action };
		case "auto_compaction_end":
			return {
				type: "auto_compaction_end",
				action: event.action,
				result: event.result,
				aborted: event.aborted,
				willRetry: event.willRetry,
				errorMessage: event.errorMessage,
				skipped: event.skipped,
			};
		case "auto_retry_start":
			return {
				type: "auto_retry_start",
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				errorMessage: event.errorMessage,
				errorId: event.errorId,
			};
		case "auto_retry_end":
			return {
				type: "auto_retry_end",
				success: event.success,
				attempt: event.attempt,
				finalError: event.finalError,
				retryErrors: event.retryErrors,
			};
		case "retry_fallback_applied":
			return {
				type: "retry_fallback_applied",
				from: event.from,
				to: event.to,
				role: event.role,
				reason: event.reason,
			};
		case "retry_fallback_succeeded":
			return { type: "retry_fallback_succeeded", model: event.model, role: event.role };
		case "ttsr_triggered":
			return { type: "ttsr_triggered", rules: event.rules };
		case "todo_reminder":
			return {
				type: "todo_reminder",
				todos: event.todos,
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			};
		case "goal_updated":
			return { type: "goal_updated", goal: event.goal, state: event.state };
		default:
			return null;
	}
}

/**
 * Deduplicates guest lifecycle boundaries for UI and extension consumers.
 *
 * Owns the per-join turn index the session maintains for its own extension
 * events (`#turnIndex`): the wire's turn_start/turn_end carry no counter, so
 * this class numbers turns itself exactly like `AgentSession` numbers its
 * own (zero-based, reset on `agent_start`, incremented after each
 * `turn_end`).
 *
 * UI consumers receive accepted boundaries synchronously.
 * Extension emissions share one promise queue so handler completion order matches event
 * order even when a handler awaits. Delivery is never awaited
 * inline: a slow extension handler must not stall the guest's frame
 * application.
 */
export class GuestLifecycleEmitter {
	#turnIndex = 0;
	#runId: string | null = null;
	#inferredRunId: string | null = null;
	#openRuns = new Set<string>();
	#chain: Promise<void> = Promise.resolve();
	/** True until a terminal host settle, including scheduled continuations. */
	#active = false;
	#loopOpen = false;
	readonly #onEvent?: (event: AgentSessionLifecycleEvent) => void;

	constructor(onEvent?: (event: AgentSessionLifecycleEvent) => void) {
		this.#onEvent = onEvent;
	}

	reconcile(runner: ExtensionRunner | undefined, state: AgentLifecycleState, messages: AgentMessage[]): void {
		// A null owner abandons mirror tracking without proving host completion.
		if (state === null || state.phase === "idle") {
			for (const runId of this.#openRuns) {
				if (runId !== state?.runId) {
					this.#emit(
						runner,
						{
							type: "agent_end",
							runId,
							messages,
							isTerminal: state === null && runId === this.#runId,
							outcome: "unknown",
						},
						state !== null,
					);
				}
			}
		}
		if (state && state.phase !== "idle") {
			if (this.#runId !== state.runId || (state.phase === "running" && !this.#loopOpen)) {
				this.#emit(runner, { type: "agent_start", runId: state.runId }, state.phase === "running");
				this.#inferredRunId = state.runId;
			}
			if (state.phase === "continuing" && this.#loopOpen) {
				this.#emit(
					runner,
					{
						type: "agent_end",
						runId: state.runId,
						messages,
						isTerminal: false,
						outcome: state.outcome,
						yielded: state.awaitingAsyncWork === true,
						...(state.awaitingAsyncWork === true ? { awaitingAsyncWork: true } : {}),
					},
					state.awaitingAsyncWork === true,
				);
			}
		} else if (state && (this.#active || this.#runId !== state.runId)) {
			const render = this.#active;
			if (this.#runId !== state.runId) this.#emit(runner, { type: "agent_start", runId: state.runId }, render);
			this.#emit(
				runner,
				{ type: "agent_end", runId: state.runId, messages, isTerminal: true, outcome: state.outcome ?? "unknown" },
				render,
			);
		} else if (this.#active && this.#runId) {
			this.#emit(
				runner,
				{ type: "agent_end", runId: this.#runId, messages, isTerminal: true, outcome: "unknown" },
				false,
			);
		}
	}

	emit(runner: ExtensionRunner | undefined, event: AgentSessionLifecycleEvent): void {
		this.#emit(runner, event, true);
	}

	#emit(runner: ExtensionRunner | undefined, event: AgentSessionLifecycleEvent, render: boolean): void {
		if (event.type === "agent_start") {
			if (this.#inferredRunId === event.runId) {
				this.#inferredRunId = null;
				return;
			}
			this.#turnIndex = 0;
			this.#runId = event.runId;
			this.#inferredRunId = null;
			this.#active = true;
			this.#loopOpen = true;
			this.#openRuns.add(event.runId);
		} else if (event.type === "agent_end") {
			if (this.#runId === null) this.#emit(runner, { type: "agent_start", runId: event.runId }, render);
			if (event.isTerminal && event.runId === this.#runId) {
				for (const runId of this.#openRuns) {
					if (runId !== event.runId)
						this.#emit(runner, { type: "agent_end", runId, messages: event.messages, isTerminal: false }, render);
				}
			}
			const wasOpen = this.#openRuns.delete(event.runId);
			if (!wasOpen && !(event.isTerminal && event.runId === this.#runId && this.#active)) return;
			if (event.runId === this.#runId) {
				this.#inferredRunId = null;
				this.#loopOpen = false;
				this.#active = !event.isTerminal;
			}
		}
		if (render) this.#onEvent?.(event);
		const turnIndex = this.#turnIndex;
		if (event.type === "turn_end") this.#turnIndex++;
		if (!runner || (event.type !== "agent_start" && !runner.hasHandlers(event.type))) return;
		const runId = event.type === "agent_end" ? event.runId : (this.#runId ?? "");
		const mapped = extensionEventFromSessionEvent(event, turnIndex, runId);
		if (!mapped) return;
		this.#chain = this.#chain
			.then(() => runner.emit(mapped))
			.then(
				() => {},
				err => {
					logger.warn("collab guest extension event emit failed", { type: event.type, error: String(err) });
				},
			);
	}

	async drain(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.#chain;
			await pending;
		} while (pending !== this.#chain);
	}
}
