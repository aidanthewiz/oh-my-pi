import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $which, isRecord } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	captureForgeCliEnvironment,
	FORGE_NON_INTERACTIVE_ENV,
	type ForgeCliResult,
	type ForgeCliSpec,
	runForgeCli,
} from "./forge-cli";

/** Options shaping `gh` failure messages and output handling. */
export interface GhCommandOptions {
	/** Caller passed an explicit repo; suppresses "run inside a checkout" hints. */
	repoProvided?: boolean;
	/** Trim captured output (default true). */
	trimOutput?: boolean;
	/** Credential environment captured by the initiating operation. */
	env?: Readonly<Record<string, string | undefined>>;
}

/** Deadline for `gh` subprocesses spawned by the coding agent. */
export const GH_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const GH_SPEC: ForgeCliSpec = {
	bin: "gh",
	displayName: "GitHub CLI",
	installMessage: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.",
	env: {
		...FORGE_NON_INTERACTIVE_ENV,
		GH_PROMPT_DISABLED: "1",
		GH_TELEMETRY: "false",
		GH_DEBUG: undefined,
		DEBUG: undefined,
		DO_NOT_TRACK: "1",
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
	},
	timeoutMs: GH_COMMAND_TIMEOUT_MS,
};

/** Global credential file selected by the same environment passed to gh. */
export function getGithubConfigPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const home = env.HOME || env.USERPROFILE || os.homedir();
	const directory =
		env.GH_CONFIG_DIR ||
		(env.XDG_CONFIG_HOME
			? path.join(env.XDG_CONFIG_HOME, "gh")
			: process.platform === "win32" && (env.AppData || env.APPDATA)
				? path.join((env.AppData || env.APPDATA)!, "GitHub CLI")
				: path.join(home, ".config", "gh"));
	return path.join(directory, "hosts.yml");
}

async function assertGithubEnterpriseHosts(
	cwd: string,
	args: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	signal?: AbortSignal,
): Promise<void> {
	if (!env.GH_ENTERPRISE_TOKEN && !env.GITHUB_ENTERPRISE_TOKEN) return;
	const candidates = new Set<string>();
	const addTarget = (value: string, repository = false) => {
		if (value.includes("://")) candidates.add(new URL(value).host.toLowerCase());
		else if (repository && value.split("/").length > 2) candidates.add(value.split("/")[0]!.toLowerCase());
		else if (!repository) candidates.add(value.toLowerCase());
	};
	let explicit = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--hostname" || arg === "--repo" || arg === "-R") {
			const value = args[++i];
			if (value) addTarget(value, arg !== "--hostname");
			explicit = true;
		} else if (arg.startsWith("--hostname=") || arg.startsWith("--repo=")) {
			addTarget(arg.slice(arg.indexOf("=") + 1), arg.startsWith("--repo="));
			explicit = true;
		} else if ((i === 1 || i === 2) && /^https?:\/\//.test(arg)) {
			addTarget(arg);
			explicit = true;
		}
	}
	if (!explicit && env.GH_REPO) {
		addTarget(env.GH_REPO, true);
		explicit = true;
	}
	if (!explicit && args[0] !== "api") {
		const repo = vcs.git(cwd);
		if (repo) {
			for (const remote of await repo.remoteList(signal)) {
				const value = await repo.remoteUrl(remote, signal);
				if (!value) continue;
				const scp = /^(?:[^/@:]+@)?([^/:]+):/.exec(value);
				if (value.includes("://")) addTarget(value);
				else if (scp) candidates.add(scp[1]!.toLowerCase());
			}
		}
	}
	if (candidates.size === 0) candidates.add((env.GH_HOST || "github.com").toLowerCase());
	const trusted = new Set(["github.com"]);
	if (env.GH_HOST)
		trusted.add(new URL(env.GH_HOST.includes("://") ? env.GH_HOST : `https://${env.GH_HOST}`).host.toLowerCase());
	if ([...candidates].every(host => trusted.has(host) || host.endsWith(".ghe.com"))) return;
	try {
		const config = Bun.YAML.parse(await fs.readFile(getGithubConfigPath(env), "utf8")) as unknown;
		if (isRecord(config)) for (const host of Object.keys(config)) trusted.add(host.toLowerCase());
	} catch {}
	for (const host of candidates) {
		if (!trusted.has(host) && !host.endsWith(".ghe.com")) {
			throw new ToolError(
				`Refusing to send GitHub enterprise token environment variables to unconfigured host ${host}. Configure GH_HOST or authenticate that host with gh auth login.`,
			);
		}
	}
}

