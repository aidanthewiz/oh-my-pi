import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { compileCodingAgent } from "../scripts/compile-binary";
import { isLocallyAnonymousStdinChannel } from "./fixtures/aws-secret-input-stdin-metadata";

async function capture(stream: ReadableStream<Uint8Array>, maxBytes: number) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let overflow = false;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const remaining = maxBytes - size;
			if (value.byteLength > remaining) overflow = true;
			if (remaining > 0) {
				const retained = value.slice(0, remaining);
				chunks.push(retained);
				size += retained.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { text: Buffer.concat(chunks).toString("utf8"), overflow };
}

test.skipIf(process.platform === "win32")(
	"source and release-compiled owned stdin use an anonymous stream through EOF and join blocked writers",
	async () => {
		using temp = TempDir.createSync("@omp-owned-stdin-native-");
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const entrypoint = path.join(import.meta.dir, "fixtures/aws-secret-input-owned-stdin.ts");
		const outfile = temp.join("owned-stdin");
		const shouldAdhocSign = process.platform === "darwin";
		await compileCodingAgent({
			repoRoot,
			entrypoint,
			outfile,
			transformersVersion: "unused",
			native: { platform: process.platform, arch: process.arch },
			minifyIdentifiers: true,
			skipBuiltinCodesign: shouldAdhocSign,
		});
		if (shouldAdhocSign) {
			const entitlements = path.join(repoRoot, "scripts/macos-entitlements.plist");
			await $`codesign --force --sign - --entitlements ${entitlements} ${outfile}`.quiet();
		}
		for (const compiled of [false, true]) {
			const root = temp.join(compiled ? "compiled" : "source");
			await fs.mkdir(root);
			const command = compiled
				? [outfile, "parent"]
				: [process.execPath, "--no-env-file", "--no-install", entrypoint, "parent"];
			const child = Bun.spawn(command, {
				cwd: root,
				env: {
					HOME: root,
					USERPROFILE: root,
					TMPDIR: root,
					XDG_CONFIG_HOME: root,
					XDG_CACHE_HOME: root,
					BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
					DO_NOT_TRACK: "1",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				signal: AbortSignal.timeout(60_000),
			});
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					capture(child.stdout, 16_384),
					capture(child.stderr, 4_096),
					child.exited,
				]);
				expect({ compiled, exitCode, stderr: stderr.text, overflow: stdout.overflow || stderr.overflow }).toEqual({
					compiled,
					exitCode: 0,
					stderr: "",
					overflow: false,
				});
				const receipt: unknown = JSON.parse(stdout.text);
				expect(isRecord(receipt) && receipt.compiled === compiled && Array.isArray(receipt.cases)).toBe(true);
				if (!isRecord(receipt) || !Array.isArray(receipt.cases)) throw new Error("MISSING_OWNED_STDIN_EVIDENCE");
				expect(receipt.cases.map(item => item.mode)).toEqual([
					"text",
					"newline",
					"binary",
					"input-limit",
					"empty",
					"refuse",
					"blocked",
					"cancel-registration",
					"reject-registration",
					"unproved-cancel",
				]);
				for (const item of receipt.cases) {
					expect({ mode: item.mode, reaped: item.reaped, writerClosed: item.writerClosed }).toEqual({
						mode: item.mode,
						reaped: true,
						writerClosed: true,
					});
					if (
						["refuse", "blocked", "cancel-registration", "reject-registration", "unproved-cancel"].includes(
							item.mode,
						)
					) {
						expect(Object.hasOwn(item, "received")).toBe(false);
						continue;
					}
					expect(isRecord(item.received)).toBe(true);
					if (!isRecord(item.received)) throw new Error("MISSING_RECEIVER_DESCRIPTOR_EVIDENCE");
					expect(item.received.compiled).toBe(compiled);
					expect(item.received.exactInput).toBe(true);
					expect(item.received.eof).toBe(true);
					expect(item.received.inputWasEmpty).toBe(item.mode === "empty");
					expect(isLocallyAnonymousStdinChannel(item.received.stdinPrivateChannel)).toBe(true);
					expect((item.received.stdinPrivateChannel as Record<string, unknown>).isRegularFile).toBe(false);
				}
			} finally {
				child.kill("SIGKILL");
				await child.exited;
			}
		}
	},
	180_000,
);
