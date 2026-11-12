import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	artifactFileGeneration,
	parseStructuredArtifactSidecar,
	serializeStructuredArtifactSidecar,
} from "@oh-my-pi/pi-coding-agent/session/artifacts";
import type { TaskToolDetails, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const AGENT_ID = "FocusedYield";
const PARENT_ID = "Main";
const MOCK_API_SOURCE = "test/focused-subagent-manual-yield";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-focused-yield-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	// The subagent session opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Result each typed prompt asks for; the spawn task and any non-user turn yield `initial result`. */
const PROMPT_RESULTS: Record<string, string> = { "go on": "manual result", "finish up": "final result" };

/** The yield data for the newest typed (user-role) prompt the mock model sees. */
function resultForLatestPrompt(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
							.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
							.join("")
					: "";
		for (const prompt in PROMPT_RESULTS) {
			if (text.includes(prompt)) return PROMPT_RESULTS[prompt];
		}
	}
	return "initial result";
}

async function spawnKeptAliveChild(options: { handler?: MockHandler; structured?: boolean; enableIrc?: boolean } = {}) {
	const structured = options.structured !== false;
	// Under the isolated HOME: project discovery walks up from cwd and stops at os.homedir(). On Windows
	// os.tmpdir() lives under the real home, so a cwd outside the fake HOME would walk into the real
	// ~/.omp and load the developer's installed plugins as project plugins.
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler:
			options.handler ??
			(context => {
				if (!(context.tools ?? []).some(tool => tool.name === "yield")) {
					const emptyReport = context.messages.some(
						message => message.role === "user" && JSON.stringify(message.content).includes("empty report"),
					);
					if (!structured && emptyReport) {
						return { content: [] };
					}
					if (
						!structured &&
						context.messages.some(
							message => message.role === "user" && JSON.stringify(message.content).includes("failed report"),
						)
					) {
						return {
							content: ["partial failed report"],
							stopReason: "error",
							errorMessage: "report provider failed",
						};
					}
					return { content: [structured ? "label" : resultForLatestPrompt(context.messages)] };
				}
				// A turn that already yielded ends on the tool result; answer it with prose.
				if (context.messages.at(-1)?.role === "toolResult") return { content: ["ok"] };
				const data = resultForLatestPrompt(context.messages);
				return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data } }] };
			}),
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);

	const deliveries: string[] = [];
	const firstDelivery = Promise.withResolvers<string>();
	const secondDelivery = Promise.withResolvers<string>();
	const unregisterSink = manager.registerDeliverySink(PARENT_ID, (_jobId, text) => {
		deliveries.push(text);
		firstDelivery.resolve(text);
		if (deliveries.length === 2) secondDelivery.resolve(text);
	});
	const close = async (): Promise<void> => {
		unregisterSink();
		await AgentLifecycleManager.global().dispose();
		await authStorage.close();
	};
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report",
			index: 0,
			id: AGENT_ID,
			structured,
			outputSchema: structured ? { type: "string" } : undefined,
			parentAgentId: PARENT_ID,
			asyncJobManager: manager,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: options?.enableIrc ?? false,
		});
		expect(result.exitCode).toBe(0);
	} catch (error) {
		await close();
		throw error;
	}
	const artifact = path.join(artifactsDir, `${AGENT_ID}.md`);
	if (options.handler) expect(await Bun.file(artifact).text()).toContain("INITIAL_FINAL");
	else expect(await Bun.file(artifact).text()).toContain("initial result");
	const session = AgentRegistry.global().get(AGENT_ID)?.session;
	if (!session) {
		await close();
		throw new Error("kept-alive subagent has no live session");
	}
	return {
		session: localSession(session),
		artifact,
		deliveries,
		firstDelivery: firstDelivery.promise,
		secondDelivery: secondDelivery.promise,
		close,
		mock,
	};
}

it("a focused manual prompt's yield rewrites the artifact and notifies the parent", async () => {
	const child = await spawnKeptAliveChild();
	try {
		// The focused-session input path: a plain user prompt on the idle child.
		await child.session.prompt("go on");

		// The job settles only after finalization has rewritten the artifact.
		expect(await child.firstDelivery).toContain("manual result");
		expect(await Bun.file(child.artifact).text()).toContain("manual result");
	} finally {
		await child.close();
	}
}, 15_000);

