import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AgentTelemetry, instrumentedCompleteSimple } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import {
	getAgentDir,
	getSkillDescriptionsDbPath,
	isBunTestRuntime,
	isEexist,
	logger,
	postmortem,
	prompt,
} from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { normalizeModelPatternList, resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { CostCapError } from "../session/cost-gate";
import type { ToolSession } from "../tools";
import compressDescriptionPrompt from "../prompts/skills/compress-description.md" with { type: "text" };
import { Semaphore } from "../task/parallel";
import type { Skill } from "./skills";

const MAX_PREVIEW_CHARS = 100;
// A sentence or word cut shorter than this discards too much; cut at the budget instead.
const MIN_PREVIEW_CUT = 40;
const MAX_COMPRESSED_CHARS = 160;
// Revision of validCompression's rules, part of every unusable-answer marker: bump it whenever the
// rules accept more, so answers an older, stricter revision rejected are asked for again.
const VALIDATION_REVISION = 2;
// Leave ample room for other cleanup under postmortem's 10-second deadline.
const STORE_CLOSE_GRACE_MS = 4_000;
const inFlight = new Map<string, Promise<void>>();
const compressionSlots = new Semaphore(4);

/** Background compression through a fast model; the model key scopes cached unusable answers. */
export interface SkillDescriptionCompressor {
	/** `provider/id` of the model the next request would use; `undefined` when none is available. */
	modelKey(): string | undefined;
	/** @throws on transport failures, missing models or credentials, and non-`stop` completions. */
	compress(name: string, description: string, request: string, isCurrent?: () => boolean): Promise<string>;
}

/** A completed request exhausted its output budget, rather than failing in transit. */
class SkillDescriptionLengthError extends Error {}

class SkillDescriptionUsageError extends Error {}

/**
 * Compress through an explicitly configured, trusted fast role.
 * Each request retains its initiating session, account authority, cost gate, and usage journal.
 */
export function createSkillDescriptionCompressor(
	registry: ModelRegistry,
	settings: Settings,
	options: {
		session: ToolSession;
		getTelemetry?: () => AgentTelemetry | undefined;
	},
): SkillDescriptionCompressor {
	const { session } = options;
	const select = (): Model<Api> | undefined => {
		const authority = settings.grantAuthority();
		for (const role of ["smol", "tiny"]) {
			const configured = authority.getModelRole(role)?.trim();
			if (!configured || settings.getModelRole(role)?.trim() !== configured) continue;
			const selection = resolveModelOverride(normalizeModelPatternList(configured), registry, settings, {
				exactOnly: true,
			});
			if (selection.model) return selection.model;
		}
		return undefined;
	};
	return {
		modelKey() {
			const model = select();
			return model ? `${model.provider}/${model.id}` : undefined;
		},
		async compress(_name, _description, request, catalogCurrent) {
			if (session.settings !== settings || session.modelRegistry !== registry) {
				throw new Error("Skill description compression session authority does not match");
			}
			const model = select();
			if (!model) throw new Error("No trusted configured smol or tiny model is available");
			const requestOwner = session.captureRequestOwner?.(model);
			const prepare = session.prepareSimpleStreamOptions;
			const journal = session.sessionManager;
			const journalSessionId = journal?.getSessionId?.();
			if (!requestOwner || !prepare || !journalSessionId || !journal?.appendModelUsage) {
				throw new Error("Skill description compression requires an admitted session owner");
			}
			const usageOwner = { sessionId: journalSessionId, parentId: journal.getLeafId?.() ?? null };
			const sessionId = session.getCredentialSourceSessionId?.() ?? session.getSessionId?.() ?? journalSessionId;
			const gate = session.costGate;
			const telemetry = options.getTelemetry?.();
			const refused = new AbortController();
			const requestSignal = AbortSignal.any([AbortSignal.timeout(30_000), refused.signal]);
			const prepared = prepare.call(session, { signal: requestSignal }, model.provider);
			const signal =
				prepared.signal && prepared.signal !== requestSignal
					? AbortSignal.any([requestSignal, prepared.signal])
					: requestSignal;
			const isCurrent = (): boolean => {
				const selected = select();
				return (
					catalogCurrent?.() !== false &&
					session.isDisposed?.() !== true &&
					session.costGate === gate &&
					requestOwner.isCurrent() &&
					selected?.provider === model.provider &&
					selected.id === model.id &&
					selected.api === model.api &&
					selected.baseUrl === model.baseUrl
				);
			};
			const admit = (): void => {
				signal.throwIfAborted();
				if (!isCurrent()) throw new Error("Skill description compression owner changed");
				const refusal = gate?.check();
				if (refusal) {
					const error = new CostCapError(refusal);
					refused.abort(error);
					throw error;
				}
				gate?.admit();
			};
			admit();
			const supplied = session.getApiKey ? await session.getApiKey(model) : registry.resolver(model, sessionId);
			if (supplied === undefined) throw new Error("Skill description compression credential is unavailable");
			let usageRecorded = false;
			let response: AssistantMessage;
			try {
				response = await instrumentedCompleteSimple(
					model,
					{ messages: [{ role: "user", content: request, timestamp: Date.now() }] },
					{
						...prepared,
						apiKey: async request => {
							admit();
							const credential = typeof supplied === "function" ? await supplied(request) : supplied;
							const credentialId = typeof credential === "object" ? credential?.credentialId : undefined;
							if (!requestOwner.bindCredential(credentialId)) {
								throw new Error("Skill description compression credential changed");
							}
							admit();
							return credential;
						},
						sessionId,
						maxTokens: 1024,
						disableReasoning: true,
						temperature: 0,
						signal,
						waitForTerminalDrain: true,
						beforeDispatch: () => {
							admit();
							prepared.beforeDispatch?.();
							admit();
						},
						fetch: transportFetch(model, prepared.fetch, admit),
						onPayload: async (payload, actualModel, requestSignal) => {
							admit();
							const replacement = await prepared.onPayload?.(payload, actualModel, requestSignal);
							admit();
							return replacement ?? payload;
						},
						onAttempt: message => {
							usageRecorded = true;
							try {
								gate?.record(message.usage.cost.total);
								const entry = journal.appendModelUsage!(
									{
										purpose: "skill-description",
										api: message.api,
										provider: message.provider,
										model: message.model,
										usage: message.usage,
										stopReason: message.stopReason,
									},
									usageOwner,
								);
								if (entry === undefined) throw new Error("The initiating usage journal is unavailable");
							} catch (cause) {
								throw new SkillDescriptionUsageError("Skill description usage persistence failed", { cause });
							}
						},
					},
					{ telemetry, oneshotKind: "skill_description" },
				);
			} catch (error) {
				if (error instanceof SkillDescriptionUsageError) throw error;
				if (refused.signal.aborted) throw refused.signal.reason;
				throw error;
			} finally {
				if (usageRecorded) {
					try {
						await journal.flush();
					} catch (cause) {
						throw new SkillDescriptionUsageError("Skill description usage persistence failed", { cause });
					}
				}
			}
			if (response.stopReason === "length") throw new SkillDescriptionLengthError("Model stopped: length");
			if (response.stopReason !== "stop") {
				throw new Error(`Model stopped: ${response.stopReason} ${response.errorMessage ?? ""}`);
			}
			return response.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("");
		},
	};
}

function keyFor(skill: Pick<Skill, "name" | "description">): string {
	return new Bun.CryptoHasher("sha256")
		.update(compressDescriptionPrompt)
		.update("\0")
		.update(skill.name)
		.update("\0")
		.update(skill.description)
		.digest("hex");
}

/** A deterministic, bounded routing hint while model compression is pending. */
export function previewSkillDescription(description: string): string {
	const text = description.replace(/\s+/g, " ").trim();
	if (text.length <= MAX_PREVIEW_CHARS) return text;
	const boundary = text.slice(0, MAX_PREVIEW_CHARS - 1);
	const sentence = boundary.match(/^.*?[.!?](?=\s|$)/)?.[0];
	if (sentence && sentence.length >= MIN_PREVIEW_CUT) return sentence;
	// Space-free scripts (CJK) may hold only an early space before a Latin term.
	const space = boundary.lastIndexOf(" ");
	const cut = space >= MIN_PREVIEW_CUT ? boundary.slice(0, space).trimEnd() : boundary;
	return `${cut}…`;
}

/**
 * The prompt's 12-word target stays advisory: small models routinely overshoot it by a few words
 * while staying well inside the character budget, which is what bounds the prompt.
 */
function validCompression(text: string): string | null {
	const line = text.trim();
	if (!line || /[\r\n]/.test(line) || line.length > MAX_COMPRESSED_CHARS) return null;
	return line;
}

/** Store key recording that `model`'s answer for the skill at `key` failed this validation revision. */
function unusableKey(key: string, model: string): string {
	return `${key}:v${VALIDATION_REVISION}:${model}`;
}

function pendingForStore(store: SkillDescriptionStore): Promise<void>[] {
	const prefix = `${store.path}:`;
	return [...inFlight].filter(([key]) => key.startsWith(prefix)).map(([, pending]) => pending);
}

let shared: SkillDescriptionStore | null | undefined;

/**
 * Process-wide store at {@link getSkillDescriptionsDbPath}, opened on first use
 * and closed at exit. Opening per render and per compression write created and
 * deleted the `-wal`/`-shm` sidecars and re-ran PRAGMA/CREATE/chmod every time.
 * `undefined` when it cannot be opened (logged once; prompts keep the bounded
 * previews) and under the test runner, so tests never read or write the user's
 * cache; tests open {@link SkillDescriptionStore.open} explicitly.
 */
export function sharedSkillDescriptionStore(): SkillDescriptionStore | undefined {
	if (isBunTestRuntime()) return undefined;
	if (shared === undefined) {
		try {
			const store = SkillDescriptionStore.open();
			postmortem.register("skill-descriptions-db", () => store.close(), { exitOnly: true });
			shared = store;
		} catch (error) {
			logger.warn("Skill description cache unavailable", { error: String(error) });
			shared = null;
		}
	}
	return shared ?? undefined;
}

/**
 * Store under an SDK session's own `agentDir` when it differs from the process
 * agent dir; the caller closes it with the session. `undefined` under the test
 * runner (same isolation as {@link sharedSkillDescriptionStore}) or when it
 * cannot be opened (logged; the catalog then uses the shared store).
 */
export function openSessionSkillDescriptionStore(agentDir: string): SkillDescriptionStore | undefined {
	if (isBunTestRuntime()) return undefined;
	try {
		return SkillDescriptionStore.open(resolveSkillDescriptionsDbPath(agentDir));
	} catch (error) {
		logger.warn("Skill description cache unavailable", { agentDir, error: String(error) });
		return undefined;
	}
}

/**
 * Skill-description database for `agentDir` (default: the process agent dir).
 * When XDG relocates it away from `<agentDir>/skill-descriptions.db`, a legacy
 * database is adopted once so enabling XDG does not discard every cached
 * compression and re-bill the model for it.
 */
function resolveSkillDescriptionsDbPath(agentDir?: string): string {
	const dbPath = getSkillDescriptionsDbPath(agentDir);
	adoptLegacyDatabase(path.join(agentDir ?? getAgentDir(), "skill-descriptions.db"), dbPath);
	return dbPath;
}

/**
 * Best-effort one-time copy of a legacy SQLite database. `VACUUM INTO` takes a
 * consistent snapshot including uncheckpointed WAL frames, which a plain file
 * copy would drop; hard-linking the staged file into place publishes it
 * atomically and never clobbers a database another process adopted or created
 * first. Where hard links are unsupported (some FUSE, exFAT, or network
 * mounts) an exclusive copy keeps the no-clobber guarantee. The legacy file
 * stays for older omp versions sharing the profile.
 */
function adoptLegacyDatabase(legacyPath: string, dbPath: string): void {
	if (legacyPath === dbPath || fs.existsSync(dbPath) || !fs.existsSync(legacyPath)) return;
	const staging = `${dbPath}.adopt-${process.pid}`;
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		fs.rmSync(staging, { force: true });
		const legacy = new Database(legacyPath, { readonly: true });
		try {
			legacy.run("VACUUM INTO ?", [staging]);
		} finally {
			legacy.close();
		}
		try {
			fs.linkSync(staging, dbPath);
		} catch (error) {
			if (isEexist(error)) return;
			fs.copyFileSync(staging, dbPath, fs.constants.COPYFILE_EXCL);
		}
	} catch (error) {
		logger.debug("Skill description cache not adopted", { legacyPath, dbPath, error: String(error) });
	} finally {
		fs.rmSync(staging, { force: true });
	}
}

