import { describe, expect, it } from "bun:test";
import {
	CF_BRAND,
	CF_VERSION,
	compareCfProductVersions,
	compareCfVersions,
	isCfProductVersion,
} from "@oh-my-pi/pi-coding-agent/cli/cf-version";

/**
 * Channel versions ordered strictly ascending. Mixes 3- and 4-segment forms:
 * a 4-segment patch roll sits between its upstream base and the next upstream
 * version, and any upstream bump outranks every patch roll of an older base.
 */
const ASCENDING = ["16.3.11", "16.3.11.1", "16.3.11.2", "16.3.12", "16.4.0", "17.0.0"];

describe("compareCfVersions ordering", () => {
	it("orders the channel version chain strictly ascending (all pairs, both directions)", () => {
		for (let i = 0; i < ASCENDING.length; i++) {
			for (let j = i + 1; j < ASCENDING.length; j++) {
				const lower = ASCENDING[i];
				const higher = ASCENDING[j];
				expect(compareCfVersions(lower, higher)).toBeLessThan(0);
				expect(compareCfVersions(higher, lower)).toBeGreaterThan(0);
			}
		}
	});

	it("returns 0 for identical versions", () => {
		for (const version of ASCENDING) {
			expect(compareCfVersions(version, version)).toBe(0);
		}
	});

	it("treats missing segments as 0", () => {
		expect(compareCfVersions("16.3.11", "16.3.11.0")).toBe(0);
		expect(compareCfVersions("16.3.11.0", "16.3.11")).toBe(0);
		expect(compareCfVersions("16.3.11", "16.3.11.1")).toBeLessThan(0);
	});

	it("always ranks an upstream bump above any patch roll of an older upstream", () => {
		// The critical channel invariant: once upstream 16.3.12 is rolled into
		// the mirror, no 16.3.11.N patch roll may compare newer.
		expect(compareCfVersions("16.3.11.5", "16.3.12")).toBeLessThan(0);
		expect(compareCfVersions("16.3.11.999", "16.3.12")).toBeLessThan(0);
		expect(compareCfVersions("16.3.12", "16.3.11.999")).toBeGreaterThan(0);
		expect(compareCfVersions("16.3.11.42", "16.4.0")).toBeLessThan(0);
		expect(compareCfVersions("16.3.11.42", "17.0.0")).toBeLessThan(0);
	});

	it("compares segments numerically, not lexicographically", () => {
		// String comparison would invert all of these.
		expect(compareCfVersions("16.3.9", "16.3.11")).toBeLessThan(0);
		expect(compareCfVersions("16.9.0", "16.10.0")).toBeLessThan(0);
		expect(compareCfVersions("9.0.0", "16.0.0")).toBeLessThan(0);
		expect(compareCfVersions("16.3.11.9", "16.3.11.10")).toBeLessThan(0);
	});

	it("flips sign when arguments swap", () => {
		const versions = [...ASCENDING, "16.3.9", "16.10.0", "16.3.11.0"];
		for (const a of versions) {
			for (const b of versions) {
				// Antisymmetry over {-1, 0, 1}; sum form avoids Object.is(-0, 0) noise.
				expect(Math.sign(compareCfVersions(a, b)) + Math.sign(compareCfVersions(b, a))).toBe(0);
			}
		}
	});

	it("sorts a shuffled list into the channel order", () => {
		const shuffled = ["16.4.0", "16.3.11.2", "17.0.0", "16.3.11", "16.3.12", "16.3.11.1"];
		expect(shuffled.toSorted(compareCfVersions)).toEqual(ASCENDING);
	});
});

describe("Coreforge product version ordering", () => {
	const versions = ["1.0.1", "1.0.2-beta.1", "1.0.2-beta.10", "1.0.2", "1.1.0-beta.1"];

	it("orders beta rolls below their stable release", () => {
		expect(versions.toSorted(compareCfProductVersions)).toEqual(versions);
		expect(compareCfProductVersions("1.0.2", "1.0.2-beta.999")).toBeGreaterThan(0);
	});

	it("accepts only stable and numbered beta product versions", () => {
		for (const version of versions) expect(isCfProductVersion(version)).toBe(true);
		for (const version of ["1.0.2-alpha.1", "1.0.2-beta.0", "1.0.2.3", "01.0.2"]) {
			expect(isCfProductVersion(version)).toBe(false);
		}
	});
});

describe("CF_VERSION", () => {
	it("is a 3- or 4-segment dotted-numeric version", () => {
		// Dev/source builds fall back to the upstream 3-segment version; release
		// builds carry the 4-segment channel version. Either way it must be
		// consumable by compareCfVersions.
		expect(CF_VERSION).toMatch(/^\d+\.\d+\.\d+(\.\d+)?$/);
		expect(compareCfVersions(CF_VERSION, CF_VERSION)).toBe(0);
	});
});

describe("CF_BRAND", () => {
	it("is a non-empty display brand", () => {
		// Shape only — the exact default/override is asserted via child spawns
		// below (this process may inherit an OMP_BRAND from the host).
		expect(CF_BRAND.length).toBeGreaterThan(0);
	});
});

