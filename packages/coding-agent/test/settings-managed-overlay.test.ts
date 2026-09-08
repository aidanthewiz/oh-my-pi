import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MANAGED_CONFIG_FILE_ENV, MANAGED_CONFIG_FILENAME, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

/**
 * The managed overlay (`<agentDir>/config.managed.yml`) is the org-policy
 * layer a managed distribution (e.g. the coreforge launcher) ships alongside
 * the profile. Contract under test:
 *
 *   defaults <- global <- project <- CLI overlays <- MANAGED <- runtime overrides
 *
 * - present  -> its keys beat config.yml / project config / --config overlays
 * - deep-merged -> user-added record keys (modelRoles.myRole) survive
 * - absent   -> zero behavioural change (upstream default)
 * - runtime  -> overrides still beat it (in-session /model switching works)
 * - writes   -> never land in the managed file (global config.yml only)
 */
describe("Settings managed overlay", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-managed-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.close();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		delete Bun.env[MANAGED_CONFIG_FILE_ENV];
		await tempDir?.remove();
	});

	const managedPath = () => path.join(agentDir, MANAGED_CONFIG_FILENAME);
	const configPath = () => path.join(agentDir, "config.yml");

	const writeManaged = async (settings: Record<string, unknown>) => {
		await Bun.write(managedPath(), YAML.stringify(settings, null, 2));
	};
	const writeGlobal = async (settings: Record<string, unknown>) => {
		await Bun.write(configPath(), YAML.stringify(settings, null, 2));
	};

	it("overrides global config.yml values", async () => {
		await writeGlobal({ modelRoles: { default: "anthropic/user-picked" } });
		await writeManaged({ modelRoles: { default: "anthropic-aws/org-pinned" } });

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.getModelRole("default")).toBe("anthropic-aws/org-pinned");
	});

	it("uses an invocation-specific managed overlay when selected", async () => {
		await writeManaged({ modelRoles: { default: "anthropic-aws/profile-backend" } });
		const overridePath = tempDir.join("catalog-managed.yml");
		await Bun.write(
			overridePath,
			YAML.stringify({ modelRoles: { default: "openai-codex/catalog-backend" } }, null, 2),
		);
		Bun.env[MANAGED_CONFIG_FILE_ENV] = overridePath;

		const settings = await Settings.init({ cwd: projectDir, agentDir });

		expect(settings.getModelRole("default")).toBe("openai-codex/catalog-backend");
	});

	it("deep-merges records so user-added keys survive", async () => {
		await writeGlobal({
			modelRoles: { default: "anthropic/user-picked", myCustomRole: "openai/user-model" },
		});
		await writeManaged({ modelRoles: { default: "anthropic-aws/org-pinned" } });

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.getModelRole("default")).toBe("anthropic-aws/org-pinned");
		expect(settings.getModelRole("myCustomRole")).toBe("openai/user-model");
	});

	it("overrides project config", async () => {
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			YAML.stringify({ modelRoles: { default: "openai/project-model" } }, null, 2),
		);
		await writeManaged({ modelRoles: { default: "anthropic-aws/org-pinned" } });

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.getModelRole("default")).toBe("anthropic-aws/org-pinned");
	});

	it("overrides --config CLI overlays", async () => {
		const overlayPath = tempDir.join("overlay.yml");
		await Bun.write(overlayPath, YAML.stringify({ modelRoles: { default: "openai/cli-model" } }, null, 2));
		await writeManaged({ modelRoles: { default: "anthropic-aws/org-pinned" } });

		const settings = await Settings.init({ cwd: projectDir, agentDir, configFiles: [overlayPath] });
		expect(settings.getModelRole("default")).toBe("anthropic-aws/org-pinned");
	});

	it("yields to runtime overrides (in-session model switching)", async () => {
		await writeManaged({ modelRoles: { default: "anthropic-aws/org-pinned" } });

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.overrideModelRoles({ default: "openai/session-switch" });
		expect(settings.getModelRole("default")).toBe("openai/session-switch");
	});

	it("changes nothing when the file is absent", async () => {
		await writeGlobal({ modelRoles: { default: "anthropic/user-picked" } });

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.getModelRole("default")).toBe("anthropic/user-picked");
	});

	it("treats a malformed managed file as empty instead of failing startup", async () => {
		await writeGlobal({ modelRoles: { default: "anthropic/user-picked" } });
		await Bun.write(managedPath(), "- just\n- a\n- list\n");

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.getModelRole("default")).toBe("anthropic/user-picked");
	});

	it("never writes managed values back to disk", async () => {
		await writeManaged({ modelRoles: { default: "anthropic-aws/org-pinned" } });

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.set("setupVersion", 3);
		await settings.flush();

		const managedRaw = YAML.parse(await Bun.file(managedPath()).text()) as Record<string, unknown>;
		expect(managedRaw).toEqual({ modelRoles: { default: "anthropic-aws/org-pinned" } });
		const globalRaw = YAML.parse(await Bun.file(configPath()).text()) as Record<string, unknown>;
		expect(globalRaw.setupVersion).toBe(3);
		// The managed value must not have been baked into the persisted global file.
		expect(globalRaw.modelRoles).toBeUndefined();
	});

	it("persists role edits to the global file while the managed value keeps winning", async () => {
		await writeManaged({ modelRoles: { default: "anthropic-aws/org-pinned" } });

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.setModelRole("default", "openai/user-attempt");
		await settings.flush();

		// The write landed in config.yml (user intent preserved on disk)...
		const globalRaw = YAML.parse(await Bun.file(configPath()).text()) as Record<string, unknown>;
		expect((globalRaw.modelRoles as Record<string, string>).default).toBe("openai/user-attempt");
		// ...but the effective value stays org-pinned.
		expect(settings.getModelRole("default")).toBe("anthropic-aws/org-pinned");
	});

	it("carries the managed layer through cloneForCwd", async () => {
		await writeManaged({ modelRoles: { default: "anthropic-aws/org-pinned" } });

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const otherProject = tempDir.join("other-project");
		fs.mkdirSync(otherProject, { recursive: true });
		const cloned = await settings.cloneForCwd(otherProject);
		expect(cloned.getModelRole("default")).toBe("anthropic-aws/org-pinned");
	});

	it("loads the managed layer in read-only mode", async () => {
		await writeGlobal({ modelRoles: { default: "anthropic/user-picked" } });
		await writeManaged({ modelRoles: { default: "anthropic-aws/org-pinned" } });

		const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });
		expect(settings.getModelRole("default")).toBe("anthropic-aws/org-pinned");
	});
});