/**
 * SQLite store of compressed descriptions, keyed by prompt + skill content hash. A
 * `<key>:v<revision>:<provider/id>` row records that model's unusable answer, so it is not asked
 * again while new models and validation revisions still are.
 */
export class SkillDescriptionStore {
	/** Database file; scopes in-flight compression jobs shared by catalogs on this store. */
	readonly path: string;
	readonly #db: Database;
	readonly #select: Statement<{ description: string }, [string]>;
	readonly #upsert: Statement<unknown, [string, string]>;
	#closeCall?: Promise<void>;
	#closed = false;

	private constructor(dbPath: string, db: Database) {
		this.path = dbPath;
		this.#db = db;
		this.#select = db.prepare("SELECT description FROM skill_descriptions WHERE key = ?");
		this.#upsert = db.prepare("INSERT OR REPLACE INTO skill_descriptions (key, description) VALUES (?, ?)");
	}

	/**
	 * Open (creating if needed) the store at `dbPath`.
	 * @throws when the directory or database cannot be created.
	 */
	static open(dbPath: string = resolveSkillDescriptionsDbPath()): SkillDescriptionStore {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		const db = new Database(dbPath, { create: true });
		try {
			// Install before any lock-taking statement (SQLite cache contention, #2421).
			db.run("PRAGMA busy_timeout = 100");
			db.run("PRAGMA journal_mode=WAL");
			db.run("PRAGMA synchronous=NORMAL");
			db.run("CREATE TABLE IF NOT EXISTS skill_descriptions (key TEXT PRIMARY KEY, description TEXT NOT NULL)");
			if (process.platform !== "win32") fs.chmodSync(dbPath, 0o600);
			return new SkillDescriptionStore(dbPath, db);
		} catch (error) {
			db.close();
			throw error;
		}
	}

