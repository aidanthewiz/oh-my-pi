import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { findSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	lastSessionTransfer,
	markSessionMoved,
	packSession,
	type UnpackSessionResult,
	unpackSession,
} from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

function headerOf(entries: FileEntry[]): SessionHeader {
	const header = entries[0];
	if (header?.type !== "session") throw new Error("missing session header");
	return header;
}

function userTexts(entries: FileEntry[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user" && typeof message.content === "string") texts.push(message.content);
	}
	return texts;
}

async function appendTurn(sessionFile: string, text: string): Promise<void> {
	const session = await SessionManager.open(sessionFile);
	session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
	await session.close();
}

describe("omp session unpack against a local copy", () => {
	let root: string;
	let laptopAgent: string;
	let cloudAgent: string;
	let laptopCwd: string;
	let cloudCwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-transfer-copy-"));
		laptopAgent = path.join(root, "laptop-agent");
		cloudAgent = path.join(root, "cloud-agent");
		laptopCwd = path.join(root, "laptop", "project");
		cloudCwd = path.join(root, "cloud", "project");
		fs.mkdirSync(laptopCwd, { recursive: true });
		fs.mkdirSync(cloudCwd, { recursive: true });
		setAgentDir(laptopAgent);
	});

	afterEach(async () => {
		resetSessionIndexForTests();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(root, { recursive: true, force: true });
	});

	/** Laptop session with one turn, packed to `<root>/out.tar`; returns its file. */
	async function laptopSessionPacked(): Promise<string> {
		const session = SessionManager.create(laptopCwd);
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const file = session.getSessionFile();
		if (!file) throw new Error("session has no file");
		await session.close();
		await packSession(file, path.join(root, "out.tar"));
		return file;
	}

	/** Unpack `<root>/out.tar` on the cloud machine, add a turn there, and pack it to `<root>/back.tar`. */
	async function continueOnCloud(): Promise<void> {
		setAgentDir(cloudAgent);
		const unpacked = await unpackSession(path.join(root, "out.tar"), { cwd: cloudCwd });
		await appendTurn(unpacked.sessionFile, "cloud work");
		await packSession(unpacked.sessionFile, path.join(root, "back.tar"));
		setAgentDir(laptopAgent);
	}

	it("replaces a stale prefix copy, keeping one live copy", async () => {
		const laptopFile = await laptopSessionPacked();
		const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
		// The copy left behind is marked moved after packing, so only it holds that marker.
		await markSessionMoved(laptopFile, "cloud");
		await continueOnCloud();

		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

		expect(result.mode).toBe("replaced");
		expect(result.id).toBe(id);
		expect(await findSessionFiles(id)).toEqual([result.sessionFile]);
		const entries = await loadEntriesFromFile(result.sessionFile);
		expect(userTexts(entries)).toEqual(["first", "cloud work"]);
		expect(lastSessionTransfer(entries)).toEqual({
			kind: "arrived",
			fromCwd: path.resolve(cloudCwd),
			cwd: path.resolve(laptopCwd),
		});
	});

	it("preserves a completed local turn at the pre-lease boundary", async () => {
		const laptopFile = await laptopSessionPacked();
		const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
		await continueOnCloud();
		const claim = FileSessionStorage.prototype.claimSession;
		let localBefore: Buffer<ArrayBuffer> | undefined;
		const boundary = spyOn(FileSessionStorage.prototype, "claimSession").mockImplementation(
			function (this: FileSessionStorage, claimedId, file) {
				if (claimedId === id && localBefore === undefined) {
					const child = Bun.spawnSync(
						[
							process.execPath,
							"--eval",
							`
						import { SessionManager } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent/session/session-manager"))};
						import { setAgentDir } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils"))};
						import { makeAssistantMessage } from ${JSON.stringify(new URL("./session-manager/helpers.ts", import.meta.url).href)};
						setAgentDir(${JSON.stringify(laptopAgent)});
						const session = await SessionManager.open(${JSON.stringify(laptopFile)});
						session.appendMessage({ role: "user", content: "completed before lease", timestamp: 2 });
						session.appendMessage(makeAssistantMessage());
						await session.flush();
						await session.close();
						`,
						],
						{ env: process.env, stdout: "pipe", stderr: "pipe" },
					);
					if (child.exitCode !== 0) throw new Error(child.stderr.toString());
					localBefore = fs.readFileSync(laptopFile);
				}
				return claim.call(this, claimedId, file);
			},
		);
		let result: UnpackSessionResult;
		try {
			result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });
		} finally {
			boundary.mockRestore();
		}

		if (localBefore === undefined) throw new Error("The pre-lease writer did not complete");
		expect(result.mode).toBe("forked");
		expect(headerOf(await loadEntriesFromFile(result.sessionFile)).parentSession).toBe(id);
		expect(userTexts(await loadEntriesFromFile(result.sessionFile))).toEqual(["first", "cloud work"]);
		expect(userTexts(await loadEntriesFromFile(laptopFile))).toEqual(["first", "completed before lease"]);
		expect(await fsp.readFile(laptopFile)).toEqual(localBefore);
	});

	it.each(["local-only artifact", "edited artifact", "extended subagent transcript"])(
		"preserves a %s independently of the journal",
		async scenario => {
			const laptopFile = await laptopSessionPacked();
			const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
			const relative = scenario === "extended subagent transcript" ? "0-Explore.jsonl" : "tools/result.bin";
			const artifact = path.join(laptopFile.slice(0, -".jsonl".length), relative);
			const original =
				scenario === "extended subagent transcript"
					? Buffer.from('{"type":"session","id":"sub","cwd":"/synthetic"}\n')
					: Buffer.from([0, 1, 2, 255]);
			if (scenario !== "local-only artifact") {
				await fsp.mkdir(path.dirname(artifact), { recursive: true });
				await fsp.writeFile(artifact, original);
				await packSession(laptopFile, path.join(root, "out.tar"));
			}
			await continueOnCloud();
			const localBytes =
				scenario === "extended subagent transcript"
					? Buffer.concat([
							original,
							Buffer.from(
								'{"type":"message","id":"local","message":{"role":"user","content":"local subagent work"}}\n',
							),
						])
					: Buffer.from([255, 0, 42, 1]);
			await fsp.mkdir(path.dirname(artifact), { recursive: true });
			await fsp.writeFile(artifact, localBytes);
			const journalBefore = await fsp.readFile(laptopFile);

			const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

			expect(result.mode).toBe("forked");
			expect(result.id).not.toBe(id);
			expect(headerOf(await loadEntriesFromFile(result.sessionFile)).parentSession).toBe(id);
			expect(userTexts(await loadEntriesFromFile(result.sessionFile))).toEqual(["first", "cloud work"]);
			expect(await fsp.readFile(laptopFile)).toEqual(journalBefore);
			expect(await fsp.readFile(artifact)).toEqual(localBytes);
			const incomingArtifact = path.join(result.sessionFile.slice(0, -".jsonl".length), relative);
			if (scenario === "local-only artifact") {
				expect(await Bun.file(incomingArtifact).exists()).toBe(false);
			} else {
				expect(await fsp.readFile(incomingArtifact)).toEqual(original);
			}
		},
	);

	it("replaces an unchanged ancestor with identical local artifact bytes", async () => {
		const laptopFile = await laptopSessionPacked();
		const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
		const relative = "nested/retained.bin";
		const artifacts = laptopFile.slice(0, -".jsonl".length);
		const retained = Buffer.from([0, 255, 7, 128]);
		await fsp.mkdir(path.join(artifacts, "nested"), { recursive: true });
		await fsp.writeFile(path.join(artifacts, relative), retained);
		await packSession(laptopFile, path.join(root, "out.tar"));
		await continueOnCloud();

		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

		expect(result.mode).toBe("replaced");
		expect(result.id).toBe(id);
		expect(await findSessionFiles(id)).toEqual([result.sessionFile]);
		expect(userTexts(await loadEntriesFromFile(result.sessionFile))).toEqual(["first", "cloud work"]);
		expect(await fsp.readFile(path.join(result.sessionFile.slice(0, -".jsonl".length), relative))).toEqual(retained);
	});

	it.each([false, true])("preserves all local copies when only the second has artifact changes: %s", async changed => {
		const laptopFile = await laptopSessionPacked();
		const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
		const otherDir = SessionManager.getDefaultSessionDir(path.join(root, "other-project"));
		const otherFile = path.join(otherDir, path.basename(laptopFile));
		await fsp.mkdir(otherDir, { recursive: true });
		await fsp.copyFile(laptopFile, otherFile);
		const artifact = path.join(otherFile.slice(0, -".jsonl".length), "local-only.bin");
		const localBytes = Buffer.from([255, 0, 1]);
		if (changed) {
			await fsp.mkdir(path.dirname(artifact), { recursive: true });
			await fsp.writeFile(artifact, localBytes);
		}
		const journalBefore = await fsp.readFile(laptopFile);
		await continueOnCloud();

		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

		expect(userTexts(await loadEntriesFromFile(result.sessionFile))).toEqual(["first", "cloud work"]);
		if (changed) {
			expect(result.mode).toBe("forked");
			expect(headerOf(await loadEntriesFromFile(result.sessionFile)).parentSession).toBe(id);
			expect(await fsp.readFile(laptopFile)).toEqual(journalBefore);
			expect(await fsp.readFile(otherFile)).toEqual(journalBefore);
			expect(await fsp.readFile(artifact)).toEqual(localBytes);
		} else {
			expect(result.mode).toBe("replaced");
			expect(await findSessionFiles(id)).toEqual([result.sessionFile]);
			expect(await Bun.file(otherFile).exists()).toBe(false);
		}
	});

	it.each(["not a journal\n", '{"type":"session","id":"broken"\n'])(
		"preserves changed non-session or malformed jsonl artifacts: %s",
		async original => {
			const laptopFile = await laptopSessionPacked();
			const artifact = path.join(laptopFile.slice(0, -".jsonl".length), "output.jsonl");
			await fsp.mkdir(path.dirname(artifact), { recursive: true });
			await fsp.writeFile(artifact, original);
			await packSession(laptopFile, path.join(root, "out.tar"));
			await continueOnCloud();
			const localBytes = Buffer.from(`${original}local-only bytes\n`);
			await fsp.writeFile(artifact, localBytes);
			const journalBefore = await fsp.readFile(laptopFile);

			const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

			expect(result.mode).toBe("forked");
			expect(await fsp.readFile(laptopFile)).toEqual(journalBefore);
			expect(await fsp.readFile(artifact)).toEqual(localBytes);
			expect(await fsp.readFile(path.join(result.sessionFile.slice(0, -".jsonl".length), "output.jsonl"))).toEqual(
				Buffer.from(original),
			);
		},
	);

	it.skipIf(process.platform === "win32").each(["root", "nested"])(
		"refuses a symlink artifact %s without following or deleting foreign bytes",
		async location => {
			const laptopFile = await laptopSessionPacked();
			await continueOnCloud();
			const artifacts = laptopFile.slice(0, -".jsonl".length);
			const foreign = path.join(root, "foreign");
			await fsp.mkdir(foreign);
			const foreignFile = path.join(foreign, "private.bin");
			const foreignBytes = Buffer.from([0, 128, 255]);
			await fsp.writeFile(foreignFile, foreignBytes);
			if (location === "nested") await fsp.mkdir(artifacts);
			const link = location === "root" ? artifacts : path.join(artifacts, "linked");
			await fsp.symlink(foreign, link, "dir");
			const journalBefore = await fsp.readFile(laptopFile);

			await expect(unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd })).rejects.toThrow(
				/not a real directory|not a regular file/,
			);

			expect(await fsp.readFile(laptopFile)).toEqual(journalBefore);
			expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
			expect(await fsp.readFile(foreignFile)).toEqual(foreignBytes);
		},
	);

	it("refuses a non-directory local artifact root without replacing the journal", async () => {
		const laptopFile = await laptopSessionPacked();
		await continueOnCloud();
		const artifacts = laptopFile.slice(0, -".jsonl".length);
		const localBytes = Buffer.from([0, 7, 255]);
		await fsp.writeFile(artifacts, localBytes);
		const journalBefore = await fsp.readFile(laptopFile);

		await expect(unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd })).rejects.toThrow(
			/not a real directory/,
		);

		expect(await fsp.readFile(laptopFile)).toEqual(journalBefore);
		expect(await fsp.readFile(artifacts)).toEqual(localBytes);
	});

	it("restores local journal and artifacts when arrival persistence fails after replacement", async () => {
		const laptopFile = await laptopSessionPacked();
		const artifact = path.join(laptopFile.slice(0, -".jsonl".length), "retained.bin");
		const localBytes = Buffer.from([0, 255, 128]);
		await fsp.mkdir(path.dirname(artifact), { recursive: true });
		await fsp.writeFile(artifact, localBytes);
		await packSession(laptopFile, path.join(root, "out.tar"));
		await continueOnCloud();
		const journalBefore = await fsp.readFile(laptopFile);
		const filesBefore = (await fsp.readdir(path.dirname(laptopFile))).sort();
		const append = spyOn(SessionManager.prototype, "appendCustomMessageEntry").mockImplementation(() => {
			throw new Error("synthetic arrival persistence failure");
		});
		try {
			await expect(unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd })).rejects.toThrow(
				/synthetic arrival persistence failure/,
			);
		} finally {
			append.mockRestore();
		}

		expect(await fsp.readFile(laptopFile)).toEqual(journalBefore);
		expect(await fsp.readFile(artifact)).toEqual(localBytes);
		expect((await fsp.readdir(path.dirname(laptopFile))).sort()).toEqual(filesBefore);
		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });
		expect(result.mode).toBe("replaced");
		expect(userTexts(await loadEntriesFromFile(result.sessionFile))).toEqual(["first", "cloud work"]);
		expect(await fsp.readFile(path.join(result.sessionFile.slice(0, -".jsonl".length), "retained.bin"))).toEqual(
			localBytes,
		);
	});

	it.each(["parent", "subagent"])("refuses a live %s writer without changing local bytes", async owner => {
		const laptopFile = await laptopSessionPacked();
		const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
		const subagent = SessionManager.create(laptopCwd, laptopFile.slice(0, -".jsonl".length));
		subagent.appendMessage({ role: "user", content: "subagent work", timestamp: 1 });
		subagent.appendMessage(makeAssistantMessage());
		await subagent.flush();
		const subagentFile = subagent.getSessionFile();
		await subagent.close();
		if (!subagentFile) throw new Error("missing subagent transcript");
		await packSession(laptopFile, path.join(root, "out.tar"));
		await continueOnCloud();
		const writerFile = owner === "parent" ? laptopFile : subagentFile;
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
				import { SessionManager } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent/session/session-manager"))};
				import { setAgentDir } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils"))};
				import { makeAssistantMessage } from ${JSON.stringify(new URL("./session-manager/helpers.ts", import.meta.url).href)};
				setAgentDir(${JSON.stringify(laptopAgent)});
				const session = await SessionManager.open(${JSON.stringify(writerFile)});
				session.appendMessage({ role: "user", content: "live local work", timestamp: 2 });
				session.appendMessage(makeAssistantMessage());
				await session.flush();
				await Bun.write(Bun.stdout, "ready\\n");
				await Bun.stdin.text();
				await session.close();
				`,
			],
			{ env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		try {
			const ready = await child.stdout.getReader().read();
			if (new TextDecoder().decode(ready.value) !== "ready\n") {
				throw new Error(`Writer failed before readiness: ${await new Response(child.stderr).text()}`);
			}
			const journalBefore = await fsp.readFile(laptopFile);
			const subagentBefore = await fsp.readFile(subagentFile);

			await expect(unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd })).rejects.toThrow(
				/another live .* process writes this session/,
			);

			expect(await fsp.readFile(laptopFile)).toEqual(journalBefore);
			expect(await fsp.readFile(subagentFile)).toEqual(subagentBefore);
			expect(await findSessionFiles(id)).toEqual([laptopFile]);
		} finally {
			child.stdin.end();
			await child.exited;
		}
		expect(child.exitCode).toBe(0);
		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });
		expect(result.mode).toBe("forked");
		expect(userTexts(await loadEntriesFromFile(writerFile))).toEqual([
			owner === "parent" ? "first" : "subagent work",
			"live local work",
		]);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"refuses unreadable local artifact bytes without replacing the journal",
		async () => {
			const laptopFile = await laptopSessionPacked();
			const artifact = path.join(laptopFile.slice(0, -".jsonl".length), "retained.bin");
			const localBytes = Buffer.from([0, 255, 128]);
			await fsp.mkdir(path.dirname(artifact), { recursive: true });
			await fsp.writeFile(artifact, localBytes);
			await packSession(laptopFile, path.join(root, "out.tar"));
			await continueOnCloud();
			const journalBefore = await fsp.readFile(laptopFile);
			await fsp.chmod(artifact, 0);
			try {
				await expect(unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd })).rejects.toThrow(
					/EACCES|EPERM/,
				);
			} finally {
				await fsp.chmod(artifact, 0o600);
			}

			expect(await fsp.readFile(laptopFile)).toEqual(journalBefore);
			expect(await fsp.readFile(artifact)).toEqual(localBytes);
			const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });
			expect(result.mode).toBe("replaced");
		},
	);

	it("unpacks as a fork when the local copy diverged", async () => {
		const laptopFile = await laptopSessionPacked();
		const id = headerOf(await loadEntriesFromFile(laptopFile)).id;
		await appendTurn(laptopFile, "laptop work");
		await continueOnCloud();

		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

		expect(result.mode).toBe("forked");
		expect(result.id).not.toBe(id);
		const forked = await loadEntriesFromFile(result.sessionFile);
		expect(headerOf(forked).parentSession).toBe(id);
		expect(headerOf(forked).cwd).toBe(path.resolve(laptopCwd));
		expect(userTexts(forked)).toEqual(["first", "cloud work"]);
		// The diverged local copy is untouched.
		expect(userTexts(await loadEntriesFromFile(laptopFile))).toEqual(["first", "laptop work"]);
	});

	it("forks same-ID entries with edited content and preserves the local journal and artifacts", async () => {
		const laptopFile = await laptopSessionPacked();
		const entries = await loadEntriesFromFile(laptopFile);
		const id = headerOf(entries).id;
		const turn = entries.find(entry => entry.type === "message" && entry.message.role === "user");
		if (turn?.type !== "message" || turn.message.role !== "user") throw new Error("missing user entry");
		turn.message.content = "edited laptop work";
		await fsp.writeFile(laptopFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const artifact = path.join(laptopFile.slice(0, -".jsonl".length), "local.txt");
		await fsp.mkdir(path.dirname(artifact), { recursive: true });
		await fsp.writeFile(artifact, "local artifact");
		const localBefore = await fsp.readFile(laptopFile);
		await continueOnCloud();

		const result = await unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd });

		expect(result.mode).toBe("forked");
		expect(result.id).not.toBe(id);
		const forked = await loadEntriesFromFile(result.sessionFile);
		expect(headerOf(forked).parentSession).toBe(id);
		expect(userTexts(forked)).toEqual(["first", "cloud work"]);
		expect(await fsp.readFile(laptopFile)).toEqual(localBefore);
		expect(await Bun.file(artifact).text()).toBe("local artifact");
	});
});
