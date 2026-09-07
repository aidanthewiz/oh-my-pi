import { afterEach, describe, expect, it } from "bun:test";
import {
	ensureAntigravityVersion,
	getAntigravityUserAgent,
	getAntigravityVersion,
	parseAntigravityManifestVersion,
} from "@oh-my-pi/pi-catalog/wire/gemini-headers";

const originalVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;

afterEach(() => {
	if (originalVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
	else process.env.PI_AI_ANTIGRAVITY_VERSION = originalVersion;
});

describe("Antigravity client version", () => {
	it("parses only complete semantic versions from update manifests", () => {
		expect(parseAntigravityManifestVersion("version: 2.8.0\nfiles: []\n")).toBe("2.8.0");
		expect(parseAntigravityManifestVersion("version: '3.1.4' # current\n")).toBe("3.1.4");
		expect(parseAntigravityManifestVersion("version: 2.8\n")).toBeNull();
		expect(parseAntigravityManifestVersion("releaseVersion: 2.8.0\n")).toBeNull();
	});

	it("uses the operator override without contacting the update manifest", async () => {
		process.env.PI_AI_ANTIGRAVITY_VERSION = "9.8.7";
		let fetchCalls = 0;
		const fetcher = Object.assign(
			(_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
				fetchCalls += 1;
				return Promise.reject(new Error("unexpected fetch"));
			},
			{ preconnect: fetch.preconnect },
		);

		await ensureAntigravityVersion(fetcher);

		expect(fetchCalls).toBe(0);
		expect(getAntigravityVersion()).toBe("9.8.7");
		expect(getAntigravityUserAgent()).toContain("antigravity/hub/9.8.7 ");
	});
});
