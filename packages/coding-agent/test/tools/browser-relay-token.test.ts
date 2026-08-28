import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureBrowserRelayToken, writeBrowserRelayToken } from "../../src/tools/browser/relay/token";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function temporaryRelayDirectory(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coreforge-relay-token-"));
	temporaryDirectories.push(dir);
	return path.join(dir, "browser-relay");
}

describe("browser relay token", () => {
	it("creates one private token across concurrent starters", async () => {
		const dir = await temporaryRelayDirectory();
		const tokens = await Promise.all(Array.from({ length: 16 }, () => ensureBrowserRelayToken(dir)));

		expect(new Set(tokens)).toEqual(new Set([tokens[0]]));
		expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect((await fs.readFile(path.join(dir, "token"), "utf8")).trim()).toBe(tokens[0]);
		if (process.platform !== "win32") {
			expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(path.join(dir, "token"))).mode & 0o777).toBe(0o600);
		}
	});

	it("atomically replaces the token and rejects an empty replacement", async () => {
		const dir = await temporaryRelayDirectory();
		await ensureBrowserRelayToken(dir);
		await writeBrowserRelayToken("manual-token", dir);

		expect(await ensureBrowserRelayToken(dir)).toBe("manual-token");
		await expect(writeBrowserRelayToken("  ", dir)).rejects.toThrow("Browser relay token must be nonempty");
	});
});
