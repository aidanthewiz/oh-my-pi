import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const READ_CLI_URL = new URL("../src/cli/read-cli.ts", import.meta.url).href;

function createFixture(tempDir: TempDir): { agentDir: string; home: string; project: string; runnerPath: string } {
	const agentDir = tempDir.join("agent");
	const home = tempDir.join("home");
	const project = tempDir.join("project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
	const runnerPath = tempDir.join("read-cli-runner.ts");
	fs.writeFileSync(
		runnerPath,
		`import { runReadCommand } from ${JSON.stringify(READ_CLI_URL)};\nawait runReadCommand({ path: process.argv[2] });\n`,
	);
	return { agentDir, home, project, runnerPath };
}

async function runRead(
	fixture: { agentDir: string; home: string; project: string; runnerPath: string },
	target: string,
): Promise<{ output: string; exitCode: number }> {
	const child = Bun.spawn([process.execPath, fixture.runnerPath, target], {
		cwd: fixture.project,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: fixture.home,
			PI_CODING_AGENT_DIR: fixture.agentDir,
			PI_TEST_RUNTIME: "1",
			AWS_EC2_METADATA_DISABLED: "true",
			AWS_SHARED_CREDENTIALS_FILE: path.join(fixture.home, "no-credentials"),
			AWS_CONFIG_FILE: path.join(fixture.home, "no-config"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { output: `${stdout}\n${stderr}`, exitCode };
}

describe("read CLI query ownership", () => {
	it("reads literal q filenames without opening unrelated vision credentials", async () => {
		using tempDir = TempDir.createSync("@pi-read-cli-literal-q-");
		const fixture = createFixture(tempDir);
		fs.writeFileSync(path.join(fixture.agentDir, "auth.db"), "invalid SQLite credentials database");
		fs.writeFileSync(path.join(fixture.project, "notes?q=literal"), "literal question filename contents\n");
		fs.writeFileSync(path.join(fixture.project, "README"), "companion literal contents\n");
		for (const target of ["notes?q=literal", "notes?q=literal;README"]) {
			const result = await runRead(fixture, target);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("literal question filename contents");
			if (target.includes(";")) expect(result.output).toContain("companion literal contents");
		}
	}, 60_000);

	it("keeps URL-looking image question text inside one real vision request", async () => {
		using tempDir = TempDir.createSync("@pi-read-cli-imgq-");
		const fixture = createFixture(tempDir);
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push(new URL(request.url).pathname);
				return Response.json(
					{ error: { message: "synthetic request rejection", type: "invalid_request_error" } },
					{ status: 400 },
				);
			},
		});
		try {
			fs.writeFileSync(
				path.join(fixture.project, ".omp", "config.yml"),
				'modelRoles:\n  vision: "testvision/vmodel"\nimages:\n  questionTimeoutMs: 3000\n',
			);
			fs.writeFileSync(
				path.join(fixture.agentDir, "models.yml"),
				`providers:
  testvision:
    api: openai-completions
    baseUrl: ${server.url.origin}/v1
    apiKey: "test-key"
    models:
      - id: vmodel
        name: Vision Test
        input: [text, image]
        contextWindow: 128000
        maxTokens: 4096
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`,
			);
			const pngPath = path.join(fixture.project, "test.png");
			fs.writeFileSync(pngPath, Buffer.from(PNG_1X1, "base64"));
			const result = await runRead(fixture, `${pngPath}?q=look;${server.url.origin}/unexpected.sqlite?q=other`);
			expect(requests, result.output).toEqual(["/v1/chat/completions"]);
			expect(result.exitCode).not.toBe(0);
		} finally {
			await server.stop(true);
		}
	}, 60_000);
});
