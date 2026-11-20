import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const createAgentSession = sdkModule.createAgentSession;
const ASSIGNMENT = "Inspect the synthetic autoload target.";

interface SkillHarness {
	root: string;
	parent: CreateAgentSessionResult;
	toolSession: ToolSession;
	requests: string[];
	writeSkill: (name: string, body: string) => Promise<void>;
}

async function withSkills(run: (harness: SkillHarness) => Promise<void>, excluded: string[] = []): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-autoload-consumer-"));
	const authStorage = createInMemoryAuthStorage();
	const sessions: AgentSession[] = [];
	try {
		const skillsDir = path.join(root, "skills");
		await fs.mkdir(skillsDir);
		authStorage.keys.setRuntime("anthropic", "synthetic-autoload-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled autoload test model");
		const settings = Settings.isolated({
			"async.enabled": false,
			"advisor.enabled": false,
			"compaction.enabled": false,
			"todo.enabled": false,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			"plugins.persistentPolicy": "allowlist",
			"plugins.persistentAllowlist": [],
			"skills.enableCodexUser": false,
			"skills.enableClaudeUser": false,
			"skills.enableClaudeProject": false,
			"skills.enablePiUser": false,
			"skills.enablePiProject": false,
			"skills.enableAgentsUser": false,
			"skills.enableAgentsProject": false,
			"skills.customDirectories": [skillsDir],
			disabledExtensions: excluded.map(name => `skill:${name}`),
		});
		const parent = await createAgentSession({
			cwd: root,
			agentDir: root,
			agentId: `${path.basename(root)}-parent`,
			authStorage,
			modelRegistry,
			model,
			settings,
			sessionManager: SessionManager.inMemory(root),
			toolNames: [],
			contextFiles: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			cacheWarming: false,
		});
		sessions.push(parent.session);
		const toolSession: ToolSession = {
			cwd: root,
			hasUI: false,
			settings,
			authStorage,
			modelRegistry,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			getSessionFile: () => null,
			getSessionId: () => parent.session.sessionManager.getSessionId(),
			getSessionSpawns: () => "*",
			getSessionAgents: () => [],
			getActiveModel: () => parent.session.model,
			getAgentId: () => parent.session.getAgentId() ?? null,
			get skills() {
				return parent.session.skills;
			},
			refreshSkills: () => parent.session.refreshSkills(),
			captureOwnerCurrent: parent.captureOwnerCurrent,
			captureOwnerLifetimeCurrent: parent.captureOwnerLifetimeCurrent,
			contextFiles: [],
			rules: [],
			promptTemplates: [],
		};
		const requests: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const child = await createAgentSession({
				...options,
				agentDir: root,
				slashCommands: [],
				disableExtensionDiscovery: true,
				skipPythonPreflight: true,
			});
			sessions.push(child.session);
			const transport = createMockModel({
				responses: [{ content: ["The skill-guided inspection is complete."] }],
			});
			child.session.agent.streamFn = (requestModel, context, options) => {
				requests.push(JSON.stringify(context.messages));
				return transport.stream(requestModel, context, options);
			};
			return child;
		});
		await run({
			root,
			parent,
			toolSession,
			requests,
			writeSkill: async (name, body) => {
				const baseDir = path.join(skillsDir, name);
				await fs.mkdir(baseDir);
				await Bun.write(
					path.join(baseDir, "SKILL.md"),
					`---\nname: ${name}\ndescription: Synthetic autoload skill.\n---\n\n${body}\n`,
				);
			},
		});
	} finally {
		vi.restoreAllMocks();
		try {
			await Promise.all(sessions.map(session => session.dispose()));
		} finally {
			await authStorage.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	}
}

function firstRequestText(requests: string[]): string {
	expect(requests[0]?.includes(ASSIGNMENT)).toBe(true);
	return requests[0];
}

describe("autoloadSkills in executor", () => {
	it("delivers each skill body before the assignment in the first model request", async () => {
		await withSkills(async ({ root, parent, toolSession, requests, writeSkill }) => {
			await writeSkill("skill-a", "Synthetic skill A instructions.");
			await writeSkill("skill-b", "Synthetic skill B instructions.");
			await parent.session.refreshSkills();
			const skills = parent.session.skills.filter(skill => ["skill-a", "skill-b"].includes(skill.name));
			const result = await runSubprocess({
				cwd: root,
				agent: { name: "task", description: "test", systemPrompt: "Test", source: "bundled", tools: [] },
				task: ASSIGNMENT,
				index: 0,
				id: `${path.basename(root)}-child`,
				settings: toolSession.settings,
				modelRegistry: toolSession.modelRegistry,
				modelOverride: ["anthropic/claude-sonnet-4-5"],
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
				keepAlive: false,
				skills,
				autoloadSkills: skills,
			});
			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);
			const context = firstRequestText(requests);
			for (const body of ["Synthetic skill A instructions.", "Synthetic skill B instructions."]) {
				expect(context).toContain(body);
				expect(context.indexOf(body)).toBeLessThan(context.indexOf(ASSIGNMENT));
			}
		});
	});
});

describe("autoloadSkills through task spawn", () => {
	it.each(["late", "excluded", "unavailable", "not-requested"] as const)(
		"handles a %s skill in the child's first model context",
		async availability => {
			await withSkills(
				async ({ parent, toolSession, requests, writeSkill }) => {
					expect(parent.session.skills.some(skill => skill.name === "late-skill")).toBe(false);
					if (availability !== "unavailable") await writeSkill("late-skill", "Late skill body.");
					vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
						agents: [
							{
								name: "late-agent",
								description: "Autoloads a late skill",
								systemPrompt: "Test",
								source: "project",
								tools: [],
								autoloadSkills: availability === "not-requested" ? [] : ["late-skill"],
							},
						],
						projectAgentsDir: null,
					});
					const { result } = await runStructuredSubagent({
						session: toolSession,
						invocationKind: "task",
						assignment: ASSIGNMENT,
						agent: "late-agent",
						keepAlive: false,
					});
					expect(result.error).toBeUndefined();
					expect(result.exitCode).toBe(0);
					const context = firstRequestText(requests);
					if (availability === "late") {
						expect(parent.session.skills.some(skill => skill.name === "late-skill")).toBe(true);
						expect(context).toContain("Late skill body.");
						expect(context.indexOf("Late skill body.")).toBeLessThan(context.indexOf(ASSIGNMENT));
					} else {
						expect(context).not.toContain("Late skill body.");
					}
				},
				availability === "excluded" ? ["late-skill"] : [],
			);
		},
	);
});
