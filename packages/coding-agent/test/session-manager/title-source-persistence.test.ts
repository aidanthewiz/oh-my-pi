import { createHash, type Hash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	SESSION_TITLE_SLOT_BYTES,
	type SessionHeader,
	TITLE_CHANGE_ENTRY_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	admitTitleCard,
	serializeTitleSlot,
	parseTitleSlotFromContent,
	titleFitsSlot,
	type SessionTitleUpdate,
} from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

import { makeAssistantMessage } from "./helpers";

function parseJsonLine(line: string): Record<string, unknown> {
	return JSON.parse(line) as Record<string, unknown>;
}

function readRawLines(filePath: string): string[] {
	return fs.readFileSync(filePath, "utf8").trimEnd().split("\n");
}

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(entry): entry is SessionHeader =>
			typeof entry === "object" && entry !== null && "type" in entry && entry.type === "session",
	);
}

describe("session title source persistence", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-title-source-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		// Title changes open history.db under testAgentDir; Windows cannot delete an open file.
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	it("persists auto title source across reopen", async () => {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName("Auto title", "auto");
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		const entries = await loadEntriesFromFile(sessionFile!);
		expect(getHeader(entries)?.titleSource).toBe("auto");
		const rawLines = readRawLines(sessionFile!);
		expect(Buffer.byteLength(`${rawLines[0]}\n`, "utf8")).toBe(SESSION_TITLE_SLOT_BYTES);
		expect(parseJsonLine(rawLines[0])).toMatchObject({
			type: "title",
			v: 1,
			title: "Auto title",
			source: "auto",
		});
		expect(parseJsonLine(rawLines[1]).type).toBe("session");
		const reopened = await SessionManager.open(sessionFile!);
		expect(reopened.getSessionName()).toBe("Auto title");
		expect(reopened.titleSource).toBe("auto");
		await reopened.close();
		await session.close();
	});

	it("loads legacy slotless files with header titles", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const file = path.join(sessionDir, "legacy.jsonl");
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "legacy-session",
			title: "Legacy title",
			titleSource: "user",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		};
		fs.writeFileSync(file, `${JSON.stringify(header)}\n`);

		const entries = await loadEntriesFromFile(file);
		expect(getHeader(entries)?.title).toBe("Legacy title");
		expect(getHeader(entries)?.titleSource).toBe("user");

		const reopened = await SessionManager.open(file);
		expect(reopened.getSessionName()).toBe("Legacy title");
		expect(reopened.titleSource).toBe("user");
		await reopened.close();
	});

	it("renames slotted sessions by updating the fixed title slot and appending an audit entry", async () => {
		const storage = new FileSessionStorage();
		const session = SessionManager.create(cwd, undefined, storage);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName("Auto title", "auto", "initial");
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();

		await session.setSessionName("Manual title", "user", "rename");
		await session.flush();

		const rawLines = readRawLines(sessionFile!);
		expect(parseJsonLine(rawLines[0])).toMatchObject({
			type: "title",
			title: "Manual title",
			source: "user",
		});
		expect(parseJsonLine(rawLines[1]).type).toBe("session");

		const entries = await loadEntriesFromFile(sessionFile!);
		expect(getHeader(entries)?.title).toBe("Manual title");
		const titleChanges = entries.filter(entry => entry.type === TITLE_CHANGE_ENTRY_TYPE);
		expect(titleChanges.map(entry => entry.title)).toEqual(["Auto title", "Manual title"]);
		expect(titleChanges.map(entry => entry.trigger)).toEqual(["initial", "rename"]);
		await session.close();
	});

	it("notifies name-change subscribers only after successful applied names", async () => {
		const session = SessionManager.inMemory(cwd);
		const names: Array<string | undefined> = [];
		const unsubscribe = session.onSessionNameChanged(() => {
			names.push(session.getSessionName());
		});

		try {
			await expect(session.setSessionName("   ", "user")).resolves.toBe(false);
			expect(names).toEqual([]);

			await expect(session.setSessionName("Manual title", "user")).resolves.toBe(true);
			expect(names).toEqual(["Manual title"]);

			await expect(session.setSessionName("Ignored auto title", "auto")).resolves.toBe(false);
			expect(names).toEqual(["Manual title"]);
		} finally {
			unsubscribe();
		}

		await expect(session.setSessionName("Second title", "user")).resolves.toBe(true);
		expect(names).toEqual(["Manual title"]);
	});

	it("identifies its overflow publication if a peer replaces the file before the write resolves", async () => {
		class ReplacedAfterPublishStorage extends FileSessionStorage {
			published = "";
			override async writeTextAtomic(
				file: string,
				content: string,
				options?: WriteTextAtomicOptions,
			): Promise<void> {
				await super.writeTextAtomic(file, content, options);
				this.published = content;
				fs.writeFileSync(file, "peer replacement\n");
			}
		}
		const storage = new ReplacedAfterPublishStorage();
		const update = { title: "Original", source: "auto" as const, updatedAt: "2026-01-01T00:00:00.000Z" };
		const file = path.join(testAgentDir, "replaced-overflow.jsonl");
		const content =
			serializeTitleSlot(update) +
			JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "replaced-overflow",
				cwd,
				timestamp: update.updatedAt,
				title: update.title,
				titleSource: update.source,
				titleUpdatedAt: update.updatedAt,
			}) +
			"\n";
		fs.writeFileSync(file, content);
		const fingerprint = await storage.updateSessionTitle(file, { ...update, title: "界".repeat(150) });
		expect(fingerprint.digest("hex")).toBe(createHash("sha1").update(storage.published).digest("hex"));
		expect(fs.readFileSync(file, "utf8")).toBe("peer replacement\n");
	});

	const card = { code: "CACHE", emoji: "🧪", nf: "nf-md-flask" };

	it.each(["file", "memory"] as const)(
		"roundtrips and clears a bound tuple on same-title manual replacement (%s)",
		async kind => {
			const storage = kind === "file" ? new FileSessionStorage() : new MemorySessionStorage();
			const manager = SessionManager.create(cwd, path.join(testAgentDir, "sessions"), storage);
			await manager.ensureOnDisk();
			await manager.setSessionName("Repair cache", "auto", undefined, card);
			const updatedAt = manager.titleUpdatedAt;
			await manager.flush();
			const file = manager.getSessionFile()!;
			const physical = await storage.readText(file);
			expect(Buffer.byteLength(physical.split("\n")[0] + "\n", "utf8")).toBe(256);
			const expectedKey = createHash("sha256")
				.update(JSON.stringify(["Repair cache", "auto", updatedAt]))
				.digest("hex")
				.slice(0, 16);
			expect(parseTitleSlotFromContent(physical)?.card).toEqual({ ...card, key: expectedKey });
			const exposed = manager.getSessionTitleCard()!;
			exposed.code = "OTHER";
			expect(manager.getSessionTitleCard()).toEqual(card);
			await manager.close();
			const reopened = await SessionManager.open(file, undefined, storage);
			try {
				expect(reopened.getSessionName()).toBe("Repair cache");
				expect(reopened.titleUpdatedAt).toBe(updatedAt);
				expect(reopened.getSessionTitleCard()).toEqual(card);
				await reopened.setSessionName("Repair cache", "user");
				expect(reopened.getSessionTitleCard()).toBeUndefined();
				expect(await reopened.setSessionName("Generated replacement", "auto", undefined, card)).toBe(false);
				expect(reopened.getSessionName()).toBe("Repair cache");
			} finally {
				await reopened.close();
			}
			const cold = await SessionManager.open(file, undefined, storage);
			try {
				expect(cold.getSessionName()).toBe("Repair cache");
				expect(cold.getSessionTitleCard()).toBeUndefined();
				expect(cold.titleSource).toBe("user");
			} finally {
				await cold.close();
			}
		},
	);

	it("omits metadata whole at UTF8 boundaries without truncating fitting or overlong names", async () => {
		const updatedAt = "2026-01-01T00:00:00.000Z";
		const empty = { title: "", source: "auto" as const, updatedAt };
		const budget = parseTitleSlotFromContent(serializeTitleSlot(empty))!.pad.length;
		for (const title of ["界".repeat(35), "x".repeat(budget), "x".repeat(budget + 1), "界".repeat(150)]) {
			const update = { title, source: "auto" as const, updatedAt };
			const physical = serializeTitleSlot({ ...update, card: admitTitleCard(update, card) });
			expect(Buffer.byteLength(physical, "utf8")).toBe(256);
			expect(parseTitleSlotFromContent(physical)?.card).toBeUndefined();
			const slot = parseTitleSlotFromContent(physical)!;
			if (titleFitsSlot(update)) {
				expect(slot.title).toBe(title);
				expect(slot.ref).toBeUndefined();
			} else {
				expect(slot.title).toBe("");
				expect(slot.ref).toMatch(/^[0-9a-f]{16}$/);
			}
			const manager = SessionManager.create(cwd);
			await manager.ensureOnDisk();
			await manager.setSessionName(title, "auto", undefined, card);
			const file = manager.getSessionFile()!;
			await manager.close();
			const reopened = await SessionManager.open(file);
			try {
				expect(reopened.getSessionName()).toBe(title);
				expect(reopened.getSessionTitleCard()).toBeUndefined();
			} finally {
				await reopened.close();
			}
		}
	});

	it("takes metadata only from the winning container and exact tuple", async () => {
		const updatedAt = "2026-01-01T00:00:00.000Z";
		const valid = { title: "Old name", source: "auto" as const, updatedAt };
		const titleCard = admitTitleCard(valid, card)!;
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "bound-title",
			timestamp: updatedAt,
			cwd,
			title: valid.title,
			titleSource: valid.source,
			titleUpdatedAt: updatedAt,
			titleCard,
		};
		const staleSlot = JSON.parse(serializeTitleSlot({ title: "Winner", source: "user", updatedAt }));
		staleSlot.card = titleCard;
		staleSlot.pad = "";
		staleSlot.pad = " ".repeat(256 - Buffer.byteLength(JSON.stringify(staleSlot) + "\n", "utf8"));
		const cases = [
			{ label: "header-only", header, slot: "", title: "Old name", card },
			{
				label: "stale-header",
				header,
				slot: serializeTitleSlot({ title: "Winner", source: "user", updatedAt }),
				title: "Winner",
				card: undefined,
			},
			{ label: "stale-slot", header, slot: JSON.stringify(staleSlot) + "\n", title: "Winner", card: undefined },
			{
				label: "mismatched-header",
				header: { ...header, title: "Changed name" },
				slot: "",
				title: "Changed name",
				card: undefined,
			},
			{
				label: "mismatched-time",
				header: { ...header, titleUpdatedAt: "2026-01-02T00:00:00.000Z" },
				slot: "",
				title: "Old name",
				card: undefined,
			},
			{
				label: "mismatched-source",
				header: { ...header, titleSource: "user" },
				slot: "",
				title: "Old name",
				card: undefined,
			},
			{
				label: "malformed-card",
				header: { ...header, titleCard: { ...titleCard, code: "INVALID" } },
				slot: "",
				title: "Old name",
				card: undefined,
			},
		];
		for (const item of cases) {
			const file = path.join(testAgentDir, item.label + ".jsonl");
			fs.writeFileSync(file, item.slot + JSON.stringify(item.header) + "\n");
			for (let pass = 0; pass < 3; pass++) {
				const manager = await SessionManager.open(file);
				try {
					expect(manager.getSessionName()).toBe(item.title);
					expect(manager.getSessionTitleCard()).toEqual(item.card);
					await manager.flush();
				} finally {
					await manager.close();
				}
			}
		}
	});

	it("rejects an overflow reference attached to a different header tuple", async () => {
		const update = { title: "界".repeat(150), source: "user" as const, updatedAt: "2026-01-01T00:00:00.000Z" };
		for (const changed of [
			{ title: update.title + "x" },
			{ titleSource: "auto" },
			{ titleUpdatedAt: "2026-01-02T00:00:00.000Z" },
		]) {
			const file = path.join(testAgentDir, "overflow.jsonl");
			fs.writeFileSync(
				file,
				serializeTitleSlot(update) +
					JSON.stringify({
						type: "session",
						version: CURRENT_SESSION_VERSION,
						id: "overflow",
						cwd,
						timestamp: update.updatedAt,
						title: update.title,
						titleSource: update.source,
						titleUpdatedAt: update.updatedAt,
						...changed,
					}) +
					"\n",
			);
			const manager = await SessionManager.open(file);
			try {
				expect(manager.getSessionName()).toBeUndefined();
				expect(manager.getSessionTitleCard()).toBeUndefined();
			} finally {
				await manager.close();
			}
		}
	});

	it("does not announce or persist new metadata after a title write and its repair fail", async () => {
		class FailingStorage extends FileSessionStorage {
			fail = false;
			override async updateSessionTitle(file: string, update: SessionTitleUpdate): Promise<Hash> {
				if (this.fail) throw new Error("synthetic title write failure");
				return super.updateSessionTitle(file, update);
			}
			override async writeTextAtomic(
				file: string,
				content: string,
				options?: WriteTextAtomicOptions,
			): Promise<void> {
				if (this.fail) throw new Error("synthetic repair failure");
				return super.writeTextAtomic(file, content, options);
			}
		}
		const storage = new FailingStorage();
		const manager = SessionManager.create(cwd, undefined, storage);
		await manager.ensureOnDisk();
		await manager.setSessionName("Durable old title", "auto", undefined, card);
		const file = manager.getSessionFile()!;
		const observed: string[] = [];
		const unsubscribe = manager.onSessionNameChanged(() => observed.push(manager.getSessionName()!));
		storage.fail = true;
		try {
			await expect(
				manager.setSessionName("Unconfirmed title", "user", undefined, { code: "NEW", emoji: "🔥" }),
			).rejects.toThrow();
			expect(observed).toEqual([]);
			const disk = parseTitleSlotFromContent(await storage.readText(file))!;
			expect(disk.title).toBe("Durable old title");
			expect(disk.card?.code).toBe("CACHE");
		} finally {
			unsubscribe();
			storage.fail = false;
			await expect(manager.close()).rejects.toThrow();
		}
	});
});
