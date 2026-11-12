import { expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

async function runPrewalkResumeCase(inherited: boolean, disableModelFallback = false): Promise<void> {
	using temp = TempDir.createSync("@pi-prewalk-resume-intent-");
	const source = "test/sdk-prewalk-resume-intent";
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const registry = new ModelRegistry(authStorage, temp.join("models.yml"));
	const model = Object.assign(
		createMockModel({
			id: "resume-effort-target",
			reasoning: true,
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "todo",
							arguments: { op: "init", list: [{ phase: "Work", items: ["Write proof"] }] },
						},
					],
				},
				{
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: { path: temp.join("out.txt"), content: "once\n" },
						},
					],
				},
				{ content: ["complete"] },
			],
		}),
		{ thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] } as const },
	);
	const availableSpy = vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
	let session: AgentSession | undefined;
	let manager: SessionManager | undefined;
	registerMockApi(source);
	try {
		manager = SessionManager.create(temp.path(), temp.join("sessions"));
		await manager.ensureOnDisk();
		manager.appendModelChange("mock/resume-effort-target", "prewalk");
		manager.appendThinkingLevelChange(Effort.Low, Effort.Low);
		manager.appendMessage({ role: "user", content: "previous completed task", timestamp: Date.now() });
		const filename = manager.getSessionFile();
		if (!filename) throw new Error("Expected persisted fixture");
		await manager.close();
		manager = await SessionManager.open(filename, undefined, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		({ session } = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.path(),
			authStorage,
			modelRegistry: registry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"async.enabled": false,
				"retry.enabled": false,
				"advisor.enabled": false,
				"tools.format": "native",
				"todo.enabled": true,
				"todo.reminders": false,
				"prewalk.auto": "off",
				"title.refreshOnReplan": false,
			}),
			sessionManager: manager,
			model,
			thinkingLevel: Effort.High,
			prewalk: { target: model, thinkingLevel: Effort.Low },
			disableModelFallback,
			...(inherited ? { prewalkInherited: true } : {}),
			bindProcessState: false,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["todo", "write"],
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			autoApprove: true,
		}));
		expect(session.configuredThinkingLevel()).toBe(Effort.High);
		await session.prompt("Write the synthetic proof once and finish.");
		const results = manager
			.getEntries()
			.flatMap(entry =>
				entry.type === "message" && entry.message.role === "toolResult"
					? [{ name: entry.message.toolName, failed: entry.message.isError === true }]
					: [],
			);
		expect(results).toEqual([
			{ name: "todo", failed: false },
			{ name: "write", failed: false },
		]);
		expect(await Bun.file(temp.join("out.txt")).text()).toBe("once\n");
		expect(model.calls.map(call => call.options?.reasoning)).toEqual([
			Effort.High,
			Effort.High,
			inherited || disableModelFallback ? Effort.High : Effort.Low,
		]);
		expect(
			manager
				.getEntries()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "assistant"
						? [`${entry.message.provider}/${entry.message.model}`]
						: [],
				),
		).toEqual(["mock/resume-effort-target", "mock/resume-effort-target", "mock/resume-effort-target"]);
		expect(session.getPrewalkState()).toBeUndefined();
	} finally {
		try {
			if (session) await session.dispose();
		} finally {
			try {
				await manager?.close();
			} finally {
				availableSpy.mockRestore();
				unregisterCustomApis(source);
				await authStorage.close();
			}
		}
	}
}

it("honors a fresh explicit effort-only prewalk after a persisted handoff", () => runPrewalkResumeCase(false), 30_000);

it("does not replay an inherited arm after the operator changed only effort", () => runPrewalkResumeCase(true), 30_000);

it(
	"keeps the approved effort of an exact-model request instead of applying a configured prewalk",
	() => runPrewalkResumeCase(false, true),
	30_000,
);
