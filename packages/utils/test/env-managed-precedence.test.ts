import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

// The env module applies its .env precedence exactly once, eagerly, at import
// time (it reads Bun.env + the agent-dir .env the moment it loads). So these
// behaviors can only be exercised from a fresh process: each case spawns a
// child that sets a controlled agent dir + ambient env, imports the module,
// and prints the resolved values back.

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

const envUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "src", "env.ts")).href;

/**
 * Spawn a child that loads the env module under a controlled agent-dir `.env`,
 * ambient environment, and launch cwd, then reports the resolved values for
 * `keys`. Returns the parsed `$env` subset the module produced.
 */
async function resolveEnvInChild(opts: {
	agentEnvContent: string;
	ambient: Record<string, string | undefined>;
	keys: string[];
	childKeys?: string[];
	managed: boolean;
	cwd?: string;
	projectEnvContent?: string;
	childOverlay?: Record<string, string | undefined>;
	// Simulate Bun's implicit cwd `.env` autoload: load the project `.env` into
	// the child's Bun.env BEFORE the module runs (via --env-file), reproducing
	// the contamination the shipped engine disables. Used to prove a project
	// `.env` can neither activate managed mode nor leak as ambient fallback.
	autoloadProject?: boolean;
	// When set, model the real shipped launch: a named profile whose agent `.env`
	// lives at `$HOME/.omp/profiles/<profile>/agent/.env`. Named profiles ignore
	// PI_CODING_AGENT_DIR (dirs.ts DirResolver), so this drives OMP_PROFILE + HOME.
	profile?: string;
	// Expect the env module to REFUSE (throw at import): assert non-zero exit and
	// return { __stderr } for message matching instead of parsed values.
	expectThrow?: boolean;
}): Promise<Record<string, string | undefined>> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-managed-env-"));
	try {
		const home = path.join(root, "home");
		const agentDir = opts.profile
			? path.join(home, ".omp", "profiles", opts.profile, "agent")
			: path.join(root, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, ".env"), opts.agentEnvContent);

		const cwd = opts.cwd ?? path.join(root, "cwd");
		await fs.mkdir(cwd, { recursive: true });
		if (opts.projectEnvContent !== undefined) {
			await fs.writeFile(path.join(cwd, ".env"), opts.projectEnvContent);
		}

		// An empty env file to pass to `--env-file`, disabling Bun's cwd `.env`
		// autoload cross-platform (`/dev/null` is not portable to Windows CI).
		const emptyEnvFile = path.join(root, "empty.env");
		await fs.writeFile(emptyEnvFile, "");

		const probePath = path.join(root, "probe.ts");
		await Bun.write(
			probePath,
			[
				`import { $env, filterChildShellEnv } from ${JSON.stringify(envUrl)};`,
				`const keys = ${JSON.stringify(opts.keys)};`,
				`const childKeys = ${JSON.stringify(opts.childKeys ?? [])};`,
				"const out = {};",
				"for (const k of keys) out[k] = $env[k];",
				`const childEnv = filterChildShellEnv(Bun.env, process.cwd(), ${JSON.stringify(opts.childOverlay)});`,
				"for (const k of childKeys) out['child:' + k] = childEnv[k];",
				"process.stdout.write(JSON.stringify(out));",
			].join("\n"),
		);

		// Start from a clean, explicit environment: only what the case declares,
		// plus the agent-dir wiring and PATH so bun can execute. This keeps the
		// host's own ANTHROPIC_*/OPENAI_* exports from leaking into the child.
		// Named-profile cases drive HOME + OMP_PROFILE (the real launch shape);
		// default-profile cases use PI_CODING_AGENT_DIR to point at the temp .env.
		const childEnv: Record<string, string | undefined> = {
			PATH: process.env.PATH,
			// ambient first, so the wiring below is authoritative and a case that
			// puts OMP_DOTENV_OVERRIDE/OMP_PROFILE in `ambient` can't silently
			// contradict `managed`/`profile`.
			...opts.ambient,
			HOME: opts.profile ? home : process.env.HOME,
			...(opts.profile ? { OMP_PROFILE: opts.profile } : { PI_CODING_AGENT_DIR: agentDir }),
			// Set the flag deterministically from `managed` in BOTH directions, so
			// a case that puts OMP_DOTENV_OVERRIDE in `ambient` can never flip the
			// mode: managed -> "1", unmanaged -> undefined (evicted).
			OMP_DOTENV_OVERRIDE: opts.managed ? "1" : undefined,
		};

		// By default the empty `--env-file` disables Bun's implicit cwd `.env`
		// autoload, matching the shipped engine (compiled `--no-compile-autoload-
		// dotenv`, source mode a clean `.dev-cwd`) so we test env.ts, not Bun's
		// preloader. With `autoloadProject`, point `--env-file` at the project
		// `.env` instead, reproducing the autoload contamination the reviewer
		// flagged (project values in Bun.env before the module runs).
		const envFile =
			opts.autoloadProject && opts.projectEnvContent !== undefined ? path.join(cwd, ".env") : emptyEnvFile;
		const proc = Bun.spawn([process.execPath, `--env-file=${envFile}`, probePath], {
			stdout: "pipe",
			stderr: "pipe",
			cwd,
			env: childEnv,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			readStream(proc.stdout as ReadableStream<Uint8Array>),
			readStream(proc.stderr as ReadableStream<Uint8Array>),
			proc.exited,
		]);
		if (opts.expectThrow) {
			expect(exitCode, "expected the env module to refuse (non-zero exit)").not.toBe(0);
			return { __stderr: stderr };
		}
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("managed dotenv precedence (OMP_DOTENV_OVERRIDE=1)", () => {
	it("profile .env OVERRIDES a conflicting ambient value", async () => {
		const out = await resolveEnvInChild({
			agentEnvContent: "OPENAI_API_KEY=from-dotenv\n",
			ambient: { OPENAI_API_KEY: "from-shell" },
			keys: ["OPENAI_API_KEY"],
			managed: true,
		});
		expect(out.OPENAI_API_KEY).toBe("from-dotenv");
	});

	it("ambient FILLS a key the profile .env leaves empty (shell fallback)", async () => {
		const out = await resolveEnvInChild({
			// shipped placeholder: empty value must defer to the ambient export
			agentEnvContent: "OPENAI_API_KEY=\n",
			ambient: { OPENAI_API_KEY: "from-shell" },
			keys: ["OPENAI_API_KEY"],
			managed: true,
		});
		expect(out.OPENAI_API_KEY).toBe("from-shell");
	});

	it("ambient FILLS a key absent from the profile .env entirely", async () => {
		const out = await resolveEnvInChild({
			agentEnvContent: "ANTHROPIC_AWS_WORKSPACE_ID=ws-dotenv\n",
			ambient: { HTTPS_PROXY: "http://corp-proxy:8080" },
			keys: ["HTTPS_PROXY", "ANTHROPIC_AWS_WORKSPACE_ID"],
			managed: true,
		});
		expect(out.HTTPS_PROXY).toBe("http://corp-proxy:8080");
		expect(out.ANTHROPIC_AWS_WORKSPACE_ID).toBe("ws-dotenv");
	});

	it("does NOT consult the project ($CWD) .env for creds", async () => {
		const out = await resolveEnvInChild({
			agentEnvContent: "ANTHROPIC_AWS_WORKSPACE_ID=ws-dotenv\n",
			ambient: {},
			projectEnvContent: "OPENAI_API_KEY=from-project-dir\n",
			keys: ["OPENAI_API_KEY"],
			managed: true,
		});
		// project .env is skipped in managed mode -> the key never resolves
		expect(out.OPENAI_API_KEY).toBeUndefined();
	});

	// The shipped wrapper launches with OMP_PROFILE=coreforge, whose agent `.env`
	// lives at $HOME/.omp/profiles/coreforge/agent/.env. Named profiles ignore
	// PI_CODING_AGENT_DIR, so this exercises the real resolution path — a guard
	// against a wrapper/profile wiring drift where the authoritative `.env` is a
	// different file than the one the override logic reads.
	it("under OMP_PROFILE=coreforge: profile .env overrides ambient, shell fills gaps, project .env skipped", async () => {
		const out = await resolveEnvInChild({
			profile: "coreforge",
			agentEnvContent: "OPENAI_API_KEY=from-dotenv\nANTHROPIC_AWS_WORKSPACE_ID=\n",
			ambient: { OPENAI_API_KEY: "from-shell", ANTHROPIC_AWS_WORKSPACE_ID: "ws-shell" },
			projectEnvContent: "PERPLEXITY_API_KEY=from-project\n",
			keys: ["OPENAI_API_KEY", "ANTHROPIC_AWS_WORKSPACE_ID", "PERPLEXITY_API_KEY"],
			managed: true,
		});
		expect(out.OPENAI_API_KEY).toBe("from-dotenv"); // non-empty .env wins
		expect(out.ANTHROPIC_AWS_WORKSPACE_ID).toBe("ws-shell"); // empty placeholder -> shell fills
		expect(out.PERPLEXITY_API_KEY).toBeUndefined(); // project .env never consulted
	});

	it("keeps managed profile values inside the engine process", async () => {
		const out = await resolveEnvInChild({
			profile: "coreforge",
			agentEnvContent: "AWS_BEARER_TOKEN_BEDROCK=managed-secret\nOPENAI_API_KEY=\n",
			ambient: {
				AWS_BEARER_TOKEN_BEDROCK: "stale-shell",
				OPENAI_API_KEY: "ambient-fallback",
			},
			keys: ["AWS_BEARER_TOKEN_BEDROCK", "OPENAI_API_KEY"],
			childKeys: ["AWS_BEARER_TOKEN_BEDROCK", "OPENAI_API_KEY"],
			managed: true,
		});
		expect(out.AWS_BEARER_TOKEN_BEDROCK).toBe("managed-secret");
		expect(out.OPENAI_API_KEY).toBe("ambient-fallback");
		expect(out["child:AWS_BEARER_TOKEN_BEDROCK"]).toBeUndefined();
		expect(out["child:OPENAI_API_KEY"]).toBeUndefined();
	});

	// Provenance is unrecoverable when Bun's autoload merges the cwd `.env` into
	// Bun.env before the module runs: a launcher-set flag and a project-file flag
	// are byte-identical ("1"). The one ambiguous observable — BOTH Bun.env and
	// the parsed project `.env` carrying "1" — is refused loudly instead of
	// guessed: silently picking managed flips the mode under a raw-bun-autoload
	// user; silently picking default downgrades a real managed launch and lets
	// the project `.env` gap-fill creds. Fail closed, name the file, exit.
	it("REFUSES when a project .env flag reaches Bun.env via autoload (ambiguous provenance)", async () => {
		const out = await resolveEnvInChild({
			managed: false, // launcher did NOT set the flag; only the project file does
			autoloadProject: true,
			agentEnvContent: "ANTHROPIC_AWS_WORKSPACE_ID=ws-agent\n",
			ambient: {},
			projectEnvContent: "OMP_DOTENV_OVERRIDE=1\nOPENAI_API_KEY=from-project\n",
			keys: ["OPENAI_API_KEY", "ANTHROPIC_AWS_WORKSPACE_ID"],
			expectThrow: true,
		});
		// The refusal names the flag and the offending file path.
		expect(out.__stderr).toContain("OMP_DOTENV_OVERRIDE=1 is set in both");
	});

	it("a launcher-flagged run does NOT leak an autoloaded project value into an empty agent key", async () => {
		const out = await resolveEnvInChild({
			managed: true, // launcher set the flag for real
			autoloadProject: true,
			agentEnvContent: "OPENAI_API_KEY=\n", // empty placeholder -> would defer to ambient
			ambient: {},
			projectEnvContent: "OPENAI_API_KEY=from-project\n",
			keys: ["OPENAI_API_KEY"],
		});
		// The autoloaded project value is stripped before agentEnv applies, so the
		// empty placeholder finds no ambient fallback -> no cwd credential inject.
		expect(out.OPENAI_API_KEY).toBeUndefined();
	});

	// Reviewer collision (env.ts): the launcher set OMP_DOTENV_OVERRIDE=1 AND the
	// autoloaded project `.env` carries the same line. Indistinguishable from the
	// forged case above, so it is refused too — a silent guess here either leaked
	// project creds (old strip deleted the launcher flag -> default-mode gap-fill)
	// or silently flipped a raw-bun user into managed mode. The error is loud and
	// actionable: no creds are ever resolved from the ambiguous state.
	it("REFUSES a launcher+project same-line flag collision (no creds resolved)", async () => {
		const out = await resolveEnvInChild({
			managed: true, // launcher set the flag for real...
			autoloadProject: true, // ...and the project `.env` also carries the line (collision)
			agentEnvContent: "OPENAI_API_KEY=\n",
			ambient: {},
			projectEnvContent: "OMP_DOTENV_OVERRIDE=1\nOPENAI_API_KEY=from-project\n",
			keys: ["OPENAI_API_KEY"],
			expectThrow: true,
		});
		expect(out.__stderr).toContain("OMP_DOTENV_OVERRIDE=1 is set in both");
	});

	// The flag is launcher-only: no dotenv file layer may introduce it into the
	// resolved env (else a child spawn would inherit it as ambient and flip into
	// managed mode one hop removed). Autoload OFF (the shipped shape): a project
	// `.env` declaring the flag must neither activate managed mode nor export it.
	it("a project .env flag (autoload off) neither activates managed mode nor exports the flag", async () => {
		const out = await resolveEnvInChild({
			managed: false,
			agentEnvContent: "ANTHROPIC_AWS_WORKSPACE_ID=ws-agent\n",
			ambient: {},
			projectEnvContent: "OMP_DOTENV_OVERRIDE=1\nOPENAI_API_KEY=from-project\n",
			keys: ["OPENAI_API_KEY", "ANTHROPIC_AWS_WORKSPACE_ID", "OMP_DOTENV_OVERRIDE"],
		});
		// Default mode ran (project .env still a normal gap-fill layer)...
		expect(out.OPENAI_API_KEY).toBe("from-project");
		expect(out.ANTHROPIC_AWS_WORKSPACE_ID).toBe("ws-agent");
		// ...but the launcher flag itself is never sourced from a file layer.
		expect(out.OMP_DOTENV_OVERRIDE).toBeUndefined();
	});
});

