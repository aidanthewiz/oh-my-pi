import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
const answer = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "anthropic-messages" as const,
	provider: "anthropic" as const,
	model: "claude-sonnet-4-20250514",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 0,
});
const bashResult = {
	role: "bashExecution" as const,
	command: "sleep 5 && echo done",
	output: "done",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	timestamp: 0,
};

describe("off-branch leaf replay", () => {
	it("keeps the active branch when a late bash result lands on an abandoned branch", async () => {
		const root = makeTempDir("@pi-off-branch-leaf-");
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		const firstUser = manager.appendMessage(user("first prompt"));
		const firstAnswer = manager.appendMessage(answer("first answer"));
		manager.branch(firstUser);
		const secondUser = manager.appendMessage(user("second prompt"));

		// A standalone `!` command started on the abandoned path finishes after
		// the rewind and is delivered back to the branch it started on.
		manager.appendMessageToBranch(bashResult, firstAnswer);

		expect(manager.getLeafId()).toBe(secondUser);
		expect(manager.buildSessionContext().messages.map(message => message.role)).toEqual(["user", "user"]);
		await manager.close();

		const reopened = await SessionManager.open(sessionFile);
		try {
			expect(reopened.getLeafId()).toBe(secondUser);
			expect(reopened.buildSessionContext().messages.map(message => message.role)).toEqual(["user", "user"]);
		} finally {
			await reopened.close();
		}
	});

	it("preserves a cleared leaf across a late result and restart", async () => {
		const root = makeTempDir("@pi-off-branch-cleared-");
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const first = manager.appendMessage(user("abandoned"));
		manager.appendMessage(answer("old answer"));
		manager.resetLeaf();
		manager.appendMessageToBranch(bashResult, first);
		const file = manager.getSessionFile()!;
		await manager.close();
		const reopened = await SessionManager.open(file);
		try {
			expect(reopened.getLeafId()).toBeNull();
			expect(reopened.buildSessionContext().messages).toEqual([]);
		} finally {
			await reopened.close();
		}
	});

	it("replays an explicitly selected sibling instead of its previous active leaf", async () => {
		const root = makeTempDir("@pi-off-branch-sibling-");
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const first = manager.appendMessage(user("question"));
		manager.appendMessage(answer("old answer"));
		const sibling = manager.appendMessageToBranch(answer("replacement"), first, { preserveActiveLeaf: false });
		manager.branch(sibling);
		const file = manager.getSessionFile()!;
		await manager.close();
		const reopened = await SessionManager.open(file);
		try {
			expect(reopened.getLeafId()).toBe(sibling);
			expect(reopened.buildSessionContext().messages).toMatchObject([user("question"), answer("replacement")]);
		} finally {
			await reopened.close();
		}
	});

	it("drops captured leaf markers when copying an off-branch path", async () => {
		const root = makeTempDir("@pi-off-branch-copy-");
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const first = manager.appendMessage(user("first"));
		const firstAnswer = manager.appendMessage(answer("answer"));
		manager.branch(first);
		manager.appendMessage(user("active branch"));
		const late = manager.appendMessageToBranch(bashResult, firstAnswer);
		await manager.flush();
		const file = manager.createBranchedSession(late)!;
		await manager.close();
		const reopened = await SessionManager.open(file);
		try {
			expect(reopened.getLeafId()).toBe(late);
			expect(reopened.buildSessionContext().messages.map(message => message.role)).toEqual([
				"user",
				"assistant",
				"bashExecution",
			]);
			expect(reopened.getEntries().every(entry => entry.activeLeafId === undefined)).toBe(true);
		} finally {
			await reopened.close();
		}
	});

	it("recovers the newest self-selected leaf when a captured leaf no longer exists", async () => {
		const root = makeTempDir("@pi-off-branch-missing-leaf-");
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const first = manager.appendMessage(user("first"));
		manager.appendMessage(answer("answer"));
		manager.branch(first);
		const active = manager.appendMessage(user("active branch"));
		const late = manager.appendMessageToBranch(bashResult, first);
		manager.getEntry(late)!.activeLeafId = "missing-captured-leaf";
		await manager.rewriteEntries();
		const file = manager.getSessionFile()!;
		await manager.close();
		const reopened = await SessionManager.open(file);
		try {
			expect(reopened.getLeafId()).toBe(active);
			expect(reopened.buildSessionContext().messages).toMatchObject([user("first"), user("active branch")]);
		} finally {
			await reopened.close();
		}
	});

	it.each([
		{ name: "empty", changes: [], valid: true },
		{ name: "opaque", changes: [{ name: "a\ud800", nested: { value: "\udfff" } }], valid: true },
		{ name: "malformed", changes: ["not a signed record"], valid: false },
	])("reloads $name native compaction records without changing signed bytes", async ({ changes, valid }) => {
		const root = makeTempDir("@pi-native-journal-");
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const first = manager.appendMessage(user("history"));
		manager.appendMessage(answer("history answer"));
		manager.appendCompaction("readable summary", undefined, first, 100, {
			method: "remote",
			preserveData: {
				anthropicCompaction: {
					provider: "amazon-bedrock",
					content: "signed content\ud800",
					signature: "opaque signature",
					toolChanges: changes,
				},
			},
		});
		const file = manager.getSessionFile()!;
		await manager.close();
		const reopened = await SessionManager.open(file);
		try {
			const summary = reopened.buildSessionContext().messages.find(message => message.role === "compactionSummary");
			expect(summary?.role).toBe("compactionSummary");
			if (summary?.role !== "compactionSummary") throw new Error("Missing compaction summary");
			if (valid) {
				expect(summary.providerPayload).toMatchObject({
					type: "anthropicCompaction",
					provider: "amazon-bedrock",
					content: "signed content\ud800",
					signature: "opaque signature",
					toolChanges: changes,
				});
			} else {
				expect(summary.providerPayload).toBeUndefined();
				expect(summary.summary).toBe("readable summary");
			}
		} finally {
			await reopened.close();
		}
	});
});