	/** @throws on SQLite errors. */
	get(key: string): string | undefined {
		return this.#select.get(key)?.description;
	}

	/** @throws on SQLite errors. */
	put(key: string, description: string): void {
		this.#upsert.run(key, description);
	}

	/** Whether closing has begun and no new compression work is admitted. */
	get isClosing(): boolean {
		return this.#closeCall !== undefined;
	}

	/** Whether the database is closed and late replies are discarded; false while draining. */
	get isClosed(): boolean {
		return this.#closed;
	}

	/** Stop admitting requests and give already-running compressions a bounded chance to persist. */
	close(): Promise<void> {
		if (!this.#closeCall) {
			const pending = pendingForStore(this);
			if (pending.length === 0) {
				this.#closeDatabase();
				this.#closeCall = Promise.resolve();
			} else {
				this.#closeCall = this.#closeAfterPending(pending);
			}
		}
		return this.#closeCall;
	}

	async #closeAfterPending(pending: Promise<void>[]): Promise<void> {
		const deadline = Promise.withResolvers<void>();
		const timer = setTimeout(deadline.resolve, STORE_CLOSE_GRACE_MS);
		try {
			await Promise.race([Promise.all(pending), deadline.promise]);
		} finally {
			clearTimeout(timer);
			this.#closeDatabase();
		}
	}

	#closeDatabase(): void {
		this.#closed = true;
		// Unfinalized statements keep the file handle open on Windows.
		this.#select.finalize();
		this.#upsert.finalize();
		this.#db.close();
	}

	/** Start bounded closure on disposal; await close() to wait for pending writes. */
	[Symbol.dispose](): void {
		void this.close();
	}
}

