import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it.each(["restart-work", "default"])(
	"native restart preserves profile %s and reopens its persisted session",
	async profile => {
		using tempDir = TempDir.createSync("@omp-restart-profile-");
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/restart-profile.ts"), "--profile", "stale-profile"],
			{
				cwd: tempDir.path(),
				env: {
					...process.env,
					// os.homedir() reads USERPROFILE on Windows, HOME elsewhere.
					HOME: tempDir.path(),
					USERPROFILE: tempDir.path(),
					OMP_RESTART_TEST_PROFILE: profile === "default" ? "" : profile,
					PI_CONFIG_FILES: undefined,
					OMP_MANAGED_CONFIG_FILE: undefined,
					OMP_LAUNCH_CWD: undefined,
					BUN_OPTIONS: undefined,
					OMP_PROFILE: undefined,
					PI_PROFILE: undefined,
					PI_CODING_AGENT_DIR: undefined,
					PI_CODING_AGENT_SESSION_DIR: undefined,
					PI_CONFIG_DIR: ".omp",
					XDG_DATA_HOME: undefined,
					XDG_STATE_HOME: undefined,
					XDG_CACHE_HOME: undefined,
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const result = JSON.parse(stdout.trim());
		expect(result.profile).toBe(profile);
		expect(result.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({ role: "user", content: "profile restart marker" }),
				}),
			]),
		);
	},
	30_000,
);
