import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ThinkingConfig } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgDisabledModels, cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const perCallSettings = (model: Model, extra: Record<string, unknown> = {}) =>
	Settings.isolated({
		"task.maxRecursionDepth": 2,
		"task.perCallModel": "on",
		"task.isolation.enabled": false,
		"compaction.enabled": false,
		modelRoles: { review: `mock/${model.id}` },
		...extra,
	});

const cleanups: (() => Promise<void>)[] = [];
let runs = 0;

/** Runs a bundled `worker` on `perCallModel` through the real executor, with `model` as the only registry entry. */
async function runWorker(options: {
	model: Model;
	perCallModel: string;
	settings?: Settings;
	assignment?: string;
	setup?: (modelRegistry: ModelRegistry) => void;
}) {
	const { model } = options;
	const run = ++runs;
	const sourceId = `executor-exact-model-${run}`;
	const agentId = `ExactModel${run}`;
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-exact-model-"));
	const authStorage = await AuthStorage.create(":memory:");
	cleanups.push(async () => {
		await AgentRegistry.global().get(agentId)?.session?.dispose();
		AgentRegistry.global().unregister(agentId);
		unregisterCustomApis(sourceId);
		authStorage.close();
		await fs.rm(cwd, { recursive: true, force: true });
	});
	authStorage.keys.setRuntime("mock", "test-key");
	registerMockApi(sourceId);
	const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
	const find = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
		provider === "mock" && id === model.id ? model : find(provider, id),
	);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [model]);
	vi.spyOn(modelRegistry, "getAll").mockImplementation(() => [model]);
	options.setup?.(modelRegistry);
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ name: "worker", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] }],
		projectAgentsDir: null,
	});
	const session = {
		cwd,
		hasUI: false,
		settings: options.settings ?? perCallSettings(model),
		authStorage,
		modelRegistry,
		restrictToolNames: true,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
	} as unknown as ToolSession;
	const execution = await runStructuredSubagent({
		session,
		invocationKind: "task",
		assignment: options.assignment ?? "Answer the question.",
		agent: "worker",
		perCallModel: options.perCallModel,
		structured: false,
		identity: { id: agentId },
		keepAlive: false,
	});
	return execution.result;
}

const failure = (result: { error?: string; stderr: string; output: string }) =>
	`${result.error ?? ""}${result.stderr}${result.output}`;

describe("per-call exact selection after background discovery", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	it.each([false, true])("holds exact selection through cold discovery (%s)", async exact => {
		const model = createMockModel({
			id: "requested-model-complete",
			handler: () => ({ content: ["Exact answer."] }),
		});
		const result = await runWorker({
			model,
			perCallModel: exact ? `mock/${model.id}` : "mock/requested-model",
			setup: modelRegistry => {
				let warm = false;
				vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => (warm ? [model] : []));
				vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockImplementation(async () => {
					warm = true;
				});
			},
		});
		if (exact) {
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("Exact answer.");
			expect(model.calls).toHaveLength(1);
		} else {
			expect(model.calls).toHaveLength(0);
			expect(result.exitCode).not.toBe(0);
			expect(failure(result)).toMatch(/exact model|unavailable/);
		}
	});

	it.each(["role", "enabledModels", "disabledModels"] as const)(
		"refuses the next request when the operator revokes the model via %s",
		async policy => {
			const settings = perCallSettings(createMockModel({ id: "revoked-model" }), { "retry.enabled": false });
			const model = createMockModel({
				id: "revoked-model",
				responses: [
					() => {
						if (policy === "role") settings.setModelRole("review", "mock/other-model");
						else if (policy === "enabledModels") cfgEnabledModels.override(settings, ["mock/other-model"]);
						else cfgDisabledModels.override(settings, ["mock/revoked-model"]);
						return { content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] };
					},
				],
				handler: () => ({ content: ["Answer after revocation."] }),
			});
			const result = await runWorker({
				model,
				settings,
				perCallModel: `mock/${model.id}`,
				assignment: "Read notes.txt, then answer.",
			});
			// Only the request admitted before the revocation reached the model.
			expect(model.calls).toHaveLength(1);
			expect(result.output).not.toContain("Answer after revocation.");
			expect(failure(result)).toMatch(/not approved|not an available chat model|disabled/);
		},
	);

	it.each([
		{ label: "clamps a :high selector to task.maxEffort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		{ label: "fails a model whose lowest effort is above task.maxEffort", efforts: [Effort.High] },
	])("$label on the running worker", async ({ efforts }) => {
		const model = Object.assign(
			createMockModel({ id: "laddered", reasoning: true, handler: () => ({ content: ["Capped answer."] }) }),
			{ thinking: { mode: "effort", efforts } satisfies ThinkingConfig },
		);
		const result = await runWorker({
			model,
			settings: perCallSettings(model, { "task.maxEffort": "low" }),
			perCallModel: `mock/${model.id}:high`,
		});
		if (efforts.length > 1) {
			expect(result.exitCode).toBe(0);
			// The request the provider receives runs at the ceiling, not the requested `:high`.
			expect(model.calls.map(call => call.options?.reasoning)).toEqual([Effort.Low]);
		} else {
			expect(model.calls).toHaveLength(0);
			expect(result.exitCode).not.toBe(0);
			expect(failure(result)).toMatch(/no supported thinking effort at or below task\.maxEffort=low/);
		}
	});

	it.each([
		{ id: "coding-router", selector: "mock/coding-router:low", level: Effort.Low },
		{
			id: "coding-router:low",
			selector: "mock/coding-router:low:high",
			level: Effort.High,
		},
	])(
		"dispatches $selector without confusing a literal model id with its thinking suffix",
		async ({ id, selector, level }) => {
			const model = Object.assign(
				createMockModel({ id, reasoning: true, handler: () => ({ content: ["Persisted."] }) }),
				{ thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] } satisfies ThinkingConfig },
			);
			const result = await runWorker({
				model,
				settings: perCallSettings(model, { "task.maxEffort": "high" }),
				perCallModel: selector,
			});
			expect(result.exitCode).toBe(0);
			expect(model.calls.map(call => call.options?.reasoning)).toEqual([level]);
		},
	);
});