it.each([true, false])(
	"overlapping focused turns retain their own result (structured=%s)",
	async structured => {
		const child = await spawnKeptAliveChild({ structured });
		const publicationStarted = Promise.withResolvers<void>();
		const releasePublication = Promise.withResolvers<void>();
		const newerWrites: Promise<number>[] = [];
		const realWrite = Bun.write.bind(Bun);
		const writeSpy = vi.spyOn(Bun, "write").mockImplementation(async (target, content, options) => {
			if (String(target).startsWith(`${child.artifact}.tmp-`) && typeof content === "string") {
				if (content.includes("manual result")) {
					publicationStarted.resolve();
					await releasePublication.promise;
					await Promise.all(newerWrites);
				} else if (content.includes("final result")) {
					const write = realWrite(target as string, content, options);
					newerWrites.push(write);
					return write;
				}
			}
			return (realWrite as (...args: unknown[]) => Promise<number>)(target, content, options);
		});
		try {
			// Owned background work keeps the first manual turn's observation open
			// after the turn itself returns, leaving the child idle for another prompt.
			const gate = Promise.withResolvers<void>();
			manager.register(
				"bash",
				"background build",
				async () => {
					await gate.promise;
					return "build done";
				},
				{ ownerId: AGENT_ID, agentId: AGENT_ID },
			);
			await child.session.prompt("go on");
			await child.session.prompt("finish up");
			await publicationStarted.promise;
			gate.resolve();
			await child.session.settleAsyncWork();
			releasePublication.resolve();

			await child.secondDelivery;
			// One completion per turn, each carrying only that turn's yield.
			const manual = child.deliveries.filter(text => text.includes("manual result"));
			const final = child.deliveries.filter(text => text.includes("final result"));
			expect(child.deliveries).toHaveLength(2);
			expect(manual).toHaveLength(1);
			expect(final).toHaveLength(1);
			expect(manual[0]).not.toContain("final result");
			expect(await Bun.file(child.artifact).text()).toContain("final result");
			if (structured) {
				const generation = artifactFileGeneration(await fs.stat(child.artifact, { bigint: true }));
				const sidecar = await Bun.file(child.artifact.replace(/\.md$/, ".json")).text();
				expect(parseStructuredArtifactSidecar(sidecar, generation)?.data).toBe("final result");
			}
		} finally {
			releasePublication.resolve();
			writeSpy.mockRestore();
			await child.close();
		}
	},
	15_000,
);

it("a focused plain result rewrites its artifact and notifies the parent", async () => {
	const child = await spawnKeptAliveChild({ structured: false });
	try {
		await child.session.prompt("go on");
		await child.firstDelivery;
		expect({
			artifact: (await Bun.file(child.artifact).text()).includes("manual result"),
			delivered: child.deliveries.filter(text => text.includes("manual result")).length,
		}).toEqual({ artifact: true, delivered: 1 });
	} finally {
		await child.close();
	}
}, 15_000);

