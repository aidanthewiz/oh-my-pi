import { describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { EvalDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/types";
import { splitEvalOutput } from "@oh-my-pi/pi-tui/tools/eval";

async function print(text: string, mode: "console" | "echo" = "console") {
	const runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "json-integer-integrity" });
	const texts: string[] = [];
	const displays: EvalDisplayOutput[] = [];
	const hooks: RuntimeHooks = {
		onText: chunk => {
			texts.push(chunk);
		},
		onDisplay: output => {
			displays.push(output);
		},
		callTool: async () => undefined,
	};
	try {
		if (mode === "console") {
			await runtime.run(`console.log(${JSON.stringify(text)});`, undefined, hooks);
		} else {
			runtime.echo(await runtime.run(`(${JSON.stringify(text)})`, undefined, hooks), hooks);
		}
		const stdout = texts.join("");
		const views = displays.flatMap(output => (output.type === "view" ? [output] : []));
		return { stdout, displays, parts: splitEvalOutput(stdout, views) };
	} finally {
		runtime.dispose();
	}
}

describe("printed JSON numeric integrity", () => {
	for (const mode of ["console", "echo"] as const) {
		it.each([
			'{\n"id":9007199254740993\n}',
			'{\n"id":-9007199254740993\n}',
			'[\n{"id":9007199254740993e0}\n]',
			'{\n"id":900719925474099312345678901234567890\n}',
			'{\n"id":1e309\n}',
		])(`${mode} preserves literal digits rather than substituting a lossy tree: %s`, async text => {
			const result = await print(text, mode);
			expect(result.stdout).toBe(`${text}\n`);
			expect(result.parts).toEqual([{ kind: "text", text: `${text}\n` }]);
			expect(result.displays).toEqual([]);
		});
	}

	it("keeps safe numbers and numeric strings available to the replacement renderer", async () => {
		const text =
			'{\n"max":9007199254740991,"min":-9007199254740991,"id":"9007199254740993","fraction":1.25,"exponent":1e3\n}';
		const view = {
			kind: "json" as const,
			value: {
				max: 9007199254740991,
				min: -9007199254740991,
				id: "9007199254740993",
				fraction: 1.25,
				exponent: 1000,
			},
		};
		const result = await print(text);
		expect(result.stdout).toBe(`${text}\n`);
		expect(result.displays).toEqual([{ type: "view", text, view }]);
		expect(result.parts).toEqual([{ kind: "view", view }]);
	});

	it.each([
		{ size: 80, rich: false },
		{ size: 81, rich: true },
		{ size: 32768, rich: true },
		{ size: 32769, rich: false },
	])("preserves text or a complete replacement at the $size-character boundary", async ({ size, rich }) => {
		const value = { pad: "x".repeat(size - 10) };
		const text = JSON.stringify(value);
		const result = await print(text);
		expect(result.stdout).toBe(`${text}\n`);
		expect(result.parts).toEqual(
			rich ? [{ kind: "view", view: { kind: "json", value } }] : [{ kind: "text", text: `${text}\n` }],
		);
	});

	it("keeps malformed JSON literal while replacing short multiline safe JSON", async () => {
		const malformed = '{\n"id":9007199254740993,\n}';
		const result = await print(malformed);
		expect(result.stdout).toBe(`${malformed}\n`);
		expect(result.parts).toEqual([{ kind: "text", text: `${malformed}\n` }]);
		expect(result.displays).toEqual([]);
		const text = '{\n"id":7\n}';
		const safe = await print(text);
		expect(safe.stdout).toBe(`${text}\n`);
		expect(safe.parts).toEqual([{ kind: "view", view: { kind: "json", value: { id: 7 } } }]);
	});
});
