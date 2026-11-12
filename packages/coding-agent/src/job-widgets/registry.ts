/**
 * The widgets of one root session's jobs: derives each shown job's view from
 * its live output, asks the cheap model for a spec once the job has output
 * worth describing (and for a caption of a command that needs explaining),
 * and pushes refreshed views to subscribers while jobs run.
 */
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../async/job-manager";
import type { JobWidgetAuthor, JobWidgetAuthorRequest } from "./author";
import { type JobCaptionWriter, needsJobCaption, normalizeJobCaption } from "./caption";
import { JobWidgetRuntime, sampleLines } from "./runtime";
import { type JobWidgetSpec, jobWidgetSkip, validateJobWidgetSpec } from "./spec";
import type { JobWidgetBrief, JobWidgetInputs, JobWidgetRegistry } from "./types";

/** Tunables; the defaults are the product behavior, tests shrink the clocks. */
export interface JobWidgetsOptions {
	/** Writes specs; absent = fallback views only. */
	author?: JobWidgetAuthor;
	/** Writes command captions; absent = no captions. */
	captioner?: JobCaptionWriter;
	/** Whether widgets and captions are on (`async.widgets`); read on every call. */
	enabled?: () => boolean;
	/** Remote-author eligibility, independent of local derivation and the author's managed admission. */
	authorEnabled?: () => boolean;
	now?: () => number;
	/** Background refresh period while subscribers watch running widgets. */
	refreshMs?: number;
	/** Minimum time between two reads of one job's sources. */
	minIngestMs?: number;
	/** Job age before a spec or a caption may be requested. */
	authorAfterMs?: number;
	/** Spec and caption requests in flight at once, across jobs. */
	maxInFlight?: number;
	/** Spec requests (each with its one retry) per job. */
	maxAttempts?: number;
	/** Unmatched lines on the rules' sources that suggest the spec stopped fitting. */
	driftLines?: number;
	/** Age of the newest matched data past which drift re-authors. */
	driftStaleMs?: number;
}

const DEFAULTS = {
	refreshMs: 1000,
	minIngestMs: 250,
	authorAfterMs: 15_000,
	maxInFlight: 2,
	maxAttempts: 3,
	driftLines: 200,
	driftStaleMs: 90_000,
} as const;

/** Lines a source needs before its output is worth a spec. */
const MIN_AUTHOR_LINES = 3;
const MAX_ENTRIES = 256;
const MAX_PENDING_REQUESTS = 16;

interface WidgetEntry {
	job: AsyncJob;
	inputs: JobWidgetInputs;
	runtime: JobWidgetRuntime;
	view: JobWidgetView;
	/** `JSON.stringify(view)`, to tell a changed view from a recomputed identical one. */
	viewKey: string;
	lastIngestAt: number;
	shown: boolean;
	/** Settled and flushed: the view never changes again. */
	frozen: boolean;
	attempts: number;
	/** No model can write specs: stop asking. */
	authorUnavailable: boolean;
	request?: AbortController;
	captionRequest?: AbortController;
	/** Whether the installed spec was written knowing the task's `watch` hint. */
	specHadWatch: boolean;
	/**
	 * Set once the author declined (`skip`): the task's `watch` hint at the
	 * time, `""` without one. A command's job is never asked again; a task's
	 * is asked again once its subagent names something else to watch.
	 */
	skippedWatch?: string;
	/** A spec dropped for no longer fitting the output, sent back as rejected with the next request. */
	misfit?: { answer: string; errors: string[] };
	/** Set once the caption was decided: requested, or found unneeded. */
	captionAsked?: boolean;
	caption?: string;
}

