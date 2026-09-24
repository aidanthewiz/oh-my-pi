import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { AwsTool, listTrustedAwsProfiles } from "../../src/tools/aws";
import { MCPTool } from "../../src/mcp/tool-bridge";
import type { MCPServerConnection } from "../../src/mcp/types";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { reserveManagedAwsProfile } from "@oh-my-pi/pi-utils";
import { ensureCoreforgeAwsSso } from "../../src/identity/aws-sso";
import { restoreCoreforgeOperationalAwsEnvironment } from "../../src/identity/runtime";
import { resolveAwsCredentials } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";
import type { ExtensionRunner } from "../../src/extensibility/extensions";

const root = process.env.HOME!;
const repository = path.join(root, "repository");
const cwd = path.join(repository, "nested");
await fs.mkdir(cwd, { recursive: true });
await fs.mkdir(path.join(repository, ".git"), { recursive: true });
await fs.writeFile(path.join(cwd, "aws"), "repository interception must never execute");
let artifact = 0;
const settings = Settings.isolated();
let activeContext: AgentToolContext | undefined = undefined;
const tool = new AwsTool({
	cwd,
	hasUI: true,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings,
	getToolContext: () => activeContext,
	allocateOutputArtifact: async () => ({ id: `aws-${++artifact}`, path: path.join(root, `artifact-${artifact}.txt`) }),
});
const calls = async () =>
	(await fs.readFile(path.join(root, "aws.calls"), "utf8").catch(() => ""))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
const text = (result: AgentToolResult<unknown>) =>
	result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
const read = { profile: "commercial", service: "s3api", operation: "list-buckets" };
if (process.env.NATIVE_AWS_EXPECT_NO_CLI) {
	const before = (await calls()).length;
	await assert.rejects(
		() => tool.execute("missing-cli", read),
		error => error instanceof ToolError && error.context?.code === "AWS_CLI_UNAVAILABLE",
	);
	assert.equal((await calls()).length, before);
	process.exit(0);
}
const modelEnvironment: Record<string, string | undefined> = {};
restoreCoreforgeOperationalAwsEnvironment(modelEnvironment);
assert.equal(modelEnvironment.OMP_MODEL_AWS_PROFILE, undefined);
assert.equal(modelEnvironment.OMP_MODEL_AWS_REGION, undefined);
const first = await tool.execute("commercial", read);
assert.notEqual(first.isError, true, JSON.stringify({ first, calls: await calls() }));
assert.match(text(first), /commercial/);
assert.ok(!text(first).includes("fixture-secret"));
assert.ok(!text(first).includes("fixture-token"));
await tool.execute("government", { ...read, profile: "government" });
const initial = await calls();
assert.equal(initial.length, 2);
assert.equal(initial[1].argv[initial[1].argv.indexOf("--region") + 1], "us-gov-west-1");
for (const call of initial) {
	assert.notEqual(call.cwd, cwd);
	for (const key of [
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"OMP_MODEL_AWS_PROFILE",
		"OMP_MODEL_AWS_REGION",
		"OMP_OPERATIONAL_AWS_EXECUTABLE",
		"AWS_ENDPOINT_URL",
	])
		assert.equal(call.env[key], undefined, key);
	assert.equal(call.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, "true");
	assert.equal(call.env.AWS_SHARED_CREDENTIALS_FILE, path.join(root, "credentials"));
}
for (const args of [
	{ ...read, profile: "missing" },
	{ ...read, profile: "coreforge" },
	{ ...read, profile: "managed-alias" },
	{ ...read, profile: "partition-conflict" },
	{ ...read, profile: "role-conflict" },
	{ ...read, region: "us-gov-west-1" },
	{ ...read, parameters: { endpoint: "https://invalid.test" } },
	{ ...read, parameters: { Payload: "file:///private" } },
])
	await assert.rejects(
		() => tool.execute("reject", args),
		/PROFILE_NOT_FOUND|WRONG_PARTITION|INVALID_OPERATION|AUTH_REQUIRED/,
	);