/** One prompt/session snapshot; completing a background job never mutates its rendered descriptions. */
export class SkillDescriptionCatalog {
	readonly #store: SkillDescriptionStore | undefined;
	readonly #compress?: SkillDescriptionCompressor;
	readonly #snapshot = new Map<string, string>();
	/** Misses rendered before {@link startCompression}; `undefined` once compression runs. */
	#deferred: Map<string, Skill> | undefined;
	readonly #pending = new Set<Promise<void>>();
	#generation = 0;
	#drain: Promise<void> | undefined;
	#usageFailure: unknown;

	/**
	 * `store` defaults to {@link sharedSkillDescriptionStore}; without one, prompts keep previews.
	 * `deferCompression` holds model work until {@link startCompression}: until the owning session's
	 * cost gate exists, and off a startup path (resolving the compression model composes the catalog).
	 */
	constructor(
		options: {
			store?: SkillDescriptionStore;
			compress?: SkillDescriptionCompressor;
			deferCompression?: boolean;
		} = {},
	) {
		this.#store = options.store ?? sharedSkillDescriptionStore();
		this.#compress = options.compress;
		if (options.deferCompression) this.#deferred = new Map();
	}

	/** Read the session's frozen prompt hints without starting new model work. */
	snapshot(skills: readonly Skill[]): Array<Skill & { description: string }> {
		return skills.map(skill => ({
			...skill,
			description: this.#snapshot.get(keyFor(skill)) ?? previewSkillDescription(skill.description),
		}));
	}

