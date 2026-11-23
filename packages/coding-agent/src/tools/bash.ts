import {
	type BashToolDetails,
	formatBackgroundNotice,
	formatWallTimeNotice,
	formatExitCodeNotice,
	WALL_TIME_NOTICE_MIN_MS,
} from "@oh-my-pi/pi-tui/tools/bash";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { PipeStreams, type ShellCommands, shellBuiltins } from "@oh-my-pi/pi-natives";
import { $which, isEnoent, logger, prompt, spillUrl } from "@oh-my-pi/pi-utils";
import { $env } from "@oh-my-pi/pi-utils/env";
import { isCmdShell, isPosixShell, isPowerShell, type ShellConfig } from "@oh-my-pi/pi-utils/procmgr";
import {
	compileNotifyPattern,
	type NotifyPattern,
	OutputNotifier,
	raceJobSettlement,
	resolveAutoBackgroundWaitMs,
} from "../async";
import type { Settings } from "../config/settings";
import { shellChangeSnapshots } from "../commit/selective/journal";
import { type BoardEntry, registerOnBoard } from "../daemon/client";
import { applyDirenvPreflight, type BashResult, executeBash } from "../exec/bash-executor";
import { shellMounts, shellProcessCommand } from "../exec/shell-process";
import { createToolCommandHandler, toolCommandNames } from "../exec/tool-command-host";
import { InternalUrlRouter } from "../internal-urls";
import { sessionResolveContext } from "../internal-urls/context";
import {
	InternalUrlFilesystem,
	type InternalUrlFilesystemOptions,
	type UrlWriteReport,
	UrlFsError,
} from "../internal-urls/url-filesystem";
import { PipeTextSources, TextTap } from "../job-widgets";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import dcgApprovalPrompt from "../prompts/tools/dcg-approval.md" with { type: "text" };
import type {
	ClientBridge,
	ClientBridgeTerminalExitStatus,
	ClientBridgeTerminalHandle,
	ClientBridgeTerminalOutput,
} from "../session/client-bridge";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { TerminalGraphicsDecoder } from "../utils/terminal-graphics";
import { appendImageLinks } from "../utils/image-temp";
import type { ToolSession } from ".";
import { type RuntimeToolApprovalRequest, truncateForPrompt } from "./approval";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import type { ShellTrace } from "@oh-my-pi/pi-wire";
import { applyPatchShellInput } from "./bash-apply-patch";
import { checkBashInterception } from "./bash-interceptor";
import { rewriteGitWorktreeAdd } from "./bash-worktree-rewrite";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import {
	type DcgAskDecision,
	type DcgDecision,
	type DcgShellDialect,
	enforceDestructiveCommandGuard,
	isDestructiveCommandGuardConfigured,
} from "./destructive-command-guard";
import { resolveEvalBackends } from "./eval-backends";
import { invalidateGithubCacheForBashCommand, invalidateGithubCacheForBashResult } from "./gh-cache-invalidation";
import { serviceLogs, startService, type ServiceReady } from "../launch/services";
import { isFindEnabled } from "./jfind";
import { formatArtifactErrorNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { outputMeta, resolveInlineByteCapBudget } from "./output-meta";
import { resolveShellDirectory, resolveToCwd } from "./path-utils";
import {
	BASH_APPROVAL_SHELL_CONTROL_CHARS,
	extractAndChainSegments,
	extractLeadingCdTarget,
	extractLiteralAndChainSegments,
	isShellEnvironmentAssignment,
	type LiteralShellCommandSegment,
	lexShellCommand,
	tokenizeShellSegments,
	withoutLeadingEnvironmentAssignments,
} from "./shell-tokenize";
import { ToolAbortError } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";
import type { ToolCommandDispatch } from "./tool-commands";

import {
	cfgAstEditEnabled,
	cfgAstGrepEnabled,
	cfgAsyncEnabled,
	cfgGlobEnabled,
	cfgGrepEnabled,
	cfgLaunchEnabled,
	cfgToolsMaxTimeout,
} from "./settings";
import {
	type BashApprovalPatternRule,
	type BashPatternApproval,
	cfgBashAllowedEnvVars,
	cfgBashAllowCompoundCommands,
	cfgBashAutoBackgroundEnabled,
	cfgBashAutoBackgroundThresholdMs,
	cfgBashDirenv,
	cfgBashDirenvLoadTimeoutMs,
	cfgBashGitGuard,
	cfgBashInterceptorEnabled,
	cfgBashInterceptorPatterns,
	cfgBashPatterns,
	DEFAULT_BASH_INTERCEPTOR_RULES,
} from "../exec/settings";
import { cfgDisplayShellVisualization } from "../modes/settings";
import { cfgSkillful } from "../session/settings";
import { cfgWorktreeClone, ovnfsCommand } from "../task/settings";
import { sessionShellSpeech } from "../tts/shell-speech";
import { nativeShapingOff, shapeToolText, shapingExperiment } from "../spotlight";
import { SPOTLIGHT_FULL_OUTPUT_MAX_BYTES } from "../spotlight/types";
import type { SpotlightDetails } from "@oh-my-pi/pi-tui/chat/spotlight";

const BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;
const SERVICE_CODE_LOADING_ENV_RE =
	/^(?:BASH_ENV|BASH_FUNC_.*|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|LD_PRELOAD|DYLD_.*|NODE_OPTIONS|BUN_OPTIONS|PYTHONSTARTUP|RUBYOPT|PERL5OPT|GIT_CONFIG_.*|GIT_EXEC_PATH)$/i;
const INTERNAL_BASH_URL_RE = /(?<![\w./\\-])(?!(?:https?|file):\/\/)[a-z][a-z0-9+.-]*:\/\//i;

function assertSafeServiceEnv(env: Record<string, string> | undefined): void {
	for (const key of Object.keys(env ?? {})) {
		if (SERVICE_CODE_LOADING_ENV_RE.test(key))
			throw new ToolError(`Service env cannot set shell startup or preload variable: ${key}`);
	}
}

function hasBashApprovalShellControl(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let hasReinterpretableShellControl = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) {
				hasReinterpretableShellControl = true;
			}
			continue;
		}
		if (ch === "\\") {
			const escaped = command[i + 1];
			if (escaped && Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, escaped)) {
				hasReinterpretableShellControl = true;
			}
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			// Expansion is active inside double quotes even in the original line.
			if (ch === "`" || ch === "$") return true;
			// Other control characters are literal here but become executable if a
			// `-c`/`-e` option reinterprets the argument through another shell.
			if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) return true;
	}
	// Options such as `git -c alias.x='!...'` and `sh -c "..."` reinterpret
	// otherwise literal quoted or escaped arguments as executable code.
	return hasReinterpretableShellControl && BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE.test(command);
}

const BASH_PATTERN_APPROVAL_VALUES = new Set(["allow", "deny", "prompt"]);

/**
 * Shape a shell command line for an ACP-conformant `terminal/create` request.
 *
 * ACP's `command` field is documented as the executable and `args` as its
 * argv tail (see https://agentclientprotocol.com/protocol/v1/terminals), so a
 * spec-conformant client `spawn(command, args)`s them directly — no implicit
 * shell. A raw `bash` tool line ("git status && echo x | head") therefore has
 * to be wrapped in an explicit shell invocation, otherwise the client tries
 * to spawn the whole line as argv[0] and fails with `ENOENT` for anything
 * containing a space, pipe, `&&`, redirect, or `$(...)`.
 *
 * The wrap reuses the same shell binary + args the local `bash-executor` would
 * pick via `settings.getShellConfig()` — Git Bash / `bash.exe` on Windows
 * (`cmd.exe /c` as the last-resort fallback when no bash exists on the host),
 * `$SHELL` (bash/zsh) with the `sh` fallback on POSIX — so the ACP path
 * preserves `bash` tool semantics (`$VAR`, `$(...)`, `source`, POSIX quoting,
 * `-l`) wherever a POSIX shell is available. The agent host's shell path is
 * used as a proxy for the client's, matching the near-universal ACP
 * deployment shape of an editor spawning omp as a co-hosted subprocess.
 */
export function wrapShellLineForClientTerminal(
	line: string,
	shellConfig: { shell: string; args: string[]; prefix?: string | undefined },
): { command: string; args: string[] } {
	const finalLine = shellConfig.prefix ? `${shellConfig.prefix} ${line}` : line;
	return { command: shellConfig.shell, args: [...shellConfig.args, finalLine] };
}

/**
 * Bash patterns flagged as safety critical for approval policy.
 *
 * These remain approval signals for non-yolo sessions. Destructive Git,
 * filesystem, disk, infrastructure, and database decisions belong to DCG.
 */
export const CRITICAL_BASH_PATTERNS = [
	// Fork bomb (a few common spacings).
	/:\(\)\s*\{\s*:\s*\|\s*:/i,

	// Remote-fetch-then-execute (curl/wget piped to a shell or process-subbed).
	/\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	/(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	// Process/host control — must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
] as const;

const FALLBACK_DESTRUCTIVE_BASH_PATTERNS = [
	/\brm\s+(?:-\S+\s+)*(?:-[a-z]*[rRfF][a-z]*|--recursive|--force)\s+(?:-\S+\s+)*\//i,
	/\brm\s+(?:-\S+\s+)*--no-preserve-root\b/i,
	/\bsudo\s+rm\b/i,
	/\bchmod\s+-R\s+[0-7]+\s+\//i,
	/\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//,
	/\bchown\s+-R\s+\S+\s+\//i,
	/>\s*\/dev\/sd[a-z]/i,
	/\bmkfs(\.|\b)/i,
	/\bdd\s+if=.+of=\/dev\/(?!(?:null|zero|stdout|stderr|tty|fd\/\d+)(?:[\s;&|)<>]|$))/i,
	/\bshred\s+\/dev\//i,
	/\bcryptsetup\b/i,
	/>\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i,
] as const;
const ALL_CRITICAL_BASH_PATTERNS = [...CRITICAL_BASH_PATTERNS, ...FALLBACK_DESTRUCTIVE_BASH_PATTERNS];

function normalizeBashApprovalPattern(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

function bashApprovalPatternToRegExp(pattern: string): RegExp {
	const escaped = normalizeBashApprovalPattern(pattern)
		.split("*")
		.map(part => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "u");
}

function normalizeBashPatternApproval(value: unknown): BashPatternApproval | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return BASH_PATTERN_APPROVAL_VALUES.has(normalized) ? (normalized as BashPatternApproval) : undefined;
}

function normalizeBashAllowedEnvList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
}

function getBashApprovalPatternRules(value: unknown): BashApprovalPatternRule[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(item => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
			const record = item as Record<string, unknown>;
			if (typeof record.match !== "string") return undefined;
			const match = normalizeBashApprovalPattern(record.match);
			const approval = normalizeBashPatternApproval(record.approval);
			const env = normalizeBashAllowedEnvList(record.env);
			if (match.length === 0 || !approval) return undefined;
			return env.length > 0 ? { match, approval, env } : { match, approval };
		})
		.filter((rule): rule is BashApprovalPatternRule => !!rule);
}

function commandMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	return bashApprovalPatternToRegExp(pattern).test(normalizedCommand);
}

// Names match exactly: a wildcard such as `CARGO_*` would also admit
// execution-redirecting variables (`CARGO_BUILD_RUSTC_WRAPPER`, `*_RUNNER`).
function stripAllowedLeadingEnvAssignments(command: string, allowedEnvNames: readonly string[]): string | undefined {
	if (allowedEnvNames.length === 0) return undefined;
	return withoutLeadingEnvironmentAssignments(command, varName => allowedEnvNames.includes(varName)) ?? undefined;
}

// `deny`/`prompt` rules are matched per segment so a dangerous command buried in
// a compound line (`cd x && rm -rf /`, `sleep 1 & rm -rf /`) is still caught,
// including when prefixed by leading `NAME=value` environment assignments.
// Reuse the shared shell tokenizer so segmentation stays in one place and honors
// every command boundary (`;`, `&&`, `||`, `|`, `&`, subshells, newlines).
function bashCommandSegments(command: string): string[] {
	const candidates: string[] = [];
	for (const words of tokenizeShellSegments(command)) {
		if (words.length === 0) continue;
		candidates.push(words.join(" "));
		let firstCmdIndex = 0;
		while (firstCmdIndex < words.length && isShellEnvironmentAssignment(words[firstCmdIndex])) {
			firstCmdIndex++;
		}
		if (firstCmdIndex > 0 && firstCmdIndex < words.length) {
			candidates.push(words.slice(firstCmdIndex).join(" "));
		}
	}
	return candidates;
}

// `deny`/`prompt` matching: the rule fires when its glob matches the whole
// command or any single segment of a compound command.
function commandSegmentMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const regex = bashApprovalPatternToRegExp(pattern);
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	if (regex.test(normalizedCommand)) return true;
	return bashCommandSegments(command).some(segment => regex.test(segment));
}

// A rule "applies" to a command under approval-specific semantics: `allow` must
// vouch for the ENTIRE command and never rides a compound line (shell control
// syntax could smuggle an unsafe segment past a narrow allow), while `deny` and
// `prompt` fire on any matching segment so they mean what they appear to.
function bashApprovalRuleMatches(
	command: string,
	rule: BashApprovalPatternRule,
	allowedEnvVars: readonly string[],
): boolean {
	if (rule.approval === "allow") {
		if (hasBashApprovalShellControl(command)) return false;
		const trimmedCommand = command.trimStart();
		const hasLeadingEnv =
			withoutLeadingEnvironmentAssignments(trimmedCommand) !== null || isShellEnvironmentAssignment(trimmedCommand);
		if (
			(!hasLeadingEnv || isShellEnvironmentAssignment(rule.match)) &&
			commandMatchesBashApprovalPattern(command, rule.match)
		) {
			return true;
		}
		if (!hasLeadingEnv) return false;
		const effectiveEnv = rule.env ? [...rule.env, ...allowedEnvVars] : allowedEnvVars;
		const stripped = stripAllowedLeadingEnvAssignments(trimmedCommand, effectiveEnv);
		return stripped !== undefined && commandMatchesBashApprovalPattern(stripped, rule.match);
	}
	return commandSegmentMatchesBashApprovalPattern(command, rule.match);
}

