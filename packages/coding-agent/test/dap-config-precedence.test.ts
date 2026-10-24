import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapterConfigs } from "@oh-my-pi/pi-coding-agent/dap/config";
import { loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";

const ADAPTER = "omp-precedence-probe";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("DAP config layering", () => {
	test("a cwd file overrides the project config dir field by field", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-precedence-"));
		await Bun.write(
			path.join(tempDir, ".omp", "dap.yaml"),
			`${ADAPTER}:\n  command: project-cmd\n  args: [from-project]\n`,
		);
		await Bun.write(path.join(tempDir, "dap.json"), JSON.stringify({ [ADAPTER]: { command: "cwd-cmd" } }));

		const adapter = getAdapterConfigs(tempDir)[ADAPTER];

		expect(adapter?.command).toBe("cwd-cmd");
		expect(adapter?.args).toEqual(["from-project"]);
	});

	test("malformed and invalid high-priority DAP sources retain valid lower fields", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dap-invalid-"));
		await Bun.write(
			path.join(tempDir, ".omp", "dap.yml"),
			JSON.stringify({
				[ADAPTER]: { command: "lower-command", args: ["retained"], launchDefaults: { cwd: "/owned" } },
			}),
		);
		await Bun.write(path.join(tempDir, "dap.json"), "{malformed");
		await Bun.write(path.join(tempDir, ".dap.json"), JSON.stringify({ [ADAPTER]: { command: null } }));

		const adapter = getAdapterConfigs(tempDir)[ADAPTER];
		expect(adapter?.command).toBe("lower-command");
		expect(adapter?.args).toEqual(["retained"]);
		expect(adapter?.launchDefaults).toEqual({ cwd: "/owned" });
	});

	test("LSP uses the shared priority stack and skips malformed or rejected files", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-precedence-"));
		await Bun.write(
			path.join(tempDir, ".omp", "lsp.yml"),
			JSON.stringify({
				servers: {
					[ADAPTER]: { command: process.execPath, args: ["lower"], fileTypes: [".probe"], rootMarkers: ["."] },
				},
				idleTimeoutMs: 900,
			}),
		);
		await Bun.write(path.join(tempDir, "lsp.json"), "{malformed");
		await Bun.write(path.join(tempDir, ".lsp.json"), "[]");
		await Bun.write(
			path.join(tempDir, "lsp.yaml"),
			JSON.stringify({ servers: { [ADAPTER]: { args: ["cwd"] } }, idleTimeoutMs: 100 }),
		);

		const config = loadConfig(tempDir);
		expect(config.servers[ADAPTER]?.command).toBe(process.execPath);
		expect(config.servers[ADAPTER]?.args).toEqual(["cwd"]);
		expect(config.servers[ADAPTER]?.fileTypes).toEqual([".probe"]);
		expect(config.idleTimeoutMs).toBe(100);
	});
});
