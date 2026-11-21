/**
 * The root `AsyncJobManager` across subagent worker links (kind
 * `"async-job-manager"`, protocol in `./async-jobs-protocol`).
 *
 * Main side: every manager crossing to a worker is served by reference. Job ids,
 * rows, the running-job cap, delivery queues and sinks stay on the root's
 * manager; a worker-registered job's body runs in the worker (its `run`
 * function crosses), and main's cancellation aborts it through the run
 * context's signal. Delivery sinks, settle listeners and widget subscriptions a
 * worker registered are dropped when it exits, so owned deliveries dead-letter
 * exactly as for a disposed in-process session.
 *
 * A worker job's `process` and `widgetInputs` arrive as a {@link WireJobFeed};
 * {@link JobFeedMirror} keeps the latest pids, brief and source text main
 * pulled (each synchronous read starts one background pull) or the body pushed
 * as it settled, so the widget registry's final read sees the job's last output.
 *
 * Worker side: see `./async-jobs-remote`.
 */
import { randomUUID } from "node:crypto";
import {
	type AsyncJob,
	AsyncJobError,
	AsyncJobManager,
	type AsyncJobProcess,
	type AsyncJobRegisterOptions,
} from "../../async/job-manager";
import { TextTap } from "../../job-widgets/text-tap";
import type { JobTextSource, JobWidgetBrief, JobWidgetInputs, JobWidgetRegistry } from "../../job-widgets/types";
import { AgentRegistry, type AgentRef, isMintedAgentRef } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionLifecycleEvent } from "../../session/agent-session-events";
import type { AgentSessionHandle } from "../../session/agent-session-handle";
import type { ThreadId } from "../identity";
import { registerRpcError, type RpcServe } from "../rpc";
import { RemoteAgentSession } from "../remote-agent-session";
import { findRemoteSession, isRegisteredLocalSession } from "../session-directory";
import type { SessionRunLifecycleEvent } from "../session-mirror";
import type { ThreadService, WorkerPeer } from "../services";
import {
	ASYNC_JOB_MANAGER_KIND,
	type AsyncJobManagerProtocol,
	type AsyncJobOwnerKind,
	type AsyncJobWire,
	fromWireReason,
	type JobFeedDelta,
	toWireSignal,
	type WireJobFeed,
	type WireRegisterOptions,
	type WireRunContext,
	type WireWidgetProducer,
} from "./async-jobs-protocol";
import { RemoteAsyncJobManager } from "./async-jobs-remote";
import { ignoreSettle, PeerCleanups } from "./support";

registerRpcError("AsyncJobError", message => new AsyncJobError(message));

// ─────────────────────────────────────────────────────────────────────────────
// Main side
// ─────────────────────────────────────────────────────────────────────────────

/** Main-side mirror of a worker job's process. */
class MirroredProcess implements AsyncJobProcess {
	constructor(
		readonly command: string,
		readonly cwd: string,
		readonly mirror: JobFeedMirror,
	) {}

	pids(): readonly number[] {
		this.mirror.refresh();
		return this.mirror.pids;
	}
}

/** Main-side mirror of one worker widget source: the text received so far. */
class MirroredSource extends TextTap {}

/** Latest data of a worker job's {@link WireJobFeed}; implements its widget inputs over it. */
class JobFeedMirror implements JobWidgetInputs {
	readonly process: MirroredProcess | undefined;
	readonly widgetInputs: JobWidgetInputs | undefined;
	pids: readonly number[] = [];
	#brief: JobWidgetBrief | undefined;
	readonly #sources = new Map<string, MirroredSource>();
	readonly #pull: WireJobFeed["pull"];
	#pulling = false;
	#done = false;
	readonly #canAuthor: (feed: JobFeedMirror) => boolean;
	authorSignal: AbortSignal | undefined;

	constructor(feed: WireJobFeed, canAuthor: (feed: JobFeedMirror) => boolean) {
		this.#canAuthor = canAuthor;
		this.#pull = feed.pull;
		this.#brief = feed.brief;
		this.process = feed.process ? new MirroredProcess(feed.process.command, feed.process.cwd, this) : undefined;
		this.widgetInputs = feed.brief ? this : undefined;
	}

	canAuthor(): boolean {
		return this.#canAuthor(this);
	}

