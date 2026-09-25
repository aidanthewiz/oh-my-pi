import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Launch provenance is captured at module import, so the bridge runs in a separate process.
test("managed AWS validates deferred legacy schemas against live profile bindings", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-aws-routing-"));
	try {
		const config = path.join(root, "config");
		await fs.writeFile(
			config,
			"[profile commercial]\nregion = us-east-1\nsso_session = shared\n[sso-session shared]\nsso_start_url = https://example.invalid/start\nsso_region = us-east-1\n[profile other]\nregion = eu-central-1\n[profile government]\nregion = us-gov-west-1\n[profile coreforge]\nregion = us-east-1\n",
		);
		const bridge = path.resolve(import.meta.dir, "../src/mcp/tool-bridge.ts");
		const script = `
import { MCPTool, DeferredMCPTool } from ${JSON.stringify(bridge)};
const requests = [];
let connects = 0;
let reconnects = 0;
let expired = false;
const definition = { name: "aws___run_script", inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: ["commercial", "other", "government", "coreforge"] }, code: { type: "string" } } } };
const connection = {
 name: "coreforge-aws-agent-toolkit", config: { command: "unused" }, capabilities: { tools: {} },
 transport: { request: async (method, params) => {
  if (method === "tools/list") return { tools: [definition] };
  requests.push(params.arguments?.aws_profile ?? "knowledge");
  if (expired) return { isError: true, content: [{ type: "text", text: "SSO token expired: login required" }] };
  return { content: [{ type: "text", text: JSON.stringify({ profile: params.arguments?.aws_profile }) }] };
 } },
};
const deferred = new DeferredMCPTool(connection.name, definition, async () => { connects++; return connection; }, undefined, async () => { reconnects++; return connection; });
const context = {};
const rejected = [];
for (const selected of [undefined, "government", "coreforge", "missing"]) {
 const args = { code: "result = {}\\nresult", ...(selected ? { aws_profile: selected } : {}) };
 const result = await deferred.execute("reject", args, undefined, context);
 rejected.push({ error: result.isError, text: result.content[0].text });
}
const afterRejections = { connects, reconnects, requests: requests.length };
const direct = new MCPTool(connection, definition);
await direct.execute("one", { aws_profile: "commercial", code: "result = {}\\nresult" }, undefined, context);
await direct.execute("two", { aws_profile: "other", code: "result = {}\\nresult" }, undefined, context);
const knowledge = new MCPTool(connection, { name: "aws___list_regions", inputSchema: { type: "object", properties: {} } });
await knowledge.execute("knowledge", {}, undefined, context);
expired = true;
const authResult = await direct.execute("expired", { aws_profile: "commercial", code: "result = {}\\nresult" }, undefined, context);
const boundCalls = [];
const legacyCachedDefinition = {
 name: "aws___run_script",
 inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
};
const boundConnection = {
 name: connection.name, config: connection.config, capabilities: { tools: {} }, operationalAwsProfiles: ["commercial"],
 transport: { request: async (method, params) => {
  if (method === "tools/list") return { tools: [legacyCachedDefinition] };
  if ("aws_profile" in params.arguments) throw new Error("Upstream single-profile schema rejects aws_profile");
  boundCalls.push(params.arguments.code);
  return { content: [{ type: "text", text: "bound-commercial identity" }] };
 } },
};
const legacyTool = new DeferredMCPTool(connection.name, legacyCachedDefinition, async () => boundConnection);
const legacySchema = legacyTool.parameters;
const legacyMissing = await legacyTool.execute("legacy-missing", { code: "read" }, undefined, context);
const legacyAllowed = await legacyTool.execute("legacy-allowed", { aws_profile: "commercial", code: "read" }, undefined, context);
const legacyWrong = await legacyTool.execute("legacy-wrong", { aws_profile: "other", code: "read" }, undefined, context);
boundConnection.awsProfileBindings?.set("aws___run_script", "other");
const legacyChanged = await legacyTool.execute("legacy-changed", { aws_profile: "commercial", code: "read" }, undefined, context);
let staleConnects = 0;
const staleDefinition = {
 name: "aws___run_script",
 inputSchema: { type: "object", properties: { code: { type: "string" }, aws_profile: { type: "string", enum: ["commercial"] } }, required: ["code", "aws_profile"] },
};
const freshConnection = {
 name: connection.name, config: connection.config, capabilities: { tools: {} }, operationalAwsProfiles: ["other"],
 transport: { request: async (method, params) => {
  if (method === "tools/list") return { tools: [{ name: "aws___run_script", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }] };
  if ("aws_profile" in params.arguments) throw new Error("Single-profile proxy rejected aws_profile");
  return { content: [{ type: "text", text: "current-other identity" }] };
 } },
};
const staleTool = new DeferredMCPTool(connection.name, staleDefinition, async () => { staleConnects++; return freshConnection; });
const staleAllowed = await staleTool.execute("stale", { aws_profile: "other", code: "read" }, undefined, context);
const staleResult = { connects: staleConnects, error: staleAllowed.isError, text: staleAllowed.content[0].text };
console.log(JSON.stringify({ rejected, afterRejections, requests, authResult, reconnects, boundCalls, legacyMissing, legacyWrong, legacyAllowed, legacyChanged, legacySchema, staleResult }));
`;
		const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
			cwd: root,
			signal: AbortSignal.timeout(20_000),
			env: {
				HOME: root,
				PATH: process.env.PATH ?? "",
				OMP_OPERATIONAL_AWS_CONFIG_FILE: config,
				OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials"),
				OMP_OPERATIONAL_AWS_EXECUTABLE: process.execPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, stderr).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.afterRejections).toEqual({
			connects: 0,
			reconnects: 0,
			requests: 0,
		});
		expect(result.rejected.map((entry: { error: boolean }) => entry.error)).toEqual([true, true, true, true]);
		expect(result.rejected[0].text).toContain("PROFILE_NOT_FOUND");
		expect(result.rejected[1].text).toContain("WRONG_PARTITION");
		expect(result.requests).toEqual(["commercial", "other", "knowledge", "commercial"]);
		expect(result.authResult.isError).toBe(true);
		expect(result.authResult.content[0].text).toContain("AUTH_REQUIRED");
		expect(result.authResult.content[0].text).toContain("commercial");
		expect(result.reconnects).toBe(0);
		expect(result.legacyMissing.isError).toBe(true);
		expect(result.legacyWrong.isError).toBe(true);
		expect(result.legacyAllowed.isError, result.legacyAllowed.content[0].text).not.toBe(true);
		expect(result.legacyAllowed.content[0].text).toContain("bound-commercial identity");
		expect(result.legacyChanged.isError).toBe(true);
		expect(result.legacyWrong.content[0].text).toContain("PROFILE_NOT_FOUND");
		expect(result.boundCalls).toEqual(["read"]);
		expect(result.legacyChanged.content[0].text).toContain("PROFILE_NOT_FOUND");
		expect(result.legacySchema.required).toContain("aws_profile");
		expect(result.staleResult).toEqual({ connects: 1, text: "current-other identity" });
		expect(result.legacySchema.properties.aws_profile).toMatchObject({
			type: "string",
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("managed AWS discovers anonymously and signs with the selected profile on first use", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-aws-first-use-"));
	try {
		const config = path.join(root, "config");
		await fs.writeFile(
			config,
			"[profile expired]\nregion = us-east-1\nsso_session = first\n[sso-session first]\nsso_start_url = https://fixture.invalid/start\nsso_region = us-east-1\n[profile healthy]\nregion = us-east-1\n",
		);
		const aws = path.join(root, process.platform === "win32" ? "aws.exe" : "aws");
		const fixture = path.resolve(import.meta.dir, "fixtures/recording-aws.ts");
		if (process.platform === "win32") {
			const build = Bun.spawn([process.execPath, "build", "--compile", fixture, "--outfile", aws], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [error, exit] = await Promise.all([new Response(build.stderr).text(), build.exited]);
			expect(exit, error).toBe(0);
		} else {
			await fs.writeFile(aws, `#!${process.execPath}\n${await fs.readFile(fixture, "utf8")}`, { mode: 0o755 });
		}
		const proxy = path.join(root, "proxy.ts");
		await fs.writeFile(
			proxy,
			`import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const profiles = (Bun.env.OMP_OPERATIONAL_AWS_PROFILES ?? "").split("\\n").filter(Boolean);
appendFileSync(join(Bun.env.HOME!, "proxy.starts"), JSON.stringify(profiles) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
 const request = JSON.parse(line);
 if (!request.id) continue;
 let result;
 let error;
 if (request.method === "initialize") {
  if (profiles[0] === "expired" && !existsSync(join(Bun.env.HOME!, "authenticated-expired")))
   error = { code: -32000, message: "SSOTokenLoadError: first profile expired" };
  else result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake-aws", version: "1" } };
 } else if (request.method === "tools/list") {
  result = { tools: [
   { name: "aws___list_regions", inputSchema: { type: "object", properties: {} } },
   { name: "aws___run_script", inputSchema: { type: "object",
     properties: { code: { type: "string" }, ...(profiles.length > 1 ? { aws_profile: { type: "string", enum: profiles } } : {}) },
     required: ["code"] } },
  ] };
 } else if (request.method === "tools/call") {
  result = { content: [{ type: "text", text: JSON.stringify({ profiles, args: request.params.arguments }) }] };
 } else result = {};
 console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }));
}`,
		);
		const script = `
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connectToServer, disconnectServer, listTools } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/mcp/client.ts"))};
import { MCPTool } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/mcp/tool-bridge.ts"))};
import { Settings } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/config/settings.ts"))};
const config = { command: process.execPath, args: ["--no-env-file", ${JSON.stringify(proxy)}] };
const options = { preserveOperationalAws: true, awsAnonymousBootstrap: true };
let connection = await connectToServer("coreforge-aws-agent-toolkit", config, options);
const tools = await listTools(connection);
assert.deepEqual(connection.operationalAwsProfiles, []);
assert.deepEqual(tools.find(t => t.name === "aws___run_script").inputSchema.properties.aws_profile.enum, ["expired", "healthy"]);
assert.equal(readFileSync(join(process.env.HOME, "proxy.starts"), "utf8").trim(), "[]");
assert.equal(readFileSync(join(process.env.HOME, "aws.calls"), "utf8").trim(), "");
const context = { hasUI: true, settings: Settings.isolated(), sessionManager: { getCwd: () => process.env.HOME },
 ui: { confirm: async () => true, notify: () => {} } };
const reconnect = async ({ awsProfile } = {}) => {
 await disconnectServer(connection);
 connection = await connectToServer("coreforge-aws-agent-toolkit", config, { preserveOperationalAws: true, awsPreferredProfile: awsProfile });
 return connection;
};
const knowledge = new MCPTool(connection, tools.find(t => t.name === "aws___list_regions"));
const knowledgeResult = await knowledge.execute("knowledge", {}, undefined, context);
assert.notEqual(knowledgeResult.isError, true, knowledgeResult.content[0]?.text);
const run = new MCPTool(connection, tools.find(t => t.name === "aws___run_script"), reconnect);
const healthy = await run.execute("healthy", { aws_profile: "healthy", code: "result = 1" }, undefined, context);
assert.notEqual(healthy.isError, true, healthy.content[0]?.text);
assert.deepEqual(JSON.parse(healthy.content[0].text).profiles, ["healthy", "expired"]);
assert.equal(JSON.parse(healthy.content[0].text).args.aws_profile, "healthy");
assert.equal(readFileSync(join(process.env.HOME, "aws.calls"), "utf8").trim().split("\\n").length, 1);
await disconnectServer(connection);
const afterDrop = await run.execute("reconnect", { aws_profile: "healthy", code: "result = 4" }, undefined, context);
assert.notEqual(afterDrop.isError, true, afterDrop.content[0]?.text);
assert.deepEqual(JSON.parse(afterDrop.content[0].text).profiles, ["healthy", "expired"]);
await disconnectServer(connection);
connection = await connectToServer("coreforge-aws-agent-toolkit", config, options);
const expiredRun = new MCPTool(connection, (await listTools(connection)).find(t => t.name === "aws___run_script"), reconnect);
const recovered = await expiredRun.execute("expired", { aws_profile: "expired", code: "result = 2" }, undefined, context);
assert.notEqual(recovered.isError, true, recovered.content[0]?.text);
assert.deepEqual(JSON.parse(recovered.content[0].text).profiles, ["expired", "healthy"]);
assert.equal(readFileSync(join(process.env.HOME, "aws.calls"), "utf8").trim().split("\\n").filter(x => x.includes('"login"')).length, 1);
await disconnectServer(connection);
connection = await connectToServer("coreforge-aws-agent-toolkit", config, options);
let sharedReconnect;
const reconnectTogether = async () => sharedReconnect ??= (async () => {
 await disconnectServer(connection);
 connection = await connectToServer("coreforge-aws-agent-toolkit", config, { preserveOperationalAws: true, awsPreferredProfile: "healthy" });
 return connection;
})();
const firstCaller = new MCPTool(connection, tools.find(t => t.name === "aws___run_script"), reconnectTogether);
const secondCaller = new MCPTool(connection, tools.find(t => t.name === "aws___run_script"), reconnectTogether);
const [firstResult, secondResult] = await Promise.all([
 firstCaller.execute("first", { aws_profile: "healthy", code: "result = 5" }, undefined, context),
 secondCaller.execute("second", { aws_profile: "expired", code: "result = 6" }, undefined, context),
]);
assert.notEqual(firstResult.isError, true, firstResult.content[0]?.text);
assert.equal(secondResult.isError, true);
assert.match(secondResult.content[0].text, /PROFILE_CONFLICT/);
await disconnectServer(connection);
const singleConfig = { ...config, env: { AWS_MCP_PROXY_PROFILES: "healthy" } };
let single = await connectToServer("coreforge-aws-agent-toolkit", singleConfig, options);
const singleTools = await listTools(single);
assert.deepEqual(singleTools.find(t => t.name === "aws___run_script").inputSchema.properties.aws_profile.enum, ["healthy"]);
const singleRun = new MCPTool(single, singleTools.find(t => t.name === "aws___run_script"), async ({ awsProfile } = {}) => {
 await disconnectServer(single);
 single = await connectToServer("coreforge-aws-agent-toolkit", singleConfig, { preserveOperationalAws: true, awsPreferredProfile: awsProfile });
 return single;
});
const only = await singleRun.execute("single", { aws_profile: "healthy", code: "result = 3" }, undefined, context);
assert.notEqual(only.isError, true, only.content[0]?.text);
assert.deepEqual(JSON.parse(only.content[0].text).profiles, ["healthy"]);
assert.equal(JSON.parse(only.content[0].text).args.aws_profile, undefined);
await disconnectServer(single);
const empty = await connectToServer("coreforge-aws-agent-toolkit", { ...config, env: { AWS_MCP_PROXY_PROFILES: "" } }, options);
assert.deepEqual((await listTools(empty)).map(t => t.name), ["aws___list_regions"]);
await disconnectServer(empty);
console.log("first-use routing passed");
`;
		await fs.writeFile(path.join(root, "aws.calls"), "");
		const policy = path.join(root, "dcg-policy");
		await fs.writeFile(policy, "fixture");
		const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
			cwd: root,
			signal: AbortSignal.timeout(35_000),
			env: {
				HOME: root,
				USERPROFILE: root,
				PATH: process.env.PATH ?? "",
				...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
				OMP_OPERATIONAL_AWS_CONFIG_FILE: config,
				OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials"),
				OMP_OPERATIONAL_AWS_EXECUTABLE: aws,
				OMP_DCG_PATH: aws,
				OMP_DCG_VERSION: "fixture",
				OMP_DCG_BINARY_SHA256: createHash("sha256")
					.update(await fs.readFile(aws))
					.digest("hex"),
				OMP_DCG_CONFIG: policy,
				OMP_DCG_CONFIG_SHA256: createHash("sha256").update("fixture").digest("hex"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, `${stdout}\n${stderr}`).toBe(0);
		expect(stdout).toContain("first-use routing passed");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 45_000);
