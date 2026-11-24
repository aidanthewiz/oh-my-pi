/**
 * Interactive startup binds startup-safe extensions after the composer accepts
 * input (`deferredExtensionPaths`) and gates the first request on them. These
 * tests pin the two halves of that contract: which sources may defer, and that
 * a deferred source ends up as live as an eagerly loaded one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { bindPreparedExtensions, ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionAPI,
	PreparedExtension,
	RegisteredTool,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { RegisteredToolAdapter } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import {
	partitionStartupExtensions,
	recordStartupVerdicts,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/startup-deferral";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { type AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgToolsCommands, NATIVE_TODO_BACKEND } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const DEFERRED_TOOL_EXTENSION = (logPath: string) => `
	import * as fs from "node:fs";
	export default function(pi) {
		const { Type } = pi.typebox;
		pi.registerTool({
			name: "deferred_probe",
			label: "Deferred probe",
			description: "Registered by a startup-deferred extension.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
		pi.on("session_start", () => { fs.appendFileSync(${JSON.stringify(logPath)}, "deferred\\n"); });
	}
`;

function fixtureBoundary<T>(promise: Promise<T>, boundary: string): Promise<T> {
	return withTimeout(promise, 2_000, `Deferred extension fixture did not reach ${boundary}`);
}

describe("startup-deferred extensions", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-deferred-ext-");
		authStorage = createInMemoryAuthStorage();
	});

	afterEach(() => {
		AgentStorage.close();
		authStorage.close();
		tempDir.removeSync();
	});

	it("defers only sources whose recorded verdict matches their current file", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const toolOnly = path.join(tempDir.path(), "tool-only.ts");
		const withShortcut = path.join(tempDir.path(), "with-shortcut.ts");
		const neverLoaded = path.join(tempDir.path(), "never-loaded.ts");
		fs.writeFileSync(toolOnly, DEFERRED_TOOL_EXTENSION(path.join(tempDir.path(), "unused.log")));
		fs.writeFileSync(
			withShortcut,
			`export default function(pi) { pi.registerShortcut("ctrl+shift+y", { handler: () => {} }); }`,
		);
		// The first frame replays the transcript with message and reply renderers, and link schemes
		// reach the markdown renderer at UI init: each alone keeps an extension eager.
		const drawing = {
			"link-scheme.ts": `pi.registerLinkScheme("demo-link");`,
			"message-renderer.ts": `pi.registerMessageRenderer("demo-message", () => undefined);`,
			"text-renderer.ts": `pi.registerAssistantTextRenderer(() => undefined);`,
			"thinking-renderer.ts": `pi.registerAssistantThinkingRenderer(() => undefined);`,
		};
		// A resumed session's list goes to the selected todo backend as soon as the session starts.
		const todoBackend = path.join(tempDir.path(), "todo-backend.ts");
		fs.writeFileSync(
			todoBackend,
			`export default function(pi) { pi.registerTodoBackend({ id: "demo", replace() {} }); }`,
		);
		const drawingPaths = Object.entries(drawing).map(([name, body]) => {
			const file = path.join(tempDir.path(), name);
			fs.writeFileSync(file, `export default function(pi) { ${body} }`);
			return file;
		});
		fs.writeFileSync(neverLoaded, `export default function() {}`);

		const loaded = await loadExtensions([toolOnly, withShortcut, ...drawingPaths, todoBackend], tempDir.path());
		expect(loaded.errors).toEqual([]);
		await recordStartupVerdicts(storage, loaded.extensions);

		const paths = [toolOnly, withShortcut, ...drawingPaths, todoBackend, neverLoaded];
		expect(await partitionStartupExtensions(storage, paths, tempDir.path(), "native")).toEqual({
			eager: [withShortcut, ...drawingPaths, neverLoaded],
			deferred: [toolOnly, todoBackend],
		});
		expect(await partitionStartupExtensions(storage, paths, tempDir.path(), "demo")).toEqual({
			eager: [withShortcut, ...drawingPaths, todoBackend, neverLoaded],
			deferred: [toolOnly],
		});

		// An edited source may now register something startup needs: load it eagerly again.
		fs.appendFileSync(toolOnly, "\n// edited\n");
		expect(await partitionStartupExtensions(storage, paths, tempDir.path(), "native")).toEqual({
			eager: [toolOnly, withShortcut, ...drawingPaths, neverLoaded],
			deferred: [todoBackend],
		});
	});

	for (const presentation of ["top-level", "mounted"] as const) {
		it(`binds a deferred extension into the live session and replays session_start to it alone (${presentation})`, async () => {
			const logPath = path.join(tempDir.path(), "session-start.log");
			const eagerPath = path.join(tempDir.path(), "eager.ts");
			const deferredPath = path.join(tempDir.path(), "deferred.ts");
			fs.writeFileSync(
				eagerPath,
				`import * as fs from "node:fs";
			export default function(pi) {
				pi.on("session_start", () => { fs.appendFileSync(${JSON.stringify(logPath)}, "eager\\n"); });
			}`,
			);
			fs.writeFileSync(deferredPath, DEFERRED_TOOL_EXTENSION(logPath));

			const eventBus = new EventBus();
			const preloaded = await loadExtensions([eagerPath], tempDir.path(), eventBus);
			const settings = Settings.isolated();
			cfgToolsCommands.set(settings, presentation === "mounted");
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				settings,
				eventBus,
				preloadedExtensions: preloaded,
				deferredExtensionPaths: [deferredPath],
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: presentation === "mounted" ? ["read", "bash"] : ["read"],
			});

			try {
				const runner = session.extensionRunner;
				if (!runner) throw new Error("expected an extension runner");
				await runner.emit({ type: "session_start" });
				expect(session.getAllToolNames()).not.toContain("deferred_probe");

				await session.loadDeferredExtensions();

				expect(session.getAllToolNames()).toContain("deferred_probe");
				expect(session.getEnabledToolNames()).toContain("deferred_probe");
				expect(fs.readFileSync(logPath, "utf8")).toBe("eager\ndeferred\n");
				// Subagents and forks inherit the deferred source like an eager one.
				expect(session.extensionPaths).toContain(deferredPath);
				const tool = session.getToolByName("deferred_probe");
				if (!tool) throw new Error("expected deferred tool");
				expect(session.getAllToolInfos().find(entry => entry.name === tool.name)?.sourceInfo.path).toBe(
					deferredPath,
				);
				expect(session.getMountedToolCommandNames().includes(tool.name)).toBe(presentation === "mounted");
				if (presentation === "mounted") {
					expect(session.agent.state.tools.some(candidate => candidate.name === tool.name)).toBe(false);
				} else {
					expect(session.agent.state.tools.find(candidate => candidate.name === tool.name)).toBe(tool);
				}
				const mounted = session.getMountedToolCommandNames();
				await session.newSession();
				expect(session.getToolByName(tool.name)).toBe(tool);
				expect(session.getEnabledToolNames()).toContain(tool.name);
				expect(session.getMountedToolCommandNames()).toEqual(mounted);
				expect(await tool.execute("graduated", {})).toEqual({
					content: [{ type: "text", text: "ok" }],
					details: {},
				});
			} finally {
				await session.dispose();
			}
		});
	}

	it("keeps provider and both fallback factories eager and ignores corrupt cache entries", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const paths = ["provider", "write", "delete"].map(name => path.join(tempDir.path(), `${name}.ts`));
		fs.writeFileSync(paths[0], `export default pi => pi.registerProvider("probe", { apiKey: "synthetic" });`);
		fs.writeFileSync(paths[1], `export default pi => pi.registerFileWriteFallback(() => false);`);
		fs.writeFileSync(paths[2], `export default pi => pi.registerFileDeleteFallback(() => false);`);
		const loaded = await loadExtensions(paths, tempDir.path());
		expect(loaded.errors).toEqual([]);
		await recordStartupVerdicts(storage, loaded.extensions);
		expect(await partitionStartupExtensions(storage, paths, tempDir.path(), NATIVE_TODO_BACKEND)).toEqual({
			eager: paths,
			deferred: [],
		});
		storage.setCache(`extension_startup:v1:${paths[0]}`, "{broken", Math.floor(Date.now() / 1000) + 60);
		storage.setCache(
			`extension_startup:v1:${paths[1]}`,
			JSON.stringify({ fingerprint: "invalid", deferrable: true }),
			Math.floor(Date.now() / 1000) + 60,
		);
		expect(await partitionStartupExtensions(storage, paths, tempDir.path(), NATIVE_TODO_BACKEND)).toEqual({
			eager: paths,
			deferred: [],
		});
	});

	it("discards staged providers and rejects stale factory registrations without touching another owner's queue", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		let active = true;
		let api: ExtensionAPI | undefined;
		const prepared: PreparedExtension = {
			path: "<inline-stale>",
			resolvedPath: "<inline-stale>",
			error: null,
			factory: async pi => {
				api = pi;
				pi.registerProvider("staged", { apiKey: "synthetic" });
				started.resolve();
				await release.promise;
				pi.registerProvider("late", { apiKey: "synthetic" });
			},
		};
		const pending = bindPreparedExtensions([prepared], tempDir.path(), undefined, runtime, {
			isActive: () => active,
		});
		const rejected = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await fixtureBoundary(started.promise, "factory registration");
			expect(runtime.pendingProviderRegistrations).toEqual([]);
			active = false;
			runtime.registerProvider("replacement", { apiKey: "replacement-synthetic" }, "replacement-owner");
		} finally {
			release.resolve();
			await fixtureBoundary(
				pending.then(
					() => undefined,
					() => undefined,
				),
				"released factory settlement",
			);
		}
		expect(await rejected).toBeInstanceOf(Error);
		expect(runtime.pendingProviderRegistrations).toEqual([
			{ name: "replacement", config: { apiKey: "replacement-synthetic" }, sourceId: "replacement-owner" },
		]);
		if (!api) throw new Error("factory did not bind");
		expect(() => api!.registerFileWriteFallback(async () => true)).toThrow(Error);
		expect(() => api!.registerFileDeleteFallback(async () => true)).toThrow(Error);
		expect(() =>
			api!.registerTool({
				name: "late_tool",
				label: "Late",
				description: "Must not activate",
				parameters: api!.typebox.Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "late" }], details: {} }),
			}),
		).toThrow(Error);
	});

	for (const invalidation of ["disposal", "replacement"] as const) {
		it(`stops replay and late tool/provider registration after ${invalidation}`, async () => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const runtime = new ExtensionRuntime();
			const manager = SessionManager.inMemory();
			const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			const runner = new ExtensionRunner([], runtime, tempDir.path(), manager, registry);
			let secondHandlerRan = false;
			const prepared: PreparedExtension = {
				path: "<inline-replay>",
				resolvedPath: "<inline-replay>",
				error: null,
				factory: pi => {
					pi.on("session_start", async () => {
						started.resolve();
						await release.promise;
						pi.registerProvider("stale_replay", { apiKey: "synthetic" });
						pi.registerTool({
							name: "stale_replay_tool",
							label: "Stale replay",
							description: "Must not activate",
							parameters: pi.typebox.Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "stale" }], details: {} }),
						});
					});
					pi.on("session_start", () => {
						secondHandlerRan = true;
					});
				},
			};
			const loaded = await bindPreparedExtensions([prepared], tempDir.path(), undefined, runtime, {
				isActive: () => true,
			});
			expect(loaded.errors).toEqual([]);
			await runner.emit({ type: "session_start" });
			const pending = runner.addExtensions(loaded.extensions);
			const rejected = pending.then(
				() => undefined,
				(error: unknown) => error,
			);
			try {
				await fixtureBoundary(started.promise, "session_start replay");
				if (invalidation === "disposal") runner.disposeFileFallbacks();
				else await manager.newSession();
			} finally {
				release.resolve();
				try {
					await fixtureBoundary(
						pending.then(
							() => undefined,
							() => undefined,
						),
						"released replay settlement",
					);
				} finally {
					runner.disposeFileFallbacks();
					await manager.close();
				}
			}
			expect(await rejected).toBeInstanceOf(Error);
			expect(secondHandlerRan).toBe(false);
			expect(runtime.pendingProviderRegistrations).toEqual([]);
			expect(runner.getRegisteredTool("stale_replay_tool")).toBeUndefined();
		});
	}

	it("delivers session_start once when insertion overlaps its original broadcast", async () => {
		const broadcastStarted = Promise.withResolvers<void>();
		const releaseBroadcast = Promise.withResolvers<void>();
		const activationStarted = Promise.withResolvers<void>();
		const releaseActivation = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const manager = SessionManager.inMemory();
		let starts = 0;
		const eager = await bindPreparedExtensions(
			[
				{
					path: "<inline-eager-race>",
					resolvedPath: "<inline-eager-race>",
					error: null,
					factory: pi => {
						pi.on("session_start", async () => {
							broadcastStarted.resolve();
							await releaseBroadcast.promise;
						});
					},
				},
			],
			tempDir.path(),
			undefined,
			runtime,
		);
		const late = await bindPreparedExtensions(
			[
				{
					path: "<inline-late-race>",
					resolvedPath: "<inline-late-race>",
					error: null,
					factory: pi => {
						pi.registerTool({
							name: "broadcast_race",
							label: "Broadcast race",
							description: "Activation barrier",
							parameters: pi.typebox.Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "race" }], details: {} }),
						});
						pi.on("session_start", () => {
							starts += 1;
						});
					},
				},
			],
			tempDir.path(),
			undefined,
			runtime,
		);
		const runner = new ExtensionRunner(
			eager.extensions,
			runtime,
			tempDir.path(),
			manager,
			new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		);
		const unsubscribe = runner.onToolRegistered(async () => {
			activationStarted.resolve();
			await releaseActivation.promise;
		});
		const broadcast = runner.emit({ type: "session_start" });
		let insertion: Promise<void> | undefined;
		try {
			await fixtureBoundary(broadcastStarted.promise, "original session_start");
			insertion = runner.addExtensions(late.extensions);
			await fixtureBoundary(activationStarted.promise, "overlapping tool activation");
			releaseBroadcast.resolve();
			await broadcast;
			releaseActivation.resolve();
			await insertion;
			expect(starts).toBe(1);
		} finally {
			releaseBroadcast.resolve();
			releaseActivation.resolve();
			try {
				await fixtureBoundary(Promise.all([broadcast, insertion]), "overlapping broadcast teardown");
			} finally {
				unsubscribe();
				runner.disposeFileFallbacks();
				await manager.close();
			}
		}
	});

	it("delivers session_start to a late successor after a failed owner is removed during broadcast", async () => {
		const eagerStarted = Promise.withResolvers<void>();
		const releaseEager = Promise.withResolvers<void>();
		const registrationStarted = Promise.withResolvers<void>();
		const releaseRegistration = Promise.withResolvers<void>();
		const failedHandlerStarted = Promise.withResolvers<void>();
		const releaseFailedHandler = Promise.withResolvers<void>();
		let successorStarts = 0;
		const preloaded = await bindPreparedExtensions(
			[
				{
					path: "<broadcast-eager>",
					resolvedPath: "<broadcast-eager>",
					error: null,
					factory: pi => {
						pi.on("session_start", async () => {
							eagerStarted.resolve();
							await releaseEager.promise;
						});
					},
				},
			],
			tempDir.path(),
		);
		const late = await bindPreparedExtensions(
			[
				{
					path: "<broadcast-failed>",
					resolvedPath: "<broadcast-failed>",
					error: null,
					factory: pi => {
						pi.registerTool({
							name: "removed_start_tool",
							label: "Removed",
							description: "Failed broadcast owner",
							parameters: pi.typebox.Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "removed" }], details: {} }),
						});
						pi.on("session_start", async () => {
							failedHandlerStarted.resolve();
							await releaseFailedHandler.promise;
						});
					},
				},
				{
					path: "<broadcast-successor>",
					resolvedPath: "<broadcast-successor>",
					error: null,
					factory: pi => {
						pi.on("session_start", () => {
							successorStarts += 1;
						});
					},
				},
			],
			tempDir.path(),
			undefined,
			preloaded.runtime,
			{ isActive: () => true },
		);
		const settings = Settings.isolated();
		cfgToolsCommands.set(settings, false);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings,
			preloadedExtensions: preloaded,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});
		const runner = session.extensionRunner!;
		const failed = late.extensions[0]!;
		const successor = late.extensions[1]!;
		const unsubscribe = runner.onToolRegistered(tool => {
			if (tool.owner !== failed) return;
			registrationStarted.resolve();
			return releaseRegistration.promise.then(() => {
				throw new Error("synthetic broadcast owner failure");
			});
		});
		let broadcast: Promise<void> | undefined;
		let insertingFailed: Promise<void> | undefined;
		let insertingSuccessor: Promise<void> | undefined;
		try {
			broadcast = initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
			await fixtureBoundary(eagerStarted.promise, "original broadcast eager handler");
			insertingFailed = runner.addExtensions([failed]);
			const rejected = insertingFailed.then(
				() => undefined,
				(error: unknown) => error,
			);
			await fixtureBoundary(registrationStarted.promise, "failed broadcast owner registration");
			releaseEager.resolve();
			await fixtureBoundary(failedHandlerStarted.promise, "original broadcast entering failed owner");
			insertingSuccessor = runner.addExtensions([successor]);
			await fixtureBoundary(insertingSuccessor, "late successor insertion before broadcast completion");
			expect(successorStarts).toBe(0);
			releaseRegistration.resolve();
			expect(await fixtureBoundary(rejected, "failed owner removal during broadcast")).toBeInstanceOf(Error);
			releaseFailedHandler.resolve();
			await fixtureBoundary(broadcast, "original broadcast after failed owner removal");
			expect(successorStarts).toBe(1);
			expect(runner.isExtensionActive(failed.path)).toBe(false);
			expect(runner.isExtensionActive(successor.path)).toBe(true);
			expect(runner.getLoadedExtensions()).toContain(failed);
			expect(runner.getExtensionPaths()).not.toContain(failed.path);
			expect(runner.getRegisteredTool("removed_start_tool")).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("removed_start_tool");
		} finally {
			releaseEager.resolve();
			releaseRegistration.resolve();
			releaseFailedHandler.resolve();
			try {
				await fixtureBoundary(
					Promise.allSettled([broadcast, insertingFailed, insertingSuccessor]),
					"broadcast removal and late successor teardown",
				);
			} finally {
				unsubscribe();
				await session.dispose();
			}
		}
	});

	for (const [outcome, caseName] of [
		["failure", "restores the original tool when overlapping activation predecessors and replacements both fail"],
		["success", "preserves a successful overlapping successor after its predecessor activation fails"],
	] as const) {
		it(caseName, async () => {
			const preloaded = await bindPreparedExtensions(
				[
					{
						path: "<overlap-prior>",
						resolvedPath: "<overlap-prior>",
						error: null,
						factory: pi =>
							pi.registerTool({
								name: "overlap_tool",
								label: "Prior",
								description: "Pre-overlap implementation",
								parameters: pi.typebox.Type.Object({ prior: pi.typebox.Type.String() }),
								execute: async () => ({ content: [{ type: "text", text: "prior" }], details: {} }),
							}),
					},
				],
				tempDir.path(),
			);
			const added = await bindPreparedExtensions(
				["A", "B"].map(label => ({
					path: `<overlap-${label}>`,
					resolvedPath: `<overlap-${label}>`,
					error: null,
					factory: (pi: ExtensionAPI) =>
						pi.registerTool({
							name: "overlap_tool",
							label,
							description: `Overlapping owner ${label}`,
							parameters: pi.typebox.Type.Object({ [label]: pi.typebox.Type.String() }),
							execute: async () => ({ content: [{ type: "text", text: label }], details: {} }),
						}),
				})),
				tempDir.path(),
				undefined,
				preloaded.runtime,
				{ isActive: () => true },
			);
			const settings = Settings.isolated();
			cfgToolsCommands.set(settings, false);
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				settings,
				preloadedExtensions: preloaded,
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: ["read"],
			});
			const runner = session.extensionRunner!;
			const prior = session.getToolByName("overlap_tool")!;
			const priorInfo = session.getAllToolInfos().find(tool => tool.name === prior.name);
			const priorMounted = session.getMountedToolCommandNames();
			const ownerA = added.extensions[0]!;
			const ownerB = added.extensions[1]!;
			const startedA = Promise.withResolvers<void>();
			const startedB = Promise.withResolvers<void>();
			const releaseA = Promise.withResolvers<void>();
			const releaseB = Promise.withResolvers<void>();
			const unsubscribe = runner.onToolRegistered(tool => {
				if (tool.owner === ownerA) {
					startedA.resolve();
					return releaseA.promise.then(() => {
						throw new Error("synthetic predecessor activation failure");
					});
				}
				if (tool.owner === ownerB) {
					startedB.resolve();
					return releaseB.promise.then(() => {
						if (outcome === "failure") throw new Error("synthetic replacement activation failure");
					});
				}
			});
			let pendingA: Promise<void> | undefined;
			let pendingB: Promise<void> | undefined;
			try {
				await initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
				pendingA = runner.addExtensions([ownerA]);
				const rejectedA = pendingA.then(
					() => undefined,
					(error: unknown) => error,
				);
				await fixtureBoundary(startedA.promise, "overlapping predecessor subscriber");
				const toolA = await fixtureBoundary(
					session.runToolRegistryMutation(async () => session.getToolByName("overlap_tool")),
					"overlapping predecessor publication",
				);
				if (!toolA) throw new Error("expected overlapping predecessor");
				expect(await toolA.execute("pending-overlap-A", { A: "value" })).toEqual({
					content: [{ type: "text", text: "A" }],
					details: {},
				});
				pendingB = runner.addExtensions([ownerB]);
				const settledB = pendingB.then(
					() => undefined,
					(error: unknown) => error,
				);
				await fixtureBoundary(startedB.promise, "overlapping replacement subscriber");
				const toolB = await fixtureBoundary(
					session.runToolRegistryMutation(async () => session.getToolByName("overlap_tool")),
					"overlapping replacement publication",
				);
				if (!toolB) throw new Error("expected overlapping replacement");
				const infoB = session.getAllToolInfos().find(tool => tool.name === toolB.name);
				expect(toolB).not.toBe(toolA);
				releaseA.resolve();
				expect(await fixtureBoundary(rejectedA, "displaced predecessor activation failure")).toBeInstanceOf(Error);
				expect(session.getToolByName("overlap_tool")).toBe(toolB);
				expect(await toolB.execute("pending-overlap-B", { B: "value" })).toEqual({
					content: [{ type: "text", text: "B" }],
					details: {},
				});
				releaseB.resolve();
				const resultB = await fixtureBoundary(settledB, "overlapping replacement settlement");
				if (outcome === "failure") {
					expect(resultB).toBeInstanceOf(Error);
					expect(session.getToolByName("overlap_tool")).toBe(prior);
					expect(session.agent.state.tools.find(tool => tool.name === prior.name)).toBe(prior);
					expect(session.getAllToolInfos().find(tool => tool.name === prior.name)).toEqual(priorInfo);
					expect(await prior.execute("restored-overlap-prior", { prior: "value" })).toEqual({
						content: [{ type: "text", text: "prior" }],
						details: {},
					});
					await expect(toolB.execute("failed-overlap-B", { B: "value" })).rejects.toThrow(
						"Extension owner is no longer active",
					);
				} else {
					expect(resultB).toBeUndefined();
					await session.newSession();
					expect(session.getToolByName("overlap_tool")).toBe(toolB);
					expect(session.agent.state.tools.find(tool => tool.name === toolB.name)).toBe(toolB);
					expect(session.getAllToolInfos().find(tool => tool.name === toolB.name)).toEqual(infoB);
					expect(await toolB.execute("graduated-overlap-B", { B: "value" })).toEqual({
						content: [{ type: "text", text: "B" }],
						details: {},
					});
				}
				expect(session.getEnabledToolNames()).toContain(prior.name);
				expect(session.getMountedToolCommandNames()).toEqual(priorMounted);
				await expect(toolA.execute("failed-overlap-A", { A: "value" })).rejects.toThrow(
					"Extension owner is no longer active",
				);
			} finally {
				releaseA.resolve();
				releaseB.resolve();
				try {
					await fixtureBoundary(Promise.allSettled([pendingA, pendingB]), "overlapping owner teardown");
				} finally {
					unsubscribe();
					await session.dispose();
				}
			}
		});
	}

	for (const [retiredResult, caseName] of [
		["none", "retains a surviving tool_call denial when an earlier activation retires during dispatch"],
		["block", "discards a retired tool_call result before applying the surviving owner's denial"],
	] as const) {
		it(caseName, async () => {
			const registrationStarted = Promise.withResolvers<void>();
			const releaseRegistration = Promise.withResolvers<void>();
			const handlerStarted = Promise.withResolvers<void>();
			const releaseHandler = Promise.withResolvers<void>();
			const survivingReason = "synthetic surviving-owner policy";
			let survivingCalls = 0;
			let executions = 0;
			const preloaded = await bindPreparedExtensions(
				[
					{
						path: "<dispatch-prior>",
						resolvedPath: "<dispatch-prior>",
						error: null,
						factory: pi =>
							pi.registerTool({
								name: "dispatch_survivor",
								label: "Survivor",
								description: "Unaffected eager implementation",
								parameters: pi.typebox.Type.Object({}),
								execute: async () => {
									executions += 1;
									return { content: [{ type: "text", text: "executed" }], details: {} };
								},
							}),
					},
				],
				tempDir.path(),
			);
			const added = await bindPreparedExtensions(
				[
					{
						path: "<dispatch-retiring>",
						resolvedPath: "<dispatch-retiring>",
						error: null,
						factory: pi => {
							pi.registerTool({
								name: "retiring_dispatch_owner",
								label: "Retiring",
								description: "Pending activation owner",
								parameters: pi.typebox.Type.Object({}),
								execute: async () => ({ content: [{ type: "text", text: "retiring" }], details: {} }),
							});
							pi.on("tool_call", async event => {
								if (event.toolName !== "dispatch_survivor") return;
								handlerStarted.resolve();
								await releaseHandler.promise;
								if (retiredResult === "block")
									return {
										block: true,
										reason: "synthetic retired-owner policy",
									};
							});
						},
					},
					{
						path: "<dispatch-surviving-policy>",
						resolvedPath: "<dispatch-surviving-policy>",
						error: null,
						factory: pi => {
							pi.on("tool_call", event => {
								if (event.toolName !== "dispatch_survivor") return;
								survivingCalls += 1;
								return { block: true, reason: survivingReason };
							});
						},
					},
				],
				tempDir.path(),
				undefined,
				preloaded.runtime,
				{ isActive: () => true },
			);
			const settings = Settings.isolated();
			cfgToolsCommands.set(settings, false);
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				settings,
				preloadedExtensions: preloaded,
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: ["read"],
			});
			const runner = session.extensionRunner!;
			const prior = session.getToolByName("dispatch_survivor")!;
			const priorInfo = session.getAllToolInfos().find(tool => tool.name === prior.name);
			const retiring = added.extensions[0]!;
			const surviving = added.extensions[1]!;
			const unsubscribe = runner.onToolRegistered(tool => {
				if (tool.owner !== retiring) return;
				registrationStarted.resolve();
				return releaseRegistration.promise.then(() => {
					throw new Error("synthetic dispatch activation failure");
				});
			});
			let pendingA: Promise<void> | undefined;
			let pendingB: Promise<void> | undefined;
			let execution: Promise<unknown> | undefined;
			try {
				await initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
				pendingA = runner.addExtensions([retiring]);
				const rejectedA = pendingA.then(
					() => undefined,
					(error: unknown) => error,
				);
				await fixtureBoundary(registrationStarted.promise, "pending tool-call owner activation");
				pendingB = runner.addExtensions([surviving]);
				await fixtureBoundary(pendingB, "surviving tool-call policy activation");
				execution = prior.execute("retirement-dispatch", {}).then(
					result => result,
					(error: unknown) => error,
				);
				await fixtureBoundary(handlerStarted.promise, "tool-call dispatch awaiting the retiring owner");
				releaseRegistration.resolve();
				expect(await fixtureBoundary(rejectedA, "tool-call owner retirement")).toBeInstanceOf(Error);
				expect(runner.isExtensionActive(retiring.path)).toBe(false);
				expect(runner.isExtensionActive(surviving.path)).toBe(true);
				releaseHandler.resolve();
				const outcome = await fixtureBoundary(execution, "tool-call dispatch after owner retirement");
				expect(survivingCalls).toBe(1);
				expect(executions).toBe(0);
				expect(outcome).toBeInstanceOf(Error);
				if (outcome instanceof Error) expect(outcome.message).toBe(survivingReason);
				expect(session.getToolByName(prior.name)).toBe(prior);
				expect(session.agent.state.tools.find(tool => tool.name === prior.name)).toBe(prior);
				expect(session.getAllToolInfos().find(tool => tool.name === prior.name)).toEqual(priorInfo);
				expect(session.getEnabledToolNames()).toContain(prior.name);
				expect(session.getMountedToolCommandNames()).not.toContain(prior.name);
				expect(session.getAllToolNames()).not.toContain("retiring_dispatch_owner");
			} finally {
				releaseRegistration.resolve();
				releaseHandler.resolve();
				try {
					await fixtureBoundary(
						Promise.allSettled([pendingA, pendingB, execution]),
						"tool-call retirement teardown",
					);
				} finally {
					unsubscribe();
					await session.dispose();
				}
			}
		});
	}

	it("rejects readiness when an asynchronous subscriber's nested registration fails", async () => {
		const runtime = new ExtensionRuntime();
		const manager = SessionManager.inMemory();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const nestedStarted = Promise.withResolvers<void>();
		const releaseNested = Promise.withResolvers<void>();
		let api: ExtensionAPI | undefined;
		let replayed = false;
		const loaded = await bindPreparedExtensions(
			[
				{
					path: "<nested-registration>",
					resolvedPath: "<nested-registration>",
					error: null,
					factory: pi => {
						api = pi;
						pi.registerTool({
							name: "nested_first",
							label: "First",
							description: "Nested registration readiness",
							parameters: pi.typebox.Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "nested" }], details: {} }),
						});
						pi.on("session_start", () => {
							replayed = true;
						});
					},
				},
			],
			tempDir.path(),
			undefined,
			runtime,
			{ isActive: () => true },
		);
		const runner = new ExtensionRunner(
			[],
			runtime,
			tempDir.path(),
			manager,
			new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		);
		await runner.emit({ type: "session_start" });
		const subscribers: Promise<void>[] = [];
		const unsubscribe = runner.onToolRegistered(tool => {
			const subscriber = (async () => {
				if (tool.definition.name === "nested_first") {
					started.resolve();
					await release.promise;
					api!.registerTool({ ...tool.definition, name: "nested_second" });
				} else {
					nestedStarted.resolve();
					await releaseNested.promise;
					throw new Error("synthetic nested subscriber failure");
				}
			})();
			subscribers.push(subscriber);
			return subscriber;
		});
		const pending = runner.addExtensions(loaded.extensions);
		const rejection = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			await fixtureBoundary(started.promise, "asynchronous first registration subscriber");
			release.resolve();
			await fixtureBoundary(nestedStarted.promise, "nested registration subscriber");
			releaseNested.resolve();
			expect(await fixtureBoundary(rejection, "nested registration readiness rejection")).toMatchObject({
				message: expect.stringContaining("synthetic nested subscriber failure"),
			});
			expect(replayed).toBe(false);
			const retained = new RegisteredToolAdapter(loaded.extensions[0]!.tools.get("nested_second")!, runner);
			await expect(retained.execute("nested-retained", {})).rejects.toThrow("Extension owner is no longer active");
		} finally {
			release.resolve();
			releaseNested.resolve();
			try {
				await fixtureBoundary(
					Promise.all([
						pending.then(
							() => undefined,
							() => undefined,
						),
						Promise.allSettled(subscribers),
					]),
					"nested subscriber and activation teardown",
				);
			} finally {
				unsubscribe();
				runner.disposeFileFallbacks();
				await manager.close();
			}
		}
	});

	it("invalidates an activation whose subscriber ignores its expired registration signal", async () => {
		const preloaded = await bindPreparedExtensions(
			[
				{
					path: "<expiry-prior>",
					resolvedPath: "<expiry-prior>",
					error: null,
					factory: pi =>
						pi.registerTool({
							name: "expired_probe",
							label: "Prior",
							description: "prior expiry description",
							parameters: pi.typebox.Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "prior" }], details: {} }),
						}),
				},
			],
			tempDir.path(),
		);
		const settings = Settings.isolated();
		cfgToolsCommands.set(settings, false);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings,
			preloadedExtensions: preloaded,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});
		const runner = session.extensionRunner!;
		const prior = session.getToolByName("expired_probe")!;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const deadline = new AbortController();
		let replayed = false;
		let executed = false;
		let api: ExtensionAPI | undefined;
		let subscriber: Promise<void> | undefined;
		let pending: Promise<void> | undefined;
		let unsubscribe: (() => void) | undefined;
		let timeout: { mockRestore(): void } | undefined;
		try {
			const loaded = await bindPreparedExtensions(
				[
					{
						path: "<expired-registration>",
						resolvedPath: "<expired-registration>",
						error: null,
						factory: pi => {
							api = pi;
							for (const name of ["expired_probe", "expired_sibling"])
								pi.registerTool({
									name,
									label: name,
									description: "stale expiry description",
									parameters: pi.typebox.Type.Object({}),
									execute: async () => {
										executed = true;
										return { content: [{ type: "text", text: "expired" }], details: {} };
									},
								});
							pi.on("session_start", () => {
								replayed = true;
							});
						},
					},
				],
				tempDir.path(),
				undefined,
				preloaded.runtime,
				{ isActive: () => true },
			);
			await runner.emit({ type: "session_start" });
			unsubscribe = runner.onToolRegistered(tool => {
				if (tool.definition.name !== "expired_sibling") return;
				subscriber = (async () => {
					started.resolve();
					await release.promise;
					api!.registerTool({
						...tool.definition,
						name: "expired_probe",
						description: "late stale expiry description",
					});
				})();
				return subscriber;
			});
			timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
			pending = runner.addExtensions(loaded.extensions);
			timeout.mockRestore();
			const rejection = pending.then(
				() => undefined,
				(error: unknown) => error,
			);
			await fixtureBoundary(started.promise, "subscriber waiting at the registration deadline");
			const retained = await session.runToolRegistryMutation(async () => session.getToolByName("expired_probe"));
			if (!retained) throw new Error("expected published expiry candidate");
			expect(retained).not.toBe(prior);
			expect(session.getEnabledToolNames()).toContain("expired_sibling");
			let synchronousLateError: unknown;
			deadline.signal.addEventListener(
				"abort",
				() => {
					try {
						api!.registerTool({
							...loaded.extensions[0]!.tools.get("expired_sibling")!.definition,
							name: "expired_at_abort",
						});
					} catch (error) {
						synchronousLateError = error;
					}
				},
				{ once: true },
			);
			deadline.abort(new DOMException("Registration deadline expired", "TimeoutError"));
			expect(synchronousLateError).toBeInstanceOf(Error);
			expect(
				await fixtureBoundary(rejection, "expired activation rejection before subscriber release"),
			).toBeInstanceOf(Error);
			expect(replayed).toBe(false);
			expect(session.getToolByName("expired_probe")).toBe(prior);
			expect(session.getAllToolNames()).not.toContain("expired_sibling");
			expect(session.getAllToolNames()).not.toContain("expired_at_abort");
			await expect(retained!.execute("expired", {})).rejects.toThrow("Extension owner is no longer active");
			expect(executed).toBe(false);
			const successor = await bindPreparedExtensions(
				[
					{
						path: "<expiry-successor>",
						resolvedPath: "<expiry-successor>",
						error: null,
						factory: pi =>
							pi.registerTool({
								name: "expired_probe",
								label: "Successor",
								description: "successor expiry description",
								parameters: pi.typebox.Type.Object({}),
								execute: async () => ({ content: [{ type: "text", text: "successor" }], details: {} }),
							}),
					},
				],
				tempDir.path(),
				undefined,
				preloaded.runtime,
			);
			await runner.addExtensions(successor.extensions);
			const current = session.getToolByName("expired_probe")!;
			const lateRejection = subscriber!.then(
				() => undefined,
				(error: unknown) => error,
			);
			release.resolve();
			expect(await fixtureBoundary(lateRejection, "late subscriber refusal")).toBeInstanceOf(Error);
			expect(session.getToolByName("expired_probe")).toBe(current);
			expect(session.agent.state.tools.find(tool => tool.name === current.name)).toBe(current);
			expect(await current.execute("expiry-successor", {})).toEqual({
				content: [{ type: "text", text: "successor" }],
				details: {},
			});
		} finally {
			timeout?.mockRestore();
			release.resolve();
			deadline.abort();
			try {
				await fixtureBoundary(
					Promise.all([
						pending?.then(
							() => undefined,
							() => undefined,
						),
						subscriber?.then(
							() => undefined,
							() => undefined,
						),
					]),
					"expired subscriber and activation teardown",
				);
			} finally {
				unsubscribe?.();
				await session.dispose();
			}
		}
	});

	for (const invalidation of ["abort", "new-session", "account-replacement"] as const) {
		it(`refuses queued deferred publication after ${invalidation} and preserves prior and successor tools`, async () => {
			const deferredPath = path.join(tempDir.path(), "queued.ts");
			const definition = (name: string, text: string) => `{
				name: ${JSON.stringify(name)}, label: "Queue probe",
				description: ${JSON.stringify(text)}, parameters: pi.typebox.Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(text)} }], details: {} })
			}`;
			fs.writeFileSync(
				deferredPath,
				`export default pi => {
				pi.registerTool(${definition("queued_shared", "stale queued description")});
				pi.registerTool(${definition("queued_stale_only", "stale queued only")});
			}`,
			);
			const preloaded = await bindPreparedExtensions(
				[
					{
						path: "<queued-prior>",
						resolvedPath: "<queued-prior>",
						error: null,
						factory: pi =>
							pi.registerTool({
								name: "queued_shared",
								label: "Prior",
								description: "prior queued description",
								parameters: pi.typebox.Type.Object({}),
								execute: async () => ({ content: [{ type: "text", text: "prior" }], details: {} }),
							}),
					},
				],
				tempDir.path(),
			);
			const settings = Settings.isolated();
			cfgToolsCommands.set(settings, false);
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				settings,
				preloadedExtensions: preloaded,
				deferredExtensionPaths: [deferredPath],
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: ["read"],
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const scheduled = Promise.withResolvers<void>();
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const unsubscribe = runner.onToolRegistered(tool => {
				if (tool.definition.name === "queued_stale_only") scheduled.resolve();
			});
			const prior = session.getToolByName("queued_shared");
			const blocked = session.runToolRegistryMutation(async () => {
				entered.resolve();
				await release.promise;
			});
			let transition: Promise<unknown> | undefined;
			let loading: Promise<void> | undefined;
			try {
				if (!prior) throw new Error("expected prior tool");
				await fixtureBoundary(entered.promise, "held registry queue");
				loading = session.loadDeferredExtensions();
				const rejected = loading.then(
					() => undefined,
					(error: unknown) => error,
				);
				await fixtureBoundary(scheduled.promise, "queued stale registration");
				if (invalidation === "new-session") {
					transition = session.newSession();
					expect(session.isSessionTransitioning).toBe(true);
				} else if (invalidation === "abort") {
					await session.abort();
				} else {
					await authStorage.replaceStore(new SqliteAuthCredentialStore(new Database(":memory:")), {
						sourceIdentity: "synthetic-replacement",
					});
				}
				release.resolve();
				await blocked;
				expect(await rejected).toBeInstanceOf(Error);
				await transition;
				const successor = await bindPreparedExtensions(
					[
						{
							path: "<queued-successor>",
							resolvedPath: "<queued-successor>",
							error: null,
							factory: pi =>
								pi.registerTool({
									name: "queued_successor",
									label: "Successor",
									description: "successor queued description",
									parameters: pi.typebox.Type.Object({}),
									execute: async () => ({ content: [{ type: "text", text: "successor" }], details: {} }),
								}),
						},
					],
					tempDir.path(),
					undefined,
					preloaded.runtime,
				);
				await runner.addExtensions(successor.extensions);
				expect(session.getAllToolNames()).not.toContain("queued_stale_only");
				expect(session.getEnabledToolNames()).not.toContain("queued_stale_only");
				expect(session.agent.state.tools.find(tool => tool.name === "queued_shared")).toBe(prior);
				expect(await prior.execute("prior", {})).toEqual({
					content: [{ type: "text", text: "prior" }],
					details: {},
				});
				const published = session.agent.state.tools.find(tool => tool.name === "queued_successor");
				if (!published) throw new Error("expected successor tool");
				expect(await published.execute("successor", {})).toEqual({
					content: [{ type: "text", text: "successor" }],
					details: {},
				});
			} finally {
				release.resolve();
				try {
					await blocked;
					if (loading)
						await fixtureBoundary(
							loading.then(
								() => undefined,
								() => undefined,
							),
							"queued activation teardown",
						);
					await transition;
				} finally {
					unsubscribe();
					await session.dispose();
				}
			}
		});
	}

	for (const [invalidation, presentation] of [
		["abort", "top-level"],
		["new-session", "top-level"],
		["account-replacement", "top-level"],
		["sibling-failure", "top-level"],
		["abort", "mounted"],
	] as const) {
		it(`rolls back an already-published ${presentation} sibling after ${invalidation}`, async () => {
			const deferredPaths = ["partial_shared", "partial_second"].map(name => {
				const deferredPath = path.join(tempDir.path(), `${name}.ts`);
				fs.writeFileSync(
					deferredPath,
					`export default pi => pi.registerTool({
						name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)},
						description: ${JSON.stringify(`stale partial ${name}`)},
						parameters: pi.typebox.Type.Object({ stale: pi.typebox.Type.String() }),
						execute: async () => ({ content: [{ type: "text", text: "stale" }], details: {} })
					});`,
				);
				return deferredPath;
			});
			const preloaded = await bindPreparedExtensions(
				[
					{
						path: "<partial-prior>",
						resolvedPath: "<partial-prior>",
						error: null,
						factory: pi =>
							pi.registerTool({
								name: "partial_shared",
								label: "Prior",
								description: "prior partial description",
								parameters: pi.typebox.Type.Object({ prior: pi.typebox.Type.String() }),
								execute: async () => ({ content: [{ type: "text", text: "prior" }], details: {} }),
							}),
					},
				],
				tempDir.path(),
			);
			const settings = Settings.isolated();
			cfgToolsCommands.set(settings, presentation === "mounted");
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				settings,
				preloadedExtensions: preloaded,
				deferredExtensionPaths: deferredPaths,
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: presentation === "mounted" ? ["read", "bash"] : ["read"],
			});
			const runner = session.extensionRunner!;
			const prior = session.getToolByName("partial_shared")!;
			const priorInfo = session.getAllToolInfos().find(tool => tool.name === prior.name);
			const priorMounted = session.getMountedToolCommandNames();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const scheduled = Promise.withResolvers<void>();
			let blocked: Promise<void> | undefined;
			const unsubscribe = runner.onToolRegistered(tool => {
				if (tool.definition.name === "partial_shared") {
					blocked = session.runToolRegistryMutation(async () => {
						entered.resolve();
						await release.promise;
					});
				}
				if (tool.definition.name === "partial_second") {
					scheduled.resolve();
					if (invalidation === "sibling-failure") {
						return release.promise.then(() => {
							throw new Error("synthetic sibling failure");
						});
					}
				}
			});
			let transition: Promise<unknown> | undefined;
			let loading: Promise<void> | undefined;
			try {
				loading = session.loadDeferredExtensions();
				const rejected = loading.then(
					() => undefined,
					(error: unknown) => error,
				);
				await fixtureBoundary(entered.promise, "published first sibling and held second sibling");
				await fixtureBoundary(scheduled.promise, "second sibling queued behind the first publication");
				const stale = session.getToolByName("partial_shared")!;
				expect(stale).not.toBe(prior);
				expect(session.getToolByName("partial_second")).toBeUndefined();
				if (presentation === "mounted") {
					expect(session.getMountedToolCommandNames()).toContain(stale.name);
					expect(session.agent.state.tools.some(tool => tool.name === stale.name)).toBe(false);
				} else {
					expect(session.agent.state.tools.find(tool => tool.name === stale.name)).toBe(stale);
				}
				expect(session.getEnabledToolNames()).toContain(stale.name);
				if (invalidation === "new-session") {
					transition = session.newSession();
				} else if (invalidation === "abort") {
					await session.abort();
				} else if (invalidation === "account-replacement") {
					await authStorage.replaceStore(new SqliteAuthCredentialStore(new Database(":memory:")), {
						sourceIdentity: "synthetic-partial-replacement",
					});
				}
				release.resolve();
				await blocked;
				expect(await rejected).toBeInstanceOf(Error);
				await transition;
				expect(session.getToolByName("partial_shared")).toBe(prior);
				if (presentation === "top-level") {
					expect(session.agent.state.tools.find(tool => tool.name === prior.name)).toBe(prior);
				}
				expect(session.getAllToolInfos().find(tool => tool.name === prior.name)).toEqual(priorInfo);
				expect(session.getEnabledToolNames()).toContain(prior.name);
				expect(session.getMountedToolCommandNames()).toEqual(priorMounted);
				expect(session.getAllToolNames()).not.toContain("partial_second");
				expect(session.getEnabledToolNames()).not.toContain("partial_second");
				await expect(stale.execute("retained-partial", { stale: "value" })).rejects.toThrow(
					"Extension owner is no longer active",
				);
				expect(await prior.execute("restored-partial", { prior: "value" })).toEqual({
					content: [{ type: "text", text: "prior" }],
					details: {},
				});
			} finally {
				release.resolve();
				try {
					await blocked;
					if (loading)
						await fixtureBoundary(
							loading.then(
								() => undefined,
								() => undefined,
							),
							"partial activation teardown",
						);
					await transition;
				} finally {
					unsubscribe();
					await session.dispose();
				}
			}
		});
	}

	it("restores the pre-activation tool after reentrant same-owner replacement and sibling failure", async () => {
		const eventBus = new EventBus();
		const deferredPath = path.join(tempDir.path(), "reentrant-undo-chain.ts");
		fs.writeFileSync(
			deferredPath,
			`export default pi => {
			pi.registerTool({
				name: "undo_chain", label: "First candidate", description: "First candidate",
				parameters: pi.typebox.Type.Object({ first: pi.typebox.Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "first" }], details: {} })
			});
			pi.events.on("replace-undo-chain", () => {
				pi.registerTool({
					name: "undo_chain", label: "Replacement candidate", description: "Replacement candidate",
					parameters: pi.typebox.Type.Object({ replacement: pi.typebox.Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "replacement" }], details: {} })
				});
				pi.events.emit("undo-chain-replaced", undefined);
			});
			pi.registerTool({
				name: "undo_chain_sibling", label: "Sibling", description: "Failing sibling",
				parameters: pi.typebox.Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "sibling" }], details: {} })
			});
		}`,
		);
		const preloaded = await bindPreparedExtensions(
			[
				{
					path: "<undo-chain-prior>",
					resolvedPath: "<undo-chain-prior>",
					error: null,
					factory: pi =>
						pi.registerTool({
							name: "undo_chain",
							label: "Prior",
							description: "Pre-activation implementation",
							parameters: pi.typebox.Type.Object({ prior: pi.typebox.Type.String() }),
							execute: async () => ({ content: [{ type: "text", text: "prior" }], details: {} }),
						}),
				},
			],
			tempDir.path(),
			eventBus,
		);
		const settings = Settings.isolated();
		cfgToolsCommands.set(settings, false);
		let replaceOnRender = false;
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings,
			eventBus,
			preloadedExtensions: preloaded,
			deferredExtensionPaths: [deferredPath],
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
			systemPrompt: prompt => {
				if (replaceOnRender) {
					replaceOnRender = false;
					eventBus.emit("replace-undo-chain", undefined);
				}
				return prompt;
			},
		});
		const runner = session.extensionRunner!;
		const prior = session.getToolByName("undo_chain")!;
		const priorInfo = session.getAllToolInfos().find(tool => tool.name === prior.name);
		const priorMounted = session.getMountedToolCommandNames();
		const siblingStarted = Promise.withResolvers<void>();
		const replacementScheduled = Promise.withResolvers<void>();
		const releaseSibling = Promise.withResolvers<void>();
		const siblingFailure = new Error("synthetic reentrant sibling failure");
		const unsubscribeReplaced = eventBus.on("undo-chain-replaced", () => replacementScheduled.resolve());
		const unsubscribe = runner.onToolRegistered(tool => {
			if (tool.definition.name !== "undo_chain_sibling") return;
			siblingStarted.resolve();
			return releaseSibling.promise.then(() => {
				throw siblingFailure;
			});
		});
		let loading: Promise<void> | undefined;
		try {
			await initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
			replaceOnRender = true;
			loading = session.loadDeferredExtensions();
			const rejected = loading.then(
				() => undefined,
				(error: unknown) => error,
			);
			await fixtureBoundary(siblingStarted.promise, "reentrant activation sibling subscriber");
			await fixtureBoundary(replacementScheduled.promise, "same-owner replacement during the first render");
			const replacement = await fixtureBoundary(
				session.runToolRegistryMutation(async () => session.getToolByName("undo_chain")),
				"reentrant replacement publication before sibling failure",
			);
			if (!replacement) throw new Error("expected reentrant replacement");
			expect(replacement).not.toBe(prior);
			expect(session.agent.state.tools.find(tool => tool.name === replacement.name)).toBe(replacement);
			expect(await replacement.execute("reentrant-candidate", { replacement: "value" })).toEqual({
				content: [{ type: "text", text: "replacement" }],
				details: {},
			});
			releaseSibling.resolve();
			expect(await fixtureBoundary(rejected, "reentrant activation failure")).toBeInstanceOf(Error);
			expect(session.getToolByName("undo_chain")).toBe(prior);
			expect(session.agent.state.tools.find(tool => tool.name === prior.name)).toBe(prior);
			expect(session.getAllToolInfos().find(tool => tool.name === prior.name)).toEqual(priorInfo);
			expect(session.getMountedToolCommandNames()).toEqual(priorMounted);
			expect(session.getEnabledToolNames()).toContain(prior.name);
			expect(session.getAllToolNames()).not.toContain("undo_chain_sibling");
			expect(session.getEnabledToolNames()).not.toContain("undo_chain_sibling");
			expect(await prior.execute("restored-undo-chain", { prior: "value" })).toEqual({
				content: [{ type: "text", text: "prior" }],
				details: {},
			});
			await expect(replacement.execute("failed-reentrant-candidate", { replacement: "value" })).rejects.toThrow(
				"Extension owner is no longer active",
			);
		} finally {
			replaceOnRender = false;
			releaseSibling.resolve();
			try {
				if (loading)
					await fixtureBoundary(
						loading.then(
							() => undefined,
							() => undefined,
						),
						"reentrant activation teardown",
					);
			} finally {
				unsubscribe();
				unsubscribeReplaced();
				await session.dispose();
				eventBus.clear();
			}
		}
	});

	it("excludes a failed deferred owner from tool dispatch and later registration precedence", async () => {
		const eventBus = new EventBus();
		const deferredPath = path.join(tempDir.path(), "failed-routing.ts");
		fs.writeFileSync(
			deferredPath,
			`export default pi => {
			pi.registerTool({
				name: "routing_survivor", label: "Failed candidate", description: "Failed candidate",
				parameters: pi.typebox.Type.Object({ failed: pi.typebox.Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "failed" }], details: {} })
			});
			pi.on("tool_call", event => {
				if (event.toolName !== "routing_survivor") return;
				pi.events.emit("failed-routing-dispatch", "tool_call");
				if (event.toolCallId === "restored-routing-first") return {
					block: true, reason: "synthetic failed owner block"
				};
			});
			pi.on("tool_result", event => {
				if (event.toolName !== "routing_survivor") return;
				pi.events.emit("failed-routing-dispatch", "tool_result");
				return { content: [{ type: "text", text: "failed owner result" }] };
			});
		}`,
		);
		let api: ExtensionAPI | undefined;
		const preloaded = await bindPreparedExtensions(
			[
				{
					path: "<routing-survivor>",
					resolvedPath: "<routing-survivor>",
					error: null,
					factory: pi => {
						api = pi;
						pi.registerTool({
							name: "routing_survivor",
							label: "Survivor",
							description: "Surviving owner",
							parameters: pi.typebox.Type.Object({ prior: pi.typebox.Type.String() }),
							execute: async () => ({ content: [{ type: "text", text: "prior" }], details: {} }),
						});
					},
				},
			],
			tempDir.path(),
			eventBus,
		);
		const settings = Settings.isolated();
		cfgToolsCommands.set(settings, false);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings,
			eventBus,
			preloadedExtensions: preloaded,
			deferredExtensionPaths: [deferredPath],
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});
		const runner = session.extensionRunner!;
		const prior = session.getToolByName("routing_survivor")!;
		const priorInfo = session.getAllToolInfos().find(tool => tool.name === prior.name);
		const failedDispatches: unknown[] = [];
		const unsubscribeEvents = eventBus.on("failed-routing-dispatch", event => {
			failedDispatches.push(event);
		});
		const unsubscribe = runner.onToolRegistered(tool => {
			if (tool.extensionPath === deferredPath)
				return Promise.reject(new Error("synthetic routing activation failure"));
		});
		try {
			await initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
			const rejected = session.loadDeferredExtensions().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(await fixtureBoundary(rejected, "failed routing owner rollback")).toBeInstanceOf(Error);
			const restored = session.getToolByName("routing_survivor");
			const restoredInfo = session.getAllToolInfos().find(tool => tool.name === prior.name);
			const firstExecution = await prior.execute("restored-routing-first", { prior: "value" }).then(
				result => result,
				(error: unknown) => error,
			);
			api!.registerTool({
				name: "routing_survivor",
				label: "Updated survivor",
				description: "Surviving owner re-registration",
				parameters: api!.typebox.Type.Object({ updated: api!.typebox.Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "updated" }], details: {} }),
			});
			const updated = await fixtureBoundary(
				session.runToolRegistryMutation(async () => session.getToolByName("routing_survivor")),
				"surviving owner re-registration publication",
			);
			if (!updated) throw new Error("expected surviving registration");
			const secondExecution = await updated.execute("restored-routing-second", { updated: "value" }).then(
				result => result,
				(error: unknown) => error,
			);
			expect(restored).toBe(prior);
			expect(restoredInfo).toEqual(priorInfo);
			expect(firstExecution).toEqual({ content: [{ type: "text", text: "prior" }], details: {} });
			expect(updated).not.toBe(prior);
			expect(session.agent.state.tools.find(tool => tool.name === updated.name)).toBe(updated);
			expect(session.getEnabledToolNames()).toContain(updated.name);
			expect(session.getMountedToolCommandNames()).not.toContain(updated.name);
			expect(session.getAllToolInfos().find(tool => tool.name === updated.name)?.sourceInfo).toEqual(
				priorInfo!.sourceInfo,
			);
			expect(secondExecution).toEqual({ content: [{ type: "text", text: "updated" }], details: {} });
			expect(failedDispatches).toEqual([]);
			await expect(prior.execute("replaced-routing-prior", { prior: "value" })).rejects.toThrow(
				"Extension owner is no longer active",
			);
		} finally {
			unsubscribe();
			unsubscribeEvents();
			await session.dispose();
			eventBus.clear();
		}
	});

	it("restores a same-owner executable after failed replacement without reviving successful orphans", async () => {
		let api: ExtensionAPI | undefined;
		const preloaded = await bindPreparedExtensions(
			[
				{
					path: "<same-owner-render>",
					resolvedPath: "<same-owner-render>",
					error: null,
					factory: pi => {
						api = pi;
						pi.registerTool({
							name: "owner_restore",
							label: "Original",
							description: "Original same-owner tool",
							parameters: pi.typebox.Type.Object({ original: pi.typebox.Type.String() }),
							execute: async () => ({ content: [{ type: "text", text: "original" }], details: {} }),
						});
						pi.on("session_start", () =>
							pi.registerTool({
								name: "owner_restore",
								label: "Rejected replacement",
								description: "Replacement whose publication fails",
								parameters: pi.typebox.Type.Object({ rejected: pi.typebox.Type.String() }),
								execute: async () => ({ content: [{ type: "text", text: "rejected" }], details: {} }),
							}),
						);
					},
				},
			],
			tempDir.path(),
		);
		const settings = Settings.isolated();
		cfgToolsCommands.set(settings, false);
		const renderFailure = new Error("synthetic same-owner replacement render failure");
		let failNextRender = false;
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings,
			preloadedExtensions: preloaded,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
			systemPrompt: prompt => {
				if (failNextRender) {
					failNextRender = false;
					throw renderFailure;
				}
				return prompt;
			},
		});
		const prior = session.getToolByName("owner_restore")!;
		const priorInfo = session.getAllToolInfos().find(tool => tool.name === prior.name);
		const priorMounted = session.getMountedToolCommandNames();
		const runtimeErrors: string[] = [];
		try {
			failNextRender = true;
			await initializeExtensions(session, {
				reportSendError: vi.fn(),
				reportRuntimeError: error => {
					runtimeErrors.push(error.error);
				},
			});
			const restored = session.getToolByName("owner_restore");
			const restoredInfo = session.getAllToolInfos().find(tool => tool.name === prior.name);
			const restoredExecution = await prior.execute("restored-same-owner", { original: "value" }).then(
				result => result,
				(error: unknown) => error,
			);
			api!.registerTool({
				name: "owner_restore",
				label: "Successful replacement",
				description: "Published same-owner replacement",
				parameters: api!.typebox.Type.Object({ successful: api!.typebox.Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "successful" }], details: {} }),
			});
			const successor = await fixtureBoundary(
				session.runToolRegistryMutation(async () => session.getToolByName("owner_restore")),
				"successful same-owner replacement publication",
			);
			if (!successor) throw new Error("expected successful same-owner replacement");
			const successorExecution = await successor.execute("successful-same-owner", { successful: "value" });
			const orphanExecution = await prior.execute("successful-replacement-orphan", { original: "value" }).then(
				result => result,
				(error: unknown) => error,
			);
			expect(runtimeErrors).toEqual([renderFailure.message]);
			expect(restored).toBe(prior);
			expect(restoredInfo).toEqual(priorInfo);
			expect(restoredExecution).toEqual({ content: [{ type: "text", text: "original" }], details: {} });
			expect(successor).not.toBe(prior);
			expect(session.agent.state.tools.find(tool => tool.name === successor.name)).toBe(successor);
			expect(session.getEnabledToolNames()).toContain(successor.name);
			expect(session.getMountedToolCommandNames()).toEqual(priorMounted);
			expect(session.getAllToolInfos().find(tool => tool.name === successor.name)?.sourceInfo).toEqual(
				priorInfo!.sourceInfo,
			);
			expect(successorExecution).toEqual({ content: [{ type: "text", text: "successful" }], details: {} });
			expect(orphanExecution).toBeInstanceOf(Error);
		} finally {
			failNextRender = false;
			await session.dispose();
		}
	});

	for (const origin of ["ordinary", "equal-mcp"] as const) {
		it(`does not resurrect a replaced startup backfill registration with ${origin} origin`, async () => {
			let api: ExtensionAPI | undefined;
			const preloaded = await bindPreparedExtensions(
				[
					{
						path: "<backfill-owner>",
						resolvedPath: "<backfill-owner>",
						error: null,
						factory: pi => {
							api = pi;
						},
					},
				],
				tempDir.path(),
			);
			let ownerActive = true;
			if (origin === "equal-mcp") preloaded.extensions[0]!.isActive = () => ownerActive;
			const name = origin === "equal-mcp" ? "mcp__startup_lookup" : "startup_lookup";
			const register = (toolName: string, text: string) =>
				api!.registerTool({
					name: toolName,
					label: text,
					description: `${text} backfill description`,
					parameters: api!.typebox.Type.Object({ [text]: api!.typebox.Type.String() }),
					...(origin === "equal-mcp" && toolName === name
						? { mcpServerName: "startup", mcpToolName: "lookup" }
						: {}),
					execute: async () => ({ content: [{ type: "text", text }], details: {} }),
				});
			let original: RegisteredTool | undefined;
			let renders = 0;
			const settings = Settings.isolated();
			cfgToolsCommands.set(settings, false);
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				settings,
				preloadedExtensions: preloaded,
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: ["read"],
				systemPrompt: prompt => {
					renders += 1;
					if (renders === 1) {
						register("startup_blocker", "blocker");
						register(name, "obsolete");
						original = preloaded.extensions[0]!.tools.get(name);
					} else if (renders === 2) {
						register(name, "replacement");
					}
					return prompt;
				},
			});
			try {
				await initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
				const current = session.getToolByName(name)!;
				await api!.setActiveTools(["read", "startup_blocker", name]);
				expect(session.agent.state.tools.find(tool => tool.name === name)).toBe(current);
				expect(session.getEnabledToolNames()).toContain(name);
				expect(session.getMountedToolCommandNames()).not.toContain(name);
				expect(await current.execute("current-backfill", { replacement: "value" })).toEqual({
					content: [{ type: "text", text: "replacement" }],
					details: {},
				});
				if (origin === "equal-mcp") {
					expect(session.getExtensionMCPTool(name)).toBe(current);
					expect(session.hasMCPManagerTool(name)).toBe(false);
				} else {
					const unowned = new RegisteredToolAdapter(
						{
							definition: original!.definition,
							extensionPath: original!.extensionPath,
							sourceInfo: original!.sourceInfo,
						},
						session.extensionRunner!,
					);
					await expect(unowned.execute("missing-owner", { obsolete: "value" })).rejects.toThrow(
						"Extension owner is no longer active",
					);
				}
				const retained = new RegisteredToolAdapter(original!, session.extensionRunner!);
				await expect(retained.execute("orphan-backfill", { obsolete: "value" })).rejects.toThrow(
					"Extension owner is no longer active",
				);
				ownerActive = false;
				await expect(retained.execute("invalidated-orphan-backfill", { obsolete: "value" })).rejects.toThrow(
					"Extension owner is no longer active",
				);
			} finally {
				await session.dispose();
			}
		});
	}

	for (const replacement of ["prior", "successor", "different-successor"] as const) {
		it(`rejects render-invalidated activation without overwriting ${replacement} publication`, async () => {
			const deferredPath = path.join(tempDir.path(), "render-stale.ts");
			const executedPath = path.join(tempDir.path(), "stale-executed");
			fs.writeFileSync(
				deferredPath,
				`import * as fs from "node:fs";
				export default pi => pi.registerTool({
					name: "render_shared", label: "Stale render", description: "stale render description",
					parameters: pi.typebox.Type.Object({}),
					execute: async () => {
						fs.writeFileSync(${JSON.stringify(executedPath)}, "executed");
						return { content: [{ type: "text", text: "stale" }], details: {} };
					}
				});`,
			);
			const runtime = new ExtensionRuntime();
			const prepare = (text: string): PreparedExtension => ({
				path: `<render-${text}>`,
				resolvedPath: `<render-${text}>`,
				error: null,
				factory: pi =>
					pi.registerTool({
						name: text === "different-successor" ? "render_other" : "render_shared",
						label: text,
						description: `${text} render description`,
						parameters: pi.typebox.Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text }], details: {} }),
					}),
			});
			const preloaded = await bindPreparedExtensions([prepare("prior")], tempDir.path(), undefined, runtime);
			const successor = await bindPreparedExtensions(
				[prepare(replacement === "different-successor" ? replacement : "successor")],
				tempDir.path(),
				undefined,
				runtime,
			);
			let onRender: ((candidate: string[]) => void) | undefined;
			let invalidatedPrompt: string[] | undefined;
			const renderedPrompts: string[][] = [];
			const settings = Settings.isolated();
			cfgToolsCommands.set(settings, false);
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
				settings,
				preloadedExtensions: preloaded,
				deferredExtensionPaths: [deferredPath],
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				toolNames: ["read"],
				systemPrompt: defaultPrompt => {
					const candidate = [...defaultPrompt, `Synthetic prompt revision ${renderedPrompts.length + 1}`];
					renderedPrompts.push(candidate);
					const invalidate = onRender;
					onRender = undefined;
					invalidate?.(candidate);
					return candidate;
				},
			});
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected extension runner");
			const prior = session.getToolByName("render_shared");
			if (!prior) throw new Error("expected prior registration");
			let stale: typeof prior | undefined;
			let abort: Promise<void> | undefined;
			let succeeding: Promise<void> | undefined;
			const rendered = Promise.withResolvers<void>();
			onRender = candidate => {
				invalidatedPrompt = candidate;
				stale = session.getToolByName("render_shared");
				abort = session.abort();
				if (replacement !== "prior") {
					succeeding = runner.addExtensions(successor.extensions);
				}
				rendered.resolve();
			};
			let loading: Promise<void> | undefined;
			try {
				loading = session.loadDeferredExtensions();
				const rejected = loading.then(
					() => undefined,
					(error: unknown) => error,
				);
				await fixtureBoundary(rendered.promise, "invalidating prompt render");
				expect(await rejected).toBeInstanceOf(Error);
				await abort;
				await succeeding;
				expect(stale).not.toBe(prior);
				if (!stale) throw new Error("expected render candidate");
				await expect(stale.execute("stale-retained", {})).rejects.toThrow("Extension owner is no longer active");
				expect(fs.existsSync(executedPath)).toBe(false);
				const published = session.getToolByName("render_shared");
				if (!published) throw new Error("expected retained registration");
				const sharedText = replacement === "successor" ? replacement : "prior";
				if (replacement !== "successor") expect(published).toBe(prior);
				expect(await published.execute("retained", {})).toEqual({
					content: [{ type: "text", text: sharedText }],
					details: {},
				});
				expect(session.agent.state.tools.find(tool => tool.name === "render_shared")).toBe(published);
				expect(session.getEnabledToolNames()).toContain("render_shared");
				expect(session.getMountedToolCommandNames()).not.toContain("render_shared");
				if (replacement === "different-successor") {
					const other = session.getToolByName("render_other");
					expect(session.agent.state.tools.find(tool => tool.name === "render_other")).toBe(other);
					expect(session.getEnabledToolNames()).toContain("render_other");
					expect(await other!.execute("different-successor", {})).toEqual({
						content: [{ type: "text", text: replacement }],
						details: {},
					});
				}
				const latestPrompt = renderedPrompts.at(-1);
				if (!latestPrompt) throw new Error("Expected a rendered prompt revision");
				expect(session.agent.state.systemPrompt).toEqual(latestPrompt);
				expect(session.agent.state.systemPrompt).not.toContain(invalidatedPrompt!.at(-1));
			} finally {
				onRender = undefined;
				try {
					if (loading)
						await fixtureBoundary(
							loading.then(
								() => undefined,
								() => undefined,
							),
							"render activation teardown",
						);
					await abort;
					await succeeding;
				} finally {
					await session.dispose();
				}
			}
		});
	}

	it("runs graduated deferred shutdown cleanup after disposal without routing failed or suspended owners", async () => {
		const eventBus = new EventBus();
		const observed: unknown[] = [];
		const unsubscribeEvents = eventBus.on("shutdown-observed", owner => {
			observed.push(owner);
		});
		const pendingStarted = Promise.withResolvers<void>();
		const releasePending = Promise.withResolvers<void>();
		const deferredPath = path.join(tempDir.path(), "shutdown-graduated.ts");
		fs.writeFileSync(
			deferredPath,
			`export default pi => {
			pi.registerTool({
				name: "shutdown_graduated", label: "Graduated", description: "Successful deferred owner",
				parameters: pi.typebox.Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "graduated" }], details: {} })
			});
			pi.on("session_shutdown", () => pi.events.emit("shutdown-observed", "graduated"));
		}`,
		);
		const preloaded = await bindPreparedExtensions(
			[
				{
					path: "<shutdown-eager>",
					resolvedPath: "<shutdown-eager>",
					error: null,
					factory: pi => {
						pi.on("session_shutdown", () => pi.events.emit("shutdown-observed", "eager"));
					},
				},
			],
			tempDir.path(),
			eventBus,
		);
		const added = await bindPreparedExtensions(
			[
				{
					path: "<shutdown-failed>",
					resolvedPath: "<shutdown-failed>",
					error: null,
					factory: pi => {
						pi.registerTool({
							name: "shutdown_failed",
							label: "Failed",
							description: "Failed shutdown owner",
							parameters: pi.typebox.Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "failed" }], details: {} }),
						});
						pi.on("session_shutdown", () => pi.events.emit("shutdown-observed", "failed"));
					},
				},
				{
					path: "<shutdown-suspended>",
					resolvedPath: "<shutdown-suspended>",
					error: null,
					factory: pi => {
						pi.on("session_shutdown", () => pi.events.emit("shutdown-observed", "suspended"));
					},
				},
				{
					path: "<shutdown-pending>",
					resolvedPath: "<shutdown-pending>",
					error: null,
					factory: pi => {
						pi.registerTool({
							name: "shutdown_pending",
							label: "Pending",
							description: "Pending shutdown owner",
							parameters: pi.typebox.Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "pending" }], details: {} }),
						});
						pi.on("session_shutdown", () => pi.events.emit("shutdown-observed", "pending"));
					},
				},
			],
			tempDir.path(),
			eventBus,
			preloaded.runtime,
			{ isActive: () => true },
		);
		const settings = Settings.isolated();
		cfgToolsCommands.set(settings, false);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings,
			eventBus,
			preloadedExtensions: preloaded,
			deferredExtensionPaths: [deferredPath],
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});
		const runner = session.extensionRunner!;
		const failed = added.extensions[0]!;
		const suspended = added.extensions[1]!;
		const pending = added.extensions[2]!;
		let pendingActivation: Promise<void> | undefined;
		const unsubscribe = runner.onToolRegistered(tool => {
			if (tool.owner === failed) return Promise.reject(new Error("synthetic shutdown activation failure"));
			if (tool.owner === pending) {
				pendingStarted.resolve();
				return releasePending.promise.then(() => {
					throw new Error("synthetic pending shutdown settlement");
				});
			}
		});
		try {
			await initializeExtensions(session, { reportSendError: vi.fn(), reportRuntimeError: vi.fn() });
			await session.loadDeferredExtensions();
			const graduated = runner.getLoadedExtensions().find(extension => extension.path === deferredPath);
			if (!graduated) throw new Error("expected graduated deferred shutdown owner");
			expect(graduated.isActive?.()).toBe(true);
			expect(await session.getToolByName("shutdown_graduated")!.execute("graduated-before-dispose", {})).toEqual({
				content: [{ type: "text", text: "graduated" }],
				details: {},
			});
			const rejected = runner.addExtensions([failed]).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(await fixtureBoundary(rejected, "failed shutdown owner activation")).toBeInstanceOf(Error);
			await runner.addExtensions([suspended]);
			runner.setSuspendedExtensions(extension => extension === suspended);
			expect(runner.getLoadedExtensions()).toContain(failed);
			expect(runner.getLoadedExtensions()).toContain(suspended);
			pendingActivation = runner.addExtensions([pending]);
			const pendingOutcome = pendingActivation.then(
				() => undefined,
				(error: unknown) => error,
			);
			await fixtureBoundary(pendingStarted.promise, "pending owner before shutdown");
			session.beginDispose();
			expect(session.isDisposed).toBe(true);
			expect(graduated.isActive?.()).toBe(false);
			await session.dispose();
			expect(observed.toSorted()).toEqual(["eager", "graduated", "pending"]);
			releasePending.resolve();
			expect(await fixtureBoundary(pendingOutcome, "pending owner after shutdown")).toBeInstanceOf(Error);
		} finally {
			releasePending.resolve();
			try {
				if (pendingActivation)
					await fixtureBoundary(
						pendingActivation.then(
							() => undefined,
							() => undefined,
						),
						"pending shutdown owner teardown",
					);
			} finally {
				unsubscribe();
				await session.dispose();
				unsubscribeEvents();
				eventBus.clear();
			}
		}
	});

	it("keeps a deferred factory failure as a rejected readiness barrier", async () => {
		const failedPath = path.join(tempDir.path(), "failed.ts");
		fs.writeFileSync(failedPath, `export default function() { throw new Error("factory readiness failure"); }`);
		const eventBus = new EventBus();
		const preloaded = await loadExtensions([], tempDir.path(), eventBus);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated(),
			eventBus,
			preloadedExtensions: preloaded,
			deferredExtensionPaths: [failedPath],
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});
		try {
			await expect(session.loadDeferredExtensions()).rejects.toThrow(Error);
			await expect(session.loadDeferredExtensions()).rejects.toThrow(Error);
			expect(session.extensionPaths).not.toContain(failedPath);
		} finally {
			await session.dispose();
		}
	});
});