// The constants resolve from the environment once, at module import, so the
// precedence rules can only be exercised from fresh child processes.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const modUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "src", "cli", "cf-version.ts")).href;

function readConst(
	name: "CF_VERSION" | "CF_PRODUCT_VERSION" | "CF_DISPLAY_VERSION" | "CF_BRAND" | "CF_COMMAND",
	env: Record<string, string | undefined>,
): string {
	const code = `import { ${name} } from ${JSON.stringify(modUrl)}; process.stdout.write(${name} ?? "");`;
	const res = spawnSync(process.execPath, ["-e", code], {
		env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
		encoding: "utf8",
	});
	expect(res.status, res.stderr).toBe(0);
	return res.stdout.trim();
}

describe("channel version resolution precedence", () => {
	// Source builds carry no stamped CF_VERSION_OVERRIDE, so the launcher's
	// OMP_CF_VERSION is how they learn the 4-segment channel version.
	it("adopts a valid OMP_CF_VERSION from the launcher", () => {
		expect(readConst("CF_VERSION", { OMP_CF_VERSION: "16.4.2.1" })).toBe("16.4.2.1");
	});

	it("ignores a malformed OMP_CF_VERSION and falls back to upstream VERSION", () => {
		const fallback = readConst("CF_VERSION", {});
		expect(readConst("CF_VERSION", { OMP_CF_VERSION: "not-a-version" })).toBe(fallback);
		expect(readConst("CF_VERSION", { OMP_CF_VERSION: "" })).toBe(fallback);
	});

	it("uses the launcher product version only for product-facing display", () => {
		const env = { OMP_CF_VERSION: "17.0.2.3", OMP_CF_PRODUCT_VERSION: "1.4.0" };
		expect(readConst("CF_PRODUCT_VERSION", env)).toBe("1.4.0");
		expect(readConst("CF_DISPLAY_VERSION", env)).toBe("1.4.0");
		expect(readConst("CF_VERSION", env)).toBe("17.0.2.3");
		const betaEnv = { OMP_CF_VERSION: "17.0.2.3", OMP_CF_PRODUCT_VERSION: "1.5.0-beta.12" };
		expect(readConst("CF_PRODUCT_VERSION", betaEnv)).toBe("1.5.0-beta.12");
		expect(readConst("CF_DISPLAY_VERSION", betaEnv)).toBe("1.5.0-beta.12");

		const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
		const result = spawnSync(process.execPath, [cli, "--version"], {
			env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("coreforge/17.0.2.3");
	});

	it("keeps malformed or missing product metadata out of the product channel", () => {
		expect(readConst("CF_PRODUCT_VERSION", { OMP_CF_VERSION: "17.0.2.3", OMP_CF_PRODUCT_VERSION: "rolling" })).toBe(
			"",
		);
		expect(readConst("CF_PRODUCT_VERSION", { OMP_CF_PRODUCT_VERSION: "17.0.2.3" })).toBe("");
		expect(readConst("CF_PRODUCT_VERSION", {})).toBe("");
	});

	it("falls back to the engine version for display when product metadata is invalid", () => {
		const env = { OMP_CF_VERSION: "17.0.2.3", OMP_CF_PRODUCT_VERSION: "rolling" };
		expect(readConst("CF_DISPLAY_VERSION", env)).toBe("17.0.2.3");

		const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
		const result = spawnSync(process.execPath, [cli, "--version"], {
			env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("coreforge/17.0.2.3");
	});

	it("honors OMP_BRAND override, else defaults to coreforge", () => {
		expect(readConst("CF_BRAND", { OMP_BRAND: "acme-cli" })).toBe("acme-cli");
		expect(readConst("CF_BRAND", { OMP_BRAND: "Acme CLI" })).toBe("Acme CLI"); // display allows prose
		expect(readConst("CF_BRAND", {})).toBe("coreforge");
	});

	it("honors a single-token OMP_COMMAND, else falls back to coreforge", () => {
		// CF_COMMAND lands in copy-paste hints, so it must stay runnable.
		expect(readConst("CF_COMMAND", { OMP_COMMAND: "acme" })).toBe("acme");
		expect(readConst("CF_COMMAND", { OMP_COMMAND: "acme-cli.v2" })).toBe("acme-cli.v2");
		expect(readConst("CF_COMMAND", {})).toBe("coreforge");
	});

	it("rejects an unrunnable OMP_COMMAND (prose / metacharacters) -> coreforge", () => {
		// The reviewer's exact case: a prose brand reused as the command would
		// print `Acme CLI --resume <id>`, which is not a runnable command.
		expect(readConst("CF_COMMAND", { OMP_COMMAND: "Acme CLI" })).toBe("coreforge");
		expect(readConst("CF_COMMAND", { OMP_COMMAND: "acme; rm -rf /" })).toBe("coreforge");
		expect(readConst("CF_COMMAND", { OMP_COMMAND: "" })).toBe("coreforge");
		// A prose OMP_BRAND must NOT bleed into the command.
		expect(readConst("CF_COMMAND", { OMP_BRAND: "Acme CLI" })).toBe("coreforge");
	});
});
