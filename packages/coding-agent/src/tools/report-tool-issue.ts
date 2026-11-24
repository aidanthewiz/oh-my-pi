/**
 * The `report_issue` command hands one observed tool failure to Coreforge's
 * interactive `/report` workflow. Each occurrence requires consent; filing
 * still requires approval of the resulting draft. No telemetry is submitted.
 */
import { type } from "@oh-my-pi/omptype";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { $env, $flag, getAutoQaDbPath, getInstallId, logger, VERSION } from "@oh-my-pi/pi-utils";
import type { Settings } from "..";
import type { Tool, ToolSession } from "./index";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolCommandCallName } from "./tool-commands";

import { REPORT_ISSUE_COMMAND_NAME } from "@oh-my-pi/pi-tui/tools/report-tool-issue";
import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";

import { cfgDevAutoqa, cfgDevAutoqaConsent, cfgDevAutoqaPushEndpoint, cfgDevAutoqaPushToken } from "./settings";

/** Accepted `report` shapes, appended to format errors. */
const REPORT_ISSUE_USAGE =
	"Expected `<tool>: <concise description>`, or the tool name on line 1 with the report body below.";

/** Whether a tool call runs `report_issue`, directly or as a `bash` command. */
export function isReportIssueToolCall(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean {
	return (toolCommandCallName(toolCall) ?? toolCall.name) === REPORT_ISSUE_COMMAND_NAME;
}

/**
 * Maximum `tool` length the collector accepts, in UTF-8 bytes. An oversized
 * entry makes the collector reject the *whole* batch with HTTP 400, so
 * grievances are clamped at record time and again at send time — rows recorded
 * before the clamp existed still sit in users' databases.
 */
const MAX_TOOL_BYTES = 128;

/**
 * Remove the user's identity from grievance text. Reports quote paths and
 * commands verbatim and leave the machine, so the home directory becomes `~`,
 * and the login name becomes `<user>` in the forms that name the user: a home
 * path the first rewrite missed (`/c/Users/<user>`, an encoded session dir
 * `-Users-<user>-`, `~<user>`), a reverse-DNS label (`com.<user>.app`) and
 * `<user>@host`. Elsewhere the name is left alone: logins such as `will`,
 * `node`, `bin` or `test` are also words and directory names. `root` names no
 * one, so only its home is rewritten.
 */
function redactUserIdentity(text: string): string {
	let redacted = text;
	const home = os.homedir();
	// Case-insensitive throughout: Windows and default macOS volumes name the
	// same home in any case (`c:\users\will`), and over-matching another
	// casing only hides more.
	if (home.length > 1) {
		for (const form of new Set([home, home.replaceAll("\\", "/")])) {
			const pattern = `(?<![\\p{L}\\p{N}_.-])${RegExp.escape(form)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`;
			redacted = redacted.replace(new RegExp(pattern, "giu"), "~");
		}
	}
	let user: string | undefined;
	try {
		user = os.userInfo().username;
	} catch {
		// No passwd entry for the uid (some containers): the home rewrite above still applies.
	}
	if (user && user !== "root") {
		const name = RegExp.escape(user);
		const pattern = new RegExp(
			`(?<=(?<![\\p{L}\\p{N}])(?:Users|home)[/\\\\-]|~|(?<![\\p{L}\\p{N}])(?:com|org|net|io|dev)\\.)${name}(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])${name}(?=@)`,
			"giu",
		);
		redacted = redacted.replace(pattern, "<user>");
	}
	return redacted;
}

/**
 * Prepare a grievance for storage and for the collector: redact the user's
 * identity, then clamp to the collector's field limits.
 *
 * An over-long `tool` is prose the model put on line 1 instead of a tool name,
 * so the original line is kept at the head of the report and only the stored
 * name is truncated: nothing is lost and the row stops being a poison pill.
 */
function normalizeGrievance(rawTool: string, rawReport: string): { tool: string; report: string } {
	const tool = redactUserIdentity(rawTool);
	const report = redactUserIdentity(rawReport);
	if (Buffer.byteLength(tool, "utf8") <= MAX_TOOL_BYTES) return { tool, report };
	return { tool: truncateHeadBytes(tool, MAX_TOOL_BYTES).text, report: `${tool}\n${report}` };
}

function parseReportIssueBody(text: string): { tool: string; report: string } {
	const body = text.trim();
	if (!body) {
		throw new ToolError(`Empty report. ${REPORT_ISSUE_USAGE}`);
	}
	const firstNewline = body.indexOf("\n");
	if (firstNewline >= 0) {
		const tool = body.slice(0, firstNewline).trim();
		const report = body.slice(firstNewline + 1).trim();
		if (tool && report) return normalizeGrievance(tool, report);
	}
	// Only a colon followed by whitespace separates, so a URI (`help://read/sources`) or an
	// unspaced argument (`{name:'x'}`) in the tool name stays in the tool name.
	const colon = body.search(/:\s/);
	if (colon > 0) {
		const tool = body.slice(0, colon).trim();
		const report = body.slice(colon + 1).trim();
		if (tool && report) return normalizeGrievance(tool, report);
	}
	throw new ToolError(`Invalid report format. ${REPORT_ISSUE_USAGE}`);
}

/** Legacy Auto-QA is opt-in and cannot inject reports unless explicitly configured. */
export function isAutoQaEnabled(settings?: Settings): boolean {
	if (!settings) return cfgDevAutoqa.envValue() ?? false;
	const enabled = cfgDevAutoqa.get(settings);
	if (cfgDevAutoqa.isConfigured(settings)) return enabled;
	return enabled && cfgDevAutoqaConsent.get(settings) !== "denied";
}

// The process-global handler lets reports from subagents reach the parent UI.
export type CoreforgeReportResult = boolean | null | "deferred";
export type CoreforgeReportHandler = (tool: string, report: string) => Promise<CoreforgeReportResult>;

let coreforgeReportHandler: CoreforgeReportHandler | null = null;
let coreforgeReportPromptTail: Promise<void> = Promise.resolve();

export function setCoreforgeReportHandler(handler: CoreforgeReportHandler | null): void {
	coreforgeReportHandler = handler;
}

/** Test-only: clear the handler and serialized prompt queue. */
export function __resetCoreforgeReportHandlerForTests(): void {
	coreforgeReportHandler = null;
	coreforgeReportPromptTail = Promise.resolve();
}

async function requestCoreforgeReport(tool: string, report: string): Promise<CoreforgeReportResult> {
	const invoke = async (): Promise<CoreforgeReportResult> => {
		if (!coreforgeReportHandler) return null;
		try {
			return await coreforgeReportHandler(tool, report);
		} catch (error) {
			logger.warn("Coreforge report prompt failed", { error: String(error) });
			return null;
		}
	};
	const request = coreforgeReportPromptTail.then(invoke, invoke);
	coreforgeReportPromptTail = request.then(
		() => undefined,
		() => undefined,
	);
	return request;
}

let cachedDb: Database | null = null;

/**
 * Open (or return the cached handle for) the auto-QA SQLite database at
 * `~/.omp/autoqa.db` (XDG: `$XDG_DATA_HOME/omp/autoqa.db`), creating the
 * schema lazily. Returns `null` when the path cannot be resolved or opened.
 */
export function openAutoQaDb(): Database | null {
	if (cachedDb) return cachedDb;
	const dbPath = getAutoQaDbPath();
	if (!dbPath) return null;
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath, { create: true });
		// Install the busy handler BEFORE any lock-taking statement. See #2421.
		db.run("PRAGMA busy_timeout = 5000");
		// `pushed` is tri-state: 0 = queued, 1 = accepted by the collector,
		// -1 = permanently refused (`push_error` holds the collector's reason).
		// Refused rows are parked so one bad row can't block the queue forever.
		db.exec(`
			CREATE TABLE IF NOT EXISTS grievances (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				model TEXT NOT NULL,
				version TEXT NOT NULL,
				tool TEXT NOT NULL,
				report TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				pushed INTEGER NOT NULL DEFAULT 0,
				push_error TEXT,
				source TEXT
			);
		`);
		// Legacy DBs (May 2026) predate `created_at`. ALTER TABLE only accepts
		// constant defaults, so add it empty and backfill before the index below.
		const hasCreatedAt = db.prepare("SELECT 1 FROM pragma_table_info('grievances') WHERE name = 'created_at'").get();
		if (!hasCreatedAt) {
			db.exec(`
				ALTER TABLE grievances ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
				UPDATE grievances SET created_at = CURRENT_TIMESTAMP WHERE created_at = '';
			`);
		}
		const hasPushError = db.prepare("SELECT 1 FROM pragma_table_info('grievances') WHERE name = 'push_error'").get();
		if (!hasPushError) db.exec("ALTER TABLE grievances ADD COLUMN push_error TEXT;");
		const hasSource = db.prepare("SELECT 1 FROM pragma_table_info('grievances') WHERE name = 'source'").get();
		if (!hasSource) db.exec("ALTER TABLE grievances ADD COLUMN source TEXT;");
		db.exec(`
			CREATE INDEX IF NOT EXISTS grievances_pushed_created_at_idx
			ON grievances (pushed, created_at, id);
		`);
		cachedDb = db;
		return db;
	} catch (error) {
		logger.warn("Failed to open auto-QA database", { error: String(error) });
		return null;
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Backend push
// ───────────────────────────────────────────────────────────────────────────

export interface FlushResult {
	/** Rows the collector accepted this flush. */
	pushed: number;
	ok: boolean;
	skipped?: boolean;
	/**
	 * Rows the collector permanently refused. They are parked as `pushed = -1`
	 * and never retried; only present when non-zero.
	 */
	rejected?: number;
	/** Last collector error (`HTTP <status>: <body>`), for CLI reporting. */
	error?: string;
}

/**
 * Optional per-flush controls. Used by `omp grievances push` to surface
 * progress to a TTY and to skip the user-facing consent gate (manual
 * pushes are the user's explicit intent, not a side effect of a model report).
 */
export interface FlushOptions {
	/**
	 * Skip the `dev.autoqaConsent === "granted"` gate in
	 * {@link resolvePushConfig}. Endpoint configuration is still required.
	 * Reserved for explicit user-driven pushes (CLI `grievances push`,
	 * future debug recipes); never set from the tool's auto-flush path.
	 */
	bypassConsent?: boolean;
	/**
	 * Fetch implementation for the push POST. Defaults to global fetch.
	 */
	fetch?: FetchImpl;
	/**
	 * Fires once at the start of the loop with the snapshot count of
	 * unpushed rows. Subsequent inserts won't be reflected (the count is
	 * a planning hint for progress reporters, not a live total).
	 */
	onStart?: (totalUnpushed: number) => void;
	/**
	 * Fires after every successfully shipped batch with the running pushed
	 * count. Reporters compare against the `totalUnpushed` they saw in
	 * `onStart` to advance their bar.
	 */
	onProgress?: (pushedSoFar: number) => void;
}

interface PushConfig {
	endpoint: string;
	token: string | undefined;
}

const FLUSH_TIMEOUT_MS = 5_000;
const FAILURE_COOLDOWN_MS = 30_000;
/**
 * Per-request batch size. The worker loops until no unpushed rows remain,
 * shipping `FLUSH_BATCH_SIZE` rows per POST. Tunes the trade-off between
 * request count and request size — 50 keeps each payload well under the
 * default `maxBody` limit on the autoqa collector while letting a
 * realistic backlog (a few hundred legacy rows on first flush after the
 * consent grant) drain in single-digit requests.
 */
const FLUSH_BATCH_SIZE = 50;

let inFlightFlush: Promise<FlushResult> | null = null;
let lastFailureAt = 0;

/** Test-only: clear single-flight + cooldown state. Never call from production code. */
export function __resetAutoQaFlushStateForTests(): void {
	inFlightFlush = null;
	lastFailureAt = 0;
}

function envOverrideString(name: string): string | undefined {
	const value = $env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePushConfig(settings: Settings | undefined, bypassConsent: boolean): PushConfig | null {
	if (!isAutoQaEnabled(settings)) return null;

	// Consent IS the push opt-in for the auto-flush path. `bypassConsent`
	// covers explicit user-driven pushes (`omp grievances push`) where the
	// user clearly intends to ship regardless of dialog state. The
	// `PI_AUTO_QA_PUSH` env flag stays as a CI/headless override too.
	if (!bypassConsent) {
		const consented = (settings ? cfgDevAutoqaConsent.get(settings) : undefined) === "granted";
		if (!consented && !$flag("PI_AUTO_QA_PUSH")) return null;
	}

	const endpoint =
		envOverrideString("PI_AUTO_QA_PUSH_URL") ?? (settings ? cfgDevAutoqaPushEndpoint.get(settings) : undefined);
	if (!endpoint || endpoint.trim().length === 0) return null;

	const token =
		envOverrideString("PI_AUTO_QA_PUSH_TOKEN") ?? (settings ? cfgDevAutoqaPushToken.get(settings) : undefined);
	return { endpoint: endpoint.trim(), token: token && token.length > 0 ? token : undefined };
}

interface GrievanceRow {
	id: number;
	model: string;
	version: string;
	tool: string;
	report: string;
	/** Historical tool provenance; null for rows recorded before provenance was stored. */
	source: string | null;
}

/** Cap on collector error text kept for logs, `FlushResult`, and `push_error`. */
const MAX_PUSH_ERROR_CHARS = 300;

async function describeErrorResponse(response: Response): Promise<string> {
	let detail = "";
	try {
		detail = (await response.text()).trim();
	} catch {
		/* body already consumed or not readable — status alone is the error */
	}
	if (detail.length > MAX_PUSH_ERROR_CHARS) detail = `${detail.slice(0, MAX_PUSH_ERROR_CHARS)}…`;
	return detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`;
}

type BatchOutcome =
	/** Collector accepted every entry. */
	| { kind: "sent" }
	/** Collector refused the payload; retrying the same bytes is pointless. */
	| { kind: "rejected"; error: string }
	/** Transient failure (network, 5xx, rate limit, auth) — try again later. */
	| { kind: "retry"; error: string };

async function performFlush(db: Database, config: PushConfig, options: FlushOptions = {}): Promise<FlushResult> {
	const selectStmt = db.prepare(
		"SELECT id, model, version, tool, report, source FROM grievances WHERE pushed = 0 ORDER BY id ASC LIMIT ?",
	);
	// Planning snapshot — fires once so progress reporters can size their bar.
	// Mid-flight inserts are NOT folded in (the worker drains them too, but
	// the progress bar treats the initial backlog as the denominator).
	if (options.onStart) {
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM grievances WHERE pushed = 0").get() as { n: number };
		options.onStart(totalRow.n);
	}
	const fetchImpl = options.fetch ?? fetch;
	let totalPushed = 0;
	let totalRejected = 0;
	let lastError: string | undefined;

	const postBatch = async (batch: GrievanceRow[]): Promise<BatchOutcome> => {
		const body = JSON.stringify({
			agent: { name: "omp", version: VERSION },
			installId: getInstallId(),
			// Coarse host fingerprint for triage — `darwin`/`linux`/`win32` +
			// `arm64`/`x64`. Useful for "is this bug arch-specific?" without
			// leaking the user's machine name.
			platform: process.platform,
			arch: process.arch,
			// Normalized on the way out so rows recorded before record-time
			// clamping and redaction existed neither poison every batch nor
			// ship the user's home directory.
			entries: batch.map(({ source, ...row }) => ({
				...row,
				...normalizeGrievance(row.tool, row.report),
				...(source ? { source } : {}),
			})),
		});
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (config.token) headers.authorization = `Bearer ${config.token}`;

		let response: Response;
		try {
			response = await fetchImpl(config.endpoint, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
			});
		} catch (error) {
			return { kind: "retry", error: String(error) };
		}
		if (response.ok) return { kind: "sent" };
		const error = await describeErrorResponse(response);
		// 400/413/422 mean the payload itself is unacceptable — retrying the same
		// bytes can only fail again. 5xx, 408, 429 and auth failures (401/403) say
		// nothing about the rows, so they stay retryable.
		const status = response.status;
		const permanent = status === 400 || status === 413 || status === 422;
		return permanent ? { kind: "rejected", error } : { kind: "retry", error };
	};

	/**
	 * Ship one batch, bisecting on payload rejections until the offending rows
	 * are isolated and parked. `false` means a transient failure — the caller
	 * stops the flush and leaves everything queued for the next attempt.
	 */
	const shipBatch = async (batch: GrievanceRow[]): Promise<boolean> => {
		const outcome = await postBatch(batch);
		if (outcome.kind === "sent") {
			const ids = batch.map(r => r.id);
			const placeholders = ids.map(() => "?").join(",");
			db.prepare(`UPDATE grievances SET pushed = 1 WHERE id IN (${placeholders})`).run(...ids);
			totalPushed += batch.length;
			options.onProgress?.(totalPushed);
			return true;
		}
		lastError = outcome.error;
		if (outcome.kind === "retry") return false;
		if (batch.length === 1) {
			const row = batch[0];
			if (!row) return true;
			db.prepare("UPDATE grievances SET pushed = -1, push_error = ? WHERE id = ?").run(outcome.error, row.id);
			totalRejected += 1;
			logger.warn("autoqa grievance rejected", {
				endpoint: config.endpoint,
				id: row.id,
				tool: row.tool,
				error: outcome.error,
			});
			return true;
		}
		const mid = Math.floor(batch.length / 2);
		return (await shipBatch(batch.slice(0, mid))) && (await shipBatch(batch.slice(mid)));
	};

	let ok = true;
	for (;;) {
		const rows = selectStmt.all(FLUSH_BATCH_SIZE) as GrievanceRow[];
		if (rows.length === 0) break;
		if (!(await shipBatch(rows))) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", {
				endpoint: config.endpoint,
				error: lastError,
				batchSize: rows.length,
				pushedSoFar: totalPushed,
			});
			ok = false;
			break;
		}
	}
	return {
		pushed: totalPushed,
		ok,
		...(totalRejected > 0 ? { rejected: totalRejected } : {}),
		...(lastError ? { error: lastError } : {}),
	};
}

/**
 * Flush queued grievances to the configured backend.
 */
export async function flushGrievances(
	db?: Database,
	settings?: Settings,
	options: FlushOptions = {},
): Promise<FlushResult> {
	const config = resolvePushConfig(settings, options.bypassConsent === true);
	if (!config) return { pushed: 0, ok: false, skipped: true };

	const bypass = options.bypassConsent === true;
	if (!bypass && inFlightFlush) return inFlightFlush;

	if (!bypass && lastFailureAt > 0 && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
		return { pushed: 0, ok: false, skipped: true };
	}

	const handle = db ?? openAutoQaDb();
	if (!handle) return { pushed: 0, ok: false, skipped: true };

	const promise = (async () => {
		try {
			return await performFlush(handle, config, options);
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("autoqa push failed", { endpoint: config.endpoint, error: String(error) });
			return { pushed: 0, ok: false };
		}
	})();

	if (!bypass) inFlightFlush = promise;
	try {
		return await promise;
	} finally {
		if (!bypass) inFlightFlush = null;
	}
}

export async function reportToolIssue(_session: ToolSession, text: string): Promise<AgentToolResult<unknown>> {
	const { tool, report } = parseReportIssueBody(text);
	const accepted = await requestCoreforgeReport(tool, report);
	const message =
		accepted === true
			? "Coreforge /report queued. The issue will still require draft approval before filing."
			: accepted === "deferred"
				? "Coreforge report saved for review when the agent is idle. Nothing was filed."
				: accepted === false
					? "Coreforge report dismissed. Nothing was filed."
					: "Coreforge /report requires an interactive parent session. Nothing was filed.";
	return { content: [{ type: "text", text: message }] };
}

const reportIssueSchema = type({
	report: type("string").describe("Observed failure in `<tool>: <concise description>` form."),
	"+": "reject",
});

export function createReportIssueTool(session: ToolSession): Tool {
	const tool: AgentTool<typeof reportIssueSchema> = {
		name: REPORT_ISSUE_COMMAND_NAME,
		label: "Report Tool Issue",
		summary: "Request review of an observed tool failure",
		description:
			"Request per-occurrence consent to start Coreforge /report with `<tool>: <concise description>`. No issue is filed until its draft is approved.",
		parameters: reportIssueSchema,
		strict: true,
		intent: "omit",
		approval: "write",
		async execute(_toolCallId, params) {
			return reportToolIssue(session, params.report);
		},
	};
	return tool;
}
