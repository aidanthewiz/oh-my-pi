import { afterAll, afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { bridgeValueFromToolResult } from "../../src/eval/js/session-tool";
import { IrcBus } from "../../src/irc/bus";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import type { ToolSession } from "../../src/tools";
import {
	artifactFileGeneration,
	ArtifactManager,
	serializeStructuredArtifactSidecar,
} from "../../src/session/artifacts";

import { ReadTool } from "../../src/tools/read";
const tempDir = TempDir.createSync("@omp-nested-agent-repro-");
afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});
afterAll(() => {
	tempDir.removeSync();
});

async function writeBoundSidecar(primary: string, data: unknown): Promise<void> {
	const generation = artifactFileGeneration(await fs.stat(primary, { bigint: true }));
	await fs.writeFile(
		primary.slice(0, -3) + ".json",
		serializeStructuredArtifactSidecar(JSON.stringify(data), generation),
	);
}

it("agent:// resolves a depth-2 subagent's .md output while its session is live and artifact-manager-adopted", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	// Every subagent adopts the root ArtifactManager and reports its dir.
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// A depth-1 subagent's OWN children are written under its own
	// sessionFile.slice(0, -6) (task/index.ts), i.e. one level deeper.
	const midSessionFile = path.join(rootArtifactsDir, "CodexDeepDive.jsonl");
	const midOwnArtifactsDir = midSessionFile.slice(0, -6);
	await fs.mkdir(midOwnArtifactsDir, { recursive: true });

	const grandchildId = "CodexDeepDive.GraphStore";
	const grandchildSessionFile = path.join(midOwnArtifactsDir, `${grandchildId}.jsonl`);
	await fs.writeFile(path.join(midOwnArtifactsDir, `${grandchildId}.md`), "full report content");

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "CodexDeepDive",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: midSessionFile,
	});
	registry.register({
		id: grandchildId,
		displayName: "sub",
		kind: "sub",
		parentId: "CodexDeepDive",
		session: fakeSession,
		sessionFile: grandchildSessionFile,
	});

	const resource = await new AgentProtocolHandler().resolve(new URL(`agent://${grandchildId}`) as never);
	expect(resource.content).toBe("full report content");
});

it("agent:// nested child is the dotted host; a slash on the parent is a JSON path, never a hierarchy hop", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "slash-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// Parent subagent adopts the root ArtifactManager; its own children are
	// written one level deeper under its sessionFile-derived dir, dot-qualified.
	const parentSessionFile = path.join(rootArtifactsDir, "Parent.jsonl");
	const parentOwnDir = parentSessionFile.slice(0, -6);
	await fs.mkdir(parentOwnDir, { recursive: true });
	await fs.writeFile(path.join(parentOwnDir, "Parent.Child.md"), "child capsule");
	// Parent output may be in the root dir; the nested child must still win.
	await fs.writeFile(path.join(rootArtifactsDir, "Parent.md"), JSON.stringify({ Child: "parent json field" }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "Parent",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: parentSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const dotted = await handler.resolve(new URL("agent://Parent.Child") as never);
	expect(dotted.content).toBe("child capsule");
	expect(dotted.contentType).toBe("text/markdown");
	// The slash never hops the hierarchy: it extracts `Child` from Parent.md.
	const slash = await handler.resolve(new URL("agent://Parent/Child") as never);
	expect(slash.content).toBe("parent json field");
});

it("agent:// path form extracts JSON by key and array index", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "json-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	await fs.writeFile(
		path.join(rootArtifactsDir, "Worker.md"),
		JSON.stringify({ result: { ok: true }, reports: [{ data: "first report" }] }),
	);

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const extracted = await handler.resolve(new URL("agent://Worker/result") as never);
	expect(extracted.contentType).toBe("application/json");
	expect(JSON.parse(extracted.content)).toEqual({ ok: true });
	// Numeric segments index arrays; a string leaf reads as prose.
	const indexed = await handler.resolve(new URL("agent://Worker/reports/0/data") as never);
	expect(indexed.contentType).toBe("text/markdown");
	expect(indexed.content).toBe("first report");
	const queried = await handler.resolve(new URL("agent://Worker?q=.reports[0].data") as never);
	expect(queried.contentType).toBe("text/markdown");
	expect(queried.content).toBe("first report");
	expect(queried.notes).toContain("Extracted: .reports[0].data");
	// A missing key yields `undefined`, not a crash or the whole document.
	const missing = await handler.resolve(new URL("agent://Worker/reports/5/data") as never);
	expect(missing.content).toBe("null");
	await expect(handler.resolve(new URL("agent://Worker/reports?q=.result") as never)).rejects.toThrow(
		/cannot combine path extraction with \?q=/,
	);
});

