import { expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { SpawnRun } from "@oh-my-pi/pi-coding-agent/task/spawn-run";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

const permit = { acquire: async () => {}, release: () => {} };
const done = { content: [{ type: "text", text: "done" }] } as AgentToolResult<TaskToolDetails>;

it("does not cancel a settled run when its former owner aborts", async () => {
	const owner = new AbortController();
	let bodySignal: AbortSignal | undefined;
	const run = new SpawnRun(permit, async ({ signal }) => {
		bodySignal = signal;
		return done;
	});
	run.attach({ signal: owner.signal });
	await run.result;
	owner.abort(new Error("owner cancelled after completion"));
	expect(bodySignal?.aborted).toBe(false);
});

it("propagates the owner cancellation reason to an unsettled run", async () => {
	const owner = new AbortController();
	let bodySignal: AbortSignal | undefined;
	const run = new SpawnRun(permit, ({ signal }) => {
		bodySignal = signal;
		const { promise, resolve } = Promise.withResolvers<AgentToolResult<TaskToolDetails>>();
		signal.addEventListener("abort", () => resolve(done), { once: true });
		return promise;
	});
	run.attach({ signal: owner.signal });
	await run.started;
	const reason = new Error("owner cancelled");
	owner.abort(reason);
	await run.result;
	expect(bodySignal?.aborted).toBe(true);
	expect(bodySignal?.reason).toBe(reason);
});
