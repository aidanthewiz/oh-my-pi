import { describe, expect, it } from "bun:test";
import {
	AwsSessionAuthGroups,
	type AwsLoginReservation,
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
	it("deduplicates an owned approved login and requires explicit approval after an owner decline", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "shared";
		const reservation = groups.reserveLogin(group)!;
		groups.markApproved(reservation);
		let logins = 0;
		const login = async () => {
			logins++;
			return true;
		};
		const [first, second] = await Promise.all([
			groups.runApprovedLogin(reservation, login),
			groups.runApprovedLogin(reservation, login),
		]);
		expect(first.authenticated).toBe(true);
		expect(second.authenticated).toBe(true);
		expect(logins).toBe(1);
		const declined = groups.reserveLogin(group)!;
		groups.declineLogin(declined);
		expect(await groups.runApprovedLogin(declined, login)).toEqual({ authenticated: false, declined: true });
		let automaticAttempts = 0;
		expect(
			await groups.recoverOnce(group, async () => {
				automaticAttempts++;
				return true;
			}),
		).toBe(false);
		expect(automaticAttempts).toBe(0);
		const retry = groups.reserveLogin(group)!;
		expect(groups.reserveLogin(group)).toBeUndefined();
		groups.markApproved(retry);
		expect((await groups.runApprovedLogin(retry, login)).authenticated).toBe(true);
		expect(logins).toBe(2);
	});

	it("renews an authenticated group once for concurrent expired operations", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "shared";
		let logins = 0;
		const { promise: barrier, resolve: finishLogin } = Promise.withResolvers<void>();
		const recover = async (reserveLogin: () => AwsLoginReservation | undefined) => {
			const reservation = reserveLogin()!;
			groups.markApproved(reservation);
			return (
				await groups.runApprovedLogin(reservation, async () => {
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
		expect(groups.reserveLogin(group)).toBeUndefined();
		finishLogin();
		expect(await firstRenewal).toBe(true);
		expect(await concurrentRenewal).toBe(true);
		expect(logins).toBe(2);
	});

	it("suppresses automatic renewal after an owned failure until an explicit retry", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "failed";
		let attempts = 0;
		const failedRenewal = async (reserveLogin: () => AwsLoginReservation | undefined) => {
			attempts++;
			const reservation = reserveLogin()!;
			groups.markApproved(reservation);
			return (await groups.runApprovedLogin(reservation, async () => false)).authenticated;
		};
		expect(await groups.recoverOnce(group, failedRenewal)).toBe(false);
		expect(await groups.recoverOnce(group, failedRenewal)).toBe(false);
		expect(attempts).toBe(1);
		const retry = groups.reserveLogin(group)!;
		groups.markApproved(retry);
		expect((await groups.runApprovedLogin(retry, async () => true)).authenticated).toBe(true);
	});

	it("blocks an explicit reservation during renewal and permits retry after owned probe failure", async () => {
		const groups = new AwsSessionAuthGroups();
		const initial = groups.reserveLogin("shared")!;
		groups.markApproved(initial);
		await groups.runApprovedLogin(initial, async () => true);
		const probe = Promise.withResolvers<void>();
		const releaseProbe = Promise.withResolvers<void>();
		const recovery = groups.recoverOnce("shared", async () => {
			probe.resolve();
			await releaseProbe.promise;
			return false;
		});
		await probe.promise;
		expect(groups.reserveLogin("shared")).toBeUndefined();
		groups.recordAuthenticationFailure("shared", groups.generation("shared"));
		releaseProbe.resolve();
		expect(await recovery).toBe(false);
		let attempts = 0;
		expect(
			await groups.recoverOnce("shared", async () => {
				attempts++;
				return true;
			}),
		).toBe(false);
		expect(attempts).toBe(0);
		const retry = groups.reserveLogin("shared")!;
		groups.markApproved(retry);
		expect((await groups.runApprovedLogin(retry, async () => true)).authenticated).toBe(true);
	});

	it("allows explicit retry after interruption without running an unapproved handler", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "interrupted";
		const interrupted = groups.reserveLogin(group)!;
		groups.markApproved(interrupted);
		await expect(
			groups.runApprovedLogin(interrupted, async () => {
				throw new Error("interrupted");
			}),
		).rejects.toThrow("interrupted");
		let logins = 0;
		const login = async () => {
			logins++;
			return true;
		};
		expect(
			await groups.recoverOnce(
				group,
				async reserveLogin => (await groups.runApprovedLogin(reserveLogin()!, login)).authenticated,
			),
		).toBe(false);
		const retry = groups.reserveLogin(group)!;
		expect((await groups.runApprovedLogin(retry, login)).authenticated).toBe(false);
		expect(logins).toBe(0);
		groups.markApproved(retry);
		expect((await groups.runApprovedLogin(retry, login)).authenticated).toBe(true);
		expect(logins).toBe(1);
	});

	it("does not restore authentication when the login owner cancels a running attempt", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "cancelled";
		const reservation = groups.reserveLogin(group)!;
		groups.markApproved(reservation);
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const login = groups.runApprovedLogin(reservation, async () => {
			started.resolve();
			await finish.promise;
			return true;
		});
		await started.promise;
		groups.declineLogin(reservation);
		finish.resolve();
		expect((await login).authenticated).toBe(false);
		let automaticAttempts = 0;
		expect(
			await groups.recoverOnce(group, async () => {
				automaticAttempts++;
				return true;
			}),
		).toBe(false);
		expect(automaticAttempts).toBe(0);
	});

	for (const approved of [false, true]) {
		it(`preserves ${approved ? "approved" : "offered"} login authority against same-generation request failures`, async () => {
			const groups = new AwsSessionAuthGroups();
			const group = "pending";
			const reservation = groups.reserveLogin(group)!;
			if (approved) groups.markApproved(reservation);
			const observedGeneration = groups.generation(group);
			let recoveries = 0;
			expect(
				await groups.recoverOnce(group, async () => {
					recoveries++;
					return false;
				}),
			).toBe(false);
			groups.recordAuthenticationFailure(group, observedGeneration);
			groups.declineLogin({ group });
			groups.markApproved(reservation);
			let logins = 0;
			const login = async () => {
				logins++;
				return true;
			};
			expect((await groups.runApprovedLogin(reservation, login)).authenticated).toBe(true);
			expect(logins).toBe(1);
			expect(recoveries).toBe(0);
			expect(
				await groups.recoverOnce(group, async reserveLogin => {
					const renewal = reserveLogin()!;
					groups.markApproved(renewal);
					return (await groups.runApprovedLogin(renewal, login)).authenticated;
				}),
			).toBe(true);
			expect(logins).toBe(2);
		});
	}

	it("ignores completed-generation failures and stale owners during a newer approved login", async () => {
		const groups = new AwsSessionAuthGroups();
		const group = "newer-login";
		const initial = groups.reserveLogin(group)!;
		groups.markApproved(initial);
		await groups.runApprovedLogin(initial, async () => true);
		const failedGeneration = groups.generation(group);
		const reservation = groups.reserveLogin(group)!;
		groups.markApproved(reservation);
		groups.recordAuthenticationFailure(group, failedGeneration);
		groups.declineLogin(initial);
		let logins = 0;
		const login = async () => {
			logins++;
			return true;
		};
		expect((await groups.runApprovedLogin(reservation, login)).authenticated).toBe(true);
		groups.recordAuthenticationFailure(group, failedGeneration);
		expect(
			await groups.recoverOnce(group, async reserveLogin => {
				const renewal = reserveLogin()!;
				groups.markApproved(renewal);
				return (await groups.runApprovedLogin(renewal, login)).authenticated;
			}),
		).toBe(true);
		expect(logins).toBe(2);
	});
});
