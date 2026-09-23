import { describe, expect, test } from "bun:test";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { isScrubbedEnvVar } from "./ci-test-ts.ts";

describe("CI test child environment", () => {
	test("scrubs profile, managed-model, and provider state inherited from Coreforge", () => {
		for (const name of [
			"BUN_OPTIONS",
			"OMP_NO_ENV_FILE",
			"OMP_DOTENV_OVERRIDE",
			"OMP_PROFILE",
			"OMPPROFILE",
			"PI_PROFILE",
			"PI_CODING_AGENT_DIR",
			"PI_CONFIG_DIR",
			"OMP_AGENT_STRIP",
			"OMP_CF_PRODUCT_VERSION",
			"OMP_CF_VERSION",
			"OMP_MODEL_ALLOW",
			"OMP_MODEL_AWS_PROFILE",
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_CUSTOM_HEADERS",
			"ANTHROPIC_AWS_WORKSPACE_ID",
			"ANTHROPIC_API_KEY",
			"AWS_PROFILE",
			"DCG_EXPECTED_AT_STARTUP",
		]) {
			expect(isScrubbedEnvVar(name), name).toBe(true);
		}
	});

	test("retains test-runner controls", () => {
		for (const name of ["OMP_TEST_CONCURRENCY", "OMP_TEST_CHUNK_TIMEOUT", "PI_TEST_RUNTIME"]) {
			expect(isScrubbedEnvVar(name), name).toBe(false);
		}
	});
});

describe("test runner watchdog", () => {
	// Parent fake timers cannot drive the real watchdog inside the isolated runner process.
	test("kills a stalled chunk, reports failure, and continues the queue", async () => {
		using dir = TempDir.createSync("omp-test-runner-watchdog-");
		const started = dir.join("started");
		const completed = dir.join("completed");
		const continued = dir.join("continued");
		const stalledCommand = [
			process.execPath,
			"-e",
			`await Bun.write(${JSON.stringify(started)}, "started"); await Bun.sleep(60_000); await Bun.write(${JSON.stringify(completed)}, "completed");`,
		];
		const nextCommand = [process.execPath, "-e", `await Bun.write(${JSON.stringify(continued)}, "continued");`];
		const commands = [
			{ label: "stalled chunk", cwd: ".", command: stalledCommand },
			{ label: "following chunk", cwd: ".", command: nextCommand },
		];
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`import { runTestCommandsInParallel } from ${JSON.stringify(import.meta.resolve("./ci-test-ts.ts"))}; await runTestCommandsInParallel(${JSON.stringify(commands)}, 1);`,
			],
			{
				env: { ...Bun.env, OMP_TEST_CHUNK_TIMEOUT: "1", NO_COLOR: "1" },
				timeout: 10_000,
				detached: true,
				allowNonZero: true,
			},
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("[watchdog]");
		expect(await Bun.file(started).exists()).toBe(true);
		expect(await Bun.file(completed).exists()).toBe(false);
		expect(await Bun.file(continued).text()).toBe("continued");
	}, 15_000);
});