function findNonCompoundBashRestrictionRule(
	command: string,
	rules: readonly BashApprovalPatternRule[],
): BashApprovalPatternRule | undefined {
	const segments = bashCommandSegments(command);
	let promptRule: BashApprovalPatternRule | undefined;
	for (const rule of rules) {
		if (
			rule.approval !== "allow" &&
			commandMatchesBashApprovalPattern(command, rule.match) &&
			!segments.some(segment => commandMatchesBashApprovalPattern(segment, rule.match))
		) {
			if (rule.approval === "deny") return rule;
			promptRule ??= rule;
		}
	}
	for (const segment of segments) {
		const segmentRule = rules.find(
			rule => rule.approval !== "allow" && commandMatchesBashApprovalPattern(segment, rule.match),
		);
		if (segmentRule?.approval === "deny") return segmentRule;
		if (segmentRule?.approval === "prompt") promptRule ??= segmentRule;
	}
	return promptRule;
}

function findBashApprovalPatternRule(
	command: string,
	rules: readonly BashApprovalPatternRule[],
	allowedEnvVars: readonly string[],
): BashApprovalPatternRule | undefined {
	if (hasBashApprovalShellControl(command)) {
		return findNonCompoundBashRestrictionRule(command, rules);
	}
	return rules.find(rule => bashApprovalRuleMatches(command, rule, allowedEnvVars));
}

type BashPatternDecision =
	| { kind: "deny"; rule: BashApprovalPatternRule }
	| { kind: "prompt"; rule: BashApprovalPatternRule }
	| { kind: "allow" }
	| { kind: "unmatched" };

/** One `bash.patterns` view: its rules plus the env names its `allow` rules may strip. */
interface BashPatternPolicy {
	rules: BashApprovalPatternRule[];
	allowedEnvVars: string[];
}

function resolveBashPatternDecision(
	command: string,
	compoundSegments: readonly LiteralShellCommandSegment[] | null,
	patternRules: readonly BashApprovalPatternRule[],
	allowedEnvVars: readonly string[],
): BashPatternDecision {
	if (compoundSegments) {
		let promptRule: BashApprovalPatternRule | undefined;
		for (const rule of patternRules) {
			if (
				rule.approval !== "allow" &&
				commandMatchesBashApprovalPattern(command, rule.match) &&
				!compoundSegments.some(segment => commandSegmentMatchesBashApprovalPattern(segment.text, rule.match))
			) {
				if (rule.approval === "deny") return { kind: "deny", rule };
				promptRule ??= rule;
			}
		}
		let hasUnmatchedSegment = false;
		for (const segment of compoundSegments) {
			const segmentRule = findBashApprovalPatternRule(segment.text, patternRules, allowedEnvVars);
			if (segmentRule?.approval === "deny") return { kind: "deny", rule: segmentRule };
			if (segmentRule?.approval === "prompt") promptRule ??= segmentRule;
			if (!segmentRule) hasUnmatchedSegment = true;
		}
		if (promptRule) return { kind: "prompt", rule: promptRule };
		return hasUnmatchedSegment ? { kind: "unmatched" } : { kind: "allow" };
	}
	const patternRule = findBashApprovalPatternRule(command, patternRules, allowedEnvVars);
	if (patternRule?.approval === "deny") return { kind: "deny", rule: patternRule };
	if (patternRule?.approval === "prompt") return { kind: "prompt", rule: patternRule };
	if (patternRule?.approval === "allow") return { kind: "allow" };
	return { kind: "unmatched" };
}

async function saveBashOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.();
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, originalText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

const BASH_TIMEOUT_DESCRIPTION = `timeout in seconds; 0 disables the command deadline; nonzero values are clamped to ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}`;

// Blank stays valid: some tool-call layers spell an unset field as "".
const SERVICE_NAME = type(/^(?:\s*|[A-Za-z0-9][A-Za-z0-9._-]{0,47})$/).describe(
	"starts a long-lived supervised service under this name; omit for finite commands, async jobs included. 1-48 of [A-Za-z0-9._-]",
);

const SERVICE_READY = type({
	"log?": type("string").describe("regex an output line matches once the service is ready"),
	"port?": type("number").describe("TCP port the service accepts connections on once ready"),
	"host?": type("string").describe("host for the port probe; default localhost (127.0.0.1 and ::1)"),
	"timeout?": type("number").describe("seconds to wait for readiness; default 30"),
}).describe("service readiness; needs log or port");

const bashSchemaBase = type({
	command: type("string"),
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
});

const bashSchemaWithAsync = type({
	command: "string",
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"async?": "boolean",
	"notify?": "string",
});

const bashSchemaWithService = type({
	command: "string",
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"notify?": "string",
	"name?": SERVICE_NAME,
	"ready?": SERVICE_READY,
});

const bashSchemaWithAsyncAndService = type({
	command: "string",
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"async?": "boolean",
	"notify?": "string",
	"name?": SERVICE_NAME,
	"ready?": SERVICE_READY,
});

// Without an interactive UI a finite command's `pty` can only fall back, so those sessions are not
// offered it; services keep it, since the daemon gives them a terminal of their own.
const bashSchemaBaseNoPty = bashSchemaBase.omit("pty");
const bashSchemaWithAsyncNoPty = bashSchemaWithAsync.omit("pty");

type BashToolSchema =
	| typeof bashSchemaBase
	| typeof bashSchemaWithAsync
	| typeof bashSchemaWithService
	| typeof bashSchemaWithAsyncAndService
	| typeof bashSchemaBaseNoPty
	| typeof bashSchemaWithAsyncNoPty;

export interface BashToolInput {
	command: string;
	timeout?: number;
	cwd?: string;
	name?: string;
	ready?: ServiceReady;
	async?: boolean;
	/**
	 * Regex; each output line it matches is reported while the command runs. Without `name` the command
	 * runs as a background job, as `async` does; with `name` the service reports.
	 */
	notify?: string;
	pty?: boolean;
}

const PTY_BOARD_COMMAND_MAX = 60;

/** A pty command as one board-label line of at most {@link PTY_BOARD_COMMAND_MAX} chars. */
function ptyBoardCommand(command: string): string {
	const line = command.replace(/\s+/gu, " ").trim();
	return line.length > PTY_BOARD_COMMAND_MAX ? `${line.slice(0, PTY_BOARD_COMMAND_MAX - 1)}…` : line;
}

/**
 * Treats a blank string as an unset field.
 *
 * Some tool-call layers materialize every optional argument, spelling "not set"
 * as `""`; a whitespace-only service name is no more a name than a missing one.
 */
function blankToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Drops placeholder readiness fields, and the whole spec when it names no
 * condition (`log` or `port`): `host` and `timeout` only configure one. An
 * empty `log` pattern would otherwise match the first byte of output, an empty
 * `host` would break the TCP probe, and a zero `port` (how tool-call layers
 * materialize an unset number; no listener has it) would fail port validation,
 * so placeholder values must not reach {@link startService}.
 */
function normalizeReady(ready: ServiceReady | undefined): ServiceReady | undefined {
	if (!ready) return undefined;
	const log = blankToUndefined(ready.log);
	const port = Number.isFinite(ready.port) && ready.port !== 0 ? ready.port : undefined;
	if (log === undefined && port === undefined) return undefined;
	const host = blankToUndefined(ready.host);
	const timeout = Number.isFinite(ready.timeout) ? ready.timeout : undefined;
	return { log, host, port, timeout };
}

function normalizeBashInput(input: BashToolInput): BashToolInput {
	if ("env" in input) throw new ToolError("Bash no longer accepts an env parameter.");
	const name = blankToUndefined(input.name);
	const ready = name === undefined ? undefined : normalizeReady(input.ready);
	if (name !== undefined && ready === undefined && (input.async === true || input.timeout !== undefined)) {
		throw new ToolError("A named service takes no async or timeout without a readiness condition.");
	}
	return {
		...input,
		name,
		async: name === undefined ? input.async === true || blankToUndefined(input.notify) !== undefined : undefined,
		timeout: name === undefined ? input.timeout : undefined,
		ready,
	};
}
export interface BashToolOptions {}

interface PreparedShellConfig {
	shell: string;
	args: string[];
	prefix: string | undefined;
	env: Record<string, string>;
}

type PreparedBashBackend =
	| { kind: "local" }
	| {
			kind: "client-terminal";
			bridge: ClientBridge;
			createTerminal: NonNullable<ClientBridge["createTerminal"]>;
			shellConfig: PreparedShellConfig;
	  }
	| {
			kind: "local-pty";
			ui: NonNullable<AgentToolContext["ui"]>;
			shellConfig: PreparedShellConfig;
	  }
	| { kind: "service"; shellConfig: PreparedShellConfig };

interface PreparedBashExecution {
	command: string;
	commandCwd: string;
	guardCwd: string;
	cwdSelected: boolean;
	cdSeparator?: ";";
	dcgDecision: DcgDecision;
	backend: PreparedBashBackend;
	preflight: { command: string; env: Record<string, string> | undefined };
}

function snapshotShellConfig(settings: Settings): PreparedShellConfig {
	const config: ShellConfig = settings.getShellConfig();
	return {
		shell: config.shell,
		args: [...config.args],
		prefix: config.prefix,
		env: { ...config.env },
	};
}

function sameShellConfig(left: PreparedShellConfig, right: PreparedShellConfig): boolean {
	return (
		left.shell === right.shell &&
		left.prefix === right.prefix &&
		left.args.length === right.args.length &&
		left.args.every((arg, index) => arg === right.args[index]) &&
		Object.keys(left.env).length === Object.keys(right.env).length &&
		Object.entries(left.env).every(([key, value]) => right.env[key] === value)
	);
}

function sameBashBackend(left: PreparedBashBackend, right: PreparedBashBackend): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "local":
			return true;
		case "client-terminal":
			return (
				right.kind === "client-terminal" &&
				left.bridge === right.bridge &&
				left.createTerminal === right.createTerminal &&
				sameShellConfig(left.shellConfig, right.shellConfig)
			);
		case "local-pty":
			return (
				right.kind === "local-pty" && left.ui === right.ui && sameShellConfig(left.shellConfig, right.shellConfig)
			);
		case "service":
			return right.kind === "service" && sameShellConfig(left.shellConfig, right.shellConfig);
	}
}

function dcgDialectForBackend(backend: PreparedBashBackend): DcgShellDialect {
	if (backend.kind !== "client-terminal") return "posix";
	const shell = backend.shellConfig.shell;
	if (isCmdShell(shell)) return "cmd";
	if (isPowerShell(shell)) return "ps";
	return "posix";
}

function formatDcgRuntimeApproval(
	input: BashToolInput,
	prepared: PreparedBashExecution,
	decision: DcgAskDecision,
): RuntimeToolApprovalRequest {
	const rule = decision.ruleId ?? "unknown rule";
	return {
		reason: `Destructive Command Guard requires review (${rule})`,
		tuiStyle: "destructive",
		allowParentApproval: true,
		prompt: prompt.render(dcgApprovalPrompt, {
			rule,
			reason: decision.reason,
			workingDirectory: JSON.stringify(prepared.commandCwd),
			environment: "{}",
			executionMode:
				input.name !== undefined
					? `named service ${JSON.stringify(input.name)}`
					: input.async === true
						? "background"
						: input.pty === true
							? "interactive PTY"
							: "foreground",
			timeoutSeconds: input.timeout ?? 300,
			command: JSON.stringify(prepared.command),
		}),
	};
}

function bashInputFingerprint(input: BashToolInput): string {
	return JSON.stringify({
		command: input.command,
		timeout: input.timeout,
		cwd: input.cwd,
		name: input.name,
		ready: input.ready,
		async: input.async,
		pty: input.pty,
	});
}

type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
			result: AgentToolResult<BashToolDetails>;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	getLatestTrace: () => ShellTrace | undefined;
	/** Notices for this call's results, including the ones the run adds (URL writes). */
	notices: readonly string[];
	/** Hand the call's card to the job: later frames carry `details.async` and the last one settles it. */
	background: () => void;
	/** Text the run wrote to `out://` while the call was in the foreground, oldest first. */
	replies: readonly string[];
	/** Tool command dispatches of the run so far, in invocation order. */
	toolCommands: () => ToolCommandDispatch[];
}

interface BashProgressDetails extends BashToolDetails {
	images?: ImageContent[];
	/** A running job's output so far (`proc://` shows it). */
	output?: string;
}

/** Pid probe of a background job with no command in flight. */
const NO_PIDS = (): readonly number[] => [];

/**
 * Shown when a call ran in a fork of the session's busy shell (it overlapped a parallel or backgrounded call)
 * and what it set could not be carried back into the session's shell.
 */
const FORK_STATE_LOST_NOTICE = "Ran in a copy of the busy session shell; changes here won't persist.";
/** Shown when such a call left background jobs running: they stay in the copy. */
const FORK_JOBS_NOTICE =
	"Background jobs started here run in a copy of the busy session shell; later calls' jobs, wait and %N won't see them.";

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

/**
 * Incrementally decodes cumulative client-terminal snapshots. Normal snapshots
 * append only the unseen suffix; a host-side rolling/truncated window retires
 * the old decoder and starts from the replacement snapshot without losing
 * images already completed before the rollover.
 */
class TerminalSnapshotDecoder {
	#decoder = new TerminalGraphicsDecoder();
	#raw = "";
	#clean = "";
	#retiredImages: Array<Promise<ImageContent[]>> = [];

