import { describe, expect, it } from "bun:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { HookRunner } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/runner";
import { HookToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/tool-wrapper";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { dispatchToolCommand, type ToolCommandState } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function fixture(cancellationBehavior?: AgentTool["cancellationBehavior"]) {
	const started = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const schema = type({ mode: "'cleanup' | 'ordinary'", "cancellationBehavior?": "string" });
	let openResources = 0;
	let executions = 0;
	const tool: AgentTool<typeof schema, { openResources: number }> = {
		name: "lifecycle",
		label: "Lifecycle",
		description: "Owns a resource until cancellation cleanup completes.",
		parameters: schema,
		approval: "read",
		cancellationBehavior,
		async execute(_id, _args, signal) {
			executions++;
			openResources++;
			const onAbort = () => aborted.resolve();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			started.resolve();
			try {
				await aborted.promise;
				await release.promise;
			} finally {
				openResources--;
				signal?.removeEventListener("abort", onAbort);
				closed.resolve();
			}
			return {
				content: [{ type: "text", text: "Cancelled after resource cleanup." }],
				details: { openResources },
				isError: true,
			};
		},
	};
	const hooks = {
		hasHandlers: (event: string) => event === "tool_result",
		emit: async () => ({ content: [{ type: "text", text: "PRIVATE-CANCELLATION-CAUSE" }] }),
	} as unknown as HookRunner;
	const canonical = wrapToolWithMetaNotice(new HookToolWrapper(tool, hooks));
	const state: ToolCommandState = {
		tools: new Map([[tool.name, canonical]]),
		mountedNames: new Set([tool.name]),
		builtInNames: new Set(),
		isActive: () => false,
	};
	return {
		state,
		started,
		aborted,
		release,
		closed,
		get openResources() {
			return openResources;
		},
		get executions() {
			return executions;
		},
	};
}

const perCall: AgentTool["cancellationBehavior"] = args =>
	args !== null && typeof args === "object" && "mode" in args && args.mode === "cleanup" ? "await-cleanup" : undefined;

describe("mounted command cancellation through hooks and output wrappers", () => {
	for (const [name, behavior] of [
		["intrinsic", "await-cleanup"],
		["per-call", perCall],
	] as const) {
		it(`retains ${name} cleanup ownership and its safe terminal result`, async () => {
			const test = fixture(behavior);
			const controller = new AbortController();
			let settled = false;
			const pending = dispatchToolCommand(
				test.state,
				"lifecycle",
				{ mode: "cleanup" },
				"cleanup",
				controller.signal,
			);
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				await test.started.promise;
				controller.abort(new Error("PRIVATE-CANCELLATION-CAUSE"));
				await test.aborted.promise;
				await nextTurn();
				expect(test.openResources).toBe(1);
				expect(settled).toBe(false);
				test.release.resolve();
				const outcome = await pending;
				expect(test.openResources).toBe(0);
				expect(outcome.result).toMatchObject({ details: { openResources: 0 }, isError: true });
				expect(JSON.stringify(outcome)).not.toContain("PRIVATE-CANCELLATION-CAUSE");
			} finally {
				controller.abort();
				test.release.resolve();
				await pending.catch(() => {});
				if (test.executions > 0) await test.closed.promise;
			}
		});
	}
	for (const [name, behavior] of [
		["ordinary", undefined],
		["per-call opt-out", perCall],
	] as const) {
		it(`keeps early cancellation for ${name} work despite a forged argument`, async () => {
			const test = fixture(behavior);
			const controller = new AbortController();
			const pending = dispatchToolCommand(
				test.state,
				"lifecycle",
				{ mode: "ordinary", cancellationBehavior: "await-cleanup" },
				"ordinary",
				controller.signal,
			);
			void pending.catch(() => {});
			try {
				await test.started.promise;
				controller.abort();
				await expect(pending).rejects.toBeInstanceOf(Error);
				expect(test.openResources).toBe(1);
			} finally {
				controller.abort();
				test.release.resolve();
				await pending.catch(() => {});
				if (test.executions > 0) await test.closed.promise;
			}
			expect(test.openResources).toBe(0);
		});
	}
	it("refuses pre-cancelled work before acquiring any resource", async () => {
		const test = fixture("await-cleanup");
		await expect(
			dispatchToolCommand(test.state, "lifecycle", { mode: "cleanup" }, "pre-cancelled", AbortSignal.abort()),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(test.executions).toBe(0);
		expect(test.openResources).toBe(0);
	});
});
