import { describe, expect, it } from "bun:test";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { COMPILED_EXTERNAL_DEPENDENCIES } from "../packages/coding-agent/scripts/compile-binary";
import { BINARY_TARGETS } from "./ci-release-build-binaries";

describe("Windows release binary target", () => {
	it("builds the generic Windows release asset with the baseline runtime", () => {
		const target = BINARY_TARGETS.find(candidate => candidate.id === "win32-x64");
		expect(target).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
			outfile: "packages/coding-agent/binaries/omp-windows-x64.exe",
		});
		expect(COMPILED_EXTERNAL_DEPENDENCIES).toContain("fastembed");
		expect(COMPILED_EXTERNAL_DEPENDENCIES).toContain("onnxruntime-node");
	});

	it("uses the baseline runtime for local Windows cross-build aliases", () => {
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
	});
});
