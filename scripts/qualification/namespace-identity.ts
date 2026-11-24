import { constants } from "node:fs";
import * as fs from "node:fs/promises";

function errorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException)?.code;
	return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN";
}

async function boundedProcFile(file: string, limit: number) {
	try {
		const handle = await fs.open(file, "r");
		try {
			const buffer = Buffer.alloc(limit + 1);
			let size = 0;
			while (size < buffer.length) {
				const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
				if (bytesRead === 0) break;
				size += bytesRead;
			}
			return { text: buffer.subarray(0, Math.min(size, limit)).toString("utf8"), truncated: size > limit };
		} finally {
			await handle.close();
		}
	} catch (error) {
		return { error: errorCode(error) };
	}
}

async function idMap(file: string) {
	const read = await boundedProcFile(file, 4096);
	if (read.text === undefined) return read;
	const ranges: { inside: number; outside: number; count: number }[] = [];
	let malformedRows = 0;
	const lines = read.text.trim().split("\n").filter(Boolean);
	for (const line of lines.slice(0, 64)) {
		const fields = line.trim().split(/\s+/).map(Number);
		if (fields.length !== 3 || fields.some(value => !Number.isSafeInteger(value) || value < 0)) {
			malformedRows++;
			continue;
		}
		ranges.push({ inside: fields[0]!, outside: fields[1]!, count: fields[2]! });
	}
	return { ranges, malformedRows, truncated: read.truncated || lines.length > 64 };
}

async function directory(file: "/" | "/tmp") {
	try {
		const realpath = await fs.realpath(file);
		const stat = await fs.lstat(realpath, { bigint: true });
		let writeAccess: { allowed: boolean; error?: string };
		try {
			await fs.access(realpath, constants.W_OK);
			writeAccess = { allowed: true };
		} catch (error) {
			writeAccess = { allowed: false, error: errorCode(error) };
		}
		return {
			path: file,
			realpath,
			kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
			mode: Number(stat.mode & 0o7777n),
			uid: Number(stat.uid),
			gid: Number(stat.gid),
			device: stat.dev.toString(),
			inode: stat.ino.toString(),
			writeAccess,
		};
	} catch (error) {
		return { path: file, error: errorCode(error) };
	}
}

async function tmpMount() {
	const read = await boundedProcFile("/proc/self/mountinfo", 65536);
	if (read.text === undefined) return read;
	const allowedFlags = new Set([
		"ro",
		"rw",
		"nosuid",
		"nodev",
		"noexec",
		"relatime",
		"noatime",
		"nodiratime",
		"strictatime",
		"lazytime",
	]);
	let selected: { mountpoint: string; filesystem: string; mountFlags: string[]; superFlags: string[] } | undefined;
	for (const line of read.text.split("\n")) {
		const separator = line.indexOf(" - ");
		if (separator < 0) continue;
		const before = line.slice(0, separator).split(" ");
		const after = line.slice(separator + 3).split(" ");
		const mountpoint = before[4];
		if (mountpoint !== "/" && mountpoint !== "/tmp") continue;
		if (selected && selected.mountpoint.length >= mountpoint.length) continue;
		selected = {
			mountpoint,
			filesystem: /^[A-Za-z0-9_.-]{1,40}$/.test(after[0] ?? "") ? after[0]! : "other",
			mountFlags: [...new Set((before[5] ?? "").split(",").filter(flag => allowedFlags.has(flag)))],
			superFlags: [...new Set((after[2] ?? "").split(",").filter(flag => allowedFlags.has(flag)))],
		};
	}
	return { coveringTmp: selected ?? null, truncated: read.truncated };
}

/** Fixed, read-only projection for the compiled qualification namespace investigation. */
export async function captureNamespaceIdentity(stage: "outside" | "inside") {
	const [root, tmp, uidMap, gidMap, mount] = await Promise.all([
		directory("/"),
		directory("/tmp"),
		idMap("/proc/self/uid_map"),
		idMap("/proc/self/gid_map"),
		tmpMount(),
	]);
	return {
		schema: "CoreforgeQualificationNamespaceIdentity",
		stage,
		uid: process.getuid?.() ?? null,
		euid: process.geteuid?.() ?? null,
		gid: process.getgid?.() ?? null,
		egid: process.getegid?.() ?? null,
		root,
		tmp,
		uidMap,
		gidMap,
		mount,
	};
}
