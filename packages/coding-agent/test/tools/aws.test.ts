import { describe, expect, it } from "bun:test";
import {
	AwsSessionAuthGroups,
	catalogAwsProfiles,
	buildAwsParameterArgv,
	parseAwsIni,
	partitionForAwsRegion,
	redactAwsOutput,
	resolveAwsSsoAuthGroup,
} from "@oh-my-pi/pi-coding-agent/tools/aws";

describe("native AWS profile catalog", () => {
	it("retains legacy, expired, recursive-role, and credentials-only profiles while excluding Coreforge", () => {
		const config = parseAwsIni(`
[profile legacy]
sso_start_url = https://example.awsapps.com/start
sso_region = us-west-2
sso_account_id = 123456789012
sso_role_name = ReadOnly

[profile expired]
sso_session = shared
sso_account_id = 123456789012
sso_role_name = ReadOnly

[sso-session shared]
sso_start_url = https://example.awsapps.com/start/
sso_region = us-west-2

[profile role]
role_arn = arn:aws:iam::123456789012:role/ReadOnly
source_profile = legacy

[profile coreforge]
region = us-east-1

[profile coreforge-admin]
region = us-east-1
`);
		const credentials = parseAwsIni(
			`
[credentials-only]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = secret
`,
			"credentials",
		);

		const profiles = catalogAwsProfiles(config, credentials);
		expect(profiles.map(profile => profile.name)).toEqual([
			"coreforge-admin",
			"credentials-only",
			"expired",
			"legacy",
			"role",
		]);
		expect(profiles.find(profile => profile.name === "expired")?.ssoGroup).not.toBe(
			profiles.find(profile => profile.name === "legacy")?.ssoGroup,
		);
		expect(profiles.find(profile => profile.name === "credentials-only")?.configuredRegion).toBeUndefined();

		expect(resolveAwsSsoAuthGroup("role", config, credentials)).toBe(
			resolveAwsSsoAuthGroup("legacy", config, credentials),
		);
	});
	it("keeps nested configuration and distinguishes profile names from SSO and service sections", () => {
		const config = parseAwsIni(`
[profile normal]
region = us-east-1
s3 =
    addressing_style = path
[profile sso-session:team]
region = us-west-2
[sso-session team]
sso_region = us-east-1
sso_start_url = https://example.awsapps.com/start
[services local]
s3 =
    endpoint_url = https://example.invalid
`);
		expect(catalogAwsProfiles(config, {}).map(profile => profile.name)).toEqual(["normal", "sso-session:team"]);
		expect(config.normal.s3).toContain("addressing_style = path");
		expect(config.normal.region).toBe("us-east-1");
	});
});

describe("native AWS argument boundary", () => {
	it("rejects global-option and file indirection attempts before a child process starts", () => {
		expect(() => buildAwsParameterArgv({ endpointUrl: "https://attacker.invalid" })).toThrow("INVALID_OPERATION");
		expect(() => buildAwsParameterArgv({ PolicyDocument: "file:///tmp/policy.json" })).toThrow("INVALID_OPERATION");
		expect(() => buildAwsParameterArgv({ Payload: "fileb:///tmp/payload.bin" })).toThrow("INVALID_OPERATION");
		expect(() => buildAwsParameterArgv({ verifySsl: false })).toThrow("INVALID_OPERATION");
		expect(() => buildAwsParameterArgv({ signRequest: false })).toThrow("INVALID_OPERATION");
		expect(() => buildAwsParameterArgv({ verify: false })).toThrow("INVALID_OPERATION");
	});

	it("encodes AWS CLI booleans as switches", () => {
		expect(buildAwsParameterArgv({ DryRun: true, Force: false })).toEqual(["--dry-run", "--no-force"]);
	});

	it("does not infer commercial partition for unknown regions", () => {
		expect(partitionForAwsRegion("us-gov-west-1")).toBe("aws-us-gov");
		expect(partitionForAwsRegion("cn-north-1")).toBe("aws-cn");
		expect(partitionForAwsRegion("zz-private-1")).toBeUndefined();
	});
});

describe("native AWS output redaction", () => {
	it("removes credential sentinels from JSON stdout and textual stderr before artifact output", () => {
		const stdout = redactAwsOutput(
			'{"SecretAccessKey":"stdout-secret","SessionToken":"stdout-token","RoleId":"AROAEXAMPLE"}',
		);
		const stderr = redactAwsOutput("SecretAccessKey: stderr-secret SessionToken=stderr-token");
		expect(stdout).not.toContain("stdout-secret");
		expect(stdout).not.toContain("stdout-token");
		expect(stderr).not.toContain("stderr-secret");
		expect(stderr).not.toContain("stderr-token");
		expect(stdout).toContain("AROAEXAMPLE");
	});

	it("redacts a quoted credential cut off by the output cap", () => {
		const truncated = '{"PrivateKey":"secret material with \\"quoted\\" bytes\\';
		expect(redactAwsOutput(truncated)).not.toContain("secret material");
		expect(redactAwsOutput(truncated)).not.toContain("quoted");
	});
});

describe("native AWS SSO approvals", () => {
	it("deduplicates concurrent approved logins and retains a decline for the session", async () => {
		const groups = new AwsSessionAuthGroups();
		groups.markApproved("https://example.awsapps.com/start|us-west-2");
		let logins = 0;
		const login = async () => {
			logins++;
			return true;
		};
		const [first, second] = await Promise.all([
			groups.runApprovedLogin("https://example.awsapps.com/start|us-west-2", login),
			groups.runApprovedLogin("https://example.awsapps.com/start|us-west-2", login),
		]);
		expect(first.authenticated).toBe(true);
		expect(second.authenticated).toBe(true);
		expect(logins).toBe(1);
		groups.markDeclined("https://example.awsapps.com/declined|us-west-2");
		expect(await groups.runApprovedLogin("https://example.awsapps.com/declined|us-west-2", login)).toEqual({
			authenticated: false,
			declined: true,
		});
		expect(logins).toBe(1);
	});
});
