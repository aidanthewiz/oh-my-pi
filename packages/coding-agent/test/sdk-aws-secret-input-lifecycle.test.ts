import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAwsSecretInputNativeGuardLauncher } from "./fixtures/aws-secret-input-native-dcg";
import {
	isLocallyAnonymousStdinChannel,
	isSupportedFiniteStdinDescriptor,
	isVerifiedStdinProducerWitness,
} from "./fixtures/aws-secret-input-stdin-metadata";

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
				const chunk = value.slice(0, remaining);
				chunks.push(chunk);
				size += chunk.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { text: Buffer.concat(chunks).toString("utf8"), overflow };
}

const TRANSITIONS = {
	fork: { kind: "fork", identityChanged: true, returnedToOriginalSession: true, staleGrantRejected: true },
	dispose: {
		kind: "dispose",
		rootTeardownBlocked: true,
		completeCallbacksDeferred: true,
		childExitedWhileTeardownBlocked: true,
		newPreparationRejected: true,
		newExecutionRejected: true,
		completeCallbacksEventuallyRun: true,
	},
};
const PHASES = [
	"setup",
	"sdk-construction",
	"fresh-approval",
	"consumer-readiness",
	"supported-fork",
	"joined-worker-and-consumer",
	"returned-session-replay",
	"root-disposal-begin",
	"root-disposal-state",
	"root-disposal-cancellation",
	"root-disposal-deferral",
	"closed-disposal-admission",
	"complete-root-teardown",
	"public-surfaces",
	"public-session-records",
	"no-model-dispatch",
	"worker-owned-directories",
	"worker-private-boundary",
	"worker-teardown-receipts",
	"root-disposal-complete",
	"owned-files",
	"exact-approval-count",
];
const CLEANUP_PHASES = [
	"private-processes",
	"active-execution",
	"session-disposal",
	"control-listener",
	"in-memory-auth",
	"session-writer",
	"owned-files",
];

for (const scenario of ["fork", "dispose"] as const) {
	test.skipIf(process.platform === "win32")(
		`SDK-created AWS secret-input joins the private worker and owned child across ${scenario}`,
		async () => {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sdk-aws-secret-input-lifecycle-")));
			try {
				const guardPath = path.join(root, "native-dcg");
				const guard = createAwsSecretInputNativeGuardLauncher(root);
				await fs.writeFile(guardPath, guard, { mode: 0o755 });
				const policyPath = path.join(root, "dcg.toml");
				const policy = '[packs]\nenabled = ["fixture_aws_secret_input"]\n';
				await fs.writeFile(policyPath, policy);
				const child = Bun.spawn(
					[
						process.execPath,
						"--no-env-file",
						"--no-install",
						path.resolve(import.meta.dir, "fixtures/sdk-aws-secret-input-lifecycle-probe.ts"),
						root,
						scenario,
					],
					{
						cwd: root,
						env: {
							HOME: root,
							USERPROFILE: root,
							TMPDIR: root,
							TMP: root,
							TEMP: root,
							XDG_CONFIG_HOME: root,
							XDG_CACHE_HOME: root,
							XDG_DATA_HOME: root,
							OMP_DOTENV_OVERRIDE: "1",
							OMP_CF_PRODUCT_VERSION: "fixture",
							BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
							DO_NOT_TRACK: "1",
							OMP_DCG_PATH: guardPath,
							OMP_DCG_VERSION: "fixture",
							OMP_DCG_BINARY_SHA256: new Bun.CryptoHasher("sha256").update(guard).digest("hex"),
							OMP_DCG_CONFIG: policyPath,
							OMP_DCG_CONFIG_SHA256: new Bun.CryptoHasher("sha256").update(policy).digest("hex"),
							...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
						},
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						signal: AbortSignal.timeout(90_000),
					},
				);
				try {
					const [stdout, stderr, exit] = await Promise.all([
						capture(child.stdout, 16_384),
						capture(child.stderr, 16_384),
						child.exited,
					]);
					let receipt: unknown;
					try {
						receipt = JSON.parse(stdout.text);
					} catch {}
					const summary =
						receipt && typeof receipt === "object" ? (receipt as Record<string, unknown>) : undefined;
					const phase = PHASES.find(value => summary?.stage === value) ?? "startup";
					const cleanup = CLEANUP_PHASES.find(value => summary?.cleanup === value) ?? "none";
					const primaryFailure = summary?.primaryFailure === true ? "failed" : "none";
					expect(
						exit === 0,
						`SDK secret-input fixture failed; phase=${phase}; primary=${primaryFailure}; cleanup=${cleanup}; diagnostics are withheld`,
					).toBe(true);
					expect(stdout.overflow || stderr.overflow, "Fixture diagnostics exceeded their public bounds").toBe(
						false,
					);
					expect(stderr.text === "", "SDK fixture stderr is withheld").toBe(true);
					const stdinPrivateChannel = summary?.stdinPrivateChannel;
					const stdinProducerWitness = summary?.stdinProducerWitness;
					expect(
						isSupportedFiniteStdinDescriptor(stdinPrivateChannel) &&
							isVerifiedStdinProducerWitness(stdinProducerWitness) &&
							isLocallyAnonymousStdinChannel(stdinPrivateChannel) &&
							summary?.stdinInputMode ===
								(stdinProducerWitness.inputWasEmpty ? "empty-eof" : "anonymous-channel") &&
							summary?.stdinPeerMetadataObserved ===
								(stdinPrivateChannel.isSocket === true &&
									stdinPrivateChannel.peerSocketFamily === "unix" &&
									stdinPrivateChannel.peerAddress === "unnamed"),
						"Finite stdin transport observations are incomplete; receipt is withheld",
					).toBe(true);
					expect(
						typeof summary?.workerSocketIdentitiesCompared === "boolean",
						"Worker socket identity availability was not reported",
					).toBe(true);
					expect(
						process.platform === "linux"
							? typeof summary?.guardianSocketIdentitiesCompared === "boolean"
							: summary?.guardianSocketIdentitiesCompared === null,
						"Guardian socket identity availability was not reported",
					).toBe(true);
					expect(
						Bun.deepEquals(receipt, {
							schema: "sdk-aws-secret-input-lifecycle/v1",
							transition: TRANSITIONS[scenario],
							consumerReady: true,
							scopeAborted: true,
							cancelled: true,
							workerReapedBeforeResult: true,
							consumerReaped: true,
							descendantReaped: true,
							guardianReaped: true,
							stdinPrivateChannelVerified: true,
							stdinInputMode: summary?.stdinInputMode,
							stdinPrivateChannel,
							stdinProducerWitness,
							stdinPeerMetadataObserved: summary?.stdinPeerMetadataObserved,
							noControllingTty: true,
							workerPrivateCanaryClosed: true,
							measurableWorkerDescriptorsClosed: true,
							workerSocketIdentitiesCompared: summary?.workerSocketIdentitiesCompared,
							measurableGuardianDescriptorsClosed: process.platform === "linux" ? true : null,
							guardianSocketIdentitiesCompared: summary?.guardianSocketIdentitiesCompared,
							guardianFdSnapshotAvailable: process.platform === "linux",
							publicSurfacesClean: true,
							ownedFilesClean: true,
							modelDispatches: 0,
							liveAws: false,
						}),
						"SDK secret-input lifecycle evidence is incomplete; receipt is withheld",
					).toBe(true);
				} finally {
					if (child.exitCode === null) child.kill("SIGKILL");
					await child.exited;
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		100_000,
	);
}
