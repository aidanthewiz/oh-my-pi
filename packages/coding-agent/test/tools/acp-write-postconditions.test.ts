import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { routeWriteThroughBridge } from "@oh-my-pi/pi-coding-agent/tools/acp-bridge";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";

function session(cwd: string, bridge: ClientBridge): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "lsp.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getClientBridge: () => bridge,
	};
}

describe("acknowledged ACP file writes", () => {
	it("drains a committed editor write after cancellation and reports the persisted bytes", async () => {
		using temp = TempDir.createSync("@acp-write-custody-");
		const file = temp.join("document.txt");
		await Bun.write(file, "before\n");
		const committed = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const bridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => {
				await Bun.write(file, "formatted by editor\n");
				committed.resolve();
				await release.promise;
			},
		} as ClientBridge;
		const owner = session(temp.path(), bridge);
		let mutations = 0;
		owner.bumpFileMutationVersion = () => {
			return ++mutations;
		};
		const controller = new AbortController();
		let settled = false;
		const writing = new WriteTool(owner).execute(
			"owned-write",
			{ path: file, content: "requested\n" },
			controller.signal,
		);
		void writing.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await committed.promise;
			controller.abort();
			await Promise.resolve();
			expect(settled).toBe(false);
			release.resolve();
			const result = await writing;
			expect(result.isError).not.toBe(true);
			expect(await Bun.file(file).text()).toBe("formatted by editor\n");
			expect(mutations).toBe(1);
		} finally {
			release.resolve();
			await writing.catch(() => {});
		}
	});

	it("returns verified editor formatting instead of the requested pre-image", async () => {
		using temp = TempDir.createSync("@acp-verified-write-");
		const file = temp.join("document.txt");
		const bridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => {
				await Bun.write(file, "formatted\n");
			},
		} as ClientBridge;
		const result = await routeWriteThroughBridge(session(temp.path(), bridge), file, file, "requested\n");
		expect(result).toEqual({ text: "formatted\n", driftedFromRequest: true });
	});

	it("does not fabricate a verified snapshot when an acknowledged write cannot be read back", async () => {
		using temp = TempDir.createSync("@acp-unverified-write-");
		const file = temp.join("not-published.txt");
		const bridge = { capabilities: { writeTextFile: true }, writeTextFile: async () => {} } as ClientBridge;
		await expect(
			routeWriteThroughBridge(session(temp.path(), bridge), file, file, "not on disk"),
		).rejects.toBeInstanceOf(ToolError);
		expect(await Bun.file(file).exists()).toBe(false);
	});
});
