import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CF_ENGINE_RELEASE_REPO } from "@oh-my-pi/pi-coding-agent/cli/cf-channel";
import { managedInstallName } from "@oh-my-pi/pi-coding-agent/cli/managed-install";
import {
	downloadVerifiedBinary,
	isMuslLinuxForTest,
	parseReportedVersion,
	parseUpdateArgs,
	pruneBunInstallCache,
	replaceBinaryForUpdate,
	resolveBunGlobalNodeModulesDirFromLocations,
	resolveGitHubTokenForTest,
	resolveReleaseBinaryAsset,
	resolveUpdateMethodForTest,
	resolveUpdateTargetFromPath,
	sweepStaleUpdateArtifacts,
	updateViaBinaryAt,
} from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-test-")));
	tempDirs.push(dir);
	return dir;
}
/**
 * Run `fn` with `process.platform` reporting `platform`. Launcher
 * classification and recovery hints are platform-gated, so the gate itself has
 * to be driven from whichever host runs this suite.
 */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!platformDescriptor) throw new Error("process.platform descriptor missing");
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
	}
}

/** npm's global layout: `<prefix>/bin` + `<prefix>/lib/node_modules` on POSIX; both rooted at `<prefix>` on Windows. */
function npmGlobalLayout(prefix: string): { binDir: string; nodeModulesDir: string } {
	return process.platform === "win32"
		? { binDir: prefix, nodeModulesDir: path.join(prefix, "node_modules") }
		: { binDir: path.join(prefix, "bin"), nodeModulesDir: path.join(prefix, "lib", "node_modules") };
}

afterEach(async () => {
	vi.restoreAllMocks();

	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("parseUpdateArgs", () => {
	it("preserves the legacy plugin update shorthand", () => {
		expect(parseUpdateArgs(["update", "-l"])).toEqual({
			force: false,
			check: false,
			plugins: true,
		});
	});
});

describe("GitHub update credentials", () => {
	it("prefers an explicit environment token over gh auth", async () => {
		let calls = 0;
		const token = await resolveGitHubTokenForTest({
			envToken: "env-token",
			ghPath: "gh",
			runGhAuthToken: async () => {
				calls += 1;
				return "keyring-token";
			},
		});
		expect(token).toBe("env-token");
		expect(calls).toBe(0);
	});

	it("uses gh auth when no environment token is configured", async () => {
		const token = await resolveGitHubTokenForTest({
			envToken: "",
			ghPath: "gh",
			runGhAuthToken: async () => "keyring-token  ",
		});
		expect(token).toBe("keyring-token");
	});

	it("falls back to GH_TOKEN when GITHUB_TOKEN is empty", async () => {
		const previousGitHubToken = Bun.env.GITHUB_TOKEN;
		const previousGhToken = Bun.env.GH_TOKEN;
		Bun.env.GITHUB_TOKEN = "";
		Bun.env.GH_TOKEN = "gh-env-token";
		try {
			expect(await resolveGitHubTokenForTest({ ghPath: null })).toBe("gh-env-token");
		} finally {
			if (previousGitHubToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousGitHubToken;
			if (previousGhToken === undefined) delete Bun.env.GH_TOKEN;
			else Bun.env.GH_TOKEN = previousGhToken;
		}
	});

	it("keeps anonymous fallback when gh is unavailable", async () => {
		const token = await resolveGitHubTokenForTest({ envToken: "", ghPath: null });
		expect(token).toBeUndefined();
	});
});

describe("parseReportedVersion", () => {
	it("preserves the prerelease suffix so a canary launcher verifies as up to date", () => {
		// Regression: dropping `-canary.1` made a correctly installed canary
		// build look like a stale `X.Y.Z` launcher, triggering a needless
		// binary repair.
		expect(parseReportedVersion("omp/18.0.6-canary.1")).toBe("18.0.6-canary.1");
		expect(parseReportedVersion("coreforge/18.0.6.1")).toBe("18.0.6.1");
		expect(parseReportedVersion("omp/18.0.5")).toBe("18.0.5");
		expect(parseReportedVersion("not a version")).toBeUndefined();
	});

	it("rejects version output from a different executable", () => {
		expect(parseReportedVersion("node/18.0.5")).toBeUndefined();
		expect(parseReportedVersion("codex/18.0.5")).toBeUndefined();
	});

	it("requires Coreforge provenance when validating a foreign update target", () => {
		expect(parseReportedVersion("coreforge/18.1.15.4", "coreforge")).toBe("18.1.15.4");
		expect(parseReportedVersion("omp/18.1.16", "coreforge")).toBeUndefined();
	});
});

describe("update-cli libc detection", () => {
	it("does not mistake an installed musl loader for a glibc host", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39",
			}),
		).toBe(false);
	});

	it("recognizes a musl host from ldd output", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "musl libc (x86_64)",
			}),
		).toBe(true);
	});
});

