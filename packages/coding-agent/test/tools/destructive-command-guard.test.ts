import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type DcgProcessResult,
	type DcgProcessRunner,
	enforceDestructiveCommandGuard,
} from "@oh-my-pi/pi-coding-agent/tools/destructive-command-guard";

function output(command: string, decision: "allow" | "deny", extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schema_version: 1,
		dcg_version: "0.6.7",
		robot_mode: true,
		command,
		decision,
		agent: { detected: "pi" },
		...extra,
	});
}

describe("Destructive Command Guard enforcement", () => {
	let tempDir: string;
	let configPath: string;
	let env: Record<string, string>;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-dcg-"));
		configPath = path.join(tempDir, "dcg.toml");
		const contents = '[packs]\nenabled = ["core"]\n';
		fs.writeFileSync(configPath, contents);
		const binaryPath = path.join(tempDir, "dcg");
		const binaryContents = "pinned dcg binary";
		fs.writeFileSync(binaryPath, binaryContents);
		env = {
			PATH: process.env.PATH ?? "",
			DCG_BYPASS: "1",
			AWS_SECRET_ACCESS_KEY: "must-not-reach-dcg",
			DCG_DISABLE: "core.git",
			OMP_DCG_PATH: binaryPath,
			OMP_DCG_VERSION: "0.6.7",
			OMP_DCG_BINARY_SHA256: createHash("sha256").update(binaryContents).digest("hex"),
			OMP_DCG_CONFIG: configPath,
			OMP_DCG_CONFIG_SHA256: createHash("sha256").update(contents).digest("hex"),
		};
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("allows only a valid explicit allow and sanitizes DCG control variables", async () => {
		let invocation: Parameters<DcgProcessRunner>[0] | undefined;
		const run: DcgProcessRunner = async options => {
			invocation = options;
			return { exitCode: 0, stdout: output(options.command, "allow"), stderr: "" };
		};

		await enforceDestructiveCommandGuard("git status", tempDir, undefined, { env, run });

		expect(invocation?.binaryPath).toBe(env.OMP_DCG_PATH);
		expect(invocation?.cwd).toBe(tempDir);
		expect(invocation?.env.DCG_BYPASS).toBeUndefined();
		expect(invocation?.env.DCG_DISABLE).toBeUndefined();
		expect(invocation?.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(invocation?.env.DCG_CONFIG).toBe(configPath);
		expect(invocation?.env.DCG_ALLOWLIST_SYSTEM_PATH).toBe("");
		expect(invocation?.env.DCG_HISTORY_DISABLED).toBe("1");
		expect(invocation?.env.PI_CODING_AGENT).toBe("true");
	});

	it("surfaces DCG rule denials", async () => {
		const run: DcgProcessRunner = async options => ({
			exitCode: 1,
			stdout: output(options.command, "deny", {
				rule_id: "core.git:reset-hard",
				reason: "git reset --hard destroys uncommitted changes.",
			}),
			stderr: "",
		});

		await expect(
			enforceDestructiveCommandGuard("git reset --hard HEAD", tempDir, undefined, { env, run }),
		).rejects.toThrow(
			"Command blocked by Destructive Command Guard (core.git:reset-hard): git reset --hard destroys uncommitted changes.",
		);
	});

	it("fails closed on protocol and process inconsistencies", async () => {
		const cases: DcgProcessResult[] = [
			{ exitCode: 3, stdout: "", stderr: "configuration error" },
			{ exitCode: 0, stdout: output("different command", "allow"), stderr: "" },
			{ exitCode: 0, stdout: output("git status", "deny"), stderr: "" },
			{ exitCode: 0, stdout: output("git status", "allow", { allowlist: { layer: "user" } }), stderr: "" },
		];

		for (const result of cases) {
			await expect(
				enforceDestructiveCommandGuard("git status", tempDir, undefined, {
					env,
					run: async () => result,
				}),
			).rejects.toThrow(/Command blocked because Destructive Command Guard could not verify safety/u);
		}
	});

	it("fails closed when managed configuration is incomplete or modified", async () => {
		const incomplete = { ...env };
		delete incomplete.OMP_DCG_CONFIG_SHA256;
		await expect(
			enforceDestructiveCommandGuard("git status", tempDir, undefined, { env: incomplete }),
		).rejects.toThrow("incomplete managed configuration");

		fs.appendFileSync(configPath, "# modified\n");
		await expect(enforceDestructiveCommandGuard("git status", tempDir, undefined, { env })).rejects.toThrow(
			"managed policy checksum does not match the Coreforge pin",
		);

		fs.writeFileSync(configPath, '[packs]\nenabled = ["core"]\n');
		fs.writeFileSync(env.OMP_DCG_PATH, "modified executable");
		await expect(enforceDestructiveCommandGuard("git status", tempDir, undefined, { env })).rejects.toThrow(
			"managed executable checksum does not match the Coreforge pin",
		);
	});

	it("fails closed when a required managed contract disappears", async () => {
		await expect(
			enforceDestructiveCommandGuard("git status", tempDir, undefined, {
				env: { PATH: process.env.PATH },
				required: true,
			}),
		).rejects.toThrow("managed configuration disappeared after startup");
	});

	it.skipIf(process.platform === "win32")(
		"bounds cleanup when DCG ignores graceful termination",
		async () => {
			const script = "#!/bin/sh\ntrap '' TERM INT\nwhile :; do :; done\n";
			fs.writeFileSync(env.OMP_DCG_PATH, script, { mode: 0o755 });
			fs.chmodSync(env.OMP_DCG_PATH, 0o755);
			env.OMP_DCG_BINARY_SHA256 = createHash("sha256").update(script).digest("hex");

			const startedAt = Date.now();
			await expect(enforceDestructiveCommandGuard("git status", tempDir, undefined, { env })).rejects.toThrow(
				"dcg exceeded the 3000ms decision deadline",
			);
			expect(Date.now() - startedAt).toBeLessThan(4_000);
		},
		6_000,
	);

	it("stays opt-in when no managed DCG environment is present", async () => {
		let invoked = false;
		await enforceDestructiveCommandGuard("git status", tempDir, undefined, {
			env: { PATH: process.env.PATH },
			run: async () => {
				invoked = true;
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		});
		expect(invoked).toBe(false);
	});
});
