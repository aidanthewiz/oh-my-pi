import { describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DeepSeekProvider, searchDeepSeek } from "@oh-my-pi/pi-coding-agent/web/search/providers/deepseek";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

describe("DeepSeek search admission", () => {
	it("requires explicit selection even when a chat credential is installed", async () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			authStorage.keys.setRuntime("deepseek", "synthetic-deepseek-key");
			const provider = new DeepSeekProvider();
			expect(provider.isAvailable()).toBe(false);
			expect(provider.isExplicitlyAvailable(authStorage)).toBe(true);
		} finally {
			await authStorage.close();
		}
	});

	it("rejects oversized Unicode queries locally without needing credentials", async () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			const query = String.fromCodePoint(0x10437).repeat(129);
			const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: Settings.isolated() });
			const model = modelRegistry.find("web", "deepseek");
			if (!model) throw new Error("Bundled DeepSeek search model missing");
			const failure = await searchDeepSeek({ query, authStorage, modelRegistry, model, systemPrompt: "" }).catch(
				error => error,
			);
			expect(failure).toBeInstanceOf(SearchProviderError);
			expect(failure).toMatchObject({
				provider: "deepseek",
				status: 400,
			});
		} finally {
			await authStorage.close();
		}
	});
});