it("agent:// path extraction prefers the <id>.json sidecar over the markdown body", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "sidecar-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	// Non-JSON body proves the fallback path could not have produced the answer.
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.md"), "schema_violation summary text");
	await writeBoundSidecar(path.join(rootArtifactsDir, "Worker.md"), { summary: "ok", count: 7 });

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const resource = await handler.resolve(new URL("agent://Worker/count") as never);
	expect(resource.contentType).toBe("application/json");
	expect(JSON.parse(resource.content)).toBe(7);
	expect(resource.sourcePath?.endsWith("Worker.json")).toBe(true);

	// A bare id keeps serving the markdown body, never the sidecar.
	const bare = await handler.resolve(new URL("agent://Worker") as never);
	expect(bare.contentType).toBe("text/markdown");
	expect(bare.content).toBe("schema_violation summary text");

	// A corrupt sidecar falls back to <id>.md instead of surfacing its own parse error.
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.json"), "{not json");
	await expect(handler.resolve(new URL("agent://Worker/count") as never)).rejects.toBeInstanceOf(Error);

	await writeBoundSidecar(path.join(rootArtifactsDir, "Worker.md"), { count: 7 });
	await fs.writeFile(path.join(rootArtifactsDir, "replacement.md"), "schema_violation summary text");
	await fs.rename(path.join(rootArtifactsDir, "replacement.md"), path.join(rootArtifactsDir, "Worker.md"));
	await expect(handler.resolve(new URL("agent://Worker/count") as never)).rejects.toBeInstanceOf(Error);
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.json"), JSON.stringify({ count: "unbound stale payload" }));
	await expect(handler.resolve(new URL("agent://Worker/count") as never)).rejects.toBeInstanceOf(Error);
	await writeBoundSidecar(path.join(rootArtifactsDir, "Worker.md"), { count: 9 });
	expect(JSON.parse((await handler.resolve(new URL("agent://Worker/count") as never)).content)).toBe(9);
});

it.each(["primary", "sidecar"] as const)("agent:// rejects a racing %s file generation", async target => {
	const rootSessionFile = path.join(tempDir.path(), `race-${target}.jsonl`);
	const dir = rootSessionFile.slice(0, -6);
	await fs.mkdir(dir, { recursive: true });
	const primary = path.join(dir, "Worker.md");
	const sidecar = path.join(dir, "Worker.json");
	await fs.writeFile(primary, JSON.stringify({ count: 1 }));
	await writeBoundSidecar(primary, { count: 7 });
	const replacement = path.join(dir, "replacement");
	await fs.writeFile(
		replacement,
		target === "primary"
			? JSON.stringify({ count: 1 })
			: serializeStructuredArtifactSidecar(
					JSON.stringify({ count: 9 }),
					artifactFileGeneration(await fs.stat(primary, { bigint: true })),
				),
	);
	AgentRegistry.global().register({
		id: "Main",
		displayName: "Main",
		kind: "main",
		session: { sessionManager: { getArtifactsDir: () => dir } } as unknown as AgentSession,
		sessionFile: rootSessionFile,
	});
	const originalOpen = fs.open;
	let replaced = false;
	vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
		const handle = await originalOpen(file, flags, mode);
		if (String(file) === sidecar && !replaced) {
			replaced = true;
			await fs.rename(replacement, target === "primary" ? primary : sidecar);
		}
		return handle;
	});
	await expect(new AgentProtocolHandler().resolve(new URL("agent://Worker/count") as never)).rejects.toBeInstanceOf(
		Error,
	);
});

it("agent:// writes deliver peer messages but reject JSON paths and disabled IRC", async () => {
	IrcBus.resetGlobalForTests();
	const registry = AgentRegistry.global();
	const delivered: string[] = [];
	registry.register({
		id: "Worker",
		displayName: "worker",
		kind: "sub",
		session: {
			deliverIrcMessage: async (message: { body: string }) => {
				delivered.push(message.body);
				return "woken";
			},
		} as unknown as AgentSession,
	});
	const session: ToolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		agentRegistry: registry,
		getAgentId: () => "Main",
		settings: Settings.isolated(),
		taskDepth: 0,
	};
	const handler = new AgentProtocolHandler();
	const context = { session };
	const receipt = await handler.write(parseInternalUrl("agent://Worker"), "Check context", context);
	expect(receipt.isError).toBe(false);
	expect(delivered).toEqual(["Check context"]);

	await expect(handler.write(parseInternalUrl("agent://Worker/result"), "overwrite", context)).rejects.toThrow(
		/JSON-path suffix/,
	);
	session.enableIrc = false;
	await expect(handler.write(parseInternalUrl("agent://Worker"), "blocked", context)).rejects.toThrow(
		/Peer messaging is unavailable/,
	);
	expect(delivered).toEqual(["Check context"]);
});