describe("update-cli install target detection", () => {
	it("leaves Nix store installations under Nix management", () => {
		const method = resolveUpdateMethodForTest(
			"/nix/store/0123456789-omp-17.2.15/bin/omp",
			"/nix/store/9876543210-bun-1.3.14/bin",
		);

		expect(method).toBe("nix");
	});

	it("uses bun update when prioritized omp is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses npm update when prioritized omp is inside an npm global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.npm-global/bin/omp", undefined, {
			npmBinDir: "/Users/test/.npm-global/bin",
		});

		expect(method).toBe("npm");
	});

	it("uses npm update for Windows npm command shims even when no package-manager bin dirs were detected", () => {
		const method = resolveUpdateMethodForTest("C:\\Users\\test\\AppData\\Roaming\\npm\\omp.cmd", undefined);

		expect(method).toBe("npm");
	});

	it("uses binary update when a plain file in the npm global bin dir is the standalone binary, not an npm symlink", () => {
		// Regression: with `npm prefix -g` pointed at the installer's default
		// (~/.local), directory containment alone misclassified the standalone
		// binary as npm-managed, so `npm install -g` failed with EEXIST refusing
		// to overwrite the existing executable. POSIX layout: on Windows an
		// extensionless launcher is npm's sh shim (covered by the win32 cases).
		const method = withPlatform("linux", () =>
			resolveUpdateMethodForTest("/home/u/.local/bin/omp", undefined, {
				npmBinDir: "/home/u/.local/bin",
				ompIsRegularFile: true,
			}),
		);

		expect(method).toBe("binary");
	});

	it("uses binary update when a plain file in the bun global bin dir is the standalone binary", () => {
		const method = withPlatform("linux", () =>
			resolveUpdateMethodForTest("/home/u/.local/bin/omp", "/home/u/.local/bin", {
				ompIsRegularFile: true,
			}),
		);

		expect(method).toBe("binary");
	});

	it("keeps bun update for regular-file entries in the bun global bin dir on Windows, where bun writes .exe shims", () => {
		// On Windows a bun-managed global install is a regular-file .exe
		// launcher, not a symlink, so the standalone-binary override cannot key
		// off file type — it keys off bun's `<name>.bunx` metadata sidecar, which
		// only a bun-managed launcher has. Paths use forward slashes so the
		// lexical containment check works on the POSIX host running this suite.
		const method = withPlatform("win32", () =>
			resolveUpdateMethodForTest("C:/Users/test/.bun/bin/omp.exe", "C:/Users/test/.bun/bin", {
				ompIsRegularFile: true,
				bunShimMarker: true,
			}),
		);

		expect(method).toBe("bun");
	});

	it("uses binary update for a Windows .exe in the bun global bin dir once bun's metadata sidecar is gone", () => {
		// Regression: a binary-only release replaces bun's launcher with the
		// standalone binary. Classifying that by directory alone sent the next
		// update back through `bun install -g`, which cannot overwrite the
		// running .exe — bun tolerates that EBUSY — so the install stayed pinned
		// to the old version with no way forward.
		const method = withPlatform("win32", () =>
			resolveUpdateMethodForTest("C:/Users/test/.bun/bin/omp.exe", "C:/Users/test/.bun/bin", {
				ompIsRegularFile: true,
			}),
		);

		expect(method).toBe("binary");
	});

	it("still uses npm update when the npm global bin entry is a package-manager symlink, not a plain file", () => {
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/omp", undefined, {
			npmBinDir: "/home/u/.local/bin",
			ompIsRegularFile: false,
		});

		expect(method).toBe("npm");
	});

	it("updates the standalone binary behind a foreign npm-bin alias without replacing the alias", async () => {
		const dir = await makeTempDir();
		const npmBinDir = path.join(dir, ".npm-global", "bin");
		const standalonePath = path.join(dir, ".local", "bin", "omp");
		const aliasPath = path.join(npmBinDir, "omp");
		await fs.mkdir(npmBinDir, { recursive: true });
		await Bun.write(standalonePath, "binary");
		await fs.symlink(standalonePath, aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
			allowPackageManagers: true,
			npmBinDir,
		});

		expect(target).toEqual({
			method: "binary",
			path: standalonePath,
			replacesSymlink: false,
			validateExistingTarget: true,
		});
		expect(await fs.readlink(aliasPath)).toBe(standalonePath);
	});

	it("keeps an npm-linked checkout under npm management instead of overwriting its resolved script", async () => {
		const dir = await makeTempDir();
		const npmPrefix = path.join(dir, ".npm-global");
		const { binDir: npmBinDir, nodeModulesDir } = npmGlobalLayout(npmPrefix);
		const packagePath = path.join(nodeModulesDir, "@oh-my-pi", "pi-coding-agent");
		const checkoutPath = path.join(dir, "checkout");
		const checkoutCli = path.join(checkoutPath, "dist", "cli.js");
		const aliasPath = path.join(npmBinDir, "omp");
		await fs.mkdir(npmBinDir, { recursive: true });
		await fs.mkdir(path.dirname(packagePath), { recursive: true });
		await Bun.write(checkoutCli, "linked checkout");
		await fs.symlink(checkoutPath, packagePath, "junction");
		await fs.symlink(path.relative(npmBinDir, path.join(packagePath, "dist", "cli.js")), aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
			allowPackageManagers: true,
			npmBinDir,
		});

		expect(await fs.realpath(aliasPath)).toBe(checkoutCli);
		expect(target).toEqual({ method: "npm", path: aliasPath });
		expect(await Bun.file(checkoutCli).text()).toBe("linked checkout");
	});

	it("treats a Bun-bin alias into ~/.bun/custom as foreign", async () => {
		const dir = await makeTempDir();
		const bunDir = path.join(dir, ".bun");
		const bunBinDir = path.join(bunDir, "bin");
		const standalonePath = path.join(bunDir, "custom", "omp");
		const aliasPath = path.join(bunBinDir, "omp");
		await fs.mkdir(bunBinDir, { recursive: true });
		await Bun.write(standalonePath, "binary");
		await fs.symlink(path.relative(bunBinDir, standalonePath), aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, bunBinDir, {
			allowPackageManagers: true,
		});

		expect(target).toEqual({
			method: "binary",
			path: standalonePath,
			replacesSymlink: false,
			validateExistingTarget: true,
		});
	});

	it("resolves a foreign symlink to its real binary on a binary-only release instead of clobbering the launcher", async () => {
		// Admin shared-install layout: a non-manager symlink in PATH points into
		// a shared install dir. On a binary-only release the target must still be
		// the resolved binary, not the launcher — otherwise the update writes
		// beside a root-owned symlink (EACCES) or replaces it with a split-brain
		// copy that shadows the shared install (#8732).
		const dir = await makeTempDir();
		const sharedBinDir = path.join(dir, "opt", "omp", "bin");
		const standalonePath = path.join(sharedBinDir, "omp");
		const launcherDir = path.join(dir, "usr", "local", "bin");
		const launcherPath = path.join(launcherDir, "omp");
		await fs.mkdir(sharedBinDir, { recursive: true });
		await fs.mkdir(launcherDir, { recursive: true });
		await Bun.write(standalonePath, "binary");
		await fs.symlink(standalonePath, launcherPath);

		const target = resolveUpdateTargetFromPath(launcherPath, undefined, {
			allowPackageManagers: false,
		});

		expect(target).toEqual({
			method: "binary",
			path: standalonePath,
			replacesSymlink: false,
			validateExistingTarget: true,
		});
		expect(await fs.readlink(launcherPath)).toBe(standalonePath);
	});

	it.skipIf(process.platform === "win32")(
		"refuses to overwrite a shared shebang dispatcher behind a foreign symlink",
		async () => {
			const dir = await makeTempDir();
			const dispatcherPath = path.join(dir, "launch");
			const aliasPath = path.join(dir, "omp");
			const dispatcher = "#!/bin/sh\necho dispatcher\n";
			await Bun.write(dispatcherPath, dispatcher);
			await fs.chmod(dispatcherPath, 0o755);
			await fs.symlink("launch", aliasPath);
			const fetchImpl = vi.fn(async () => new Response());

			const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
				allowPackageManagers: true,
			});
			if (target.method !== "binary") throw new Error("Expected binary update target");

			await expect(
				updateViaBinaryAt(target.path, "18.1.13", {
					binaryName: "omp-linux-x64",
					fetchImpl,
					validateExistingTarget: target.validateExistingTarget,
				}),
			).rejects.toThrow(`Refusing to replace ${dispatcherPath}`);
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(await Bun.file(dispatcherPath).text()).toBe(dispatcher);
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses a foreign native target that does not report an OMP version",
		async () => {
			const dir = await makeTempDir();
			const foreignPath = path.join(dir, "foreign");
			const aliasPath = path.join(dir, "omp");
			await fs.copyFile(process.execPath, foreignPath);
			await fs.chmod(foreignPath, 0o755);
			await fs.symlink(foreignPath, aliasPath);
			const fetchImpl = vi.fn(async () => new Response());
			const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
				allowPackageManagers: true,
			});
			if (target.method !== "binary") throw new Error("Expected binary update target");

			await expect(
				updateViaBinaryAt(target.path, "18.1.13", {
					binaryName: "omp-linux-x64",
					fetchImpl,
					validateExistingTarget: target.validateExistingTarget,
				}),
			).rejects.toThrow("does not report a Coreforge version when run directly");
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("takes over a package-manager launcher in place on a binary-only release", async () => {
		// A bun/npm-managed launcher symlinks into the manager's node_modules.
		// A forced binary release cannot route through the manager, so the
		// launcher is deliberately replaced in place, keeping the PATH entry live.
		const dir = await makeTempDir();
		const npmPrefix = path.join(dir, ".npm-global");
		const { binDir: npmBinDir, nodeModulesDir } = npmGlobalLayout(npmPrefix);
		const managedBinary = path.join(nodeModulesDir, "@oh-my-pi", "pi-coding-agent", "omp");
		const aliasPath = path.join(npmBinDir, "omp");
		await fs.mkdir(npmBinDir, { recursive: true });
		await fs.mkdir(path.dirname(managedBinary), { recursive: true });
		await Bun.write(managedBinary, "binary");
		await fs.symlink(managedBinary, aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
			allowPackageManagers: false,
			npmBinDir,
		});

		expect(target).toEqual({
			method: "binary",
			path: aliasPath,
			replacesSymlink: true,
			validateExistingTarget: false,
		});
	});

	it("keeps a split-root Bun-linked checkout under Bun management instead of overwriting its script", async () => {
		const dir = await makeTempDir();
		const bunBinDir = path.join(dir, "bun-bin");
		const bunGlobalDir = path.join(dir, "bun-global");
		const packagePath = path.join(bunGlobalDir, "node_modules", "@oh-my-pi", "pi-coding-agent");
		const checkoutPath = path.join(dir, "checkout");
		const checkoutCli = path.join(checkoutPath, "dist", "cli.js");
		const aliasPath = path.join(bunBinDir, "omp");
		await fs.mkdir(bunBinDir, { recursive: true });
		await fs.mkdir(path.dirname(packagePath), { recursive: true });
		await Bun.write(checkoutCli, "linked checkout");
		await fs.symlink(checkoutPath, packagePath, "junction");
		await fs.symlink(path.relative(bunBinDir, path.join(packagePath, "dist", "cli.js")), aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, bunBinDir, {
			allowPackageManagers: true,
			bunGlobalDir,
		});

		expect(await fs.realpath(aliasPath)).toBe(checkoutCli);
		expect(target).toEqual({ method: "bun", path: aliasPath });
		expect(await Bun.file(checkoutCli).text()).toBe("linked checkout");
	});

	it("uses binary update when prioritized omp is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", undefined);

		expect(method).toBe("binary");
	});

	it("uses Homebrew update when prioritized omp resolves into the Homebrew formula", async () => {
		const dir = await makeTempDir();
		const prefix = path.join(dir, "opt", "omp");
		const linkedBin = path.join(dir, "bin");
		await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
		await fs.mkdir(linkedBin, { recursive: true });
		await Bun.write(path.join(prefix, "bin", "omp"), "binary");
		await fs.symlink(path.join(prefix, "bin", "omp"), path.join(linkedBin, "omp"));

		const method = resolveUpdateMethodForTest(path.join(linkedBin, "omp"), "/Users/test/.bun/bin", {
			homebrewPrefix: prefix,
		});

		expect(method).toBe("brew");
	});

	it("uses mise update when prioritized omp is in an active mise bin path", () => {
		const method = resolveUpdateMethodForTest(
			"/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin/omp",
			undefined,
			{
				miseBinDirs: ["/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin"],
			},
		);

		expect(method).toBe("mise");
	});

	it("uses mise update when prioritized omp is a mise shim", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/mise/shims/omp", undefined, {
			miseDataDir: "/Users/test/.local/share/mise",
		});

		expect(method).toBe("mise");
	});
});