	/** Start one background pull unless one is in flight or the job settled. */
	refresh(): void {
		if (this.#pulling || this.#done) return;
		this.#pulling = true;
		Promise.resolve(this.#pull()).then(
			delta => {
				this.#pulling = false;
				if (!this.#done) this.apply(delta);
			},
			() => {
				// Closed link or dead worker: keep the last data, stop pulling.
				this.#done = true;
			},
		);
	}

	/** Adopt a delta; `final` is the settled body's last one, after which no pulls run. */
	apply(delta: JobFeedDelta, final = false): void {
		if (delta.pids) this.pids = delta.pids;
		if (delta.brief) this.#brief = delta.brief;
		for (const source of delta.sources ?? []) {
			let mirror = this.#sources.get(source.id);
			if (!mirror || source.reset) {
				mirror = new MirroredSource(source.id, source.label);
				this.#sources.set(source.id, mirror);
			}
			mirror.append(source.text);
			if (!source.open) mirror.close();
		}
		if (final) {
			this.#done = true;
			this.pids = [];
			for (const mirror of this.#sources.values()) mirror.close();
		}
	}

	sources(): readonly JobTextSource[] {
		this.refresh();
		return Array.from(this.#sources.values());
	}

	brief(): JobWidgetBrief {
		this.refresh();
		if (!this.#brief) throw new Error("Job has no widget brief");
		return this.#brief;
	}
}

/** Cloneable projection of a main job row. */
export function toJobWire(job: AsyncJob): AsyncJobWire {
	const process = job.process;
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		startTime: job.startTime,
		endTime: job.endTime,
		label: job.label,
		intent: job.intent,
		resultText: job.resultText,
		errorText: job.errorText,
		structured: job.structured,
		progressText: job.progressText,
		latestDetails: job.latestDetails,
		ownerId: job.ownerId,
		agentId: job.agentId,
		agentOutputPublished: job.agentOutputPublished,
		queued: job.queued,
		foreground: job.foreground,
		process: process
			? {
					command: process.command,
					cwd: process.cwd,
					// A mirror's cached pids: projecting must not pull from the worker that runs the job.
					pids:
						job.status !== "running"
							? []
							: process instanceof MirroredProcess
								? process.mirror.pids
								: [...process.pids()],
				}
			: undefined,
		hasWidgetInputs: job.widgetInputs !== undefined,
	};
}

function toJobWires(jobs: readonly AsyncJob[]): AsyncJobWire[] {
	return jobs.map(toJobWire);
}

/** Main-side registration options for a worker job. */
function mainRegisterOptions(options: WireRegisterOptions | undefined, feed: JobFeedMirror | undefined) {
	const result: AsyncJobRegisterOptions = {
		id: options?.id,
		ownerId: options?.ownerId,
		agentId: options?.agentId,
		onProgress: options?.onProgress,
		queued: options?.queued,
		foreground: options?.foreground,
		intent: options?.intent,
		process: feed?.process,
		widgetInputs: feed?.widgetInputs,
	};
	return result;
}

interface CapturedOwner {
	readonly manager: AsyncJobManager;
	readonly kind: AsyncJobOwnerKind;
	readonly capture: () => () => boolean;
	readonly isCurrent: () => boolean;
}

interface CapturedProducer {
	readonly wire: WireWidgetProducer;
	readonly manager: AsyncJobManager;
	readonly captureId: number;
	readonly session: RemoteAgentSession;
	readonly cancellation: AbortController;
	job?: AsyncJob;
	feed?: JobFeedMirror;
	task?: {
		readonly owner: AgentRef;
		readonly session: AgentSession | RemoteAgentSession;
		readonly sessionId: string;
		runId?: string;
		promptSequence?: number;
		readonly runs: Map<string, "running" | "continuing" | "terminal">;
		stop?: () => void;
	};
}

interface HeldWidgets {
	readonly id: number;
	readonly manager: AsyncJobManager;
	readonly registry: JobWidgetRegistry;
}

/** Main retains authority and admitted widget work for the worker link's lifetime. */
class PeerAsyncJobsState {
	readonly #owners = new Map<number, CapturedOwner>();
	readonly #heldWidgets = new Map<number, HeldWidgets>();
	readonly #producers = new Map<string, CapturedProducer>();
	#sessionOwners = new WeakMap<
		RemoteAgentSession,
		{ readonly manager: AsyncJobManager; readonly captureId: number }
	>();
	#widgets = new WeakMap<AsyncJobManager, HeldWidgets>();
	#nextId = 1;

	constructor(readonly threadId: ThreadId) {}

	captureOwner(manager: AsyncJobManager, kind: AsyncJobOwnerKind): number | undefined {
		if (kind !== "widget" && kind !== "lifetime") return undefined;
		const capture = kind === "widget" ? manager.captureWidgetOwnerCurrent : manager.captureOwnerLifetimeCurrent;
		if (!capture) return undefined;
		const id = this.#nextId++;
		this.#owners.set(id, { manager, kind, capture, isCurrent: capture.call(manager) });
		return id;
	}

	ownerCurrent(manager: AsyncJobManager, id: number): boolean {
		const owner = this.#owners.get(id);
		return (
			owner !== undefined &&
			owner.manager === manager &&
			owner.capture ===
				(owner.kind === "widget" ? manager.captureWidgetOwnerCurrent : manager.captureOwnerLifetimeCurrent) &&
			owner.isCurrent()
		);
	}

	bindSession(manager: AsyncJobManager, captureId: number, session: AgentSessionHandle): boolean {
		if (
			this.#owners.get(captureId)?.kind !== "widget" ||
			!this.ownerCurrent(manager, captureId) ||
			!(session instanceof RemoteAgentSession) ||
			session.home !== this.threadId ||
			findRemoteSession(session.instanceKey) !== session ||
			session.asyncJobManager !== manager ||
			session.isDisposed ||
			session.isSessionTransitioning
		)
			return false;
		const previous = this.#sessionOwners.get(session);
		if (previous) return previous.manager === manager && previous.captureId === captureId;
		this.#sessionOwners.set(session, { manager, captureId });
		return true;
	}

	captureProducer(
		manager: AsyncJobManager,
		captureId: number,
		session: AgentSessionHandle,
		kind: JobWidgetBrief["kind"],
	): WireWidgetProducer | undefined {
		if (
			this.#owners.get(captureId)?.kind !== "widget" ||
			!this.ownerCurrent(manager, captureId) ||
			(kind !== "bash" && kind !== "task") ||
			!(session instanceof RemoteAgentSession) ||
			session.home !== this.threadId ||
			findRemoteSession(session.instanceKey) !== session ||
			this.#sessionOwners.get(session)?.manager !== manager ||
			this.#sessionOwners.get(session)?.captureId !== captureId ||
			session.asyncJobManager !== manager ||
			session.isDisposed ||
			session.isSessionTransitioning
		)
			return undefined;
		const wire: WireWidgetProducer = { id: randomUUID(), sessionId: session.sessionManager.getSessionId(), kind };
		this.#producers.set(wire.id, { wire, manager, captureId, session, cancellation: new AbortController() });
		return wire;
	}

	#producerOwnerCurrent(producer: CapturedProducer): boolean {
		const { wire, manager, session, captureId } = producer;
		return (
			this.#producers.get(wire.id) === producer &&
			this.#owners.get(captureId)?.kind === "widget" &&
			this.ownerCurrent(manager, captureId) &&
			findRemoteSession(session.instanceKey) === session &&
			session.home === this.threadId &&
			session.asyncJobManager === manager &&
			!session.isDisposed &&
			!session.isSessionTransitioning &&
			session.sessionManager.getSessionId() === wire.sessionId
		);
	}

	bindProducer(
		manager: AsyncJobManager,
		wire: WireWidgetProducer | undefined,
		feed: JobFeedMirror,
		job: AsyncJob,
	): void {
		if (!wire) return;
		const producer = this.#producers.get(wire.id);
		if (
			!producer ||
			producer.manager !== manager ||
			producer.job ||
			producer.wire.sessionId !== wire.sessionId ||
			producer.wire.kind !== wire.kind ||
			job.type !== wire.kind ||
			job.ownerId !== producer.session.agentId ||
			feed.brief().kind !== wire.kind ||
			(wire.kind === "bash" ? !feed.process : !job.agentId) ||
			!this.#producerOwnerCurrent(producer)
		)
			return;
		producer.job = job;
		producer.feed = feed;
		feed.authorSignal = producer.cancellation.signal;
		void job.promise.then(() => this.revokeProducer(manager, wire.id));
	}

	bindTaskOwner(manager: AsyncJobManager, id: string, owner: AgentRef): boolean {
		const producer = this.#producers.get(id);
		if (
			!producer ||
			producer.manager !== manager ||
			producer.wire.kind !== "task" ||
			!producer.job ||
			manager.getJob(producer.job.id) !== producer.job ||
			producer.job.widgetInputs !== producer.feed ||
			producer.job.status !== "running" ||
			producer.job.agentId !== owner.id ||
			!isMintedAgentRef(owner) ||
			AgentRegistry.global().get(owner.id) !== owner ||
			owner.status === "aborted" ||
			!this.#producerOwnerCurrent(producer)
		)
			return false;
		if (producer.task) return producer.task.owner === owner;
		const session = owner.session;
		if (
			!session ||
			(!isRegisteredLocalSession(session) &&
				!(session instanceof RemoteAgentSession && findRemoteSession(session.instanceKey) === session)) ||
			session.asyncJobManager !== manager ||
			session.isDisposed ||
			session.isSessionTransitioning ||
			!Number.isSafeInteger(session.promptSequence)
		)
			return false;
		const lifecycle = session.lifecycleState;
		const runId = lifecycle?.phase === "idle" ? undefined : lifecycle?.runId;
		const task: NonNullable<CapturedProducer["task"]> = {
			owner,
			session,
			sessionId: session.sessionManager.getSessionId(),
			runId,
			promptSequence: runId === undefined ? undefined : session.promptSequence,
			runs: new Map(),
		};
		producer.task = task;
		if (task.runId) task.runs.set(task.runId, lifecycle?.phase === "continuing" ? "continuing" : "running");
		const stopRun = session.subscribeLifecycle((event: AgentSessionLifecycleEvent | SessionRunLifecycleEvent) => {
			if (event.type !== "agent_start" && event.type !== "agent_end") return;
			if (
				!this.#producerOwnerCurrent(producer) ||
				AgentRegistry.global().get(owner.id) !== owner ||
				owner.session !== session ||
				owner.status === "aborted" ||
				session.isDisposed ||
				session.isSessionTransitioning ||
				session.sessionManager.getSessionId() !== task.sessionId ||
				!Number.isSafeInteger(session.promptSequence) ||
				(task.promptSequence !== undefined && task.promptSequence !== session.promptSequence)
			) {
				this.revokeProducer(manager, id);
				return;
			}
			if (event.type === "agent_start") {
				task.promptSequence ??= session.promptSequence;
				if (!task.runs.has(event.runId)) task.runs.set(event.runId, "running");
				task.runId ??= event.runId;
			} else {
				if (!task.runs.has(event.runId)) return;
				task.runs.set(event.runId, event.isTerminal === false ? "continuing" : "terminal");
			}
			// A physical successor needs its predecessor's canonical non-terminal settle.
			while (task.runId !== undefined) {
				const state = task.runs.get(task.runId);
				if (state === "terminal") {
					this.revokeProducer(manager, id);
					return;
				}
				if (state !== "continuing" || task.runs.size < 2) return;
				const next = task.runs.keys();
				next.next();
				const successor = next.next().value;
				if (successor === undefined) return;
				task.runs.delete(task.runId);
				task.runId = successor;
			}
		});
		const stopRef = AgentRegistry.global().onChange(event => {
			if (
				event.ref.id === owner.id &&
				(AgentRegistry.global().get(owner.id) !== owner || owner.status === "aborted" || owner.session !== session)
			)
				this.revokeProducer(manager, id);
		});
		task.stop = () => {
			stopRun();
			stopRef();
		};
		return true;
	}

	producerCurrent(manager: AsyncJobManager, wire: WireWidgetProducer | undefined, feed: JobFeedMirror): boolean {
		if (!wire) return false;
		const producer = this.#producers.get(wire.id);
		const job = producer?.job;
		if (
			!producer ||
			producer.manager !== manager ||
			producer.wire.sessionId !== wire.sessionId ||
			producer.wire.kind !== wire.kind ||
			producer.feed !== feed ||
			!job ||
			manager.getJob(job.id) !== job ||
			job.type !== wire.kind ||
			job.ownerId !== producer.session.agentId ||
			job.widgetInputs !== feed ||
			job.process !== feed.process ||
			job.status !== "running" ||
			!this.#producerOwnerCurrent(producer)
		)
			return false;
		if (wire.kind === "bash") return true;
		const task = producer.task;
		if (
			!task ||
			AgentRegistry.global().get(task.owner.id) !== task.owner ||
			task.owner.status === "aborted" ||
			task.owner.session !== task.session ||
			task.session.isDisposed ||
			task.session.isSessionTransitioning ||
			task.promptSequence !== task.session.promptSequence ||
			task.session.sessionManager.getSessionId() !== task.sessionId
		)
			return false;
		const runId = task.session.lifecycleState?.runId;
		return task.runId !== undefined && task.runId === runId;
	}

	revokeProducer(manager: AsyncJobManager, id: string): void {
		const producer = this.#producers.get(id);
		if (!producer || producer.manager !== manager) return;
		this.#producers.delete(id);
		producer.task?.stop?.();
		producer.cancellation.abort();
	}

	holdWidgets(manager: AsyncJobManager): number | undefined {
		const registry = manager.widgets;
		if (!registry) return undefined;
		const previous = this.#widgets.get(manager);
		if (previous?.registry === registry) return previous.id;
		const held: HeldWidgets = { id: this.#nextId++, manager, registry };
		this.#heldWidgets.set(held.id, held);
		this.#widgets.set(manager, held);
		return held.id;
	}

	widgets(manager: AsyncJobManager, id: number): JobWidgetRegistry {
		const held = this.#heldWidgets.get(id);
		if (!held || held.manager !== manager) throw new Error("Widget registry does not belong to this job manager");
		return held.registry;
	}

	release(): void {
		for (const producer of this.#producers.values()) this.revokeProducer(producer.manager, producer.wire.id);
		this.#owners.clear();
		this.#heldWidgets.clear();
		this.#widgets = new WeakMap();
		this.#sessionOwners = new WeakMap();
	}
}

/** Everything workers registered on main managers (sinks, listeners, subscriptions). */
const cleanups = new PeerCleanups(ASYNC_JOB_MANAGER_KIND);

function serveManager(threadId: ThreadId): RpcServe<AsyncJobManager, AsyncJobManagerProtocol> {
	const state = new PeerAsyncJobsState(threadId);
	cleanups.track(threadId, () => state.release());
	return {
		widgets: manager => state.holdWidgets(manager),
		captureOwner: (manager, kind) => state.captureOwner(manager, kind),
		ownerCurrent: (manager, id) => state.ownerCurrent(manager, id),
		widgetSession: (manager, captureId, session) => state.bindSession(manager, captureId, session),
		widgetProducer: (manager, captureId, session, kind) => state.captureProducer(manager, captureId, session, kind),
		widgetProducerBindTask: (manager, producerId, owner) => state.bindTaskOwner(manager, producerId, owner),
		widgetProducerRevoke: (manager, producerId) => state.revokeProducer(manager, producerId),
		atCapacity: manager => manager.atCapacity,
		onJobSettled: (manager, listener) =>
			cleanups.track(
				threadId,
				manager.onJobSettled(() => ignoreSettle(listener())),
			),
		register: (manager, type, label, run, options) => {
			const wire = options?.feed;
			const feed = wire
				? new JobFeedMirror(wire, mirror => state.producerCurrent(manager, wire.producer, mirror))
				: undefined;
			const id = manager.register(
				type,
				label,
				ctx => {
					const wire: WireRunContext = {
						jobId: ctx.jobId,
						signal: toWireSignal(ctx.signal),
						reportProgress: ctx.reportProgress,
						markRunning: ctx.markRunning,
						pushFeed: feed ? delta => feed.apply(delta, true) : undefined,
					};
					return run(wire);
				},
				mainRegisterOptions(options, feed),
			);
			const job = manager.getJob(id);
			if (feed && job) state.bindProducer(manager, wire?.producer, feed, job);
			return id;
		},
		publishCompleted: (manager, type, label, result, options) =>
			manager.publishCompleted(type, label, result, options),
		cancel: (manager, id, filter) => manager.cancel(id, filter),
		getJob: (manager, id) => {
			const job = manager.getJob(id);
			return job ? toJobWire(job) : undefined;
		},
		getRunningJobs: (manager, filter) => toJobWires(manager.getRunningJobs(filter)),
		getRecentJobs: (manager, limit, filter) => toJobWires(manager.getRecentJobs(limit, filter)),
		getAllJobs: (manager, filter) => toJobWires(manager.getAllJobs(filter)),
		backgroundJob: (manager, jobId) => manager.backgroundJob(jobId),
		releaseForegroundJob: (manager, jobId) => manager.releaseForegroundJob(jobId),
		getDeliveryState: (manager, filter) => manager.getDeliveryState(filter),
		hasPendingDeliveries: (manager, filter) => manager.hasPendingDeliveries(filter),
		watchJobs: (manager, jobIds) => manager.watchJobs(jobIds),
		unwatchJobs: (manager, jobIds) => manager.unwatchJobs(jobIds),
		acknowledgeDeliveries: (manager, jobIds) => manager.acknowledgeDeliveries(jobIds),
		consumeJobResults: (manager, jobIds) => manager.consumeJobResults(jobIds),
		isJobResultConsumed: (manager, jobId) => manager.isJobResultConsumed(jobId),
		cancelAll: (manager, filter, reason) => manager.cancelAll(filter, fromWireReason(reason)),
		evictCompletedJobs: (manager, filter) => manager.evictCompletedJobs(filter),
		waitForAll: manager => manager.waitForAll(),
		registerDeliverySink: (manager, ownerId, sink) =>
			cleanups.track(
				threadId,
				manager.registerDeliverySink(ownerId, (jobId, text, job) =>
					sink(jobId, text, job ? toJobWire(job) : undefined),
				),
			),
		waitForOwnerJobs: (manager, ownerId, options) => manager.waitForOwnerJobs(ownerId, options),
		cancelAndReapOwnerJobs: (manager, ownerId, deadlineAt) => manager.cancelAndReapOwnerJobs(ownerId, deadlineAt),
		drainDeliveries: (manager, options) => manager.drainDeliveries(options),
		isDeliverySuppressed: (manager, jobId) => manager.isDeliverySuppressed(jobId),
		isDeliveryPending: (manager, jobId) => manager.isDeliveryPending(jobId),
		isDeliverySuperseded: (manager, jobId) => manager.isDeliverySuperseded(jobId),
		whenSettled: async (manager, jobId) => {
			await manager.getJob(jobId)?.promise;
		},
		signal: (manager, jobId) => {
			const job = manager.getJob(jobId);
			return job ? toWireSignal(job.abortController.signal) : undefined;
		},
		setRetainedArtifactsCleanup: (manager, jobId, cleanup) => {
			const job = manager.getJob(jobId);
			if (job) job.retainedArtifactsCleanup = cleanup;
		},
		widgetView: (manager, registryId, jobId) => {
			const widgets = state.widgets(manager, registryId);
			const job = manager.getJob(jobId);
			return job ? widgets.view(job) : undefined;
		},
		widgetCaption: (manager, registryId, jobId) => {
			const widgets = state.widgets(manager, registryId);
			const job = manager.getJob(jobId);
			return job ? widgets.caption(job) : undefined;
		},
		widgetRequestCaption: (manager, registryId, jobId) => {
			const widgets = state.widgets(manager, registryId);
			const job = manager.getJob(jobId);
			if (job) widgets.requestCaption(job);
		},
		widgetSubscribe: (manager, registryId, listener) =>
			cleanups.track(
				threadId,
				state.widgets(manager, registryId).subscribe(() => ignoreSettle(listener())),
			),
		widgetForget: (manager, registryId, jobId) => state.widgets(manager, registryId).forget(jobId),
		widgetInvalidate: (manager, registryId) => state.widgets(manager, registryId).invalidate(),
		widgetDrain: (manager, registryId) => state.widgets(manager, registryId).drain(),
	};
}

function installMain(peer: WorkerPeer): void {
	peer.link.exportClass<AsyncJobManager, AsyncJobManagerProtocol>(
		ASYNC_JOB_MANAGER_KIND,
		(value): value is AsyncJobManager => value instanceof AsyncJobManager,
		serveManager(peer.threadId),
	);
}

/**
 * Root `AsyncJobManager`s for subagent workers: main serves them by reference, workers use
 * {@link RemoteAsyncJobManager}. See the module doc.
 */
export const asyncJobsThreadService: ThreadService = {
	name: ASYNC_JOB_MANAGER_KIND,
	installMain,
	onWorkerExit: peer => cleanups.release(peer.threadId),
	installWorker(link) {
		link.importClass<RemoteAsyncJobManager, AsyncJobManagerProtocol>(
			ASYNC_JOB_MANAGER_KIND,
			remote => new RemoteAsyncJobManager(remote),
		);
	},
};