it("delivers a durable focused plain result without reserving a full execution slot", async () => {
	const child = await spawnKeptAliveChild({ structured: false });
	const blocker = Promise.withResolvers<string>();
	const publicationStarted = Promise.withResolvers<void>();
	const releasePublication = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<{ text: string; artifact: string; hasSidecar: boolean }>();
	const sidecar = child.artifact.replace(/\.md$/, ".json");
	const generation = artifactFileGeneration(await fs.stat(child.artifact, { bigint: true }));
	await Bun.write(
		sidecar,
		serializeStructuredArtifactSidecar('{"report":"superseded structured result"}', generation),
	);
	const unregisterSink = manager.registerDeliverySink(PARENT_ID, async (_jobId, text) => {
		delivered.resolve({
			text,
			artifact: await Bun.file(child.artifact).text(),
			hasSidecar: await Bun.file(sidecar).exists(),
		});
	});
	const realWrite = Bun.write.bind(Bun);
	const writeSpy = vi.spyOn(Bun, "write").mockImplementation(async (target, content, options) => {
		if (
			String(target).startsWith(`${child.artifact}.tmp-`) &&
			typeof content === "string" &&
			content.includes("manual result")
		) {
			publicationStarted.resolve();
			await releasePublication.promise;
		}
		return (realWrite as (...args: unknown[]) => Promise<number>)(target, content, options);
	});
	try {
		for (let index = 0; index < 4; index++) {
			manager.register("bash", `busy-${index}`, () => blocker.promise, { ownerId: "Other" });
		}
		expect(manager.atCapacity).toBe(true);
		await child.session.prompt("go on");
		await publicationStarted.promise;
		expect(manager.getRunningJobs({ ownerId: PARENT_ID })).toEqual([]);
		expect(await Bun.file(child.artifact).text()).toContain("initial result");
		expect(parseStructuredArtifactSidecar(await Bun.file(sidecar).text(), generation)?.data).toEqual({
			report: "superseded structured result",
		});
		expect(manager.getAllJobs().filter(job => job.ownerId === PARENT_ID)).toEqual([]);
		releasePublication.resolve();
		const snapshot = await delivered.promise;
		expect(snapshot.text).toContain("manual result");
		expect(snapshot.artifact).toContain("manual result");
		expect(snapshot.hasSidecar).toBe(false);
		expect(manager.atCapacity).toBe(true);
		expect(manager.getRunningJobs({ ownerId: PARENT_ID })).toEqual([]);
	} finally {
		releasePublication.resolve();
		blocker.resolve("finished");
		await manager.waitForAll();
		unregisterSink();
		writeSpy.mockRestore();
		await child.close();
	}
}, 15_000);

it.each(["empty report", "failed report"])(
	"a focused %s preserves its prior authoritative artifact",
	async prompt => {
		const child = await spawnKeptAliveChild({ structured: false });
		try {
			await child.session.prompt("go on");
			await child.firstDelivery;
			await manager.waitForOwnerJobs(PARENT_ID);
			await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
			expect(await Bun.file(child.artifact).text()).toContain("manual result");
			const accepted = await Bun.file(child.artifact).text();
			const acceptedDeliveries = [...child.deliveries];
			await child.session.prompt(prompt);
			await manager.waitForOwnerJobs(PARENT_ID);
			await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
			expect(await Bun.file(child.artifact).text()).toBe(accepted);
			expect(child.deliveries).toEqual(acceptedDeliveries);
		} finally {
			await child.close();
		}
	},
	15_000,
);
it("publishes a consumed parent injection during a peer wake without publishing peer-only replies", async () => {
	const peerStarted = Promise.withResolvers<void>();
	const releasePeer = Promise.withResolvers<void>();
	let request = 0;
	const child = await spawnKeptAliveChild({
		structured: false,
		enableIrc: true,
		handler: async () => {
			request++;
			if (request === 1) return { content: ["INITIAL_FINAL"] };
			if (request === 2) return { content: ["POSITIVE_FINAL"] };
			if (request === 3) {
				peerStarted.resolve();
				await releasePeer.promise;
				return { content: ["PEER_INTERMEDIATE"] };
			}
			return {
				content: [request === 4 ? "NEGATIVE_FINAL" : request === 5 ? "PEER_ONLY_FINAL" : "BROADCAST_ONLY_FINAL"],
			};
		},
	});
	try {
		const bus = IrcBus.global();
		const positive = await bus.send({ from: PARENT_ID, to: AGENT_ID, body: "First follow-up" });
		expect(positive.outcome).toBe("woken");
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(await Bun.file(child.artifact).text()).toContain("POSITIVE_FINAL");
		expect(child.deliveries.filter(text => text.includes("POSITIVE_FINAL"))).toHaveLength(1);
		const peer = await bus.send({ from: "Peer", to: AGENT_ID, body: "Can you check?" });
		expect(peer.outcome).toBe("woken");
		await peerStarted.promise;
		const parent = await bus.send({ from: PARENT_ID, to: AGENT_ID, body: "Publish the follow-up" });
		expect(parent.outcome).toBe("injected");
		// Receiving the request is not consumption; the prior result is still authoritative.
		expect(await Bun.file(child.artifact).text()).toContain("POSITIVE_FINAL");
		expect(child.deliveries).toHaveLength(1);
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(1);
		releasePeer.resolve();
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(JSON.stringify(child.mock.calls.at(-1)?.context.messages)).toContain("Publish the follow-up");
		expect(await Bun.file(child.artifact).text()).toContain("NEGATIVE_FINAL");
		expect(child.deliveries.filter(text => text.includes("NEGATIVE_FINAL"))).toHaveLength(1);
		expect(
			manager.getAllJobs({ ownerId: PARENT_ID }).filter(job => job.resultText?.includes("NEGATIVE_FINAL")),
		).toHaveLength(1);
		const peerOnly = await bus.send({ from: "Peer", to: AGENT_ID, body: "One more check?" });
		expect(peerOnly.outcome).toBe("woken");
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		expect(await Bun.file(child.artifact).text()).toContain("NEGATIVE_FINAL");
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(child.deliveries.filter(text => text.includes("PEER_ONLY_FINAL"))).toHaveLength(0);
		expect(child.deliveries).toHaveLength(2);
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(2);
		await bus.send({ from: PARENT_ID, to: AGENT_ID, body: "Announcement, not a request", broadcast: true });
		await child.session.waitForIdle();
		await child.session.waitForIrcReplies();
		await manager.waitForOwnerJobs(PARENT_ID);
		await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
		expect(child.deliveries).toHaveLength(2);
		expect(manager.getAllJobs({ ownerId: PARENT_ID })).toHaveLength(2);
		expect(await Bun.file(child.artifact).text()).toContain("NEGATIVE_FINAL");
		expect(AgentRegistry.global().get(AGENT_ID)?.lifecycle?.acceptedAt).toBeUndefined();
	} finally {
		releasePeer.resolve();
		await child.close();
	}
}, 15_000);

