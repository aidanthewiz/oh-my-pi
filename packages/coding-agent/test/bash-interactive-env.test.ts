import { expect, test } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { runInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-interactive";
import { TempDir } from "@oh-my-pi/pi-utils";

function headlessUi(): NonNullable<AgentToolContext["ui"]> {
	// The test only exercises `custom`; the production context supplies the other UI methods.
	return {
		custom<T>(factory: (...args: unknown[]) => unknown): Promise<T> {
			return new Promise<T>(resolve => {
				factory(
					{
						terminal: { columns: 80, rows: 24 },
						requestRender() {},
					},
					{},
					{},
					resolve,
				);
			});
		},
	} as unknown as NonNullable<AgentToolContext["ui"]>;
}

test("interactive PTY commands receive only the filtered replacement environment", async () => {
	const original = Bun.env.MANAGED_PROFILE_SECRET;
	const tempDir = TempDir.createSync("@omp-filtered-pty-env-");
	try {
		Bun.env.MANAGED_PROFILE_SECRET = "parent-secret";
		const command = `printf "%s|%s" "\${MANAGED_PROFILE_SECRET-unset}" "\${EXPLICIT_SAFE-unset}" > filtered-env.txt`;
		const result = await runInteractiveBashPty(headlessUi(), {
			command,
			application: "/bin/bash",
			args: ["-c", command],
			cwd: tempDir.path(),
			env: {
				MANAGED_PROFILE_SECRET: "caller-secret",
				EXPLICIT_SAFE: "explicit-value",
			},
		});

		expect(result.exitCode).toBe(0);
		expect(await Bun.file(`${tempDir.path()}/filtered-env.txt`).text()).toBe("unset|explicit-value");
	} finally {
		if (original === undefined) delete Bun.env.MANAGED_PROFILE_SECRET;
		else Bun.env.MANAGED_PROFILE_SECRET = original;
		tempDir.removeSync();
	}
});
