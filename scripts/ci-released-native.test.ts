import { expect, test } from "bun:test";
import { expectedChecksum, isNativeBuildPath, selectLatestCoreforceRelease } from "./ci-released-native";

test("selects the highest published roll for the exact engine version", () => {
	expect(
		selectLatestCoreforceRelease("18.1.15", [
			{ tagName: "v18.1.15.2" },
			{ tagName: "v18.1.16.1" },
			{ tagName: "v18.1.15.11" },
			{ tagName: "v18.1.15.12", isDraft: true },
			{ tagName: "v18.1.15.0" },
			{ tagName: "v18.1.15.3-canary.1" },
		]),
	).toBe("v18.1.15.11");
});

test("classifies only native build inputs as source-build changes", () => {
	for (const relativePath of [
		"Cargo.lock",
		"MODULE.bazel",
		"scripts/bazel-natives.ts",
		"packages/natives/package.json",
		"packages/natives/scripts/build-bindings.ts",
		"packages/natives/scripts/gen-enums.ts",
		"scripts/host-detect.ts",
		"bazel/native.bzl",
		"crates/pi-natives/src/lib.rs",
	]) {
		expect(isNativeBuildPath(relativePath)).toBe(true);
	}
	for (const relativePath of [
		".github/workflows/cf-verify.yml",
		"package.json",
		"packages/coding-agent/src/tools/bash.ts",
		"scripts/ci-release-build-binaries.ts",
	]) {
		expect(isNativeBuildPath(relativePath)).toBe(false);
	}
});

test("returns no tag when the engine version has no published Coreforce roll", () => {
	expect(selectLatestCoreforceRelease("18.1.15", [{ tagName: "v18.1.14.9" }])).toBeUndefined();
});

test("selects the exact release asset checksum", () => {
	const checksum = "a".repeat(64);
	expect(expectedChecksum(`${"b".repeat(64)}  other.tgz\n${checksum}  native.tgz\n`, "native.tgz")).toBe(checksum);
});

test("rejects missing and duplicate release asset checksums", () => {
	const checksum = "a".repeat(64);
	expect(() => expectedChecksum("", "native.tgz")).toThrow("found 0");
	expect(() => expectedChecksum(`${checksum}  native.tgz\n${checksum}  native.tgz\n`, "native.tgz")).toThrow(
		"found 2",
	);
});
