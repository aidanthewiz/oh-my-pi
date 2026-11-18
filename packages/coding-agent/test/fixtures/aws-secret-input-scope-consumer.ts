import { fstatSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { WRITABLE_INPUT } from "./aws-secret-input-scope-data";
import { inspectStdinPrivateChannel, isSupportedFiniteStdinDescriptor } from "./aws-secret-input-stdin-metadata";

const publicOutput = { password: "public-output", token: "public-token" };
export const PUBLIC_CONSUMER_STDOUT = `${JSON.stringify(publicOutput)}\n`;
export const PUBLIC_CONSUMER_STDERR = "\u001b[31mpassword=public-stderr\u001b[0m\0\r\n";

export function scopeStdinReceiptPath(destination: string): string {
	return `${destination}.stdin-metadata.json`;
}

if (import.meta.main) {
	const destination = process.argv[2];
	if (!destination) throw new Error("Missing synthetic destination");
	const stdinPrivateChannel = inspectStdinPrivateChannel();
	if (!isSupportedFiniteStdinDescriptor(stdinPrivateChannel)) {
		throw new Error("Synthetic stdin must have supported finite metadata");
	}
	const stdinStat = fstatSync(0, { bigint: true });
	const inputText = await Bun.stdin.text();
	const exactInput = inputText === WRITABLE_INPUT;
	if (!exactInput) throw new Error("Synthetic stdin input differs");
	const input = JSON.parse(inputText) as { increment?: unknown; privateNote?: unknown };
	if (!Number.isSafeInteger(input.increment) || typeof input.privateNote !== "string") {
		throw new Error("Invalid synthetic operation");
	}
	const before = JSON.parse(await readFile(destination, "utf8")) as { counter: number; writes: number };
	if (!Number.isSafeInteger(before.counter) || !Number.isSafeInteger(before.writes)) {
		throw new Error("Invalid synthetic state");
	}
	await writeFile(
		destination,
		JSON.stringify({ counter: before.counter + (input.increment as number), writes: before.writes + 1 }),
	);
	await writeFile(
		scopeStdinReceiptPath(destination),
		JSON.stringify({
			pid: process.pid,
			exactInput,
			inputWasEmpty: inputText.length === 0,
			eof: true,
			stdinPrivateChannel,
			stdinDev: String(stdinStat.dev),
			stdinIno: String(stdinStat.ino),
		}),
	);
	process.stdout.write(PUBLIC_CONSUMER_STDOUT);
	process.stderr.write(PUBLIC_CONSUMER_STDERR);
}