it.each(["cancel", "replace"] as const)(
	"preserves the accepted report when an owner wake is %s during output preparation",
	async fault => {
		let request = 0;
		const child = await spawnKeptAliveChild({
			structured: false,
			enableIrc: true,
			handler: async () => ({ content: [++request === 1 ? "INITIAL_FINAL" : "CANDIDATE_NEW_REPORT"] }),
		});
		const sidecar = child.artifact.replace(/\.md$/, ".json");
		const generation = artifactFileGeneration(await fs.stat(child.artifact, { bigint: true }));
		await Bun.write(
			sidecar,
			serializeStructuredArtifactSidecar('{"report":"accepted structured source"}', generation),
		);
		const accepted = await Bun.file(child.artifact).text();
		const acceptedJson = await Bun.file(sidecar).text();
		const preparing = Promise.withResolvers<void>();
		const allowPublication = Promise.withResolvers<void>();
		const realWrite = Bun.write.bind(Bun);
		const writeSpy = vi.spyOn(Bun, "write").mockImplementation(async (target, content, options) => {
			if (String(target).startsWith(`${child.artifact}.tmp-`) && typeof content === "string") {
				preparing.resolve();
				await allowPublication.promise;
			}
			return (realWrite as (...args: unknown[]) => Promise<number>)(target, content, options);
		});
		try {
			await IrcBus.global().send({ from: PARENT_ID, to: AGENT_ID, body: "go on" });
			await preparing.promise;
			if (fault === "cancel") {
				const job = manager.getRunningJobs({ ownerId: PARENT_ID })[0];
				if (!job) throw new Error("Owner wake did not register its job");
				expect(manager.cancel(job.id, { ownerId: PARENT_ID })).toBe(true);
			} else {
				const current = AgentRegistry.global().get(AGENT_ID);
				if (!current) throw new Error("Owner wake lost its registry ref");
				AgentRegistry.global().register({
					id: AGENT_ID,
					displayName: AGENT_ID,
					kind: "sub",
					parentId: PARENT_ID,
					session: child.session,
					sessionFile: current.sessionFile,
					status: "idle",
				});
			}
			allowPublication.resolve();
			await child.session.waitForIrcReplies();
			await manager.waitForOwnerJobs(PARENT_ID);
			await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
			expect(await Bun.file(child.artifact).text()).toBe(accepted);
			expect(await Bun.file(sidecar).text()).toBe(acceptedJson);
			if (fault === "cancel") expect(child.deliveries).toEqual([]);
		} finally {
			allowPublication.resolve();
			writeSpy.mockRestore();
			await child.close();
		}
	},
	15_000,
);

