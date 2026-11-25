import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

const fixtures = [
	...["natives", "tui", "collab-web", "typescript-edit-benchmark"].map(name => ({
		name,
		file: path.join("packages", name, "consumer.test.ts"),
	})),
	{ name: "project-tui", file: path.join(".omp", "tests", "tui.test.ts") },
];
const consumers = fixtures.map(fixture => fixture.name);
const inspectedNames = [
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

async function prepareFixture(root: string): Promise<void> {
	await fs.mkdir(path.join(root, "scripts"), { recursive: true });
	for (const name of ["ci-test-ts.ts", "ci-disk-metadata.ts"]) {
		await fs.copyFile(new URL(`./${name}`, import.meta.url), path.join(root, "scripts", name));
	}
	await fs.symlink(path.resolve(import.meta.dir, "../node_modules"), path.join(root, "node_modules"), "junction");
	for (const { name, file } of fixtures) {
		const target = path.join(root, file);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(
			target,
			`import { test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
test("owned runner consumer", async () => {
 const output = process.env.RUNNER_TEST_OUTPUT;
 if (!output) throw new Error("Missing owned output directory");
 const name = ${JSON.stringify(name)};
 if (process.env.RUNNER_TEST_STALL === name) {
  const detached = Bun.spawn([process.execPath, "--no-env-file", "-e", "await Bun.sleep(60000)"], {
   detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  const started = path.join(output, name + ".started");
  await Bun.write(started + ".tmp", JSON.stringify({ pid: process.pid, detachedPid: detached.pid }));
  await fs.rename(started + ".tmp", started);
  await Bun.sleep(60000);
 }
 await Bun.write(path.join(output, name + ".json"), JSON.stringify({name, env: Object.fromEntries(${JSON.stringify(inspectedNames)}.map(key => [key, process.env[key] ?? null]))}));
});
`,
		);
	}
}

async function runFixture(root: string, output: string, overrides: Record<string, string | undefined> = {}) {
	root = path.resolve(root);
	output = path.resolve(output);
	await fs.mkdir(output, { recursive: true });
	const env = { ...Bun.env };
	delete env.OMP_TEST_SHARD;
	delete env.OMP_TEST_CHUNK_TIMEOUT;
	for (const [name, value] of Object.entries({
		CI: "1",
		NO_COLOR: "1",
		OMP_TEST_CONCURRENCY: "1",
		OMP_TEST_TIMEOUT: "60000",
		RUNNER_TEST_OUTPUT: output,
		...overrides,
	})) {
		if (value === undefined) delete env[name];
		else env[name] = value;
	}
	return ptree.exec([process.execPath, "--no-env-file", path.join(root, "scripts/ci-test-ts.ts"), "native"], {
		cwd: root,
		env,
		timeout: 15_000,
		detached: true,
		allowNonZero: true,
	});
}

async function completedConsumers(output: string): Promise<string[]> {
	return (await fs.readdir(output)).filter(name => name.endsWith(".json")).sort();
}

describe("CI runner process boundaries", () => {
	test("isolates provider credentials and managed state while retaining runner controls", async () => {
		using dir = TempDir.createSync("omp-test-runner-env-");
		await prepareFixture(dir.path());
		const output = dir.join("output");
		const result = await runFixture(dir.path(), output, {
			ANTHROPIC_API_KEY: "synthetic-secret",
			AWS_PROFILE: "synthetic-profile",
			PI_PROFILE: "synthetic-profile",
			OMP_MODEL_ALLOW: "synthetic-model",
			OMP_CF_VERSION: "synthetic-version",
			DCG_EXPECTED_AT_STARTUP: "synthetic-policy",
			GH_TOKEN: "synthetic-token",
			OMP_TEST_CONCURRENCY: "3",
		});
		expect(result.exitCode, result.stderr || result.stdout).toBe(0);
		expect(await completedConsumers(output)).toEqual(consumers.map(name => `${name}.json`).sort());
		for (const name of consumers) {
			const observed = await Bun.file(path.join(output, `${name}.json`)).json();
			for (const key of inspectedNames.slice(0, 7)) expect(observed.env[key], key).toBeNull();
			expect(observed.env.OMP_TEST_CONCURRENCY).toBe("3");
			expect(observed.env.PI_TEST_RUNTIME).toBe("1");
		}
	}, 20_000);

	// Real subprocess deadlines and process-table transitions require the platform clock.
	for (const concurrency of ["1", undefined]) {
		test(`retires a stalled chunk and its detached worker (${concurrency ? "pooled" : "sequential"})`, async () => {
			using dir = TempDir.createSync("omp-test-runner-watchdog-");
			await prepareFixture(dir.path());
			const output = dir.join("output");
			const unrelated = Bun.spawn([process.execPath, "--no-env-file", "-e", "await Bun.sleep(60000)"], {
				detached: true,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			const unrelatedHandle = Process.fromPid(unrelated.pid);
			let owner: Process | null = null;
			let detached: Process | null = null;
			const pending = runFixture(dir.path(), output, {
				OMP_TEST_CONCURRENCY: concurrency,
				OMP_TEST_CHUNK_TIMEOUT: "1",
				RUNNER_TEST_STALL: "natives",
			});
			try {
				const startedPath = path.join(output, "natives.started");
				const startedDeadline = Date.now() + 5000;
				while (!(await Bun.file(startedPath).exists()) && Date.now() < startedDeadline) await Bun.sleep(10);
				const started = await Bun.file(startedPath).json();
				owner = Process.fromPid(started.pid);
				detached = Process.fromPid(started.detachedPid);
				expect(owner?.status()).toBe(ProcessStatus.Running);
				expect(detached?.status()).toBe(ProcessStatus.Running);
				if (process.platform !== "win32") {
					expect(detached?.groupId()).toBe(started.detachedPid);
					expect(detached?.groupId()).not.toBe(owner?.groupId());
				}
				const result = await pending;
				expect(result.exitCode, result.stderr || result.stdout).toBe(1);
				const exitDeadline = Date.now() + 1000;
				while (
					(owner?.status() === ProcessStatus.Running || detached?.status() === ProcessStatus.Running) &&
					Date.now() < exitDeadline
				) {
					await Bun.sleep(10);
				}
				expect(owner?.status()).not.toBe(ProcessStatus.Running);
				expect(detached?.status()).not.toBe(ProcessStatus.Running);
				expect(unrelatedHandle?.status()).toBe(ProcessStatus.Running);
				expect(await Bun.file(path.join(output, "natives.json")).exists()).toBe(false);
				expect(await completedConsumers(output)).toEqual(
					concurrency
						? consumers
								.slice(1)
								.map(name => `${name}.json`)
								.sort()
						: [],
				);
			} finally {
				if (detached?.status() === ProcessStatus.Running) detached.killTree(9);
				if (owner?.status() === ProcessStatus.Running) owner.killTree(9);
				unrelated.kill("SIGKILL");
				await unrelated.exited;
				await pending;
			}
		}, 20_000);
	}

	test("shards execute every chunk exactly once and remain balanced", async () => {
		using dir = TempDir.createSync("omp-test-runner-shards-");
		await prepareFixture(dir.path());
		const selected: string[][] = [];
		for (let index = 1; index <= 3; index++) {
			const output = dir.join(`shard-${index}`);
			const result = await runFixture(dir.path(), output, { OMP_TEST_SHARD: `${index}/3` });
			expect(result.exitCode, result.stderr || result.stdout).toBe(0);
			selected.push(await completedConsumers(output));
		}
		expect(selected.flat().sort()).toEqual(consumers.map(name => `${name}.json`).sort());
		const widths = selected.map(rows => rows.length);
		expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
	}, 20_000);

	test("rejects malformed and empty shard requests without running consumers", async () => {
		using dir = TempDir.createSync("omp-test-runner-invalid-shard-");
		await prepareFixture(dir.path());
		const emptyShard = `${consumers.length + 1}/${consumers.length + 1}`;
		for (const [index, spec] of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3", emptyShard].entries()) {
			const output = dir.join(`invalid-${index}`);
			const result = await runFixture(dir.path(), output, { OMP_TEST_SHARD: spec });
			expect(result.exitCode).not.toBe(0);
			expect(await fs.readdir(output)).toEqual([]);
		}
	}, 20_000);

	test("rejects invalid concurrency before dispatching a consumer", async () => {
		using dir = TempDir.createSync("omp-test-runner-invalid-concurrency-");
		await prepareFixture(dir.path());
		for (const [index, spec] of ["0", "-1", "many"].entries()) {
			const output = dir.join(`invalid-${index}`);
			const result = await runFixture(dir.path(), output, { OMP_TEST_CONCURRENCY: spec });
			expect(result.exitCode).not.toBe(0);
			expect(await fs.readdir(output)).toEqual([]);
		}
	}, 20_000);
});
