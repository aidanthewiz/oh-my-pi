import { describe, expect, it } from "bun:test";
import {
	assertAwsDbCapability,
	AWS_DB_CAPABILITY,
	AWS_DB_INPUT_SCHEMA,
	AwsDbFailure,
	awsDbRequestFingerprint,
	normalizeAwsDbRequest,
	type AwsDbFailureCode,
	type AwsDbInspectionRequest,
} from "@oh-my-pi/pi-coding-agent/tools/aws-db-contract";

function inspection(): AwsDbInspectionRequest {
	return {
		action: "inspect-automation-template",
		capability: AWS_DB_CAPABILITY.capability,
		profile: "fixture-reader",
		expected: {
			accountId: "123456789012",
			principalArn: "arn:aws:sts::123456789012:assumed-role/FixtureReader/fixture-session",
			partition: "aws",
			region: "us-east-1",
			tenantId: "fixture-tenant",
			clusterArn: "arn:aws:rds:us-east-1:123456789012:cluster:fixture-cluster",
			clusterResourceId: "cluster-FIXTURE123",
			instanceArn: "arn:aws:rds:us-east-1:123456789012:db:fixture-reader",
			instanceResourceId: "db-FIXTURE123",
			endpoint: "fixture-reader.example.invalid",
			port: 3306,
			database: "fixture_database",
			secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture-reader-AbCdEf",
			secretVersionId: "12345678-1234-1234-1234-123456789012",
		},
		agencyId: "17",
		automationId: "23",
		stepId: "31",
		limits: { maxRows: 1, maxBytes: 4096, timeoutMs: 1000 },
	};
}

function expectFailure(operation: () => unknown, code: AwsDbFailureCode): void {
	let failure: unknown;
	try {
		operation();
	} catch (error) {
		failure = error;
	}
	expect(failure instanceof AwsDbFailure).toBe(true);
	expect(failure instanceof AwsDbFailure && failure.code === code && failure.message === code).toBe(true);
	expect(failure instanceof Error && !Object.hasOwn(failure, "cause")).toBe(true);
}

function reverseKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reverseKeys);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.reverse()
				.map(([key, child]) => [key, reverseKeys(child)]),
		);
	}
	return value;
}