async function createOwnerSession(gate?: { entered: () => void; release: Promise<void> }) {
	const cwd = path.join(root, "home", "owner-work");
	await fs.mkdir(cwd, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const handler: MockHandler = async context => {
		const hasYieldTool = (context.tools ?? []).some(tool => tool.name === "yield");
		if (gate && context.tools !== undefined && JSON.stringify(context.messages).includes("GATED_TASK")) {
			gate.entered();
			await gate.release;
		}
		return hasYieldTool && context.messages.at(-1)?.role !== "toolResult"
			? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "SAFE_TASK_REPORT" } }] }
			: { content: ["SAFE_TASK_REPORT"] };
	};
	const model = createMockModel({ id: "owner-model", handler });
	const other = createMockModel({ id: "other-model", handler });
	modelRegistry.registerProvider("mock", {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "test-key",
		models: [model, other],
	});
	registerCustomApi(
		model.api,
		(candidate, context, options) => {
			const original = [model, other].find(mock => mock.id === candidate.id);
			if (!original) throw new Error(`Unexpected synthetic model: ${candidate.id}`);
			return original.stream(candidate, context, options);
		},
		MOCK_API_SOURCE,
	);
	const settings = Settings.isolated({
		"async.enabled": true,
		"task.batch": true,
		"task.agentIdleTtlMs": 0,
		"task.maxConcurrency": 1,
		"memory.backend": "off",
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/owner-model", task: "mock/owner-model", smol: "mock/owner-model" },
	});
	const sessionManager = SessionManager.create(cwd, path.join(root, "source-sessions"));
	await sessionManager.ensureOnDisk();
	try {
		const owner = await sdk.createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			model,
			settings,
			sessionManager,
			toolNames: ["task"],
			spawns: "*",
			disableExtensionDiscovery: true,
			contextFiles: [],
			skills: [],
			rules: [],
			promptTemplates: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
		});
		return { owner, authStorage, modelRegistry, model, other, settings, cwd };
	} catch (error) {
		await sessionManager.close();
		await authStorage.close();
		throw error;
	}
}

it("uses the canonical safe name for async artifact writes and source namespaces", async () => {
	const fixture = await createOwnerSession();
	try {
		const task = fixture.owner.session.getToolByName("task");
		if (!task) throw new Error("Task tool is unavailable");
		const result = await task.execute("unsafe-async-name", {
			context: "Synthetic artifact boundary control.",
			tasks: [
				{ name: "../../Escaped:Pipe", task: "Return the synthetic report.", solutionSpace: "one fixed report" },
			],
		} as TaskParams);
		const details = result.details as TaskToolDetails;
		const jobs = fixture.owner.session.asyncJobManager;
		if (!jobs) throw new Error("Async manager is unavailable");
		await jobs.waitForAll();
		const job = jobs.getJob(details.async!.jobId);
		expect(job?.status, JSON.stringify(job)).toBe("completed");
		const artifacts = fixture.owner.session.sessionManager.getArtifactsDir();
		if (!artifacts) throw new Error("Root artifacts are unavailable");
		expect(details.progress?.[0]?.id).toBe("EscapedPipe");
		expect(jobs.getJob(details.async!.jobId)?.agentId).toBe("EscapedPipe");
		expect(await Bun.file(path.join(artifacts, "EscapedPipe.md")).text()).toContain("SAFE_TASK_REPORT");
		const source = await InternalUrlRouter.instance().resolve("agent://EscapedPipe", {
			sessionFile: fixture.owner.session.sessionManager.getSessionFile(),
		});
		expect(source.content).toContain("SAFE_TASK_REPORT");
		expect(await Bun.file(path.resolve(artifacts, "../../Escaped:Pipe.md")).exists()).toBe(false);
		expect(await Bun.file(path.resolve(artifacts, "../../Escaped:Pipe.jsonl")).exists()).toBe(false);
	} finally {
		await AgentLifecycleManager.global().dispose();
		await fixture.owner.session.dispose();
		await fixture.authStorage.close();
	}
}, 20_000);

