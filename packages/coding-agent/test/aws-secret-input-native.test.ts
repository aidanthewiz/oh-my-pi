import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { compileCodingAgent } from "../scripts/compile-binary";
import { createAwsSecretInputNativeGuardLauncher } from "./fixtures/aws-secret-input-native-dcg";
import {
	isLocallyAnonymousStdinChannel,
	isSupportedFiniteStdinDescriptor,
	isVerifiedStdinProducerWitness,
} from "./fixtures/aws-secret-input-stdin-metadata";

const CASES = [
	"schema-before-access",
	"capability-before-access",
	"host-admission-before-approval",
	"worker-admission-before-approval",
	"capability-mismatch-before-approval",
	"user-denial-before-delivery",
	"aws-policy-denial",
	"identity-policy-denial",
	"consumer-policy-denial",
	"consumer-exec-policy-denial",
	"aws-guard-denial",
	"consumer-guard-denial",
	"combined-one-use-approval",
	"immutable-approved-request",
	"changed-settings-reject-grant",
	"changed-session-reject-grant",
	"changed-host-cwd-reject-grant",
	"raw-consumer-output",
	"fixed-provider-failure",
	"no-session-one-use-approval",
	"completed-secret-input-cannot-downgrade",
	"prepared-secret-input-cannot-downgrade",
	"capability-call-cannot-downgrade",
	"project-bun-preload-cannot-intercept-non-bun-receiver",
	"global-bun-preload-cannot-intercept-non-bun-receiver",
	"paused-secret-bash-revokes-live-authority",
	"paused-secret-exec-revokes-live-authority",
	"paused-secret-replacement-revokes-live-authority",
	"paused-identity-aws-revokes-live-authority",
	"paused-identity-replacement-revokes-live-authority",
	"cross-account-secret-binds-approved-resource",
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

function safeReceipt(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const receipt = value as Record<string, unknown>;
	const stdinPrivateChannel = receipt.stdinPrivateChannel;
	const stdinProducerWitness = receipt.stdinProducerWitness;
	if (
		!isSupportedFiniteStdinDescriptor(stdinPrivateChannel) ||
		!isVerifiedStdinProducerWitness(stdinProducerWitness) ||
		!isLocallyAnonymousStdinChannel(stdinPrivateChannel)
	)
		return false;
	if (typeof receipt.workerSocketIdentitiesCompared !== "boolean") return false;
	if (
		process.platform === "linux"
			? typeof receipt.guardianSocketIdentitiesCompared !== "boolean"
			: receipt.guardianSocketIdentitiesCompared !== null
	)
		return false;
	return Bun.deepEquals(receipt, {
		schema: "aws-secret-input-native/v1",
		cases: CASES.map(name => ({ name, passed: true })),
		transport: "native-write-xdev-private-worker-finite-stdin",
		allWorkersReaped: true,
		publicSurfacesClean: true,
		ownedFilesClean: true,
		stdinPrivateChannelVerified: true,
		stdinInputMode: stdinProducerWitness.inputWasEmpty ? "empty-eof" : "anonymous-channel",
		stdinPrivateChannel,
		stdinProducerWitness,
		stdinPeerMetadataObserved:
			stdinPrivateChannel.isSocket === true &&
			stdinPrivateChannel.peerSocketFamily === "unix" &&
			stdinPrivateChannel.peerAddress === "unnamed",
		noControllingTty: true,
		workerPrivateCanaryClosed: true,
		measurableWorkerDescriptorsClosed: true,
		workerSocketIdentitiesCompared: receipt.workerSocketIdentitiesCompared,
		measurableGuardianDescriptorsClosed: process.platform === "linux" ? true : null,
		guardianSocketIdentitiesCompared: receipt.guardianSocketIdentitiesCompared,
		guardianFdSnapshotAvailable: process.platform === "linux",
		liveAws: false,
		networkAccess: "owned-loopback-only",
	});
}

async function compileSyntheticWorker(entry: string, outfile: string): Promise<void> {
	const transformers = createRequire(import.meta.url)("@huggingface/transformers/package.json") as { version: string };
	await compileCodingAgent({
		repoRoot: path.resolve(import.meta.dir, "../../.."),
		entrypoint: path.resolve(import.meta.dir, "fixtures", entry),
		outfile,
		transformersVersion: transformers.version,
		native: { platform: process.platform, arch: process.arch },
	});
}

for (const mode of ["source", "compiled"] as const) {
	test.skipIf(process.platform === "win32")(
		`native Write xd://aws preserves admission, immutable approval, guards, and real stdin delivery (${mode} worker)`,
		async () => {
			const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aws-secret-input-native-")));
			const root = path.join(workspace, "runtime");
			try {
				await fs.mkdir(root);
				let compiledWorker: string | undefined;
				let compiledMalformedWorker: string | undefined;
				if (mode === "compiled") {
					const buildRoot = path.join(workspace, "compiled");
					await fs.mkdir(buildRoot);
					compiledWorker = path.join(buildRoot, "worker");
					compiledMalformedWorker = path.join(buildRoot, "malformed-worker");
					await compileSyntheticWorker("aws-secret-input-lifecycle-worker.ts", compiledWorker);
					await compileSyntheticWorker("aws-secret-input-lifecycle-malformed-worker.ts", compiledMalformedWorker);
				}
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
						path.resolve(import.meta.dir, "fixtures/aws-secret-input-native.ts"),
						root,
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
							PI_TEST_AWS_SECRET_INPUT_WORKER_BINARY: compiledWorker,
							PI_TEST_AWS_SECRET_INPUT_MALFORMED_WORKER_BINARY: compiledMalformedWorker,
							...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
						},
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						signal: AbortSignal.timeout(150_000),
					},
				);
				try {
					const [stdout, stderr, exit] = await Promise.all([
						capture(child.stdout, 32_768),
						capture(child.stderr, 16_384),
						child.exited,
					]);
					let receipt: unknown;
					try {
						receipt = JSON.parse(stdout.text);
					} catch {}
					const failure =
						receipt && typeof receipt === "object" ? (receipt as Record<string, unknown>) : undefined;
					const failedCase =
						failure?.schema === "aws-secret-input-native-failure/v1"
							? ["setup", ...CASES].find(name => name === failure.case)
							: undefined;
					expect(
						exit === 0,
						`Native secret-input fixture failed; case=${failedCase ?? "startup"}; diagnostics are withheld`,
					).toBe(true);
					expect(stdout.overflow || stderr.overflow, "Fixture diagnostics exceeded their public bounds").toBe(
						false,
					);
					expect(stderr.text === "", "Fixture stderr is withheld").toBe(true);
					expect(safeReceipt(receipt), "Native secret-input evidence is incomplete; receipt is withheld").toBe(
						true,
					);
				} finally {
					if (child.exitCode === null) child.kill("SIGKILL");
					await child.exited;
				}
			} finally {
				await fs.rm(workspace, { recursive: true, force: true });
			}
		},
		mode === "compiled" ? 300_000 : 160_000,
	);
}
