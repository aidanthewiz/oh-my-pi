import { afterEach, describe, expect, it, vi } from "bun:test";
import { runUpdateCommand } from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		// cf-channel token resolution consults env before shelling out to
		// `gh auth token`; pin a token so the test never depends on ambient auth.
		const priorToken = process.env.OMP_UPDATE_GITHUB_TOKEN;
		process.env.OMP_UPDATE_GITHUB_TOKEN = "test-token";
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ tag_name: "v999.0.0.1", assets: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		try {
			await runUpdateCommand({ force: false, check: true });
		} finally {
			if (priorToken === undefined) delete process.env.OMP_UPDATE_GITHUB_TOKEN;
			else process.env.OMP_UPDATE_GITHUB_TOKEN = priorToken;
		}

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});

	it("translates unsupported proxy failures into actionable guidance", async () => {
		const priorToken = process.env.OMP_UPDATE_GITHUB_TOKEN;
		process.env.OMP_UPDATE_GITHUB_TOKEN = "test-token";
		vi.spyOn(console, "log").mockImplementation(() => {});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit(1)");
		}) as typeof process.exit);
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://api.github.com". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		try {
			await expect(runUpdateCommand({ force: false, check: true })).rejects.toThrow("process.exit(1)");
			const message = consoleError.mock.calls.flat().join(" ");
			expect(message).not.toContain("verbose: true");
			expect(message).not.toContain("fetch()");
			expect(message).toMatch(/SOCKS/i);
			expect(message).toMatch(/https?:\/\//i);
		} finally {
			if (priorToken === undefined) delete process.env.OMP_UPDATE_GITHUB_TOKEN;
			else process.env.OMP_UPDATE_GITHUB_TOKEN = priorToken;
		}
	});
});
