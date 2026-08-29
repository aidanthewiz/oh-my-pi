import * as path from "node:path";
import { getDaemonRuntimeDir } from "@oh-my-pi/pi-utils";
import { DAEMON_BROKER_PROTOCOL_VERSION } from "./protocol";

/** Resolve the private runtime directory shared by omp processes in one project directory. */
export { getDaemonRuntimeDir as daemonRuntimeDir };

/** Isolate incompatible daemon state and endpoints from older engine processes. */
export function daemonBrokerRuntimeDir(runtimeRoot: string): string {
	return path.join(runtimeRoot, `broker-v${DAEMON_BROKER_PROTOCOL_VERSION}`);
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
