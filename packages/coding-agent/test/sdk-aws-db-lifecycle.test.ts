import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyAwsDbSmokeStartup } from "./fixtures/aws-db-native-diagnostics";

const FAILURE_PHASES: Readonly<Record<string, true>> = {
	setup: true,
	"sdk-construction": true,
	"fresh-approval": true,
	"physical-read": true,
	"supported-fork": true,
	"cancelled-worker-exit": true,
	"returned-session-replay": true,
	"root-disposal-begin": true,
	"worker-exit-before-root-teardown": true,
	"closed-disposal-admission": true,
	"complete-root-teardown": true,
};

function diagnosticPhase(receipt: unknown): string {
	if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return "module-load";
	const value = receipt as Record<string, unknown>;
	return value.schema === "sdk-aws-db-lifecycle-failure/v1" &&
		typeof value.stage === "string" &&
		Object.hasOwn(FAILURE_PHASES, value.stage)
		? value.stage
		: "result";
}

const EXPECTED_RECEIPT = {
	schema: "sdk-aws-db-lifecycle/v1",
	primaryFactoryCalls: 1,
	readStarted: true,
	scopeAborted: true,
	failureCode: "CANCELLED",
	workers: 1,
	workerExitCode: 0,
	workerExitedBeforeResult: true,
	updates: 0,
	guardSteps: 7,
	modelDispatches: 0,
	physical: "synthetic-mysql-over-real-tls",
	liveAws: false,
	hostedDatabase: false,
};

const EXPECTED_TRANSITIONS = {
	fork: {
		kind: "fork",
		identityChanged: true,
		returnedToOriginalSession: true,
		staleGrantRejected: true,
	},
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

for (const scenario of ["fork", "dispose"] as const) {
	test.skipIf(process.platform === "win32")(
		`SDK-created aws_db cancels and joins its real physical worker across ${scenario === "fork" ? "session.fork" : "disposal begin"}`,
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-aws-db-lifecycle-"));
			try {
				const guardPath = path.join(root, "native-dcg");
				const guard = `#!${process.execPath}\n${await Bun.file(
					path.resolve(import.meta.dir, "fixtures/aws-db-native-dcg.ts"),
				).text()}`;
				await fs.writeFile(guardPath, guard, { mode: 0o755 });
				const policyPath = path.join(root, "dcg.toml");
				const policy = '[packs]\nenabled = ["fixture_aws_db"]\n';
				await fs.writeFile(policyPath, policy);
				const child = Bun.spawn(
					[
						process.execPath,
						"--no-env-file",
						"--no-install",
						path.resolve(import.meta.dir, "fixtures/sdk-aws-db-lifecycle-probe.ts"),
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
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					let receipt: unknown;
					let parsed = false;
					try {
						receipt = JSON.parse(stdout);
						parsed = true;
					} catch {}
					const phase = diagnosticPhase(receipt);
					const startup = classifyAwsDbSmokeStartup(stderr);
					expect(
						exit === 0,
						`SDK lifecycle subprocess failed; phase=${phase}; startup=${startup}; diagnostics are withheld`,
					).toBe(true);
					expect(stderr.length === 0, "SDK lifecycle emitted stderr; diagnostics are withheld").toBe(true);
					expect(parsed, "SDK lifecycle receipt was invalid; captured output is withheld").toBe(true);
					const expected = { ...EXPECTED_RECEIPT, transition: EXPECTED_TRANSITIONS[scenario] };
					expect(
						Bun.deepEquals(receipt, expected),
						"SDK lifecycle proof was incomplete; receipt is withheld",
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
