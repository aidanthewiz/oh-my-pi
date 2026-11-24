import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type InternalUrl, VaultProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function createSession(): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("read keeps the query of schemes that own it", () => {
	it("hands vault://…?op=search&q=… to the vault handler instead of peeling an image question", async () => {
		const seen: InternalUrl[] = [];
		vi.spyOn(VaultProtocolHandler.prototype, "locate").mockResolvedValue(null);
		vi.spyOn(VaultProtocolHandler.prototype, "resolve").mockImplementation(async url => {
			seen.push(url);
			return { url: url.href, content: "hit: Plans/roadmap.md", contentType: "text/plain" };
		});

		const result = await new ReadTool(createSession()).execute("vault-search", {
			path: "vault://Work?op=search&q=plan",
		});

		expect(seen.map(url => [url.searchParams.get("op"), url.searchParams.get("q")])).toEqual([["search", "plan"]]);
		expect(result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(
			"hit: Plans/roadmap.md",
		);
	});
});

describe("read routed documents", () => {
	it.each([true, false])("retains resource notes without contaminating raw=%s document text", async raw => {
		const router = InternalUrlRouter.instance();
		router.register({
			scheme: "cf-noted-document",
			spec: { backing: "virtual", selectors: "lines", immutable: true },
			resolve: async url => ({
				url: url.href,
				content: "unselected-before\nselected-document-line\nunselected-after",
				contentType: "text/plain",
				notes: ["synthetic resource note"],
			}),
		});
		try {
			const result = await new ReadTool(createSession()).execute("noted-document", {
				path: `cf-noted-document://page${raw ? ":raw" : ""}:2-2`,
			});
			const text = result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
			expect(result.isError).not.toBe(true);
			expect(result.details?.notes).toContain("synthetic resource note");
			expect(text).toContain("selected-document-line");
			if (raw) {
				expect(text).not.toContain("unselected-before");
				expect(text).not.toContain("unselected-after");
				expect(text).not.toContain("synthetic resource note");
			} else {
				expect(text).toContain("synthetic resource note");
			}
		} finally {
			router.unregister("cf-noted-document");
		}
	});
});
