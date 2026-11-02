import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import {
	createAgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => vi.restoreAllMocks());

function providerConfig(ids: string[]): ProviderConfigInput {
	return {
		baseUrl: "https://synthetic.invalid/v1",
		apiKey: "synthetic-key",
		api: "openai-completions",
		models: ids.map(id => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		})),
	};
}

async function withCatalog(
	run: (fixture: {
		settings: Settings;
		build: (args: string[]) => Promise<CreateAgentSessionOptions>;
		create: (args: string[], extensions?: ExtensionFactory[]) => Promise<CreateAgentSessionResult>;
	}) => Promise<void>,
) {
	using temp = TempDir.createSync("@omp-provider-authority-");
	const authStorage = createInMemoryAuthStorage();
	const settings = Settings.isolated({ "memory.backend": "off" });
	const registry = new ModelRegistry(authStorage, temp.join("models.yml"), {
		settings,
		cacheDbPath: temp.join("models.db"),
	});
	// Caller-owned registrations must survive the SDK's extension-source reconciliation.
	registry.registerProvider("private", providerConfig(["different"]));
	registry.registerProvider("router", providerConfig(["private/requested"]));
	vi.spyOn(registry, "getDiscoverableProviders").mockReturnValue([]);
	const preconnect = () => {
		throw new Error("Unexpected network preconnect");
	};
	const network = vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async () => {
				throw new Error("Unexpected network request");
			},
			{ preconnect },
		),
	);
	Object.assign(network, { preconnect });
	const sessions: CreateAgentSessionResult[] = [];
	const build = (args: string[]) =>
		buildSessionOptions(
			parseArgs(["--cwd", temp.path(), ...args]),
			[],
			SessionManager.inMemory(temp.path()),
			registry,
			settings,
			() => {},
		);
	const create = async (args: string[], extensions: ExtensionFactory[] = []) => {
		const options = await build(args);
		const result = await createAgentSession({
			...options,
			cwd: temp.path(),
			agentDir: path.join(temp.path(), "agent"),
			authStorage,
			modelRegistry: registry,
			settings,
			bindProcessState: false,
			sessionManager: SessionManager.inMemory(temp.path()),
			disableExtensionDiscovery: true,
			extensions,
			preloadedCustomToolPaths: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		});
		sessions.push(result);
		return result;
	};
	try {
		await run({ settings, build, create });
	} finally {
		try {
			for (const result of sessions) await result.session.dispose();
		} finally {
			settings.cancelPendingSaves();
			registry.unregisterProvider("private");
			registry.unregisterProvider("router");
			await authStorage.close();
			expect(network).not.toHaveBeenCalled();
		}
	}
}

describe("explicit provider authority after deferred discovery", () => {
	it.each(["requested", "private/requested"])(
		"TA-CLI-MISS refuses a cross-provider literal collision for %s",
		async selector => {
			await withCatalog(async ({ create }) => {
				const { session, modelFallbackMessage } = await create(["--provider", "private", "--model", selector]);
				expect(session.model).toBeUndefined();
				expect(modelFallbackMessage).toContain("private/requested");
			});
		},
	);

	it("TA-CLI-LATE selects the exact late model under a canonicalized provider constraint", async () => {
		await withCatalog(async ({ create }) => {
			const extension: ExtensionFactory = pi => pi.registerProvider("private", providerConfig(["requested"]));
			const { session, modelFallbackMessage } = await create(
				["--provider", "PRIVATE", "--model", "requested"],
				[extension],
			);
			expect(session.model).toMatchObject({ provider: "private", id: "requested" });
			expect(modelFallbackMessage).toBeUndefined();
		});
	});

	it("TA-CLI-BARE keeps exact literal-ID selection without an explicit provider", async () => {
		await withCatalog(async ({ create }) => {
			const { session } = await create(["--model", "private/requested"]);
			expect(session.model).toMatchObject({ provider: "router", id: "private/requested" });
		});
	});

	it("TA-CLI-DISABLED refuses a disabled provider before deferred extension resolution", async () => {
		await withCatalog(async ({ settings, build }) => {
			cfgDisabledProviders.override(settings, ["private"]);
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const refused = new Error("synthetic process exit");
			const exit = vi.spyOn(process, "exit").mockImplementation(() => {
				throw refused;
			});
			await expect(build(["--provider", "private", "--model", "requested"])).rejects.toBe(refused);
			expect(exit).toHaveBeenCalledWith(1);
			expect(stderr.mock.calls.flat().join("")).toContain("private");
		});
	});
});
