import { expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	agentLoop,
	getCleanupOwnedToolCallArgs,
	withNestedCleanupOwnedToolCall,
} from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

for (const cleanupOwned of [true, false]) {
	test(`nested cleanup authority requires an owned parent (${cleanupOwned}) and expires with the call`, async () => {
		const schema = type({});
		const args = { value: "nested" };
		const child: AgentTool = {
			name: "child",
			label: "Child",
			description: "Nested resource owner",
			parameters: schema,
			cancellationBehavior: "await-cleanup",
			execute: async () => ({ content: [] }),
		};
		let during: unknown;
		const released = Promise.withResolvers<void>();
		let later: Promise<unknown> | undefined;
		const root: AgentTool = {
			name: "root",
			label: "Root",
			description: "Root resource owner",
			parameters: schema,
			cancellationBehavior: cleanupOwned ? "await-cleanup" : undefined,
			execute: async () => {
				await withNestedCleanupOwnedToolCall(child, args, async () => {
					during = getCleanupOwnedToolCallArgs(child);
					later = released.promise.then(() => getCleanupOwnedToolCallArgs(child));
					await Promise.resolve();
					expect(getCleanupOwnedToolCallArgs(child)).toEqual(cleanupOwned ? args : undefined);
				});
				expect(getCleanupOwnedToolCallArgs(child)).toBeUndefined();
				return { content: [] };
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [root] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "root-call", name: "root", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const events = agentLoop(
			[createUserMessage("run")],
			context,
			{
				model: mock.model,
				convertToLlm: messages =>
					messages.filter(
						message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
					),
			},
			undefined,
			mock.stream,
		);
		for await (const _event of events) {
			/* Drain the real loop lifecycle. */
		}
		expect(during).toEqual(cleanupOwned ? args : undefined);
		expect(later).toBeDefined();
		released.resolve();
		expect(await later).toBeUndefined();
	});
}

test("a direct nested helper call cannot mint root cleanup authority", async () => {
	const child: AgentTool = {
		name: "child",
		label: "Child",
		description: "Nested resource owner",
		parameters: type({}),
		cancellationBehavior: "await-cleanup",
		execute: async () => ({ content: [] }),
	};
	await withNestedCleanupOwnedToolCall(child, {}, async () => {
		expect(getCleanupOwnedToolCallArgs(child)).toBeUndefined();
	});
});
