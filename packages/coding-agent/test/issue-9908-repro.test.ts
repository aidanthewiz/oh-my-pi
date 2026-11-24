import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { mnemopiEmbedUnitKey } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";

describe("issue #9908 — embedding model/cache identity", () => {
	it("shares equivalent cache paths but separates different models and caches", () => {
		const cache = path.resolve("synthetic-embedding-cache");
		const key = mnemopiEmbedUnitKey("model-a", cache);
		expect(mnemopiEmbedUnitKey("model-a", path.relative(process.cwd(), cache))).toBe(key);
		expect(mnemopiEmbedUnitKey("model-a", `${cache}/../synthetic-embedding-cache`)).toBe(key);
		expect(mnemopiEmbedUnitKey("model-b", cache)).not.toBe(key);
		expect(mnemopiEmbedUnitKey("model-a", `${cache}-other`)).not.toBe(key);
		if (process.platform === "win32") {
			expect(mnemopiEmbedUnitKey("model-a", cache.toUpperCase())).toBe(key);
		}
	});
});
