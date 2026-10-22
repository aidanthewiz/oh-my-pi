import { describe, expect, it } from "bun:test";
import { isReadOnlyComputerCall, renderComputerCall } from "@oh-my-pi/pi-coding-agent/tools/computer/call";

describe("renderComputerCall", () => {
	it("classifies read-only chains by the terminal helper", () => {
		expect(isReadOnlyComputerCall([{ method: "screenshot", args: [] }])).toBe(true);
		expect(isReadOnlyComputerCall([{ method: "type", args: ["x"] }])).toBe(false);
		expect(isReadOnlyComputerCall([{ method: "clipboard.read", args: [] }])).toBe(true);
		expect(
			isReadOnlyComputerCall([
				{ method: "window", args: ["42"] },
				{ method: "ax", args: [] },
			]),
		).toBe(true);
		expect(
			isReadOnlyComputerCall([
				{ method: "window", args: ["42"] },
				{ method: "raise", args: [] },
			]),
		).toBe(false);
		expect(
			isReadOnlyComputerCall([
				{ method: "ref", args: ["e5"] },
				{ method: "bounds", args: [] },
			]),
		).toBe(true);
		expect(
			isReadOnlyComputerCall([
				{ method: "ref", args: ["e5"] },
				{ method: "press", args: [] },
			]),
		).toBe(false);
	});

	it("rejects invalid roots and handle hops before execution", () => {
		for (const chain of [
			[],
			[{ method: "launch", args: [] }],
			[{ method: "toString", args: [] }],
			[
				{ method: "windows", args: [] },
				{ method: "click", args: [1, 2] },
			],
			[
				{ method: "window", args: ["42"] },
				{ method: "setValue", args: ["x"] },
			],
			[
				{ method: "window", args: ["42"] },
				{ method: "toString", args: [] },
			],
			[
				{ method: "ref", args: ["e5"] },
				{ method: "raise", args: [] },
			],
			[
				{ method: "window", args: ["42"] },
				{ method: "find", args: [{}] },
				{ method: "press", args: [] },
			],
		]) {
			expect(() => renderComputerCall(chain)).toThrow();
			expect(() => isReadOnlyComputerCall(chain)).toThrow();
		}
	});
});
