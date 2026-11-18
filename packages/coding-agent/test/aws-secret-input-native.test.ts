import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { compileCodingAgent } from "../scripts/compile-binary";
import { createAwsSecretInputNativeGuardLauncher } from "./fixtures/aws-secret-input-native-dcg";
import {
	isLocallyAnonymousStdinChannel,
	isVerifiedStdinProducerWitness,
} from "./fixtures/aws-secret-input-stdin-metadata";
import { LIFECYCLE_SENSITIVE_MARKER } from "./fixtures/aws-secret-input-lifecycle-values";
import {
	assertAwsSecretInputNativeFileBytes,
	assertAwsSecretInputNativeFiles,
} from "./fixtures/aws-secret-input-native";
import { rejectionOf } from "./helpers/rejection";

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
const CASE_NAMES = new Set<string>(["setup", ...CASES]);
const PHASE_NAMES = new Set<string>([
	"case",
	"result",
	"files",
	"done",
	"cleanup",
	"cleanup-files",
	"inspection",
	"inspection-done",
]);

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
	if (!isLocallyAnonymousStdinChannel(stdinPrivateChannel) || !isVerifiedStdinProducerWitness(stdinProducerWitness))
		return false;
	if (typeof receipt.workerSocketIdentitiesCompared !== "boolean") return false;
	if (
		process.platform === "linux"
			? receipt.workerSocketIdentitiesCompared !== true || receipt.guardianSocketIdentitiesCompared !== true
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

test("owned-file inspection reads beyond eight MiB without rejecting public binary assets", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "aws-native-file-inspection-"));
	try {
		const file = await fs.open(path.join(root, "public.bin"), "w+");
		try {
			await file.truncate(9 * 1024 * 1024);
			await file.write(new Uint8Array([0xff, 0x80, 0, 0xc0]), 0, 4, 0);
			await assertAwsSecretInputNativeFiles(root);
			const marker = Buffer.from(LIFECYCLE_SENSITIVE_MARKER);
			await file.write(marker, 0, marker.length, 8 * 1024 * 1024 + 31);
		} finally {
			await file.close();
		}
		expect(await rejectionOf(assertAwsSecretInputNativeFiles(root))).toBeInstanceOf(Error);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("owned-file inspection rejects a marker split across byte-sized chunks and closes the stream", async () => {
	const marker = Buffer.from(LIFECYCLE_SENSITIVE_MARKER);
	await assertAwsSecretInputNativeFileBytes(
		(async function* () {
			yield marker.subarray(0, -1);
			yield new Uint8Array([0xff]);
		})(),
	);
	let closed = false;
	const chunks = (async function* () {
		try {
			yield new Uint8Array([0xff, 0, 0x80]);
			for (let index = 0; index < marker.length; index++) yield marker.subarray(index, index + 1);
		} finally {
			closed = true;
		}
	})();
	expect(await rejectionOf(assertAwsSecretInputNativeFileBytes(chunks))).toBeInstanceOf(Error);
	expect(closed).toBe(true);
});

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
				let lastCase = "setup";
				let lastPhase = "startup";
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
						serialization: "json",
						ipc(message) {
							if (!message || typeof message !== "object" || Array.isArray(message)) return;
							const frame = message as Record<string, unknown>;
							if (
								Object.keys(frame).length !== 3 ||
								frame.type !== "native-phase" ||
								typeof frame.case !== "string" ||
								!CASE_NAMES.has(frame.case) ||
								typeof frame.phase !== "string" ||
								!PHASE_NAMES.has(frame.phase)
							)
								return;
							lastCase = frame.case;
							lastPhase = frame.phase;
						},
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
						`Native secret-input fixture failed; case=${failedCase ?? lastCase}; phase=${lastPhase}; exit=${exit}; signal=${child.signalCode ?? "none"}; diagnostics are withheld`,
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