describe("update-cli bun paths", () => {
	it("derives global node_modules from supported Bun locations with the explicit global directory taking precedence", () => {
		expect(
			resolveBunGlobalNodeModulesDirFromLocations({
				globalBinDir: path.join("home", ".bun", "bin"),
			}),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
		expect(
			resolveBunGlobalNodeModulesDirFromLocations({
				cacheDir: path.join("home", ".bun", "install", "cache"),
			}),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
		expect(
			resolveBunGlobalNodeModulesDirFromLocations({
				globalDir: path.join("root", "bun-global"),
				globalBinDir: path.join("root", "bun-bin"),
			}),
		).toBe(path.join("root", "bun-global", "node_modules"));
	});
});

describe("update-cli bun cache pruning", () => {
	it("keeps only the newest cached version for filtered global install packages", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "react", "18.3.1@@@1"), "");
		await Bun.write(path.join(dir, "react", "19.2.6@@@1"), "");
		await Bun.write(
			path.join(dir, "react@18.3.1@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "18.3.1" }),
		);
		await Bun.write(
			path.join(dir, "react@19.2.6@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "19.2.6" }),
		);
		await Bun.write(path.join(dir, "@oh-my-pi", "pi-utils", "15.7.6@@@1"), "");
		await Bun.write(path.join(dir, "@oh-my-pi", "pi-utils", "15.8.0@@@1"), "");
		await Bun.write(
			path.join(dir, "@oh-my-pi", "pi-utils@15.7.6@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "15.7.6" }),
		);
		await Bun.write(
			path.join(dir, "@oh-my-pi", "pi-utils@15.8.0@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "15.8.0" }),
		);
		await Bun.write(path.join(dir, "chalk", "4.1.2@@@1"), "");
		await Bun.write(path.join(dir, "chalk", "5.6.2@@@1"), "");
		await Bun.write(
			path.join(dir, "chalk@4.1.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "4.1.2" }),
		);
		await Bun.write(
			path.join(dir, "chalk@5.6.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "5.6.2" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["react", "@oh-my-pi/pi-utils"]));

		expect(result).toEqual({ scannedPackages: 2, removedEntries: 4 });
		expect(await Bun.file(path.join(dir, "react", "18.3.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react@18.3.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react", "19.2.6@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "react@19.2.6@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils", "15.7.6@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils@15.7.6@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils", "15.8.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils@15.8.0@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk", "4.1.2@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk@4.1.2@@@1", "package.json")).exists()).toBe(true);
	});

	it("keeps current registry-qualified marker entries with their materialized package", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 0 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json")).exists()).toBe(true);
	});

	it("treats a stable release as newer than a matching prerelease", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0-beta.1@@@1"), "");
		await Bun.write(path.join(dir, "pkg", "1.0.0@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0-beta.1" }),
		);
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir);

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0-beta.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@@1", "package.json")).exists()).toBe(true);
	});

	it("compares numeric version segments without precision loss", async () => {
		const dir = await makeTempDir();
		const older = "1.0.99999999999999999999";
		const newer = "1.0.100000000000000000000";
		await Bun.write(path.join(dir, "pkg", `${older}@@@1`), "");
		await Bun.write(path.join(dir, "pkg", `${newer}@@@1`), "");
		await Bun.write(
			path.join(dir, `pkg@${older}@@@1`, "package.json"),
			JSON.stringify({ name: "pkg", version: older }),
		);
		await Bun.write(
			path.join(dir, `pkg@${newer}@@@1`, "package.json"),
			JSON.stringify({ name: "pkg", version: newer }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", `${older}@@@1`)).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, `pkg@${older}@@@1`, "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", `${newer}@@@1`)).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, `pkg@${newer}@@@1`, "package.json")).exists()).toBe(true);
	});
});

describe("update-cli release binary integrity", () => {
	const tag = "v17.1.2";
	const binaryName = "omp-linux-x64";
	const url = `https://github.com/${CF_ENGINE_RELEASE_REPO}/releases/download/${tag}/${binaryName}`;
	const assetApiUrl = `https://api.github.com/repos/${CF_ENGINE_RELEASE_REPO}/releases/assets/123`;
	const content = "verified binary";
	const digest = `sha256:${Bun.SHA256.hash(content, "hex")}`;

	function releaseAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			tag_name: tag,
			draft: false,
			prerelease: false,
			assets: [
				{
					name: binaryName,
					state: "uploaded",
					url: assetApiUrl,
					size: Buffer.byteLength(content),
					digest,
					browser_download_url: url,
					...overrides,
				},
			],
		};
	}

	it("selects an uploaded asset with a valid SHA-256 digest", () => {
		expect(resolveReleaseBinaryAsset(releaseAsset(), tag, binaryName)).toEqual({
			url,
			size: Buffer.byteLength(content),
			digest,
		});
	});

	it("rejects missing and unsupported release asset digests", () => {
		expect(() => resolveReleaseBinaryAsset(releaseAsset({ digest: null }), tag, binaryName)).toThrow("has no digest");
		expect(() => resolveReleaseBinaryAsset(releaseAsset({ digest: "sha512:abc" }), tag, binaryName)).toThrow(
			"has an unsupported digest",
		);
	});

	it("rejects a draft, a stable-channel prerelease, and metadata without one exact asset", () => {
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), draft: true }, tag, binaryName)).toThrow(
			"is a draft",
		);
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), prerelease: true }, tag, binaryName)).toThrow(
			"is a prerelease",
		);
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), assets: [] }, tag, binaryName)).toThrow(
			`has 0 assets named ${binaryName}`,
		);
		expect(() =>
			resolveReleaseBinaryAsset(
				{ ...releaseAsset(), assets: [releaseAsset().assets, releaseAsset().assets].flat() },
				tag,
				binaryName,
			),
		).toThrow(`has 2 assets named ${binaryName}`);
		expect(() =>
			resolveReleaseBinaryAsset(
				releaseAsset({ browser_download_url: "https://example.com/omp-linux-x64" }),
				tag,
				binaryName,
			),
		).toThrow("has an unexpected download URL");
	});

	it("installs a prerelease asset only when a canary update permits it", () => {
		// Canary GitHub releases are marked prerelease; a canary update passes
		// allowPrerelease so its exact-tag asset installs, while a draft stays
		// rejected even then.
		expect(
			resolveReleaseBinaryAsset({ ...releaseAsset(), prerelease: true }, tag, binaryName, { allowPrerelease: true }),
		).toEqual({ url, size: Buffer.byteLength(content), digest });
		expect(() =>
			resolveReleaseBinaryAsset({ ...releaseAsset(), draft: true }, tag, binaryName, { allowPrerelease: true }),
		).toThrow("is a draft");
	});
	it("writes a download only after its size and digest match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);

		await downloadVerifiedBinary({
			url,
			targetPath,
			expectedSize: Buffer.byteLength(content),
			expectedDigest: digest,
			fetchImpl: async () => new Response(content),
		});

		expect(await Bun.file(targetPath).text()).toBe(content);
		// Windows has no POSIX mode bits; the executable bit is only observable elsewhere.
		if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
	});

	it("aborts the response stream as soon as it exceeds the expected size", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array(pulls === 1 ? 2 : 1));
					if (pulls === 2) controller.close();
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: 1,
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("received at least 2");
		expect(pulls).toBe(1);
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("wraps a timeout during body streaming with a friendly message", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(1));
					controller.error(new DOMException("The operation timed out.", "TimeoutError"));
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("Timed out downloading release binary after 15 minutes");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("removes downloads whose size or digest does not match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const fetchImpl = async () => new Response(content);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content) + 1,
				expectedDigest: digest,
				fetchImpl,
			}),
		).rejects.toThrow("size mismatch");
		expect(await Bun.file(targetPath).exists()).toBe(false);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: `sha256:${Bun.SHA256.hash("different binary", "hex")}`,
				fetchImpl,
			}),
		).rejects.toThrow("digest mismatch");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("rejects an altered executable before replacing the installed binary", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const installed = "#!/bin/sh\necho omp/17.0.8\n";
		const altered = "#!/bin/sh\necho omp/17.1.2\n";
		await Bun.write(targetPath, installed);
		await fs.chmod(targetPath, 0o755);
		const expectedDigest = `sha256:${Bun.SHA256.hash("x".repeat(Buffer.byteLength(altered)), "hex")}`;

		const requestAuthorizations: Array<string | null> = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.endsWith("/releases/latest")) {
				requestAuthorizations.push(new Headers(init?.headers).get("Authorization"));
				return Response.json(
					releaseAsset({
						size: Buffer.byteLength(altered),
						digest: expectedDigest,
					}),
				);
			}
			if (requestUrl === assetApiUrl) {
				requestAuthorizations.push(new Headers(init?.headers).get("Authorization"));
				return new Response(altered);
			}
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		await expect(
			updateViaBinaryAt(targetPath, "17.1.2", {
				binaryName,
				fetchImpl,
				githubToken: "test-token",
			}),
		).rejects.toThrow("digest mismatch");
		expect(requestAuthorizations).toEqual(["Bearer test-token", "Bearer test-token"]);
		expect(await Bun.file(targetPath).text()).toBe(installed);
		if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
		const newResidue = (await fs.readdir(dir)).filter(name => name.endsWith(".new"));
		expect(newResidue).toEqual([]);
	});

	it("explains how to authenticate when private-channel credentials are unavailable", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		let fetchCalls = 0;
		const fetchImpl = async () => {
			fetchCalls++;
			return new Response(null, { status: 403, statusText: "Forbidden" });
		};

		await expect(
			updateViaBinaryAt(targetPath, "17.1.2", {
				binaryName,
				fetchImpl,
				githubToken: "",
			}),
		).rejects.toThrow("set GITHUB_TOKEN or run `gh auth login`");
		expect(fetchCalls).toBe(0);
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("revalidates a foreign target under its replacement lock after download", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		await Bun.write(targetPath, "owned Coreforge binary");
		const validateExistingTarget = async (pathToValidate: string) => {
			if ((await Bun.file(pathToValidate).text()) !== "owned Coreforge binary") {
				throw new Error("target ownership changed");
			}
		};
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.endsWith("/releases/latest")) return Response.json(releaseAsset());
			if (requestUrl === assetApiUrl) {
				await Bun.write(targetPath, "foreign replacement");
				return new Response(content);
			}
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		await expect(
			updateViaBinaryAt(targetPath, "17.1.2", {
				binaryName,
				fetchImpl,
				githubToken: "test-token",
				validateExistingTarget,
			}),
		).rejects.toThrow("target ownership changed");
		expect(await Bun.file(targetPath).text()).toBe("foreign replacement");
		expect((await fs.readdir(dir)).filter(name => name.endsWith(".new") || name.endsWith(".bak"))).toEqual([]);
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous omp binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
	it("installs at a vacated launcher path when the previous launcher is gone", async () => {
		// Repairing a launcher a failed package-manager reinstall deleted: there
		// is nothing to move aside, so the swap must still land instead of
		// aborting on ENOENT and leaving the user without a launcher.
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(tempPath, "new binary");

		const result = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(result.ok).toBe(true);
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale update artifact sweep", () => {
	it("reclaims timestamped and legacy backups and orphaned temps while sparing in-progress temps and unrelated files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Orphaned temp files from a hard-killed download: reaped once older than
		// the download window. Legacy fixed name and timestamped name both count.
		const stale = new Date(Date.now() - 60 * 60 * 1000);
		await Bun.write(`${targetPath}.new`, "legacy temp");
		await fs.utimes(`${targetPath}.new`, stale, stale);
		await Bun.write(`${targetPath}.1700000000000.4242.new`, "timestamped temp");
		await fs.utimes(`${targetPath}.1700000000000.4242.new`, stale, stale);
		// Must survive: a fresh temp still belongs to a concurrent, in-progress
		// download (unique per attempt), plus foreign basenames and non-numeric
		// middle segments.
		await Bun.write(`${targetPath}.9999999999999.7.new`, "in-progress temp");
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");
		await Bun.write(`${targetPath}.config.new`, "keep me three");

		await sweepStaleUpdateArtifacts(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.new`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.new`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.9999999999999.7.new`).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.new`).exists()).toBe(true);
	});
});

