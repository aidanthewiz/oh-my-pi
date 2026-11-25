import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectDiskMetadata, reportCIDiskMetadata } from "../../../scripts/ci-disk-metadata";

let root: string;
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "disk-metadata-")));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

it("reports allocated and logical sizes without exposing contents or following links", async () => {
	const owned = path.join(root, "owned");
	await fs.mkdir(path.join(owned, "nested"), { recursive: true });
	await fs.writeFile(path.join(owned, "first"), "private-content");
	await fs.writeFile(path.join(owned, "nested", "second"), "abc");
	await fs.writeFile(path.join(root, "outside"), "outside-content-must-not-appear");
	if (process.platform !== "win32") await fs.symlink(path.join(root, "outside"), path.join(owned, "link"));
	const result = await collectDiskMetadata([{ label: "test", path: owned, depth: 8 }]);
	const first = await fs.stat(path.join(owned, "first"));
	const second = await fs.stat(path.join(owned, "nested", "second"));
	expect(result.roots[0].logicalBytesObserved).toBe(first.size + second.size);
	expect(result.roots[0].allocatedBytesObserved).toBe((first.blocks + second.blocks) * 512);
	expect(result.roots[0].truncated).toBe(false);
	expect(result.largestFiles.map(file => file.path).sort()).toEqual(["first", "nested/second"]);
	expect(JSON.stringify(result)).not.toContain("private-content");
	expect(JSON.stringify(result)).not.toContain("outside-content");
});

it("marks partial samples and bounds reported files when the entry budget is reached", async () => {
	for (let index = 0; index < 10; index++) await fs.writeFile(path.join(root, String(index)), "x");
	const result = await collectDiskMetadata([{ label: "bounded", path: root, depth: 1 }], { entries: 3, topFiles: 1 });
	expect(result.roots[0].entries).toBe(3);
	expect(result.roots[0].truncated).toBe(true);
	expect(result.roots[0].logicalBytesObserved).toBe(3);
	expect(result.largestFiles).toHaveLength(1);
});

it("refuses a symlink root rather than inspecting its target", async () => {
	if (process.platform === "win32") return;
	const target = path.join(root, "target");
	await fs.mkdir(target);
	await fs.writeFile(path.join(target, "secret"), "must-not-be-scanned");
	const link = path.join(root, "link");
	await fs.symlink(target, link);
	const result = await collectDiskMetadata([{ label: "link", path: link, depth: 8 }]);
	expect(result.roots[0].error).toBeDefined();
	expect(result.roots[0].entries).toBe(0);
	expect(result.largestFiles).toEqual([]);
});

it("records missing roots as diagnostic failures without hiding other root data", async () => {
	await fs.writeFile(path.join(root, "kept"), "ok");
	const result = await collectDiskMetadata([
		{ label: "missing", path: path.join(root, "absent"), depth: 0 },
		{ label: "present", path: root, depth: 0 },
	]);
	expect(result.roots[0].error).toBe("ENOENT");
	expect(result.roots[1].logicalBytesObserved).toBe(2);
	expect(result.largestFiles.map(file => file.path)).toEqual(["kept"]);
});

it("caps diagnostic bytes even when sampled filenames require JSON escaping", async () => {
	if (process.platform === "win32") return;
	for (let index = 0; index < 20; index++) {
		await fs.writeFile(path.join(root, "\u0001".repeat(230) + index), "secret-content");
	}
	const lines: string[] = [];
	await reportCIDiskMetadata(root, root, "child-failure", 7, line => {
		lines.push(line);
	});
	expect(lines).toHaveLength(1);
	expect(Buffer.byteLength(lines[0])).toBeLessThanOrEqual(16_024);
	expect(lines[0]).not.toContain("secret-content");
	const record = JSON.parse(lines[0].slice("[ci-disk-metadata] ".length));
	expect(record.exitCode).toBe(7);
	expect(record.outputTruncated).toBe(true);
});

it("ends diagnostic collection without waiting for stalled filesystem metadata", async () => {
	const pending = Promise.withResolvers<never>();
	const statfs = spyOn(fs, "statfs").mockReturnValue(pending.promise);
	const lines: string[] = [];
	const started = performance.now();
	try {
		await reportCIDiskMetadata(root, root, "child-failure", 139, line => {
			lines.push(line);
		});
		expect(performance.now() - started).toBeLessThan(4_000);
		const record = JSON.parse(lines[0].slice("[ci-disk-metadata] ".length));
		expect(record.error).toBe("diagnostic-timeout");
		expect(record.exitCode).toBe(139);
	} finally {
		statfs.mockRestore();
		pending.reject(new Error("fixture closed"));
	}
});

it("preserves an original failure when diagnostic output also fails", async () => {
	const original = new Error("original child failure");
	const operation = async () => {
		try {
			throw original;
		} finally {
			await reportCIDiskMetadata(root, root, "child-failure", 7, () => {
				throw new Error("output unavailable");
			});
		}
	};
	await expect(operation()).rejects.toBe(original);
});

it("attributes a relative core candidate to the failed checkout-contained working directory", async () => {
	const cwd = path.join(root, "packages", "fixture");
	await fs.mkdir(cwd, { recursive: true });
	await fs.writeFile(path.join(cwd, "core.fixture"), "synthetic-not-a-core");
	const lines: string[] = [];
	await reportCIDiskMetadata(
		root,
		root,
		"child-failure",
		139,
		line => {
			lines.push(line);
		},
		{ label: "fixture chunk", cwd: "packages/fixture" },
	);
	const record = JSON.parse(lines[0].slice("[ci-disk-metadata] ".length));
	expect(record.command).toEqual({ label: "fixture chunk", cwd: "packages/fixture" });
	const candidate = record.sample.largestFiles.find(
		(file: { root: string; path: string }) => file.root === "failed-command" && file.path === "core.fixture",
	);
	expect(candidate.bytes).toBe(20);
	expect(lines[0]).not.toContain("synthetic-not-a-core");
});

it("rejects a failed working directory outside the checkout", async () => {
	const lines: string[] = [];
	await reportCIDiskMetadata(
		root,
		root,
		"child-failure",
		1,
		line => {
			lines.push(line);
		},
		{ label: "outside", cwd: ".." },
	);
	const record = JSON.parse(lines[0].slice("[ci-disk-metadata] ".length));
	expect(record.command.error).toBe("cwd-outside-checkout");
	expect(record.sample.roots.some((entry: { root: string }) => entry.root === "failed-command")).toBe(false);
});

it("does not scan the checkout root twice when it is the failed working directory", async () => {
	const lines: string[] = [];
	await reportCIDiskMetadata(
		root,
		root,
		"child-failure",
		1,
		line => {
			lines.push(line);
		},
		{ label: "root", cwd: "." },
	);
	const record = JSON.parse(lines[0].slice("[ci-disk-metadata] ".length));
	expect(record.command.cwd).toBe(".");
	expect(record.sample.roots.map((entry: { root: string }) => entry.root)).toEqual([
		"failed-command",
		"test-scratch",
		"build-output",
	]);
});
