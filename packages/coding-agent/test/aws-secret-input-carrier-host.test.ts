import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { AWS_SECRET_INPUT_CAPABILITY } from "../src/tools/aws-secret-input-contract";
import { createAwsSecretInputNativeGuardLauncher } from "./fixtures/aws-secret-input-native-dcg";

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

for (const language of ["js", "py"] as const) {
	test.skipIf(process.platform === "win32" || (language === "py" && process.env.PI_PYTHON_INTEGRATION !== "1"))(
		language === "js"
			? "actual SDK and JS Eval carriers refuse AWS secret input while native dispatch owns approval and cleanup"
			: "actual Python Eval refuses canonical AWS and Write capability probes and secret delivery before protected work",
		async () => {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aws-secret-input-carrier-host-")));
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
						path.resolve(import.meta.dir, "fixtures/aws-secret-input-carrier-host-probe.ts"),
						root,
						language,
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
							XDG_STATE_HOME: root,
							PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
							OMP_DOTENV_OVERRIDE: "1",
							OMP_CF_PRODUCT_VERSION: "fixture",
							BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
							DO_NOT_TRACK: "1",
							OMP_DCG_PATH: guardPath,
							OMP_DCG_VERSION: "fixture",
							OMP_DCG_BINARY_SHA256: new Bun.CryptoHasher("sha256").update(guard).digest("hex"),
							OMP_DCG_CONFIG: policyPath,
							OMP_DCG_CONFIG_SHA256: new Bun.CryptoHasher("sha256").update(policy).digest("hex"),
							...(language === "py"
								? { CARRIER_PYTHON: process.env.CARRIER_PYTHON ?? Bun.which("python3") ?? "/usr/bin/python3" }
								: {}),
						},
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						signal: AbortSignal.timeout(110_000),
					},
				);
				try {
					const [stdout, stderr, exit] = await Promise.all([
						capture(child.stdout, 16_384),
						capture(child.stderr, 4_096),
						child.exited,
					]);
					let receipt: unknown;
					try {
						receipt = JSON.parse(stdout.text);
					} catch {}
					const summary = isRecord(receipt) ? receipt : undefined;
					const stage =
						typeof summary?.stage === "string" && /^[a-z-]{1,80}$/u.test(summary.stage)
							? summary.stage
							: "startup";
					expect(exit === 0, `Carrier fixture failed at ${stage}; diagnostics are withheld`).toBe(true);
					expect(stdout.overflow || stderr.overflow, "Fixture diagnostics exceeded their public bounds").toBe(
						false,
					);
					expect(stderr.text === "", "Carrier fixture stderr is withheld").toBe(true);
					const expectedDenials: string[] = [];
					for (const kind of ["transfer", "capability"]) {
						if (language === "js") {
							for (const carrier of [
								"raw-aws",
								"canonical-aws",
								"canonical-write",
								"copied-write",
								"bridge-aws",
								"bridge-write",
							])
								expectedDenials.push(`sdk-${carrier}-${kind}`);
						}
						for (const carrier of ["aws", "write", "copied-write"])
							expectedDenials.push(`${language}-eval-${carrier}-${kind}`);
					}
					if (language === "js")
						expectedDenials.push(
							"preflight-write-canonical-aws",
							"preflight-write-canonical-write",
							"preflight-write-nested-native-dispatch",
							"result-write-canonical-aws",
							"result-write-canonical-write",
							"stale-canonical-aws",
							"stale-canonical-write",
							"held-canonical-write",
							"held-bridge-aws",
							"preflight-aws-canonical-aws",
							"preflight-aws-canonical-write",
							"result-aws-canonical-aws",
							"result-aws-canonical-write",
						);
					expect(summary?.denied).toEqual(expectedDenials);
					const counts = isRecord(summary?.counts) ? summary.counts : undefined;
					if (language === "py") {
						expect(counts).toEqual({
							ui: 0,
							probeWorker: 0,
							launch: 0,
							runWorker: 0,
							providerFiles: 0,
							providerClients: 0,
							providerRequests: 0,
							providerDestroyed: 0,
							receiver: 0,
							cleanupComplete: 0,
						});
						expect(summary?.native).toBeNull();
					} else {
						expect(counts?.ui).toBe(3);
						expect(counts?.launch).toBe(3);
						expect(counts?.runWorker).toBe(3);
						expect(counts?.providerRequests).toBe(6);
						expect(counts?.providerDestroyed).toBe(counts?.providerClients);
						expect(counts?.receiver).toBe(3);
						expect(counts?.cleanupComplete).toBe(3);
						const native = isRecord(summary?.native) ? summary.native : undefined;
						expect(native?.capability).toEqual(AWS_SECRET_INPUT_CAPABILITY);
						const capabilityRoutes = native?.capabilityRoutes;
						expect(Array.isArray(capabilityRoutes)).toBe(true);
						if (!Array.isArray(capabilityRoutes)) throw new Error("Missing native capability receipts");
						expect(
							capabilityRoutes.map(route => ({
								stage: route.stage,
								compatible: Bun.deepEquals(route.capability, AWS_SECRET_INPUT_CAPABILITY),
								protectedActivity: route.protectedActivity,
							})),
						).toEqual(
							[
								"native-hashline-content-capability",
								"native-inner-intent-capability",
								"native-mounted-aws-capability",
								"native-top-level-write-capability",
							].map(stage => ({
								stage,
								compatible: true,
								protectedActivity: {
									ui: 0,
									launch: 0,
									runWorker: 0,
									providerFiles: 0,
									providerClients: 0,
									providerRequests: 0,
									providerDestroyed: 0,
									receiver: 0,
									cleanupComplete: 0,
								},
							})),
						);
						expect(native?.stdout).toBe("carrier-input-approved\n");
						expect(native?.directStdout).toBe("carrier-input-approved\n");
						expect(native?.resultHandlers).toEqual({ write: 1, aws: 1 });
						expect(native?.cancelled).toBe(true);
						expect(native?.cleanupRemoved).toBe(true);
					}
				} finally {
					if (child.exitCode === null) child.kill("SIGKILL");
					await child.exited;
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		120_000,
	);
}
