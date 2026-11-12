/**
 * WebKit mode: an explicitly enabled ABKit host process, speaking Tern's
 * browser protocol over its standard streams (`host.ts`). The default
 * engine directory belongs to the active profile. Explicit executable
 * paths remain operator-owned; installation requires separate authority.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { expandTilde, getTrustedEnvValue, getWebKitHostPath, parseFlag } from "@oh-my-pi/pi-utils";

/** The host executable's file name inside an engine directory: `ABHost`, on Windows `ABHost.exe`. */
export function hostExecutableName(platform: NodeJS.Platform): string {
	return platform === "win32" ? "ABHost.exe" : "ABHost";
}

/** The engine's viewer program, beside the host executable in engines that ship one (macOS): it shows the host's pages in windows. */
const VIEWER_NAME = "ABView";

/** Platforms whose released engines ship {@link VIEWER_NAME} (ABKit's `docs/installing.md`): only there can a downloaded engine show a window. */
export const VIEWER_PLATFORMS: readonly NodeJS.Platform[] = ["darwin"];

/** Browser kind selecting omp's own WebKit host process. */
export interface WebKitKind {
	kind: "webkit";
	/** Absolute path of the host executable. */
	path: string;
	/** Absolute path of the engine's viewer program, when it ships one: what lets a tab have a window. */
	viewer?: string;
}

/** Inputs of {@link resolveWebKitKind}. */
export interface ResolveWebKitKindOptions {
	/** `browser.webkit` setting (default false); `PI_BROWSER_WEBKIT=0|1` overrides selection only. */
	settingEnabled?: boolean;
	/** `browser.webkitPath` setting: the engine directory or its host executable. */
	settingPath?: string;
}

/**
 * The host executable `location` names, or null when there is none to run: a
 * directory is an engine directory and holds it under the platform's file
 * name; a file is the executable itself, whatever it is called.
 */
export function hostExecutableAt(location: string, platform: NodeJS.Platform): string | null {
	const resolved = path.resolve(expandTilde(location));
	try {
		const candidate = fs.statSync(resolved).isDirectory()
			? path.join(resolved, hostExecutableName(platform))
			: resolved;
		if (!fs.statSync(candidate).isFile()) return null;
		fs.accessSync(candidate, fs.constants.X_OK);
		return candidate;
	} catch {
		return null;
	}
}

/** The viewer program of the engine whose host executable is `executable` (a link is followed to the engine), if it ships one. */
function viewerOf(executable: string): string | undefined {
	try {
		const candidate = path.join(path.dirname(fs.realpathSync(executable)), VIEWER_NAME);
		if (!fs.statSync(candidate).isFile()) return undefined;
		fs.accessSync(candidate, fs.constants.X_OK);
		return candidate;
	} catch {
		return undefined;
	}
}

/**
 * Resolve omp's WebKit browser kind, or null when the backend is off or its
 * host executable is not installed. The executable comes from the first of
 * `PI_BROWSER_WEBKIT_PATH` and the `browser.webkitPath` setting that is set,
 * else from where the engine is installed ({@link getWebKitHostPath}): a
 * location that is set but holds no executable does not fall through to the
 * next. Like `resolveTernKind`, the
 * setting opts in and the env flag is the final override in both directions.
 * `platform` picks the executable's file name inside an engine directory.
 */
export function resolveWebKitKind(
	options?: ResolveWebKitKindOptions | null,
	env: Record<string, string | undefined> = {
		PI_BROWSER_WEBKIT: getTrustedEnvValue("PI_BROWSER_WEBKIT"),
		PI_BROWSER_WEBKIT_PATH: getTrustedEnvValue("PI_BROWSER_WEBKIT_PATH"),
	},
	platform: NodeJS.Platform = process.platform,
): WebKitKind | null {
	if (!parseFlag(env.PI_BROWSER_WEBKIT, options?.settingEnabled ?? false)) return null;
	const location = env.PI_BROWSER_WEBKIT_PATH?.trim() || options?.settingPath?.trim() || getWebKitHostPath(platform);
	const executable = hostExecutableAt(location, platform);
	if (executable === null) return null;
	const viewer = viewerOf(executable);
	return viewer === undefined ? { kind: "webkit", path: executable } : { kind: "webkit", path: executable, viewer };
}

/**
 * The engine directory a download would fill for this configuration, or null:
 * only the profile-owned default, while the backend is selected and neither
 * `PI_BROWSER_WEBKIT_PATH` nor `browser.webkitPath` names another location.
 * This resolves a destination; it does not authorize installation.
 */
export function webKitEngineToInstall(
	options?: ResolveWebKitKindOptions | null,
	env: Record<string, string | undefined> = {
		PI_BROWSER_WEBKIT: getTrustedEnvValue("PI_BROWSER_WEBKIT"),
		PI_BROWSER_WEBKIT_PATH: getTrustedEnvValue("PI_BROWSER_WEBKIT_PATH"),
	},
	platform: NodeJS.Platform = process.platform,
): string | null {
	if (!parseFlag(env.PI_BROWSER_WEBKIT, options?.settingEnabled ?? false)) return null;
	if (env.PI_BROWSER_WEBKIT_PATH?.trim() || options?.settingPath?.trim()) return null;
	const engineDir = path.dirname(getWebKitHostPath(platform));
	return hostExecutableAt(engineDir, platform) === null ? engineDir : null;
}