it.each(["model", "root", "pool", "ref"] as const)(
	"keeps parked child lifetime across model changes but fences retired %s authority",
	async change => {
		const fixture = await createOwnerSession();
		let childSdk: sdk.CreateAgentSessionResult | undefined;
		const create = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await create(options);
			if (options?.agentId === "LifetimeChild") childSdk = created;
			return created;
		});
		try {
			const result = await runSubprocess({
				cwd: fixture.cwd,
				artifactsDir: fixture.owner.session.sessionManager.getArtifactsDir()!,
				agent: {
					name: "task",
					description: "synthetic",
					systemPrompt: "Return the report.",
					tools: ["read"],
					source: "bundled",
				},
				task: "Return the synthetic report.",
				index: 0,
				id: "LifetimeChild",
				parentAgentId: PARENT_ID,
				modelOverride: "mock/owner-model",
				authStorage: fixture.authStorage,
				modelRegistry: fixture.modelRegistry,
				settings: fixture.settings,
				asyncJobManager: fixture.owner.session.asyncJobManager,
				isOwnerCurrent: fixture.owner.captureOwnerCurrent(),
				isOwnerLifetimeCurrent: fixture.owner.captureOwnerLifetimeCurrent(),
				captureReviveOwnerCurrent: () => fixture.owner.captureOwnerCurrent({ allowParked: true }),
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
			});
			expect(result.exitCode, JSON.stringify(result)).toBe(0);
			if (!childSdk) throw new Error("Child SDK result is unavailable");
			const queue = childSdk.captureOwnerCurrent();
			const lifetime = childSdk.captureOwnerLifetimeCurrent();
			const registry = AgentRegistry.global();
			const ref = registry.get("LifetimeChild")!;
			await AgentLifecycleManager.global().park(ref.id);
			expect(ref.session).toBeNull();
			expect(queue()).toBe(false);
			expect(lifetime()).toBe(true);
			const accepted = await Bun.file(result.outputPath!).text();
			const ownerAdmission = fixture.owner.captureOwnerCurrent();
			if (change === "model") {
				await fixture.owner.session.setModel(fixture.other);
				expect(ownerAdmission()).toBe(false);
				expect(lifetime()).toBe(true);
				expect(childSdk.captureOwnerCurrent({ allowParked: true })()).toBe(true);
				const revived = await AgentLifecycleManager.global().ensureLive(ref.id);
				expect(registry.get(ref.id)).toBe(ref);
				expect(revived.model?.id).toBe("owner-model");
				await revived.prompt("Return the report with the original child model.");
				await revived.waitForIrcReplies();
				expect(revived.messages.findLast(message => message.role === "assistant")?.model).toBe("owner-model");
			} else {
				if (change === "root") await fixture.owner.session.dispose();
				else if (change === "pool")
					await fixture.authStorage.replaceStore(await SqliteAuthCredentialStore.open(":memory:"));
				else registry.register({ ...registry.get(PARENT_ID)!, session: fixture.owner.session });
				const requests = fixture.model.calls.length + fixture.other.calls.length;
				expect(lifetime()).toBe(false);
				await expect(AgentLifecycleManager.global().ensureLive(ref.id)).rejects.toBeInstanceOf(Error);
				expect(fixture.model.calls.length + fixture.other.calls.length).toBe(requests);
				expect(await Bun.file(result.outputPath!).text()).toBe(accepted);
			}
		} finally {
			await AgentLifecycleManager.global().dispose();
			await fixture.owner.session.dispose();
			await fixture.authStorage.close();
		}
	},
	20_000,
);

