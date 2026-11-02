import * as fs from "node:fs/promises";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, logger, TempDir } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Settings } from "../config/settings";
import { captureForgeCliEnvironment, CwdLookupMemo, ForgeCredentialsChangedError } from "../utils/forge-cli";
import { gitlab } from "../utils/gitlab";
import { type PrDiffPayload, parsePrUnifiedDiff } from "./gh-pr-diff";
import type { ViewLookupResult } from "./gh-view";
import {
	GITLAB_TOKEN_ENV_VARS,
	getGlabConfigPath,
	getGlabCredentialSourceIdentity,
	getOrFetchView,
	resolveGitlabCacheAuthKey,
} from "./github-cache";

/**
 * GitLab project refs are `<host>/<namespace…>/<project>` (host lowercased).
 * glab's `-R` accepts a full URL, which disambiguates nested groups and
 * self-managed hosts.
 */
export function formatGitlabProjectArg(project: string): string {
	return `https://${project}`;
}

/** One namespace or project path segment of a GitLab project ref. */
export const GITLAB_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
/** A GitLab host with optional port; rejects userinfo, paths, and control characters. */
export const GITLAB_HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d+)?$/;

/** Parse a GitLab project web URL into a `<host>/<namespace…>/<project>` ref. */
export function parseGitlabProjectWebUrl(webUrl: string): string | undefined {
	let url: URL;
	try {
		url = new URL(webUrl);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 2 || !segments.every(segment => GITLAB_PATH_SEGMENT_PATTERN.test(segment))) return undefined;
	return `${url.host.toLowerCase()}/${segments.join("/")}`;
}

/**
 * glab sends `GITLAB_TOKEN`/`GITLAB_ACCESS_TOKEN`/`OAUTH_TOKEN` to whatever
 * host it talks to, while stored config.yml tokens are per host. When an env
 * token is set, MR URLs (pasted, detected in conversation, or model-chosen)
 * may only reach hosts the user already trusts with credentials: gitlab.com,
 * the configured default host, or a host in glab's config.
 */
async function assertGitlabHostTrustedForEnvToken(
	host: string,
	env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
	if (!GITLAB_TOKEN_ENV_VARS.some(name => env[name])) return;
	const trusted = new Set(["gitlab.com"]);
	for (const name of ["GITLAB_HOST", "GITLAB_URI", "GL_HOST"]) {
		const value = env[name]?.trim();
		if (!value) continue;
		try {
			trusted.add(new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase());
		} catch {
			logger.debug("glab: ignoring unparseable default host", { name });
		}
	}
	if (trusted.has(host)) return;
	try {
		const config = Bun.YAML.parse(await Bun.file(getGlabConfigPath(env)).text()) as { hosts?: unknown } | null;
		if (config && typeof config.hosts === "object" && config.hosts !== null) {
			for (const name of Object.keys(config.hosts)) trusted.add(name.toLowerCase());
		}
	} catch (err) {
		if (!isEnoent(err)) logger.debug("glab: failed to read config hosts");
	}
	if (trusted.has(host)) return;
	throw new ToolError(
		`Refusing to send GitLab token environment variables to ${host}: configure GITLAB_HOST or authenticate that host with \`glab auth login --hostname ${host}\`. A checkout remote does not grant credential trust.`,
	);
}

const defaultProjectMemo = new CwdLookupMemo(resolveGitlabProjectFromCwd);

async function writeProjectionObject(gitDir: string, kind: string, body: string): Promise<string> {
	const bytes = Buffer.from(`${kind} ${Buffer.byteLength(body)}\0${body}`);
	const oid = new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
	const directory = path.join(gitDir, "objects", oid.slice(0, 2));
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(path.join(directory, oid.slice(2)), deflateSync(bytes));
	return oid;
}

