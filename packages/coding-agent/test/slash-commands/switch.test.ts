import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { TempDir } from "@oh-my-pi/pi-utils";

const selector = "anthropic/claude-sonnet-4-5";

describe("/switch session role transitions", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let settings: Settings;
	let manager: SessionManager;
	let session: AgentSession;
	let context: InteractiveModeContext;
	let model: Model;

	beforeEach(async () => {
		directory = TempDir.createSync("@pi-switch-role-");
		auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		auth.keys.setRuntime("anthropic", "test-key");
		const registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
		model = registry.find("anthropic", "claude-sonnet-4-5")!;
		settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", selector);
		settings.setModelRole("smol", `${selector}:low`);
		manager = SessionManager.inMemory();
		manager.appendModelChange(selector, "default");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, tools: [], messages: [], systemPrompt: ["Test"], thinkingLevel: Effort.Medium },
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
		});
		context = {
			session,
			get viewSession() {
				return context.session;
			},
			sessionManager: manager,
			settings,
			editor: { setText: () => {} },
			statusLine: { invalidate: () => {} },
			keybindings: { getKeys: () => [] },
			updateEditorBorderColor: () => {},
			showStatus: () => {},
			showError: (error: string) => {
				throw new Error(error);
			},
			handleCompactCommand: async () => {
				throw new Error("An empty session must not compact");
			},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(context);
		context.switchSessionModel = controller.switchSessionModel.bind(controller);
	});

	afterEach(async () => {
		await session.dispose();
		await auth.close();
		directory.removeSync();
	});

	for (const mode of ["tui", "acp"] as const) {
		it(`${mode} preserves explicit role identity when roles share a model`, async () => {
			const command = "/switch @smol:high";
			if (mode === "tui") {
				await executeBuiltinSlashCommand(command, { ctx: context });
			} else {
				await lookupBuiltinSlashCommand("switch")!.handle!(parseSlashCommand(command)!, {
					session,
					sessionManager: manager,
					settings,
					cwd: directory.path(),
					output: () => {},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				});
			}
			const cycle = session.getRoleModelCycle(["default", "smol"]);
			expect(session.model?.id).toBe(model.id);
			expect(session.thinkingLevel).toBe(Effort.High);
			expect(manager.getLastModelChangeRole()).toBe("smol");
			expect(cycle?.models[cycle.currentIndex].role).toBe("smol");
			expect(settings.getModelRole("smol")).toBe(`${selector}:low`);
			expect(settings.getModelRole("default")).toBe(selector);
		});
	}

	it("keeps a direct model selector temporary rather than assigning a matching role", async () => {
		await executeBuiltinSlashCommand(`/switch ${selector}:high`, { ctx: context });
		expect(session.model?.id).toBe(model.id);
		expect(session.thinkingLevel).toBe(Effort.High);
		expect(manager.getLastModelChangeRole()).toBe("temporary");
		expect(settings.getModelRole("smol")).toBe(`${selector}:low`);
		expect(settings.getModelRole("default")).toBe(selector);
	});

	it("resolves a focused session's role without changing the main model or either saved role", async () => {
		const childSettings = Settings.isolated({
			"compaction.enabled": false,
			modelRoles: { default: selector, smol: `${selector}:high` },
		});
		const childManager = SessionManager.inMemory();
		const child = new AgentSession({
			agent: new Agent({
				initialState: { model, tools: [], messages: [], systemPrompt: ["Child"], thinkingLevel: Effort.Low },
			}),
			sessionManager: childManager,
			settings: childSettings,
			modelRegistry: session.modelRegistry,
			scopedModels: [{ model, thinkingLevel: Effort.High }],
		});
		try {
			const focused = { ...context, viewSession: child, focusedAgentId: "child" };
			const controller = new SelectorController(focused);
			focused.switchSessionModel = controller.switchSessionModel.bind(controller);

			await executeBuiltinSlashCommand("/switch @smol", { ctx: focused });

			expect(child.thinkingLevel).toBe(Effort.High);
			expect(childManager.getLastModelChangeRole()).toBe("smol");
			expect(session.model?.id).toBe(model.id);
			expect(manager.getLastModelChangeRole()).toBe("default");
			expect(childSettings.getModelRole("smol")).toBe(`${selector}:high`);
			expect(settings.getModelRole("smol")).toBe(`${selector}:low`);
		} finally {
			await child.dispose();
		}
	});
});