function formatGhFailure(args: readonly string[], stdout: string, stderr: string, options?: GhCommandOptions): string {
	const message = (stderr || stdout).trim();
	if (message.includes("gh auth login") || message.includes("not logged into any GitHub hosts")) {
		return "GitHub CLI is not authenticated. Run `gh auth login`.";
	}
	if (
		!options?.repoProvided &&
		(message.includes("not a git repository") ||
			message.includes("no git remotes found") ||
			message.includes("unable to determine current repository"))
	) {
		return "GitHub repository context is unavailable. Pass `repo` explicitly or run the tool inside a GitHub checkout.";
	}
	if (message) return message;
	return `GitHub CLI command failed: gh ${args.join(" ")}`;
}

function describeGitHubApiError(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (!isRecord(value)) return undefined;
	if (typeof value.message === "string") return value.message.trim() || undefined;

	const resource = typeof value.resource === "string" ? value.resource.trim() : "";
	const field = typeof value.field === "string" ? value.field.trim() : "";
	const target = [resource, field].filter(Boolean).join(".");
	const code = typeof value.code === "string" ? value.code.trim() : "";
	if (target && code) return `${target}: ${code}`;
	return target || code || undefined;
}

function parseGitHubApiErrorMessages(stdout: string): string[] {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!isRecord(payload)) return [];

	const messages = new Set<string>();
	const summary = describeGitHubApiError(payload.message);
	if (summary) messages.add(summary);
	if (Array.isArray(payload.errors)) {
		for (const error of payload.errors) {
			const message = describeGitHubApiError(error);
			if (message) messages.add(message);
		}
	}
	return [...messages];
}

function formatGhJsonFailure(
	args: readonly string[],
	stdout: string,
	stderr: string,
	options?: GhCommandOptions,
): string {
	const rawMessage = (stderr || stdout).trim();
	const fallback = formatGhFailure(args, stdout, stderr, options);
	if (fallback !== rawMessage) return fallback;
	const details = parseGitHubApiErrorMessages(stdout).filter(message => !fallback.includes(message));
	if (details.length === 0) return fallback;
	return `${fallback}\nGitHub details:\n${details.map(message => `- ${message}`).join("\n")}`;
}

/** The sanctioned `gh` CLI runner: non-interactive env, bounded capture, deadline. */
export const github = {
	/** Check if the `gh` CLI is installed. */
	available(): boolean {
		return Boolean($which("gh"));
	},

	/** Run a raw `gh` CLI command. Does not throw on non-zero exit. */
	async run(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<ForgeCliResult> {
		const env = options?.env ?? captureForgeCliEnvironment(cwd, "gh");
		await assertGithubEnterpriseHosts(cwd, args, env, signal);
		return runForgeCli(GH_SPEC, cwd, args, signal, options?.trimOutput !== false, env);
	},

	/** Run `gh` and parse stdout as JSON. Throws on non-zero exit or invalid JSON. */
	async json<T>(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<T> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) {
			throw new ToolError(formatGhJsonFailure(args, result.stdout, result.stderr, options));
		}
		if (!result.stdout) throw new ToolError("GitHub CLI returned empty output.");
		try {
			return JSON.parse(result.stdout) as T;
		} catch {
			throw new ToolError("GitHub CLI returned invalid JSON output.");
		}
	},

	/** Run `gh` and return stdout as text. Throws on non-zero exit. */
	async text(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<string> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) throw new ToolError(formatGhFailure(args, result.stdout, result.stderr, options));
		return result.stdout;
	},
};
