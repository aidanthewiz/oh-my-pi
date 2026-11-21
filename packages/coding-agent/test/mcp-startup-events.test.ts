import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import {
	formatMCPConnectionStatusMessage,
	isMcpConnectionStatusEvent,
} from "@oh-my-pi/pi-coding-agent/mcp/startup-events";

describe("mcp/startup-events — connection-status cross-module contract", () => {
	it("sanitizes failure errors before rendering them in status text", () => {
		const homePath = `${os.homedir()}/.omp/mcp.log`;
		const message = formatMCPConnectionStatusMessage({
			pendingServers: ["slow"],
			connectedServers: [],
			failedServers: [{ serverName: "broken", error: `failed at\t${homePath}\n${"x".repeat(120)}` }],
		});

		expect(message).not.toContain(os.homedir());
		expect(message).not.toContain("\n");
		expect(message).not.toContain("\t");
		expect(message).toContain("broken: failed at   ~/.omp/mcp.log");
	});

	it("uses shared path boundaries in command-like and quoted failure text", () => {
		const home = os.homedir();
		const message = formatMCPConnectionStatusMessage({
			pendingServers: [],
			connectedServers: [],
			failedServers: [{ serverName: "broken", error: `PYTHONPATH=${home}:/opt/lib; config \`${home}/cfg\`` }],
		});
		expect(message).toContain("PYTHONPATH=~:/opt/lib");
		expect(message).toContain("`~/cfg`");
		expect(message).not.toContain(home);
	});

	it("keeps the config source and transport error visible under independent truncation", () => {
		const message = formatMCPConnectionStatusMessage({
			pendingServers: [],
			connectedServers: [],
			failedServers: [
				{
					serverName: "broken",
					error: `ENOENT ${"missing executable ".repeat(10)}`,
					sourcePath: `${os.homedir()}/.codex/config.toml`,
				},
			],
		});

		expect(message).not.toContain(os.homedir());
		expect(message).toContain("broken [config: ~/.codex/config.toml]: ENOENT");
		expect(message).toContain("…");
	});

	it("keeps the sign-in action outside long diagnostic truncation without assigning it to permission failures", () => {
		const error = `HTTP 401: ${"server diagnostic ".repeat(30)}do-not-render-tail`;
		const signedOut = formatMCPConnectionStatusMessage({
			pendingServers: ["slow"],
			connectedServers: ["healthy"],
			failedServers: [{ serverName: "hosted", error, authRequired: true }],
		});
		expect(signedOut).toContain("/mcp");
		expect(signedOut).toContain("hosted");
		expect(signedOut).toContain("healthy");
		expect(signedOut).not.toContain("do-not-render-tail");
		const forbidden = formatMCPConnectionStatusMessage({
			pendingServers: [],
			connectedServers: [],
			failedServers: [{ serverName: "hosted", error: "HTTP 403: permission denied" }],
		});
		expect(forbidden).not.toContain("/mcp");
	});

	it("shortens config sources when the home directory contains spaces", () => {
		const homeDir = "/tmp/OMP User";
		const moduleUrl = new URL("../src/mcp/startup-events.ts", import.meta.url).href;
		const script = `
			import os from "node:os";
			import { formatMCPConnectionStatusMessage } from ${JSON.stringify(moduleUrl)};
			const sourcePath = os.homedir() + "/.codex/config.toml";
			process.stdout.write(formatMCPConnectionStatusMessage({
				pendingServers: [],
				connectedServers: [],
				failedServers: [{ serverName: "broken", error: "ENOENT", sourcePath }],
			}));
		`;
		const result = Bun.spawnSync({
			cmd: [process.execPath, "-e", script],
			env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
		});
		const message = result.stdout.toString();

		expect(result.exitCode).toBe(0);
		expect(message).not.toContain(homeDir);
		expect(message).toContain("broken [config: ~/.codex/config.toml]: ENOENT");
	});

	it("sanitizes server names before rendering them in status text", () => {
		const homePath = `${os.homedir()}/.omp`;
		const message = formatMCPConnectionStatusMessage({
			pendingServers: [`${homePath}/pending\n${"p".repeat(80)}`],
			connectedServers: [`${homePath}/connected\tserver`],
			failedServers: [{ serverName: `${homePath}/broken\nserver`, error: "missing command" }],
		});

		expect(message).not.toContain(os.homedir());
		expect(message).not.toContain("\n");
		expect(message).not.toContain("\t");
		expect(message).toContain("Connected: ~/.omp/connected   server.");
		expect(message).toContain("Failed: ~/.omp/broken server: missing command.");
		expect(message).toContain("Still connecting: ~/.omp/pending");
	});

	it("accepts well-formed payloads and rejects malformed ones", () => {
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["a", "b"] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: [] })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "reconnecting", serverName: "a" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: "a" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "a", error: "boom" })).toBe(true);
		expect(isMcpConnectionStatusEvent({ type: "cancelled", serverName: "a" })).toBe(true);
		expect(
			isMcpConnectionStatusEvent({
				type: "failed",
				serverName: "a",
				error: "boom",
				sourcePath: "/tmp/config.toml",
			}),
		).toBe(true);
		expect(
			isMcpConnectionStatusEvent({
				type: "failed",
				serverName: "hosted",
				error: "HTTP 401",
				authRequired: true,
				authDeferred: false,
			}),
		).toBe(true);
		expect(
			isMcpConnectionStatusEvent({ type: "failed", serverName: "hosted", error: "HTTP 401", authRequired: "yes" }),
		).toBe(false);
		expect(
			isMcpConnectionStatusEvent({ type: "failed", serverName: "hosted", error: "HTTP 401", authDeferred: "later" }),
		).toBe(false);

		expect(isMcpConnectionStatusEvent(null)).toBe(false);
		expect(isMcpConnectionStatusEvent(undefined)).toBe(false);
		expect(isMcpConnectionStatusEvent("mcp:connection-status")).toBe(false);
		expect(isMcpConnectionStatusEvent({})).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: "alpha" })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connecting", serverNames: ["ok", 3] })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "reconnecting", serverName: 1 })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "connected", serverName: 1 })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "cancelled", serverName: 1 })).toBe(false);
		expect(isMcpConnectionStatusEvent({ type: "failed", serverName: "a" })).toBe(false);
		expect(
			isMcpConnectionStatusEvent({
				type: "failed",
				serverName: "a",
				error: "boom",
				sourcePath: 42,
			}),
		).toBe(false);
	});
});
