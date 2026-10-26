import { afterEach, describe, expect, test, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { CompletionProbeInput, Provider } from "@oh-my-pi/pi-ai";
import { createStrictCompletionProbe } from "../../src/cli/auth-gateway-cli";
import { Settings } from "../../src/config/settings";

afterEach(() => {
	vi.restoreAllMocks();
});

function oauthProbeInput(provider: Provider): CompletionProbeInput {
	return {
		provider,
		credentialId: 1,
		credential: {
			type: "oauth",
			accessToken: "access-token",
			refreshToken: "refresh-token",
			expiresAt: 1_900_000_000_000,
			projectId: "project-1",
		},
		signal: new AbortController().signal,
	};
}

/** Runs one strict probe and returns the apiKey the chat request received. */
async function probeApiKey(provider: Provider): Promise<string | undefined> {
	const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "stop",
		content: [{ type: "text", text: "pong" }],
	} as never);
	const result = await createStrictCompletionProbe(Settings.isolated())(oauthProbeInput(provider));
	expect(result.ok).toBe(true);
	const apiKey = complete.mock.calls[0]?.[2]?.apiKey;
	return typeof apiKey === "string" ? apiKey : undefined;
}

describe("auth-gateway check --strict completion probe", () => {
	test("sends the structured credential blob for a structured-format OAuth provider", async () => {
		const apiKey = await probeApiKey("alibaba-coding-plan" as Provider);
		expect(JSON.parse(apiKey ?? "")).toMatchObject({ token: "access-token", projectId: "project-1" });
	});

	test("sends the raw access token for a bearer-format OAuth provider", async () => {
		expect(await probeApiKey("anthropic" as Provider)).toBe("access-token");
	});

	test.each([
		{ disabledProviders: ["anthropic"] },
		{ disabledModels: ["anthropic/*"] },
		{ enabledModels: ["openai/*"] },
	])("skips completion requests excluded by model policy %j", async policy => {
		const complete = vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			throw new Error("A disallowed model must not reach completion dispatch");
		});
		const result = await createStrictCompletionProbe(Settings.isolated(policy))(oauthProbeInput("anthropic"));
		expect(result.ok).toBeNull();
		expect(complete).not.toHaveBeenCalled();
	});

	test("does not escape an allowed model after a stale-model rejection", async () => {
		const complete = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "error",
			errorMessage: "model not found",
			content: [],
		} as never);
		const result = await createStrictCompletionProbe(
			Settings.isolated({ enabledModels: ["anthropic/claude-sonnet-4-5"] }),
		)(oauthProbeInput("anthropic"));
		expect(result.ok).toBe(false);
		expect(complete.mock.calls.map(([model]) => `${model.provider}/${model.id}`)).toEqual([
			"anthropic/claude-sonnet-4-5",
		]);
	});
});