describe("default dotenv precedence (flag unset) is unchanged", () => {
	it("ambient WINS over the profile .env", async () => {
		const out = await resolveEnvInChild({
			agentEnvContent: "OPENAI_API_KEY=from-dotenv\n",
			ambient: { OPENAI_API_KEY: "from-shell" },
			keys: ["OPENAI_API_KEY"],
			managed: false,
		});
		expect(out.OPENAI_API_KEY).toBe("from-shell");
	});

	it("profile .env fills a gap, and the project .env is still consulted", async () => {
		const out = await resolveEnvInChild({
			agentEnvContent: "ANTHROPIC_AWS_WORKSPACE_ID=ws-dotenv\n",
			ambient: {},
			projectEnvContent: "OPENAI_API_KEY=from-project-dir\n",
			keys: ["OPENAI_API_KEY", "ANTHROPIC_AWS_WORKSPACE_ID"],
			managed: false,
		});
		expect(out.ANTHROPIC_AWS_WORKSPACE_ID).toBe("ws-dotenv");
		expect(out.OPENAI_API_KEY).toBe("from-project-dir");
	});
});

describe("child process dotenv boundary", () => {
	it("prevents a Bun child from reloading filtered cwd dotenv values", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-child-env-"));
		try {
			await fs.writeFile(path.join(root, ".env"), "PROJECT_ONLY_SECRET=from-project-dotenv\n");
			// env.ts mutates Bun.env eagerly; load it here to keep the parent clean
			// while this case exercises a fresh child-process boundary.
			const { filterChildShellEnv } = await import(envUrl);
			const childEnv = filterChildShellEnv({ ...Bun.env, BUN_OPTIONS: undefined }, root);
			const proc = Bun.spawn(
				[process.execPath, "-e", 'process.stdout.write(process.env.PROJECT_ONLY_SECRET ?? "")'],
				{
					cwd: root,
					env: childEnv,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toBe("");
			expect(childEnv.BUN_OPTIONS).toBe("--no-env-file");
			expect(filterChildShellEnv({ ...Bun.env, BUN_OPTIONS: "--smol" }, root).BUN_OPTIONS).toBe(
				"--smol --no-env-file",
			);
			expect(
				filterChildShellEnv({ ...Bun.env, BUN_OPTIONS: "--smol" }, root, {
					BUN_OPTIONS: "",
					OMP_NO_ENV_FILE: "0",
				}),
			).toEqual(expect.objectContaining({ BUN_OPTIONS: "--no-env-file", OMP_NO_ENV_FILE: "1" }));
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("prevents a filtered Bun child from reloading the managed profile", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-child-profile-"));
		try {
			const agentDir = path.join(root, "agent");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.writeFile(path.join(agentDir, ".env"), "MANAGED_PROFILE_SECRET=from-managed-profile\n");
			const probePath = path.join(root, "profile-probe.ts");
			await Bun.write(
				probePath,
				`import ${JSON.stringify(envUrl)};\nprocess.stdout.write(process.env.MANAGED_PROFILE_SECRET ?? "");`,
			);
			const { filterChildShellEnv } = await import(envUrl);
			const childEnv = filterChildShellEnv(
				{
					PATH: Bun.env.PATH,
					HOME: Bun.env.HOME,
					OMP_DOTENV_OVERRIDE: "1",
					PI_CODING_AGENT_DIR: agentDir,
					BUN_OPTIONS: undefined,
				},
				root,
			);
			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: root,
				env: childEnv,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStream(proc.stdout as ReadableStream<Uint8Array>),
				readStream(proc.stderr as ReadableStream<Uint8Array>),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(stdout).toBe("");
			expect(childEnv.OMP_NO_ENV_FILE).toBe("1");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("does not restore managed profile values through a child overlay", async () => {
		const out = await resolveEnvInChild({
			agentEnvContent: "OPENAI_API_KEY=managed-secret\n",
			ambient: {},
			keys: ["OPENAI_API_KEY"],
			childKeys: ["OPENAI_API_KEY", "MCP_ONLY"],
			childOverlay: {
				OPENAI_API_KEY: "managed-secret",
				MCP_ONLY: "explicit-value",
			},
			managed: true,
		});
		expect(out.OPENAI_API_KEY).toBe("managed-secret");
		expect(out["child:OPENAI_API_KEY"]).toBeUndefined();
		expect(out["child:MCP_ONLY"]).toBe("explicit-value");
	});

	it("does not honor the child sentinel without Bun's launch-time option", async () => {
		const out = await resolveEnvInChild({
			agentEnvContent: "MANAGED_PROFILE_SECRET=from-managed-profile\n",
			ambient: { OMP_NO_ENV_FILE: "1" },
			keys: ["MANAGED_PROFILE_SECRET"],
			managed: true,
		});
		expect(out.MANAGED_PROFILE_SECRET).toBe("from-managed-profile");
	});

	it.skipIf(process.platform !== "win32")("removes managed profile keys regardless of Windows casing", async () => {
		const out = await resolveEnvInChild({
			agentEnvContent: "OpenAi_Api_Key=from-managed-profile\n",
			ambient: { OPENAI_API_KEY: "from-ambient-shell" },
			keys: ["OPENAI_API_KEY"],
			childKeys: ["OPENAI_API_KEY", "openai_api_key"],
			childOverlay: { openai_api_key: "from-managed-profile" },
			managed: true,
		});
		expect(out.OPENAI_API_KEY).toBe("from-managed-profile");
		expect(out["child:OPENAI_API_KEY"]).toBeUndefined();
		expect(out["child:openai_api_key"]).toBeUndefined();
	});

	it("strips operational credentials and renamed protected values from repository children", async () => {
		// Dynamic import preserves env.ts's controlled one-time initialization for this suite.
		const { filterChildShellEnv, filterTrustedChildShellEnv, filterUserMcpChildEnv, registerChildEnvRedactions } =
			await import(envUrl);
		const managedName = `OMP_MANAGED_SECRET_${crypto.randomUUID().replaceAll("-", "")}`;
		const managedSecret = `managed-${crypto.randomUUID()}`;
		const awsSecret = `aws-${crypto.randomUUID()}`;
		registerChildEnvRedactions([managedName], [managedSecret]);
		const parent = {
			PATH: Bun.env.PATH,
			HOME: Bun.env.HOME,
			AWS_PROFILE: "employee-ops",
			AWS_REGION: "us-west-2",
			AWS_ACCESS_KEY_ID: "AKIATEST",
			AWS_SECRET_ACCESS_KEY: awsSecret,
			AWS_SESSION_TOKEN: "session-secret",
			GH_TOKEN: "github-secret",
			OPENAI_API_KEY: "openai-parent-secret",
			ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer anthropic-secret",
			CLAUDE_CODE_CLIENT_KEY: "-----BEGIN PRIVATE KEY-----client-secret",
			PERPLEXITY_COOKIES: "session=perplexity-secret",
			[managedName]: managedSecret,
		};
		const overlay = {
			AWS_PROFILE: "overlay-profile",
			GH_TOKEN: "github-secret",
			RENAMED_MANAGED_SECRET: managedSecret,
			RENAMED_AWS_SECRET: awsSecret,
		};

		const child = filterChildShellEnv(parent, process.cwd(), overlay);
		expect(child.AWS_PROFILE).toBeUndefined();
		expect(child.AWS_REGION).toBeUndefined();
		expect(child.AWS_ACCESS_KEY_ID).toBeUndefined();
		expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(child.AWS_SESSION_TOKEN).toBeUndefined();
		expect(child.GH_TOKEN).toBeUndefined();
		expect(child.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
		expect(child.CLAUDE_CODE_CLIENT_KEY).toBeUndefined();
		expect(child.PERPLEXITY_COOKIES).toBeUndefined();
		expect(child[managedName]).toBeUndefined();
		expect(child.RENAMED_MANAGED_SECRET).toBeUndefined();
		expect(child.RENAMED_AWS_SECRET).toBeUndefined();
		expect(child.AWS_CONFIG_FILE).toBe(os.devNull);
		expect(child.AWS_SHARED_CREDENTIALS_FILE).toBe(os.devNull);
		expect(child.AWS_EC2_METADATA_DISABLED).toBe("true");

		const trusted = filterTrustedChildShellEnv(parent, process.cwd(), overlay);
		expect(trusted.AWS_PROFILE).toBe("overlay-profile");
		expect(trusted.AWS_REGION).toBe("us-west-2");
		expect(trusted.GH_TOKEN).toBeUndefined();
		expect(trusted.OPENAI_API_KEY).toBeUndefined();
		expect(trusted[managedName]).toBeUndefined();
		expect(trusted.RENAMED_MANAGED_SECRET).toBeUndefined();
		expect(trusted.RENAMED_AWS_SECRET).toBeUndefined();
		expect(trusted.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
		expect(trusted.CLAUDE_CODE_CLIENT_KEY).toBeUndefined();
		expect(trusted.PERPLEXITY_COOKIES).toBeUndefined();

		const userMcp = filterUserMcpChildEnv(parent, process.cwd(), overlay);
		expect(userMcp.AWS_PROFILE).toBe("overlay-profile");
		expect(userMcp.AWS_REGION).toBeUndefined();
		expect(userMcp.AWS_ACCESS_KEY_ID).toBeUndefined();
		expect(userMcp.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(userMcp.AWS_SESSION_TOKEN).toBeUndefined();
		expect(userMcp.GH_TOKEN).toBe("github-secret");
		expect(userMcp.OPENAI_API_KEY).toBeUndefined();
		expect(userMcp[managedName]).toBeUndefined();
		expect(userMcp.RENAMED_MANAGED_SECRET).toBeUndefined();
		expect(userMcp.RENAMED_AWS_SECRET).toBe(awsSecret);
		expect(userMcp.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
		expect(userMcp.CLAUDE_CODE_CLIENT_KEY).toBeUndefined();
		expect(userMcp.PERPLEXITY_COOKIES).toBeUndefined();
	});

	it("preserves only launcher-proven AWS values across self-referential project dotenv entries", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-operational-aws-"));
		try {
			const operational = {
				AWS_PROFILE: "employee-operations",
				AWS_REGION: "us-west-2",
				AWS_ACCESS_KEY_ID: "AKIA-LAUNCHER",
				AWS_SECRET_ACCESS_KEY: `secret-${crypto.randomUUID()}`,
				AWS_SESSION_TOKEN: `session-${crypto.randomUUID()}`,
				AWS_CONFIG_FILE: path.join(root, "aws-config"),
				AWS_WEB_IDENTITY_TOKEN_FILE: path.join(root, "web-identity"),
				AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:9911/credentials",
				AWS_CONTAINER_AUTHORIZATION_TOKEN: `container-${crypto.randomUUID()}`,
			};
			await fs.writeFile(
				path.join(root, ".env"),
				`${Object.keys(operational)
					.map(key => `${key}=$${key}`)
					.join("\n")}\nAWS_DEFAULT_PROFILE=$AWS_DEFAULT_PROFILE\n`,
			);
			const {
				filterChildShellEnv,
				filterTrustedChildShellEnv,
				filterUserMcpChildEnv,
				registerOperationalAwsEnvProvenance,
			} = await import(envUrl);
			registerOperationalAwsEnvProvenance([
				...Object.entries(operational),
				["AWS_DEFAULT_PROFILE", "launcher-default"],
			]);
			const parent = { ...operational, AWS_DEFAULT_PROFILE: "repo-controlled" };

			const trusted = filterTrustedChildShellEnv(parent, root);
			for (const [key, value] of Object.entries(operational)) expect(trusted[key]).toBe(value);
			expect(trusted.AWS_DEFAULT_PROFILE).toBeUndefined();

			const userMcp = filterUserMcpChildEnv(parent, root);
			for (const key of Object.keys(operational)) {
				if (key === "AWS_CONFIG_FILE") expect(userMcp[key]).toBe(os.devNull);
				else expect(userMcp[key]).toBeUndefined();
			}
			expect(userMcp.AWS_DEFAULT_PROFILE).toBeUndefined();

			const child = filterChildShellEnv(parent, root);
			for (const key of Object.keys(operational)) {
				if (key === "AWS_CONFIG_FILE") expect(child[key]).toBe(os.devNull);
				else expect(child[key]).toBeUndefined();
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