describe("aws_db closed request contract", () => {
	const unknownFields: Array<[string, () => unknown]> = [
		["capability request credentials", () => ({ action: "capabilities", profile: "fixture-reader" })],
		["capability request limits", () => ({ action: "capabilities", limits: { maxRows: 1 } })],
		["inspection SQL override", () => ({ ...inspection(), sql: "SELECT 1" })],
		["inspection provider override", () => ({ ...inspection(), endpointUrl: "https://fixture.invalid" })],
		["inspection approval assertion", () => ({ ...inspection(), approved: true })],
		[
			"expected credentials",
			() => {
				const request = inspection();
				return { ...request, expected: { ...request.expected, username: "fixture-reader" } };
			},
		],
		[
			"expected endpoint override",
			() => {
				const request = inspection();
				return { ...request, expected: { ...request.expected, host: "other.example.invalid" } };
			},
		],
		[
			"limit bypass",
			() => {
				const request = inspection();
				return { ...request, limits: { ...request.limits, unlimited: true } };
			},
		],
		["prototype-shaped JSON member", () => JSON.parse('{"action":"capabilities","__proto__":{"approved":true}}')],
	];
	for (const [name, input] of unknownFields) {
		it(`rejects unknown fields: ${name}`, () => {
			expectFailure(() => normalizeAwsDbRequest(input()), "INVALID_REQUEST");
		});
	}

	for (const field of ["request", "expected", "limits"] as const) {
		for (const extra of ["hidden", "symbol", "prototype"] as const) {
			it(`rejects ${extra} data outside the JSON contract in ${field}`, () => {
				const request = inspection();
				const branch = field === "request" ? request : request[field];
				if (extra === "hidden") Object.defineProperty(branch, "approved", { value: true });
				else if (extra === "symbol") Object.defineProperty(branch, Symbol("approved"), { value: true });
				else Object.setPrototypeOf(branch, { approved: true });
				expectFailure(() => normalizeAwsDbRequest(request), "INVALID_REQUEST");
			});
		}
	}

	it("rejects request property accessors before invoking caller-controlled code", () => {
		let reads = 0;
		const request = inspection();
		Object.defineProperty(request.expected, "secretVersionId", {
			enumerable: true,
			get() {
				reads++;
				return "12345678-1234-1234-1234-123456789012";
			},
		});
		expectFailure(() => normalizeAwsDbRequest(request), "INVALID_REQUEST");
		expect(reads === 0).toBe(true);
	});

	for (const [name, input] of [
		["missing action", () => ({})],
		["unknown action", () => ({ action: "query" })],
		["null request", () => null],
		["array request", () => []],
		[
			"missing expected identity",
			() => {
				const { expected: _, ...rest } = inspection();
				return rest;
			},
		],
		[
			"missing limits",
			() => {
				const { limits: _, ...rest } = inspection();
				return rest;
			},
		],
		["array expected identity", () => ({ ...inspection(), expected: [] })],
		["null limits", () => ({ ...inspection(), limits: null })],
	] as Array<[string, () => unknown]>) {
		it(`rejects malformed requests: ${name}`, () => {
			expectFailure(() => normalizeAwsDbRequest(input()), "INVALID_REQUEST");
		});
	}

	for (const [name, limits] of [
		["multiple rows", { maxRows: 2, maxBytes: 1, timeoutMs: 1 }],
		["zero rows", { maxRows: 0, maxBytes: 1, timeoutMs: 1 }],
		["zero bytes", { maxRows: 1, maxBytes: 0, timeoutMs: 1 }],
		["excess bytes", { maxRows: 1, maxBytes: 65_537, timeoutMs: 1 }],
		["fractional bytes", { maxRows: 1, maxBytes: 1.5, timeoutMs: 1 }],
		["unbounded bytes", { maxRows: 1, maxBytes: Number.POSITIVE_INFINITY, timeoutMs: 1 }],
		["zero timeout", { maxRows: 1, maxBytes: 1, timeoutMs: 0 }],
		["excess timeout", { maxRows: 1, maxBytes: 1, timeoutMs: 10_001 }],
		["fractional timeout", { maxRows: 1, maxBytes: 1, timeoutMs: 1.5 }],
		["text timeout", { maxRows: 1, maxBytes: 1, timeoutMs: "1" }],
	] as const) {
		it(`rejects unsafe read limits: ${name}`, () => {
			expectFailure(() => normalizeAwsDbRequest({ ...inspection(), limits }), "INVALID_REQUEST");
		});
	}

	it("accepts the smallest and largest bounded single-row reads", () => {
		for (const limits of [
			{ maxRows: 1 as const, maxBytes: 1, timeoutMs: 1 },
			{ maxRows: 1 as const, maxBytes: 65_536, timeoutMs: 10_000 },
		]) {
			const normalized = normalizeAwsDbRequest({ ...inspection(), limits });
			expect(
				normalized.action === "inspect-automation-template" && normalized.limits.maxBytes === limits.maxBytes,
			).toBe(true);
		}
	});

	for (const [name, capability] of [
		["short digest", `sha256:${"0".repeat(63)}`],
		["long digest", `sha256:${"0".repeat(65)}`],
		["uppercase digest", `sha256:${"A".repeat(64)}`],
		["other digest algorithm", `sha512:${"0".repeat(64)}`],
		["missing digest algorithm", "0".repeat(64)],
		["digest control character", `${AWS_DB_CAPABILITY.capability}\n`],
	] as const) {
		it(`rejects malformed capability digests: ${name}`, () => {
			expectFailure(() => normalizeAwsDbRequest({ ...inspection(), capability }), "INVALID_REQUEST");
		});
	}

	it("rejects a well-formed digest for a different capability", () => {
		const different = AWS_DB_CAPABILITY.capability.replace(
			/.$/u,
			AWS_DB_CAPABILITY.capability.endsWith("0") ? "1" : "0",
		);
		expectFailure(() => normalizeAwsDbRequest({ ...inspection(), capability: different }), "CAPABILITY_INCOMPATIBLE");
	});

	for (const [name, version] of [
		["empty version", ""],
		["short version", "a".repeat(31)],
		["long version", "a".repeat(65)],
		["version alias", "AWSCURRENT"],
		["version path", "a".repeat(31) + "/"],
		["version terminal newline", "a".repeat(32) + "\n"],
		["version terminal carriage return", "a".repeat(32) + "\r"],
		["numeric version", 1234567890123456],
	] as const) {
		it(`rejects malformed secret versions: ${name}`, () => {
			const request = inspection();
			expectFailure(
				() => normalizeAwsDbRequest({ ...request, expected: { ...request.expected, secretVersionId: version } }),
				"INVALID_REQUEST",
			);
		});
	}

	for (const field of ["agencyId", "automationId", "stepId"] as const) {
		it(`preserves the exact signed-64-bit ${field} boundary without numeric coercion`, () => {
			for (const id of ["1", "9223372036854775807"]) {
				const normalized = normalizeAwsDbRequest({ ...inspection(), [field]: id });
				expect(normalized.action === "inspect-automation-template" && normalized[field] === id).toBe(true);
			}
		});
		for (const [name, id] of [
			["zero", "0"],
			["negative", "-1"],
			["leading zero", "01"],
			["explicit plus", "+1"],
			["fraction", "1.0"],
			["exponent", "1e3"],
			["above signed range", "9223372036854775808"],
			["above decimal width", "10000000000000000000"],
			["numeric input", 1],
		] as const) {
			it(`rejects ${field} outside canonical signed-64-bit IDs: ${name}`, () => {
				expectFailure(() => normalizeAwsDbRequest({ ...inspection(), [field]: id }), "INVALID_REQUEST");
			});
		}
	}

	for (const [name, profile] of [
		["leading whitespace", " fixture"],
		["trailing whitespace", "fixture "],
		["tab", "fixture\tother"],
		["newline", "fixture\nother"],
		["carriage return", "fixture\rother"],
		["NUL", "fixture\0other"],
		["terminal escape", "fixture\u001bother"],
		["DEL", "fixture\u007fother"],
		["option prefix", "--profile"],
		["path", "../fixture"],
		["overlong profile", "a".repeat(129)],
	] as const) {
		it(`rejects unsafe profile controls: ${name}`, () => {
			expectFailure(() => normalizeAwsDbRequest({ ...inspection(), profile }), "INVALID_REQUEST");
		});
	}

	it("accepts explicit profile names without reinterpreting internal punctuation or spaces", () => {
		const profile = "fixture reader_+=,.@-01";
		const normalized = normalizeAwsDbRequest({ ...inspection(), profile });
		expect(normalized.action === "inspect-automation-template" && normalized.profile === profile).toBe(true);
	});
});

