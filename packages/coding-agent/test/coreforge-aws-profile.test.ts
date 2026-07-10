import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CoreforgeAwsSsoConstants,
	resolveOrSeedCoreforgeAwsProfile,
} from "@oh-my-pi/pi-coding-agent/identity/aws-profile";

// Adopt-or-seed contract for the managed IAM Identity Center profile:
// adoption is CONTENT-keyed (account id + start URL, any profile name), a
// name collision with foreign content is never overwritten, and seeding
// appends the modern sso-session shape without touching existing text.

const CONSTANTS: CoreforgeAwsSsoConstants = {
	profile: "somacommercial",
	region: "us-east-1",
	ssoStartUrl: "https://d-9067c31b82.awsapps.com/start",
	ssoRegion: "us-east-1",
	ssoAccountId: "891455110252",
	ssoRoleName: "CoreforgeModelAccess",
};

let dir: string;
let configPath: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-aws-profile-"));
	configPath = path.join(dir, "config");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveOrSeedCoreforgeAwsProfile", () => {
	it("seeds the managed profile into a missing config file", () => {
		const resolved = resolveOrSeedCoreforgeAwsProfile(CONSTANTS, configPath);
		expect(resolved).toEqual({ profile: "somacommercial", source: "seeded" });
		const text = fs.readFileSync(configPath, "utf8");
		expect(text).toContain("[sso-session coreforge-somacommercial]");
		expect(text).toContain("sso_start_url = https://d-9067c31b82.awsapps.com/start");
		expect(text).toContain("[profile somacommercial]");
		expect(text).toContain("sso_account_id = 891455110252");
		expect(text).toContain("sso_role_name = CoreforgeModelAccess");
		// Idempotent: a second resolution adopts what it just seeded.
		expect(resolveOrSeedCoreforgeAwsProfile(CONSTANTS, configPath)).toEqual({
			profile: "somacommercial",
			source: "existing-managed",
		});
	});

	it("adopts an existing matching profile under any name (legacy sso_start_url shape)", () => {
		fs.writeFileSync(
			configPath,
			[
				"[profile my-own-name]",
				// Fragment/trailing decorations from a console copy still match.
				"sso_start_url = https://d-9067c31b82.awsapps.com/start/#/?tab=accounts",
				"sso_region = us-east-1",
				"sso_account_id = 891455110252",
				"sso_role_name = CoreforgeModelAccess",
				"region = us-east-1",
				"",
			].join("\n"),
		);
		const before = fs.readFileSync(configPath, "utf8");
		expect(resolveOrSeedCoreforgeAwsProfile(CONSTANTS, configPath)).toEqual({
			profile: "my-own-name",
			source: "adopted",
		});
		// Adoption never rewrites the user's file.
		expect(fs.readFileSync(configPath, "utf8")).toBe(before);
	});

	it("adopts a matching sso-session shaped profile", () => {
		fs.writeFileSync(
			configPath,
			[
				"[sso-session corp]",
				"sso_start_url = https://d-9067c31b82.awsapps.com/start",
				"sso_region = us-east-1",
				"[profile work]",
				"sso_session = corp",
				"sso_account_id = 891455110252",
				"sso_role_name = CoreforgeModelAccess",
				"",
			].join("\n"),
		);
		expect(resolveOrSeedCoreforgeAwsProfile(CONSTANTS, configPath).profile).toBe("work");
	});

	it("seeds a fresh sso-session when the managed-name block carries a rotated portal URL", () => {
		fs.writeFileSync(
			configPath,
			[
				"[sso-session coreforge-somacommercial]",
				"sso_start_url = https://d-oldportal.awsapps.com/start",
				"sso_region = us-east-1",
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		const resolved = resolveOrSeedCoreforgeAwsProfile(CONSTANTS, configPath);
		expect(resolved).toEqual({ profile: "somacommercial", source: "seeded" });
		const text = fs.readFileSync(configPath, "utf8");
		// Stale block untouched; profile references a new session with the
		// current portal URL.
		expect(text).toContain("sso_start_url = https://d-oldportal.awsapps.com/start");
		expect(text).toContain("[sso-session coreforge-somacommercial-2]");
		expect(text).toContain("sso_session = coreforge-somacommercial-2");
		expect(text).toContain("sso_start_url = https://d-9067c31b82.awsapps.com/start");
	});

	it("never adopts a profile for a different account or portal", () => {
		fs.writeFileSync(
			configPath,
			[
				"[profile other-account]",
				"sso_start_url = https://d-9067c31b82.awsapps.com/start",
				"sso_region = us-east-1",
				"sso_account_id = 111111111111",
				"sso_role_name = AdministratorAccess",
				"[profile other-portal]",
				"sso_start_url = https://start.us-gov-home.awsapps.com/directory/other",
				"sso_region = us-gov-west-1",
				"sso_account_id = 891455110252",
				"sso_role_name = AdministratorAccess",
				"",
			].join("\n"),
		);
		const resolved = resolveOrSeedCoreforgeAwsProfile(CONSTANTS, configPath);
		expect(resolved.source).toBe("seeded");
		expect(resolved.profile).toBe("somacommercial");
	});

	it("does not adopt the right account and portal under a different role", () => {
		fs.writeFileSync(
			configPath,
			[
				"[profile admin]",
				"sso_start_url = https://d-9067c31b82.awsapps.com/start",
				"sso_region = us-east-1",
				"sso_account_id = 891455110252",
				"sso_role_name = AdministratorAccess",
				"",
			].join("\n"),
		);
		const resolved = resolveOrSeedCoreforgeAwsProfile(CONSTANTS, configPath);
		expect(resolved).toEqual({ profile: "somacommercial", source: "seeded" });
		expect(fs.readFileSync(configPath, "utf8")).toContain("sso_role_name = CoreforgeModelAccess");
	});

	it("seeds under a coreforge- fallback name when the managed name is taken by foreign content", () => {
		fs.writeFileSync(
			configPath,
			[
				"[profile somacommercial]",
				"sso_start_url = https://elsewhere.awsapps.com/start",
				"sso_region = eu-west-1",
				"sso_account_id = 222222222222",
				"sso_role_name = Whatever",
				"",
			].join("\n"),
		);
		const resolved = resolveOrSeedCoreforgeAwsProfile(CONSTANTS, configPath);
		expect(resolved).toEqual({ profile: "coreforge-somacommercial", source: "seeded" });
		const text = fs.readFileSync(configPath, "utf8");
		// The user's colliding profile is untouched.
		expect(text).toContain("sso_account_id = 222222222222");
		expect(text).toContain("[profile coreforge-somacommercial]");
	});

	it("hard-errors when both the managed and fallback names are taken by foreign content", () => {
		fs.writeFileSync(
			configPath,
			[
				"[profile somacommercial]",
				"sso_account_id = 222222222222",
				"[profile coreforge-somacommercial]",
				"sso_account_id = 333333333333",
				"",
			].join("\n"),
		);
		expect(() => resolveOrSeedCoreforgeAwsProfile(CONSTANTS, configPath)).toThrow(/neither matches the managed/);
	});

	it("rejects malformed managed constants before writing AWS config", () => {
		expect(() => resolveOrSeedCoreforgeAwsProfile({ ...CONSTANTS, profile: "bad name!" }, configPath)).toThrow(
			/Invalid managed AWS profile name/,
		);
		expect(() => resolveOrSeedCoreforgeAwsProfile({ ...CONSTANTS, ssoAccountId: "12345" }, configPath)).toThrow(
			/Invalid managed AWS account id/,
		);
		expect(() =>
			resolveOrSeedCoreforgeAwsProfile({ ...CONSTANTS, region: "us-east-1\n[profile foreign]" }, configPath),
		).toThrow(/Invalid managed AWS region/);
		expect(() =>
			resolveOrSeedCoreforgeAwsProfile({ ...CONSTANTS, ssoRegion: "us-east-1\n[profile foreign]" }, configPath),
		).toThrow(/Invalid managed AWS SSO region/);
		expect(() =>
			resolveOrSeedCoreforgeAwsProfile(
				{ ...CONSTANTS, ssoRoleName: "CoreforgeModelAccess\n[profile foreign]" },
				configPath,
			),
		).toThrow(/Invalid managed AWS SSO role name/);
		expect(() =>
			resolveOrSeedCoreforgeAwsProfile(
				{ ...CONSTANTS, ssoStartUrl: "https://d-example.awsapps.com/start\n[profile foreign]" },
				configPath,
			),
		).toThrow(/control characters/);
		expect(() =>
			resolveOrSeedCoreforgeAwsProfile(
				{ ...CONSTANTS, ssoStartUrl: "http://d-example.awsapps.com/start" },
				configPath,
			),
		).toThrow(/Invalid managed AWS SSO start URL/);
		expect(fs.existsSync(configPath)).toBe(false);
	});
});
