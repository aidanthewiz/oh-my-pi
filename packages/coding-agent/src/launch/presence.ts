import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasFsCode, isEnoent, logger, postmortem } from "@oh-my-pi/pi-utils";
import { canonicalProjectDir, daemonBrokerRuntimeDir, daemonRuntimeDir, readStoredDaemonRecord } from "./paths";
import { parseDaemonSnapshot, parseDaemonSpec } from "./protocol";

const CLIENTS_DIR = "clients";
const BROKER_PID_FILE = "broker.pid";
/**
 * Basename of the container holding per-project daemon scopes
 * (`<state>/run/daemons`). {@link pruneDeadDaemonRuntimeDirs} refuses to sweep
 * any other root so a runtime dir passed from outside the state tree cannot
 * turn the reclaim into an rm -rf of unrelated neighbours (issue #8721).
 */
const DAEMONS_DIR = "daemons";
/**
 * Name shape of a project daemon scope: the 16-hex wyhash of the project dir
 * produced by `getDaemonRuntimeDir`. Only entries matching this are pruned,
 * which excludes the machine-global `global` container and any foreign dir.
 */
const DAEMON_SCOPE_KEY = /^[0-9a-f]{16}$/;
/**
 * Grace before a dead daemon runtime dir becomes prune-eligible. Guards against
 * deleting a scope whose owning omp process is mid-startup (token written, broker
 * not yet spawned, presence not yet registered). The leak this reclaims is a
 * weeks-scale accumulation, so a few minutes of slack costs nothing.
 */
const DAEMON_RUNTIME_STALE_GRACE_MS = 5 * 60_000;

/** Handle keeping one omp process registered in a project daemon scope. */
export interface DaemonProjectPresence {
	close(): Promise<void>;
}

/** Register this omp process so project daemons survive while it remains alive. */
export async function registerDaemonProjectPresence(
	projectDir: string,
	runtimeOverride?: string,
): Promise<DaemonProjectPresence> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeRoot = runtimeOverride ?? daemonRuntimeDir(canonical);
	const runtimeDir = daemonBrokerRuntimeDir(runtimeRoot);
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	await fs.mkdir(clientsDir, { recursive: true, mode: 0o700 });
	const id = `${process.pid}-${crypto.randomUUID()}`;
	const presencePath = path.join(clientsDir, `${id}.json`);
	await Bun.write(presencePath, JSON.stringify({ pid: process.pid, id, projectDir: canonical }));
	// POSIX modes are meaningless on Windows; chmod there only costs another syscall.
	if (process.platform !== "win32") await fs.chmod(presencePath, 0o600);
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		cancelCleanup();
		await fs.rm(presencePath, { force: true });
	};
	const cancelCleanup = postmortem.register(`daemon-presence:${id}`, () => close());
	return { close };
}

/** Return whether a registered omp process in this runtime directory is still alive. */
export async function hasLiveDaemonProjectPresence(runtimeDir: string): Promise<boolean> {
	const clientsDir = path.join(runtimeDir, CLIENTS_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(clientsDir);
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	let live = false;
	for (const entry of entries) {
		const presencePath = path.join(clientsDir, entry);
		try {
			const decoded: unknown = await Bun.file(presencePath).json();
			if (
				typeof decoded !== "object" ||
				decoded === null ||
				!("pid" in decoded) ||
				typeof decoded.pid !== "number"
			) {
				await fs.rm(presencePath, { force: true });
				continue;
			}
			try {
				process.kill(decoded.pid, 0);
				live = true;
			} catch (error) {
				if (hasFsCode(error, "ESRCH")) await fs.rm(presencePath, { force: true });
				else live = true;
			}
		} catch (error) {
			if (!isEnoent(error)) await fs.rm(presencePath, { force: true });
		}
	}
	return live;
}

/** PID recorded in the runtime dir's broker lease when that broker process is still alive; undefined otherwise. */
export async function readLiveDaemonBrokerPid(runtimeDir: string): Promise<number | undefined> {
	let raw: unknown;
	try {
		raw = await Bun.file(path.join(runtimeDir, BROKER_PID_FILE)).json();
	} catch {
		return undefined; // Missing or malformed broker.pid => no owning broker.
	}
	if (typeof raw !== "object" || raw === null || !("pid" in raw) || typeof raw.pid !== "number") {
		return undefined;
	}
	try {
		process.kill(raw.pid, 0);
		return raw.pid;
	} catch (error) {
		return hasFsCode(error, "ESRCH") ? undefined : raw.pid;
	}
}

async function hasLiveDaemonInRuntime(runtimeDir: string): Promise<boolean> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(path.join(runtimeDir, DAEMONS_DIR), { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const stored = await readStoredDaemonRecord(path.join(runtimeDir, DAEMONS_DIR, entry.name));
			if (!stored) return true;
			const snapshot = parseDaemonSnapshot(stored.meta.daemon);
			const spec = parseDaemonSpec(stored.spec);
			if (!spec.detached || snapshot.pid === undefined || ["exited", "failed"].includes(snapshot.state)) continue;
			try {
				process.kill(snapshot.pid, 0);
				return true;
			} catch (error) {
				if (!hasFsCode(error, "ESRCH")) return true;
			}
		} catch {
			return true;
		}
	}
	return false;
}

/**
 * Sweep only hash-keyed project scopes inside `run/daemons`, never relocated or global runtimes.
 * A scope with any live legacy or versioned broker, client, or detached daemon retains its metadata.
 */
export async function pruneDeadDaemonRuntimeDirs(currentRuntimeDir: string): Promise<void> {
	const scope = path.basename(currentRuntimeDir).match(/^broker-v\d+$/)
		? path.dirname(currentRuntimeDir)
		: currentRuntimeDir;
	const root = path.dirname(scope);
	if (path.basename(root) !== DAEMONS_DIR || !DAEMON_SCOPE_KEY.test(path.basename(scope))) return;
	const current = path.resolve(scope);
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to scan daemon runtime root for pruning", {
				root,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory() || !DAEMON_SCOPE_KEY.test(entry.name)) continue;
		const dir = path.join(root, entry.name);
		if (path.resolve(dir) === current) continue;
		try {
			const stat = await fs.stat(dir);
			if (now - stat.mtimeMs < DAEMON_RUNTIME_STALE_GRACE_MS) continue;
			const runtimes = [dir];
			for (const version of await fs.readdir(dir, { withFileTypes: true })) {
				if (version.isDirectory() && /^broker-v\d+$/.test(version.name))
					runtimes.push(path.join(dir, version.name));
			}
			let occupied = false;
			for (const runtime of runtimes) {
				if (
					(await readLiveDaemonBrokerPid(runtime)) !== undefined ||
					(await hasLiveDaemonProjectPresence(runtime)) ||
					(await hasLiveDaemonInRuntime(runtime))
				) {
					occupied = true;
					break;
				}
			}
			if (occupied) continue;
			await fs.rm(dir, { recursive: true, force: true });
		} catch (error) {
			if (isEnoent(error)) continue;
			logger.warn("Failed to prune dead daemon runtime dir", {
				dir,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
