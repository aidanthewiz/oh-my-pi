import { describe, expect, it, vi } from "bun:test";
import * as vm from "node:vm";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import { AsyncJobManager } from "../../src/async/job-manager";
import { runEvalWait } from "../../src/eval/handle-bridge";
import type { ToolSession } from "../../src/tools";

// Run the shipped prelude with the real handle wait bridge where timing and settlement matter.
function loadPrelude(callTool: (name: string, args: unknown) => Promise<unknown>): Record<string, unknown> {
	const sandbox: Record<string, unknown> = { __omp_call_tool__: callTool };
	vm.createContext(sandbox);
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
	return sandbox;
}

type AgentHelper = (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;

describe("eval js agent() handle", () => {
	it("throws when the bridge omits the handle id", async () => {
		const sandbox = loadPrelude(async () => ({ text: "lonely" }));
		// The factory returns a thenable handle wrapper, so normalize to a Promise
		// before asserting rejection (Bun's `.rejects` requires a real Promise).
		await expect(Promise.resolve((sandbox.agent as AgentHelper)("x"))).rejects.toThrow(
			"agent() did not return a handle",
		);
	});

	it("parses wait() text as JSON only when a schema was given", async () => {
		const sandbox = loadPrelude(async name => {
			if (name === "__agent__") return { id: "id-9", agent: "task" };
			if (name === "__wait__") return { items: [{ status: "completed", text: '{"k":1}' }] };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const withSchema = (await (sandbox.agent as AgentHelper)("emit", {
			schema: { type: "object" },
		})) as { wait(): Promise<unknown> };
		expect(await withSchema.wait()).toEqual({ k: 1 });

		const plain = (await (sandbox.agent as AgentHelper)("emit")) as {
			wait(): Promise<unknown>;
		};
		expect(await plain.wait()).toBe('{"k":1}');
	});
});

describe("eval js immediate-handle contract", () => {
	// Regression for #10986: the JS factories return immediately, so the
	// documented pattern `const h = completion(...); await h.wait()` must work
	// without first `await`-ing the factory itself.
	it("exposes handle methods on the un-awaited factory result", async () => {
		const sandbox = loadPrelude(async name => {
			if (name === "__completion__") return { id: "c-1" };
			if (name === "__wait__") return { items: [{ status: "completed", text: "OK" }] };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const completion = sandbox.completion as (prompt: string, opts?: unknown) => { wait(): Promise<unknown> };

		const handle = completion("Return OK", { model: "smol" });
		expect(typeof handle.wait).toBe("function");
		expect(await handle.wait()).toBe("OK");
	});

	it("treats an un-awaited factory result as a single handle in wait()", async () => {
		const sandbox = loadPrelude(async name => {
			if (name === "__agent__") return { id: "a-2", agent: "task" };
			if (name === "__wait__") return { items: [{ status: "completed", text: "done" }] };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const waitAll = sandbox.wait as (handles: unknown) => Promise<unknown[]>;

		expect(await waitAll((sandbox.agent as AgentHelper)("go"))).toEqual(["done"]);
	});
});

describe("eval js wait options", () => {
	type Waitable = { wait(...args: unknown[]): Promise<unknown> };
	type WaitHelper = (handles: unknown, opts?: unknown, ...rest: unknown[]) => Promise<unknown[]>;

	function fixture() {
		const manager = new AsyncJobManager({});
		const gate = Promise.withResolvers<string>();
		const entered = Promise.withResolvers<void>();
		const id = manager.register("task", "controlled agent", () => gate.promise, { ownerId: "Main" });
		const session = { asyncJobManager: manager, getAgentId: () => "Main" } as ToolSession;
		const sandbox = loadPrelude(async (name, args) => {
			if (name === "__agent__") return { id, agent: "task" };
			if (name === "__wait__") {
				const waiting = runEvalWait(args, { session });
				entered.resolve();
				return waiting;
			}
			throw new Error(`unexpected bridge call ${name}`);
		});
		return { sandbox, manager, gate, entered, id };
	}

	it.each([
		"wait(agent('go'), 1)",
		"wait(agent('go'), { timeout: 1 })",
		"(await agent('go')).wait(1)",
		"(await agent('go')).wait({ timeout: 1 })",
		"agent('go').wait(1)",
		"agent('go').wait({ timeout: 1 })",
	])("times out after one second without cancelling the agent: %s", async expression => {
		vi.useFakeTimers();
		const { sandbox, manager, gate, entered, id } = fixture();
		try {
			let settled = false;
			const result = vm.runInContext(
				`(async () => { try { await ${expression}; return "unexpected completion"; } catch (error) { return error.name; } })()`,
				sandbox,
			) as Promise<string>;
			void result.then(() => {
				settled = true;
			});
			await entered.promise;
			vi.advanceTimersByTime(999);
			await Promise.resolve();
			expect(settled).toBe(false);
			vi.advanceTimersByTime(1);
			expect(await result).toBe("TimeoutError");
			expect(manager.getJob(id)?.status).toBe("running");
		} finally {
			gate.resolve("released");
			await manager.dispose();
			vi.useRealTimers();
		}
	});

	it.each([
		"wait(agent('go'), 1, false).then(values => values[0])",
		"wait(agent('go'), { timeout: 1, raiseErrors: false }).then(values => values[0])",
		"(await agent('go')).wait(1, false)",
		"(await agent('go')).wait({ timeout: 1, raiseErrors: false })",
		"agent('go').wait(1, false)",
		"agent('go').wait({ timeout: 1, raiseErrors: false })",
	])("returns a failed agent's error when raiseErrors is false: %s", async expression => {
		const { sandbox, manager, gate } = fixture();
		try {
			const result = vm.runInContext(`(async () => await ${expression})()`, sandbox) as Promise<Error>;
			gate.reject(new Error("agent execution failed"));
			expect((await result).message).toBe("agent execution failed");
		} finally {
			await manager.dispose();
		}
	});

	it("rejects mixing an options object with positional args", async () => {
		const { sandbox, manager, gate } = fixture();
		try {
			const agent = sandbox.agent as (prompt: string) => Waitable;
			const resolved = (await agent("resolved")) as Waitable;
			const mixed = /do not mix both forms/;
			await expect((sandbox.wait as WaitHelper)([resolved], { timeout: 10 }, true)).rejects.toThrow(mixed);
			await expect(resolved.wait({ timeout: 1 }, 2)).rejects.toThrow(mixed);
			await expect(agent("pending").wait({ timeout: 1 }, 2)).rejects.toThrow(mixed);
		} finally {
			gate.resolve("released");
			await manager.dispose();
		}
	});
});

describe("eval js read() URI delegation", () => {
	it("appends line selectors to delegated URI paths", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			return { text: "resource contents" };
		});
		sandbox.__omp_helpers__ = { hasRoot: () => false };

		const result = await vm.runInContext(`read("mcp://server/resource", { offset: 10, limit: 5 })`, sandbox);

		expect(result).toBe("resource contents");
		expect(calls).toEqual([
			{
				name: "read",
				args: { path: "mcp://server/resource:10-14" },
			},
		]);
	});
});
