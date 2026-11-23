import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

test("native AWS enforces process, account approval, authentication, and output boundaries", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-aws-execution-"));
	try {
		const executable = path.join(root, process.platform === "win32" ? "aws.exe" : "aws");
		const sessionHelper = path.join(root, process.platform === "win32" ? "session-helper.exe" : "session-helper");
		for (const [fixtureName, target] of [
			["recording-aws.ts", executable],
			["session-manager-helper.ts", sessionHelper],
		] as const) {
			const fixture = path.resolve(import.meta.dir, "../fixtures", fixtureName);
			if (process.platform === "win32") {
				const build = Bun.spawn([process.execPath, "build", "--compile", fixture, "--outfile", target], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [buildError, buildExit] = await Promise.all([new Response(build.stderr).text(), build.exited]);
				expect(buildExit, buildError).toBe(0);
			} else {
				await fs.writeFile(target, `#!${process.execPath}\n${await fs.readFile(fixture, "utf8")}`, {
					mode: 0o755,
				});
			}
		}
		const config = path.join(root, "config");
		await fs.writeFile(
			config,
			`[profile commercial]\nregion = us-east-1\n[profile government]\nregion = us-gov-west-1\n[profile mismatched]\nregion = us-east-1\n[profile coreforge]\nregion = us-east-1\n[profile managed-alias]\nregion = us-east-1\nsource_profile = coreforge\nrole_arn = arn:aws:iam::123456789012:role/fixture\n[profile expired]\nregion = us-east-1\nsso_session = shared\n[profile expired-peer]\nregion = us-east-1\nsso_session = shared\n[sso-session shared]\nsso_start_url = https://fixture.invalid/start\nsso_region = us-east-1\n[profile declined]\nregion = us-east-1\nsso_session = independent\n[sso-session independent]\nsso_start_url = https://fixture.invalid/start\nsso_region = us-east-1\n`,
		);
		for (const [profile, group, region] of [
			["automatic", "automatic", "us-east-1"],
			["parallel", "parallel", "us-east-1"],
			["parallel-peer", "parallel", "us-east-1"],
			["failed-login", "failed-login", "us-east-1"],
			["still-expired", "still-expired", "us-east-1"],
			["firstuse-declined", "firstuse-declined", "us-east-1"],
			["resolution-declined", "resolution-declined", "us-east-1"],
			["government-expired", "government-expired", "us-gov-west-1"],
			["mutating-expired", "mutating-expired", "us-east-1"],
			["mutating-changed", "mutating-changed", "us-east-1"],
			["mutation-reexpires", "mutation-reexpires", "us-east-1"],
			["expired-session", "session", "us-east-1"],
			["expired-session-other", "session-other", "us-east-1"],
			["expired-session-login", "session-login", "us-east-1"],
			["expired-session-first", "session-first", "us-east-1"],
			["expired-managed-direct-preflight", "managed-direct-preflight", "us-east-1"],
			["expired-managed-cold-preflight", "managed-cold-preflight", "us-east-1"],
			["expired-managed-direct-reconnect", "managed-direct-reconnect", "us-east-1"],
			["expired-managed-cold-reconnect", "managed-cold-reconnect", "us-east-1"],
		]) {
			await fs.appendFile(
				config,
				`[profile ${profile}]\nregion = ${region}\nsso_session = ${group}\n[sso-session ${group}]\nsso_start_url = https://${group}.invalid/start\nsso_region = ${region}\n`,
			);
		}
		await fs.appendFile(
			config,
			"[profile adopted-model]\nregion = us-east-1\n[profile adopted-alias]\nregion = us-east-1\nsource_profile = adopted-model\nrole_arn = arn:aws:iam::123456789012:role/fixture\n[profile coreforge-admin]\nregion = us-east-1\n",
		);
		await fs.appendFile(
			config,
			"[profile partition-conflict]\nregion = us-east-1\nsso_start_url = https://fixture.invalid/start\nsso_region = us-gov-west-1\n[profile role-conflict]\nregion = us-east-1\nrole_arn = arn:aws-us-gov:iam::123456789012:role/fixture\nsource_profile = government\n",
		);
		for (const [profile, helper] of [
			[
				"repository-helper",
				path.join(root, "repository", process.platform === "win32" ? "native-helper.exe" : "native-helper"),
			],
			["script-helper", path.join(root, "external-helper")],
		]) {
			await fs.appendFile(
				config,
				`[profile ${profile}]\nregion = us-east-1\ncredential_process = ${JSON.stringify(helper)}\n`,
			);
		}
		await fs.writeFile(
			path.join(root, "credentials"),
			"[commercial]\naws_access_key_id = fixture-access\naws_secret_access_key = fixture-secret\n",
		);
		const policy = path.join(root, "dcg-policy");
		await fs.writeFile(policy, "fixture");
		const executableHash = createHash("sha256")
			.update(await fs.readFile(executable))
			.digest("hex");
		const policyHash = createHash("sha256").update("fixture").digest("hex");
		const env = {
			HOME: root,
			USERPROFILE: root,
			PATH: path.join(root, "repository"),
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			OMP_DOTENV_OVERRIDE: "1",
			OMP_CF_PRODUCT_VERSION: "fixture",
			OMP_OPERATIONAL_AWS_CONFIG_FILE: config,
			OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials"),
			OMP_OPERATIONAL_AWS_EXECUTABLE: executable,
			OMP_OPERATIONAL_AWS_SESSION_MANAGER_PLUGIN: sessionHelper,
			OMP_OPERATIONAL_AWS_PROFILE: "commercial",
			OMP_OPERATIONAL_AWS_REGION: "us-east-1",
			OMP_DCG_PATH: executable,
			OMP_DCG_VERSION: "fixture",
			OMP_DCG_BINARY_SHA256: executableHash,
			OMP_DCG_CONFIG: policy,
			OMP_DCG_CONFIG_SHA256: policyHash,
			AWS_ACCESS_KEY_ID: "managed-access",
			AWS_SECRET_ACCESS_KEY: "managed-secret",
			AWS_SESSION_TOKEN: "managed-token",
			AWS_PROFILE: "coreforge",
			OMP_MODEL_AWS_AUTH_MODE: "managed",
			OMP_MODEL_AWS_PROFILE: "coreforge",
			OMP_MODEL_AWS_REGION: "us-east-1",
			AWS_ENDPOINT_URL: "https://attacker.invalid",
			ANTHROPIC_API_KEY: "unrelated-anthropic",
			OPENAI_API_KEY: "unrelated-openai",
		};
		for (const scenario of ["normal", "missing-cli", "missing-plugin"]) {
			const probe = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					path.resolve(import.meta.dir, "../fixtures/native-aws-execution-probe.ts"),
				],
				{
					cwd: root,
					signal: AbortSignal.timeout(150_000),
					env:
						scenario === "missing-cli"
							? { ...env, OMP_OPERATIONAL_AWS_EXECUTABLE: undefined, NATIVE_AWS_EXPECT_NO_CLI: "1" }
							: scenario === "missing-plugin"
								? {
										...env,
										OMP_OPERATIONAL_AWS_SESSION_MANAGER_PLUGIN: undefined,
										NATIVE_AWS_EXPECT_NO_PLUGIN: "1",
									}
								: env,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(probe.stdout).text(),
				new Response(probe.stderr).text(),
				probe.exited,
			]);
			expect(exit, `${stdout}\n${stderr}`).toBe(0);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 180_000);