	render(skills: readonly Skill[]): Array<Skill & { description: string }> {
		if (skills.length === 0) return [];
		const store = this.#store;
		const misses = new Map<string, Skill>();
		const rendered = skills.map(skill => {
			const key = keyFor(skill);
			let description = this.#snapshot.get(key);
			if (description === undefined) {
				try {
					description = store?.get(key);
				} catch (error) {
					logger.warn("Skill description cache read failed", { error: String(error) });
				}
				if (description === undefined) {
					description = previewSkillDescription(skill.description);
					misses.set(key, skill);
				}
				this.#snapshot.set(key, description);
			}
			return { ...skill, description };
		});
		if (!store || misses.size === 0) return rendered;
		if (this.#deferred) {
			for (const [key, skill] of misses) this.#deferred.set(key, skill);
		} else {
			this.#schedule(store, misses);
		}
		return rendered;
	}

	/** Start compression held by `deferCompression`; later renders schedule theirs immediately. */
	startCompression(): void {
		const deferred = this.#deferred;
		this.#deferred = undefined;
		if (deferred && deferred.size > 0 && this.#store) this.#schedule(this.#store, deferred);
	}

	/** Await this catalog's accepted operations, including their captured usage persistence. */
	async waitForPending(): Promise<void> {
		while (this.#pending.size > 0) await Promise.all(this.#pending);
		if (this.#usageFailure !== undefined) throw this.#usageFailure;
	}

	/** Invalidate queued attempts and drain accepted work before its session changes or closes. */
	drain(): Promise<void> {
		if (this.#drain) return this.#drain;
		this.#generation++;
		this.#deferred?.clear();
		this.#snapshot.clear();
		this.#drain = this.waitForPending().finally(() => {
			this.#drain = undefined;
		});
		return this.#drain;
	}

	#schedule(store: SkillDescriptionStore, misses: ReadonlyMap<string, Skill>): void {
		const compressor = this.#compress;
		if (!compressor || store.isClosing || this.#drain || this.#usageFailure !== undefined) return;
		// One resolution serves the whole batch: each composes the available model catalog, and a
		// miss that model already answered unusably needs nothing more. Deferred until the current
		// synchronous prompt rendering has finished.
		let batchModel: Promise<string | undefined> | undefined;
		const generation = this.#generation;
		const isCurrent = () => generation === this.#generation;
		for (const [key, skill] of misses) {
			const job = `${store.path}:${key}`;
			if (inFlight.has(job)) continue;
			batchModel ??= Promise.resolve().then(() => compressor.modelKey());
			const pending = compressSkill(store, compressor, batchModel, key, skill, isCurrent)
				.catch(error => {
					this.#usageFailure ??= error;
				})
				.finally(() => {
					inFlight.delete(job);
					this.#pending.delete(pending);
				});
			this.#pending.add(pending);
			inFlight.set(job, pending);
		}
	}
}

/**
 * Compress one skill's description into `store`. `batchModel` filters out skills that model
 * already answered unusably (and everything when no model is available) before taking a slot.
 */
async function compressSkill(
	store: SkillDescriptionStore,
	compressor: SkillDescriptionCompressor,
	batchModel: Promise<string | undefined>,
	key: string,
	skill: Skill,
	isCurrent: () => boolean,
): Promise<void> {
	try {
		const candidate = await batchModel;
		if (
			!isCurrent() ||
			candidate === undefined ||
			store.isClosing ||
			store.get(unusableKey(key, candidate)) !== undefined
		)
			return;
		await compressionSlots.acquire();
		try {
			if (!isCurrent() || store.isClosing) return;
			// Unusable answers are remembered per model: that model is not asked again, a newly selected one is.
			// Re-resolved because the role can change while this job waits behind running requests.
			const model = compressor.modelKey();
			const unusable = model === undefined ? undefined : unusableKey(key, model);
			if (unusable !== undefined && store.get(unusable) !== undefined) return;
			const request = prompt.render(compressDescriptionPrompt, {
				name: skill.name,
				description: skill.description,
			});
			let result: string | null = null;
			try {
				result = validCompression(await compressor.compress(skill.name, skill.description, request, isCurrent));
			} catch (error) {
				if (!(error instanceof SkillDescriptionLengthError)) throw error;
			}
			if (!isCurrent() || store.isClosed) return;
			if (result !== null) {
				store.put(key, result);
			} else if (unusable !== undefined) {
				logger.warn("Skill description compression unusable; keeping the preview for this model", {
					skill: skill.name,
					model,
				});
				store.put(unusable, previewSkillDescription(skill.description));
			}
		} finally {
			compressionSlots.release();
		}
	} catch (error) {
		if (error instanceof SkillDescriptionUsageError) throw error;
		logger.warn("Skill description compression failed", { skill: skill.name, error: String(error) });
	}
}
