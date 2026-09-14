import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Launch provenance is captured at module import, so the bridge runs in a separate process.
test("managed AWS rejects missing and sovereign profiles before connecting or invoking", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-aws-routing-"));
	try {
		const config = path.join(root, "config");
		await fs.writeFile(
			config,
			"[profile commercial]\nregion = us-east-1\nsso_session = shared\n[sso-session shared]\nsso_start_url = https://example.invalid/start\nsso_region = us-east-1\n[profile other]\nregion = eu-central-1\n[profile government]\nregion = us-gov-west-1\n[profile coreforge]\nregion = us-east-1\n",
		);
		const bridge = path.resolve(import.meta.dir, "../src/mcp/tool-bridge.ts");
		const client = path.resolve(import.meta.dir, "../src/mcp/client.ts");
		const script = `
import { MCPTool, DeferredMCPTool } from ${JSON.stringify(bridge)};
import { listTools } from ${JSON.stringify(client)};
const requests = [];
let connects = 0;
let reconnects = 0;
let expired = false;
const connection = {
 name: "coreforge-aws-agent-toolkit", config: { command: "unused" },
 transport: { request: async (method, params) => {
  requests.push(params.arguments?.aws_profile ?? "knowledge");
  if (expired) return { isError: true, content: [{ type: "text", text: "SSO token expired: login required" }] };
  return { content: [{ type: "text", text: JSON.stringify({ profile: params.arguments?.aws_profile }) }] };
 } },
};
const definition = { name: "aws___run_script", inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: ["commercial", "other", "government", "coreforge"] }, code: { type: "string" } } } };
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
const boundConnection = {
 name: connection.name, config: connection.config, capabilities: { tools: {} }, operationalAwsProfiles: ["commercial"],
 transport: { request: async (method, params) => {
  if (method === "tools/list") return { tools: [
   { name: "aws___run_script", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } },
   { name: "aws___list_regions", inputSchema: { type: "object", properties: {} } },
  ] };
  if ("aws_profile" in params.arguments) throw new Error("Upstream single-profile schema rejects aws_profile");
  boundCalls.push(params.arguments.code);
  return { content: [{ type: "text", text: "bound-commercial identity" }] };
 } },
};
const boundDefinitions = await listTools(boundConnection);
const cachedDefinition = JSON.parse(JSON.stringify(boundDefinitions[0]));
const boundTool = new DeferredMCPTool(connection.name, cachedDefinition, async () => boundConnection);
const boundMissing = await boundTool.execute("bound-missing", { code: "read" }, undefined, context);
const boundWrong = await boundTool.execute("bound-wrong", { aws_profile: "other", code: "read" }, undefined, context);
const boundAllowed = await boundTool.execute("bound-allowed", { aws_profile: "commercial", code: "read" }, undefined, context);
boundConnection.awsProfileBindings.set("aws___run_script", "other");
const boundChanged = await boundTool.execute("bound-changed", { aws_profile: "commercial", code: "read" }, undefined, context);
console.log(JSON.stringify({ rejected, afterRejections, requests, authResult, reconnects, boundCalls, boundMissing, boundWrong, boundAllowed, boundChanged, knowledgeSchema: boundDefinitions[1].inputSchema }));
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
		expect(result.afterRejections).toEqual({ connects: 0, reconnects: 0, requests: 0 });
		expect(result.rejected.map((entry: { error: boolean }) => entry.error)).toEqual([true, true, true, true]);
		expect(result.rejected[0].text).toContain("PROFILE_NOT_FOUND");
		expect(result.rejected[1].text).toContain("WRONG_PARTITION");
		expect(result.requests).toEqual(["commercial", "other", "knowledge", "commercial"]);
		expect(result.authResult.isError).toBe(true);
		expect(result.authResult.content[0].text).toContain("AUTH_REQUIRED");
		expect(result.authResult.content[0].text).toContain("commercial");
		expect(result.reconnects).toBe(0);
		expect(result.boundMissing.isError).toBe(true);
		expect(result.boundWrong.isError).toBe(true);
		expect(result.boundAllowed.isError).not.toBe(true);
		expect(result.boundAllowed.content[0].text).toContain("bound-commercial identity");
		expect(result.boundChanged.isError).toBe(true);
		expect(result.boundCalls).toEqual(["read"]);
		expect(result.knowledgeSchema.properties.aws_profile).toBeUndefined();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