describe("aws_db explicit identity and resource binding", () => {
	for (const field of ["clusterArn", "instanceArn", "secretArn"] as const) {
		const mutations: Array<[string, (arn: string) => string]> = [
			["account", arn => arn.replace("123456789012", "210987654321")],
			["partition", arn => arn.replace("arn:aws:", "arn:aws-us-gov:")],
			["region", arn => arn.replace("us-east-1", "us-west-2")],
			["service", arn => arn.replace(field === "secretArn" ? ":secretsmanager:" : ":rds:", ":s3:")],
			[
				"resource kind",
				arn =>
					arn.replace(
						field === "clusterArn" ? ":cluster:" : field === "instanceArn" ? ":db:" : ":secret:",
						":snapshot:",
					),
			],
			["empty resource", arn => arn.slice(0, arn.lastIndexOf(":") + 1)],
		];
		for (const [name, mutate] of mutations) {
			it(`rejects ${field} with mismatched ${name}`, () => {
				const request = inspection();
				expectFailure(
					() =>
						normalizeAwsDbRequest({
							...request,
							expected: { ...request.expected, [field]: mutate(request.expected[field]) },
						}),
					"INVALID_REQUEST",
				);
			});
		}
	}

	for (const [name, principalArn] of [
		["account", "arn:aws:iam::210987654321:user/FixtureReader"],
		["partition", "arn:aws-us-gov:iam::123456789012:user/FixtureReader"],
		["service", "arn:aws:rds::123456789012:user/FixtureReader"],
		["missing assumed-role session", "arn:aws:sts::123456789012:assumed-role/FixtureReader"],
		["IAM assumed-role kind", "arn:aws:iam::123456789012:assumed-role/FixtureReader/fixture-session"],
		["IAM role instead of caller identity", "arn:aws:iam::123456789012:role/fixture/FixtureReader"],
		["STS role kind", "arn:aws:sts::123456789012:role/FixtureReader"],
		["STS user kind", "arn:aws:sts::123456789012:user/FixtureReader"],
	] as const) {
		it(`rejects a principal ARN with mismatched ${name}`, () => {
			const request = inspection();
			expectFailure(
				() => normalizeAwsDbRequest({ ...request, expected: { ...request.expected, principalArn } }),
				"INVALID_REQUEST",
			);
		});
	}

	for (const [partition, region] of [
		["aws", "us-east-1"],
		["aws-us-gov", "us-gov-west-1"],
		["aws-cn", "cn-north-1"],
	] as const) {
		it(`accepts only consistently bound resources in ${partition}`, () => {
			const request = inspection();
			request.expected.partition = partition;
			request.expected.region = region;
			for (const field of ["principalArn", "clusterArn", "instanceArn", "secretArn"] as const) {
				request.expected[field] = request.expected[field]
					.replace("arn:aws:", `arn:${partition}:`)
					.replace("us-east-1", region);
			}
			const normalized = normalizeAwsDbRequest(request);
			expect(
				normalized.action === "inspect-automation-template" && normalized.expected.partition === partition,
			).toBe(true);
			expectFailure(
				() =>
					normalizeAwsDbRequest({
						...request,
						expected: { ...request.expected, partition: partition === "aws" ? "aws-us-gov" : "aws" },
					}),
				"INVALID_REQUEST",
			);
		});
	}

	for (const region of ["ca-west-1", "il-central-1"] as const) {
		it(`accepts a completely bound inspection in qualified region ${region}`, () => {
			const request = inspection();
			request.expected.region = region;
			for (const field of ["clusterArn", "instanceArn", "secretArn"] as const) {
				request.expected[field] = request.expected[field].replace("us-east-1", region);
			}
			const normalized = normalizeAwsDbRequest(request);
			expect(normalized.action === "inspect-automation-template" && normalized.expected.region === region).toBe(
				true,
			);
		});
	}

	it("rejects a completely bound future region outside the qualified TLS trust coverage", () => {
		const request = inspection();
		request.expected.region = "us-west-3";
		for (const field of ["clusterArn", "instanceArn", "secretArn"] as const) {
			request.expected[field] = request.expected[field].replace("us-east-1", request.expected.region);
		}
		expectFailure(() => normalizeAwsDbRequest(request), "CAPABILITY_INCOMPATIBLE");
	});

	it("rejects mismatched resource bindings before classifying an uncovered TLS region", () => {
		const request = inspection();
		request.expected.region = "us-west-3";
		for (const field of ["clusterArn", "instanceArn", "secretArn"] as const) {
			request.expected[field] = request.expected[field].replace("us-east-1", request.expected.region);
		}
		request.expected.secretArn = request.expected.secretArn.replace("us-west-3", "us-east-1");
		expectFailure(() => normalizeAwsDbRequest(request), "INVALID_REQUEST");
	});

	it("accepts a matching IAM user identity with a path", () => {
		const principalArn = "arn:aws:iam::123456789012:user/fixture/FixtureReader";
		const request = inspection();
		const normalized = normalizeAwsDbRequest({ ...request, expected: { ...request.expected, principalArn } });
		expect(
			normalized.action === "inspect-automation-template" && normalized.expected.principalArn === principalArn,
		).toBe(true);
	});
});

