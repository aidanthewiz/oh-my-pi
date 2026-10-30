import { afterEach, describe, expect, it, vi } from "bun:test";
import type { SSHConnectionTarget } from "../../src/ssh/connection-manager";
import * as connectionManager from "../../src/ssh/connection-manager";
import { readRemoteFile, writeRemoteFile } from "../../src/ssh/file-transfer";

describe("ssh file-transfer POSIX guard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects a confirmed Windows remote before running any POSIX command", async () => {
		// Stub BOTH the connection and the host-info probe so the guard is reached
		// without opening a real SSH connection and before any command is spawned.
		const ensureConnectionSpy = vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		const ensureHostInfoSpy = vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "windows",
			shell: "powershell",
			compatEnabled: false,
		});
		const target: SSHConnectionTarget = { name: "winbox", host: "winbox" };
		await expect(readRemoteFile(target, "C:/x.txt", { maxBytes: 1024 })).rejects.toThrow(
			/Windows host.*use `bash` with a remote SSH command/,
		);
		await expect(writeRemoteFile(target, "C:/x.txt", new Uint8Array([1]), {})).rejects.toThrow(
			/Windows host.*use `bash` with a remote SSH command/,
		);
		// Prove the guard ran through the stubbed transport rather than failing early
		// for an unrelated reason (e.g. a future import refactor bypassing the mocks).
		expect(ensureConnectionSpy).toHaveBeenCalled();
		expect(ensureHostInfoSpy).toHaveBeenCalled();
	});

	it("rejects a non-Windows remote with no verified transferShell", async () => {
		// No transferShell means the capability probe never confirmed any of
		// sh/bash/zsh works. The guard refuses regardless of `shell` because the
		// real ssh:// contract is "did we verify a POSIX shell works", not
		// "what name did the login shell self-report" (#3719).
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 4,
			os: "linux",
			shell: "unknown",
			compatEnabled: false,
		});
		const target: SSHConnectionTarget = { name: "noshell", host: "noshell" };
		await expect(readRemoteFile(target, "/etc/hosts", { maxBytes: 1024 })).rejects.toThrow(
			/no verified POSIX shell.*use `bash` with a remote SSH command/,
		);
		await expect(writeRemoteFile(target, "/tmp/x", new Uint8Array([1]), {})).rejects.toThrow(
			/no verified POSIX shell.*use `bash` with a remote SSH command/,
		);
	});
});
