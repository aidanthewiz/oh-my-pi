/**
 * A subagent run that holds one spawn-semaphore permit until it settles.
 *
 * The task tool starts each run after the complete call passes validation.
 * The owner binds its abort signal and progress/artifact sinks with
 * {@link SpawnRun.attach}.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { TextTap } from "../job-widgets/text-tap";
import { TOOLS_SOURCE_ID } from "../job-widgets/types";
import type { AgentRef } from "../registry/agent-registry";
import { TOOLS_SOURCE_LABEL } from "./widget-inputs";

/** Wall-clock stamps a spawn reports to the executor: call time and permit time. */
export interface SpawnLaunchTiming {
	invokedAt: number;
	acquiredAt: number;
}

/** Permit source bounding concurrent subagents; the task tool's session semaphore. */
export interface SpawnPermit {
	acquire(signal: AbortSignal): Promise<void>;
	release(): void;
}

/** Everything the run body needs from its `SpawnRun`. */
export interface SpawnRunBody {
	signal: AbortSignal;
	timing: SpawnLaunchTiming;
	onUpdate: AgentToolUpdateCallback<TaskToolDetails>;
	onArtifactsRetained: (cleanup: () => Promise<void>) => void;
	/** The run's {@link SpawnRun.tools} tap. */
	tools: TextTap;
	onAgentRegistered: (ref: AgentRef) => void;
}

/** Owner bindings applied before a run starts. */
export interface SpawnRunOwner {
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
	onArtifactsRetained?: (cleanup: () => Promise<void>) => void;
	onAgentRegistered?: (ref: AgentRef) => void;
}

export class SpawnRun {
	readonly #controller = new AbortController();
	#onUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined;
	#onArtifactsRetained: ((cleanup: () => Promise<void>) => void) | undefined;
	#onAgentRegistered: ((ref: AgentRef) => void) | undefined;
	/**
	 * The subagent's finished tool calls with their results, as the `tools`
	 * source of its job widget; closed once the run settles.
	 */
	readonly tools = new TextTap(TOOLS_SOURCE_ID, TOOLS_SOURCE_LABEL);
	#ownerRef: WeakRef<AgentRef> | undefined;
	get ownerRef(): AgentRef | undefined {
		return this.#ownerRef?.deref();
	}
	/** Resolves once the permit is held; rejects with the acquire error when aborted first. */
	readonly started: Promise<SpawnLaunchTiming>;
	/** The run's payload; rejects only when `started` does. */
	readonly result: Promise<AgentToolResult<TaskToolDetails>>;

	/** Acquire a permit, then run `body` and release the permit when it settles. */
	constructor(permit: SpawnPermit, body: (run: SpawnRunBody) => Promise<AgentToolResult<TaskToolDetails>>) {
		const invokedAt = Date.now();
		this.started = permit.acquire(this.#controller.signal).then(() => ({ invokedAt, acquiredAt: Date.now() }));
		this.result = this.started.then(async timing => {
			try {
				return await body({
					signal: this.#controller.signal,
					timing,
					onUpdate: update => this.#onUpdate?.(update),
					onArtifactsRetained: cleanup => {
						if (this.#onArtifactsRetained) this.#onArtifactsRetained(cleanup);
						else void cleanup();
					},
					tools: this.tools,
					onAgentRegistered: ref => {
						this.#ownerRef = new WeakRef(ref);
						this.#onAgentRegistered?.(ref);
					},
				});
			} finally {
				permit.release();
			}
		});
		const closeTools = () => this.tools.close();
		void this.result.then(closeTools, closeTools);
	}

	/** Bind the owner's abort signal and progress/artifact sinks. */
	attach(owner: SpawnRunOwner): void {
		const signal = owner.signal;
		if (signal?.aborted) this.#controller.abort(signal.reason);
		else if (signal) {
			const onAbort = () => this.#controller.abort(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			// The owner signal can outlive the run (a session- or job-scoped signal that never
			// aborts); drop the listener once the run settles so the signal does not pin it.
			const detach = () => signal.removeEventListener("abort", onAbort);
			void this.result.then(detach, detach);
		}
		this.#onUpdate = owner.onUpdate;
		this.#onArtifactsRetained = owner.onArtifactsRetained;
		this.#onAgentRegistered = owner.onAgentRegistered;
		const ref = this.ownerRef;
		if (ref) this.#onAgentRegistered?.(ref);
	}
}
