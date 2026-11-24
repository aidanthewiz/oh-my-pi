import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnManagedChild } from "@oh-my-pi/pi-coding-agent/daemon/children";
import { buildServerSpec } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { StdioUpstream } from "@oh-my-pi/pi-coding-agent/mcp/host/stdio-upstream";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { TempDir } from "@oh-my-pi/pi-utils";

async function start(config: MCPStdioServerConfig): Promise<StdioUpstream> {
	const spec = buildServerSpec(config, config.cwd);
	if (spec.transport !== "stdio") throw new Error("Expected a stdio specification");
	const upstream = new StdioUpstream(spec);
	try {
		await upstream.connect(spawnManagedChild);
		return upstream;
	} catch (error) {
		await upstream.close();
		throw error;
	}
}

async function captured(file: string): Promise<Record<string, string | undefined>> {
	const deadline = Date.now() + 2_000;
	while (!(await Bun.file(file).exists())) {
		if (Date.now() >= deadline) throw new Error("Child did not capture its environment");
		await Bun.sleep(10);
	}
	return Bun.file(file).json();
}

const WAIT_FOR_INPUT_END = "process.stdin.on('end', () => process.exit(0)); process.stdin.resume();";

function captureValue(expression: string): string {
	return `const captureFs = require('node:fs'); const capturePath = process.argv[1]; captureFs.writeFileSync(capturePath + '.pending', JSON.stringify(${expression})); captureFs.renameSync(capturePath + '.pending', capturePath); ${WAIT_FOR_INPUT_END}`;
}

function captureEnvironment(keys: string[]): string {
	return captureValue(`Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))`);
}

