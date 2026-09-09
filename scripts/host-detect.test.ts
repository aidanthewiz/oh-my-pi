import { describe, expect, test } from "bun:test";
import { detectHostArchitecture } from "./host-detect";

describe("detectHostArchitecture", () => {
	test("uses the GitHub runner architecture under runtime emulation", () => {
		expect(
			detectHostArchitecture("win32", "x64", {
				RUNNER_ARCH: "ARM64",
				PROCESSOR_ARCHITECTURE: "AMD64",
			}),
		).toBe("arm64");
	});

	test("uses the native Windows architecture under runtime emulation", () => {
		expect(
			detectHostArchitecture("win32", "x64", {
				PROCESSOR_ARCHITECTURE: "AMD64",
				PROCESSOR_ARCHITEW6432: "ARM64",
			}),
		).toBe("arm64");
	});

	test("uses the Windows system architecture when no emulation marker exists", () => {
		expect(detectHostArchitecture("win32", "x64", { PROCESSOR_ARCHITECTURE: "ARM64" })).toBe("arm64");
	});

	test("keeps the runtime architecture on native Windows x64", () => {
		expect(detectHostArchitecture("win32", "x64", { PROCESSOR_ARCHITECTURE: "AMD64" })).toBe("x64");
	});

	test("ignores Windows architecture variables on other platforms", () => {
		expect(detectHostArchitecture("linux", "x64", { PROCESSOR_ARCHITECTURE: "ARM64" })).toBe("x64");
	});
});
