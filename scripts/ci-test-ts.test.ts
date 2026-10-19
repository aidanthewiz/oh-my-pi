import { describe, expect, test } from "bun:test";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { selectShard } from "./ci-test-ts.ts";

describe("CI test child environment", () => {
	test("isolates provider credentials and managed state while retaining runner controls", async () => {
		using dir = TempDir.createSync("omp-test-runner-env-");
		const output = dir.join("child-env.json");
		const names = [
			"ANTHROPIC_API_KEY",
			"AWS_PROFILE",
			"PI_PROFILE",
			"OMP_MODEL_ALLOW",
			"OMP_CF_VERSION",
			"DCG_EXPECTED_AT_STARTUP",
			"GH_TOKEN",
			"OMP_TEST_CONCURRENCY",
			"PI_TEST_RUNTIME",
		];
		const childCommand = [
			process.execPath,
			"-e",
			`await Bun.write(${JSON.stringify(output)}, JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(k => [k, process.env[k] ?? null]))));`,
		];
		const result = await ptree.exec(
			[
				process.execPath,
				"-e",
				`import { runTestCommandsInParallel } from ${JSON.stringify(import.meta.resolve("./ci-test-ts.ts"))}; await runTestCommandsInParallel([{ label: "inspect env", cwd: ".", command: ${JSON.stringify(childCommand)} }], 1);`,
			],
			{
				env: {
					...Bun.env,
					ANTHROPIC_API_KEY: "synthetic-secret",
					AWS_PROFILE: "synthetic-profile",
					PI_PROFILE: "synthetic-profile",
					OMP_MODEL_ALLOW: "synthetic-model",
					OMP_CF_VERSION: "synthetic-version",
					DCG_EXPECTED_AT_STARTUP: "synthetic-policy",
					GH_TOKEN: "synthetic-token",
					OMP_TEST_CONCURRENCY: "3",
				},
				timeout: 10_000,
				detached: true,
				allowNonZero: true,
			},
		);
		expect(result.exitCode).toBe(0);
		const observed = await Bun.file(output).json();
		for (const name of names.slice(0, 7)) expect(observed[name], name).toBeNull();
		expect(observed.OMP_TEST_CONCURRENCY).toBe("3");
		expect(observed.PI_TEST_RUNTIME).toBe("1");
	}, 15_000);
});

describe("test runner watchdog", () => {
	// Parent fake timers cannot drive the real watchdog inside the isolated runner process.
	test("kills a stalled chunk, reports failure, and continues the queue", async () => {
		using dir = TempDir.createSync("@omp-test-runner-watchdog-");
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
		expect(await Bun.file(started).exists()).toBe(true);
		expect(await Bun.file(completed).exists()).toBe(false);
		expect(await Bun.file(continued).text()).toBe("continued");
	}, 15_000);
});

describe("OMP_TEST_SHARD", () => {
	test("shards partition every chunk exactly once, balanced to within one", () => {
		const chunks = Array.from({ length: 79 }, (_, i) => i);
		const shards = [1, 2, 3].map(i => selectShard(chunks, `${i}/3`));
		expect(shards.flat().sort((a, b) => a - b)).toEqual(chunks);
		const sizes = shards.map(s => s.length);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
		expect(selectShard(chunks, "1/1")).toEqual(chunks);
		expect(selectShard(chunks, undefined)).toEqual(chunks);
	});

	test("rejects malformed specs instead of running an empty or partial shard", () => {
		for (const spec of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3"]) {
			expect(() => selectShard([1, 2, 3], spec)).toThrow(Error);
		}
	});

	test("rejects a shard that selects no chunks", () => {
		expect(() => selectShard([1], "2/2")).toThrow(Error);
		expect(() => selectShard([], "1/1")).toThrow(Error);
	});
});