describe.skipIf(process.platform !== "darwin")("update-cli macOS live backup images", () => {
	// Regression for the macOS TCC image-path requirement: a `.bak` is the
	// previous executable and another process may still be running it, so it
	// must survive both the immediate post-swap cleanup and later sweeps until
	// its image exits, then be reclaimable. `process.execPath` under `bun
	// test` is the bun runtime — a real Mach-O whose copy can be held live.
	// (Copies of Apple trust-cache binaries like /bin/sleep are SIGKILLed by
	// macOS when executed from a new path, so they cannot serve here.)
	it("retains a backup whose image a live process runs across cleanup and sweep, then reclaims it after the process exits", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		await fs.copyFile(process.execPath, targetPath);
		const live = Bun.spawn([targetPath, "-e", "console.log('ready'); await Bun.stdin.text()"], {
			stdout: "pipe",
			stdin: "pipe",
			stderr: "inherit",
		});
		try {
			const reader = live.stdout.getReader();
			try {
				const first = await reader.read();
				expect(new TextDecoder().decode(first.value).trim()).toBe("ready");
			} finally {
				reader.releaseLock();
			}
			expect(live.exitCode, `live image exited with ${live.signalCode}`).toBeNull();
			// Real-time waits, not fake timers: these wait on genuine kernel and
			// process state (lsof visibility of the live image, vnode release
			// after exit) that no in-test clock controls.
			// The image must actually be live and visible to lsof, or the
			// retention assertions below would pass for the wrong reason.
			let liveImageVisible = false;
			for (let i = 0; i < 20 && !liveImageVisible; i++) {
				const seen = Bun.spawnSync(["/usr/sbin/lsof", "-t", "--", targetPath]);
				liveImageVisible = seen.exitCode === 0 && seen.stdout.toString().includes(String(live.pid));
				if (!liveImageVisible) await Bun.sleep(100);
			}
			expect(liveImageVisible).toBe(true);

			const attempt = "1700000000000.4242";
			const tempPath = `${targetPath}.${attempt}.new`;
			const backupPath = `${targetPath}.${attempt}.bak`;
			await Bun.write(tempPath, "new binary");

			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
			// The swap landed and the temp was consumed, but the live image's
			// backup must remain on disk.
			expect(await Bun.file(targetPath).text()).toBe("new binary");
			expect(await Bun.file(tempPath).exists()).toBe(false);
			expect(await Bun.file(backupPath).exists()).toBe(true);
			expect(live.exitCode, `live image exited with ${live.signalCode}`).toBeNull();

			// A later sweep must spare it too.
			await sweepStaleUpdateArtifacts(targetPath);
			expect(await Bun.file(backupPath).exists()).toBe(true);

			live.kill();
			await live.exited;

			// Once the image is gone, the backup is reclaimable.
			for (let i = 0; i < 20 && (await Bun.file(backupPath).exists()); i++) {
				await sweepStaleUpdateArtifacts(targetPath);
				await Bun.sleep(100);
			}
			expect(await Bun.file(backupPath).exists()).toBe(false);
		} finally {
			live.kill();
			await live.exited;
		}
	});
});

