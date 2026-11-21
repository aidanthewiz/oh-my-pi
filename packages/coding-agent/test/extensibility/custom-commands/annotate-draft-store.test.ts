import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	annotationDraftKey,
	loadAnnotationDrafts,
	openAnnotationDraft,
} from "../../../src/extensibility/custom-commands/bundled/annotate/draft-store";
import { createResolvedReviewTarget } from "../../../src/extensibility/custom-commands/bundled/review/target";
import {
	findMostRecentNonEmptySession,
	isEmptySession,
	listAllSessionsForPicker,
	listSessions,
	listSessionsForPicker,
} from "../../../src/session/session-listing";
import { SessionManager } from "../../../src/session/session-manager";
import { FileSessionStorage } from "../../../src/session/session-storage";

const DIFF = `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

describe("annotation drafts", () => {
	it("restores a persisted diff line note and removes it after review", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-drafts-");
		const session = {
			getArtifactsDir: () => tempDir.path(),
			getSessionId: () => "s1",
			ensureOnDisk: async () => {},
		};
		const target = createResolvedReviewTarget("uncommitted", "Uncommitted changes", DIFF, "No changes");
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme unavailable");
		const makeOverlay = () =>
			new AnnotationOverlay(
				{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
				theme,
				KeybindingsManager.inMemory(),
				target.snapshot.files,
				target.mode,
				{ onComplete() {} },
			);
		const overlay = makeOverlay();
		const restored = makeOverlay();
		try {
			overlay.restoreDraft({
				kind: "diff",
				annotations: [],
				editor: { fileIndex: 0, sourceIndex: 1, scope: "line", text: "unfinished" },
			});
			const first = await openAnnotationDraft(session, { kind: "diff", target });
			try {
				first.restore(overlay);
			} finally {
				await first.close(undefined);
			}
			const directory = path.join(tempDir.path(), "annotation-drafts", "s1");
			const [file] = await fs.readdir(directory);
			expect(
				JSON.parse(await fs.readFile(path.join(directory, file!), "utf8")).source.target.snapshot,
			).toBeUndefined();
			expect((await loadAnnotationDrafts(session))[0]?.source).toEqual({ kind: "diff", target });
			const second = await openAnnotationDraft(session, { kind: "diff", target });
			try {
				second.restore(restored);
				restored.handleInput("\r");
				expect(restored.getAnnotations()).toEqual([
					{
						scope: "line",
						path: "src/value.ts",
						oldPath: "src/value.ts",
						newPath: "src/value.ts",
						occurrence: 1,
						hunkHeader: "@@ -1 +1 @@",
						newLine: 1,
						rawLine: "+export const value = 2;",
						note: "unfinished",
					},
				]);
			} finally {
				await second.close({ action: "review" });
			}
			expect(await loadAnnotationDrafts(session)).toEqual([]);
		} finally {
			overlay.dispose();
			restored.dispose();
		}
	});

	it("discovers only the owning annotation-only session and observes removal without transcript changes", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-discovery-");
		const bucket = path.join(tempDir.path(), "bucket");
		const storage = new FileSessionStorage();
		let other: SessionManager | undefined;
		let sessionClosed = false;
		let otherClosed = false;
		const source = {
			kind: "text",
			source: { id: "p", kind: "prompt", label: "Prompt", text: "frozen source" },
		} as const;
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("dark theme unavailable");
		const overlay = new AnnotationOverlay(
			{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
			theme,
			KeybindingsManager.inMemory(),
			source.source,
			{ onComplete() {} },
		);
		const session = SessionManager.create(tempDir.path(), bucket, storage);
		try {
			overlay.handleInput("A");
			overlay.handleInput("recover this work");
			const draft = await openAnnotationDraft(session, source);
			try {
				draft.restore(overlay);
			} finally {
				await draft.close(undefined);
			}
			await session.close();
			sessionClosed = true;
			const file = session.getSessionFile()!;
			const transcript = await fs.readFile(file, "utf8");
			const local = await listSessions(bucket, storage);
			expect(local[0]?.messageCount).toBe(0);
			expect((await (await listSessionsForPicker(bucket, storage, new Set())).complete).map(row => row.id)).toEqual([
				session.getSessionId(),
			]);
			expect(
				(await (await listAllSessionsForPicker(storage, new Set(), tempDir.path())).complete).map(row => row.id),
			).toEqual([session.getSessionId()]);
			expect(await findMostRecentNonEmptySession(bucket, storage)).toBe(file);

			other = SessionManager.create(tempDir.path(), bucket, storage);
			await other.ensureOnDisk();
			await fs.cp(session.getArtifactsDir()!, other.getArtifactsDir()!, { recursive: true });
			await other.close();
			otherClosed = true;
			const foreign = (await listSessions(bucket, storage)).find(row => row.id === other!.getSessionId());
			expect(foreign).toBeDefined();
			expect(isEmptySession(foreign!)).toBe(true);
			expect(await loadAnnotationDrafts(other)).toEqual([]);

			const resumed = await openAnnotationDraft(session, source);
			try {
				resumed.restore(overlay);
				expect(overlay.getDraft()).toMatchObject({ editor: { text: "recover this work" } });
			} finally {
				await resumed.close({ action: "review" });
			}
			expect(await (await listSessionsForPicker(bucket, storage, new Set())).complete).toEqual([]);
			expect(await findMostRecentNonEmptySession(bucket, storage)).toBeNull();
			expect(await fs.readFile(file, "utf8")).toBe(transcript);
		} finally {
			overlay.dispose();
			await Promise.all([
				...(!sessionClosed ? [session.close()] : []),
				...(other && !otherClosed ? [other.close()] : []),
			]);
		}
	});

	it("skips a draft whose state cannot be replayed", async () => {
		using tempDir = TempDir.createSync("@pi-annotation-drafts-");
		const session = {
			getArtifactsDir: () => tempDir.path(),
			getSessionId: () => "s1",
			ensureOnDisk: async () => {},
		};
		const source = { kind: "text", source: { id: "p", kind: "prompt", label: "P", text: "x" } } as const;
		const key = annotationDraftKey(source);
		const file = path.join(tempDir.path(), "annotation-drafts", "s1", `draft-${key}.json`);
		await Bun.write(file, JSON.stringify({ key, updatedAt: 1, source, state: null }));
		expect(await loadAnnotationDrafts(session)).toEqual([]);
	});
});
