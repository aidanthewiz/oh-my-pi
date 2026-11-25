import * as fs from "node:fs/promises";
import * as path from "node:path";

interface MetadataRoot {
	label: string;
	path: string;
	depth: number;
}

interface Limits {
	entries?: number;
	timeMs?: number;
	topFiles?: number;
	signal?: AbortSignal;
}

interface FileMetadata {
	root: string;
	path: string;
	bytes: number;
	allocatedBytes: number;
	mtimeMs: number;
}

interface RootMetadata {
	root: string;
	depth: number;
	entries: number;
	logicalBytesObserved: number;
	allocatedBytesObserved: number;
	truncated: boolean;
	error?: string;
}

export interface DiskMetadata {
	roots: RootMetadata[];
	largestFiles: FileMetadata[];
}

interface DiskReport {
	phase: string;
	exitCode?: number;
	command?: { label: string; cwd?: string; error?: string };
	capacity?: { availableBytes: number; freeBytes: number; freeInodes: number; totalInodes: number };
	sample?: DiskMetadata;
	corePolicy?: { pattern?: string; limit?: string; error?: string };
	outputTruncated?: boolean;
	error?: string;
}

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unavailable";
}

function bounded(value: number | undefined, maximum: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(maximum, Math.max(1, Math.floor(value)))
		: maximum;
}

/** Metadata only: bounded traversal, no symlink targets or file contents. Totals describe the observed sample. */
export async function collectDiskMetadata(roots: readonly MetadataRoot[], limits: Limits = {}): Promise<DiskMetadata> {
	const entryLimit = bounded(limits.entries, 2_000);
	const topLimit = bounded(limits.topFiles, 20);
	const deadline = performance.now() + bounded(limits.timeMs, 1_500);
	const files: FileMetadata[] = [];
	const summaries: RootMetadata[] = [];
	for (const root of roots.slice(0, 4)) {
		const label = root.label.slice(0, 64);
		const depth = Number.isFinite(root.depth) ? Math.min(8, Math.max(0, Math.floor(root.depth))) : 0;
		let entries = 0;
		let logicalBytesObserved = 0;
		let allocatedBytesObserved = 0;
		let truncated = false;
		let error: string | undefined;
		const seen = new Set<string>();
		try {
			const absolute = path.resolve(root.path);
			if ((await fs.realpath(absolute)) !== absolute) throw new Error("symlink root");
			const rootStat = await fs.lstat(absolute);
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("not a plain directory");
			const queue = [{ directory: absolute, depth: 0 }];
			while (queue.length) {
				if (entries >= entryLimit || performance.now() >= deadline || limits.signal?.aborted) {
					truncated = true;
					break;
				}
				const current = queue.pop()!;
				for await (const entry of await fs.opendir(current.directory)) {
					if (entries >= entryLimit || performance.now() >= deadline || limits.signal?.aborted) {
						truncated = true;
						break;
					}
					entries++;
					if (entry.isSymbolicLink()) continue;
					const filename = path.join(current.directory, entry.name);
					const stat = await fs.lstat(filename);
					if (stat.isSymbolicLink() || stat.dev !== rootStat.dev) continue;
					if (stat.isDirectory()) {
						if (current.depth < depth) queue.push({ directory: filename, depth: current.depth + 1 });
						continue;
					}
					if (!stat.isFile()) continue;
					const identity = `${stat.dev}:${stat.ino}`;
					if (seen.has(identity)) continue;
					seen.add(identity);
					const allocatedBytes = stat.blocks * 512;
					logicalBytesObserved += stat.size;
					allocatedBytesObserved += allocatedBytes;
					files.push({
						root: label,
						path: path.relative(absolute, filename).slice(0, 256),
						bytes: stat.size,
						allocatedBytes,
						mtimeMs: stat.mtimeMs,
					});
					files.sort((left, right) => right.allocatedBytes - left.allocatedBytes);
					files.length = Math.min(files.length, topLimit);
				}
			}
		} catch (failure) {
			error = errorCode(failure);
		}
		summaries.push({ root: label, depth, entries, logicalBytesObserved, allocatedBytesObserved, truncated, error });
	}
	return { roots: summaries, largestFiles: files };
}