assert.equal((await calls()).length, 2);
await assert.rejects(
	() => tool.execute("dcg-denial", { ...read, operation: "delete-bucket", parameters: { Bucket: "protected" } }),
	/fixture\.aws/,
);
assert.equal((await calls()).length, 2);
assert.match(await fs.readFile(path.join(root, "dcg.calls"), "utf8"), /'s3api' 'delete-bucket' '--bucket=protected'/);
const optionValue = await tool.execute("flag-value", { ...read, parameters: { Prefix: "--profile=coreforge" } });
assert.match(text(optionValue), /commercial/);
assert.ok((await calls()).at(-1).argv.includes("--prefix=--profile=coreforge"));
const mutation = {
	...read,
	service: "ec2",
	operation: "terminate-instances",
	parameters: { InstanceIds: ["i-fixture"] },
};
const approval = await tool.prepareRuntimeApproval("mutation", mutation);
assert.match(approval!.prompt, /123456789012/);
assert.match(approval!.prompt, /arn:aws:iam::123456789012:user\/fixture/);
await assert.rejects(() => tool.execute("mutation", mutation), /approval/);
assert.equal((await calls()).filter(call => call.argv.includes("terminate-instances")).length, 0);
await tool.prepareRuntimeApproval("changed", mutation);
tool.approveRuntimeApproval("changed", mutation);
await fs.writeFile(path.join(root, "changed-identity"), "yes");
await assert.rejects(() => tool.execute("changed", mutation), /identity changed/);
await fs.unlink(path.join(root, "changed-identity"));
await tool.prepareRuntimeApproval("approved", mutation);
tool.approveRuntimeApproval("approved", mutation);
await tool.execute("approved", mutation);
assert.equal((await calls()).filter(call => call.argv.includes("terminate-instances")).length, 1);
await assert.rejects(
	() => tool.prepareRuntimeApproval("mismatch", { ...mutation, profile: "mismatched" }),
	/WRONG_PARTITION/,
);
const expired = await tool.execute("expired", { ...read, profile: "expired" });
assert.equal(expired.isError, true);
assert.match(text(expired), /AUTH_REQUIRED/);
assert.equal((await calls()).filter(call => call.argv.includes("login")).length, 0);
const login = { profile: "expired", service: "sso", operation: "login" };
await tool.prepareRuntimeApproval("login", login);
tool.approveRuntimeApproval("login", login);
await tool.execute("login", login);
await tool.execute("retry", { ...read, profile: "expired" });
await tool.execute("shared", { ...read, profile: "expired-peer" });
assert.equal((await calls()).filter(call => call.argv.includes("login")).length, 1);
for (const [profile, failure] of [
	["declined", "selector"],
	["resolution-declined", "resolution"],
] as const) {
	const declined = { ...login, profile };
	const wrapped = new ExtensionToolWrapper(
		tool as unknown as AgentTool,
		{
			hasHandlers: (event: string) => failure === "resolution" && event === "tool_approval_resolved",
			hasUI: () => true,
			consumeToolCallEmitted: () => false,
			runScoped: <T>(fn: () => T): T => fn(),
			getUIContext: () => ({
				select: async () => {
					if (failure === "selector") throw new Error("approval interrupted");
					return "Approve once";
				},
			}),
			emit: async (event: { type: string }) => {
				if (event.type === "tool_approval_resolved") throw new Error("approval interrupted");
			},
		} as unknown as ExtensionRunner,
	);
	await assert.rejects(
		() => wrapped.execute(profile, declined, undefined, undefined, { settings } as AgentToolContext),
		/approval interrupted/,
	);
	tool.approveRuntimeApproval(profile, declined);
	await assert.rejects(
		() => tool.execute(profile, declined),
		/approval|declined/i,
		`${profile} reused an interrupted approval`,
	);
	await assert.rejects(() => tool.prepareRuntimeApproval(`${profile}-again`, declined), /declined/);
}
assert.equal((await calls()).filter(call => call.argv.includes("login")).length, 1);
let confirmations = 0;
const context = {
	hasUI: true,
	settings,
	sessionManager: { getCwd: () => cwd },
	ui: {
		confirm: async () => {
			confirmations++;
			await Bun.sleep(25);
			return true;
		},
		notify: (message: string) => {
			if (message.includes("https://fixture.invalid/device") && message.includes("FAKE-CODE")) {
				void Bun.write(path.join(root, "device-instructions-shown"), "shown");
			}
		},
	},
} as unknown as AgentToolContext;
const automatic = await tool.execute("automatic", { ...read, profile: "automatic" }, undefined, undefined, context);
assert.notEqual(automatic.isError, true);
assert.equal(confirmations, 1);
assert.equal(
	(await calls()).filter(call => call.argv.includes("automatic") && call.argv.includes("list-buckets")).length,
	2,
);
assert.equal((await calls()).filter(call => call.argv.includes("automatic") && call.argv.includes("login")).length, 1);
const managedRequests: string[] = [];
const connection = {
	name: "coreforge-aws-agent-toolkit",
	config: { command: "unused" },
	transport: {
		request: async (_method: string, params: { arguments: { aws_profile: string } }) => {
			managedRequests.push(params.arguments.aws_profile);
			return (await Bun.file(path.join(root, "authenticated-parallel")).exists())
				? { content: [{ type: "text", text: "managed read completed" }] }
				: {
						isError: true,
						content: [{ type: "text", text: "Tool call failed due to expired or invalid AWS credentials." }],
					};
		},
	},
} as unknown as MCPServerConnection;
const managed = new MCPTool(connection, {
	name: "aws___run_script",
	inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: ["parallel-peer"] } } },
});
const [nativeShared, managedShared] = await Promise.all([
	tool.execute("parallel-native", { ...read, profile: "parallel" }, undefined, undefined, context),
	managed.execute("parallel-managed", { aws_profile: "parallel-peer" }, undefined, context),
]);
assert.notEqual(nativeShared.isError, true);
assert.notEqual(managedShared.isError, true);
assert.equal(confirmations, 2);
assert.deepEqual(managedRequests, ["parallel-peer", "parallel-peer"]);
assert.equal(
	(await calls()).filter(
		call =>
			call.argv.includes("login") && call.argv.some((arg: string) => arg === "parallel" || arg === "parallel-peer"),
	).length,
	1,
);
let deniedRequests = 0;
const deniedConnection = {
	...connection,
	transport: {
		request: async () => {
			deniedRequests++;
			return {
				isError: true,
				content: [{ type: "text", text: "Tool call failed due to expired or invalid AWS credentials." }],
			};
		},
	},
} as unknown as MCPServerConnection;
const deniedManaged = new MCPTool(deniedConnection, {
	name: "aws___run_script",
	inputSchema: {
		type: "object",
		properties: { aws_profile: { type: "string", enum: ["automatic", "partition-conflict", "role-conflict"] } },
	},
});
const deniedResult = await deniedManaged.execute(
	"valid-credentials-denied",
	{ aws_profile: "automatic" },
	undefined,
	context,
);
assert.equal(deniedResult.isError, true);
assert.equal(confirmations, 2);
assert.match(text(deniedResult), /expired or invalid AWS credentials/);
for (const profile of ["partition-conflict", "role-conflict"]) {
	const rejected = await deniedManaged.execute("partition-conflict", { aws_profile: profile }, undefined, context);
	assert.equal(rejected.isError, true);
	assert.match(text(rejected), /WRONG_PARTITION/);
}
assert.equal(deniedRequests, 1);
const declinedContext = {
	...context,
	ui: {
		confirm: async () => {
			confirmations++;
			return false;
		},
	},
} as unknown as AgentToolContext;
const firstDecline = await tool.execute(
	"firstuse-declined",
	{ ...read, profile: "firstuse-declined" },
	undefined,
	undefined,
	declinedContext,
);
const repeatedDecline = await tool.execute(
	"firstuse-declined-again",
	{ ...read, profile: "firstuse-declined" },
	undefined,
	undefined,
	context,
);
assert.equal(firstDecline.isError, true);
assert.equal(repeatedDecline.isError, true);
assert.equal(confirmations, 3);
assert.equal(
	(await calls()).filter(call => call.argv.includes("firstuse-declined") && call.argv.includes("login")).length,
	0,
);
await assert.rejects(
	() => tool.execute("failed-login", { ...read, profile: "failed-login" }, undefined, undefined, context),
	/AUTH_REQUIRED/,
);
const failedAgain = await tool.execute(
	"failed-login-again",
	{ ...read, profile: "failed-login" },
	undefined,
	undefined,
	context,
);
assert.equal(failedAgain.isError, true);
assert.equal(confirmations, 4);
assert.equal(
	(await calls()).filter(call => call.argv.includes("failed-login") && call.argv.includes("login")).length,
	1,
);
const stillExpired = await tool.execute(
	"still-expired",
	{ ...read, profile: "still-expired" },
	undefined,
	undefined,
	context,
);
assert.equal(stillExpired.isError, true);
assert.equal(
	(await calls()).filter(call => call.argv.includes("still-expired") && call.argv.includes("list-buckets")).length,
	2,
);
await tool.execute("still-expired-again", { ...read, profile: "still-expired" }, undefined, undefined, context);
assert.equal(confirmations, 5);
const governmentLogin = await tool.execute(
	"government-expired",
	{ ...read, profile: "government-expired" },
	undefined,
	undefined,
	context,
);
assert.notEqual(governmentLogin.isError, true);
assert.equal(confirmations, 6);
assert.equal((await listTrustedAwsProfiles()).find(profile => profile.name === "automatic")?.lastValidation, "valid");
activeContext = context;
const expiredMutation = { ...mutation, profile: "mutating-expired" };
const recoveredApproval = await tool.prepareRuntimeApproval("expired-mutation", expiredMutation);
assert.match(recoveredApproval!.prompt, /arn:aws:iam::123456789012:user\/fixture/);
tool.approveRuntimeApproval("expired-mutation", expiredMutation);
await tool.execute("expired-mutation", expiredMutation);
const changedMutation = { ...mutation, profile: "mutating-changed" };
await tool.prepareRuntimeApproval("expired-changed", changedMutation);
tool.approveRuntimeApproval("expired-changed", changedMutation);
await fs.writeFile(path.join(root, "expire-mutation"), "yes");
await assert.rejects(() => tool.execute("expired-changed", changedMutation), /identity changed/);
await fs.unlink(path.join(root, "changed-identity"));
assert.equal(confirmations, 8);
assert.equal((await calls()).filter(call => call.argv.includes("terminate-instances")).length, 2);
const beforeReservation = (await listTrustedAwsProfiles()).map(profile => profile.name);
assert.ok(beforeReservation.includes("adopted-model") && beforeReservation.includes("adopted-alias"));
void tool.parameters;
reserveManagedAwsProfile("adopted-model");
const afterReservation = (await listTrustedAwsProfiles()).map(profile => profile.name);
assert.ok(!afterReservation.includes("adopted-model") && !afterReservation.includes("adopted-alias"));
assert.ok(afterReservation.includes("coreforge-admin"));
assert.throws(() => tool.parameters.assert({ ...read, profile: "adopted-model" }));
const beforeRejectedHelpers = (await calls()).length;
const repositoryHelper = path.join(repository, process.platform === "win32" ? "native-helper.exe" : "native-helper");
await fs.copyFile(process.execPath, repositoryHelper);
const scriptHelper = path.join(root, "external-helper");
await fs.writeFile(scriptHelper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
for (const profile of ["repository-helper", "script-helper"]) {
	await assert.rejects(() => tool.execute(profile, { ...read, profile }), /AUTH_REQUIRED/);
}
await assert.rejects(() => tool.execute("reserved-alias", { ...read, profile: "adopted-alias" }), /PROFILE_NOT_FOUND/);
assert.equal((await calls()).length, beforeRejectedHelpers);
await tool.execute("large", { ...read, parameters: { Prefix: "large" } });
const artifacts = await fs.readdir(root);
const saved = await Promise.all(
	artifacts.filter(file => file.startsWith("artifact-")).map(file => fs.readFile(path.join(root, file), "utf8")),
);
assert.ok(saved.some(value => value.includes('"rows"')));
assert.ok(saved.every(value => !value.includes("fixture-secret") && !value.includes("fixture-token")));
const originalPath = Bun.env.PATH;
Bun.env.PATH = cwd;
try {
	const managedIdentity = await ensureCoreforgeAwsSso({ profile: "coreforge", region: "us-east-1" });
	assert.match(managedIdentity.roleArn, /user\/fixture$/);
	await fs.mkdir(path.join(root, ".aws"), { recursive: true });
	await fs.writeFile(
		path.join(root, ".aws", "config"),
		"[profile coreforge]\nsso_session = managed\nsso_account_id = 123456789012\nsso_role_name = Model\n[sso-session managed]\nsso_start_url = https://fixture.invalid/start\nsso_region = us-east-1\n",
	);
	const modelCredentials = await resolveAwsCredentials({ signal: AbortSignal.timeout(5000) });
	assert.equal(modelCredentials.accessKeyId, "fixture-model-access");
} finally {
	Bun.env.PATH = originalPath;
}
const cancel = new AbortController();
const hanging = tool.execute("cancel", { ...read, parameters: { Prefix: "hang" } }, cancel.signal);
for (let attempt = 0; attempt < 200; attempt++) {
	if (await Bun.file(path.join(root, "descendant.pid")).exists()) break;
	await Bun.sleep(10);
}
const descendant = Number(await fs.readFile(path.join(root, "descendant.pid"), "utf8"));
cancel.abort();
await hanging;
assert.throws(() => process.kill(descendant, 0));
console.log("Native AWS execution, isolation, approval, SSO, artifacts, and cancellation passed");