describe("MCP managed-child environment", () => {
	it("removes project dotenv values while preserving explicit server environment", async () => {
		using root = TempDir.createSync("@omp-mcp-env-");
		const projectKey = `OMP_MCP_PROJECT_SECRET_${crypto.randomUUID().replaceAll("-", "")}`;
		const explicitKey = `OMP_MCP_EXPLICIT_${crypto.randomUUID().replaceAll("-", "")}`;
		const output = root.join("environment.json");
		const previous = Bun.env[projectKey];
		await fs.writeFile(root.join(".env"), `${projectKey}=project-controlled-secret\n`);
		Bun.env[projectKey] = "project-controlled-secret";
		let upstream: StdioUpstream | undefined;
		try {
			upstream = await start({
				type: "stdio",
				command: process.execPath,
				args: ["-e", captureEnvironment([projectKey, explicitKey]), output],
				cwd: root.path(),
				env: { [explicitKey]: "explicit-server-value" },
			});
			const environment = await captured(output);
			expect(environment[projectKey]).toBeUndefined();
			expect(environment[explicitKey]).toBe("explicit-server-value");
		} finally {
			await upstream?.close();
			if (previous === undefined) delete Bun.env[projectKey];
			else Bun.env[projectKey] = previous;
		}
	});

	it("does not let explicit server environment reopen managed dotenv loading", async () => {
		using root = TempDir.createSync("@omp-mcp-managed-env-");
		const agentDir = root.join("agent");
		const output = root.join("environment.json");
		const secretKey = `OMP_MCP_MANAGED_${crypto.randomUUID().replaceAll("-", "")}`;
		const projectKey = `OMP_MCP_PROJECT_${crypto.randomUUID().replaceAll("-", "")}`;
		await fs.mkdir(agentDir);
		await fs.writeFile(path.join(agentDir, ".env"), `${secretKey}=managed-profile-secret\n`);
		await fs.writeFile(root.join(".env"), `${projectKey}=project-dotenv\n`);
		const envModule = pathToFileURL(path.resolve(import.meta.dir, "../../../utils/src/env.ts")).href;
		const values = `{ secret: $env[${JSON.stringify(secretKey)}], project: process.env[${JSON.stringify(projectKey)}], sentinel: process.env.OMP_NO_ENV_FILE }`;
		const script = `const { $env } = await import(${JSON.stringify(envModule)}); ${captureValue(values)}`;
		const upstream = await start({
			type: "stdio",
			command: process.execPath,
			args: ["-e", script, output],
			cwd: root.path(),
			env: { BUN_OPTIONS: "", OMP_NO_ENV_FILE: "0", OMP_PROFILE: "", PI_CODING_AGENT_DIR: agentDir, PI_PROFILE: "" },
		});
		try {
			const environment = await captured(output);
			expect(environment.secret).toBeUndefined();
			expect(environment.project).toBeUndefined();
			expect(environment.sentinel).toBe("1");
		} finally {
			await upstream.close();
		}
	});

	it("forwards immutable operational metadata only to the managed proxy", async () => {
		using root = TempDir.createSync("@omp-mcp-operational-env-");
		const keys = [
			"OMP_OPERATIONAL_AWS_CONFIG_FILE",
			"OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE",
			"OMP_OPERATIONAL_AWS_PROFILE",
			"OMP_OPERATIONAL_AWS_REGION",
			"OMP_OPERATIONAL_AWS_EXECUTABLE",
			"OMP_OPERATIONAL_AWS_HOME_DIRECTORY",
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_SESSION_TOKEN",
			"AWS_PROFILE",
			"AWS_REGION",
		];
		const trusted = {
			OMP_OPERATIONAL_AWS_CONFIG_FILE: root.join("trusted-config"),
			OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: root.join("trusted-credentials"),
			OMP_OPERATIONAL_AWS_PROFILE: "trusted-profile",
			OMP_OPERATIONAL_AWS_REGION: "us-gov-west-1",
			OMP_OPERATIONAL_AWS_EXECUTABLE: root.join("trusted-aws"),
			OMP_OPERATIONAL_AWS_HOME_DIRECTORY: root.path(),
		};
		const untrusted = Object.fromEntries(keys.map(key => [key, `project-${key}`]));
		await fs.writeFile(
			root.join(".env"),
			Object.entries(untrusted)
				.map(([key, value]) => `${key}=${value}`)
				.join("\n"),
		);
		const clientUrl = new URL("../../src/mcp/client.ts", import.meta.url).href;
		const upstreamUrl = new URL("../../src/mcp/host/stdio-upstream.ts", import.meta.url).href;
		const childrenUrl = new URL("../../src/daemon/children.ts", import.meta.url).href;
		const outputs = [root.join("managed.json"), root.join("generic.json")];
		const script = `
const { buildServerSpec } = await import(${JSON.stringify(clientUrl)});
const { StdioUpstream } = await import(${JSON.stringify(upstreamUrl)});
const { spawnManagedChild } = await import(${JSON.stringify(childrenUrl)});
for (const key of Object.keys(process.env)) if (key.startsWith('OMP_OPERATIONAL_AWS_')) delete process.env[key];
const capture = ${JSON.stringify(captureEnvironment(keys))};
const outputs = ${JSON.stringify(outputs)};
for (let i = 0; i < outputs.length; i++) {
  const spec = buildServerSpec({ type: 'stdio', command: process.execPath, args: ['-e', capture, outputs[i]], cwd: process.cwd(), env: ${JSON.stringify(untrusted)} }, process.cwd(), { preserveOperationalAws: i === 0 });
  const upstream = new StdioUpstream(spec);
  try {
    await upstream.connect(spawnManagedChild);
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(outputs[i]).exists())) {
      if (Date.now() >= deadline) throw new Error('Child did not capture its environment');
      await Bun.sleep(10);
    }
  } finally { await upstream.close(); }
}
console.log(JSON.stringify({ managed: await Bun.file(outputs[0]).json(), generic: await Bun.file(outputs[1]).json() }));`;
		const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
			cwd: root.path(),
			env: {
				...Object.fromEntries(
					Object.entries(Bun.env).filter(
						([key]) => !key.startsWith("OMP_OPERATIONAL_AWS_") && !key.startsWith("AWS_"),
					),
				),
				HOME: root.path(),
				PI_CODING_AGENT_DIR: root.path(),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				...trusted,
				AWS_ACCESS_KEY_ID: "ambient-access-key",
				AWS_SECRET_ACCESS_KEY: "ambient-secret-key",
				AWS_SESSION_TOKEN: "ambient-session-token",
				AWS_PROFILE: "ambient-profile",
				AWS_REGION: "ambient-region",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		const result = JSON.parse(stdout) as {
			managed: Record<string, string | undefined>;
			generic: Record<string, string | undefined>;
		};
		expect(result.managed).toMatchObject(trusted);
		for (const key of keys.filter(key => key.startsWith("AWS_"))) expect(result.managed[key]).toBeUndefined();
		for (const key of keys) expect(result.generic[key]).toBeUndefined();
	});
});
