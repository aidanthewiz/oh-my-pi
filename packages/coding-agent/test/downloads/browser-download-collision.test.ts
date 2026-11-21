import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "bun:test";
import { DownloadManager, type BrowserDownload } from "@oh-my-pi/pi-coding-agent/tools/browser/downloads";
import type { Browser, Page } from "puppeteer-core";

it("retains unrelated files and each sequential and overlapping download's bytes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-collision-"));
	const sessions = new Set<Map<string, (event: unknown) => void>>();
	const managers: DownloadManager[] = [];
	const drains: Promise<unknown>[] = [];
	const heldReleases: Array<() => void> = [];
	let sequence = 0;
	const emit = (method: string, event: unknown) => {
		for (const listeners of sessions) listeners.get(method)?.(event);
	};
	try {
		const directory = path.join(root, "downloads");
		for (const frame of ["a", "b"]) {
			const listeners = new Map<string, (event: unknown) => void>();
			sessions.add(listeners);
			const session = {
				on: (method: string, callback: (event: unknown) => void) => listeners.set(method, callback),
				off: (method: string) => listeners.delete(method),
				send: async () => undefined,
				detach: async () => {
					sessions.delete(listeners);
				},
			};
			const browser = { target: () => ({ createCDPSession: async () => session }) } as unknown as Browser;
			const page = { frames: () => [{ _id: frame }], browserContext: () => ({}) } as unknown as Page;
			const manager = new DownloadManager(browser, page, frame, { perTab: true, pageEvents: false });
			managers.push(manager);
			await manager.enable(directory);
		}
		const userFile = path.join(directory, "report.csv");
		await fs.writeFile(userFile, "unrelated user bytes");
		const prepare = async (manager: DownloadManager, frame: string, payload: string) => {
			const guid = `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
			const source = path.join(root, guid);
			await fs.writeFile(source, payload, { flag: "wx" });
			const result = manager.wait(AbortSignal.timeout(5000));
			drains.push(result.catch(() => undefined));
			await manager.arming;
			emit("Browser.downloadWillBegin", {
				guid,
				frameId: frame,
				suggestedFilename: "../../report.csv",
				url: `https://example.invalid/${guid}`,
			});
			return {
				guid,
				source,
				payload,
				result,
				finish: () =>
					emit("Browser.downloadProgress", {
						guid,
						state: "completed",
						receivedBytes: Buffer.byteLength(payload),
						filePath: source,
					}),
			};
		};
		const first = await prepare(managers[0]!, "a", "first bytes");
		first.finish();
		await first.result;
		const second = await prepare(managers[0]!, "a", "second distinct bytes");
		second.finish();
		await second.result;
		const left = await prepare(managers[0]!, "a", "concurrent left bytes");
		const right = await prepare(managers[1]!, "b", "concurrent right bytes");
		const sibling = await prepare(managers[0]!, "a", "same-tab overlapping bytes");
		const release = Promise.withResolvers<void>();
		heldReleases.push(() => release.resolve());
		const leftReady = Promise.withResolvers<void>(),
			rightReady = Promise.withResolvers<void>(),
			siblingReady = Promise.withResolvers<void>();
		const deliveries = [
			(async () => {
				leftReady.resolve();
				await release.promise;
				left.finish();
			})(),
			(async () => {
				rightReady.resolve();
				await release.promise;
				right.finish();
			})(),
			(async () => {
				siblingReady.resolve();
				await release.promise;
				sibling.finish();
			})(),
		];
		drains.push(...deliveries);
		await Promise.all([leftReady.promise, rightReady.promise, siblingReady.promise]);
		release.resolve();
		await Promise.all(deliveries);
		await Promise.all([left.result, right.result, sibling.result]);
		const records: BrowserDownload[] = managers.flatMap(manager => manager.list());
		expect(new Set(records.map(record => record.path)).size).toBe(5);
		expect(await fs.readFile(userFile, "utf8")).toBe("unrelated user bytes");
		for (const item of [first, second, left, right, sibling]) {
			const record = records.find(record => record.url.endsWith(item.guid))!;
			expect(path.dirname(record.path)).toBe(directory);
			expect(await fs.readFile(record.path, "utf8")).toBe(item.payload);
			expect(record.bytes).toBe(Buffer.byteLength(item.payload));
			await expect(fs.lstat(item.source)).rejects.toMatchObject({ code: "ENOENT" });
		}
	} finally {
		for (const release of heldReleases) release();
		await Promise.allSettled(drains);
		await Promise.all(managers.map(manager => manager.close()));
		expect(sessions.size).toBe(0);
		await fs.rm(root, { recursive: true, force: true });
	}
});
