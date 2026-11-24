/**
 * Regression coverage for the `<id>.json` structured-output sidecar
 * lifecycle: a replacement write failure must not leave a stale sidecar from
 * an earlier turn answering `agent://<id>/<field>` with superseded data, and
 * a schema-invalid yield with parsed data must still get a sidecar so its
 * full payload stays recoverable via `agent://<id>` (PR #10625 review).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import { withArtifactPublicationLock } from "../../src/session/artifact-publication";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import {
	artifactFileGeneration,
	parseStructuredArtifactSidecar,
	serializeStructuredArtifactSidecar,
} from "../../src/session/artifacts";

function createMockSession(onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	let disposed = false;
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		get isDisposed() {
			return disposed;
		},
		dispose: async () => {
			disposed = true;
		},
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt({ emit });
			return true;
		},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(data: unknown): AgentSession {
	return createMockSession(({ emit }) => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-sidecar",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
			isError: false,
		});
	});
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		captureOwnerCurrent: () => () => !session.isDisposed,
		captureOwnerLifetimeCurrent: () => () => !session.isDisposed,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("structured output sidecar lifecycle", () => {
	let artifactsDir: string | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (artifactsDir) await fs.rm(artifactsDir, { recursive: true, force: true });
		artifactsDir = undefined;
	});

	it.each(["cancelled", "retired"] as const)(
		"does not publish an owner %s while waiting for publication",
		async mode => {
			artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-publication-wait-"));
			const id = `WaitingOwner-${mode}`;
			const primary = path.join(artifactsDir, `${id}.md`);
			const sidecar = path.join(artifactsDir, `${id}.json`);
			const accepted = '{"report":"accepted result"}';
			await fs.writeFile(primary, accepted);
			const envelope = serializeStructuredArtifactSidecar(
				accepted,
				artifactFileGeneration(await fs.stat(primary, { bigint: true })),
			);
			await fs.writeFile(sidecar, envelope);
			const session = yieldEmittingSession({ report: "waiting result" });
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const contended = Promise.withResolvers<void>();
			if (process.platform === "linux") {
				const acquire = FileLock.tryAcquireNamed.bind(FileLock);
				vi.spyOn(FileLock, "tryAcquireNamed").mockImplementation(name => {
					const lock = acquire(name);
					if (!lock.acquired) contended.resolve();
					return lock;
				});
			} else {
				const acquire = FileLock.tryAcquire.bind(FileLock);
				vi.spyOn(FileLock, "tryAcquire").mockImplementation((...args) => {
					const lock = acquire(...args);
					if (!lock.acquired) contended.resolve();
					return lock;
				});
			}
			const holder = withArtifactPublicationLock(async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			const controller = new AbortController();
			const pending = runSubprocess({
				cwd: "/tmp",
				agent: baseAgent,
				task: "do work",
				index: 0,
				id,
				settings: Settings.isolated(),
				modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
				enableLsp: false,
				artifactsDir,
				signal: controller.signal,
			});
			try {
				await contended.promise;
				expect(await fs.readFile(primary, "utf8")).toBe(accepted);
				if (mode === "cancelled") {
					controller.abort();
				} else {
					AgentRegistry.global().register({
						id,
						displayName: id,
						kind: "sub",
						status: "idle",
						session: yieldEmittingSession({ replacement: true }),
					});
					release.resolve();
				}
				const result = await pending;
				expect(result.exitCode).toBe(1);
				expect(result.aborted).toBe(true);
				expect(result.outputPath).toBeUndefined();
				expect(await fs.readFile(primary, "utf8")).toBe(accepted);
				expect(await fs.readFile(sidecar, "utf8")).toBe(envelope);
			} finally {
				controller.abort();
				release.resolve();
				await holder;
				await pending;
				AgentRegistry.global().unregister(id);
			}
		},
	);

	it("binds structured data to the primary identity after rename", async () => {
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-post-rename-generation-"));
		const id = "RenamedIdentity";
		const primary = path.join(artifactsDir, `${id}.md`);
		const payload = { report: "complete result", nested: { value: "retained" } };
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(yieldEmittingSession(payload)));
		const rename = fsSync.renameSync;
		vi.spyOn(fsSync, "renameSync").mockImplementation((source, destination) => {
			rename(source, destination);
			if (String(destination) === primary) {
				const replacement = `${primary}.replacement`;
				fsSync.copyFileSync(primary, replacement);
				rename(replacement, primary);
			}
		});
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			outputSchema: {
				type: "object",
				properties: { report: { type: "string" }, nested: { type: "object" } },
				required: ["report", "nested"],
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput).toMatchObject({ status: "valid", data: payload });
		expect(await fs.readFile(primary, "utf8")).toBe(result.output);
		const generation = artifactFileGeneration(await fs.stat(primary, { bigint: true }));
		expect(
			parseStructuredArtifactSidecar(await fs.readFile(path.join(artifactsDir, `${id}.json`), "utf8"), generation)
				?.data,
		).toEqual(payload);
	});

	it("drops a stale sidecar instead of leaving it behind when the replacement write fails", async () => {
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-test-"));
		const id = "SidecarProbe";
		const sidecarPath = path.join(artifactsDir, `${id}.json`);
		await fs.writeFile(sidecarPath, JSON.stringify({ summary: "stale from an earlier turn" }));

		const session = yieldEmittingSession({ ok: true });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const originalWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(((dest: unknown, ...rest: unknown[]) => {
			if (typeof dest === "string" && dest.includes(`${id}.json.tmp-`)) {
				return Promise.reject(new Error("simulated disk failure"));
			}
			return (originalWrite as (...args: unknown[]) => unknown)(dest, ...rest);
		}) as typeof Bun.write);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.exitCode, JSON.stringify(result)).toBe(0);
		expect(result.structuredOutput).toMatchObject({ status: "valid", data: { ok: true } });
		// The <id>.md artifact republished successfully...
		expect(result.outputPath).toBe(path.join(artifactsDir, `${id}.md`));
		expect(await fs.readFile(result.outputPath!, "utf8")).toBe(result.output);
		// ...but the sidecar write failed, so the stale sidecar must not survive
		// to keep answering agent://<id>/<field> with the superseded payload.
		await expect(fs.stat(sidecarPath)).rejects.toThrow();
	});

	it("preserves a replacement owner's accepted artifacts when the staged sidecar write fails", async () => {
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-owner-test-"));
		const id = "ReplacedSidecarProbe";
		const outputPath = path.join(artifactsDir, `${id}.md`);
		const sidecarPath = path.join(artifactsDir, `${id}.json`);
		const accepted = JSON.stringify({ report: "replacement owner's accepted result" });
		const session = yieldEmittingSession({ ok: true });
		const replacement = yieldEmittingSession({ replacement: true });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
		const originalWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(((dest: unknown, ...rest: unknown[]) => {
			if (typeof dest === "string" && dest.includes(`${id}.json.tmp-`)) {
				return (async () => {
					AgentRegistry.global().register({
						id,
						displayName: id,
						kind: "sub",
						status: "idle",
						session: replacement,
					});
					await fs.writeFile(outputPath, accepted);
					const generation = artifactFileGeneration(await fs.stat(outputPath, { bigint: true }));
					await fs.writeFile(sidecarPath, serializeStructuredArtifactSidecar(accepted, generation));
					throw new Error("simulated disk failure after owner replacement");
				})();
			}
			return (originalWrite as (...args: unknown[]) => unknown)(dest, ...rest);
		}) as typeof Bun.write);
		try {
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: baseAgent,
				task: "do work",
				index: 0,
				id,
				settings: Settings.isolated(),
				modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
				enableLsp: false,
				artifactsDir,
				outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			});
			expect(result.exitCode, JSON.stringify(result)).toBe(1);
			expect(result.aborted).toBe(true);
			expect(result.outputPath).toBeUndefined();
			expect(await fs.readFile(outputPath, "utf8")).toBe(accepted);
			const generation = artifactFileGeneration(await fs.stat(outputPath, { bigint: true }));
			expect(parseStructuredArtifactSidecar(await fs.readFile(sidecarPath, "utf8"), generation)?.data).toEqual(
				JSON.parse(accepted),
			);
			expect(AgentRegistry.global().get(id)?.session).toBe(replacement);
		} finally {
			AgentRegistry.global().unregister(id);
		}
	});

	it("removes a stale sidecar instead of leaving it when the serialized data is undefined", async () => {
		// Regression: `Object.hasOwn(structured, "data")` can be true while
		// `JSON.stringify(structured.data, null, 2)` itself returns
		// `undefined` (e.g. `structured.data === undefined`) — previously
		// neither a write nor a removal happened, leaving a stale sidecar
		// from an earlier turn behind (PR #10625 review).
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-test-"));
		const id = "UndefinedDataProbe";
		const sidecarPath = path.join(artifactsDir, `${id}.json`);
		await fs.writeFile(sidecarPath, JSON.stringify({ summary: "stale from an earlier turn" }));

		const session = yieldEmittingSession({ ok: true });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const originalStringify = JSON.stringify.bind(JSON);
		vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...rest: unknown[]) => {
			// Narrowly target only the yielded `{ ok: true }` payload so other
			// concurrent JSON.stringify calls in the pipeline are unaffected.
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.keys(value).length === 1 &&
				"ok" in value &&
				value.ok === true
			) {
				return undefined as unknown as string;
			}
			return (originalStringify as (...args: unknown[]) => unknown)(value, ...rest) as string;
		}) as typeof JSON.stringify);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.structuredOutput?.data).toEqual({ ok: true });
		await expect(fs.stat(sidecarPath)).rejects.toThrow();
	});

	it("persists the sidecar for a schema-invalid yield that still carries parsed data", async () => {
		// Regression: previously the sidecar was written only for
		// `status === "valid"`, so an oversized invalid payload had no
		// recovery path beyond the truncated inline preview.
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-test-"));
		const id = "InvalidSidecarProbe";

		// `ok` is a string, not a boolean — violates the schema below, but the
		// data still parses and must be preserved.
		const session = yieldEmittingSession({ ok: "not-a-boolean" });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.structuredOutput?.status).toBe("invalid");
		const sidecarPath = path.join(artifactsDir, `${id}.json`);
		await expect(fs.stat(sidecarPath)).resolves.toBeDefined();
		const generation = artifactFileGeneration(await fs.stat(result.outputPath!, { bigint: true }));
		const sidecar = parseStructuredArtifactSidecar(await fs.readFile(sidecarPath, "utf8"), generation);
		expect(sidecar?.data).toEqual({ ok: "not-a-boolean" });
	});

	it.each(["write", "rename", "remove", "serialize"] as const)(
		"keeps accepted identical Markdown authoritative after optional %s and cleanup failure",
		async fault => {
			artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-generation-"));
			const id = `Generation-${fault}`;
			const primary = path.join(artifactsDir, `${id}.md`);
			const sidecar = path.join(artifactsDir, `${id}.json`);
			const options = {
				cwd: "/tmp",
				agent: baseAgent,
				task: "do work",
				index: 0,
				id,
				settings: Settings.isolated(),
				modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
				enableLsp: false,
				artifactsDir,
				outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			};
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () =>
				createSessionResult(yieldEmittingSession({ ok: true })),
			);
			const first = await runSubprocess(options);
			expect(first.exitCode).toBe(0);
			const firstMarkdown = await fs.readFile(primary, "utf8");
			const firstSidecar = await fs.readFile(sidecar, "utf8");
			const previousGeneration = artifactFileGeneration(await fs.stat(primary, { bigint: true }));
			const originalRemove = fsSync.rmSync;
			vi.spyOn(fsSync, "rmSync").mockImplementation((file, options) => {
				if (String(file) === sidecar) throw new Error("Synthetic optional cleanup failure");
				return originalRemove(file, options);
			});
			if (fault === "write") {
				const originalWrite = Bun.write.bind(Bun);
				vi.spyOn(Bun, "write").mockImplementation(((dest: unknown, ...rest: unknown[]) => {
					if (typeof dest === "string" && dest.includes(`${id}.json.tmp-`))
						return Promise.reject(new Error("Synthetic optional write failure"));
					return (originalWrite as (...args: unknown[]) => unknown)(dest, ...rest);
				}) as typeof Bun.write);
			} else if (fault === "rename") {
				const originalRename = fsSync.renameSync;
				vi.spyOn(fsSync, "renameSync").mockImplementation((source, destination) => {
					if (String(destination) === sidecar) throw new Error("Synthetic optional rename failure");
					return originalRename(source, destination);
				});
			} else if (fault === "serialize") {
				let primaryStaged = false;
				const originalWrite = Bun.write.bind(Bun);
				vi.spyOn(Bun, "write").mockImplementation(((dest: unknown, ...rest: unknown[]) => {
					if (typeof dest === "string" && dest.includes(`${id}.md.tmp-`)) primaryStaged = true;
					return (originalWrite as (...args: unknown[]) => unknown)(dest, ...rest);
				}) as typeof Bun.write);
				const originalStringify = JSON.stringify.bind(JSON);
				vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...rest: unknown[]) => {
					if (
						primaryStaged &&
						value !== null &&
						typeof value === "object" &&
						Object.keys(value).length === 1 &&
						"ok" in value
					)
						throw new Error("Synthetic optional serialization failure");
					return (originalStringify as (...args: unknown[]) => unknown)(value, ...rest);
				}) as typeof JSON.stringify);
			}
			const second = await runSubprocess({
				...options,
				outputSchema: fault === "remove" ? undefined : options.outputSchema,
			});
			expect(second.exitCode, JSON.stringify(second)).toBe(0);
			expect(second.outputPath).toBe(primary);
			expect(await fs.readFile(primary, "utf8")).toBe(firstMarkdown);
			expect(await fs.readFile(sidecar, "utf8")).toBe(firstSidecar);
			expect(artifactFileGeneration(await fs.stat(primary, { bigint: true }))).not.toBe(previousGeneration);
			const extracted = await new AgentProtocolHandler().resolve(
				new URL(`agent://${id}/ok`) as never,
				{
					session: { seanceSourceArtifactsDir: artifactsDir },
				} as never,
			);
			expect(JSON.parse(extracted.content)).toBe(true);
			expect(extracted.sourcePath).toBe(primary);
		},
	);

	it.each(["write", "rename"] as const)(
		"retains the accepted artifact and fails the result when primary %s fails",
		async fault => {
			artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-primary-failure-"));
			const id = "PrimaryFailure";
			const primary = path.join(artifactsDir, `${id}.md`);
			const accepted = "previous accepted report";
			await fs.writeFile(primary, accepted);
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
				createSessionResult(yieldEmittingSession({ ok: true })),
			);
			if (fault === "write") {
				const originalWrite = Bun.write.bind(Bun);
				vi.spyOn(Bun, "write").mockImplementation(((dest: unknown, ...rest: unknown[]) => {
					if (typeof dest === "string" && dest.includes(`${id}.md.tmp-`))
						return Promise.reject(new Error("Synthetic primary write failure"));
					return (originalWrite as (...args: unknown[]) => unknown)(dest, ...rest);
				}) as typeof Bun.write);
			} else {
				const originalRename = fsSync.renameSync;
				vi.spyOn(fsSync, "renameSync").mockImplementation((source, destination) => {
					if (String(destination) === primary) throw new Error("Synthetic primary rename failure");
					return originalRename(source, destination);
				});
			}
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: baseAgent,
				task: "work",
				index: 0,
				id,
				artifactsDir,
				settings: Settings.isolated(),
				modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
				enableLsp: false,
			});
			expect(result.exitCode).toBe(1);
			expect(result.outputPath).toBeUndefined();
			expect(await fs.readFile(primary, "utf8")).toBe(accepted);
		},
	);
});
