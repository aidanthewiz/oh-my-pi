import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CF_ENGINE_RELEASE_REPO } from "@oh-my-pi/pi-coding-agent/cli/cf-channel";
import * as pluginCli from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import * as updateCli from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import {
	buildBunInstallArgs,
	buildHomebrewUpdateArgs,
	buildMiseForceInstallArgs,
	buildMiseUpgradeArgs,
	buildNpmInstallArgs,
	downloadVerifiedBinary,
	isMuslLinuxForTest,
	parseUpdateArgs,
	pruneBunInstallCache,
	replaceBinaryForUpdate,
	resolveBunGlobalNodeModulesDirFromLocations,
	resolveReleaseBinaryAsset,
	resolveUpdateMethodForTest,
	resolveUpdateTargetFromPath,
	sweepStaleUpdateArtifacts,
	updateViaBinaryAt,
} from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import Update from "@oh-my-pi/pi-coding-agent/commands/update";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-test-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();

	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("keeps normal update flags on the app updater path", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["--check", "--force"], TEST_CONFIG);
		await command.run();

		expect(updateSpy).toHaveBeenCalledWith({ force: true, check: true });
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});

describe("parseUpdateArgs", () => {
	it("preserves the legacy plugin update shorthand", () => {
		expect(parseUpdateArgs(["update", "-l"])).toEqual({ force: false, check: false, plugins: true });
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
		// to overwrite the existing executable.
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/omp", undefined, {
			npmBinDir: "/home/u/.local/bin",
			ompIsRegularFile: true,
		});

		expect(method).toBe("binary");
	});

	it("uses binary update when a plain file in the bun global bin dir is the standalone binary", () => {
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/omp", "/home/u/.local/bin", {
			ompIsRegularFile: true,
		});

		expect(method).toBe("binary");
	});

	it("keeps bun update for regular-file entries in the bun global bin dir on Windows, where bun writes .exe shims", () => {
		// On Windows a bun-managed global install is a regular-file .exe
		// launcher, not a symlink, so the standalone-binary override must not
		// apply there — it would clobber the shim with a raw binary. Paths use
		// forward slashes so the lexical containment check works on the POSIX
		// host running this suite; the platform gate is what is under test.
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platformDescriptor) throw new Error("process.platform descriptor missing");
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		try {
			const method = resolveUpdateMethodForTest("C:/Users/test/.bun/bin/omp.exe", "C:/Users/test/.bun/bin", {
				ompIsRegularFile: true,
			});

			expect(method).toBe("bun");
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
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

		expect(target).toEqual({ method: "binary", path: standalonePath, replacesSymlink: false });
		expect(await fs.readlink(aliasPath)).toBe(standalonePath);
	});

	it("keeps an npm-linked checkout under npm management instead of overwriting its resolved script", async () => {
		const dir = await makeTempDir();
		const npmPrefix = path.join(dir, ".npm-global");
		const npmBinDir = path.join(npmPrefix, "bin");
		const packagePath = path.join(npmPrefix, "lib", "node_modules", "@oh-my-pi", "pi-coding-agent");
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

		expect(target).toEqual({ method: "binary", path: standalonePath, replacesSymlink: false });
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

		expect(target).toEqual({ method: "binary", path: standalonePath, replacesSymlink: false });
		expect(await fs.readlink(launcherPath)).toBe(standalonePath);
	});

	it("takes over a package-manager launcher in place on a binary-only release", async () => {
		// A bun/npm-managed launcher symlinks into the manager's node_modules.
		// A forced binary release cannot route through the manager, so the
		// launcher is deliberately replaced in place, keeping the PATH entry live.
		const dir = await makeTempDir();
		const npmPrefix = path.join(dir, ".npm-global");
		const npmBinDir = path.join(npmPrefix, "bin");
		const managedBinary = path.join(npmPrefix, "lib", "node_modules", "@oh-my-pi", "pi-coding-agent", "omp");
		const aliasPath = path.join(npmBinDir, "omp");
		await fs.mkdir(npmBinDir, { recursive: true });
		await fs.mkdir(path.dirname(managedBinary), { recursive: true });
		await Bun.write(managedBinary, "binary");
		await fs.symlink(managedBinary, aliasPath);

		const target = resolveUpdateTargetFromPath(aliasPath, undefined, {
			allowPackageManagers: false,
			npmBinDir,
		});

		expect(target).toEqual({ method: "binary", path: aliasPath, replacesSymlink: true });
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

describe("update-cli package manager commands", () => {
	it("targets the Homebrew tap formula and switches to reinstall for forced updates", () => {
		expect(buildHomebrewUpdateArgs(false)).toEqual(["upgrade", "can1357/tap/omp"]);
		expect(buildHomebrewUpdateArgs(true)).toEqual(["reinstall", "can1357/tap/omp"]);
	});

	it("targets the mise GitHub backend tool and force-reinstalls the checked version when requested", () => {
		expect(buildMiseUpgradeArgs()).toEqual(["upgrade", "github:can1357/oh-my-pi", "--bump"]);
		expect(buildMiseForceInstallArgs("15.10.5")).toEqual(["install", "--force", "github:can1357/oh-my-pi@15.10.5"]);
	});

	it("pins npm package installs to the official registry and the checked native package versions", () => {
		const args = buildNpmInstallArgs("16.3.15", "win32-x64");

		expect(args.slice(0, 2)).toEqual(["install", "-g"]);
		expect(args).toContain("--registry=https://registry.npmjs.org/");
		expect(args).toContain("@oh-my-pi/pi-coding-agent@16.3.15");
		expect(args).toContain("@oh-my-pi/pi-natives@16.3.15");
		expect(args).toContain("@oh-my-pi/pi-natives-win32-x64@16.3.15");
	});
});

describe("update-cli package argument compatibility", () => {
	it("installs custom package names in lock-step, with no default-name leftovers in the argv", () => {
		const packages = { pkg: "@new/omp", natives: "@new/natives" };

		const bunArgs = buildBunInstallArgs("17.0.0", "linux-x64", packages);
		expect(bunArgs).toContain("@new/omp@17.0.0");
		expect(bunArgs).toContain("@new/natives@17.0.0");
		expect(bunArgs).toContain("@new/natives-linux-x64@17.0.0");
		expect(bunArgs.some(arg => arg.startsWith("@oh-my-pi/"))).toBe(false);

		expect(buildNpmInstallArgs("17.0.0", "linux-x64", packages)).toContain("@new/omp@17.0.0");
	});

	it("adds --force to npm argv only for rename migrations so the old package's bin can be clobbered", () => {
		const packages = { pkg: "@new/omp", natives: "@new/natives" };
		expect(buildNpmInstallArgs("17.0.0", "linux-x64", packages, { force: true })).toContain("--force");
		expect(buildNpmInstallArgs("16.3.15", "win32-x64")).not.toContain("--force");
	});
});

describe("update-cli bun install command", () => {
	it("pins the official npm registry and bypasses the manifest cache so a stale mirror or snapshot cannot mask a freshly published version", () => {
		// Regression: omp queries https://registry.npmjs.org/<pkg>/latest directly.
		// The install MUST hit the same registry, otherwise:
		//   - a lagging mirror (corp proxy, Taobao, …) rejects the version with
		//     `No version matching "X" (but package exists)`,
		//   - or bun's local manifest snapshot does the same when the user's bun
		//     is already pointed at the official registry but its cache predates
		//     the release.
		// See https://github.com/can1357/oh-my-pi/issues/1686.
		const args = buildBunInstallArgs("15.7.6", "linux-x64");
		expect(args.slice(0, 5)).toEqual([
			"install",
			"-g",
			"--no-cache",
			"--registry=https://registry.npmjs.org/",
			"@oh-my-pi/pi-coding-agent@15.7.6",
		]);
	});

	it("pins the native addon core and the platform-specific leaf to the same version so the loader sentinel cannot drift on supported tags", () => {
		// Regression: bun install -g <pkg>@<v> would update only the top-level
		// package, leaving @oh-my-pi/pi-natives and @oh-my-pi/pi-natives-<tag>
		// at their previous version. The next launch then loaded a stale .node
		// file and aborted at validateLoadedBindings with `The .node file on
		// disk is from a different release than this loader`. See
		// https://github.com/can1357/oh-my-pi/issues/1824.
		for (const tag of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
			const args = buildBunInstallArgs("15.9.0", tag);
			expect(args).toContain("@oh-my-pi/pi-natives@15.9.0");
			expect(args).toContain(`@oh-my-pi/pi-natives-${tag}@15.9.0`);
		}
	});

	it("omits the leaf on unsupported platform tags so an EBADPLATFORM swap does not mask the underlying `no matching version` error", () => {
		// Defensive: an unsupported tag (e.g. linux-arm32) still installs the
		// core natives package — which will fail at module load if the platform
		// truly is unsupported — but we never request a leaf the release
		// pipeline doesn't publish, otherwise bun aborts with EBADPLATFORM
		// and hides the real diagnostic from `loadNative`'s aggregated error.
		const args = buildBunInstallArgs("15.9.0", "linux-arm");
		expect(args).toContain("@oh-my-pi/pi-natives@15.9.0");
		expect(args.some(arg => arg.startsWith("@oh-my-pi/pi-natives-"))).toBe(false);
	});

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
	const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;

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

	it("rejects release metadata that does not identify one exact stable asset", () => {
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), prerelease: true }, tag, binaryName)).toThrow(
			"is not a published stable release",
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
		expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
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
				expectedDigest: `sha256:${createHash("sha256").update("different binary").digest("hex")}`,
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
		const expectedDigest = `sha256:${createHash("sha256")
			.update("x".repeat(Buffer.byteLength(altered)))
			.digest("hex")}`;
		await Bun.write(targetPath, installed);
		await fs.chmod(targetPath, 0o755);

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
		expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
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

describe("update-cli concurrent binary updates", () => {
	const version = "999.0.0";
	const tag = `v${version}`;
	const binaryName = "omp-linux-x64";
	const url = `https://github.com/${CF_ENGINE_RELEASE_REPO}/releases/download/${tag}/${binaryName}`;
	const assetApiUrl = `https://api.github.com/repos/${CF_ENGINE_RELEASE_REPO}/releases/assets/999`;
	const payload = Buffer.alloc(2048, 0x41);
	const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;

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
