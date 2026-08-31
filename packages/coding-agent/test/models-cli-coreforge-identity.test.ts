import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runModelsCommand } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as identityStartup from "@oh-my-pi/pi-coding-agent/identity/startup";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("models CLI managed identity", () => {
	it("applies managed identity before refreshing provider catalogs", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-models-identity-"));
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		const settings = Settings.isolated({ extensions: [], enabledModels: [] });
		const previousProfile = Bun.env.OMP_MODEL_AWS_PROFILE;

		vi.spyOn(sdk, "discoverAuthStorage").mockResolvedValue(authStorage);
		vi.spyOn(Settings, "init").mockResolvedValue(settings);
		vi.spyOn(identityStartup, "ensureCoreforgeIdentityAtStartup").mockImplementation(async () => {
			Bun.env.OMP_MODEL_AWS_PROFILE = "coreforge";
			return { notices: [] };
		});
		vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(async () => {
			expect(Bun.env.OMP_MODEL_AWS_PROFILE).toBe("coreforge");
		});
		vi.spyOn(ModelRegistry.prototype, "refreshRuntimeProviders").mockResolvedValue();
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);

		try {
			await runModelsCommand({
				action: "ls",
				flags: { json: true, noExtensions: true },
			});
		} finally {
			if (previousProfile === undefined) delete Bun.env.OMP_MODEL_AWS_PROFILE;
			else Bun.env.OMP_MODEL_AWS_PROFILE = previousProfile;
			removeSyncWithRetries(tempDir);
		}
	});
});
