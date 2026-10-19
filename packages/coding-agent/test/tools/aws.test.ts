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
		expect(() => buildAwsParameterArgv({ Filters: "Name=tag:Name,Values@=file:///tmp/sentinel" })).toThrow(
			"INVALID_OPERATION",
		);
		expect(() => buildAwsParameterArgv({ verifySsl: false })).toThrow("INVALID_OPERATION");
		expect(() => buildAwsParameterArgv({ signRequest: false })).toThrow("INVALID_OPERATION");
		expect(() => buildAwsParameterArgv({ verify: false })).toThrow("INVALID_OPERATION");
	});

	it("encodes AWS CLI booleans as switches", () => {
		expect(buildAwsParameterArgv({ DryRun: true, Force: false })).toEqual(["--dry-run", "--no-force"]);
	});

	it("preserves acronym word boundaries in AWS CLI parameter flags", () => {
		expect(
			buildAwsParameterArgv({ DBInstanceIdentifier: "db-example", VPCSecurityGroupIds: ["sg-example"] }),
		).toEqual(["--db-instance-identifier=db-example", '--vpc-security-group-ids=["sg-example"]']);
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
			'{"SecretAccessKey":"stdout-secret","SecretString":"customer-secret","SessionToken":"stdout-token","RoleId":"AROAEXAMPLE"}',
		);
		const stderr = redactAwsOutput("SecretAccessKey: stderr-secret SessionToken=stderr-token");
		expect(stdout).not.toContain("stdout-secret");
		expect(stdout).not.toContain("customer-secret");
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

	it("withholds malformed JSON with compound sensitive fields rather than applying text redaction", () => {
		for (const output of [
			'{"SecretString":"customer-secret","partial":',
			' \ufeff[{"SecretBinary":"customer-secret"},',
			'{"SecretString":"customer-secret"}'.repeat(100_000),
		]) {
			const redacted = redactAwsOutput(output);
			expect(redacted).not.toContain("customer-secret");
			expect(redacted).not.toContain("SecretString");
			expect(redacted).not.toContain("SecretBinary");
		}
	});

	it("preserves useful AWS error text while removing credentials", () => {
		const stderr = redactAwsOutput("An error occurred (AccessDeniedException): SecretAccessKey=customer-secret");
		expect(stderr).toContain("AccessDeniedException");
		expect(stderr).not.toContain("customer-secret");
	});
});

describe("native AWS SSO approvals", () => {
	it("deduplicates concurrent approved logins and requires explicit approval after a decline", async () => {
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
		groups.markDeclined("https://example.awsapps.com/declined|us-west-2", 0);
		expect(await groups.runApprovedLogin("https://example.awsapps.com/declined|us-west-2", login)).toEqual({
			authenticated: false,
			declined: true,
		});
		expect(logins).toBe(1);
		expect(groups.reserveLogin("https://example.awsapps.com/declined|us-west-2")).toBe(true);
		expect(groups.reserveLogin("https://example.awsapps.com/declined|us-west-2")).toBe(false);
		groups.markApproved("https://example.awsapps.com/declined|us-west-2");
		expect(
			(await groups.runApprovedLogin("https://example.awsapps.com/declined|us-west-2", login)).authenticated,
		).toBe(true);
		expect(logins).toBe(2);
	});

	it("renews an authenticated group once for concurrent expired operations", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "shared";
		let logins = 0;
		const { promise: barrier, resolve: finishLogin } = Promise.withResolvers<void>();
		const recover = async (reserveLogin: () => boolean) => {
			expect(reserveLogin()).toBe(true);
			groups.markApproved(group);
			return (
				await groups.runApprovedLogin(group, async () => {
					logins++;
					if (logins === 2) await barrier;
					return true;
				})
			).authenticated;
		};
		expect(await groups.recoverOnce(group, recover)).toBe(true);
		const firstRenewal = groups.recoverOnce(group, recover);
		const concurrentRenewal = groups.recoverOnce(group, recover);
		await Promise.resolve();
		expect(logins).toBe(2);
		expect(groups.reserveLogin(group)).toBe(false);
		finishLogin();
		expect(await firstRenewal).toBe(true);
		expect(await concurrentRenewal).toBe(true);
		expect(logins).toBe(2);
	});

	it("suppresses automatic renewal after failure until an explicit retry", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "failed";
		groups.markAuthenticated(group);
		let attempts = 0;
		const failedRenewal = async (reserveLogin: () => boolean) => {
			attempts++;
			expect(reserveLogin()).toBe(true);
			groups.markApproved(group);
			return (await groups.runApprovedLogin(group, async () => false)).authenticated;
		};
		expect(await groups.recoverOnce(group, failedRenewal)).toBe(false);
		expect(await groups.recoverOnce(group, failedRenewal)).toBe(false);
		expect(attempts).toBe(1);
		expect(groups.reserveLogin(group)).toBe(true);
		groups.markApproved(group);
		expect((await groups.runApprovedLogin(group, async () => true)).authenticated).toBe(true);
	});

	it("blocks an explicit reservation during renewal and allows an explicit retry after renewal failure", async () => {
		const groups = new AwsSessionAuthGroups();
		groups.markAuthenticated("shared");
		const probe = Promise.withResolvers<void>();
		const releaseProbe = Promise.withResolvers<void>();
		const recovery = groups.recoverOnce("shared", async reserveLogin => {
			probe.resolve();
			await releaseProbe.promise;
			expect(reserveLogin()).toBe(true);
			groups.markApproved("shared");
			return (await groups.runApprovedLogin("shared", async () => false)).authenticated;
		});
		await probe.promise;
		expect(groups.reserveLogin("shared")).toBe(false);
		releaseProbe.resolve();
		expect(await recovery).toBe(false);
		expect(groups.reserveLogin("shared")).toBe(true);
		groups.markApproved("shared");
		expect((await groups.runApprovedLogin("shared", async () => true)).authenticated).toBe(true);
	});

	it("allows explicit retry after an interrupted login without running unapproved handlers", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "interrupted";
		expect(groups.reserveLogin(group)).toBe(true);
		groups.markApproved(group);
		await expect(
			groups.runApprovedLogin(group, async () => {
				throw new Error("interrupted");
			}),
		).rejects.toThrow("interrupted");
		let logins = 0;
		const login = async () => {
			logins++;
			return true;
		};
		expect(
			await groups.recoverOnce(group, async () => (await groups.runApprovedLogin(group, login)).authenticated),
		).toBe(false);
		expect(logins).toBe(0);
		expect(groups.reserveLogin(group)).toBe(true);
		groups.markApproved(group);
		expect((await groups.runApprovedLogin(group, login)).authenticated).toBe(true);
		expect(logins).toBe(1);
	});

	it("keeps a newer approved sign-in available when an older operation fails", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "newer-login";
		groups.markAuthenticated(group);
		const failedGeneration = groups.generation(group);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delayedFailure = (async () => {
			started.resolve();
			await release.promise;
			groups.markDeclined(group, failedGeneration);
		})();
		await started.promise;
		expect(groups.reserveLogin(group)).toBe(true);
		groups.markApproved(group);
		release.resolve();
		await delayedFailure;
		let logins = 0;
		const login = async () => {
			logins++;
			return true;
		};
		expect((await groups.runApprovedLogin(group, login)).authenticated).toBe(true);
		expect(logins).toBe(1);
		expect(
			await groups.recoverOnce(group, async reserveLogin => {
				expect(reserveLogin()).toBe(true);
				groups.markApproved(group);
				return (await groups.runApprovedLogin(group, login)).authenticated;
			}),
		).toBe(true);
		expect(logins).toBe(2);
	});
});
