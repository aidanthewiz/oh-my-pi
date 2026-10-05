/**
 * A subagent run that holds one spawn-semaphore permit until it settles.
 *
 * The task tool starts each run after the complete call passes validation.
 * The owner binds its abort signal and progress/artifact sinks with
 * {@link SpawnRun.attach}.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

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
}

/** Owner bindings applied before a run starts. */
export interface SpawnRunOwner {
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
	onArtifactsRetained?: (cleanup: () => Promise<void>) => void;
}

export class SpawnRun {
	readonly #controller = new AbortController();
	#onUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined;
	#onArtifactsRetained: ((cleanup: () => Promise<void>) => void) | undefined;
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
				});
			} finally {
				permit.release();
			}
		});
		void this.result.catch(() => undefined);
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
	}
}
