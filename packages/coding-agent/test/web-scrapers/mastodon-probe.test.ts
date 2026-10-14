import { afterEach, describe, expect, it, vi } from "bun:test";
import { handleDiscourse } from "@oh-my-pi/pi-coding-agent/web/scrapers/discourse";
import { handleMastodon } from "@oh-my-pi/pi-coding-agent/web/scrapers/mastodon";
import { loadPage } from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { isNonJsonApiResponse } from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";

type FetchArgs = Parameters<typeof fetch>;

/** Route every fetch to `respond`, counting calls. */
function mockFetch(respond: (url: string, init?: RequestInit) => Promise<Response> | Response): {
	calls: () => number;
} {
	let calls = 0;
	const implementation = async (...[input, init]: FetchArgs): Promise<Response> => {
		calls++;
		return respond(input instanceof Request ? input.url : String(input), init);
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }),
	);
	return { calls: () => calls };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("mastodon instance probe", () => {
	it("does not let one caller's abort decide the shared probe verdict for concurrent callers", async () => {
		const host = "probe-abort.mastodon.test";
		const instance = Promise.withResolvers<void>();
		mockFetch(async (url, init) => {
			if (url.endsWith("/api/v1/instance")) {
				const signal = init?.signal;
				const settled = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => settled.reject(signal.reason), { once: true });
				instance.promise.then(settled.resolve);
				await settled.promise;
				return Response.json({ uri: host });
			}
			return Response.json({
				id: "1",
				created_at: "2026-01-01T00:00:00Z",
				content: "<p>Shared probe survives caller cancellation.</p>",
				url: `https://${host}/@alice/1`,
				account: { username: "alice", acct: "alice", display_name: "Alice" },
				reblogs_count: 0,
				favourites_count: 0,
				replies_count: 0,
				media_attachments: [],
				sensitive: false,
				visibility: "public",
			});
		});

		const abortFirst = new AbortController();
		const first = handleMastodon(`https://${host}/@alice/1`, 20, abortFirst.signal);
		const second = handleMastodon(`https://${host}/@alice/1`, 20);
		abortFirst.abort();
		expect(await first).toBeNull();
		instance.resolve();

		expect((await second)?.content).toContain("Shared probe survives caller cancellation.");
	});

	it("re-probes after an inconclusive server error instead of memoizing it", async () => {
		const host = "probe-503.mastodon.test";
		const { calls } = mockFetch(() => new Response("unavailable", { status: 503 }));
		expect(await handleMastodon(`https://${host}/@alice/1`, 20)).toBeNull();
		expect(calls()).toBe(1);
		expect(await handleMastodon(`https://${host}/@alice/1`, 20)).toBeNull();
		expect(calls()).toBe(2);
	});
});

describe("discourse origin memo", () => {
	it("skips a host whose topic API answered with an HTML 404, until the negative expires", async () => {
		const host = "html-404.discourse.test";
		const { calls } = mockFetch(() => new Response("<html>not found</html>", { status: 404 }));
		expect(await handleDiscourse(`https://${host}/t/slug/1`, 20)).toBeNull();
		expect(calls()).toBe(1);
		expect(await handleDiscourse(`https://${host}/t/slug/2`, 20)).toBeNull();
		expect(calls()).toBe(1);

		// Eleven minutes later the negative verdict has lapsed.
		const now = performance.now();
		vi.spyOn(performance, "now").mockReturnValue(now + 11 * 60_000);
		expect(await handleDiscourse(`https://${host}/t/slug/3`, 20)).toBeNull();
		expect(calls()).toBe(2);
	});

	it("keeps fetching from a real instance that answers a deleted topic with a JSON 404", async () => {
		const host = "json-404.discourse.test";
		const { calls } = mockFetch(() => Response.json({ errors: ["not found"] }, { status: 404 }));
		expect(await handleDiscourse(`https://${host}/t/slug/1`, 20)).toBeNull();
		expect(calls()).toBe(1);
		expect(await handleDiscourse(`https://${host}/t/slug/2`, 20)).toBeNull();
		expect(calls()).toBe(2);
	});
});

describe("bounded platform response", () => {
	it("keeps a single oversized chunk within the byte cap and leaves its verdict inconclusive", async () => {
		mockFetch(() => Response.json({ topic_id: 1, title: "large topic" }));
		const result = await loadPage("https://bounded.discourse.test/t/topic/1.json", { maxBytes: 8 });
		expect(result.content).toBe('{"topic_');
		expect(result.truncated).toBe(true);
		expect(isNonJsonApiResponse(result)).toBe(false);
	});

	it.each([401, 403, 408, 429, 500, 503])("does not infer a non-platform host from status %i", status => {
		expect(
			isNonJsonApiResponse({
				ok: false,
				status,
				content: "<html>temporarily unavailable</html>",
				contentType: "text/html",
				finalUrl: "https://retry.discourse.test",
			}),
		).toBe(false);
	});
});
