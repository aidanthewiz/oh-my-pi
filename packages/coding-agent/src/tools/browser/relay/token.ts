import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";

const TOKEN_FILE = "token";
const TOKEN_BYTES = 32;
const TOKEN_DIR_MODE = 0o700;
const TOKEN_FILE_MODE = 0o600;

async function ensureTokenDir(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: TOKEN_DIR_MODE });
	await fs.chmod(directory, TOKEN_DIR_MODE);
}

function requireToken(token: string): string {
	if (typeof token !== "string" || token.trim() === "") throw new Error("Browser relay token must be nonempty");
	return token.trim();
}

async function writePrivateTemporary(file: string, value: string): Promise<string> {
	const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
	await fs.writeFile(temporary, value, { encoding: "utf8", flag: "wx", mode: TOKEN_FILE_MODE });
	await fs.chmod(temporary, TOKEN_FILE_MODE);
	return temporary;
}

/** Read the machine-local relay token, creating it atomically when absent. */
export async function ensureBrowserRelayToken(directory = getBrowserRelayDir()): Promise<string> {
	await ensureTokenDir(directory);
	const file = path.join(directory, TOKEN_FILE);
	for (;;) {
		try {
			const token = requireToken(await fs.readFile(file, "utf8"));
			await fs.chmod(file, TOKEN_FILE_MODE);
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
		const temporary = await writePrivateTemporary(file, token);
		try {
			// link() publishes a fully written inode without replacing a winner
			// from another process. Readers can never observe an empty token.
			await fs.link(temporary, file);
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally {
			await fs.unlink(temporary).catch(() => undefined);
		}
	}
}

/** Atomically replace the machine-local relay token after a successful bind. */
export async function writeBrowserRelayToken(token: string, directory = getBrowserRelayDir()): Promise<void> {
	const value = requireToken(token);
	await ensureTokenDir(directory);
	const file = path.join(directory, TOKEN_FILE);
	const temporary = await writePrivateTemporary(file, value);
	try {
		await fs.rename(temporary, file);
		await fs.chmod(file, TOKEN_FILE_MODE);
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
}
