import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyAwsDbSmokeStartup, describeAwsDbSmokeFailure } from "../fixtures/aws-db-native-diagnostics";

const CASES = [
	"registered-schema-read-no-access",
	"registered-capability-no-access",
	"missing-device-no-access",
	"missing-execution-host-no-access",
	"incompatible-capability-no-access",
	"incompatible-worker-no-access",
	"public-fixture-arguments-denial",
	"native-policy-denial",
	"inner-policy-denial",
	"guard-denial",
	"guard-mandatory-once-approval",
	"missing-approval",
	"user-denial",
	"changed-approved-arguments",
	"changed-approval-session",
	"consumed-approval-no-replay",
	"identity-denial-before-secret",
	"tenant-denial-before-secret",
	"resource-denial-before-secret",
	"secret-version-denial-before-read",
	"physical-reader-bounded-source",
	"unsupported-source-withheld",
	"writable-node-denial",
	"promoted-node-denial",
	"replaced-session-denial",
	"cancelled-physical-read",
	"timed-out-physical-read",
	"provider-error-withholding",
	"physical-error-withholding",
] as const;

function receiptIsSafe(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const receipt = value as Record<string, unknown>;
	if (Object.keys(receipt).sort().join(",") !== "cases,counts,physical,schema") return false;
	if (receipt.schema !== "aws-db-native-smoke/v1" || !Array.isArray(receipt.cases)) return false;
	if (receipt.cases.length !== CASES.length) return false;
	for (let index = 0; index < CASES.length; index++) {
		const entry = receipt.cases[index] as Record<string, unknown> | undefined;
		if (!entry || Object.keys(entry).sort().join(",") !== "name,passed") return false;
		if (entry.name !== CASES[index] || entry.passed !== true) return false;
	}
	if (receipt.counts === null || typeof receipt.counts !== "object") return false;
	const counts = receipt.counts as Record<string, unknown>;
	const countKeys = [
		"approvals",
		"artifactAllocations",
		"exitedWorkers",
		"fileMutations",
		"guardSteps",
		"physicalConnectionsVerified",
		"physicalSourceReadsVerified",
		"providerScopes",
		"workers",
	];
	if (Object.keys(counts).sort().join(",") !== countKeys.sort().join(",")) return false;
	if (Object.values(counts).some(count => !Number.isSafeInteger(count) || (count as number) < 0)) return false;
	if (counts.artifactAllocations !== 0 || counts.fileMutations !== 0) return false;
	if ((counts.physicalConnectionsVerified as number) < 1 || (counts.physicalSourceReadsVerified as number) < 1)
		return false;
	if ((counts.workers as number) < 1 || counts.workers !== counts.exitedWorkers) return false;
	if (receipt.physical === null || typeof receipt.physical !== "object") return false;
	const physical = receipt.physical as Record<string, unknown>;
	return (
		Object.keys(physical).sort().join(",") ===
			"allClosed,authenticationVerified,dedicatedSocket,hostedAurora,liveAws,protocol,readerProof,sameConnection" &&
		physical.protocol === "synthetic-aurora-mysql-over-real-tls" &&
		physical.dedicatedSocket === true &&
		physical.readerProof === true &&
		physical.sameConnection === true &&
		physical.authenticationVerified === true &&
		physical.allClosed === true &&
		physical.liveAws === false &&
		physical.hostedAurora === false
	);
}

test.skipIf(process.platform === "win32")(
	"registered aws_db retains guarded native execution and memory-only physical TLS boundaries",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "aws-db-native-smoke-"));
		try {
			const guardPath = path.join(root, "native-dcg");
			const guardSource = `#!${process.execPath}\n${await Bun.file(
				path.resolve(import.meta.dir, "../fixtures/aws-db-native-dcg.ts"),
			).text()}`;
			await Bun.write(guardPath, guardSource);
			await fs.chmod(guardPath, 0o755);
			const policyPath = path.join(root, "dcg.toml");
			const policy = '[packs]\nenabled = ["fixture_aws_db"]\n';
			await Bun.write(policyPath, policy);
			const probe = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					"--no-install",
					path.resolve(import.meta.dir, "../fixtures/aws-db-native-smoke.ts"),
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
						OMP_DCG_BINARY_SHA256: new Bun.CryptoHasher("sha256").update(guardSource).digest("hex"),
						OMP_DCG_CONFIG: policyPath,
						OMP_DCG_CONFIG_SHA256: new Bun.CryptoHasher("sha256").update(policy).digest("hex"),
						...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
					},
					signal: AbortSignal.timeout(180_000),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(probe.stdout).text(),
				new Response(probe.stderr).text(),
				probe.exited,
			]);
			let receipt: unknown;
			try {
				receipt = JSON.parse(stdout);
			} catch {
				receipt = undefined;
			}
			const failure = receipt && typeof receipt === "object" ? (receipt as Record<string, unknown>) : undefined;
			const failedCase =
				failure?.schema === "aws-db-native-smoke-failure/v1" && failure.passed === false
					? ["setup", ...CASES].find(name => name === failure.case)
					: undefined;
			expect(
				exit === 0,
				failedCase
					? `native smoke boundary failed (${failedCase};${describeAwsDbSmokeFailure(failure)}); captured diagnostics are withheld`
					: `native smoke subprocess failed (${classifyAwsDbSmokeStartup(stderr)}); captured diagnostics are withheld`,
			).toBe(true);
			expect(stderr.length === 0, "native smoke stderr boundary failed; diagnostics are withheld").toBe(true);
			expect(receiptIsSafe(receipt), "native smoke safe receipt boundary failed").toBe(true);
			console.info(JSON.stringify(receipt));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	190_000,
);