it("does not migrate a queued task into changed caller admission after its permit becomes available", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const fixture = await createOwnerSession({ entered: entered.resolve, release: release.promise });
	try {
		const task = fixture.owner.session.getToolByName("task");
		const jobs = fixture.owner.session.asyncJobManager;
		if (!task || !jobs) throw new Error("Task runtime is unavailable");
		const first = await task.execute("first-controlled-task", {
			context: "Synthetic queued admission control.",
			tasks: [
				{ name: "First", task: "GATED_TASK: return the synthetic report.", solutionSpace: "one fixed report" },
			],
		} as TaskParams);
		const firstJobId = (first.details as TaskToolDetails).async!.jobId;
		await Promise.race([
			entered.promise,
			jobs.waitForAll().then(() => {
				throw new Error(`Gated task settled before model entry: ${JSON.stringify(jobs.getJob(firstJobId))}`);
			}),
		]);
		const queued = await task.execute("second-controlled-task", {
			context: "Synthetic queued admission control.",
			tasks: [
				{ name: "Queued", task: "QUEUED_TASK: return the synthetic report.", solutionSpace: "one fixed report" },
			],
		} as TaskParams);
		const details = queued.details as TaskToolDetails;
		expect(jobs.getJob(details.async!.jobId)?.queued).toBe(true);
		await fixture.owner.session.setModel(fixture.other);
		release.resolve();
		await jobs.waitForAll();
		const firstJob = jobs.getJob(firstJobId);
		expect(firstJob?.status, JSON.stringify(firstJob)).toBe("completed");
		const queuedJob = jobs.getJob(details.async!.jobId);
		expect(queuedJob?.status).toBe("failed");
		expect(queuedJob?.errorText).toContain("owner was retired before dispatch");
		const artifacts = fixture.owner.session.sessionManager.getArtifactsDir()!;
		expect(await Bun.file(path.join(artifacts, "First.md")).text()).toContain("SAFE_TASK_REPORT");
		expect(await Bun.file(path.join(artifacts, "Queued.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(artifacts, "Queued.jsonl")).exists()).toBe(false);
		expect(
			[...fixture.model.calls, ...fixture.other.calls].some(call =>
				JSON.stringify(call.context.messages).includes("QUEUED_TASK"),
			),
		).toBe(false);
	} finally {
		release.resolve();
		await AgentLifecycleManager.global().dispose();
		await fixture.owner.session.dispose();
		await fixture.authStorage.close();
	}
}, 20_000);

for (const source of ["queued steering", "async completion"] as const) {
	it(`publishes a consumed parent injection during ${source}`, async () => {
		const continuationStarted = Promise.withResolvers<void>();
		const peerOnlySeen = Promise.withResolvers<void>();
		const releaseContinuation = Promise.withResolvers<void>();
		let request = 0;
		const child = await spawnKeptAliveChild({
			structured: false,
			enableIrc: true,
			handler: async () => {
				request++;
				if (request === 1) return { content: ["INITIAL_FINAL"] };
				if (request === 2) {
					continuationStarted.resolve();
					await releaseContinuation.promise;
					return { content: ["INTERMEDIATE_FINAL"] };
				}
				if (request === 4) peerOnlySeen.resolve();
				return { content: [request === 3 ? "PARENT_FRESH_FINAL" : "PEER_ONLY_FINAL"] };
			},
		});
		try {
			if (source === "queued steering") {
				await child.session.steer("Continue the task", undefined, { attribution: "agent" });
			} else {
				manager.register("bash", "child-owned work", async () => "work complete", {
					ownerId: AGENT_ID,
					agentId: AGENT_ID,
				});
			}
			await continuationStarted.promise;
			const parent = await IrcBus.global().send({ from: PARENT_ID, to: AGENT_ID, body: "Publish fresh result" });
			expect(parent.outcome).toBe("injected");
			expect(await Bun.file(child.artifact).text()).toContain("INITIAL_FINAL");
			releaseContinuation.resolve();
			await child.session.waitForIdle();
			await child.session.settleAsyncWork();
			await child.session.waitForIrcReplies();
			await manager.waitForOwnerJobs(PARENT_ID);
			await manager.drainDeliveries({ filter: { ownerId: PARENT_ID } });
			expect(JSON.stringify(child.mock.calls.at(-1)?.context.messages)).toContain("Publish fresh result");
			expect(await Bun.file(child.artifact).text()).toContain("PARENT_FRESH_FINAL");
			expect(child.deliveries.filter(text => text.includes("PARENT_FRESH_FINAL"))).toHaveLength(1);
			expect(
				manager.getAllJobs({ ownerId: PARENT_ID }).filter(job => job.resultText?.includes("PARENT_FRESH_FINAL")),
			).toHaveLength(1);
			if (source === "queued steering") {
				await child.session.steer("Continue without parent input", undefined, { attribution: "agent" });
				await peerOnlySeen.promise;
				await child.session.waitForIdle();
				await child.session.waitForIrcReplies();
				expect(await Bun.file(child.artifact).text()).toContain("PARENT_FRESH_FINAL");
				expect(child.deliveries).toHaveLength(1);
			}
		} finally {
			releaseContinuation.resolve();
			await child.close();
		}
	}, 15_000);
}
