/**
 * Update CLI command handler.
 *
 * Handles `omp update` to check for and install updates.
 * Uses the installer that owns the active omp executable when it can be detected.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { $env, $which, APP_NAME, isCompiledBinary, isEnoent, logger } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { $ } from "bun";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
	isTimeoutError,
	isUnsupportedProxyError,
	unsupportedProxyMessage,
	withTimeoutSignal,
} from "../utils/fetch-timeout";
import type { CfFetchOptions, CfRelease } from "./cf-channel";
import { CF_ENGINE_RELEASE_REPO, fetchCfAsset, fetchCfLatestRelease } from "./cf-channel";
import { CF_COMMAND, CF_VERSION, compareCfVersions } from "./cf-version";
import { managedInstallName } from "./managed-install";

const COREFORGE_VERSION_PRODUCT = "coreforge";
const HOMEBREW_FORMULA = "can1357/tap/omp";
const MISE_TOOL = "github:can1357/oh-my-pi";
const NIX_STORE_DIR = "/nix/store";
const REPO = CF_ENGINE_RELEASE_REPO;
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

interface ReleaseInfo {
	tag: string;
	version: string;
}

export type UpdateProgress =
	| { phase: "downloading"; version: string; received: number; total: number }
	| { phase: "installing"; version: string };
type UpdateProgressListener = (progress: UpdateProgress) => void;

export interface UpdateOptions {
	force: boolean;
	check: boolean;
	onProgress?: UpdateProgressListener;
}

export type UpdateOutcome =
	| { kind: "current" }
	| { kind: "available"; version: string }
	| { kind: "unsupported"; reason: string }
	| { kind: "installed"; version: string };

/** A release binary the updater can download, resolved from published GitHub release metadata. */
export interface ReleaseBinaryAsset {
	url: string;
	size: number;
	digest: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type GitHubCliTokenRunner = (ghPath: string) => Promise<string | undefined>;

async function readGitHubCliToken(ghPath: string): Promise<string | undefined> {
	try {
		const result = await $`${ghPath} auth token --hostname github.com`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const token = result.text().trim();
		return token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

async function resolveGitHubToken(
	options: {
		envToken?: string;
		ghPath?: string | null;
		runGhAuthToken?: GitHubCliTokenRunner;
	} = {},
): Promise<string | undefined> {
	const envToken = options.envToken ?? ($env.GITHUB_TOKEN || $env.GH_TOKEN);
	if (envToken) return envToken;

	const ghPath = options.ghPath === null ? undefined : (options.ghPath ?? $which("gh"));
	if (!ghPath) return undefined;

	const token = await (options.runGhAuthToken ?? readGitHubCliToken)(ghPath);
	return token?.trim() || undefined;
}

/** Test hook for the GitHub credential precedence without invoking a real CLI. */
export async function resolveGitHubTokenForTest(
	options: {
		envToken?: string;
		ghPath?: string | null;
		runGhAuthToken?: GitHubCliTokenRunner;
	} = {},
): Promise<string | undefined> {
	return resolveGitHubToken(options);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**

 * Select and validate the binary asset from GitHub release metadata.
 *
 * Draft releases are always rejected. Prereleases are rejected unless
 * `options.allowPrerelease` is set, which the canary channel passes: canary
 * GitHub releases are published as prereleases, and the exact-tag match below
 * still pins the download to the specific requested version.
 */
export function resolveReleaseBinaryAsset(
	release: unknown,
	expectedTag: string,
	binaryName: string,
	options: { allowPrerelease?: boolean } = {},
): ReleaseBinaryAsset {
	if (!isRecord(release)) {
		throw new Error("Invalid GitHub release metadata");
	}
	if (release.tag_name !== expectedTag) {
		throw new Error(`GitHub release tag mismatch: expected ${expectedTag}`);
	}
	if (release.draft !== false) {
		throw new Error(`GitHub release ${expectedTag} is a draft, not a published release`);
	}
	if (release.prerelease !== false && !options.allowPrerelease) {
		throw new Error(`GitHub release ${expectedTag} is a prerelease; only canary updates install prerelease assets`);
	}
	if (!Array.isArray(release.assets)) {
		throw new Error(`GitHub release ${expectedTag} has no asset list`);
	}

	const matches = release.assets.filter(asset => isRecord(asset) && asset.name === binaryName);
	if (matches.length !== 1) {
		throw new Error(`GitHub release ${expectedTag} has ${matches.length} assets named ${binaryName}`);
	}

	const asset = matches[0];
	if (!isRecord(asset) || asset.state !== "uploaded") {
		throw new Error(`GitHub release asset ${binaryName} is not fully uploaded`);
	}
	if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
		throw new Error(`GitHub release asset ${binaryName} has an invalid size`);
	}
	if (typeof asset.digest !== "string") {
		throw new Error(`GitHub release asset ${binaryName} has no digest`);
	}
	const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1];
	if (!digest) {
		throw new Error(`GitHub release asset ${binaryName} has an unsupported digest`);
	}

	const expectedUrl = `https://github.com/${REPO}/releases/download/${expectedTag}/${binaryName}`;
	if (asset.browser_download_url !== expectedUrl) {
		throw new Error(`GitHub release asset ${binaryName} has an unexpected download URL`);
	}

	return {
		url: expectedUrl,
		size: asset.size,
		digest: `sha256:${digest.toLowerCase()}`,
	};
}
export interface VerifiedBinaryDownloadOptions {
	url: string;
	targetPath: string;
	expectedSize: number;
	expectedDigest: string;
	fetchImpl?: Fetch;
	onProgress?: (received: number) => void;
}

/**
 * Download a binary and verify its GitHub-reported size and SHA-256 digest.
 * Remove the destination when download or verification fails.
 */
export async function downloadVerifiedBinary(options: VerifiedBinaryDownloadOptions): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	await unlinkIfExists(options.targetPath);

	let response: Response;
	try {
		response = await fetchImpl(options.url, {
			redirect: "follow",
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}

	const hash = new Bun.SHA256();
	let size = 0;
	const verifier = new Transform({
		transform(chunk, _encoding, callback) {
			size += chunk.byteLength;
			if (size > options.expectedSize) {
				callback(
					new Error(
						`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received at least ${size}`,
					),
				);
				return;
			}
			hash.update(chunk);
			options.onProgress?.(size);
			callback(null, chunk);
		},
	});

	try {
		await pipeline(response.body, verifier, fs.createWriteStream(options.targetPath, { mode: 0o600 }));
		const digest = `sha256:${hash.digest("hex")}`;
		if (size !== options.expectedSize) {
			throw new Error(`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received ${size}`);
		}
		if (digest !== options.expectedDigest) {
			throw new Error(`Downloaded binary digest mismatch: expected ${options.expectedDigest}, received ${digest}`);
		}
		await fs.promises.chmod(options.targetPath, 0o755);
	} catch (err) {
		await unlinkIfExists(options.targetPath);
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
	validateExistingTarget?: () => Promise<void>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean; plugins: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
		plugins: args.includes("--plugins") || args.includes("-l"),
	};
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function getNpmGlobalBinDir(): Promise<string | undefined> {
	if (!$which("npm")) return undefined;
	try {
		const result = await $`npm prefix -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const prefix = result.text().trim();
		if (prefix.length === 0) return undefined;
		return process.platform === "win32" ? prefix : path.join(prefix, "bin");
	} catch {
		return undefined;
	}
}

async function getHomebrewFormulaPrefix(): Promise<string | undefined> {
	if (!$which("brew")) return undefined;
	for (const formula of [HOMEBREW_FORMULA, APP_NAME]) {
		try {
			const result = await $`brew --prefix ${formula}`.quiet().nothrow();
			if (result.exitCode !== 0) continue;
			const output = result.text().trim();
			if (output.length > 0) return output;
		} catch {}
	}
	return undefined;
}

async function getMiseBinDirs(): Promise<string[]> {
	if (!$which("mise")) return [];
	try {
		const result = await $`mise bin-paths ${MISE_TOOL}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch {
		return [];
	}
}

function getMiseDataDir(): string {
	const override = process.env.MISE_DATA_DIR;
	if (override && override.length > 0) return override;
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData && localAppData.length > 0) return path.join(localAppData, "mise");
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) return path.join(xdgDataHome, "mise");
	return path.join(os.homedir(), ".local", "share", "mise");
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

/**
 * Whether this omp runs from a source checkout (the dev launcher or a `bun link` of
 * `src/cli.ts`) rather than a compiled binary or a package-manager install, which
 * always lives under `node_modules`. Checkouts update through git, so update
 * prompts are noise there.
 */
export function isSourceCheckout(): boolean {
	return !isCompiledBinary() && !import.meta.dir.split(path.sep).includes("node_modules");
}

/**
 * Only a compiled, unmanaged Coreforge install may update itself.
 * Package managers, source checkouts and managing apps retain their own update authority.
 */
export async function canSelfUpdate(): Promise<boolean> {
	if (!isCompiledBinary()) return false;
	if (isPathInDirectory(process.execPath, NIX_STORE_DIR)) return false;
	return (await managedInstallName(process.execPath)) === undefined;
}

function isSymlinkPath(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}
/** Windows script shims (npm's launchers) that a native executable cannot overwrite. */
function isWindowsScriptLauncherPath(launcherPath: string): boolean {
	const extension = path.extname(launcherPath).toLowerCase();
	return extension === ".cmd" || extension === ".ps1" || extension === ".bat";
}

/**
 * Path of bun's Windows launcher metadata sidecar for `launcherPath`.
 *
 * `bun install -g` writes a `<name>.bunx` / `<name>.exe` pair: the `.exe` is a
 * generic shim and the `.bunx` names the package entrypoint it launches.
 */
function bunShimMarkerPath(launcherPath: string): string {
	const base = path.basename(launcherPath, path.extname(launcherPath));
	return path.join(path.dirname(launcherPath), `${base}.bunx`);
}
function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard. On Windows, ~/.bun
	// is a junction when Bun is installed via Scoop, so `bun pm bin -g` and the
	// PATH-resolved omp path can refer to the same directory through different
	// strings. path.resolve does not traverse junctions/symlinks; realpath does.
	// Resolve both the file and its parent directory: the file catches manager
	// links like Homebrew's `bin/omp -> Cellar/.../bin/omp`; the parent fallback
	// still tolerates fresh install paths where the file does not exist yet.
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

function isPathInManagerRoot(linkTarget: string, nodeModulesDir: string): boolean {
	if (isPathInDirectoryLexical(linkTarget, nodeModulesDir)) return true;
	// Resolve only the manager root. Resolving the link target itself would
	// follow globally linked packages into their checkout and lose ownership.
	const nodeModulesReal = tryRealpath(path.resolve(nodeModulesDir));
	return nodeModulesReal !== undefined && isPathInDirectoryLexical(linkTarget, nodeModulesReal);
}

function resolveNpmGlobalNodeModulesDir(globalBinDir: string | undefined): string | undefined {
	if (!globalBinDir) return undefined;
	if (process.platform === "win32") return path.join(globalBinDir, "node_modules");
	return path.join(path.dirname(globalBinDir), "lib", "node_modules");
}

function isManagerOwnedBinEntry(linkTarget: string | undefined, nodeModulesDir: string | undefined): boolean {
	// Non-symlink launchers and unreadable links retain the existing bin-dir
	// classification. A readable link must point through the manager's exact
	// global node_modules tree.
	return linkTarget === undefined || (nodeModulesDir !== undefined && isPathInManagerRoot(linkTarget, nodeModulesDir));
}

type UpdateMethod = "brew" | "mise" | "nix" | "bun" | "npm" | "binary";

interface UpdateMethodResolutionOptions {
	homebrewPrefix?: string;
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
	npmBinDir?: string;
	/** Bun's configured global package directory, independent of its bin directory. */
	bunGlobalDir?: string;
	/**
	 * Whether the resolved omp path is a plain file (the standalone binary)
	 * rather than a package-manager symlink. Stops a binary install from being
	 * misrouted to npm/bun when the global bin dir overlaps the installer's
	 * target directory.
	 */
	ompIsRegularFile?: boolean;
	/**
	 * Absolute path named by the bin entry's first symlink hop. This deliberately
	 * preserves a global package symlink instead of resolving into its checkout.
	 */
	ompLinkTarget?: string;
	/**
	 * Whether bun's launcher metadata (`<name>.bunx`) sits beside the resolved
	 * launcher. Bun writes that sidecar next to every `.exe` shim it installs, so
	 * its presence is what makes a regular-file launcher in bun's bin dir
	 * bun-managed rather than a standalone binary that took the launcher over.
	 */
	bunShimMarker?: boolean;
	/**
	 * Whether package-manager routing (bun/npm) is permitted. Binary-only
	 * releases pass `false`: a manager launcher then resolves to `"binary"` and
	 * is taken over in place rather than reinstalled through its manager. Defaults
	 * to `true` in {@link resolveUpdateMethod} so callers that only classify need
	 * not set it.
	 */
	allowPackageManagers?: boolean;
}

type UpdateTarget =
	| { method: "brew" }
	| { method: "mise" }
	| { method: "nix" }
	| { method: "bun"; path?: string }
	| { method: "npm"; path?: string }
	| { method: "binary"; path: string; replacesSymlink: boolean; validateExistingTarget: boolean };

function resolveUpdateMethod(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const {
		allowPackageManagers = true,
		bunGlobalDir,
		bunShimMarker = false,
		homebrewPrefix,
		miseBinDirs = [],
		miseDataDir,
		npmBinDir,
		ompIsRegularFile = false,
		ompLinkTarget,
	} = options;
	const launcherExtension = path.extname(ompPath).toLowerCase();
	const isWindowsScriptLauncher = isWindowsScriptLauncherPath(ompPath);
	if (isPathInDirectory(ompPath, NIX_STORE_DIR)) return "nix";
	if (homebrewPrefix && isPathInDirectory(ompPath, path.join(homebrewPrefix, "bin"))) return "brew";
	if (miseBinDirs.some(dir => isPathInDirectory(ompPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(ompPath, path.join(miseDataDir, "shims"))) return "mise";
	// A plain executable file in a package-manager bin dir is the standalone
	// binary the installer placed there, not an npm/bun-managed install (those
	// symlink into node_modules on POSIX). When the global bin dir overlaps the
	// installer's default (~/.local/bin), classifying by directory alone routes
	// a binary install through npm/bun, whose reinstall then collides with the
	// existing file (npm EEXIST). Fall through to binary replacement instead.
	// On Windows every launcher is a regular file, so ownership keys off the
	// manager's own artifacts instead: npm's script shims (`omp`, `omp.cmd`,
	// `omp.ps1`) and bun's `omp.bunx` sidecar. A bare `.exe` with neither is the
	// standalone binary a binary-only release installed over the launcher —
	// routing that back through bun reinstalls a package which no longer owns
	// the launcher, and bun silently tolerates failing to overwrite the running
	// `.exe` (EBUSY), so the install would stay pinned to the old version.
	const isWindowsManagedLauncher =
		process.platform === "win32" && (isWindowsScriptLauncher || launcherExtension === "" || bunShimMarker);
	const isStandaloneRegularFile = ompIsRegularFile && !isWindowsManagedLauncher;
	const bunNodeModulesDir = resolveBunGlobalNodeModulesDirFromLocations({
		globalDir: bunGlobalDir,
		globalBinDir: bunBinDir,
	});
	if (
		allowPackageManagers &&
		bunBinDir &&
		isPathInDirectory(ompPath, bunBinDir) &&
		!isStandaloneRegularFile &&
		isManagerOwnedBinEntry(ompLinkTarget, bunNodeModulesDir)
	) {
		return "bun";
	}
	const npmNodeModulesDir = resolveNpmGlobalNodeModulesDir(npmBinDir);
	if (
		allowPackageManagers &&
		npmBinDir &&
		isPathInDirectory(ompPath, npmBinDir) &&
		!isStandaloneRegularFile &&
		isManagerOwnedBinEntry(ompLinkTarget, npmNodeModulesDir)
	) {
		return "npm";
	}
	if (isWindowsScriptLauncher) return "npm";
	return "binary";
}

export function resolveUpdateMethodForTest(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(ompPath, bunBinDir, options);
}

/** Resolve an update target from the concrete PATH entry selected by the shell. */
export function resolveUpdateTargetFromPath(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions & { allowPackageManagers: boolean },
): UpdateTarget {
	let ompIsRegularFile = false;
	let ompIsSymlink = false;
	let ompLinkTarget: string | undefined;
	let ompRealpath: string | undefined;
	const bunShimMarker = process.platform === "win32" && fs.existsSync(bunShimMarkerPath(ompPath));
	try {
		const stat = fs.lstatSync(ompPath);
		ompIsRegularFile = stat.isFile() && !stat.isSymbolicLink();
		ompIsSymlink = stat.isSymbolicLink();
		if (ompIsSymlink) {
			const rawTarget = fs.readlinkSync(ompPath);
			const linkDir = path.dirname(ompPath);
			ompLinkTarget = path.resolve(tryRealpath(linkDir) ?? linkDir, rawTarget);
			ompRealpath = tryRealpath(ompPath);
		}
	} catch {}

	const method = resolveUpdateMethod(ompPath, bunBinDir, {
		...options,
		bunShimMarker,
		ompIsRegularFile,
		ompLinkTarget,
	});
	if (method === "binary") {
		// A symlinked launcher created by bun/npm is taken over in place on a
		// binary-only release: routing through the manager is impossible, so the
		// standalone binary replaces the launcher and keeps the PATH entry live.
		// Every other symlink — a foreign alias, or an admin symlink into a
		// shared install — is self-healing: update the real binary it resolves
		// to and leave the launcher untouched, in every distribution channel.
		// The old channel gate clobbered these foreign launchers on binary-only
		// releases (EACCES on a root-owned link dir, or a stale split-brain copy
		// of the binary shadowing the shared install).
		const managerLauncher =
			ompIsSymlink &&
			!options.allowPackageManagers &&
			resolveUpdateMethod(ompPath, bunBinDir, {
				...options,
				allowPackageManagers: true,
				bunShimMarker,
				ompIsRegularFile,
				ompLinkTarget,
			}) !== "binary";
		const binaryPath = ompIsSymlink && !managerLauncher ? (ompRealpath ?? ompPath) : ompPath;
		return {
			method,
			path: binaryPath,
			replacesSymlink: ompIsSymlink && binaryPath === ompPath,
			validateExistingTarget: ompIsSymlink && !managerLauncher,
		};
	}
	if (method === "bun" || method === "npm") return { method, path: ompPath };
	return { method };
}
/**
 * Resolve how the running install should be updated.
 *
 * `allowPackageManagers: false` disables bun/npm routing — used for
 * binary-only releases, where reinstalling through a package manager is never
 * valid. The `bun pm bin -g` / `npm prefix -g` probes are then skipped unless
 * the launcher is a symlink, whose bin dirs distinguish a manager launcher
 * (taken over in place) from a foreign symlink (resolved to its real binary).
 * Homebrew/mise detection always runs: both managers install the standalone
 * release binaries and stay valid regardless of how the release is distributed.
 */
async function resolveUpdateTarget(options: { allowPackageManagers: boolean }): Promise<UpdateTarget> {
	const homebrewPrefix = await getHomebrewFormulaPrefix();
	const miseAvailable = $which("mise") !== undefined;
	const miseBinDirs = miseAvailable ? await getMiseBinDirs() : [];
	const miseDataDir = miseAvailable ? getMiseDataDir() : undefined;
	const ompPath = resolveOmpPath();

	// Binary-only releases skip package-manager routing, but a symlinked
	// launcher still needs the manager bin dirs to tell a bun/npm launcher
	// (taken over in place) from a foreign symlink (resolved to its real
	// binary). A plain-file install never needs the distinction, so the common
	// case stays probe-free.
	const probeManagers = options.allowPackageManagers || (ompPath !== undefined && isSymlinkPath(ompPath));
	const bunBinDir = probeManagers ? await getBunGlobalBinDir() : undefined;
	const npmBinDir = probeManagers ? await getNpmGlobalBinDir() : undefined;

	if (ompPath) {
		return resolveUpdateTargetFromPath(ompPath, bunBinDir, {
			allowPackageManagers: options.allowPackageManagers,
			bunGlobalDir: probeManagers ? process.env.BUN_INSTALL_GLOBAL_DIR : undefined,
			homebrewPrefix,
			miseBinDirs,
			miseDataDir,
			npmBinDir,
		});
	}

	if (bunBinDir) return { method: "bun" };

	throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
}

/**
 * Get the latest release info from the Coreforge channel.
 * Release lookups use the private Coreforce-CAD mirror, not npm.
 */
let lastCfRelease: CfRelease | undefined;
async function fetchLatestCoreforgeRelease(options?: CfFetchOptions): Promise<CfRelease> {
	try {
		return await fetchCfLatestRelease(withTimeoutSignal(RELEASE_METADATA_TIMEOUT_MS), options);
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out fetching release info after 30s", { cause: err });
		}
		if (isUnsupportedProxyError(err)) throw new Error(unsupportedProxyMessage(), { cause: err });
		throw err;
	}
}

async function getLatestRelease(): Promise<ReleaseInfo> {
	lastCfRelease = await fetchLatestCoreforgeRelease();
	return { tag: lastCfRelease.tag, version: lastCfRelease.version };
}

interface BunGlobalInstallLocations {
	globalDir?: string;
	globalBinDir?: string;
	cacheDir?: string;
}

/** Resolve Bun's global node_modules root from explicit, default, or cache locations. */
export function resolveBunGlobalNodeModulesDirFromLocations({
	globalDir,
	globalBinDir,
	cacheDir,
}: BunGlobalInstallLocations): string | undefined {
	if (globalDir && globalDir.length > 0) return path.join(globalDir, "node_modules");
	if (globalBinDir && globalBinDir.length > 0) {
		return path.join(path.dirname(globalBinDir), "install", "global", "node_modules");
	}
	if (cacheDir && cacheDir.length > 0) {
		return path.join(path.dirname(cacheDir), "global", "node_modules");
	}
	return undefined;
}

/**
 * Detect a musl-libc Linux host (Alpine, Void-musl) so self-update replaces a
 * musl binary with the musl release asset instead of the glibc build, which
 * would fail to start on the next run. The loader file alone is not sufficient:
 * glibc hosts may have musl installed for cross-compilation.
 */
interface MuslDetectionOptions {
	platform?: NodeJS.Platform;
	alpineRelease?: boolean;
	lddOutput?: string;
}

function detectLddOutput(): string | undefined {
	try {
		const result = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
		return `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		return undefined;
	}
}

function isMuslLinux(options: MuslDetectionOptions = {}): boolean {
	if ((options.platform ?? process.platform) !== "linux") return false;
	if (options.alpineRelease ?? fs.existsSync("/etc/alpine-release")) return true;
	return /\bmusl\b/i.test(options.lddOutput ?? detectLddOutput() ?? "");
}

/** Test seam for libc detection. */
export function isMuslLinuxForTest(options: Required<MuslDetectionOptions>): boolean {
	return isMuslLinux(options);
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = isMuslLinux() ? "linux-musl" : "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the binary to update. [coreforge patch] Compiled builds update
 * THEMSELVES (process.execPath) regardless of install name - the coreforge
 * installer ships the binary as `omp-coreforge` so it cannot shadow a
 * personal upstream omp install; $which("omp") would find the wrong one.
 * Source runs (bun dev) keep the PATH lookup for parity with upstream.
 */
function resolveOmpPath(): string | undefined {
	if (process.env.PI_COMPILED === "true") {
		return process.execPath;
	}
	return $which(APP_NAME) ?? undefined;
}

/**
 * Parse the version a launcher reports from product version output.
 *
 * Supports three-segment upstream versions, four-segment Coreforge release
 * rolls, and prerelease suffixes without truncating the reported identity.
 */
export function parseReportedVersion(output: string, requiredProduct?: string): string | undefined {
	const separator = output.indexOf("/");
	if (separator < 1) return undefined;
	const product = output.slice(0, separator);
	if (requiredProduct ? product !== requiredProduct : product !== APP_NAME && product !== CF_COMMAND) return undefined;
	return output.slice(separator + 1).match(/^(\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)$/)?.[1];
}

async function reportedVersionAtPath(binaryPath: string, requiredProduct?: string): Promise<string | undefined> {
	try {
		const child = Bun.spawn([binaryPath, "--version"], {
			env: requiredProduct ? { ...process.env, OMP_COMMAND: requiredProduct } : process.env,
			stdout: "pipe",
			stderr: "ignore",
		});
		const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
		if (exitCode !== 0) return undefined;
		return parseReportedVersion(output.trim(), requiredProduct);
	} catch {
		return undefined;
	}
}

/**
 * Run a specific binary and check if it reports the expected version.
 */
async function verifyBinaryAtPath(binaryPath: string, expectedVersion: string): Promise<InstalledVersionVerification> {
	const actual = await reportedVersionAtPath(binaryPath);
	return { ok: actual === expectedVersion, actual, path: binaryPath };
}

export async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const binaryPath = resolveOmpPath();
	return binaryPath ? verifyBinaryAtPath(binaryPath, expectedVersion) : { ok: false };
}

async function validateExistingUpdateTarget(targetPath: string): Promise<void> {
	let hasShebang = false;
	try {
		hasShebang = (await Bun.file(targetPath).slice(0, 2).text()) === "#!";
	} catch {}

	if (!hasShebang && (await reportedVersionAtPath(targetPath, COREFORGE_VERSION_PRODUCT)) !== undefined) return;

	const reason = hasShebang
		? "is a shebang script, not a Coreforge binary"
		: "does not report a Coreforge version when run directly";
	throw new Error(
		`Refusing to replace ${targetPath}: the resolved foreign symlink target ${reason}. Point PATH directly at the Coreforge binary you want to update, or reinstall through the Coreforge installer.`,
	);
}

function printVerifiedVersion(expectedVersion: string, binaryPath?: string): void {
	const icon = theme?.status?.success ?? "✔";
	const location = binaryPath ? ` at ${binaryPath}` : "";
	console.log(chalk.green(`\n${icon} Updated to ${expectedVersion}${location}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

/** Publish extension assets from a verified launcher, not from the process that updated it. */
export async function syncRelayAfterVerifiedUpdate(launcher: string | undefined): Promise<void> {
	if (!launcher) return;
	try {
		const result = await $`${launcher} browser-relay sync`.quiet().nothrow();
		if (result.exitCode !== 0) {
			logger.warn("browser relay sync after update failed", {
				launcher,
				exitCode: result.exitCode,
				error: result.stderr.toString().trim(),
			});
		}
	} catch (error) {
		logger.warn("browser relay sync after update failed", { launcher, error: String(error) });
	}
}

/** Report verification and publish assets only when the requested installed version was confirmed. */
async function finishVerifiedUpdate(result: InstalledVersionVerification, expectedVersion: string): Promise<void> {
	if (result.ok) {
		printVerifiedVersion(expectedVersion, result.path);
		await syncRelayAfterVerifiedUpdate(result.path);
		return;
	}
	console.log(chalk.yellow(`\nWarning: ${formatVerificationFailure(result, expectedVersion)}`));
	console.log(chalk.yellow("Reinstall through the Coreforge installer."));
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). On macOS the same unlink would instead succeed
 * while breaking the live process's TCC permission attribution — macOS
 * resolves grants against the executable's on-disk image path — so a `.bak`
 * still mapped by any process is retained for a later sweep. The replacement
 * and verification already succeeded by the time we get here, so every error
 * is swallowed; the leftover is reclaimed by {@link sweepStaleUpdateArtifacts}
 * on the next update once it is no longer in use. Returns whether the file is
 * gone.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	// macOS only, `.bak` only: a `.new` temp file is a download in progress,
	// never an installed image, and Windows/Linux locking is already handled by
	// the swallow below — so both stay ungated.
	if (process.platform === "darwin" && filePath.endsWith(".bak")) {
		// `/usr/sbin/lsof -t` prints the PIDs holding the file; exit 1 with
		// empty stdout and stderr is the only result that proves the file is
		// unused. Live users, a missing lsof, or diagnostics on stderr all
		// retain the file for a later sweep.
		let provenUnused = false;
		try {
			const result = await $`/usr/sbin/lsof -t -- ${filePath}`.quiet().nothrow();
			provenUnused = result.exitCode === 1 && result.stdout.length === 0 && result.stderr.length === 0;
		} catch {
			// lsof missing or failed to spawn — retain conservatively.
		}
		if (!provenUnused) return false;
	}
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update leftovers from earlier runs.
 *
 * Each self-update writes to `<binary>.<timestamp>.<pid>.new` and moves the
 * previous executable to `<binary>.<timestamp>.<pid>.bak` before swapping the
 * new one in. On Windows a backup cannot be deleted while the updating process
 * is alive (it is the running process image), so it is left for a later run to
 * reclaim once its owning process has exited. On macOS the sweep must also
 * spare a backup that any process still maps as its executable image —
 * unlinking it would break the live process's TCC permission attribution — so
 * a live image survives until its process exits. A `.new` temp file only
 * survives a hard kill mid-download; it is reaped once older than the download
 * window, which a live download cannot exceed without timing out and cleaning
 * up after itself — so a concurrent run's in-progress temp is never deleted. Legacy
 * fixed `<binary>.bak` / `<binary>.new` names (from before suffixes were made
 * unique) are matched too, so users upgrading from a buggy release get the
 * orphaned files cleaned up.
 */
export async function sweepStaleUpdateArtifacts(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`)) continue;
		const suffix = entry.endsWith(".bak") ? ".bak" : entry.endsWith(".new") ? ".new" : undefined;
		if (!suffix) continue;
		// Legacy "<base><suffix>" → empty middle; new "<base>.<timestamp>.<pid><suffix>"
		// → dot-separated numeric run. Anything else is an unrelated file.
		const middle = entry.slice(base.length + 1, entry.length - suffix.length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		const full = path.join(dir, entry);
		if (suffix === ".new") {
			// A temp file may belong to a concurrent update still downloading, so
			// only reap ones older than the download window.
			let mtimeMs: number;
			try {
				mtimeMs = (await fs.promises.stat(full)).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtimeMs < BINARY_DOWNLOAD_TIMEOUT_MS) continue;
		}
		await removeBackupBestEffort(full);
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		await options.validateExistingTarget?.();
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
		// A missing target is tolerated: repairing a launcher that a failed
		// package-manager reinstall removed installs the binary at a vacant
		// path. There is then nothing to restore, so a verification failure
		// leaves the new binary in place rather than the previous nothing.
		try {
			await fs.promises.rename(options.targetPath, options.backupPath);
			backupReady = true;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, and on
		// macOS unlinking the still-mapped backup would break the live image's
		// TCC permission attribution, so either way a failure here must NOT fail
		// an otherwise-successful update.
		await removeBackupBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

async function downloadCoreforgeBinary(
	targetPath: string,
	expectedVersion: string,
	binaryName: string,
	fetchImpl: Fetch | undefined,
	githubToken: string | undefined,
	onProgress?: UpdateProgressListener,
): Promise<string> {
	const requestOptions = {
		fetchImpl,
		tokenOverride: githubToken === undefined ? undefined : githubToken.trim() || null,
	};
	if (fetchImpl || githubToken !== undefined || lastCfRelease?.version !== expectedVersion) {
		lastCfRelease = await fetchLatestCoreforgeRelease(requestOptions);
	}
	if (lastCfRelease.version !== expectedVersion) {
		throw new Error(`GitHub release tag mismatch: expected v${expectedVersion}, received ${lastCfRelease.tag}`);
	}
	const matchingAssets = lastCfRelease.assets.filter(candidate => candidate.name === binaryName);
	if (matchingAssets.length !== 1) {
		throw new Error(`release ${lastCfRelease.tag} has ${matchingAssets.length} assets named ${binaryName}`);
	}
	const asset = matchingAssets[0]!;
	let trustedAssetUrl = false;
	try {
		const parsedUrl = new URL(asset.url);
		const pathPrefix = `/repos/${REPO}/releases/assets/`;
		trustedAssetUrl =
			parsedUrl.protocol === "https:" &&
			parsedUrl.hostname === "api.github.com" &&
			parsedUrl.pathname.startsWith(pathPrefix) &&
			/^\d+$/.test(parsedUrl.pathname.slice(pathPrefix.length));
	} catch {
		trustedAssetUrl = false;
	}
	if (!trustedAssetUrl) {
		throw new Error(`GitHub release asset ${binaryName} has an unexpected download URL`);
	}
	const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase();
	if (!digest) {
		throw new Error(`GitHub release asset ${binaryName} has no supported SHA-256 digest`);
	}
	const expectedDigest = `sha256:${digest}`;
	onProgress?.({ phase: "downloading", version: expectedVersion, received: 0, total: asset.size });
	await downloadVerifiedBinary({
		url: asset.url,
		targetPath,
		expectedSize: asset.size,
		expectedDigest,
		fetchImpl: (_input, init) => fetchCfAsset(asset, init?.signal ?? undefined, requestOptions),
		onProgress: received =>
			onProgress?.({ phase: "downloading", version: expectedVersion, received, total: asset.size }),
	});
	return expectedDigest;
}

// Monotonic within this process so two updates started in the same millisecond
// (same pid, same `Date.now()`) still get distinct temp/backup paths. Kept
// numeric so the artifact sweep's `\d+(\.\d+)*` matcher still reclaims them.
let updateAttemptSeq = 0;

/**
 * Download a release binary to a target path, replacing an existing file.
 * Private repository assets require the authenticated GitHub asset API.
 */
export async function updateViaBinaryAt(
	targetPath: string,
	expectedVersion: string,
	options: {
		binaryName?: string;
		fetchImpl?: Fetch;
		githubToken?: string;
		allowPrerelease?: boolean;
		/** Refuse replacement unless the existing path passes Coreforge ownership validation. */
		validateExistingTarget?: boolean | ((targetPath: string) => Promise<void>);
		verifyInstalledVersion?: (expectedVersion: string) => Promise<InstalledVersionVerification>;
		onProgress?: UpdateProgressListener;
	} = {},
): Promise<void> {
	const requestedValidator = options.validateExistingTarget;
	const validateExistingTarget =
		typeof requestedValidator === "function"
			? () => requestedValidator(targetPath)
			: requestedValidator
				? () => validateExistingUpdateTarget(targetPath)
				: undefined;
	await validateExistingTarget?.();
	const binaryName = options.binaryName ?? getBinaryName();
	// Unique per attempt so two overlapping `omp update` runs never share a temp
	// or backup path. A fixed temp name (`<binary>.new`) let the second run's
	// pre-download unlink delete the first run's still-downloading temp file; the
	// first kept writing to its open fd (size + digest still passed), then chmod
	// hit the missing path and the update aborted (issue #8434). The backup needs
	// the same uniqueness: a stale backup from an earlier update may still be
	// locked (the previous process image on Windows), so a fixed name would force
	// the move-aside rename to overwrite it. pid, timestamp, and a process-local
	// counter keep two updates started in the same millisecond from colliding.
	const attempt = `${Date.now()}.${process.pid}.${updateAttemptSeq++}`;
	const tempPath = `${targetPath}.${attempt}.new`;
	const backupPath = `${targetPath}.${attempt}.bak`;
	console.log(chalk.dim(`Downloading ${binaryName}…`));
	await downloadCoreforgeBinary(
		tempPath,
		expectedVersion,
		binaryName,
		options.fetchImpl,
		options.githubToken,
		options.onProgress,
	);

	// Serialize the target swap and stale-artifact sweep per target so two
	// overlapping `omp update` runs never replace the same binary concurrently
	// or reclaim each other's live backup/temp files. The download above writes
	// to a unique temp path and is safe to overlap; only the swap is shared.
	const verification = await withFileLock(targetPath, async () => {
		console.log(chalk.dim("Installing update..."));
		options.onProgress?.({ phase: "installing", version: expectedVersion });
		const result = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion,
			validateExistingTarget,
			verifyInstalledVersion: options.verifyInstalledVersion ?? (version => verifyBinaryAtPath(targetPath, version)),
		});
		// The launcher is no longer bun-managed: drop bun's metadata sidecar so
		// the next update classifies this install as a standalone binary instead
		// of reinstalling a package that can no longer own the launcher (bun
		// tolerates failing to overwrite the running `.exe`, so that reinstall
		// would leave the install pinned to the old version). Done after the
		// verified swap, so a rollback still restores a working bun shim, and
		// best effort: a leftover sidecar only costs one misrouted classification.
		try {
			await unlinkIfExists(bunShimMarkerPath(targetPath));
		} catch {}
		// Reclaim backups from earlier updates whose owning process has since exited.
		await sweepStaleUpdateArtifacts(targetPath);
		return result;
	});
	await finishVerifiedUpdate({ ...verification, path: verification.path ?? targetPath }, expectedVersion);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

export async function runUpdateCommand(opts: UpdateOptions): Promise<UpdateOutcome> {
	const ompPath = resolveOmpPath();
	const manager = ompPath ? await managedInstallName(ompPath) : undefined;
	if (manager) {
		const reason = `${ompPath} is installed and kept up to date by ${manager}; update it from ${manager}.`;
		console.log(chalk.yellow(reason));
		return { kind: "unsupported", reason };
	}
	console.log(chalk.dim(`Current version: ${CF_VERSION}`));

	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		throw new Error(`Failed to check for updates: ${err}`, { cause: err });
	}

	const comparison = compareCfVersions(release.version, CF_VERSION);

	if (comparison <= 0 && !opts.force) {
		const icon = theme?.status?.success ?? "✔";
		console.log(chalk.green(`${icon} Already up to date`));
		return { kind: "current" };
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		// Just check, don't install
		return { kind: "available", version: release.version };
	}

	// Coreforge releases are compiled binaries from the private mirror. Do not
	// route through upstream package managers or distribution channels.
	try {
		const target = await resolveUpdateTarget({ allowPackageManagers: true });
		if (target.method !== "binary") {
			throw new Error(
				`the ${APP_NAME} on PATH was installed via ${target.method} (upstream channel); ` +
					"coreforge updates only manage the compiled binary - reinstall via the coreforge installer",
			);
		}
		await updateViaBinaryAt(target.path, release.version, {
			validateExistingTarget: target.validateExistingTarget,
			onProgress: opts.onProgress,
		});
	} catch (err) {
		throw new Error(`Update failed: ${err}`, { cause: err });
	}
	return { kind: "installed", version: release.version };
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins
`);
}
