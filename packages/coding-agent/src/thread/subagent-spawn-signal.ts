/**
 * Earliest sign that a session is about to spawn subagents: its model is
 * streaming spawning tool calls. Main-thread sessions feed their streamed
 * assistant events here and, whenever the expected number of spawns grows,
 * let the worker pool start a worker those spawns will need
 * (`prewarmSubagentWorker`), so it boots while the arguments are still
 * streaming instead of after dispatch.
 *
 * Spawning calls: a `task` call (one spawn from its first event, then one per
 * `tasks[]` item whose opening brace has streamed), and an `eval` call once its streamed code
 * mentions `agent(` or `workpool(` (the eval subagent helpers; most cells never
 * spawn, so the name alone is no signal; counted as one spawn).
 */
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";

/** Eval helpers that spawn subagents, as they appear in streamed cell code. */
const EVAL_SPAWN_CALL = /\b(?:agent|workpool)\s*\(/;
/** Characters of an eval call's streamed arguments kept so a helper name split across deltas still matches. */
const EVAL_TAIL_CHARS = 16;

/** Five key characters, each encoded as `\uXXXX`, plus the quotes. */
const TASKS_KEY_MAX_CHARS = 32;

/** Counts object openings in the root `tasks` array without retaining assignments or starting work. */
class TaskItemsCounter {
	#depth = 0;
	#inString = false;
	#escaped = false;
	#expectKey = false;
	#keyLiteral: string | undefined;
	#tasksKey = false;
	#inTasks = false;
	#stopped = false;
	#itemsOpened = 0;

	get itemsOpened(): number {
		return this.#itemsOpened;
	}

	append(delta: string): void {
		for (const char of delta) {
			if (this.#stopped) return;
			if (this.#inString) {
				if (this.#keyLiteral !== undefined) {
					this.#keyLiteral = this.#keyLiteral.length < TASKS_KEY_MAX_CHARS ? this.#keyLiteral + char : undefined;
				}
				if (this.#escaped) this.#escaped = false;
				else if (char === "\\") this.#escaped = true;
				else if (char === '"') {
					this.#inString = false;
					if (this.#keyLiteral !== undefined) {
						try {
							this.#tasksKey = JSON.parse(this.#keyLiteral) === "tasks";
						} catch (error) {
							if (!(error instanceof SyntaxError)) throw error;
							this.#stopped = true;
						}
						this.#keyLiteral = undefined;
					}
				}
				continue;
			}
			const atItemLevel = this.#inTasks && this.#depth === 2;
			switch (char) {
				case '"':
					if (atItemLevel) this.#stopped = true;
					this.#inString = true;
					if (this.#depth === 1 && this.#expectKey) {
						this.#tasksKey = false;
						this.#keyLiteral = '"';
					}
					break;
				case "{":
				case "[":
					if (this.#depth === 0 && char !== "{") this.#stopped = true;
					if (this.#depth === 1 && !this.#expectKey && this.#tasksKey) {
						if (char === "[") this.#inTasks = true;
						else this.#stopped = true;
					}
					if (atItemLevel) {
						if (char === "{") this.#itemsOpened++;
						else this.#stopped = true;
					}
					this.#depth++;
					if (this.#depth === 1) this.#expectKey = true;
					break;
				case "}":
				case "]":
					this.#depth--;
					if (this.#inTasks && this.#depth === 1) this.#inTasks = false;
					if (this.#depth <= 0) this.#stopped = true;
					break;
				case ":":
					if (this.#depth === 1) this.#expectKey = false;
					break;
				case ",":
					if (this.#depth === 1) this.#expectKey = true;
					break;
				case " ":
				case "\n":
				case "\r":
				case "\t":
					break;
				default:
					if (atItemLevel) this.#stopped = true;
			}
		}
	}
}

/** One streaming tool call of the current message. */
type CallState =
	| { readonly kind: "task"; readonly scanner: TaskItemsCounter; spawns: number }
	| { readonly kind: "eval"; tail: string; spawns: number }
	| { readonly kind: "other"; spawns: 0 };

/** Per-message counter of spawns its streaming tool calls are about to make; see the module doc. */
export class SubagentSpawnSignal {
	/** Streaming tool calls of the current message, by content index. */
	readonly #calls = new Map<number, CallState>();
	/** Spawns last reported for the current message. */
	#reported = 0;

	/**
	 * Feed one streamed assistant event; returns the number of spawns the message's tool
	 * calls are expected to make whenever it grows, else `undefined`.
	 */
	observe(event: AssistantMessageEvent): number | undefined {
		if (event.type === "start") {
			this.#calls.clear();
			this.#reported = 0;
			return undefined;
		}
		if (event.type !== "toolcall_start" && event.type !== "toolcall_delta") return undefined;
		const block = event.partial.content[event.contentIndex];
		if (block?.type !== "toolCall" || !block.name) return undefined;
		let call = this.#calls.get(event.contentIndex);
		if (!call) {
			call =
				block.name === "task"
					? { kind: "task", scanner: new TaskItemsCounter(), spawns: 1 }
					: block.name === "eval"
						? { kind: "eval", tail: "", spawns: 0 }
						: { kind: "other", spawns: 0 };
			this.#calls.set(event.contentIndex, call);
		}
		if (event.type === "toolcall_delta") this.#feed(call, event.delta);
		let expected = 0;
		for (const state of this.#calls.values()) expected += state.spawns;
		if (expected <= this.#reported) return undefined;
		this.#reported = expected;
		return expected;
	}

	#feed(call: CallState, delta: string): void {
		if (call.kind === "task") {
			call.scanner.append(delta);
			// Count an item once its `{` streams: its assignment text still gives the worker time to boot.
			call.spawns = Math.max(1, call.scanner.itemsOpened);
		} else if (call.kind === "eval" && call.spawns === 0) {
			const scanned = call.tail + delta;
			if (EVAL_SPAWN_CALL.test(scanned)) call.spawns = 1;
			else call.tail = scanned.slice(-EVAL_TAIL_CHARS);
		}
	}
}
