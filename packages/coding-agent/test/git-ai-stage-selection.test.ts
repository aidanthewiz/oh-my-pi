import { describe, expect, it } from "bun:test";
import { shouldStageWholePickedFiles } from "../src/cli/git-tui/ai-stage";

describe("git AI stage whole-file fallback", () => {
	it("requires every hunk judgment to succeed and reject", () => {
		expect(shouldStageWholePickedFiles(true, 2, 0, 0)).toBe(true);
		expect(shouldStageWholePickedFiles(true, 2, 0, 1)).toBe(false);
	});
});