describe("aws_db immutable normalized approvals", () => {
	it("copies and freezes every request branch before caller mutation", () => {
		const input = inspection();
		const original = structuredClone(input);
		const normalized = normalizeAwsDbRequest(input);
		expect(normalized.action === "inspect-automation-template").toBe(true);
		if (normalized.action !== "inspect-automation-template") return;
		const fingerprint = awsDbRequestFingerprint(normalized);
		expect(normalized !== input && normalized.expected !== input.expected && normalized.limits !== input.limits).toBe(
			true,
		);
		expect(
			Object.isFrozen(normalized) && Object.isFrozen(normalized.expected) && Object.isFrozen(normalized.limits),
		).toBe(true);
		input.profile = "different-reader";
		input.expected.endpoint = "different.example.invalid";
		input.expected.secretVersionId = "a".repeat(32);
		input.agencyId = "99";
		input.limits.maxBytes = 65_536;
		expect(JSON.stringify(normalized) === JSON.stringify(original)).toBe(true);
		expect(awsDbRequestFingerprint(normalized) === fingerprint).toBe(true);
		expect(Reflect.set(normalized.expected, "endpoint", input.expected.endpoint)).toBe(false);
		expect(Reflect.set(normalized.limits, "maxBytes", 1)).toBe(false);
		expect(Reflect.set(normalized, "stepId", "99")).toBe(false);
	});

	it("normalizes capability requests into an immutable independent value", () => {
		const input = { action: "capabilities" };
		const normalized = normalizeAwsDbRequest(input);
		input.action = "inspect-automation-template";
		expect(normalized !== input && normalized.action === "capabilities" && Object.isFrozen(normalized)).toBe(true);
	});

	it("uses the same approval fingerprint for semantically identical property ordering", () => {
		const original = normalizeAwsDbRequest(inspection());
		const reordered = normalizeAwsDbRequest(reverseKeys(inspection()));
		expect(
			original.action === "inspect-automation-template" && reordered.action === "inspect-automation-template",
		).toBe(true);
		if (original.action !== "inspect-automation-template" || reordered.action !== "inspect-automation-template")
			return;
		expect(/^sha256:[a-f0-9]{64}$/u.test(awsDbRequestFingerprint(original))).toBe(true);
		expect(awsDbRequestFingerprint(original) === awsDbRequestFingerprint(reordered)).toBe(true);
	});

	const changes: Array<[string, (request: AwsDbInspectionRequest) => void]> = [
		[
			"profile",
			request => {
				request.profile = "other-reader";
			},
		],
		[
			"account",
			request => {
				request.expected.accountId = "210987654321";
				for (const field of ["principalArn", "clusterArn", "instanceArn", "secretArn"] as const) {
					request.expected[field] = request.expected[field].replace("123456789012", request.expected.accountId);
				}
			},
		],
		[
			"region",
			request => {
				request.expected.region = "us-west-2";
				for (const field of ["clusterArn", "instanceArn", "secretArn"] as const) {
					request.expected[field] = request.expected[field].replace("us-east-1", request.expected.region);
				}
			},
		],
		[
			"partition",
			request => {
				request.expected.partition = "aws-us-gov";
				request.expected.region = "us-gov-west-1";
				for (const field of ["principalArn", "clusterArn", "instanceArn", "secretArn"] as const) {
					request.expected[field] = request.expected[field]
						.replace("arn:aws:", "arn:aws-us-gov:")
						.replace("us-east-1", request.expected.region);
				}
			},
		],
		[
			"principal",
			request => {
				request.expected.principalArn = "arn:aws:sts::123456789012:assumed-role/OtherReader/fixture-session";
			},
		],
		[
			"tenant",
			request => {
				request.expected.tenantId = "other-tenant";
			},
		],
		[
			"cluster ARN",
			request => {
				request.expected.clusterArn += "-other";
			},
		],
		[
			"cluster resource ID",
			request => {
				request.expected.clusterResourceId += "OTHER";
			},
		],
		[
			"instance ARN",
			request => {
				request.expected.instanceArn += "-other";
			},
		],
		[
			"instance resource ID",
			request => {
				request.expected.instanceResourceId += "OTHER";
			},
		],
		[
			"endpoint",
			request => {
				request.expected.endpoint = "other.example.invalid";
			},
		],
		[
			"port",
			request => {
				request.expected.port = 3307;
			},
		],
		[
			"database",
			request => {
				request.expected.database = "other_database";
			},
		],
		[
			"secret ARN",
			request => {
				request.expected.secretArn += "-other";
			},
		],
		[
			"secret version",
			request => {
				request.expected.secretVersionId = "a".repeat(32);
			},
		],
		[
			"agency",
			request => {
				request.agencyId = "18";
			},
		],
		[
			"automation",
			request => {
				request.automationId = "24";
			},
		],
		[
			"step",
			request => {
				request.stepId = "32";
			},
		],
		[
			"byte limit",
			request => {
				request.limits.maxBytes = 4095;
			},
		],
		[
			"timeout",
			request => {
				request.limits.timeoutMs = 999;
			},
		],
	];
	for (const [name, mutate] of changes) {
		it(`binds the approval fingerprint to the exact ${name}`, () => {
			const original = inspection();
			const changed = inspection();
			mutate(changed);
			const normalized = normalizeAwsDbRequest(changed);
			expect(normalized.action === "inspect-automation-template").toBe(true);
			if (normalized.action !== "inspect-automation-template") return;
			expect(awsDbRequestFingerprint(normalized) !== awsDbRequestFingerprint(original)).toBe(true);
		});
	}
});

