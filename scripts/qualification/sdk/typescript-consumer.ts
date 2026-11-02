import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
	defineRpcClientTool,
	RpcClient,
	RpcCommandError,
} from "../../../packages/coding-agent/src/modes/rpc/rpc-client.ts";

const checkout = process.env.CF_QUAL_CHECKOUT!;
const agentDir = path.join(process.env.CF_QUAL_SDK_RUNTIME!, "typescript-agent");
await mkdir(agentDir, { mode: 0o700 });
const provider = Bun.spawn(
	[process.env.CF_QUAL_REAL_BUN!, "packages/coding-agent/test/rpc-wire/fake-openai-server.ts", agentDir],
	{ cwd: checkout, stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env },
);
const calls: { message: string }[] = [];
const results: { status: string }[] = [];
const client = new RpcClient({
	command: [process.env.CF_QUAL_SDK_LAUNCHER!, "packages/coding-agent/src/cli.ts"],
	cwd: checkout,
	env: { PI_CODING_AGENT_DIR: agentDir },
	model: "fake/fake-model",
	args: ["--no-session", "--no-skills", "--no-rules", "--no-title"],
	customTools: [
		defineRpcClientTool<{ message: string }>({
			name: "echo_host",
			description: "Return a synthetic message from the TypeScript host",
			loadMode: "essential",
			parameters: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
				additionalProperties: false,
			},
			execute(params, context) {
				calls.push(params);
				context.sendUpdate("echoing");
				return `host:${params.message}`;
			},
		}),
	],
});
let observed: unknown;
try {
	const reader = provider.stdout.getReader();
	let timer: NodeJS.Timeout | undefined;
	try {
		const banner = await Promise.race([
			(async () => {
				let text = "";
				const decoder = new TextDecoder();
				while (!text.includes("\n")) {
					const { value, done } = await reader.read();
					if (done) throw new Error("scripted provider exited before ready");
					text += decoder.decode(value, { stream: true });
				}
				return text.trim();
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("scripted provider startup timed out")), 30_000);
			}),
		]);
		assert.match(banner, /^READY \d+$/);
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
	client.onPromptResult(result => results.push(result));
	await client.start();
	const created = await client.goal("create", { objective: "TypeScript SDK qualification", tokenBudget: 5000 });
	assert.equal(created.goal?.status, "active");
	assert.equal(created.goal?.tokenBudget, 5000);
	assert.equal((await client.goal("pause")).goal?.status, "paused");
	await client.goal("drop");
	await assert.rejects(
		client.getEntries("no-such-qualification-entry"),
		(error: unknown) => error instanceof RpcCommandError && error.code === "unknown_since",
	);
	await client.promptAndWait("say hi");
	assert.equal(await client.getLastAssistantText(), "pong");
	const events = await client.promptAndWait("please use echo_host");
	assert.equal(await client.getLastAssistantText(), "tool said: host:hello");
	assert.deepEqual(calls, [{ message: "hello" }]);
	assert.deepEqual(
		results.map(result => result.status),
		["completed", "completed"],
	);
	const update = events.find(event => event.type === "tool_execution_update" && event.toolName === "echo_host");
	assert(update?.type === "tool_execution_update");
	assert.deepEqual(update.partialResult.content, [{ type: "text", text: "echoing" }]);
	const end = events.find(event => event.type === "tool_execution_end" && event.toolName === "echo_host");
	assert(end?.type === "tool_execution_end");
	assert.equal(end.isError, false);
	assert.deepEqual(end.result.content, [{ type: "text", text: "host:hello" }]);
	observed = {
		language: "typescript",
		mode: process.env.CF_QUAL_MODE,
		assistant: "pong",
		toolAssistant: await client.getLastAssistantText(),
		hostCalls: calls,
		goalTransitions: ["active", "paused"],
		unknownEntryCode: "unknown_since",
		promptStatuses: results.map(result => result.status),
	};
} finally {
	try {
		await client.stop();
	} finally {
		await provider.stdin.end();
		let timer: NodeJS.Timeout | undefined;
		try {
			const code = await Promise.race([
				provider.exited,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("scripted provider shutdown timed out")), 10_000);
				}),
			]);
			assert.equal(code, 0);
		} finally {
			clearTimeout(timer);
			if (provider.exitCode === null) {
				provider.kill("SIGKILL");
				await provider.exited;
			}
		}
	}
}
console.log(JSON.stringify({ ...(observed as object), workersClosed: true }));