async function readPolicy(filename: string, maximum: number): Promise<string> {
	const file = await fs.open(filename, "r");
	try {
		const bytes = Buffer.alloc(maximum);
		const { bytesRead } = await file.read(bytes, 0, maximum, 0);
		return bytes.toString("utf8", 0, bytesRead).trim();
	} finally {
		await file.close();
	}
}

/** Never changes a child result, even if a full filesystem also prevents diagnostics. */
export async function reportCIDiskMetadata(
	repoRoot: string,
	runnerTemp: string,
	phase: "initial" | "child-failure",
	exitCode?: number,
	writeLine: (line: string) => void = line => {
		process.stdout.write(line);
	},
	failedCommand?: { label: string; cwd: string },
): Promise<void> {
	const controller = new AbortController();
	const { promise: expired, resolve } = Promise.withResolvers<DiskReport>();
	const timer = setTimeout(() => {
		controller.abort();
		resolve({ phase, exitCode, error: "diagnostic-timeout" });
	}, 2_000);
	const capture = async (): Promise<DiskReport> => {
		const stats = await fs.statfs(repoRoot);
		controller.signal.throwIfAborted();
		const capacity = {
			availableBytes: stats.bavail * stats.bsize,
			freeBytes: stats.bfree * stats.bsize,
			freeInodes: stats.ffree,
			totalInodes: stats.files,
		};
		let sample: DiskMetadata | undefined;
		let corePolicy: DiskReport["corePolicy"];
		let command: DiskReport["command"];
		if (phase === "child-failure") {
			const roots: MetadataRoot[] = [
				{ label: "workspace-files", path: repoRoot, depth: 0 },
				{ label: "test-scratch", path: path.join(runnerTemp, "qualification-tmp"), depth: 8 },
				{ label: "build-output", path: path.join(repoRoot, "target"), depth: 4 },
			];
			if (failedCommand) {
				command = { label: failedCommand.label.slice(0, 128) };
				try {
					const checkout = await fs.realpath(repoRoot);
					const candidate = path.resolve(checkout, failedCommand.cwd);
					const cwd = await fs.realpath(candidate);
					if (cwd !== candidate || (cwd !== checkout && !cwd.startsWith(checkout + path.sep))) {
						command.error = "cwd-outside-checkout";
					} else {
						command.cwd = path.relative(checkout, cwd) || ".";
						roots.unshift({ label: "failed-command", path: cwd, depth: 0 });
					}
				} catch (error) {
					command.error = errorCode(error);
				}
			}
			const uniqueRoots = roots.filter(
				(root, index) => roots.findIndex(other => path.resolve(other.path) === path.resolve(root.path)) === index,
			);
			sample = await collectDiskMetadata(uniqueRoots, { signal: controller.signal });
			controller.signal.throwIfAborted();
			try {
				const pattern = await readPolicy("/proc/sys/kernel/core_pattern", 256);
				controller.signal.throwIfAborted();
				const limits = await readPolicy("/proc/self/limits", 4_096);
				corePolicy = { pattern, limit: limits.split("\n").find(line => line.startsWith("Max core file size")) };
			} catch (error) {
				corePolicy = { error: errorCode(error) };
			}
		}
		return { phase, exitCode, command, capacity, sample, corePolicy, outputTruncated: false };
	};
	try {
		const record = await Promise.race([capture(), expired]);
		while (Buffer.byteLength(JSON.stringify(record)) > 16_000 && record.sample?.largestFiles.length) {
			record.sample.largestFiles.pop();
			record.outputTruncated = true;
		}
		writeLine(`[ci-disk-metadata] ${JSON.stringify(record)}\n`);
	} catch (error) {
		try {
			writeLine(`[ci-disk-metadata] ${JSON.stringify({ phase, exitCode, error: errorCode(error) })}\n`);
		} catch {}
	} finally {
		clearTimeout(timer);
	}
}
