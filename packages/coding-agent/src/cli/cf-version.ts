/**
 * Coreforge channel version.
 *
 * package.json stays 3-segment semver (bun, workspace importers, and npm
 * tooling all parse it). The channel version adds a 4th ".N" patch-roll
 * segment ("16.3.11.2" = upstream 16.3.11 + coreforge roll 2) and lives only
 * in the generated override + the release tag. Dev/source builds fall back
 * to the bare upstream version.
 */
// The CLI imports this module before worker dispatch. Keep this subpath import
// side-effect-free so process-level handlers cannot preempt worker-core guards.
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { CF_VERSION_OVERRIDE } from "./cf-version.generated";

const CF_VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const CF_PRODUCT_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$/;

/**
 * The coreforge channel version, resolved in priority order:
 *   1. `CF_VERSION_OVERRIDE` — stamped into cf-version.generated.ts at
 *      release-build time for the compiled binary channel. Authoritative: a
 *      self-updated binary can be AHEAD of the launcher's `engine.lock`, and a
 *      stale or spoofed wrapper env must not downgrade or misreport it.
 *   2. `OMP_CF_VERSION` — exported by the coreforge launcher from `engine.lock`'s
 *      `version`. This is how the SOURCE channel (which runs the TS directly and
 *      carries no stamped override) learns its 4-segment channel version;
 *      without it, source runs report the bare upstream version and the
 *      self-update check reads perpetually "behind" the 4-segment release tag.
 *   3. `VERSION` — bare upstream semver, last-resort dev fallback.
 */
function resolveCfVersion(): string {
	if (CF_VERSION_OVERRIDE) return CF_VERSION_OVERRIDE;
	const fromLauncher = process.env.OMP_CF_VERSION?.trim();
	if (fromLauncher && CF_VERSION_RE.test(fromLauncher)) return fromLauncher;
	return VERSION;
}

export const CF_VERSION: string = resolveCfVersion();

/**
 * The independently released Coreforge product version shown in the managed
 * UI. The launcher resolves it from a stable or opted-in beta Coreforge tag.
 * It is absent during direct engine use, where the engine channel remains
 * authoritative.
 */
export function isCfProductVersion(version: string): boolean {
	return CF_PRODUCT_VERSION_RE.test(version);
}

function resolveCfProductVersion(): string | undefined {
	const fromLauncher = process.env.OMP_CF_PRODUCT_VERSION?.trim();
	if (fromLauncher && isCfProductVersion(fromLauncher)) return fromLauncher;
	return undefined;
}

export const CF_PRODUCT_VERSION: string | undefined = resolveCfProductVersion();
export const CF_DISPLAY_VERSION: string = CF_PRODUCT_VERSION ?? CF_VERSION;

/** Compare stable and beta Coreforge product SemVer values. */
export function compareCfProductVersions(a: string, b: string): number {
	const pa = CF_PRODUCT_VERSION_RE.exec(a);
	const pb = CF_PRODUCT_VERSION_RE.exec(b);
	if (!pa || !pb) throw new Error(`invalid Coreforge product version: ${!pa ? a : b}`);
	for (let i = 1; i <= 3; i++) {
		const difference = Number(pa[i]) - Number(pb[i]);
		if (difference !== 0) return difference;
	}
	const aRoll = pa[4] ? Number(pa[4]) : undefined;
	const bRoll = pb[4] ? Number(pb[4]) : undefined;
	if (aRoll === undefined) return bRoll === undefined ? 0 : 1;
	if (bRoll === undefined) return -1;
	return aRoll - bRoll;
}

/**
 * User-facing DISPLAY brand for banner chrome (e.g. the welcome box title).
 * May be a prose name like `Acme CLI`. Distinct from `APP_NAME` (pi-utils),
 * the on-disk identifier (`~/.omp`, log names, XDG dirs) that MUST stay `omp`
 * so paths and profiles resolve. Override with `OMP_BRAND` for white-label.
 */
export const CF_BRAND: string = process.env.OMP_BRAND?.trim() || "coreforge";

/**
 * Invokable COMMAND name shown in copy-paste hints (`<cmd> --resume <id>`, help
 * examples). Unlike `CF_BRAND` this must be a real runnable executable — the
 * wrapper on PATH — so it is kept separate AND validated: a white-label with a
 * prose `OMP_BRAND` ("Acme CLI") still needs a runnable `OMP_COMMAND` ("acme").
 * `OMP_COMMAND` is honored only when it is a single shell-safe token (one word,
 * no whitespace/quotes/control/metacharacters); anything else — including a
 * prose name accidentally reused from the brand — falls back to `coreforge`
 * so the printed hint is always something the user can actually run.
 */
const CF_COMMAND_RE = /^[A-Za-z0-9._+-]+$/;
function resolveCfCommand(): string {
	const raw = process.env.OMP_COMMAND?.trim();
	return raw && CF_COMMAND_RE.test(raw) ? raw : "coreforge";
}
export const CF_COMMAND: string = resolveCfCommand();

/**
 * Compare dotted-numeric versions of any segment count ("16.3.11" vs
 * "16.3.11.2"). Missing segments count as 0, so an upstream bump always
 * outranks a patch roll of the older upstream. Not semver - the channel
 * version is not valid semver and Bun.semver rejects it.
 */
export function compareCfVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}
