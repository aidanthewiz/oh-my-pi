import { expect, it, spyOn } from "bun:test";
import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import * as compiler from "@oh-my-pi/pi-coding-agent/eval/js/shared/rewrite-imports";

it("does not evaluate a cell cancelled while compilation is pending", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const wrapCode = compiler.wrapCode;
	const compile = spyOn(compiler, "wrapCode").mockImplementation(async code => {
		entered.resolve();
		await release.promise;
		return await wrapCode(code);
	});
	const marker = `__omp_compile_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
	const globals = globalThis as Record<string, unknown>;
	globals[marker] = "untouched";
	const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "compile-cancel" });
	const controller = new AbortController();
	let pending: Promise<unknown> | undefined;
	try {
		pending = runtime
			.run(`globalThis[${JSON.stringify(marker)}] = "evaluated"`, undefined, {
				onText: () => {},
				onDisplay: () => {},
				callTool: async () => undefined,
				onEvaluate: () => controller.signal.throwIfAborted(),
			})
			.catch(error => error);
		await entered.promise;
		const reason = new Error("cancelled before evaluation");
		controller.abort(reason);
		release.resolve();
		expect(await pending).toBe(reason);
		expect(globals[marker]).toBe("untouched");
	} finally {
		release.resolve();
		await pending;
		compile.mockRestore();
		runtime.dispose();
		delete globals[marker];
	}
});