it.each(["Visuals", "Parent.Child"])(
	"agent:// marks superseded output for %s without breaking extraction",
	async id => {
		const root = tempDir.path();
		const rootSessionFile = path.join(root, "superseded-session.jsonl");
		const rootArtifactsDir = rootSessionFile.slice(0, -6);
		await fs.mkdir(rootArtifactsDir, { recursive: true });
		const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
		const published = JSON.stringify({ status: "partial", summary: "run budget ran out" });
		await fs.writeFile(path.join(rootArtifactsDir, `${id}.md`), published);

		const mainSession = {
			sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
		} as unknown as AgentSession;
		const wokenSession = {
			sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
			isStreaming: true,
			runStartedAt: 1,
		} as unknown as AgentSession;
		const registry = AgentRegistry.global();
		registry.register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: mainSession,
			sessionFile: rootSessionFile,
		});
		registry.register({ id, displayName: "sub", kind: "sub", parentId: "Main", session: wokenSession });

		const handler = new AgentProtocolHandler();
		const url = `agent://${id}`;
		const whileRunning = await handler.resolve(parseInternalUrl(url));
		expect(whileRunning.content.endsWith(published)).toBe(true);
		expect(whileRunning.content).not.toBe(published);
		const notice = whileRunning.notes?.[0];
		if (!notice) throw new Error("The newer turn did not mark the previous output");
		// `read` reads a located file directly, skipping resolve(): a superseded
		// output must route as a resource so the banner reaches the reader.
		const router = InternalUrlRouter.instance();
		expect((await router.target(url))?.kind).toBe("resource");
		// JSON-path reads stay machine-parseable.
		const field = await handler.resolve(parseInternalUrl(`${url}/status`));
		expect(field.content).toBe("partial");
		const queried = await handler.resolve(parseInternalUrl(`${url}?q=.status`));
		expect(queried.content).toBe("partial");
		expect(field.notes).toContain(notice);
		expect(queried.notes).toContain(notice);
		const reader = new ReadTool({
			cwd: root,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => rootSessionFile,
			getSessionSpawns: () => "*",
		});
		for (const extractedUrl of [`${url}/status`, `${url}?q=.status`]) {
			const output = await reader.execute("superseded-output", { path: extractedUrl });
			expect(output.content[0]).toEqual({ type: "text", text: "partial" });
			expect(output.details?.notes).toContain(notice);
			expect(
				output.content
					.slice(1)
					.map(block => (block.type === "text" ? block.text : ""))
					.join("\n"),
			).toContain(notice);
		}
		const extractedArgs = { path: `${url}?q=.` };
		const extracted = bridgeValueFromToolResult(
			"read",
			extractedArgs,
			await reader.execute("superseded-json", extractedArgs),
		);
		if (typeof extracted === "string" || !("text" in extracted) || typeof extracted.text !== "string") {
			throw new Error("Expected structured read metadata");
		}
		expect(JSON.parse(extracted.text)).toEqual({ status: "partial", summary: "run budget ran out" });

		// Once the turn ends, the file is the current result again.
		registry.setStatus(id, "idle");
		const settled = await handler.resolve(parseInternalUrl(url));
		expect(settled.content).toBe(published);
		expect((await router.target(url))?.kind).toBe("file");

		const scopedRegistry = new AgentRegistry();
		scopedRegistry.register({ id, displayName: "scoped", kind: "sub", parentId: "Main", session: wokenSession });
		const context = {
			session: {
				cwd: root,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => rootSessionFile,
				getSessionSpawns: () => "*",
				agentRegistry: scopedRegistry,
			} satisfies ToolSession,
		};
		expect(await handler.locate(parseInternalUrl(url), context)).toBeNull();
		expect((await handler.resolve(parseInternalUrl(url), context)).notes).toEqual(whileRunning.notes);
	},
);
