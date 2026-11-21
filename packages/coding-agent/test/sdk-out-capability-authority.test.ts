import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { cfgOutEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

async function withSession(
	settings: Settings,
	taskDepth: number,
	tuiTranscript: boolean,
	run: (session: AgentSession) => Promise<void>,
	root?: string,
) {
	using temp = TempDir.createSync("@omp-out-authority-");
	const cwd = root ?? temp.path();
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, temp.join("models.yml"), {
		settings,
		cacheDbPath: temp.join("models.db"),
	});
	vi.spyOn(modelRegistry, "getDiscoverableProviders").mockReturnValue([]);
	const preconnect = () => {
		throw new Error("Unexpected network preconnect");
	};
	const network = vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async () => {
				throw new Error("Unexpected network request");
			},
			{ preconnect },
		),
	);
	Object.assign(network, { preconnect });
	let session: AgentSession | undefined;
	try {
		({ session } = await createAgentSession({
			cwd,
			agentDir: temp.join("agent"),
			authStorage,
			modelRegistry,
			settings,
			bindProcessState: false,
			sessionManager: SessionManager.inMemory(cwd),
			model: getBundledModel("openai", "gpt-4o-mini"),
			taskDepth,
			tuiTranscript,
			hasUI: tuiTranscript,
			disableExtensionDiscovery: true,
			preloadedCustomToolPaths: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		}));
		await run(session);
	} finally {
		try {
			await session?.dispose();
		} finally {
			settings.cancelPendingSaves();
			await authStorage.close();
			expect(network).not.toHaveBeenCalled();
		}
	}
}

async function assertCapability(settings: Settings, taskDepth: number, tuiTranscript: boolean, allowed: boolean) {
	const caller = { settings, taskDepth, tuiTranscript } as unknown as ToolSession;
	const router = InternalUrlRouter.instance();
	const tier = router.writeTier("out://", "Synthetic status", caller);
	if (allowed) {
		expect(tier).toBe("read");
		const written = await router.write("out://", "Synthetic status", { session: caller });
		expect(written).toMatchObject({ useless: true });
	} else {
		expect(tier).toMatchObject({ policy: "deny" });
		await expect(router.write("out://", "Synthetic status", { session: caller })).rejects.toThrow();
	}
}

async function changeCapability(session: AgentSession, change: () => void | Promise<void>) {
	const rebuilds: Promise<void>[] = [];
	const original = session.refreshBaseSystemPrompt.bind(session);
	const spy = vi.spyOn(session, "refreshBaseSystemPrompt").mockImplementation(() => {
		const rebuilding = original();
		rebuilds.push(rebuilding);
		return rebuilding;
	});
	try {
		await change();
		// Derived settings coalesce notifications in a microtask; await only rebuilds the real listener started.
		await Promise.resolve();
		await Promise.all(rebuilds);
	} finally {
		spy.mockRestore();
	}
}

describe("out:// session capability authority", () => {
	for (const taskDepth of [0, 1]) {
		for (const tuiTranscript of [false, true]) {
			for (const enabled of [undefined, false, true]) {
				it(`TA-OUT-MATRIX depth ${taskDepth}, TUI ${tuiTranscript}, configured ${enabled}`, async () => {
					const settings = Settings.isolated(enabled === undefined ? {} : { "out.enabled": enabled });
					await withSession(settings, taskDepth, tuiTranscript, async () => {
						await assertCapability(
							settings,
							taskDepth,
							tuiTranscript,
							taskDepth === 0 && (enabled ?? tuiTranscript),
						);
					});
				}, 15_000);
			}
		}
	}

	it("TA-OUT-OVERRIDE refreshes headless capability on equal-default override and clear", async () => {
		const settings = Settings.isolated();
		await withSession(settings, 0, false, async session => {
			await assertCapability(settings, 0, false, false);
			await changeCapability(session, () => cfgOutEnabled.override(settings, true));
			await assertCapability(settings, 0, false, true);
			await changeCapability(session, () => cfgOutEnabled.clearOverride(settings));
			await assertCapability(settings, 0, false, false);
		});
	}, 15_000);

	it("TA-OUT-OVERLAY follows parent configuredness without pinning the child", async () => {
		const parent = Settings.isolated();
		const child = parent.overlay();
		try {
			await withSession(child, 0, false, async session => {
				await assertCapability(child, 0, false, false);
				await changeCapability(session, () => cfgOutEnabled.override(parent, true));
				await assertCapability(child, 0, false, true);
				await changeCapability(session, () => cfgOutEnabled.clearOverride(parent));
				await assertCapability(child, 0, false, false);
			});
		} finally {
			parent.cancelPendingSaves();
		}
	}, 15_000);

	it("TA-OUT-RELOAD refreshes headless capability on persisted unset/true/unset transitions", async () => {
		// AgentStorage has only process-wide closure; isolate this disk-backed fixture from other suites' handles.
		if (process.env.OMP_TEST_OUT_CAPABILITY_RELOAD_CHILD !== "1") {
			const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "TA-OUT-RELOAD"], {
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: { ...process.env, OMP_TEST_OUT_CAPABILITY_RELOAD_CHILD: "1" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			// A real deadline bounds a separate Bun process; fake timers cannot stop a hung worker.
			const timer = setTimeout(() => child.kill(), 20_000);
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect({ exitCode, diagnostics: exitCode === 0 ? "" : `${stdout}\n${stderr}` }).toEqual({
					exitCode: 0,
					diagnostics: "",
				});
			} finally {
				clearTimeout(timer);
				if (child.exitCode === null) child.kill();
				await child.exited;
			}
			return;
		}

		using temp = TempDir.createSync("@omp-out-reload-");
		const agentDir = temp.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const config = path.join(agentDir, "config.yml");
		fs.writeFileSync(config, "{}\n");
		let settings: Settings | undefined;
		try {
			const loaded = await Settings.loadIsolated({ cwd: temp.path(), agentDir });
			settings = loaded;
			await withSession(
				loaded,
				0,
				false,
				async session => {
					await assertCapability(loaded, 0, false, false);
					await changeCapability(session, async () => {
						fs.writeFileSync(config, "out:\n  enabled: true\n");
						await loaded.reloadFromDisk();
					});
					await assertCapability(loaded, 0, false, true);
					await changeCapability(session, async () => {
						fs.writeFileSync(config, "{}\n");
						await loaded.reloadFromDisk();
					});
					await assertCapability(loaded, 0, false, false);
				},
				temp.path(),
			);
		} finally {
			settings?.cancelPendingSaves();
			AgentStorage.close();
		}
	}, 25_000);
});