describe("update-cli concurrent binary updates", () => {
	const version = "999.0.0";
	const tag = `v${version}`;
	const binaryName = "omp-linux-x64";
	const url = `https://github.com/${CF_ENGINE_RELEASE_REPO}/releases/download/${tag}/${binaryName}`;
	const assetApiUrl = `https://api.github.com/repos/${CF_ENGINE_RELEASE_REPO}/releases/assets/999`;
	const payload = Buffer.alloc(2048, 0x41);
	const digest = `sha256:${Bun.SHA256.hash(payload, "hex")}`;

	function metadata(): Response {
		return Response.json({
			tag_name: tag,
			draft: false,
			prerelease: false,
			assets: [
				{
					name: binaryName,
					state: "uploaded",
					url: assetApiUrl,
					size: payload.byteLength,
					digest,
					browser_download_url: url,
				},
			],
		});
	}

	const fastFetch = async (input: string | URL | Request): Promise<Response> => {
		const requestUrl = String(input);
		if (requestUrl.endsWith("/releases/latest")) return metadata();
		if (requestUrl === assetApiUrl) return new Response(payload);
		throw new Error(`Unexpected request: ${requestUrl}`);
	};

	const verify = async () => ({ ok: true, actual: version });

	async function prepare(): Promise<{ dir: string; targetPath: string }> {
		const loadedTheme = await getThemeByName("dark");
		if (!loadedTheme) throw new Error("theme unavailable");
		setThemeInstance(loadedTheme);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		await Bun.write(targetPath, "old binary");
		return { dir, targetPath };
	}

	it("lets an overlapping slow run install after a fast run completes", async () => {
		const { dir, targetPath } = await prepare();
		const aWroteFirstChunk = Promise.withResolvers<void>();
		const letAFinish = Promise.withResolvers<void>();
		const slowFetch = async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.endsWith("/releases/latest")) return metadata();
			if (requestUrl === assetApiUrl) {
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(payload.subarray(0, 1024));
							aWroteFirstChunk.resolve();
							await letAFinish.promise;
							controller.enqueue(payload.subarray(1024));
							controller.close();
						},
					}),
				);
			}
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		const runA = updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: slowFetch,
			githubToken: "test-token",
			verifyInstalledVersion: verify,
		});
		await aWroteFirstChunk.promise;
		await updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: fastFetch,
			githubToken: "test-token",
			verifyInstalledVersion: verify,
		});
		letAFinish.resolve();
		await runA;

		expect(await Bun.file(targetPath).bytes()).toEqual(new Uint8Array(payload));
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".new"));
		expect(residue).toEqual([]);
	});

	it("rolls back its backup when verification fails while another update runs", async () => {
		const { dir, targetPath } = await prepare();
		const enteredVerify = Promise.withResolvers<void>();
		const releaseVerify = Promise.withResolvers<void>();
		const failingVerify = async () => {
			enteredVerify.resolve();
			await releaseVerify.promise;
			return { ok: false, actual: "0.0.0", path: targetPath };
		};

		const runA = updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: fastFetch,
			githubToken: "test-token",
			verifyInstalledVersion: failingVerify,
		});
		await enteredVerify.promise;
		const runB = updateViaBinaryAt(targetPath, version, {
			binaryName,
			fetchImpl: fastFetch,
			githubToken: "test-token",
			verifyInstalledVersion: verify,
		});
		releaseVerify.resolve();
		await expect(runA).rejects.toThrow(/still reports 0\.0\.0 \(expected 999\.0\.0\)/);
		await runB;

		expect(await Bun.file(targetPath).bytes()).toEqual(new Uint8Array(payload));
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"));
		expect(residue).toEqual([]);
	});
});