/** {@link JobWidgetRegistry} for one root `AsyncJobManager`. */
export class JobWidgets implements JobWidgetRegistry {
	readonly #entries = new Map<string, WidgetEntry>();
	/** Cancels in-flight caption requests on dispose. */
	readonly #disposal = new AbortController();
	readonly #listeners = new Set<() => void>();
	readonly #author: JobWidgetAuthor | undefined;
	readonly #captioner: JobCaptionWriter | undefined;
	readonly #enabled: () => boolean;
	readonly #authorEnabled: () => boolean;
	readonly #now: () => number;
	readonly #options: Required<Omit<JobWidgetsOptions, "author" | "captioner" | "enabled" | "authorEnabled" | "now">>;
	readonly #requests = new Set<AbortController>();
	readonly #pending = new Set<Promise<void>>();
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(options: JobWidgetsOptions = {}) {
		this.#author = options.author;
		this.#captioner = options.captioner;
		this.#enabled = options.enabled ?? (() => true);
		this.#authorEnabled = options.authorEnabled ?? (() => true);
		this.#now = options.now ?? Date.now;
		this.#options = {
			refreshMs: options.refreshMs ?? DEFAULTS.refreshMs,
			minIngestMs: options.minIngestMs ?? DEFAULTS.minIngestMs,
			authorAfterMs: options.authorAfterMs ?? DEFAULTS.authorAfterMs,
			maxInFlight: options.maxInFlight ?? DEFAULTS.maxInFlight,
			maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
			driftLines: options.driftLines ?? DEFAULTS.driftLines,
			driftStaleMs: options.driftStaleMs ?? DEFAULTS.driftStaleMs,
		};
	}

	view(job: AsyncJob): JobWidgetView | undefined {
		if (!this.#active() || !job.widgetInputs) return undefined;
		const entry = this.#entry(job);
		entry.shown = true;
		this.#refresh(entry, false);
		this.#syncTimer();
		return entry.view;
	}

	requestCaption(job: AsyncJob): void {
		if (!this.#active() || !job.widgetInputs || job.status !== "running") return;
		let brief: JobWidgetBrief;
		try {
			brief = job.widgetInputs.brief();
		} catch (error) {
			logger.warn("Job caption brief failed", { jobId: job.id, error: String(error) });
			return;
		}
		this.#maybeCaption(this.#entry(job), brief, this.#now());
	}

	/** The job's entry, made fresh for a job not seen before or a new job reusing its id. */
	#entry(job: AsyncJob): WidgetEntry {
		const existing = this.#entries.get(job.id);
		if (existing?.job === job && existing.inputs === job.widgetInputs) {
			this.#entries.delete(job.id);
			this.#entries.set(job.id, existing);
			return existing;
		}
		if (existing) this.#retire(existing);
		if (this.#entries.size >= MAX_ENTRIES) {
			const oldest = this.#entries.keys().next().value;
			if (oldest !== undefined) this.forget(oldest);
		}
		const runtime = new JobWidgetRuntime(undefined, job.startTime, this.#now);
		const entry: WidgetEntry = {
			job,
			inputs: job.widgetInputs!,
			runtime,
			view: runtime.view({ label: job.intent ?? job.label, authoring: false }),
			viewKey: "",
			lastIngestAt: Number.NEGATIVE_INFINITY,
			shown: false,
			frozen: false,
			attempts: 0,
			authorUnavailable: false,
			specHadWatch: false,
		};
		this.#entries.set(job.id, entry);
		return entry;
	}

	caption(job: AsyncJob): string | undefined {
		const entry = this.#entries.get(job.id);
		return entry?.job === job && entry.inputs === job.widgetInputs && this.#active() ? entry.caption : undefined;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		this.#syncTimer();
		return () => {
			this.#listeners.delete(listener);
			this.#syncTimer();
		};
	}

	forget(jobId: string): void {
		const entry = this.#entries.get(jobId);
		if (!entry) return;
		this.#retire(entry);
		this.#entries.delete(jobId);
		this.#syncTimer();
	}

	invalidate(): void {
		const changed = this.#entries.size > 0;
		for (const entry of this.#entries.values()) this.#retire(entry);
		this.#entries.clear();
		this.#syncTimer();
		if (changed) this.#notify();
	}

	async drain(): Promise<void> {
		while (this.#pending.size > 0) await Promise.allSettled(this.#pending);
	}

	dispose(): void {
		this.#disposed = true;
		for (const entry of this.#entries.values()) this.#retire(entry);
		this.#disposal.abort();
		this.#entries.clear();
		this.#listeners.clear();
		this.#syncTimer();
	}

	#retire(entry: WidgetEntry): void {
		for (const request of [entry.request, entry.captionRequest]) {
			if (!request) continue;
			this.#requests.delete(request);
			request.abort();
		}
		entry.request = undefined;
		entry.captionRequest = undefined;
	}

	#active(): boolean {
		if (this.#disposed) return false;
		if (this.#enabled()) {
			if (!this.#authorEnabled() && this.#requests.size > 0) {
				for (const entry of this.#entries.values()) this.#retire(entry);
			}
			return true;
		}
		this.invalidate();
		return false;
	}

	#authorCurrent(entry: WidgetEntry): boolean {
		return (
			this.#authorEnabled() &&
			this.#entries.get(entry.job.id) === entry &&
			entry.job.widgetInputs === entry.inputs &&
			!entry.inputs.authorSignal?.aborted &&
			entry.inputs.canAuthor?.() === true &&
			entry.job.status === "running"
		);
	}

	/**
	 * Read new output and recompute the view, at most every `minIngestMs`
	 * unless `force`; a settled job gets one final flushing read and freezes.
	 * Returns whether the view changed.
	 */
	#refresh(entry: WidgetEntry, force: boolean): boolean {
		if (!this.#active() || this.#entries.get(entry.job.id) !== entry) return false;
		if (entry.job.widgetInputs !== entry.inputs) {
			this.#retire(entry);
			this.#entries.delete(entry.job.id);
			return false;
		}
		if ((entry.request || entry.captionRequest) && entry.inputs.canAuthor?.() !== true) this.#retire(entry);
		if (entry.frozen) return false;
		const now = this.#now();
		const settled = entry.job.status !== "running";
		if (!settled && !force && now - entry.lastIngestAt < this.#options.minIngestMs) return false;
		entry.lastIngestAt = now;
		const inputs = entry.inputs;
		let brief: JobWidgetBrief;
		try {
			if (entry.runtime.ingest(inputs.sources(), settled)) this.#dropMisfit(entry);
			brief = inputs.brief();
		} catch (error) {
			logger.warn("Job widget refresh failed", { jobId: entry.job.id, error: String(error) });
			return false;
		}
		if (settled) {
			entry.frozen = true;
			this.#retire(entry);
		} else {
			this.#maybeAuthor(entry, brief, now);
			this.#maybeCaption(entry, brief, now);
		}
		return this.#recompute(entry, brief);
	}

	#recompute(entry: WidgetEntry, brief: JobWidgetBrief): boolean {
		const view = entry.runtime.view({
			label: entry.job.intent ?? entry.job.label,
			stage: brief.stage,
			// A subagent's tool results are file contents and search hits; only a command's newest line says what it does.
			lineStage: brief.kind === "bash",
			authoring: entry.request !== undefined,
		});
		const key = JSON.stringify(view);
		if (key === entry.viewKey) return false;
		entry.view = view;
		entry.viewKey = key;
		return true;
	}

	/**
	 * Start a spec request when the job is old and talkative enough, or
	 * re-author a spec that stopped fitting. A subagent's job waits for its
	 * `watch` hint: most subagents read and edit code, and only the subagent
	 * knows whether some output of its work shows progress.
	 */
	#maybeAuthor(entry: WidgetEntry, brief: JobWidgetBrief, now: number): void {
		if (!this.#author || !this.#authorCurrent(entry) || entry.request || entry.authorUnavailable || !entry.shown)
			return;
		if (entry.attempts >= this.#options.maxAttempts || this.#requests.size >= this.#options.maxInFlight) return;
		if (this.#pending.size >= MAX_PENDING_REQUESTS) return;
		if (now - entry.job.startTime < this.#options.authorAfterMs) return;
		if (brief.kind === "task" && !brief.watch) return;
		const skipped = entry.skippedWatch;
		if (skipped !== undefined && (brief.kind !== "task" || skipped === brief.watch)) return;
		const runtime = entry.runtime;
		let previous: JobWidgetAuthorRequest["previous"];
		if (runtime.spec) {
			const reason = this.#reauthorReason(entry, brief, now);
			if (!reason) return;
			previous = { spec: runtime.spec, reason };
		} else if (brief.kind === "bash" && !runtime.samples().some(sample => sample.lines >= MIN_AUTHOR_LINES)) {
			return;
		}
		const pending = this.#writeSpec(entry, { ...brief }, previous);
		this.#pending.add(pending);
		void pending.then(
			() => this.#pending.delete(pending),
			error => {
				this.#pending.delete(pending);
				logger.warn("Job widget derivation failed", { jobId: entry.job.id, error: String(error) });
			},
		);
	}

	/** Ask once for the caption of a shown command that needs explaining, once the job is old enough. */
	#maybeCaption(entry: WidgetEntry, brief: JobWidgetBrief, now: number): void {
		const command = brief.command;
		if (entry.captionAsked || !this.#captioner || brief.kind !== "bash" || !command || !this.#authorCurrent(entry))
			return;
		if (
			now - entry.job.startTime < this.#options.authorAfterMs ||
			this.#requests.size >= this.#options.maxInFlight ||
			this.#pending.size >= MAX_PENDING_REQUESTS
		)
			return;
		entry.captionAsked = true;
		if (!needsJobCaption(command)) return;
		const pending = this.#writeCaption(entry, { ...brief, command });
		this.#pending.add(pending);
		void pending.finally(() => this.#pending.delete(pending));
	}

	async #writeCaption(entry: WidgetEntry, brief: JobWidgetBrief & { command: string }): Promise<void> {
		const controller = new AbortController();
		entry.captionRequest = controller;
		this.#requests.add(controller);
		const signal = entry.inputs.authorSignal
			? AbortSignal.any([controller.signal, this.#disposal.signal, entry.inputs.authorSignal])
			: AbortSignal.any([controller.signal, this.#disposal.signal]);
		try {
			const reply = await this.#captioner?.(
				{ ...brief, jobId: entry.job.id, canAuthor: () => this.#authorCurrent(entry) },
				signal,
			);
			if (!this.#active() || !this.#authorCurrent(entry) || signal.aborted) return;
			entry.caption = normalizeJobCaption(reply ?? "");
			if (entry.caption) this.#notify();
		} catch (error) {
			if (!signal.aborted) logger.debug("Job caption failed", { jobId: entry.job.id, error: String(error) });
		} finally {
			this.#requests.delete(controller);
			if (entry.captionRequest === controller) entry.captionRequest = undefined;
		}
	}

	#reauthorReason(entry: WidgetEntry, brief: JobWidgetBrief, now: number): string | undefined {
		if (brief.watch && !entry.specHadWatch) return `the subagent now says what to watch: ${brief.watch}`;
		const runtime = entry.runtime;
		if (runtime.unmatchedLines < this.#options.driftLines) return undefined;
		const newest = runtime.lastMatchAt;
		if (newest !== undefined && now - newest <= this.#options.driftStaleMs) return undefined;
		return `no rule matched the last ${runtime.unmatchedLines} lines`;
	}

	/** One spec request (plus one retry on a rejected answer); installs the spec when it validates. */
	async #writeSpec(
		entry: WidgetEntry,
		brief: JobWidgetBrief,
		previous: JobWidgetAuthorRequest["previous"],
	): Promise<void> {
		const author = this.#author;
		if (!author || !this.#active() || !this.#authorCurrent(entry)) return;
		const controller = new AbortController();
		const signal = entry.inputs.authorSignal
			? AbortSignal.any([controller.signal, entry.inputs.authorSignal])
			: controller.signal;
		entry.request = controller;
		entry.attempts += 1;
		this.#requests.add(controller);
		if (this.#recompute(entry, brief)) this.#notify();
		const samples = entry.runtime.samples();
		const request: JobWidgetAuthorRequest = {
			jobId: entry.job.id,
			brief,
			sources: samples,
			previous,
			canAuthor: () => this.#authorCurrent(entry),
			...(entry.misfit ? { rejected: entry.misfit } : {}),
		};
		entry.misfit = undefined;
		// Where a spec's constant totals and targets may come from, besides the samples.
		const stated = [brief.command, brief.task, brief.intent, brief.watch, brief.stage].filter(Boolean).join("\n");
		let installable: JobWidgetRuntime | undefined;
		try {
			for (let round = 0; round < 2 && !installable; round++) {
				if (!this.#active() || !this.#authorCurrent(entry) || signal.aborted) return;
				const answer = await author(request, signal);
				if (!this.#active() || !this.#authorCurrent(entry) || signal.aborted) return;
				if (answer === undefined) {
					entry.authorUnavailable = true;
					break;
				}
				const skip = jobWidgetSkip(answer);
				if (skip !== undefined) {
					logger.debug("Job widget declined", { jobId: entry.job.id, reason: skip });
					entry.skippedWatch = brief.watch ?? "";
					break;
				}
				const checked = validateJobWidgetSpec(answer, sampleLines(samples), stated);
				let errors: string[];
				if (checked.ok) {
					// The samples are a few lines; what else a loose rule matches shows only on the whole output.
					const candidate = this.#build(entry.job, checked.spec);
					errors = candidate.problems();
					if (errors.length === 0) installable = candidate;
				} else {
					errors = checked.errors;
				}
				if (errors.length > 0) {
					logger.debug("Job widget spec rejected", { jobId: entry.job.id, errors });
					request.rejected = { answer: JSON.stringify(answer), errors };
				}
			}
		} catch (error) {
			if (!signal.aborted) {
				logger.debug("Job widget spec request failed", { jobId: entry.job.id, error: String(error) });
			}
		} finally {
			this.#requests.delete(controller);
			if (entry.request === controller) entry.request = undefined;
		}
		if (!this.#active() || !this.#authorCurrent(entry) || signal.aborted || entry.frozen) return;
		if (installable) this.#install(entry, installable, brief);
		if (this.#recompute(entry, brief)) this.#notify();
		this.#syncTimer();
	}

	/** A runtime driven by `spec` (none: the fallback) that has read every source from its oldest retained text. */
	#build(job: AsyncJob, spec: JobWidgetSpec | undefined): JobWidgetRuntime {
		const runtime = new JobWidgetRuntime(spec, job.startTime, this.#now);
		const inputs = job.widgetInputs;
		try {
			if (inputs) runtime.ingest(inputs.sources(), job.status !== "running");
		} catch (error) {
			logger.warn("Job widget refresh failed", { jobId: job.id, error: String(error) });
		}
		return runtime;
	}

	/** Drive the widget by a runtime `#build` made and `problems()` cleared. */
	#install(entry: WidgetEntry, runtime: JobWidgetRuntime, brief: JobWidgetBrief): void {
		logger.debug("Job widget spec installed", { jobId: entry.job.id, spec: runtime.spec });
		entry.runtime = runtime;
		entry.specHadWatch = brief.watch !== undefined && brief.watch.length > 0;
		entry.lastIngestAt = this.#now();
	}

	/**
	 * Fall back from a spec that new output shows draws something other than
	 * progress (see `JobWidgetRuntime.problems`), so a misfit never reaches the
	 * screen; the next request sends it back with why.
	 */
	#dropMisfit(entry: WidgetEntry): void {
		const { spec } = entry.runtime;
		if (!spec) return;
		const errors = entry.runtime.problems();
		if (errors.length === 0) return;
		logger.debug("Job widget spec dropped", { jobId: entry.job.id, errors });
		entry.misfit = { answer: JSON.stringify(spec), errors };
		entry.runtime = this.#build(entry.job, undefined);
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				logger.warn("Job widget listener failed", { error: String(error) });
			}
		}
	}

	/** Shown widgets whose views can still change. */
	#hasLiveWidgets(): boolean {
		for (const entry of this.#entries.values()) if (entry.shown && !entry.frozen) return true;
		return false;
	}

	#syncTimer(): void {
		const wanted = !this.#disposed && this.#enabled() && this.#listeners.size > 0 && this.#hasLiveWidgets();
		if (wanted && !this.#timer) {
			this.#timer = setInterval(() => this.#tick(), this.#options.refreshMs);
			this.#timer.unref();
		} else if (!wanted && this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	#tick(): void {
		if (!this.#active()) return;
		let changed = false;
		for (const entry of this.#entries.values()) {
			if (!entry.shown || entry.frozen) continue;
			if (this.#refresh(entry, true)) changed = true;
		}
		if (changed) this.#notify();
		this.#syncTimer();
	}
}