async function resolveGitlabProjectFromCwd(
	cwd: string,
	signal?: AbortSignal,
	env: Readonly<Record<string, string | undefined>> = captureForgeCliEnvironment(cwd, "glab"),
	credentialSourceIdentity = getGlabCredentialSourceIdentity(env),
): Promise<string> {
	const childEnv: Readonly<Record<string, string | undefined>> = {
		...env,
		GLAB_CONFIG_DIR: path.dirname(getGlabConfigPath(env)),
	};
	const sshHosts = new Map<string, string>();
	try {
		const config = Bun.YAML.parse(await fs.readFile(getGlabConfigPath(childEnv), "utf8")) as {
			hosts?: Record<string, { ssh_host?: unknown }>;
		} | null;
		for (const [host, options] of Object.entries(config?.hosts ?? {})) {
			if (typeof options?.ssh_host === "string") sshHosts.set(options.ssh_host.toLowerCase(), host.toLowerCase());
		}
	} catch {}
	if (childEnv.GITLAB_SSH_HOST) {
		const host = childEnv.GITLAB_HOST || childEnv.GITLAB_URI || childEnv.GL_HOST || "gitlab.com";
		sshHosts.set(
			childEnv.GITLAB_SSH_HOST.toLowerCase(),
			new URL(host.includes("://") ? host : `https://${host}`).host.toLowerCase(),
		);
	}
	const repo = vcs.requireGit(cwd);
	const remotes = await repo.remoteList(signal);
	const entries: string[] = ["[core]\nrepositoryformatversion = 0\nbare = false"];
	for (const remote of remotes) {
		if (/[\0\r\n]/.test(remote)) throw new ToolError("Invalid Git remote name.");
		const value = await repo.remoteUrl(remote, signal);
		if (!value) continue;
		const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(value);
		const url =
			scp && !value.includes("://") ? `https://${scp[1]}/${scp[2]}` : value.replace(/^ssh:\/\//, "https://");
		const project = parseGitlabProjectWebUrl(url.replace(/\.git$/, ""));
		if (!project) throw new ToolError("This checkout has an unrecognized GitLab remote URL.");
		const ssh = (scp !== null && !value.includes("://")) || value.startsWith("ssh://");
		const host = project.split("/")[0]!;
		await assertGitlabHostTrustedForEnvToken(ssh ? (sshHosts.get(host) ?? host) : host, childEnv);
		const name = remote.replace(/[\\"]/g, "\\$&");
		const projectedUrl = ssh ? `ssh://git@${project}.git` : `https://${project}.git`;
		entries.push(`[remote "${name}"]\nurl = ${projectedUrl}`);
	}
	if (childEnv.GITLAB_REPO) {
		const project = parseGitlabProjectWebUrl(
			childEnv.GITLAB_REPO.includes("://") ? childEnv.GITLAB_REPO : `https://${childEnv.GITLAB_REPO}`,
		);
		if (project) await assertGitlabHostTrustedForEnvToken(project.split("/")[0]!, childEnv);
	}
	await using projection = TempDir.createSync("@glab-repository-");
	const gitDir = path.join(projection.path(), ".git");
	await fs.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true });
	const tree = await writeProjectionObject(gitDir, "tree", "");
	const commit = await writeProjectionObject(
		gitDir,
		"commit",
		`tree ${tree}\nauthor Coreforge <projection@invalid> 0 +0000\ncommitter Coreforge <projection@invalid> 0 +0000\n\nRepository selection\n`,
	);
	const branch = await repo.currentBranch(signal);
	if (branch) {
		if (branch.split("/").some(part => !part || part === "." || part === "..") || /[\0\r\n\\]/.test(branch)) {
			throw new ToolError("Invalid Git branch name.");
		}
		const branchPath = path.join(gitDir, "refs", "heads", branch);
		await fs.mkdir(path.dirname(branchPath), { recursive: true });
		await fs.writeFile(branchPath, `${commit}\n`);
		await fs.writeFile(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
		const selection = [`[branch "${branch.replace(/[\\"]/g, "\\$&")}"]`];
		for (const key of ["remote", "merge"]) {
			const value = await repo.configGet(`branch.${branch}.${key}`, signal);
			if (value) {
				if (/[\0\r\n]/.test(value)) throw new ToolError("Invalid Git branch selection.");
				selection.push(`${key} = "${value.replace(/[\\"]/g, "\\$&")}"`);
			}
		}
		entries.push(selection.join("\n"));
	} else {
		await fs.writeFile(path.join(gitDir, "HEAD"), `${commit}\n`);
	}
	await fs.writeFile(path.join(gitDir, "config"), `${entries.join("\n")}\n`);
	const view = await gitlab.json<{ web_url?: string; http_url_to_repo?: string }>(
		projection.path(),
		["repo", "view", "-F", "json"],
		signal,
		{ env: childEnv, credentialSourceIdentity },
	);
	const project =
		(view.web_url ? parseGitlabProjectWebUrl(view.web_url) : undefined) ??
		(view.http_url_to_repo ? parseGitlabProjectWebUrl(view.http_url_to_repo.replace(/\.git$/, "")) : undefined);
	if (!project) throw new ToolError("GitLab CLI returned an unrecognized project URL.");
	await assertGitlabHostTrustedForEnvToken(project.split("/")[0]!, childEnv);
	return project;
}

/** Credential-scoped discovery bypasses the cwd-only convenience memo. */
export function resolveDefaultGitlabProjectMemoized(
	cwd: string,
	signal?: AbortSignal,
	env?: Readonly<Record<string, string | undefined>>,
	credentialSourceIdentity?: string,
): Promise<string> {
	return env || credentialSourceIdentity
		? resolveGitlabProjectFromCwd(cwd, signal, env, credentialSourceIdentity)
		: defaultProjectMemo.get(cwd, signal);
}

export function resetDefaultGitlabProjectMemoForTests(): void {
	defaultProjectMemo.clear();
}

export async function fetchMrDiffFresh(
	cwd: string,
	project: string,
	iid: number,
	signal: AbortSignal | undefined,
	env: Readonly<Record<string, string | undefined>> = captureForgeCliEnvironment(cwd, "glab"),
	credentialSourceIdentity = getGlabCredentialSourceIdentity(env),
): Promise<{ rendered: string; sourceUrl: string | undefined; payload: PrDiffPayload }> {
	await assertGitlabHostTrustedForEnvToken(project.split("/")[0]!, env);
	const childEnv = { ...env, GLAB_CONFIG_DIR: path.dirname(getGlabConfigPath(env)) };
	const baseArgs = ["mr", "diff", String(iid), "-R", formatGitlabProjectArg(project)];
	let text: string;
	try {
		text = await gitlab.text(cwd, [...baseArgs, "--raw", "--color", "never"], signal, {
			trimOutput: false,
			env: childEnv,
			neutral: true,
			credentialSourceIdentity,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// glab releases without `--raw` print bare `---`/`+++` headers for every
		// diff version, which no parser here can split into one file list.
		if (message.includes("unknown flag: --raw")) {
			throw new ToolError("GitLab CLI is too old for `glab mr diff --raw`; upgrade glab.");
		}
		// Instances without the `raw_diffs` endpoint: glab's rendered diff of the
		// latest version still carries `diff --git` headers.
		if (!(message.includes("could not obtain raw diff") && message.includes("404"))) throw err;
		logger.debug("GitLab raw_diffs endpoint unavailable; retrying without --raw", { project, iid, err: message });
		text = await gitlab.text(cwd, [...baseArgs, "--color", "never"], signal, {
			trimOutput: false,
			env: childEnv,
			neutral: true,
			credentialSourceIdentity,
		});
	}
	const payload = parsePrUnifiedDiff(text);
	if (payload.files.length === 0 && text.trim()) {
		throw new ToolError("GitLab CLI returned a diff without `diff --git` file headers; upgrade glab.");
	}
	// `rendered` carries the verbatim diff; blank the payload copy so the cache
	// row stores it once. `getOrFetchMrDiff` rehydrates `unified` from `rendered`.
	return { rendered: text, sourceUrl: undefined, payload: { unified: "", files: payload.files } };
}

export interface MrDiffLookupOptions {
	cwd: string;
	/** `<host>/<namespace…>/<project>`. */
	project: string;
	iid: number;
	signal?: AbortSignal;
	settings?: Settings;
	/** `null` bypasses the cache; `undefined` derives the key from glab credentials. */
	cacheAuthKey?: string | null;
	/** Private credential environment captured by the initiating URL read. */
	env?: Readonly<Record<string, string | undefined>>;
	credentialSourceIdentity?: string;
}

/**
 * Cache-aware MR diff fetcher; one `mr-diff` cache row backs the listing,
 * full-diff, and per-file slice variants of `mr://…/diff`.
 */
export async function getOrFetchMrDiff(options: MrDiffLookupOptions): Promise<ViewLookupResult<PrDiffPayload>> {
	const env = options.env ?? captureForgeCliEnvironment(options.cwd, "glab");
	const sourceIdentity = options.credentialSourceIdentity ?? getGlabCredentialSourceIdentity(env);
	const host = options.project.split("/")[0]!;
	const credentialIdentity = resolveGitlabCacheAuthKey(host, env);
	const authKey = options.cacheAuthKey === undefined ? (credentialIdentity ?? null) : options.cacheAuthKey;
	await assertGitlabHostTrustedForEnvToken(host, env);
	if (getGlabCredentialSourceIdentity(env) !== sourceIdentity) {
		throw new ForgeCredentialsChangedError("GitLab credential configuration changed during request preparation.");
	}
	if (resolveGitlabCacheAuthKey(host, env) !== credentialIdentity) {
		throw new ForgeCredentialsChangedError("GitLab credentials changed during request preparation.");
	}
	const lookup = await getOrFetchView<PrDiffPayload>({
		repo: options.project,
		kind: "mr-diff",
		number: options.iid,
		includeComments: false,
		settings: options.settings,
		authKey,
		fetchFresh: async () => {
			if (resolveGitlabCacheAuthKey(host, env) !== credentialIdentity) {
				throw new ForgeCredentialsChangedError("GitLab credentials changed before the request.");
			}
			const fresh = await fetchMrDiffFresh(
				options.cwd,
				options.project,
				options.iid,
				options.signal,
				env,
				sourceIdentity,
			);
			if (resolveGitlabCacheAuthKey(host, env) !== credentialIdentity) {
				throw new ForgeCredentialsChangedError(
					"GitLab credentials changed during the request; no cache entry was written.",
				);
			}
			return fresh;
		},
	});
	return {
		rendered: lookup.rendered,
		sourceUrl: lookup.sourceUrl,
		payload: { unified: lookup.rendered, files: lookup.payload.files },
		status: lookup.status,
		fetchedAt: lookup.fetchedAt,
	};
}
