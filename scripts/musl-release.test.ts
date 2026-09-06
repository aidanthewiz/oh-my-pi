import { describe, expect, test } from "bun:test";
import { BINARY_TARGETS } from "./ci-release-build-binaries";

describe("musl release artifacts", () => {
	test("builds the requested x64 and arm64 musl asset names with Bun's musl targets", () => {
		expect(BINARY_TARGETS.filter(target => target.id.startsWith("linux-musl-"))).toEqual([
			{
				id: "linux-musl-x64",
				platform: "linux",
				arch: "x64",
				target: "bun-linux-x64-musl-baseline",
				outfile: "packages/coding-agent/binaries/omp-linux-musl-x64",
			},
			{
				id: "linux-musl-arm64",
				platform: "linux",
				arch: "arm64",
				target: "bun-linux-arm64-musl",
				outfile: "packages/coding-agent/binaries/omp-linux-musl-arm64",
			},
		]);
	});
});
