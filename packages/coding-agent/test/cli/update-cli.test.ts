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
});