	push(snapshot: string): string {
		if (!snapshot.startsWith(this.#raw)) {
			this.#decoder.finish();
			this.#retiredImages.push(this.#decoder.images());
			this.#decoder = new TerminalGraphicsDecoder();
			this.#raw = "";
			this.#clean = "";
		}
		const suffix = snapshot.slice(this.#raw.length);
		this.#raw = snapshot;
		this.#clean += this.#decoder.push(suffix);
		return this.#clean;
	}

	async finish(snapshot: string): Promise<{ text: string; images: ImageContent[] }> {
		const text = this.push(snapshot) + this.#decoder.finish();
		const batches = await Promise.all([...this.#retiredImages, this.#decoder.images()]);
		return { text, images: batches.flat() };
	}
}

function formatTimeoutClampNotice(
	requestedTimeoutSec: number,
	effectiveTimeoutSec: number,
	maxTimeout: number,
): string | undefined {
	if (requestedTimeoutSec === effectiveTimeoutSec) return undefined;
	const cappedByGlobal = maxTimeout > 0 && effectiveTimeoutSec === maxTimeout && maxTimeout < TOOL_TIMEOUTS.bash.max;
	const limit = cappedByGlobal
		? `global tools.maxTimeout ceiling ${maxTimeout}s`
		: `allowed range ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}s`;
	return `Timeout clamped to ${effectiveTimeoutSec}s (requested ${requestedTimeoutSec}s; ${limit}).`;
}

/**
 * Records handler answers to a command's URL writes (`> proc://<id>/kill`, `> out://`) as
 * result notices: the shell itself shows only an errno for a refused write.
 */
function noticeUrlWrites(notices: string[]): (report: UrlWriteReport) => void {
	return ({ url, text, failed }) => {
		if (failed) notices.push(`Write to ${url} failed: ${text}`);
		else if (text) notices.push(`${url}: ${text}`);
	};
}

/** Explicit tool `cwd` keeps the workspace-root alias; a hoisted shell `cd` does not. */
function resolveCommandCwd(cwd: string | undefined, sessionCwd: string, hoistedShellCwd: boolean): string {
	if (!cwd) return sessionCwd;
	return hoistedShellCwd ? resolveShellDirectory(cwd, sessionCwd) : resolveToCwd(cwd, sessionCwd);
}

/** Words that may precede a simple command in a command list without being its name. */
const SHELL_COMMAND_PREFIX_WORDS: ReadonlySet<string> = new Set([
	"!",
	"{",
	"if",
	"then",
	"elif",
	"else",
	"do",
	"while",
	"until",
	"time",
]);

/** Name of a command a simple command starts with, past leading assignments and list keywords. */
function simpleCommandName(words: readonly string[]): string | undefined {
	return words.find(word => !isShellEnvironmentAssignment(word) && !SHELL_COMMAND_PREFIX_WORDS.has(word));
}

/** First session tool command a simple command of `command` starts with. */
function invokedToolCommand(command: string, names: ReadonlySet<string>): string | undefined {
	if (names.size === 0) return undefined;
	for (const words of tokenizeShellSegments(command)) {
		const name = simpleCommandName(words);
		if (name !== undefined && names.has(name)) return name;
	}
	return undefined;
}

/** Whether the first simple command of `command` is a session tool command. */
function startsWithToolCommand(command: string, names: ReadonlySet<string>): boolean {
	const first = tokenizeShellSegments(command)[0]?.[0];
	return first !== undefined && names.has(first);
}

/** Operators that may join the commands of a line made only of tool commands. */
const TOOL_COMMAND_LINE_OPERATORS: Record<string, true> = {
	"": true,
	";": true,
	"&&": true,
	"||": true,
	"|": true,
	"|&": true,
};

/**
 * Whether every simple command of `command` invokes one of `names`, joined only by `;`, `&&`, `||`,
 * `|` and newlines, with no redirection, expansion or substitution, grouping, comment, backgrounding
 * or assignment prefix. Anything this scan cannot vouch for is not such a line.
 */
function isToolCommandLine(command: string, names: ReadonlySet<string>): boolean {
	if (names.size === 0) return false;
	let commandStart = true;
	let commands = 0;
	for (const token of lexShellCommand(command)) {
		if (token.kind === "separator") {
			if (!Object.hasOwn(TOOL_COMMAND_LINE_OPERATORS, token.raw.replace(/[ \t\n]/gu, ""))) return false;
			if (/[\n;&|]/u.test(token.raw)) commandStart = true;
			continue;
		}
		if (/[<>`$\r]/u.test(token.raw) || token.raw.startsWith("#")) return false;
		if (commandStart) {
			if (!names.has(token.value)) return false;
			commands++;
			commandStart = false;
		}
	}
	return commands > 0;
}

/** Tool command dispatches of one bash run, in invocation order. */
class ToolCommandRecorder {
	#records: Array<ToolCommandDispatch | undefined> = [];
	#finished = new Set<number>();

	/** Record a finished dispatch. */
	finish(dispatch: ToolCommandDispatch, index: number): void {
		this.#records[index] = dispatch;
		this.#finished.add(index);
	}

	/** Record the partial details a running dispatch reported. */
	progress(dispatch: ToolCommandDispatch, index: number): void {
		if (this.#finished.has(index)) return;
		const current = this.#records[index];
		this.#records[index] = current ? { ...current, inner: dispatch.inner } : dispatch;
	}

	/** Records so far, in invocation order. */
	list(): ToolCommandDispatch[] {
		return this.#records.filter((record): record is ToolCommandDispatch => record !== undefined);
	}

	/** `details.toolCommands` for a frame or result; empty when nothing was dispatched. */
	details(): { toolCommands?: ToolCommandDispatch[] } {
		const toolCommands = this.list();
		return toolCommands.length > 0 ? { toolCommands } : {};
	}
}

/**
 * Bash tool implementation.
 *
 * Executes bash commands with optional timeout and working directory.
 */
export class BashTool implements AgentTool<BashToolSchema, BashToolDetails> {
	readonly name = "bash";
	/** Own the embedded run, including admitted nested tool cleanup, until it settles. */
	readonly cancellationBehavior = "await-cleanup";
	/** Bash reads `skill://` paths through its shell filesystem, including as a working directory. */
	readonly readsSkillUris = true;
	/**
	 * The interceptor message for a call, checking the raw command and the one after a leading
	 * `cd … &&` so the wrapper hides neither shell-navigation rules nor the dedicated-tool command.
	 * A command led by a session tool command is that tool's own call and is never intercepted.
	 */
	#interception(
		rawCommand: string,
		command: string,
		name: string | undefined,
		toolNames: string[],
		toolCommands: ReadonlySet<string>,
	): string | undefined {
		if (!cfgBashInterceptorEnabled.get(this.session.settings)) return undefined;
		const rules = cfgBashInterceptorPatterns
			.get(this.session.settings)
			.filter(
				rule =>
					name === undefined ||
					!DEFAULT_BASH_INTERCEPTOR_RULES.some(
						defaultRule =>
							defaultRule.tool === "bash" &&
							rule.tool === "bash" &&
							rule.pattern === defaultRule.pattern &&
							rule.message === defaultRule.message,
					),
			);
		for (const commandToCheck of rawCommand === command ? [command] : [rawCommand, command]) {
			if (startsWithToolCommand(commandToCheck, toolCommands)) continue;
			const interception = checkBashInterception(commandToCheck, toolNames, rules, rawCommand);
			if (interception.block) return interception.message ?? "Command blocked";
		}
		return undefined;
	}

	readonly approval = (args: unknown, ctx?: AgentToolContext): ToolApprovalDecision => {
		const input = (args ?? {}) as Partial<BashToolInput>;
		const rawCommand = input.command;
		const command = typeof rawCommand === "string" ? rawCommand : "";
		// An intercepted call is refused outright; asking first would only approve a doomed call.
		const cwdCommand = input.cwd ? command : (extractLeadingCdTarget(command)?.rest ?? command);
		const name = typeof input.name === "string" ? blankToUndefined(input.name) : undefined;
		const toolCommands = new Set(toolCommandNames(this.session));
		const interception = this.#interception(command, cwdCommand, name, ctx?.toolNames ?? [], toolCommands);
		if (interception) {
			return { tier: "exec", override: true, policy: "deny", reason: interception.replace(/^Blocked:\s*/u, "") };
		}
		const { session: policy, authority } = this.#patternPolicies();
		const shell = cfgBashAllowCompoundCommands.get(this.session.settings)
			? this.session.settings.getShellConfig().shell
			: undefined;
		const compoundSegments = shell && isPosixShell(shell) ? extractLiteralAndChainSegments(command) : null;
		const decision = resolveBashPatternDecision(command, compoundSegments, policy.rules, policy.allowedEnvVars);
		// Project layers may tighten the operator's `bash.patterns`, never loosen
		// them: an operator deny or prompt still applies under a project allow.
		const authorityDecision =
			authority === policy
				? decision
				: resolveBashPatternDecision(command, compoundSegments, authority.rules, authority.allowedEnvVars);
		const denied =
			authorityDecision.kind === "deny" ? authorityDecision : decision.kind === "deny" ? decision : undefined;
		if (denied) {
			return {
				tier: "exec",
				override: true,
				policy: "deny",
				reason: `Blocked by bash pattern: ${denied.rule.match}`,
			};
		}
		const prompted =
			authorityDecision.kind === "prompt" ? authorityDecision : decision.kind === "prompt" ? decision : undefined;
		if (prompted) {
			return {
				tier: "exec",
				override: true,
				policy: "prompt",
				reason: `Prompt required by bash pattern: ${prompted.rule.match}`,
			};
		}
		const patterns = isDestructiveCommandGuardConfigured() ? CRITICAL_BASH_PATTERNS : ALL_CRITICAL_BASH_PATTERNS;
		const criticalCommand = command !== "" && patterns.some(pattern => pattern.test(command));
		if (!compoundSegments && criticalCommand) {
			return { tier: "exec", override: true, reason: "Critical pattern detected" };
		}
		if (compoundSegments) {
			for (const segment of compoundSegments) {
				const literalCommand = segment.argv.join(" ");
				if (criticalCommand || patterns.some(pattern => pattern.test(literalCommand))) {
					return { tier: "exec", override: true, reason: "Critical pattern detected" };
				}
			}
		}
		// Each tool command passes its own approval when it runs; the line itself only reads.
		if (isToolCommandLine(command, toolCommands)) return "read";
		if (decision.kind === "allow") return { tier: "write", policy: "allow" };
		return "exec";
	};
	/**
	 * `bash.patterns` rules and env allowlist for the session (`session`) and for the operator layers
	 * alone (`authority`, from `Settings.grantAuthority()`); `authority` is `session` when they agree.
	 * Shared by {@link approval} and the compound approval rows so both judge segments alike.
	 */
	#patternPolicies(): { session: BashPatternPolicy; authority: BashPatternPolicy } {
		const settings = this.session.settings;
		const rawPatterns = cfgBashPatterns.get(settings);
		const rawAllowedEnvVars = cfgBashAllowedEnvVars.get(settings);
		const session: BashPatternPolicy = {
			rules: getBashApprovalPatternRules(rawPatterns),
			allowedEnvVars: normalizeBashAllowedEnvList(rawAllowedEnvVars),
		};
		const authoritySettings = settings.grantAuthority?.();
		if (!authoritySettings) return { session, authority: session };
		const rawAuthorityPatterns = cfgBashPatterns.get(authoritySettings);
		const rawAuthorityAllowedEnvVars = cfgBashAllowedEnvVars.get(authoritySettings);
		if (rawAuthorityPatterns === rawPatterns && rawAuthorityAllowedEnvVars === rawAllowedEnvVars) {
			return { session, authority: session };
		}
		return {
			session,
			authority: {
				rules: getBashApprovalPatternRules(rawAuthorityPatterns),
				allowedEnvVars: normalizeBashAllowedEnvList(rawAuthorityAllowedEnvVars),
			},
		};
	}

	#formatCompoundApprovalDetails(command: string): string[] | null {
		const shell = cfgBashAllowCompoundCommands.get(this.session.settings)
			? this.session.settings.getShellConfig().shell
			: undefined;
		if (!shell || !isPosixShell(shell)) return null;
		const segments = extractAndChainSegments(command);
		if (!segments) return null;
		const { session: policy, authority } = this.#patternPolicies();
		// Whole-chain restrictions apply to the complete chain rather than individual segments.
		for (const rules of authority === policy ? [policy.rules] : [authority.rules, policy.rules]) {
			for (const rule of rules) {
				if (
					rule.approval !== "allow" &&
					commandMatchesBashApprovalPattern(command, rule.match) &&
					!segments.some(segment => commandSegmentMatchesBashApprovalPattern(segment.text, rule.match))
				) {
					return null;
				}
			}
		}
		const patterns = isDestructiveCommandGuardConfigured() ? CRITICAL_BASH_PATTERNS : ALL_CRITICAL_BASH_PATTERNS;
		const segmentCritical = segments.map(segment => {
			const literalCommand = segment.literal?.argv.join(" ");
			return patterns.some(
				pattern => pattern.test(segment.text) || (literalCommand !== undefined && pattern.test(literalCommand)),
			);
		});
		const wholeChainOnlyCritical =
			command !== "" && patterns.some(pattern => pattern.test(command)) && !segmentCritical.some(Boolean);
		if (wholeChainOnlyCritical) return null;

		let chainUntainted = true;
		const rows: string[] = [];
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i]!;
			const isCritical = segmentCritical[i]!;
			const segmentRule = findBashApprovalPatternRule(segment.text, policy.rules, policy.allowedEnvVars);
			const authorityRule =
				authority === policy
					? segmentRule
					: findBashApprovalPatternRule(segment.text, authority.rules, authority.allowedEnvVars);
			const promptRule =
				authorityRule?.approval === "prompt"
					? authorityRule
					: segmentRule?.approval === "prompt"
						? segmentRule
						: undefined;
			const covered =
				chainUntainted &&
				segment.literal !== null &&
				!isCritical &&
				!promptRule &&
				authorityRule?.approval !== "deny" &&
				segmentRule?.approval === "allow";
			if (segment.mutatesShellState) chainUntainted = false;
			if (covered && segmentRule) {
				rows.push(`  ✓ ${truncateForPrompt(segment.text)} (allowed: ${segmentRule.match})`);
			} else {
				const reason = promptRule
					? `prompt: ${promptRule.match}`
					: isCritical
						? "critical pattern"
						: "requires approval";
				rows.push(`  ? ${truncateForPrompt(segment.text)} (${reason})`);
			}
		}
		return ["Command:", ...rows];
	}

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "(missing)";
		if (typeof rawCommand === "string") {
			const compound = this.#formatCompoundApprovalDetails(command);
			if (compound) return compound;
		}
		return [`Command: ${truncateForPrompt(command)}`];
	};
	readonly label = "Bash";
	readonly loadMode = "essential";
	get description(): string {
		const evalBackends = resolveEvalBackends(this.session);
		const isToolActive = (name: string, fallback: boolean): boolean =>
			this.session.isToolActiveForPrompt?.(name) ?? fallback;
		return prompt.render(bashDescription, {
			asyncEnabled: cfgAsyncEnabled.get(this.session.settings),
			// The deadline an omitted `timeout` resolves to, after the `tools.maxTimeout` cap.
			defaultTimeoutSec: clampTimeout("bash", undefined, cfgToolsMaxTimeout.get(this.session.settings)),
			autoBackgroundEnabled: cfgBashAutoBackgroundEnabled.get(this.session.settings),
			autoBackgroundSeconds: cfgBashAutoBackgroundThresholdMs.get(this.session.settings) / 1000,
			hasAstGrep: isToolActive("ast_grep", cfgAstGrepEnabled.get(this.session.settings)),
			hasAstEdit: isToolActive("ast_edit", cfgAstEditEnabled.get(this.session.settings)),
			hasGrep: isToolActive("grep", cfgGrepEnabled.get(this.session.settings)),
			hasGlob: isToolActive("glob", cfgGlobEnabled.get(this.session.settings)),
			hasFind: isToolActive("find", isFindEnabled(this.session)),
			hasRead: isToolActive("read", true),
			// Frozen at the last prompt rebuild (managed sessions). SDK consumers
			// building a bare ToolSession lack the rebuild lifecycle, so fall back
			// to the derived form (skillful && skills) instead of dropping the hint.
			hasSkills:
				(this.session.skillHintVisible ??
					(cfgSkillful.get(this.session.settings) && (this.session.skills?.length ?? 0) > 0)) === true,
			hasLaunch: cfgLaunchEnabled.get(this.session.settings) === true && isToolActive("bash", true),
			hasPty: this.#ptyAvailable || this.#launchEnabled,
			hasEval: isToolActive("eval", evalBackends.python || evalBackends.js),
			// The embedded shell's session env is the shell config env (see bash-executor).
			builtins: shellBuiltins(this.session.settings.getShellConfig().env),
			isWindows: process.platform === "win32",
		});
	}
	/** Schema variant for the live `async.enabled` and `launch.enabled` settings and PTY availability. */
	get parameters(): BashToolSchema {
		const asyncEnabled = cfgAsyncEnabled.get(this.session.settings);
		if (
			cfgLaunchEnabled.get(this.session.settings) === true &&
			(this.session.isToolActiveForPrompt?.("bash") ?? true)
		)
			return asyncEnabled ? bashSchemaWithAsyncAndService : bashSchemaWithService;
		if (this.#ptyAvailable) return asyncEnabled ? bashSchemaWithAsync : bashSchemaBase;
		return asyncEnabled ? bashSchemaWithAsyncNoPty : bashSchemaBaseNoPty;
	}

	/** Whether `pty: true` can get a terminal: only an interactive UI hosts one. */
	get #ptyAvailable(): boolean {
		return this.session.hasUI && $env.PI_NO_PTY !== "1";
	}
	// Non-pty calls run alongside each other (the executor isolates overlapping
	// runs on the same shell session); pty takes over the terminal UI and must
	// run alone.
	readonly concurrency = (args: Partial<BashToolInput>): "shared" | "exclusive" =>
		args.pty === true ? "exclusive" : "shared";
	readonly strict = true;
	readonly #preparedExecutions = new WeakMap<
		object,
		{
			toolCallId: string;
			approved: boolean;
			inputFingerprint: string;
			execution: PreparedBashExecution;
			validate?: () => void;
		}
	>();

	constructor(private readonly session: ToolSession) {}

	/**
	 * URL filesystem for one embedded-shell run: this session's context, cancelled by the run's own
	 * signal. Without `onReply`/`onWrite` the run's writes to `out://` and other handler-written URLs
	 * are refused.
	 */
	#urlFilesystem(
		signal: AbortSignal | undefined,
		options: Omit<InternalUrlFilesystemOptions, "context">,
	): InternalUrlFilesystem {
		return new InternalUrlFilesystem({
			...options,
			context: sessionResolveContext(this.session, { signal }),
			// What the command's builtins and redirections write is journaled like an edit tool's write.
			onFileChange:
				this.session.recordFileChange &&
				(change => this.session.recordFileChange?.({ tool: "bash", ...shellChangeSnapshots(change) })),
		});
	}

