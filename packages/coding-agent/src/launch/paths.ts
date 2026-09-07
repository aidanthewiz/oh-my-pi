import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemonRuntimeDir, isEisdir, isEnoent } from "@oh-my-pi/pi-utils";
import { DAEMON_BROKER_PROTOCOL_VERSION } from "./protocol";

/** Resolve the private runtime directory shared by omp processes in one project directory. */
export { getDaemonRuntimeDir as daemonRuntimeDir };

/** Isolate incompatible daemon state and endpoints from older engine processes. */
export function daemonBrokerRuntimeDir(runtimeRoot: string): string {
	return path.join(runtimeRoot, `broker-v${DAEMON_BROKER_PROTOCOL_VERSION}`);
}

/** File in a broker runtime dir recording which project (or global service dir) owns the scope. */
const SCOPE_FILE = "scope.json";

/**
 * Canonicalize a project directory the same way every broker client does, so
 * hash-keyed runtime dirs and Windows pipe names agree across processes.
 * Missing paths resolve without realpath instead of failing.
 */
export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error)) return resolved;
		throw error;
	}
}

/**
 * Record the scope's canonical project directory inside its runtime dir.
 * Written by the broker at startup so out-of-process inspectors (`omp ps`)
 * can map a hash-keyed runtime dir back to its project.
 */
export async function writeDaemonScopeMeta(runtimeDir: string, projectDir: string): Promise<void> {
	await Bun.write(path.join(runtimeDir, SCOPE_FILE), JSON.stringify({ projectDir }));
}

/** Read the project directory recorded for a runtime dir; undefined when absent or malformed. */
export async function readDaemonScopeMeta(runtimeDir: string): Promise<string | undefined> {
	try {
		const raw: unknown = await Bun.file(path.join(runtimeDir, SCOPE_FILE)).json();
		if (typeof raw === "object" && raw !== null && "projectDir" in raw && typeof raw.projectDir === "string") {
			return raw.projectDir;
		}
	} catch {
		// Missing or malformed scope metadata reads as unknown.
	}
	return undefined;
}

/** Resolve the Unix socket or Windows named pipe used by one daemon broker scope. */
export function daemonBrokerEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		const key = Bun.hash
			.wyhash(`${path.resolve(projectDir)}\0${path.resolve(runtimeDir)}`)
			.toString(16)
			.padStart(16, "0");
		return `\\\\.\\pipe\\omp-daemon-v${DAEMON_BROKER_PROTOCOL_VERSION}-${key}`;
	}
	return path.join(runtimeDir, "broker.sock");
}