describe("aws_db loaded capability compatibility", () => {
	const skews: Array<[string, () => unknown]> = [
		["protocol", () => ({ ...AWS_DB_CAPABILITY, protocol: "aws-db-memory/v0" })],
		["device", () => ({ ...AWS_DB_CAPABILITY, device: "aws" })],
		[
			"worker version with unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, worker: "aws-db-isolated-process/v0" },
			}),
		],
		[
			"sanitizer version with unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, sanitizerPolicy: "restricted-template-structure/v0" },
			}),
		],
		[
			"read policy with unchanged digest",
			() => ({ ...AWS_DB_CAPABILITY, manifest: { ...AWS_DB_CAPABILITY.manifest, readPolicy: "unrestricted/v1" } }),
		],
		[
			"execution cleanup policy with unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, executionPolicy: "tool-cancellation-cleanup/v0" },
			}),
		],
		[
			"execution host policy with unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, hostPolicy: "native-tool-host/v0" },
			}),
		],
		[
			"session lifecycle policy with unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, lifecyclePolicy: "tool-session-lifecycle/v0" },
			}),
		],
		[
			"TLS policy with unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, tlsPolicy: "amazon-rds-partition-roots/v0" },
			}),
		],
		[
			"TLS trust identity with unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: {
					...AWS_DB_CAPABILITY.manifest,
					tlsTrust: AWS_DB_CAPABILITY.manifest.tlsTrust.replace(
						/.$/u,
						AWS_DB_CAPABILITY.manifest.tlsTrust.endsWith("0") ? "1" : "0",
					),
				},
			}),
		],
		[
			"TLS coverage expansion with unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: {
					...AWS_DB_CAPABILITY.manifest,
					tlsRegions: {
						...AWS_DB_CAPABILITY.manifest.tlsRegions,
						aws: [...AWS_DB_CAPABILITY.manifest.tlsRegions.aws, "us-west-3"],
					},
				},
			}),
		],
		[
			"limits with unchanged digest",
			() => ({ ...AWS_DB_CAPABILITY, limits: { ...AWS_DB_CAPABILITY.limits, maxRows: 2 } }),
		],
		[
			"provider expansion",
			() => ({
				...AWS_DB_CAPABILITY,
				supportedProviders: [...AWS_DB_CAPABILITY.supportedProviders, "credential-process"],
			}),
		],
		[
			"unknown manifest field",
			() => ({ ...AWS_DB_CAPABILITY, manifest: { ...AWS_DB_CAPABILITY.manifest, raw: true } }),
		],
		["unknown capability field", () => ({ ...AWS_DB_CAPABILITY, approved: true })],
		[
			"missing manifest",
			() => ({ device: "aws_db", protocol: AWS_DB_CAPABILITY.protocol, capability: AWS_DB_CAPABILITY.capability }),
		],
	];
	for (const [name, skew] of skews) {
		it(`rejects incompatible loaded capabilities: ${name}`, () => {
			expectFailure(() => assertAwsDbCapability(skew()), "CAPABILITY_INCOMPATIBLE");
		});
	}

	for (const extra of ["hidden", "symbol", "prototype"] as const) {
		it(`rejects ${extra} metadata even when the loaded capability digest is valid`, () => {
			const value = structuredClone(AWS_DB_CAPABILITY);
			if (extra === "hidden") Object.defineProperty(value.manifest, "approved", { value: true });
			else if (extra === "symbol") Object.defineProperty(value, Symbol("approved"), { value: true });
			else Object.setPrototypeOf(value, { approved: true });
			expectFailure(() => assertAwsDbCapability(value), "CAPABILITY_INCOMPATIBLE");
		});
	}

	it("rejects loaded capability accessors before evaluating worker-controlled metadata", () => {
		let reads = 0;
		const value = structuredClone(AWS_DB_CAPABILITY);
		Object.defineProperty(value, "capability", {
			enumerable: true,
			get() {
				reads++;
				return AWS_DB_CAPABILITY.capability;
			},
		});
		expectFailure(() => assertAwsDbCapability(value), "CAPABILITY_INCOMPATIBLE");
		expect(reads === 0).toBe(true);
	});

	it("cannot mutate the advertised schema, policies, provider list, or limits after capability publication", () => {
		const fingerprint = AWS_DB_CAPABILITY.capability;
		expect(Object.isFrozen(AWS_DB_INPUT_SCHEMA) && Object.isFrozen(AWS_DB_CAPABILITY)).toBe(true);
		expect(Reflect.set(AWS_DB_INPUT_SCHEMA, "additionalProperties", true)).toBe(false);
		expect(Reflect.set(AWS_DB_CAPABILITY.manifest, "readPolicy", "unrestricted/v1")).toBe(false);
		expect(Reflect.set(AWS_DB_CAPABILITY.limits, "maxRows", 2)).toBe(false);
		expect(Reflect.set(AWS_DB_CAPABILITY.supportedProviders, "0", "credential-process")).toBe(false);
		expect(AWS_DB_CAPABILITY.capability === fingerprint).toBe(true);
		expectFailure(() => normalizeAwsDbRequest({ ...inspection(), sql: "SELECT 1" }), "INVALID_REQUEST");
	});
});
