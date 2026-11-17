import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { compileCodingAgent } from "../scripts/compile-binary";
import { lifecycleContainsSensitive } from "./fixtures/aws-secret-input-lifecycle-values";
import {
	isLocallyAnonymousStdinChannel,
	isVerifiedFiniteStdinHandoff,
	isVerifiedStdinPrivateChannelEvidence,
	isVerifiedStdinProducerWitness,
} from "./fixtures/aws-secret-input-stdin-metadata";

const MODES = [
	"text",
	"newline",
	"binary",
	"input-limit",
	"empty",
	"refuse",
	"blocked",
	"cancel-registration",
	"reject-registration",
	"unexpected-producer-failure",
] as const;

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
	"source and release-compiled owned stdin preserve production pipe EOF and join constrained blocked writers",
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
			const producer = Process.fromPid(child.pid);
			const producerParentPid = producer?.ppid;
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					capture(child.stdout, 16_384),
					capture(child.stderr, 4_096),
					child.exited,
				]);
				const failure = /^OWNED_STDIN_PHYSICAL_PROOF_FAILED ([a-z-]+) ([a-z-]+)\n$/u.exec(stderr.text);
				const failedMode = MODES.find(mode => mode === failure?.[1]) ?? "startup";
				const failedPhase =
					["setup", "delivery", "cleanup", "receiver-evidence"].find(value => value === failure?.[2]) ?? "startup";
				expect(
					exitCode === 0,
					`Owned stdin fixture failed; mode=${failedMode}; phase=${failedPhase}; diagnostics are withheld`,
				).toBe(true);
				expect(stdout.overflow || stderr.overflow, "Fixture diagnostics exceeded their public bounds").toBe(false);
				expect(stderr.text === "", "Owned stdin fixture stderr is withheld").toBe(true);
				expect(
					lifecycleContainsSensitive(stdout.text) || lifecycleContainsSensitive(stderr.text),
					"Private fixture input escaped the producer boundary",
				).toBe(false);
				expect(producerParentPid).toBe(process.pid);
				expect(producer?.status()).toBe(ProcessStatus.Exited);
				const receipt: unknown = JSON.parse(stdout.text);
				expect(isRecord(receipt) && receipt.compiled === compiled && Array.isArray(receipt.cases)).toBe(true);
				if (!isRecord(receipt) || !Array.isArray(receipt.cases)) throw new Error("MISSING_OWNED_STDIN_EVIDENCE");
				expect(receipt.cases.map(item => item.mode)).toEqual([...MODES]);
				for (const item of receipt.cases) {
					expect(isRecord(item)).toBe(true);
					if (!isRecord(item)) throw new Error("MISSING_OWNED_STDIN_CASE");
					expect({ mode: item.mode, reaped: item.reaped, producerSettled: item.producerSettled }).toEqual({
						mode: item.mode,
						reaped: true,
						producerSettled: true,
					});
					expect(typeof item.writerEofClosed).toBe("boolean");
					const stress = item.mode === "blocked" || item.mode === "unexpected-producer-failure";
					expect(item.transport).toBe(stress ? "fixture-socketpair" : "production-pipe");
					expect(isRecord(item.stdinProducerWitness)).toBe(true);
					if (!isRecord(item.stdinProducerWitness)) throw new Error("MISSING_PRODUCER_EVIDENCE");
					const witness = item.stdinProducerWitness;
					expect(witness.observerPid).toBe(child.pid);
					expect(witness.origin).toBe("observed-anonymous-stdin-writes");
					expect(witness.pipeConfigured).toBe(!stress);
					expect(witness.inputUnmodified).toBe(true);
					expect(witness.flushesCompleted).toBe(true);
					expect(Number.isSafeInteger(witness.maxChunkBytes) && Number(witness.maxChunkBytes) <= 4096).toBe(true);
					if (stress) {
						expect(witness.backpressureObserved).toBe(true);
						expect(item.nativePendingJoined).toBe(true);
						expect(isRecord(item.pendingAtCancellation) && isRecord(item.stressChannel)).toBe(true);
						if (!isRecord(item.pendingAtCancellation) || !isRecord(item.stressChannel))
							throw new Error("MISSING_PENDING_STDIN_EVIDENCE");
						expect(item.pendingAtCancellation.guardianPid).toBe(witness.guardianPid);
						expect(["write", "flush"].includes(String(item.pendingAtCancellation.operation))).toBe(true);
						expect(
							Number(item.pendingAtCancellation.bytesAccepted) > 0 &&
								Number(item.pendingAtCancellation.bytesAccepted) < 2_097_152,
						).toBe(true);
						expect(item.stressChannel.guardianPid).toBe(witness.guardianPid);
						expect(item.stressChannel.transport).toBe("fixture-socketpair");
						expect(
							Number(item.stressChannel.sendBufferBytes) > 0 &&
								Number(item.stressChannel.sendBufferBytes) < 65_536,
						).toBe(true);
						expect(isVerifiedStdinPrivateChannelEvidence(item.stressChannel.channel)).toBe(true);
						expect(item.stressClosed).toEqual({
							guardianPid: witness.guardianPid,
							readerClosed: true,
							writerClosed: true,
						});
					}
					if (item.mode === "unexpected-producer-failure") {
						expect(item.operationRejected).toBe(true);
						expect(item.cleanupAcknowledged).toBe(false);
					}
					if (
						[
							"refuse",
							"blocked",
							"cancel-registration",
							"reject-registration",
							"unexpected-producer-failure",
						].includes(String(item.mode))
					) {
						expect(Object.hasOwn(item, "received")).toBe(false);
						continue;
					}
					expect(isRecord(item.received)).toBe(true);
					if (!isRecord(item.received)) throw new Error("MISSING_RECEIVER_DESCRIPTOR_EVIDENCE");
					expect(item.received.compiled).toBe(compiled);
					expect(item.received.mode).toBe(item.mode);
					expect(item.received.exactInput).toBe(true);
					expect(item.received.eof).toBe(true);
					expect(item.received.inputWasEmpty).toBe(item.mode === "empty");
					expect(item.writerEofClosed).toBe(true);
					expect(isVerifiedStdinProducerWitness(witness)).toBe(true);
					expect(
						isVerifiedFiniteStdinHandoff(item.received.stdinPrivateChannel, witness, item.received, {
							pid: witness.guardianPid,
							receiverPid: witness.receiverPid,
							workerPid: child.pid,
						}),
					).toBe(true);
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
