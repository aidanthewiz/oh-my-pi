/**
 * Contract: a vibe worker's spawn options carry the pre-expansion model role.
 *
 * `#resolveWorker` expands the bundled worker's role alias (`good` -> `task` ->
 * `@task`, `fast` -> `sonic` -> `@smol`) into concrete patterns, so the role
 * survives only as a separate field forwarded across `ResolvedVibeWorker` ->
 * `VibeRecord` -> `#buildSpawnOptions` -> `runSubprocess`. The executor keys the
 * child's inherited `retry.fallbackChains` entry off it; drop any link in that
 * chain and vibe children silently retry on the `default` role's chain.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { VibeCli } from "@oh-my-pi/pi-tui/tools/vibe";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function makeParentSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session",
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

/** Spawn one worker and capture the ExecutorOptions the vibe path hands the executor. */
async function spawnAndCaptureOptions(cli: VibeCli, settings: Settings): Promise<ExecutorOptions> {
	const captured = Promise.withResolvers<ExecutorOptions>();
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		captured.resolve(options);
		return {
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: options.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		} as SingleResult;
	});

	const registry = VibeSessionRegistry.global();
	await registry.spawn(makeParentSession(settings), { cli, prompt: "work" });
	return captured.promise;
}

describe("vibe worker spawn model role", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("forwards the `task` role behind the `good` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
			}),
		);

		expect(options.modelOverride).toEqual(["anthropic/sonnet"]);
		expect(options.modelRole).toBe("task");
	});

	it("forwards the `smol` role behind the `fast` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"fast",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", smol: "fast/hy3" },
			}),
		);

		expect(options.modelOverride).toEqual(["fast/hy3"]);
		expect(options.modelRole).toBe("smol");
	});

	it("keeps the role identity when a per-agent model override replaces the alias", async () => {
		// `task.agentModelOverrides` wins over the agent definition, and an explicit
		// selector carries no role — the child must then inherit `default`, not
		// capture the routing of whichever role happens to name the same model.
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
				"task.agentModelOverrides": { task: "openai-codex/sol" },
			}),
		);

		expect(options.modelOverride).toEqual(["openai-codex/sol"]);
		expect(options.modelRole).toBeUndefined();
	});

	it("keeps a worker's first session inside its exact-agent account pool", async () => {
		const tempDir = TempDir.createSync("@pi-vibe-account-pool-");
		const authStorage = createInMemoryAuthStorage();
		let worker: AgentSession | undefined;
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			await authStorage.credentials.set("anthropic", {
				type: "oauth",
				access: "worker-access",
				refresh: "worker-refresh",
				expires: Date.now() + 60 * 60_000,
				email: "a@example.com",
				orgId: "org-a",
			});
			authStorage.keys.setRuntime("anthropic", "runtime-key");
			const settings = Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
				"task.agentAccountPools": {
					task: { anthropic: ["email:a@example.com|org:org-a"] },
					sonic: { anthropic: [] },
				},
			});
			const options = await spawnAndCaptureOptions("good", settings);
			({ session: worker } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
				settings,
				model,
				oauthAccountPools: options.oauthAccountPools,
				toolNames: ["read"],
				disableExtensionDiscovery: true,
			}));
			expect(await worker.modelRegistry.getApiKey(model)).toBe("worker-access");
			await authStorage.credentials.set("anthropic", { type: "api_key", key: "stored-key" });
			await expect(worker.modelRegistry.getApiKey(model)).rejects.toThrow("restricted to its OAuth account pool");
		} finally {
			await worker?.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});
});
