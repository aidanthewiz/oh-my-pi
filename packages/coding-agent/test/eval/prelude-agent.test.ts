import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import * as vm from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { createHelpers } from "../../src/eval/js/shared/helpers";
import { AsyncJobManager } from "../../src/async/job-manager";
import { runEvalWait } from "../../src/eval/handle-bridge";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { loadPrelude, preludeHelper } from "../helpers/prelude-sandbox";

type AgentHelper = (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;

describe("eval js agent() handle", () => {
	it("throws when the bridge omits the handle id", async () => {
		const sandbox = loadPrelude(async () => ({ text: "lonely" }));
		// The factory returns a thenable handle wrapper, so normalize to a Promise
		// before asserting rejection (Bun's `.rejects` requires a real Promise).
		await expect(Promise.resolve(preludeHelper<AgentHelper>(sandbox, "agent")("x"))).rejects.toThrow(
			"agent() did not return a handle",
		);
	});

	it("parses wait() text as JSON only when a schema was given", async () => {
		const sandbox = loadPrelude(async name => {
			if (name === "__agent__") return { id: "id-9", agent: "task" };
			if (name === "__wait__") return { items: [{ status: "completed", text: '{"k":1}' }] };
			throw new Error(`unexpected bridge call ${name}`);
		});
		const withSchema = (await preludeHelper<AgentHelper>(sandbox, "agent")("emit", {
			schema: { type: "object" },
		})) as { wait(): Promise<unknown> };
		expect(await withSchema.wait()).toEqual({ k: 1 });

		const plain = (await preludeHelper<AgentHelper>(sandbox, "agent")("emit")) as {
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
		const completion = preludeHelper<(prompt: string, opts?: unknown) => { wait(): Promise<unknown> }>(
			sandbox,
			"completion",
		);

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
		const waitAll = preludeHelper<(handles: unknown) => Promise<unknown[]>>(sandbox, "wait");

		expect(await waitAll(preludeHelper<AgentHelper>(sandbox, "agent")("go"))).toEqual(["done"]);
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
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			asyncJobManager: manager,
			getAgentId: () => "Main",
		};
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
	// Over the 50 KB a bare `:raw` read through the read tool inlines, with a line wider than any column cap.
	const largeSpill = ["head", "w".repeat(60_000), ...Array.from({ length: 3000 }, (_, i) => `row ${i}`), ""].join(
		"\n",
	);

	it("reads a large spill local://<N>.log from the injected root without the read tool", async () => {
		using tmp = TempDir.createSync("@eval-prelude-spill-");
		await Bun.write(path.join(tmp.path(), "7.log"), largeSpill);
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			return { text: "from the read tool" };
		});
		sandbox.__omp_helpers__ = createHelpers({
			cwd: () => process.cwd(),
			env: new Map(),
			localRoots: () => ({ local: tmp.path() }),
			emitStatus: () => {},
		});

		expect(await vm.runInContext(`read("local://7.log")`, sandbox)).toBe(largeSpill);
		expect(await vm.runInContext(`read("local://7.log", { offset: 2, limit: 2 })`, sandbox)).toBe(
			`${"w".repeat(60_000)}\nrow 0`,
		);
		expect(calls).toEqual([]);
	});
});

describe("eval js output() options (issue #17455)", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	// Over the 50 KB the read tool pages agent:// at, so only a verbatim read reaches the tail.
	const rows = Array.from({ length: 4000 }, (_, i) => `ROW ${i + 1} ${"x".repeat(20)}`);

	/** The prelude behind the real eval bridge: schema validation, then the built-in read tool on agent://. */
	async function loadOutputPrelude(tmp: TempDir): Promise<Record<string, unknown>> {
		const artifacts = path.join(tmp.path(), "artifacts");
		await Bun.write(path.join(artifacts, "Scout.md"), `${rows.join("\n")}\n`);
		await Bun.write(
			path.join(artifacts, "Report.md"),
			JSON.stringify({ files: [{ path: "a.ts" }, { path: "b.ts" }] }),
		);
		await Bun.write(path.join(artifacts, "Shell.md"), "\x1b[31mred\x1b[0m plain\n");
		await Bun.write(path.join(artifacts, "Wide.md"), `${"w".repeat(60_000)}\nlast\n`);
		registerArtifactsDir(artifacts);
		const session: ToolSession = {
			cwd: tmp.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifacts,
			settings: Settings.isolated(),
		};
		const readTool = new ReadTool(session);
		session.getToolByName = name => (name === "read" ? (readTool as unknown as AgentTool) : undefined);
		const sandbox = loadPrelude((name, args) => callSessionTool(name, args, { session }));
		sandbox.__omp_helpers__ = createHelpers({
			cwd: () => tmp.path(),
			env: new Map(),
			localRoots: () => ({}),
			emitStatus: () => {},
		});
		return sandbox;
	}

	it("selects the offset/limit line window, verbatim past the read tool's page", async () => {
		using tmp = TempDir.createSync("@eval-prelude-output-lines-");
		const sandbox = await loadOutputPrelude(tmp);

		expect(await vm.runInContext(`output("Scout", { offset: 3990, limit: 2 })`, sandbox)).toBe(
			`${rows[3989]}\n${rows[3990]}`,
		);
		expect(await vm.runInContext(`output("Scout")`, sandbox)).toBe(`${rows.join("\n")}\n`);
		expect(await vm.runInContext(`output("Wide", { offset: 2, limit: 1 })`, sandbox)).toBe("last");
		expect(await vm.runInContext(`output("Scout", "Shell", { limit: 1 })`, sandbox)).toEqual([
			{ id: "Scout", content: rows[0] },
			{ id: "Shell", content: "\x1b[31mred\x1b[0m plain" },
		]);
		await expect(vm.runInContext(`output("Scout", { offset: 4001 })`, sandbox)).rejects.toThrow(
			"Offset 4001 is beyond end of output (4000 lines) for Scout",
		);
	});

	it("extracts a JSON query and refuses to combine it with a line window", async () => {
		using tmp = TempDir.createSync("@eval-prelude-output-query-");
		const sandbox = await loadOutputPrelude(tmp);

		expect(await vm.runInContext(`output("Report", { query: ".files[1].path" })`, sandbox)).toBe('"b.ts"');
		expect(await vm.runInContext(`output("Report", { query: ".files[5]" })`, sandbox)).toBe("null");
		await expect(vm.runInContext(`output("Scout", { query: ".x" })`, sandbox)).rejects.toThrow(
			"Output Scout is not valid JSON",
		);
		await expect(vm.runInContext(`output("Report", { query: ".files", limit: 1 })`, sandbox)).rejects.toThrow(
			"query cannot be combined with offset/limit",
		);
	});

	it("strips ANSI for format stripped and returns metadata for format json", async () => {
		using tmp = TempDir.createSync("@eval-prelude-output-format-");
		const sandbox = await loadOutputPrelude(tmp);

		expect(await vm.runInContext(`output("Shell", { format: "stripped" })`, sandbox)).toBe("red plain\n");
		expect(await vm.runInContext(`output("Scout", { format: "json", offset: 2, limit: 1 })`, sandbox)).toEqual({
			id: "Scout",
			path: path.join(tmp.path(), "artifacts", "Scout.md"),
			line_count: 4000,
			char_count: rows.join("\n").length + 1,
			content: rows[1],
			range: { start_line: 2, end_line: 2, total_lines: 4000 },
		});
	});

	it("keeps the previous-run banner while the agent streams a follow-up, but queries the published data", async () => {
		using tmp = TempDir.createSync("@eval-prelude-output-superseded-");
		const sandbox = await loadOutputPrelude(tmp);
		const registry = AgentRegistry.global();
		for (const id of ["Scout", "Report"]) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				session: { isStreaming: true, runStartedAt: Date.now() } as AgentSession,
				status: "running",
			});
		}

		expect(await vm.runInContext(`output("Scout", { limit: 1 })`, sandbox)).toContain("PREVIOUS run");
		expect(await vm.runInContext(`output("Report", { query: ".files[0].path" })`, sandbox)).toBe('"a.ts"');

		registry.setStatus("Scout", "idle");
		expect(await vm.runInContext(`output("Scout")`, sandbox)).toBe(`${rows.join("\n")}\n`);
	});
});