	/**
	 * Session tool commands for one embedded shell run, or undefined when the session mounts none.
	 * The handler lives as long as the run: `signal` is the run's own, and every dispatch lands in
	 * `recorder`, after which `onChange` re-emits the run's frame.
	 */
	#shellCommands(
		names: readonly string[],
		options: {
			toolCallId: string;
			signal: AbortSignal | undefined;
			context: AgentToolContext | undefined;
			recorder: ToolCommandRecorder;
			onChange?: () => void;
		},
	): (ShellCommands & { abort(): void }) | undefined {
		if (names.length === 0) return undefined;
		const { recorder, onChange } = options;
		const handler = createToolCommandHandler({
			session: this.session,
			toolCallId: options.toolCallId,
			signal: options.signal,
			context: options.context,
			onDispatch: (dispatch, index) => {
				recorder.finish(dispatch, index);
				onChange?.();
			},
			onProgress: (dispatch, index) => {
				recorder.progress(dispatch, index);
				onChange?.();
			},
		});
		return { names: [...names], handler, abort: handler.abort };
	}

	/**
	 * Session identity for a command, read when its tool call starts, so
	 * `/fork`, `/new`, and `/resume` take effect on the next call while a call
	 * already under way keeps the session it began in. `PI_TOOL_CALL_ID` is the
	 * id this call runs under: the agent's call in the transcript, or the eval
	 * tool bridge's own id for a call made from an eval cell. Always
	 * set every key: an empty value replaces a stale one inherited from a parent
	 * omp process, since an env overlay cannot unset.
	 */
	#sessionEnv(toolCallId: string): Record<string, string> {
		return {
			PI_SESSION_ID: this.session.sessionManager?.getSessionId?.() ?? this.session.getSessionId?.() ?? "",
			PI_SESSION_FILE: this.session.getSessionFile() ?? "",
			PI_TOOL_CALL_ID: toolCallId,
		};
	}

	/**
	 * Where the session's persistent shell stands, read from a copy of it, for a shell process
	 * (a service, a pty command) to start from: `env` holds what it exports (PATH included), as a
	 * child of that shell would see in the host directory `cwd` (its direnv environment
	 * included), and `script` defines its functions and aliases. Shell bookkeeping variables
	 * stay with the process's own shell.
	 */
	async #sessionSeed(
		sessionId: string | undefined,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<{ env: Record<string, string>; script: string }> {
		const dumpPath = path.join(os.tmpdir(), `omp-shell-env-${crypto.randomUUID()}`);
		const scriptPath = `${dumpPath}.sh`;
		const quote = (file: string): string => `'${file.replaceAll("'", `'\\''`)}'`;
		try {
			const sessionKey = sessionId ?? "";
			const dump = `env -0 > ${quote(dumpPath)} && { shopt -p expand_aliases; declare -f; alias -p; } > ${quote(scriptPath)} 2>/dev/null`;
			const result = await executeBash(dump, {
				cwd,
				// The same shell options as the session's calls, so the copy is of that session's shell.
				sessionKey: `${sessionKey}:async:service-env:${crypto.randomUUID()}`,
				seedSessionKey: sessionKey,
				minimize: !nativeShapingOff(this.session),
				gitGuard: cfgBashGitGuard.get(this.session.settings),
				ovnfs: ovnfsCommand(this.session.settings),
				timeout: 10_000,
				signal,
			});
			if (result.exitCode !== 0) throw new Error(result.output || `env exited ${result.exitCode}`);
			const [dumped, script] = await Promise.all([Bun.file(dumpPath).text(), Bun.file(scriptPath).text()]);
			const env: Record<string, string> = {};
			for (const entry of dumped.split("\0")) {
				const eq = entry.indexOf("=");
				if (eq <= 0) continue;
				const key = entry.slice(0, eq);
				if (key === "PWD" || key === "OLDPWD" || key === "SHLVL" || key === "_") continue;
				env[key] = entry.slice(eq + 1);
			}
			return { env, script };
		} finally {
			await Promise.all([fs.promises.rm(dumpPath, { force: true }), fs.promises.rm(scriptPath, { force: true })]);
		}
	}

	/**
	 * Run `command` as a shell process on a pseudo-terminal the user drives: the session's shell
	 * (its exports, functions and aliases, and the host files `mounts` puts behind its URL paths)
	 * leading a terminal of its own, so its programs own that terminal.
	 */
	async #runOnTerminal(
		ui: Pick<NonNullable<AgentToolContext["ui"]>, "custom">,
		run: {
			command: string;
			/** Host directory the process starts in. */
			hostCwd: string;
			/** URL directory its shell enters first. */
			urlCwd: string | undefined;
			sessionId: string | undefined;
			sessionEnv: Record<string, string>;
			reviewedEnv: Record<string, string> | undefined;
			validate?: () => void;
			timeoutMs: number | undefined;
			signal: AbortSignal | undefined;
			/** `urlmap` commands for the session's URL paths ({@link shellMounts}). */
			mounts: string;
		},
	): Promise<BashInteractiveResult> {
		const seed = await this.#sessionSeed(run.sessionId, run.hostCwd, run.signal);
		const script = run.mounts + seed.script;
		const source = script ? path.join(os.tmpdir(), `omp-shell-seed-${crypto.randomUUID()}.sh`) : undefined;
		// Set from the pty's start callback; a holder keeps the type from narrowing to `undefined`.
		const board: { entry?: BoardEntry } = {};
		try {
			if (source !== undefined) await fs.promises.writeFile(source, script, { mode: 0o600 });
			return await runInteractiveBashPty(ui, {
				command: run.command,
				...shellProcessCommand({ command: run.command, source, cwd: run.urlCwd }),
				cwd: run.hostCwd,
				env: { ...seed.env, ...run.reviewedEnv, ...run.sessionEnv },
				timeoutMs: run.timeoutMs,
				signal: run.signal,
				validate: run.validate,
				allocateArtifact: this.session.allocateOutputArtifact,
				onStart: pid => {
					board.entry = registerOnBoard({
						kind: "external",
						scope: { kind: "session", id: run.sessionId || `process-${process.pid}` },
						key: `pty:${pid}`,
						label: `pty: ${ptyBoardCommand(run.command)}`,
						pid,
					});
				},
			});
		} finally {
			// Resolves only after the pty program exited.
			board.entry?.dispose();
			if (source !== undefined) await fs.promises.rm(source, { force: true });
		}
	}

	/** Service launch mode: live `launch.enabled` while `bash` itself is an active tool. */
	get #launchEnabled(): boolean {
		return cfgLaunchEnabled.get(this.session.settings) === true && (this.session.isToolActive?.("bash") ?? true);
	}

	#resolveExecutionBackend(input: BashToolInput, ctx?: AgentToolContext): PreparedBashBackend {
		if (input.name !== undefined) return { kind: "service", shellConfig: snapshotShellConfig(this.session.settings) };
		if (
			input.async === true ||
			invokedToolCommand(input.command, new Set(toolCommandNames(this.session))) !== undefined
		)
			return { kind: "local" };
		if (input.pty === true) {
			const ui = canUseInteractiveBashPty(true, ctx) ? ctx?.ui : undefined;
			return ui
				? { kind: "local-pty", ui, shellConfig: snapshotShellConfig(this.session.settings) }
				: { kind: "local" };
		}
		if (
			INTERNAL_BASH_URL_RE.test(input.command) ||
			input.command.includes("local:/") ||
			input.cwd?.includes("://") ||
			input.cwd?.startsWith("local:/")
		)
			return { kind: "local" };

		const bridge = this.session.getClientBridge?.();
		const createTerminal = bridge?.createTerminal;
		if (bridge?.capabilities.terminal && createTerminal) {
			return {
				kind: "client-terminal",
				bridge,
				createTerminal,
				shellConfig: snapshotShellConfig(this.session.settings),
			};
		}
		return { kind: "local" };
	}

	async #prepareExecution(
		input: BashToolInput,
		signal: AbortSignal | undefined,
		ctx: AgentToolContext | undefined,
		sessionEnv: Record<string, string>,
	): Promise<PreparedBashExecution> {
		const rawCommand = input.command;
		let command = rawCommand;
		let cwd = input.cwd;
		// Hoist only a literal cd. A failed semicolon cd must still run its remainder.
		let hoistedShellCwd = false;
		let cdSeparator: ";" | undefined;
		if (!cwd) {
			const cd = extractLeadingCdTarget(command);
			const virtualTarget = cd !== null && InternalUrlRouter.instance().canHandle(cd.path);
			const semicolonDirectory =
				cd?.separator === ";" &&
				!virtualTarget &&
				(await fs.promises.stat(resolveShellDirectory(cd.path, this.session.cwd)).catch(() => null))?.isDirectory();
			if (cd && (cd.separator === "&&" || semicolonDirectory === true)) {
				hoistedShellCwd = !virtualTarget;
				cwd = cd.path;
				command = cd.rest;
				if (cd.separator === ";") cdSeparator = ";";
			}
		}
		if (command.includes("local:/")) {
			command = command.replace(/(?<![A-Za-z0-9_./\\])local:\/(?!\/)/g, "local://");
		}
		if (cfgWorktreeClone.get(this.session.settings)) {
			command = rewriteGitWorktreeAdd(command, resolveCliEntryCmd());
		}
		if (input.name !== undefined) {
			if (!this.#launchEnabled) throw new ToolError("Service launch is disabled in this session.");
		}
		if (input.name === undefined && input.async === true && !cfgAsyncEnabled.get(this.session.settings)) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}

		const commands = new Set(toolCommandNames(this.session));
		const interception = this.#interception(rawCommand, command, input.name, ctx?.toolNames ?? [], commands);
		if (interception) throw new ToolError(interception);
		const invokedCommand = invokedToolCommand(command, commands);
		if (invokedCommand !== undefined && (input.pty === true || input.name !== undefined)) {
			throw new ToolError(`Session tool command '${invokedCommand}' requires an embedded foreground or async run.`);
		}

		const backend = this.#resolveExecutionBackend(input, ctx);
		const router = InternalUrlRouter.instance();
		const virtualCwd = cwd && router.canHandle(router.normalize(cwd)) ? router.normalize(cwd) : undefined;
		if (virtualCwd && backend.kind !== "local") {
			throw new ToolError(
				`Working directory ${virtualCwd} exists only in the embedded shell; external processes need a host directory.`,
			);
		}
		const commandCwd = virtualCwd ?? resolveCommandCwd(cwd, this.session.cwd, hoistedShellCwd);
		if (virtualCwd) {
			try {
				const stat = await this.#urlFilesystem(signal, { tier: "exec" }).stat(virtualCwd);
				if (stat.type !== "directory") throw new ToolError(`Working directory is not a directory: ${virtualCwd}`);
			} catch (error) {
				if (error instanceof UrlFsError && error.code === "ENOENT")
					throw new ToolError(`Working directory does not exist: ${virtualCwd}`);
				throw error;
			}
		} else {
			let stat: fs.Stats;
			try {
				stat = await fs.promises.stat(commandCwd);
			} catch (error) {
				if (isEnoent(error)) throw new ToolError(`Working directory does not exist: ${commandCwd}`);
				throw error;
			}
			if (!stat.isDirectory()) throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
		}
		const guardConfigured = isDestructiveCommandGuardConfigured();
		const hostCwd =
			virtualCwd && guardConfigured
				? await router.locate(virtualCwd, sessionResolveContext(this.session, { signal }), { directory: true })
				: null;
		if (virtualCwd && guardConfigured && hostCwd === null) {
			throw new ToolError(
				`Destructive Command Guard cannot verify a working directory without host backing: ${virtualCwd}`,
			);
		}
		const guardCwd = hostCwd ?? (virtualCwd ? this.session.cwd : commandCwd);
		if (backend.kind === "client-terminal" && INTERNAL_BASH_URL_RE.test(command)) {
			throw new ToolError(
				"Internal URL command paths require the embedded shell; external processes need host paths.",
			);
		}
		const preflight = await applyDirenvPreflight(command, commandCwd, {
			callerEnv: sessionEnv,
			signal,
			timeoutMs: cfgBashDirenvLoadTimeoutMs.get(this.session.settings),
			callerTimeoutMs: input.timeout && input.timeout > 0 ? input.timeout * 1000 : undefined,
			direnvSetting: virtualCwd ? "off" : cfgBashDirenv.get(this.session.settings),
			commandPrefix:
				backend.kind === "service"
					? backend.shellConfig.prefix
					: backend.kind === "local"
						? this.session.settings.getShellConfig().prefix
						: undefined,
		});
		if (backend.kind === "service") assertSafeServiceEnv(preflight.env);
		const dialect = dcgDialectForBackend(backend);
		const originalDecision = await enforceDestructiveCommandGuard(command, guardCwd, dialect, signal);
		const finalDecision =
			preflight.command === command
				? originalDecision
				: await enforceDestructiveCommandGuard(preflight.command, guardCwd, dialect, signal);
		if (
			originalDecision.decision === "ask" &&
			finalDecision.decision === "ask" &&
			(originalDecision.ruleId !== finalDecision.ruleId || originalDecision.reason !== finalDecision.reason)
		) {
			throw new ToolError(
				"Destructive Command Guard found different approvals before and after direnv; review the final command separately.",
			);
		}
		const dcgDecision = finalDecision.decision === "ask" ? finalDecision : originalDecision;
		return {
			command: preflight.command,
			commandCwd,
			guardCwd,
			cwdSelected: cwd !== undefined,
			cdSeparator,
			dcgDecision,
			backend,
			preflight,
		};
	}

	async prepareRuntimeApproval(
		toolCallId: string,
		args: unknown,
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<RuntimeToolApprovalRequest | undefined> {
		if (typeof args !== "object" || args === null) return undefined;
		const input = args as BashToolInput;
		const normalizedInput = normalizeBashInput(input);
		const execution = await this.#prepareExecution(normalizedInput, signal, context, this.#sessionEnv(toolCallId));
		this.#preparedExecutions.set(args, {
			toolCallId,
			approved: false,
			inputFingerprint: bashInputFingerprint(input),
			execution,
		});
		if (execution.dcgDecision.decision === "allow") return undefined;
		return formatDcgRuntimeApproval(normalizedInput, execution, execution.dcgDecision);
	}

	approveRuntimeApproval(toolCallId: string, args: unknown, validate?: () => void): void {
		if (typeof args !== "object" || args === null) return;
		const cached = this.#preparedExecutions.get(args);
		if (
			cached?.toolCallId !== toolCallId ||
			cached.inputFingerprint !== bashInputFingerprint(args as BashToolInput) ||
			cached.execution.dcgDecision.decision !== "ask"
		) {
			return;
		}
		validate?.();
		cached.validate = validate;
		cached.approved = true;
	}

	#formatResultOutput(result: BashResult | BashInteractiveResult): string {
		const outputText = normalizeResultOutput(result);
		if (!outputText) return result.exitCode === 0 ? "(no output, exit code 0)" : "(no output)";
		if (!result.columnDroppedBytes || !result.artifactId) return outputText;
		const footer = `[raw output: artifact://${result.artifactId}]`;
		return outputText.endsWith(footer) ? outputText : `${outputText}\n${footer}`;
	}

	/**
	 * Throw for outcomes that are *not* a completed command: user aborts and a
	 * missing exit status. Timeouts are handled separately by
	 * #buildCompletedResult, which returns a non-throwing error result with
	 * details.timedOut=true so the renderer can show a warning border. The
	 * foreground and bridge callers plus the async job manager rely on these
	 * throwing so cancellations surface as aborts and jobs are recorded as
	 * failed. A definite non-zero exit is a completed command that failed;
	 * #buildCompletedResult surfaces it as an error *result* (carrying
	 * execution details) rather than a throw.
	 */
	#throwIfUnfinished(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		outputText: string,
	): void {
		const captureNotice = result.artifactError ? `\n\n[${formatArtifactErrorNotice(result.artifactError)}]` : "";
		if (result.cancelled) {
			// Local executor output already carries a leading `[Command cancelled]`
			// notice from the sink; PTY/bridge output does not, so annotate only
			// the latter.
			const out = normalizeResultOutput(result);
			const annotated = out.startsWith("[Command cancelled]") ? out : out ? `${out}\n\n[Command aborted]` : out;
			throw new ToolError(`${annotated || "Command aborted"}${captureNotice}`);
		}
		if (result.timedOut === true) {
			const out = normalizeResultOutput(result);
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			throw new ToolError(`${out ? `${out}\n\n[${message}]` : message}${captureNotice}`);
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status${captureNotice}`);
		}
	}

	async #buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		options: {
			command: string;
			cwd: string;
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			wallTimeMs?: number;
			/** Text the run wrote to `out://`. */
			replies?: readonly string[];
			/** The call the result answers; shapes the output under the session's Spotlight experiment. */
			toolCallId?: string;
			/** Tool command dispatches of the run, in invocation order. */
			toolCommands?: readonly ToolCommandDispatch[];
		},
	): Promise<AgentToolResult<BashToolDetails>> {
		const completionContent = result.cancelled
			? options.toolCommands?.flatMap(dispatch => dispatch.completionContent ?? [])
			: undefined;
		const exitCode = result.exitCode;
		const failedExit = exitCode !== undefined && exitCode !== 0;

		const shaped =
			options.toolCallId === undefined
				? undefined
				: await this.#shapeOutput(result, options.toolCallId, options.command);
		const outputLines = [shaped?.text ?? this.#formatResultOutput(result)];
		const notices: string[] = [];
		const wallTimeMs = options.wallTimeMs;
		const wallTimeNoticeEmitted = wallTimeMs !== undefined && wallTimeMs >= WALL_TIME_NOTICE_MIN_MS;
		if (wallTimeNoticeEmitted) {
			notices.push(formatWallTimeNotice(wallTimeMs));
		}
		if (options.notices) {
			for (const notice of options.notices) {
				if (notice) notices.push(notice);
			}
		}
		const fork = "fork" in result ? result.fork : undefined;
		if (fork && !fork.carried) notices.push(FORK_STATE_LOST_NOTICE);
		if (fork?.jobs) notices.push(FORK_JOBS_NOTICE);
		if (notices.length > 0) outputLines.push("", ...notices);
		// Shaped output already leads with its exit status.
		if (failedExit && !shaped?.text?.startsWith("[exit code ")) outputLines.push("", formatExitCodeNotice(exitCode));
		const outputText = outputLines.join("\n");

		// Timeouts are not failures — the command ran its course. Return an error
		// result (isError=true for the model) but flag timedOut so the renderer
		// uses a warning border instead of error red. Both interactive and
		// non-interactive results carry an explicit `timedOut` field from the
		// executor/PTY layer.
		const isTimeout = result.timedOut === true;

		const details: BashToolDetails = { wallTimeNoticeEmitted };
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (wallTimeMs !== undefined) {
			details.wallTimeMs = wallTimeMs;
		}
		if (failedExit) {
			details.exitCode = exitCode;
		}
		if (options.replies?.length) details.replies = [...options.replies];
		if (options.toolCommands?.length) details.toolCommands = [...options.toolCommands];
		if (shaped?.spotlight) details.spotlight = shaped.spotlight;
		// Native history is bounded; retain it whole so persisted calls remain replayable.
		const trace = "trace" in result ? result.trace : undefined;
		if (trace) details.trace = trace;

		// Final-defense inline cap config, shared by the timeout and normal
		// completion paths. The sink already bounds inline bodies to the spill
		// threshold, so with the notice slack this only fires on paths that
		// bypass the sink (client-bridge terminals, minimizer misses). When the
		// sink spilled, its artifact already holds the full raw stream — reuse
		// that id instead of saving a second (already-truncated) copy, so the
		// `[raw output: local://N.log]` footer and the truncation notice agree.
		const inlineCap = {
			maxBytes: resolveInlineByteCapBudget(this.session.settings),
			saveArtifact: result.artifactError
				? undefined
				: (full: string) => result.artifactId ?? saveBashOriginalArtifact(this.session, full),
		};

		if (isTimeout) {
			details.timedOut = true;
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			// executeBash has already emitted this leading sink notice. PTY output has not, and output shaped from the
			// artifact never carries it, so provide the LLM-facing annotation exactly once in the text sent.
			const lead = outputLines[0];
			if (lead !== `[${message}]` && !lead.startsWith(`[${message}]\n`)) {
				outputLines.push("", `[${message}]`);
			}
			const timeoutOutputText = await enforceInlineByteCap(outputLines.join("\n"), inlineCap);
			const timeoutBuilder = toolResult(details).content([
				{ type: "text", text: timeoutOutputText },
				...(result.images ?? []),
				...(completionContent ?? []),
			]);
			if (!shaped?.whole) timeoutBuilder.truncationFromSummary(result, { direction: "tail" });
			return timeoutBuilder.error().done();
		}

		const completedAfterCancellation =
			result.cancelled && options.toolCommands?.some(dispatch => dispatch.completionContent !== undefined);
		if (!completedAfterCancellation) this.#throwIfUnfinished(result, timeoutSec, outputText);
		if (!result.cancelled) await invalidateGithubCacheForBashResult(options.command, options.cwd, result);

		// No-op for already-bounded output; see `inlineCap` above.
		const cappedOutputText = await enforceInlineByteCap(outputText, inlineCap);

		const resultBuilder = toolResult(details)
			.content([{ type: "text", text: cappedOutputText }, ...(result.images ?? []), ...(completionContent ?? [])])
			.minimized("minimized" in result ? result.minimized : undefined);
		// Output shaped from the whole spilled artifact no longer matches the sink's line ranges.
		if (!shaped?.whole) resultBuilder.truncationFromSummary(result, { direction: "tail" });
		if (failedExit || result.cancelled) resultBuilder.error();
		return resultBuilder.done();
	}

	/**
	 * The command's output under the session's Spotlight shaping, or undefined when the session does not shape: `text`
	 * when shaping changed it, and the trace for the result's details. A spilled output, or one whose long lines the sink
	 * cut to its column cap, is shaped whole from its artifact (`whole`), up to {@link SPOTLIGHT_FULL_OUTPUT_MAX_BYTES}:
	 * shaping a capped line would only cut the preview further, past anything the cap dropped. Its savings still count
	 * against the capped text `plain` shows, truncation notice included, and a cut longer than that is not applied,
	 * except a short one when the column cap cut `plain` (`plainWidthCut`): the cap's preview leaves the rest to a read
	 * of the artifact. A result shaping does not cut (kept, held out, capped) stays as the sink built it, as under `plain`.
	 */
	async #shapeOutput(
		result: BashResult | BashInteractiveResult,
		toolCallId: string,
		command: string,
	): Promise<{ text?: string; whole: boolean; spotlight?: SpotlightDetails } | undefined> {
		const experiment = shapingExperiment(this.session);
		if (!experiment?.shapesTool("bash")) return undefined;
		const built = this.#formatResultOutput(result);
		let text = built;
		let whole = false;
		const widthCut = (result.columnTruncatedLines ?? 0) > 0;
		if (
			(result.truncated || widthCut) &&
			result.artifactId &&
			!result.artifactElidedBytes &&
			!result.artifactError &&
			result.totalBytes <= SPOTLIGHT_FULL_OUTPUT_MAX_BYTES
		) {
			const full = await experiment.readArtifact(result.artifactId);
			if (full !== null) {
				text = full;
				whole = true;
			}
		}
		const shaped = await shapeToolText(this.session, toolCallId, {
			tool: "bash",
			text,
			plain: built + formatOutputNotice(outputMeta().truncationFromSummary(result, { direction: "tail" }).get()),
			plainWidthCut: whole && widthCut,
			artifact: whole && result.artifactId ? spillUrl(result.artifactId) : undefined,
			command,
			exitCode: result.exitCode,
			source: command,
		});
		// Kept, held-out or capped text: the result stays as the sink built it (and keeps its truncation notice).
		return shaped.text === text
			? { whole: false, spotlight: shaped.spotlight }
			: { text: shaped.text, whole, spotlight: shaped.spotlight };
	}

	#buildBackgroundStartResult(
		jobId: string,
		previewText: string,
		timeoutSec: number | undefined,
		options: {
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			replies?: readonly string[];
			trace?: ShellTrace;
			toolCommands?: readonly ToolCommandDispatch[];
		} = {},
	): AgentToolResult<BashToolDetails> {
		const details: BashToolDetails = {
			async: { state: "running", jobId, type: "bash" },
		};
		if (options.trace) details.trace = options.trace;
		if (options.replies?.length) details.replies = [...options.replies];
		if (options.toolCommands?.length) details.toolCommands = [...options.toolCommands];
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (options.notices?.length) {
			lines.push(...options.notices, "");
		}
		lines.push(formatBackgroundNotice(jobId, timeoutSec));
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}

	#extractTextResult(result: AgentToolResult<BashToolDetails>): string {
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		return text + formatOutputNotice(result.details?.meta);
	}

	#observeDeferredResult(job: ManagedBashJobHandle, onDeferredResult: AgentToolContext["onDeferredResult"]): void {
		if (!onDeferredResult) return;
		void job.completion
			.then(completion => {
				const result = completion.result;
				const state =
					completion.kind === "failed"
						? result.details?.async?.state === "cancelled"
							? "cancelled"
							: "failed"
						: result.isError === true
							? "failed"
							: "completed";
				onDeferredResult({
					...result,
					details: {
						...result.details,
						async: { state, jobId: job.jobId, type: "bash" },
					},
				});
			})
			.catch(error => {
				logger.warn("Deferred bash result observer failed", {
					jobId: job.jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	#startManagedBashJob(options: {
		command: string;
		commandCwd: string;
		preflight: PreparedBashExecution["preflight"];
		validate?: () => void;
		timeoutMs: number | undefined;
		timeoutSec: number | undefined;
		requestedTimeoutSec?: number;
		notices?: readonly string[];
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		/** A foreground wait races the job: updates stream to the caller and the row stays hidden until promoted. */
		foreground: boolean;
		/** Approval tier bounding the job's URL filesystem. */
		approvalTier: ToolTier;
		/** Session the call started in; its shell, even if the session changes before the job runs. */
		sessionId: string | undefined;
		widgetOwnerCurrent?: () => boolean;
		/** That session's identity for the command (see {@link BashTool.#sessionEnv}). */
		sessionEnv: Record<string, string>;
		/** The model's `i` intent on the call, for the job's widget author. */
		intent?: string;
		/** The call that started the job. */
		toolCallId: string;
		/** Output lines to report while the job runs; see {@link BashToolInput.notify}. */
		notify?: NotifyPattern;
		/** Session tool command names installed for the run ({@link toolCommandNames}). */
		toolCommands: readonly string[];
		/** Tool context the run's tool commands execute under. */
		context?: AgentToolContext;
		/** A tool command is about to ask the user for approval while the call still waits on the run. */
		onApprovalPrompt?: () => void;
	}): ManagedBashJobHandle {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command;
		// Holds the run's Shell only while it runs: a retained reference would
		// keep a finished `:async:` Shell (and its background children) alive.
		let pids: () => readonly number[] = NO_PIDS;
		// Outlives the run with the job row, so a finished pipeline stays readable.
		const streams = new PipeStreams();
		const producer =
			options.widgetOwnerCurrent &&
			this.session.captureWidgetProducer?.(options.widgetOwnerCurrent, options.sessionId, "bash");
		// The job's widget reads the command's own output and every pipe it opens.
		const outputTap = new TextTap("out", "the command's own stdout+stderr");
		const pipeSources = new PipeTextSources(streams);
		let latestText = "";
		// When the command last wrote its own output: the jobs sheet follows whichever source flows.
		let outputModified: number | undefined;
		let latestProgressDetails: BashProgressDetails | undefined;
		let backgrounded = !options.foreground;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();
		const notices = [...(options.notices ?? [])];
		const replies: string[] = [];
		const toolCommandRecorder = new ToolCommandRecorder();
		// The run's live trace; cleared once the result carries the final bounded snapshot.
		let liveTrace: ShellTrace | undefined;
		// While the call waits on the run, every frame of its card carries the replies so far and the
		// transcript draws the new ones. A backgrounded job's frames carry none: the call's result already did.
		// Every frame of a live run carries its latest trace and its tool command dispatches so far.
		const withReplies = (details: BashProgressDetails): BashProgressDetails => {
			const withTrace = liveTrace && details.trace === undefined ? { ...details, trace: liveTrace } : details;
			const withCommands = { ...withTrace, ...toolCommandRecorder.details() };
			return !backgrounded && replies.length > 0 ? { ...withCommands, replies: [...replies] } : withCommands;
		};
		// Replies reach the user only while the call waits on the run: once it returns, nothing draws them.
		const onReply = (text: string): void => {
			if (backgrounded) {
				throw new ToolError("out:// replies reach the user only while the command runs in the foreground.");
			}
			replies.push(text);
			options.onUpdate?.({
				content: [{ type: "text", text: latestText }],
				details: withReplies(latestProgressDetails ?? {}),
			});
		};
		// A prompt only promotes the run while the call still waits on it; once backgrounded it just waits for the user.
		const { onApprovalPrompt } = options;
		const toolContext =
			options.context && onApprovalPrompt
				? {
						...options.context,
						onApprovalPrompt: () => {
							if (!backgrounded) onApprovalPrompt();
						},
					}
				: options.context;

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				// Records the job's progress and shows it on the call's card: plain output
				// while the call still waits on it, the job frame (`details.async`) once
				// backgrounded, so the card keeps filling and settles with the job.
				const report = async (text: string, details: BashProgressDetails): Promise<void> => {
					latestText = text;
					const reported = reportProgress(text, { ...details });
					// `output` feeds job listings; the card already shows `text`.
					const { output: _output, images, ...frame } = details;
					const { async: _async, ...foregroundFrame } = frame;
					options.onUpdate?.({
						content: [{ type: "text", text }, ...(images ?? [])],
						details: withReplies(backgrounded ? frame : foregroundFrame),
					});
					await reported;
				};
				// `#execute` refused the call when this session has no notify channel.
				const notifier =
					options.notify && this.session.openAsyncNotify
						? new OutputNotifier(
								options.notify,
								outputTap,
								this.session.openAsyncNotify({
									id: jobId,
									type: "bash",
									command: options.command,
									pattern: options.notify.source,
									running: () => manager.getJob(jobId)?.status === "running",
								}),
							)
						: undefined;
				// A cancelled job reports nothing more, even while its command is still shutting down.
				if (notifier) runSignal.addEventListener("abort", () => notifier.stop(), { once: true });
				const wallTimeStart = performance.now();
				try {
					options.validate?.();
					const result = await executeBash(options.command, {
						settings: this.session.settings,
						cwd: options.commandCwd,
						env: options.sessionEnv,
						minimize: !nativeShapingOff(this.session),
						// A call that starts in the foreground runs in the session's
						// persistent shell, like the direct path, so its variables,
						// functions, and options reach the next call even after it is
						// backgrounded. A job that starts in the background gets its own
						// copy of the session's shell, so it sees what earlier calls set
						// but never holds the session's shell nor changes it.
						sessionKey: options.foreground ? options.sessionId : `${options.sessionId ?? ""}:async:${jobId}`,
						seedSessionKey: options.foreground ? undefined : (options.sessionId ?? ""),
						isSessionCurrent: () => (this.session.getSessionId?.() ?? undefined) === options.sessionId,
						timeout: options.timeoutMs ?? 0,
						signal: runSignal,
						preflight: options.preflight,
						validate: options.validate,
						gitGuard: cfgBashGitGuard.get(this.session.settings),
						ovnfs: ovnfsCommand(this.session.settings),
						// Bound to the job's own signal: the job outlives the call that started it.
						filesystem: this.#urlFilesystem(runSignal, {
							tier: options.approvalTier,
							onReply,
							onWrite: noticeUrlWrites(notices),
							toolCallId: options.toolCallId,
						}).shellFilesystem(),
						speech: sessionShellSpeech(this.session),
						commands: this.#shellCommands(options.toolCommands, {
							toolCallId: options.toolCallId,
							// The job's own signal: the run outlives a call that returned when it was backgrounded.
							signal: runSignal,
							context: toolContext,
							recorder: toolCommandRecorder,
							onChange: () => {
								void report(latestText, {
									output: latestText,
									async: { state: "running", jobId, type: "bash" },
								});
							},
						}),
						allocateArtifact: this.session.allocateOutputArtifact,
						onChunk: chunk => {
							outputModified = Date.now();
							outputTap.append(chunk);
							notifier?.poll();
						},
						onPreview: text => {
							void report(text, { output: text, async: { state: "running", jobId, type: "bash" } });
						},
						onTrace: cfgDisplayShellVisualization.get(this.session.settings)
							? trace => {
									liveTrace = trace;
									void report(latestText, {
										output: latestText,
										async: { state: "running", jobId, type: "bash" },
									});
								}
							: undefined,
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
						streams,
						onStart: probe => {
							pids = probe;
						},
					}).finally(() => {
						pids = NO_PIDS;
						liveTrace = undefined;
						outputTap.close();
						// The result that follows carries the job's last output, matches included.
						notifier?.stop();
					});
					if (result.artifactError) latestProgressDetails = { meta: { artifactError: result.artifactError } };
					const wallTimeMs = performance.now() - wallTimeStart;
					const finalResult = await this.#buildCompletedResult(result, options.timeoutSec, {
						command: options.command,
						cwd: options.commandCwd,
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices,
						wallTimeMs,
						replies: backgrounded ? undefined : replies,
						toolCallId: options.toolCallId,
						toolCommands: toolCommandRecorder.list(),
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					const images = finalResult.content.filter((block): block is ImageContent => block.type === "image");
					latestProgressDetails = {
						...finalResult.details,
						...(images.length > 0 ? { images } : {}),
					};
					// Hand the detailed result to the foreground auto-background
					// waiter (which renders it, footer included) before deciding
					// the job's terminal state.
					completion.resolve({ kind: "completed", result: finalResult });
					if (finalResult.isError === true) {
						// A non-zero exit is a completed command that failed. Re-enter
						// the failure path so the job manager records it as failed and
						// delivers the error text, matching prior throw-based behavior.
						throw new ToolError(finalText);
					}
					await report(finalText, {
						...latestProgressDetails,
						async: { state: "completed", jobId, type: "bash" },
					});
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const output = latestText && !message.includes(latestText) ? `${latestText}\n\n${message}` : message;
					const { output: _output, images, ...details } = latestProgressDetails ?? {};
					completion.resolve({
						kind: "failed",
						error,
						result: {
							content: [{ type: "text", text: output }, ...(images ?? [])],
							details: {
								...details,
								async: { state: runSignal.aborted ? "cancelled" : "failed", jobId, type: "bash" },
							},
							isError: true,
						},
					});
					// Only a cancel aborts the job's own signal (deadlines end in a timed-out result).
					await report(output, {
						...latestProgressDetails,
						async: { state: runSignal.aborted ? "cancelled" : "failed", jobId, type: "bash" },
					});
					throw error;
				} finally {
					pids = NO_PIDS;
					outputTap.close();
					producer?.revoke();
				}
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				foreground: options.foreground,
				process: {
					command: options.command,
					cwd: options.commandCwd,
					pids: () => pids(),
					streams,
					outputModified: () => outputModified,
					trace: () => liveTrace ?? latestProgressDetails?.trace,
				},
				intent: options.intent,
				widgetInputs: {
					producer,
					canAuthor: () =>
						options.widgetOwnerCurrent?.() === true &&
						(this.session.getSessionId?.() ?? undefined) === options.sessionId &&
						manager.getJob(jobId)?.process?.streams === streams,
					sources: () => [outputTap, ...pipeSources.list()],
					brief: () => ({
						kind: "bash",
						command: options.command,
						timeoutSec: options.timeoutSec,
						intent: options.intent,
					}),
				},
			},
		);

		return {
			jobId,
			completion: completion.promise,
			getLatestText: () => latestText,
			getLatestTrace: () => liveTrace ?? latestProgressDetails?.trace,
			notices,
			background: () => {
				backgrounded = true;
			},
			replies,
			toolCommands: () => toolCommandRecorder.list(),
		};
	}

	async execute(
		toolCallId: string,
		input: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		// The directory the command actually ran in, set once resolved. A hoisted
		// `cd <dir>; …` runs only the remainder, so renderers drawing the executed
		// script read the directory from here instead of re-parsing the command.
		const ran: { cwd?: string; cdSeparator?: ";" } = {};
		const stamp = (details: BashToolDetails | undefined): BashToolDetails | undefined =>
			ran.cwd === undefined
				? details
				: { ...details, cwd: ran.cwd, ...(ran.cdSeparator ? { cdSeparator: ran.cdSeparator } : {}) };
		const result = await this.#execute(
			toolCallId,
			input,
			ran,
			signal,
			onUpdate && (update => onUpdate({ ...update, details: stamp(update.details) })),
			ctx,
		);
		return { ...result, details: stamp(result.details) };
	}

	async #execute(
		toolCallId: string,
		input: BashToolInput,
		ran: { cwd?: string; cdSeparator?: ";" },
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		const sessionId = this.session.getSessionId?.() ?? undefined;
		const sessionEnv = this.#sessionEnv(toolCallId);
		const widgetOwnerCurrent = this.session.captureWidgetOwnerCurrent?.();
		const normalizedInput = normalizeBashInput(input);
		const cached = this.#preparedExecutions.get(input);
		if (cached) this.#preparedExecutions.delete(input);
		const cacheMatches = cached?.toolCallId === toolCallId && cached.inputFingerprint === bashInputFingerprint(input);
		const runtimeApproved = cacheMatches === true && cached.approved;
		const validateApproval = runtimeApproved ? cached.validate : undefined;
		validateApproval?.();
		let prepared = cacheMatches
			? cached.execution
			: await this.#prepareExecution(normalizedInput, signal, ctx, sessionEnv);
		if (cacheMatches) {
			if (!sameBashBackend(prepared.backend, this.#resolveExecutionBackend(normalizedInput, ctx))) {
				throw new ToolError("Bash execution route or shell changed after safety review; review the command again.");
			}
			const materialized = await this.#prepareExecution(normalizedInput, signal, ctx, sessionEnv);
			validateApproval?.();
			if (!sameBashBackend(prepared.backend, materialized.backend)) {
				throw new ToolError("Bash execution route or shell changed after safety review; review the command again.");
			}
			if (
				materialized.command !== prepared.command ||
				materialized.commandCwd !== prepared.commandCwd ||
				materialized.guardCwd !== prepared.guardCwd
			) {
				throw new ToolError(
					"Bash command or working directory changed after safety review; review the command again.",
				);
			}
			if (JSON.stringify(materialized.preflight.env) !== JSON.stringify(prepared.preflight.env)) {
				throw new ToolError("Bash environment changed after safety review; review the command again.");
			}
			if (
				runtimeApproved &&
				(materialized.dcgDecision.decision !== "ask" ||
					prepared.dcgDecision.decision !== "ask" ||
					materialized.dcgDecision.ruleId !== prepared.dcgDecision.ruleId ||
					materialized.dcgDecision.reason !== prepared.dcgDecision.reason)
			) {
				throw new ToolError("Destructive Command Guard decision changed after approval; review the command again.");
			}
			prepared = materialized;
		}
		if (prepared.dcgDecision.decision === "ask" && !runtimeApproved) {
			const rule = prepared.dcgDecision.ruleId ? ` (${prepared.dcgDecision.ruleId})` : "";
			throw new ToolError(
				`Command requires interactive approval by Destructive Command Guard${rule}: ${prepared.dcgDecision.reason}`,
			);
		}

		const { command, commandCwd, backend } = prepared;
		if (prepared.cwdSelected) ran.cwd = commandCwd;
		if (prepared.cdSeparator) ran.cdSeparator = prepared.cdSeparator;
		const pendingNotices: string[] = [];
		const ignoredReady = normalizeReady(input.ready);
		if (normalizedInput.name !== undefined) {
			if (input.timeout != null)
				pendingNotices.push("Ignored timeout: service-only; readiness follows ready.timeout.");
			if (input.async === true)
				pendingNotices.push("Ignored async: service-only; a service start is asynchronous already.");
		} else if (ignoredReady !== undefined && (ignoredReady.log !== undefined || ignoredReady.port !== undefined)) {
			pendingNotices.push("Ignored ready: service-only, and no service name was given.");
		}
		const approval = this.approval(input, ctx);
		if (typeof approval !== "string" && approval.policy === "deny") {
			throw new ToolError(approval.reason ?? "Bash execution is denied.");
		}
		const approvalTier = typeof approval === "string" ? approval : approval.tier;
		const asyncRequested = normalizedInput.async === true;
		const pty = normalizedInput.pty ?? false;
		const requestedTimeoutSec = normalizedInput.timeout ?? 300;
		const name = normalizedInput.name;
		const notifySource = blankToUndefined(normalizedInput.notify);
		if (
			notifySource !== undefined &&
			!(name === undefined ? this.session.openAsyncNotify : this.session.queueServiceNotify)
		) {
			throw new ToolError("notify is unavailable in this session.");
		}
		const notify = name === undefined && notifySource !== undefined ? compileNotifyPattern(notifySource) : undefined;
		const notifyNotice =
			notifySource === undefined
				? undefined
				: `Output lines matching /${notifySource}/ arrive as follow-ups while it runs.`;
		const toolCommandNameList = toolCommandNames(this.session);
		const shellPatch = applyPatchShellInput(command);
		if (shellPatch !== undefined && !$which("apply_patch")) {
			const applyPatch = this.session.getToolForEvalBridge?.("apply_patch");
			if (applyPatch?.customWireName === "apply_patch") {
				if (shellPatch === null) throw new ToolError("apply_patch requires the patch text.");
				const patched = await applyPatch.execute(toolCallId, { input: shellPatch }, signal, undefined, ctx);
				return { content: patched.content, isError: patched.isError, details: {} };
			}
		}

		// Best-effort cache invalidation: drop github-cache rows for any issue/PR
		// number touched by a mutating `gh` subcommand inside this bash call so
		// subsequent issue:// / pr:// reads pick up the post-mutation state
		// instead of the cached pre-mutation snapshot.
		invalidateGithubCacheForBashCommand(command);

		if (name !== undefined) {
			if (backend.kind !== "service") throw new ToolError("Bash execution route changed after safety review.");
			const seed = await this.#sessionSeed(sessionId, commandCwd, signal);
			const service = await startService(
				this.session,
				{
					name,
					command,
					cwd: commandCwd,
					pty: normalizedInput.pty,
					env: { ...seed.env, ...prepared.preflight.env, ...sessionEnv },
					ready: normalizedInput.ready,
					shell: { ...backend.shellConfig, prefix: undefined },
					validate: validateApproval,
					notify: notifySource,
					seed: (await shellMounts(sessionResolveContext(this.session), approvalTier)) + seed.script,
				},
				signal,
				normalizedInput.ready === undefined ? undefined : ctx?.toolCall?.steeringSignal,
			);
			const daemon = service.daemon;
			const pid = daemon.pids[0];
			const notifyLine = service.notifyArmed ? notifyNotice : undefined;
			if (service.readyInterrupted) {
				// A queued message arrived mid-wait: return so it injects promptly.
				// The daemon keeps starting the service, inspectable via proc://.
				return {
					content: [
						{
							type: "text",
							text: `${name}: starting${pid === undefined ? "" : ` pid=${pid}`}\nReadiness wait interrupted early to handle an incoming message; the service is still starting and keeps running. Read proc://${name} for status.${notifyLine ? `\n${notifyLine}` : ""}`,
						},
					],
					details: { service: { name, state: daemon.state, ready: false, timedOut: false, pid } },
				};
			}
			const lines = [
				`${daemon.key}: ${daemon.state}${pid === undefined ? "" : ` pid=${pid}`}${daemon.readyAt === undefined ? "" : " ready"}`,
			];
			if (service.readyTimedOut)
				lines.push(
					`NOT ready — readiness timed out after ${normalizedInput.ready?.timeout ?? 30}s; process state: ${daemon.state}.`,
				);
			if (daemon.exitReason) lines.push(`Reason: ${daemon.exitReason}`);
			lines.push(...pendingNotices);
			if (notifyLine) lines.push(notifyLine);
			const log = await serviceLogs(this.session, name, signal);
			if (log) lines.push(log);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					service: {
						name,
						state: daemon.state,
						ready: daemon.readyAt !== undefined || daemon.state === "running",
						timedOut: service.readyTimedOut,
						pid,
					},
				},
			};
		}

		// A timeout of 0 is an explicit long-running-command contract: the user
		// must still cancel the call or job, but OMP does not impose a deadline.
		const timeoutDisabled = requestedTimeoutSec === 0;
		const maxTimeout = cfgToolsMaxTimeout.get(this.session.settings);
		const timeoutSec = timeoutDisabled ? undefined : clampTimeout("bash", requestedTimeoutSec, maxTimeout);
		const timeoutMs = timeoutSec === undefined ? undefined : timeoutSec * 1000;
		if (timeoutSec !== undefined) {
			const timeoutClampNotice = formatTimeoutClampNotice(requestedTimeoutSec, timeoutSec, maxTimeout);
			if (timeoutClampNotice) pendingNotices.push(timeoutClampNotice);
		}

		if (asyncRequested) {
			if (!this.session.asyncJobManager) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				preflight: prepared.preflight,
				validate: validateApproval,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,
				onUpdate,
				foreground: false,
				approvalTier,
				sessionId,
				widgetOwnerCurrent,
				sessionEnv,
				intent: this.session.getToolCallIntent?.(toolCallId),
				toolCallId,
				notify,
				toolCommands: toolCommandNameList,
				context: ctx,
			});
			this.#observeDeferredResult(job, ctx?.onDeferredResult);
			return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
				requestedTimeoutSec,
				notices: notifyNotice ? [...pendingNotices, notifyNotice] : pendingNotices,
				trace: job.getLatestTrace(),
			});
		}

		// The client-bridge terminal provides a live terminal card in the editor;
		// when available it wins over auto-backgrounding (both are opt-in, and
		// auto-background would otherwise silently disable the terminal route).
		const bridgeTerminalAvailable = backend.kind === "client-terminal";

		const autoBgManager = this.session.asyncJobManager;
		// At the running-job cap, fall through to direct foreground execution
		// instead of failing every bash call until a slot frees up.
		// Native tool commands retain this invocation's approval and cleanup ownership.
		if (
			cfgBashAutoBackgroundEnabled.get(this.session.settings) &&
			!pty &&
			!bridgeTerminalAvailable &&
			invokedToolCommand(command, new Set(toolCommandNameList)) === undefined &&
			autoBgManager &&
			!autoBgManager.atCapacity
		) {
			const autoBackgroundWaitMs = resolveAutoBackgroundWaitMs(
				Math.floor(cfgBashAutoBackgroundThresholdMs.get(this.session.settings)),
				timeoutMs,
			);
			const startBackgrounded = autoBackgroundWaitMs === 0;
			// A tool command about to ask the user promotes the run to the background at once.
			const approvalPrompt = Promise.withResolvers<{ kind: "approval" }>();
			const job = this.#startManagedBashJob({
				command,
				preflight: prepared.preflight,
				validate: validateApproval,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,
				onUpdate,
				foreground: !startBackgrounded,
				approvalTier,
				sessionId,
				widgetOwnerCurrent,
				sessionEnv,
				intent: this.session.getToolCallIntent?.(toolCallId),
				toolCallId,
				toolCommands: toolCommandNameList,
				context: ctx,
				onApprovalPrompt: () => approvalPrompt.resolve({ kind: "approval" }),
			});
			if (startBackgrounded) {
				this.#observeDeferredResult(job, ctx?.onDeferredResult);
				return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
					trace: job.getLatestTrace(),
					toolCommands: job.toolCommands(),
				});
			}
			// The job was registered as foreground-backed: hidden from listings and
			// delivery-suppressed until backgroundJob() promotes it, so a command
			// finishing within the wait never surfaces as a background job.
			const waitResult = await raceJobSettlement(
				Promise.race([job.completion, approvalPrompt.promise]),
				autoBackgroundWaitMs,
				signal,
				ctx?.toolCall?.steeringSignal,
			);
			if (waitResult.kind === "completed") {
				autoBgManager.releaseForegroundJob(job.jobId);
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				autoBgManager.releaseForegroundJob(job.jobId);
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
				autoBgManager.releaseForegroundJob(job.jobId);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.background();
			autoBgManager.backgroundJob(job.jobId);
			this.#observeDeferredResult(job, ctx?.onDeferredResult);
			// "steer": a queued user/peer message arrived mid-wait — background
			// the command (it keeps running) so the message injects promptly.
			// "approval": a tool command is asking the user; the prompt stays open while the job runs on.
			// `job.notices` also carries the notices the run added so far.
			const notices =
				waitResult.kind === "steer"
					? [...job.notices, "Backgrounded early to handle an incoming message; the command keeps running."]
					: waitResult.kind === "approval"
						? [
								...job.notices,
								"Backgrounded while a tool command waits for the user's approval; the command keeps running.",
							]
						: job.notices;
			return this.#buildBackgroundStartResult(job.jobId, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices,
				replies: job.replies,
				trace: job.getLatestTrace(),
				toolCommands: job.toolCommands(),
			});
		}

		// Route through the exact client terminal selected during safety review.
		if (backend.kind === "client-terminal") {
			// Invariant (ACP terminal bridge): createTerminal has no signal in its
			// contract; allocation cannot be cancelled retroactively. Guard before
			// allocation. Shared timeout helper / pure AbortSignal fusion rejected:
			// we need explicit kill-before-read ordering and distinct abort vs
			// timeout result shapes. Per-route race retained for testability.
			if (signal?.aborted) {
				throw new ToolAbortError("Command aborted");
			}

			const bridgeWallTimeStart = performance.now();
			const bridgeGraphics = new TerminalSnapshotDecoder();
			const killGraceMs = 1000;
			const outputSnapshotGraceMs = 2000;
			// Cancellable timeout: a bare Bun.sleep(timeoutMs) would leave a live,
			// ref'd timer for the full command timeout after fast completions —
			// accumulating timers and delaying process shutdown in SDK/headless use.
			// `timeoutMs` is optional (#4642): without one, no timer is armed and
			// the promise simply never resolves.
			const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<{
				kind: "timeout";
			}>();
			const timeoutTimer = timeoutMs ? setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs) : undefined;
			const { promise: abortedP, resolve: resolveAborted } = Promise.withResolvers<void>();
			let handle: ClientBridgeTerminalHandle | undefined;
			let killStarted = false;
			const fireKill = (): Promise<void> => {
				if (killStarted) return Promise.resolve();
				const currentHandle = handle;
				if (!currentHandle) return Promise.resolve();
				killStarted = true;
				return currentHandle.kill().catch((error: unknown) => {
					logger.warn("ACP terminal kill failed", { terminalId: currentHandle.terminalId, error });
				});
			};
			const cleanupLateCreate = (createP: Promise<ClientBridgeTerminalHandle>): void => {
				void createP
					.then(async lateHandle => {
						try {
							await lateHandle.kill();
						} catch (error) {
							logger.warn("ACP terminal kill failed", { terminalId: lateHandle.terminalId, error });
						}
						try {
							await lateHandle.release();
						} catch (error) {
							logger.warn("ACP terminal release failed", { terminalId: lateHandle.terminalId, error });
						}
					})
					.catch((error: unknown) => {
						logger.warn("ACP terminal create failed after cancellation", { error });
					});
			};
			const onAbortSignal = () => {
				resolveAborted();
				void fireKill();
			};
			signal?.addEventListener("abort", onAbortSignal, { once: true });

			try {
				const bridgeEnv = { ...prepared.preflight.env, ...sessionEnv };
				const shellSpawn = wrapShellLineForClientTerminal(command, backend.shellConfig);
				validateApproval?.();
				const createP = backend.createTerminal.call(backend.bridge, {
					command: shellSpawn.command,
					args: shellSpawn.args,
					cwd: commandCwd,
					env: bridgeEnv
						? Object.entries(bridgeEnv).map(([name, value]) => ({ name, value: value as string }))
						: undefined,
					outputByteLimit: DEFAULT_MAX_BYTES,
				});
				const createRaced = await Promise.race([
					createP.then(createdHandle => ({ kind: "created" as const, handle: createdHandle })),
					timeoutPromise,
					abortedP.then(() => ({ kind: "aborted" as const })),
				]);
				if (createRaced.kind === "aborted" || signal?.aborted) {
					cleanupLateCreate(createP);
					throw new ToolAbortError("Command aborted");
				}
				if (createRaced.kind === "timeout") {
					cleanupLateCreate(createP);
					const timedOutResult: BashInteractiveResult = {
						output: "",
						exitCode: undefined,
						cancelled: false,
						timedOut: true,
						truncated: false,
						totalLines: 0,
						totalBytes: 0,
						outputLines: 0,
						outputBytes: 0,
					};
					return this.#buildCompletedResult(timedOutResult, timeoutSec, {
						command,
						cwd: commandCwd,
						requestedTimeoutSec,
						notices: pendingNotices,
						wallTimeMs: performance.now() - bridgeWallTimeStart,
						toolCallId,
					});
				}

				handle = createRaced.handle;

				// Emit partial update so the editor can embed the live terminal card.
				onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

				// Exit, timeout, and abort are each subscribed once and latch the first
				// outcome. Every wait below races only a fresh per-iteration promise, so
				// a long command does not pile reactions onto promises that stay pending.
				type BridgeOutcome =
					| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
					| { kind: "timeout" }
					| { kind: "aborted" }
					| { kind: "failed"; error: unknown };
				// Held on an object: TypeScript would narrow a closure-assigned `let` to `undefined`.
				const bridge: { outcome?: BridgeOutcome; wake?: () => void } = {};
				const settle = (next: BridgeOutcome): void => {
					bridge.outcome ??= next;
					bridge.wake?.();
				};
				void handle.waitForExit().then(
					status => settle({ kind: "exit", status }),
					(error: unknown) => settle({ kind: "failed", error }),
				);
				void timeoutPromise.then(settle);
				void abortedP.then(() => settle({ kind: "aborted" }));
				let exitStatus!: ClientBridgeTerminalExitStatus;
				let lastPolledOutput: ClientBridgeTerminalOutput = { output: "", truncated: false };

				// Poll until the process exits, times out, or the caller aborts.
				for (;;) {
					if (!bridge.outcome) {
						// The sleep settles within one tick even when an outcome wakes us first.
						const tick = Promise.withResolvers<void>();
						bridge.wake = tick.resolve;
						void Bun.sleep(250).then(tick.resolve);
						await tick.promise;
					}
					const outcome = bridge.outcome;

					if (outcome?.kind === "failed") throw outcome.error;

					if (outcome?.kind === "aborted" || signal?.aborted) {
						await Promise.race([fireKill(), Bun.sleep(killGraceMs)]);
						throw new ToolAbortError("Command aborted");
					}

					if (outcome?.kind === "timeout") {
						// Kill before reading final output so a slow `terminal/output`
						// RPC cannot let a timed-out command keep running past the
						// enforced timeout. The handle stays valid post-kill so the
						// buffered output is still readable.
						await Promise.race([fireKill(), Bun.sleep(killGraceMs)]);
						let current = lastPolledOutput;
						try {
							current = await Promise.race([
								handle.currentOutput(),
								Bun.sleep(outputSnapshotGraceMs).then(() => lastPolledOutput),
							]);
						} catch (error) {
							logger.warn("ACP terminal final output read failed", {
								terminalId: handle.terminalId,
								error,
							});
						}
						const decoded = await bridgeGraphics.finish(current.output);
						const timedOutText = await appendImageLinks(decoded.text, decoded.images);
						const timedOutResult: BashInteractiveResult = {
							output: timedOutText,
							exitCode: undefined,
							cancelled: false,
							timedOut: true,
							truncated: current.truncated,
							totalLines: timedOutText.length > 0 ? timedOutText.split("\n").length : 0,
							totalBytes: timedOutText.length,
							outputLines: timedOutText.length > 0 ? timedOutText.split("\n").length : 0,
							outputBytes: timedOutText.length,
							...(decoded.images.length > 0 ? { images: decoded.images } : {}),
						};
						return this.#buildCompletedResult(timedOutResult, timeoutSec, {
							command,
							cwd: commandCwd,
							requestedTimeoutSec,
							notices: pendingNotices,
							wallTimeMs: performance.now() - bridgeWallTimeStart,
							toolCallId,
						});
					}

					if (outcome?.kind === "exit") {
						exitStatus = outcome.status;
						break;
					}

					// Poll tick: push current output so agent-loop transcript stays consistent.
					// Race the read against the outcomes so a stuck `terminal/output` RPC does
					// not delay cancellation or let the command outlive its deadline.
					const interrupted = Promise.withResolvers<undefined>();
					bridge.wake = () => interrupted.resolve(undefined);
					const pollOutput = await Promise.race([handle.currentOutput(), interrupted.promise]);
					if (pollOutput === undefined) {
						// An outcome landed during the poll-tick read; let the next loop
						// iteration exit via the matching branch.
						continue;
					}
					lastPolledOutput = pollOutput;
					onUpdate?.({
						content: [{ type: "text", text: bridgeGraphics.push(pollOutput.output) }],
						details: { terminalId: handle.terminalId },
					});
				}

				// Fetch final output; the terminal is released in the outer finally.
				let finalOutput = lastPolledOutput;
				try {
					finalOutput = await Promise.race([
						handle.currentOutput(),
						Bun.sleep(outputSnapshotGraceMs).then(() => lastPolledOutput),
					]);
				} catch (error) {
					logger.warn("ACP terminal final output read failed", {
						terminalId: handle.terminalId,
						error,
					});
				}

				// Map exit status: null exitCode with a signal → treat as signal kill (137).
				const rawExitCode = exitStatus.exitCode;
				const exitCode: number | undefined =
					rawExitCode != null ? rawExitCode : exitStatus.signal ? 137 : undefined;

				const decoded = await bridgeGraphics.finish(finalOutput.output);
				const outputText = await appendImageLinks(decoded.text, decoded.images);
				const outputByteLen = outputText.length;
				const outputLineCount = outputText.length > 0 ? outputText.split("\n").length : 0;

				const bridgeResult: BashResult = {
					output: outputText,
					exitCode,
					cancelled: false,
					truncated: finalOutput.truncated,
					totalLines: outputLineCount,
					totalBytes: outputByteLen,
					outputLines: outputLineCount,
					outputBytes: outputByteLen,
					...(decoded.images.length > 0 ? { images: decoded.images } : {}),
				};

				const bridgeNotices: string[] = [];
				if (finalOutput.truncated) bridgeNotices.push("(output truncated)");
				for (const notice of pendingNotices) bridgeNotices.push(notice);

				return this.#buildCompletedResult(bridgeResult, timeoutSec, {
					command,
					cwd: commandCwd,
					requestedTimeoutSec,
					notices: bridgeNotices,
					wallTimeMs: performance.now() - bridgeWallTimeStart,
					toolCallId,
				});
			} finally {
				clearTimeout(timeoutTimer);
				signal?.removeEventListener("abort", onAbortSignal);
				if (handle) {
					const releaseHandle = handle;
					// Bound release like kill/output: a hung `terminal/release` RPC must not
					// keep the tool pending after the result is already decided.
					await Promise.race([
						releaseHandle.release().catch((error: unknown) => {
							logger.warn("ACP terminal release failed", { terminalId: releaseHandle.terminalId, error });
						}),
						Bun.sleep(killGraceMs),
					]);
				}
			}
		}

		validateApproval?.();

		if (pty && backend.kind !== "local-pty") {
			pendingNotices.push("pty requested but unavailable in this environment; ran without a terminal");
		}
		const wallTimeStart = performance.now();
		const replies: string[] = [];
		const toolCommandRecorder = new ToolCommandRecorder();
		let preview = "";
		let trace: ShellTrace | undefined;
		const emitFrame = onUpdate
			? () =>
					onUpdate({
						content: [{ type: "text", text: preview }],
						details: {
							...(replies.length > 0 ? { replies: [...replies] } : {}),
							...(trace ? { trace } : {}),
							...toolCommandRecorder.details(),
						},
					})
			: undefined;
		const result: BashResult | BashInteractiveResult =
			backend.kind === "local-pty"
				? await this.#runOnTerminal(backend.ui, {
						command,
						hostCwd: commandCwd,
						urlCwd: undefined,
						sessionId,
						sessionEnv,
						reviewedEnv: prepared.preflight.env,
						validate: validateApproval,
						timeoutMs,
						signal,
						mounts: await shellMounts(sessionResolveContext(this.session, { signal }), approvalTier),
					})
				: await executeBash(command, {
						settings: this.session.settings,
						cwd: commandCwd,
						env: sessionEnv,
						sessionKey: sessionId,
						minimize: !nativeShapingOff(this.session),
						isSessionCurrent: () => (this.session.getSessionId?.() ?? undefined) === sessionId,
						timeout: timeoutMs ?? 0,
						signal,
						preflight: prepared.preflight,
						validate: validateApproval,
						gitGuard: cfgBashGitGuard.get(this.session.settings),
						ovnfs: ovnfsCommand(this.session.settings),
						filesystem: this.#urlFilesystem(signal, {
							tier: approvalTier,
							onReply: text => {
								replies.push(text);
								emitFrame?.();
							},
							onWrite: noticeUrlWrites(pendingNotices),
							toolCallId,
						}).shellFilesystem(),
						speech: sessionShellSpeech(this.session),
						commands: this.#shellCommands(toolCommandNameList, {
							toolCallId,
							signal,
							context: ctx,
							recorder: toolCommandRecorder,
							onChange: emitFrame,
						}),
						allocateArtifact: this.session.allocateOutputArtifact,
						onPreview: emitFrame
							? text => {
									preview = text;
									emitFrame();
								}
							: undefined,
						onTrace:
							emitFrame && cfgDisplayShellVisualization.get(this.session.settings)
								? next => {
										trace = next;
										emitFrame();
									}
								: undefined,
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
					});
		const wallTimeMs = performance.now() - wallTimeStart;
		const toolCommands = toolCommandRecorder.list();
		if (result.cancelled) {
			// A cancelled result is either a timeout (the command's deadline fired)
			// or a user/system abort. Timeouts are handled by #buildCompletedResult
			// which returns a non-throwing error result with details.timedOut=true
			// so the renderer can show a warning border instead of error red.
			// Both interactive and non-interactive results carry an explicit
			// `timedOut` field from the executor/PTY layer.
			const isTimeout = result.timedOut === true;
			if (!isTimeout && !toolCommands.some(dispatch => dispatch.completionContent !== undefined)) {
				const out = normalizeResultOutput(result);
				// The local executor already prepends `[Command cancelled]`; PTY
				// output does not, so preserve one cancellation notice in either case.
				let message = out.startsWith("[Command cancelled]")
					? out
					: out
						? `${out}\n\n[Command aborted]`
						: "Command aborted";
				if (result.artifactError) message += `\n\n[${formatArtifactErrorNotice(result.artifactError)}]`;
				if (signal?.aborted) {
					throw new ToolAbortError(message);
				}
				throw new ToolError(message);
			}
		}
		return this.#buildCompletedResult(result, timeoutSec, {
			command,
			cwd: commandCwd,
			requestedTimeoutSec,
			notices: pendingNotices,
			wallTimeMs,
			replies,
			toolCommands,
			toolCallId,
		});
	}
}