describe("managedInstallName", () => {
	async function managedRoot(): Promise<string> {
		const root = await makeTempDir();
		await fs.mkdir(path.join(root, "versions"));
		await fs.mkdir(path.join(root, "bin"));
		await Bun.write(path.join(root, "versions", "1.0.0"), "omp");
		await Bun.write(path.join(root, "manager.json"), JSON.stringify({ manager: "tern", name: "Tern" }));
		return root;
	}

	it.skipIf(process.platform === "win32")(
		"names the manager through the launcher symlink and a link outside the root",
		async () => {
			const root = await managedRoot();
			const launcher = path.join(root, "bin", "omp");
			await fs.symlink(path.join("..", "versions", "1.0.0"), launcher);
			const outside = path.join(await makeTempDir(), "omp");
			await fs.symlink(launcher, outside);

			expect(await managedInstallName(launcher)).toBe("Tern");
			expect(await managedInstallName(outside)).toBe("Tern");
		},
	);

	it("names the manager of a copied launcher (Windows layout)", async () => {
		const root = await managedRoot();
		const copy = path.join(root, "bin", "omp.exe");
		await Bun.write(copy, "omp");

		expect(await managedInstallName(copy)).toBe("Tern");
	});

	it("treats a binary without a readable manifest as unmanaged", async () => {
		const plain = path.join(await makeTempDir(), "bin", "omp");
		await Bun.write(plain, "omp");
		expect(await managedInstallName(plain)).toBeUndefined();

		const root = await managedRoot();
		await Bun.write(path.join(root, "manager.json"), "{not json");
		expect(await managedInstallName(path.join(root, "versions", "1.0.0"))).toBeUndefined();
	});
});
