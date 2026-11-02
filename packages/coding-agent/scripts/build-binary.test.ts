import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $ } from "bun";
import { resolveCrossBuild } from "./build-binary";
import { compileCodingAgent } from "./compile-binary";

describe("Windows release binary target", () => {
	it("resolves local Windows cross-build aliases for both architectures", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("win32-arm64")).toEqual({
			id: "win32-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
		expect(resolveCrossBuild("windows-arm64")).toEqual({
			id: "windows-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
	});
});

it("runs compiled bytecode containing dependency import.meta.resolve calls", async () => {
	using temp = TempDir.createSync("@omp-bytecode-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	await Bun.write(entrypoint, 'console.log(import.meta.resolve("node:fs"));\n');
	const shouldAdhocSign = process.platform === "darwin";
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
		skipBuiltinCodesign: shouldAdhocSign,
		native: null,
	});
	if (shouldAdhocSign) await $`codesign --force --sign - ${outfile}`.quiet();
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("node:fs");
}, 30_000);

it("runs code behind a lazy import() from a split chunk of the compiled binary", async () => {
	using temp = TempDir.createSync("@omp-split-chunk-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	await Bun.write(temp.join("lazy.ts"), 'export const value = ["lazy", "chunk"].join(" ");\n');
	await Bun.write(entrypoint, 'const { value } = await import("./lazy.ts");\nconsole.log(value);\n');
	const shouldAdhocSign = process.platform === "darwin";
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		transformersVersion: "unused",
		skipBuiltinCodesign: shouldAdhocSign,
		native: null,
	});
	if (shouldAdhocSign) await $`codesign --force --sign - ${outfile}`.quiet();
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("lazy chunk");
}, 30_000);
