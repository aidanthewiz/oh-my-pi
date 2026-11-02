import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTitleIcons } from "@oh-my-pi/pi-coding-agent/utils/title-settings";
import { admitTitleCard, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { getRecentSessions, readSessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { closeSessionIndex, recordSessionTitle } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "../session-manager/helpers";

describe("recent session title presentation", () => {
	let testAgentDir: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recent-titles-"));
		cwd = path.join(testAgentDir, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(testAgentDir);
		closeSessionIndex();
	});

	afterEach(() => {
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	async function createTitledSession(title: string): Promise<{ sessionDir: string; sessionFile: string }> {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.setSessionName(title, "user");
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("session did not materialize");
		await session.close();
		return { sessionDir: path.dirname(sessionFile), sessionFile };
	}

	it("uses current preferences and the persisted winner instead of stale indexed text", async () => {
		const { sessionDir, sessionFile } = await createTitledSession("Old indexed name");
		const manager = await SessionManager.open(sessionFile);
		let id: string;
		try {
			id = manager.getSessionId();
			await manager.setSessionName("Winner", "user", undefined, {
				code: "CARD",
				emoji: "🧪",
				nf: "nf-md-flask",
			});
		} finally {
			await manager.close();
		}
		recordSessionTitle(id!, "Stale indexed name");
		const settings = Settings.isolated({ "title.icons": "emoji" });
		const emoji = await withActiveSettings(settings, () => getRecentSessions(sessionDir));
		expect(emoji.map(item => item.name)).toEqual(["🧪 CARD: Winner"]);
		const info = await readSessionInfo(sessionFile);
		expect(info?.title).toBe("Winner");
		expect(withActiveSettings(settings, () => info?.titlePresentation?.())).toBe("🧪 CARD: Winner");
		if (!info?.titleCard) throw new Error("Session card was not loaded");
		info.titleCard.emoji = "🔥";
		const cached = await readSessionInfo(sessionFile);
		expect(withActiveSettings(settings, () => cached?.titlePresentation?.())).toBe("🧪 CARD: Winner");
		cfgTitleIcons.override(settings, "boring");
		const boring = await withActiveSettings(settings, () => getRecentSessions(sessionDir));
		expect(boring.map(item => item.name)).toEqual(["Winner"]);
		expect(boring[0].path).toBe(sessionFile);
		expect(withActiveSettings(settings, () => info?.titlePresentation?.())).toBe("Winner");
	});

	it("does not resurrect an indexed name after the authoritative container disappears", async () => {
		const { sessionDir, sessionFile } = await createTitledSession("Indexed title");
		fs.truncateSync(sessionFile, 0);
		expect(await getRecentSessions(sessionDir)).toEqual([]);
	});

	it("does not borrow header metadata when a plain slot wins", async () => {
		const { sessionDir, sessionFile } = await createTitledSession("Original");
		const manager = await SessionManager.open(sessionFile);
		try {
			await manager.setSessionName("Card title", "user", undefined, { code: "CARD", emoji: "🧪" });
		} finally {
			await manager.close();
		}
		const content = fs.readFileSync(sessionFile, "utf8");
		const header = JSON.parse(content.split("\n")[1]!);
		header.title = "Card title";
		header.titleSource = "user";
		header.titleUpdatedAt = "2025-01-01T00:00:00.000Z";
		header.titleCard = admitTitleCard(
			{ title: header.title, source: "user", updatedAt: header.titleUpdatedAt },
			{ code: "CARD", emoji: "🧪" },
		);
		const updatedAt = "2025-01-02T00:00:00.000Z";
		fs.writeFileSync(
			sessionFile,
			serializeTitleSlot({ title: "Card title", source: "user", updatedAt }) +
				JSON.stringify(header) +
				"\n" +
				content.split("\n").slice(2).join("\n"),
		);
		const settings = Settings.isolated({ "title.icons": "emoji" });
		const recent = await withActiveSettings(settings, () => getRecentSessions(sessionDir));
		expect(recent.map(item => item.name)).toEqual(["Card title"]);
	});

	it("keeps an overflow title whose header exceeds the listing prefix", async () => {
		const title = "界".repeat(1800);
		const { sessionDir, sessionFile } = await createTitledSession(title);
		const recent = await getRecentSessions(sessionDir);
		expect(recent.map(item => item.name)).toEqual([title]);
		expect(recent[0].path).toBe(sessionFile);
	});

	it("keeps the winning slot card after shortening an overflow title", async () => {
		const { sessionDir, sessionFile } = await createTitledSession("界".repeat(1800));
		const manager = await SessionManager.open(sessionFile);
		try {
			await manager.setSessionName("Short", "user", undefined, { code: "FIX", emoji: "🧪" });
		} finally {
			await manager.close();
		}
		const settings = Settings.isolated({ "title.icons": "emoji" });
		const recent = await withActiveSettings(settings, () => getRecentSessions(sessionDir));
		expect(recent.map(item => item.name)).toEqual(["🧪 FIX: Short"]);
		const info = await readSessionInfo(sessionFile);
		expect(info?.title).toBe("Short");
		expect(withActiveSettings(settings, () => info?.titlePresentation?.())).toBe("🧪 FIX: Short");
	});

	it("uses the registered presentation default without a matching settings scope", async () => {
		const { sessionDir, sessionFile } = await createTitledSession("Other project");
		const manager = await SessionManager.open(sessionFile);
		try {
			await manager.setSessionName("Other project", "user", undefined, { code: "OTHER", emoji: "🧪" });
		} finally {
			await manager.close();
		}
		const recent = await getRecentSessions(sessionDir);
		expect(recent.map(item => item.name)).toEqual(["🧪 OTHER: Other project"]);
	});

	it("reads a legacy header title without requiring an index row", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const id = Bun.randomUUIDv7();
		const legacyFile = path.join(sessionDir, `2024-01-01T00-00-00-000Z_${id}.jsonl`);
		const header = {
			type: "session",
			version: 4,
			id,
			timestamp: "2024-01-01T00:00:00.000Z",
			cwd,
			title: "Legacy title",
		};
		fs.writeFileSync(legacyFile, `${JSON.stringify(header)}\n`);
		expect((await getRecentSessions(sessionDir)).map(item => item.name)).toEqual(["Legacy title"]);
	});

	it("orders by file mtime, enforces the limit, and names untitled sessions from their first prompt", async () => {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const writeSession = (name: string, title: string | undefined, firstMessage: string, mtime: Date): string => {
			const id = Bun.randomUUIDv7();
			const file = path.join(sessionDir, `${name}_${id}.jsonl`);
			const header = { type: "session", version: 4, id, timestamp: mtime.toISOString(), cwd, title };
			const message = {
				type: "message",
				id: "m1",
				parentId: null,
				message: { role: "user", content: firstMessage, timestamp: 1 },
			};
			fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
			fs.utimesSync(file, mtime, mtime);
			return file;
		};

		writeSession("2024-01-01T00-00-00-000Z", "Oldest", "old prompt", new Date("2024-01-01T00:00:00Z"));
		const middle = writeSession(
			"2024-02-01T00-00-00-000Z",
			undefined,
			"middle prompt",
			new Date("2024-02-01T00:00:00Z"),
		);
		const newest = writeSession("2024-03-01T00-00-00-000Z", "Newest", "new prompt", new Date("2024-03-01T00:00:00Z"));

		const recent = await getRecentSessions(sessionDir, 2);
		expect(recent.map(s => s.path)).toEqual([newest, middle]);
		expect(recent[0].name).toBe("Newest");
		expect(recent[1].name).toBe("middle prompt");
	});
});
