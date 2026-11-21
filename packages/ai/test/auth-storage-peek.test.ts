import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

/**
 * Model discovery resolves its key through `keys.peek()`, and credential-scoped
 * catalogs (GitHub Copilot, Cursor) key their cache rows on the peeked
 * account. A peek that rotates accounts reads a different cache namespace on
 * every discovery pass, so one pass can replace another account's cached
 * catalog with the bundled fallback.
 */
describe("AuthStorage keys.peek", () => {
	const storages: AuthStorage[] = [];
	afterEach(async () => {
		for (const storage of storages) await storage.close();
		storages.length = 0;
	});

	it("returns the same unexpired account on every call, skipping an expired one", async () => {
		const storage = await AuthStorage.create(":memory:");
		storages.push(storage);
		const now = Date.now();
		await storage.credentials.set("cursor", [
			{ type: "oauth", access: "expired-a", refresh: "refresh-a", expires: now - 60_000 },
			{ type: "oauth", access: "live-b", refresh: "refresh-b", expires: now + 3_600_000 },
			{ type: "oauth", access: "live-c", refresh: "refresh-c", expires: now + 3_600_000 },
		]);

		const peeks = [
			await storage.keys.peek("cursor"),
			await storage.keys.peek("cursor"),
			await storage.keys.peek("cursor"),
		];

		expect(peeks).toEqual(["live-b", "live-b", "live-b"]);
	});

	it("uses expired accounts only for explicit offline identity reads, without refreshing or rotating", async () => {
		let refreshes = 0;
		const storage = await AuthStorage.create(":memory:", {
			refreshOAuthCredential: async () => {
				refreshes++;
				throw new Error("offline peek must not refresh");
			},
		});
		storages.push(storage);
		await storage.credentials.set("cursor", [
			{ type: "oauth", access: "expired-first", refresh: "refresh-first", expires: 1 },
			{ type: "oauth", access: "expired-second", refresh: "refresh-second", expires: 2 },
		]);
		expect(await storage.keys.peek("cursor")).toBeUndefined();
		expect(await storage.keys.peek("cursor", { includeExpired: true })).toBe("expired-first");
		expect(await storage.keys.peek("cursor", { includeExpired: true })).toBe("expired-first");
		expect(await storage.keys.peek("cursor")).toBeUndefined();
		expect(refreshes).toBe(0);
	});

	it("prefers a usable account even when offline identity permits expired tokens", async () => {
		const storage = await AuthStorage.create(":memory:");
		storages.push(storage);
		await storage.credentials.set("cursor", [
			{ type: "oauth", access: "expired", refresh: "refresh-expired", expires: 1 },
			{ type: "oauth", access: "usable", refresh: "refresh-usable", expires: Date.now() + 3_600_000 },
		]);
		expect(await storage.keys.peek("cursor", { includeExpired: true })).toBe("usable");
	});

	it("treats an incomplete Kiro OAuth row as no credential and serves a complete sibling", async () => {
		const storage = await AuthStorage.create(":memory:");
		storages.push(storage);
		const expires = Date.now() + 3_600_000;
		// A row without `accountId` (the login id) cannot be encoded.
		const incomplete = {
			type: "oauth" as const,
			access: "incomplete-access",
			refresh: "refresh-a",
			expires,
			region: "us-east-1",
		};
		await storage.credentials.set("kiro", incomplete);
		expect(await storage.keys.peek("kiro")).toBeUndefined();
		expect(await storage.keys.peek("kiro", { includeExpired: true })).toBeUndefined();

		await storage.credentials.set("kiro", [
			incomplete,
			{ ...incomplete, access: "complete-access", refresh: "refresh-b", accountId: "login-b" },
		]);
		expect(JSON.parse((await storage.keys.peek("kiro")) ?? "null")).toMatchObject({
			kind: "oauth",
			token: "complete-access",
			loginId: "login-b",
		});
	});
});
