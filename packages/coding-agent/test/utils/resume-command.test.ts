import { afterEach, describe, expect, it } from "bun:test";
import { CF_COMMAND } from "@oh-my-pi/pi-coding-agent/cli/cf-version";
import { resumeCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import { getActiveProfile, setProfile } from "@oh-my-pi/pi-utils/dirs";

describe("resumeCommand", () => {
	const originalProfile = getActiveProfile();

	afterEach(() => {
		setProfile(originalProfile);
	});

	it("omits the profile flag in the default profile", () => {
		setProfile(undefined);
		expect(resumeCommand("abc123")).toBe(`${CF_COMMAND} --resume abc123`);
	});

	it("carries the active profile so the emitted hint is runnable verbatim", () => {
		// Profile sessions live in ~/.omp/profiles/<name>/agent, so a resume hint
		// without --profile fails with "Session not found" (issue #9018).
		setProfile("personal");
		expect(resumeCommand("abc123")).toBe(`${CF_COMMAND} --profile personal --resume abc123`);
	});
});
