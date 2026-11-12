import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import { INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import { DeferredDiagnostics } from "@oh-my-pi/pi-coding-agent/lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics-ledger";
import type { LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { EquivalentUriMap, fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import type { DeferredDiagnosticsEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { NativeChild } from "@oh-my-pi/pi-tui/native/node";
import { formatDiagnostics } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { FileDiagnosticsResult } from "@oh-my-pi/pi-tui/tools/lsp";
import { diagnosticsBadge, diagnosticsSection } from "@oh-my-pi/pi-tui/tools/native-view";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { type ptree, TempDir } from "@oh-my-pi/pi-utils";

const SERVER_NAME = "synthetic-unreported";
const SERVER: ServerConfig = { command: SERVER_NAME, fileTypes: ["ts"], rootMarkers: [] };
const MISSING = `no diagnostics report yet from ${SERVER_NAME}`;
const OLD = "a.ts:1:1 [error] old issue";
const NEW = "a.ts:2:1 [warning] new issue";
let theme: Theme;

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "dark", "light");
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("dark theme missing");
	theme = loaded;
});

function result(messages: string[], unreported?: string[]): FileDiagnosticsResult {
	return {
		messages,
		errored: messages.some(message => message.includes("[error]")),
		summary: unreported?.length ? `reported; no diagnostics report yet from ${unreported.join(", ")}` : "reported",
		unreported,
	};
}

function nativeText(children: readonly NativeChild[] | undefined): string {
	const text: string[] = [];
	for (const child of children ?? []) {
		if (!("k" in child)) continue;
		const spans = child.p && "spans" in child.p ? child.p.spans : undefined;
		if (Array.isArray(spans)) text.push(spans.map(span => span.t).join(""));
		text.push(nativeText(child.c));
	}
	return text.join("\n");
}

function installTransport(cwd: string): void {
	let now = Date.now();
	const inlineWaiters: Array<{ at: number; resolve: () => void }> = [];
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.spyOn(Bun, "sleep").mockImplementation(((ms: number) => {
		if (ms === INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS) {
			const timeout = Promise.withResolvers<void>();
			inlineWaiters.push({ at: now + ms, resolve: timeout.resolve });
			return timeout.promise;
		}
		now += ms;
		for (let i = inlineWaiters.length - 1; i >= 0; i--) {
			if (inlineWaiters[i]!.at <= now) inlineWaiters.splice(i, 1)[0]!.resolve();
		}
		return Promise.resolve();
	}) as typeof Bun.sleep);
	const client: LspClient = {
		name: SERVER_NAME,
		cwd,
		config: SERVER,
		proc: {} as ptree.ChildProcess<"pipe">,
		requestId: 0,
		diagnostics: new EquivalentUriMap(),
		publishedDiagnostics: new EquivalentUriMap(),
		pulledDiagnostics: new EquivalentUriMap(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		isReading: false,
		status: "ready",
		serverCapabilities: {},
		lastActivity: now,
		startedAt: now - 60_000,
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
	vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
	vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([[SERVER_NAME, SERVER]]);
	vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
	vi.spyOn(lspClient, "getActiveOrPendingClient").mockResolvedValue(undefined);
	vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();
	vi.spyOn(lspClient, "syncContent").mockImplementation(async (target, filePath) => {
		const uri = fileToUri(filePath);
		target.diagnostics.delete(uri);
		target.pulledDiagnostics.delete(uri);
		target.openFiles.set(uri, {
			version: (target.openFiles.get(uri)?.version ?? 0) + 1,
			languageId: "typescript",
			lastUsedAt: now,
		});
	});
	vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
}

describe("unreported diagnostics consumers", () => {
	let dir: TempDir;
	let session: ToolSession;
	beforeEach(() => {
		dir = TempDir.createSync("@omp-unreported-consumers-");
		session = {
			cwd: dir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			enableLsp: true,
			settings: Settings.isolated({
				"lsp.formatOnWrite": true,
				"lsp.diagnosticsOnWrite": true,
				"lsp.diagnosticsOnEdit": true,
				"lsp.diagnosticsDeduplicate": true,
			}),
		};
	});
	afterEach(() => {
		vi.restoreAllMocks();
		dir.removeSync();
	});

	it("LSP-U01 preserves missing diagnostic coverage in a successful real write's model result", async () => {
		installTransport(dir.path());
		const filePath = path.join(dir.path(), "write.ts");
		const written = await wrapToolWithMetaNotice(new WriteTool(session)).execute("missing-write", {
			path: filePath,
			content: "export const value = 1;\n",
		});
		expect(await Bun.file(filePath).text()).toBe("export const value = 1;\n");
		expect(written.isError).not.toBe(true);
		expect(written.details?.diagnostics).toMatchObject({ messages: [], errored: false, unreported: [SERVER_NAME] });
		expect(
			written.content
				.filter(item => item.type === "text")
				.map(item => item.text)
				.join("\n"),
		).toContain(MISSING);
	});

	it("LSP-U02 keeps a genuine empty versioned report clean", async () => {
		installTransport(dir.path());
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async (client, filePath) => {
			const uri = fileToUri(filePath);
			const report = { diagnostics: [], version: client.openFiles.get(uri)!.version };
			client.publishedDiagnostics.set(uri, report);
			client.diagnostics.set(uri, report);
			client.publishesDocumentVersions = true;
			client.diagnosticsVersion++;
		});
		const written = await wrapToolWithMetaNotice(new WriteTool(session)).execute("clean-write", {
			path: path.join(dir.path(), "clean.ts"),
			content: "export const clean = true;\n",
		});
		expect(await Bun.file(path.join(dir.path(), "clean.ts")).text()).toBe("export const clean = true;\n");
		expect(written.isError).not.toBe(true);
		expect(written.details?.diagnostics).toMatchObject({ messages: [], summary: "OK", errored: false });
		expect(written.details?.diagnostics?.unreported).toBeUndefined();
		expect(written.details?.meta).toBeUndefined();
		expect(diagnosticsSection(written.details?.diagnostics)).toBeUndefined();
		expect(diagnosticsBadge([written.details?.diagnostics])).toBeUndefined();
		expect(
			written.content
				.filter(item => item.type === "text")
				.map(item => item.text)
				.join("\n"),
		).not.toContain(MISSING);
	});

	it.each([1, 2])("LSP-U03-%i preserves missing-report notices in a real native edit", async count => {
		installTransport(dir.path());
		const input = [
			"*** Begin Patch",
			...Array.from({ length: count }, (_, i) => `*** Add File: file${i}.ts\n+export const value${i} = ${i};`),
			"*** End Patch",
		].join("\n");
		const edited = await wrapToolWithMetaNotice(new EditTool(session, "apply_patch")).execute("missing-edit", {
			input,
		});
		expect(edited.isError).not.toBe(true);
		for (let i = 0; i < count; i++) {
			expect(await Bun.file(path.join(dir.path(), `file${i}.ts`)).text()).toBe(`export const value${i} = ${i};\n`);
		}
		const files = edited.details?.perFileResults ?? [edited.details];
		for (const file of files) {
			expect(file?.diagnostics).toMatchObject({ messages: [], errored: false, unreported: [SERVER_NAME] });
		}
		expect(
			edited.content
				.filter(item => item.type === "text")
				.map(item => item.text)
				.join("\n"),
		).toContain(MISSING);
	});

	it("LSP-U04 displays unknown coverage as a native warning, not a reported code error", () => {
		const diagnostics = result([], [SERVER_NAME]);
		const section = diagnosticsSection(diagnostics);
		expect(nativeText(section ? [section] : [])).toContain(MISSING);
		expect(section?.p).toMatchObject({ tone: "warning" });
		expect(diagnosticsBadge([diagnostics])).toMatchObject({ tone: "warning" });
		expect(diagnosticsBadge([diagnostics])?.text).not.toContain("1 diagnostic");
	});

	it.each([false, true])("LSP-U05-%s displays missing coverage in the legacy view", expanded => {
		expect(Bun.stripANSI(formatDiagnostics(result([], [SERVER_NAME]), expanded, theme, () => ""))).toContain(MISSING);
	});

	it("LSP-U06 retains mixed coverage while suppressing only previously seen messages", () => {
		const ledger = getDiagnosticsLedger(session);
		const file = path.join(dir.path(), "a.ts");
		ledger.reduce(file, result([OLD]));
		const reduced = ledger.reduce(file, result([OLD, NEW], [SERVER_NAME]));
		expect(reduced.messages).toEqual([NEW]);
		expect(reduced.errored).toBe(false);
		expect(reduced.summary).toContain(MISSING);
		const notice = formatOutputNotice({ diagnostics: reduced });
		expect(notice).toContain(MISSING);
		expect(notice).toContain("new issue");
		expect(notice).not.toContain("old issue");
	});

	it("LSP-U07 does not treat an unanswered round as recovery of a seen diagnostic", () => {
		const ledger = getDiagnosticsLedger(session);
		const file = path.join(dir.path(), "a.ts");
		ledger.reduce(file, result([OLD]));
		ledger.reduce(file, result([], [SERVER_NAME]));
		expect(ledger.reduce(file, result([OLD])).messages).toEqual([]);
		ledger.reduce(file, { messages: [], summary: "OK", errored: false });
		expect(ledger.reduce(file, result([OLD])).messages).toEqual([OLD]);
	});

	it("LSP-U08 queues mixed deferred coverage after all reported messages deduplicate and expires it on mutation", () => {
		const queued: DeferredDiagnosticsEntry[] = [];
		session.queueDeferredDiagnostics = entry => queued.push(entry);
		const file = path.join(dir.path(), "a.ts");
		getDiagnosticsLedger(session).reduce(file, result([OLD]));
		const deferred = new DeferredDiagnostics(session);
		const handle = deferred.begin(file);
		handle.finalize(undefined);
		handle.onDeferredDiagnostics(result([OLD], [SERVER_NAME]));
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({ path: file, messages: [], errored: false });
		expect(queued[0]!.summary).toContain(MISSING);
		expect(queued[0]!.isStale()).toBe(false);
		const next = deferred.begin(file);
		next.finalize(undefined);
		next.onDeferredDiagnostics(result([OLD]));
		expect(queued).toHaveLength(1);
		expect(queued[0]!.isStale()).toBe(true);
	});

	it("LSP-U09 keeps missing coverage visible when native diagnostic rows are capped", () => {
		const diagnostics = result(
			Array.from({ length: 7 }, (_, i) => `a.ts:${i + 1}:1 [warning] issue${i}`),
			[SERVER_NAME],
		);
		const section = diagnosticsSection(diagnostics);
		const text = nativeText(section ? [section] : []);
		expect(text).toContain("issue0");
		expect(text).not.toContain("issue6");
		expect(text).toContain(MISSING);
	});

	it("LSP-U10 preserves an unreported-only warning through the existing output-notice consumer", () => {
		expect(formatOutputNotice({ diagnostics: result([], [SERVER_NAME]) })).toContain(MISSING);
		expect(formatOutputNotice({ diagnostics: result([], []) })).toBe("");
	});
});
