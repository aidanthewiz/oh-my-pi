import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AWS_SECRET_INPUT_PROTOCOL,
	AwsSecretInputFailure,
	normalizeAwsSecretInputRequest,
	quoteAwsSecretInputArgv,
	safeAwsSecretInputFailure,
	type AwsSecretInputFailureCode,
	type AwsSecretInputRequest,
} from "../../src/tools/aws-secret-input-contract";

function request(): AwsSecretInputRequest {
	return {
		profile: "synthetic-input",
		region: "us-east-1",
		service: "secretsmanager",
		operation: "get-secret-value",
		parameters: {
			SecretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:synthetic-input-AbCdEf",
			VersionId: "12345678-1234-1234-1234-123456789012",
			VersionStage: "AWSCURRENT",
		},
		secretInput: {
			protocol: AWS_SECRET_INPUT_PROTOCOL,
			capability: "sha256:4936396a3a935e4582d42be1d73ef096353d23802dcea2394f7e969ffb42a358",
			expectedIdentity: {
				account: "123456789012",
				arn: "arn:aws:sts::123456789012:assumed-role/SyntheticInput/local-session",
				partition: "aws",
			},
			consumer: {
				argv: [process.execPath, "--no-env-file", "--no-install", "-e", "process.exit(0)"],
				cwd: import.meta.dir,
			},
		},
	};
}

function rejects(value: unknown, code: AwsSecretInputFailureCode = "INVALID_REQUEST"): void {
	let failure: unknown;
	try {
		normalizeAwsSecretInputRequest(value);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(AwsSecretInputFailure);
	expect((failure as AwsSecretInputFailure).code).toBe(code);
	expect((failure as Error).message).toBe(code);
	expect(Object.hasOwn(failure as Error, "cause")).toBe(false);
}

describe("AWS secret input admission data", () => {
	it("rejects nondata properties without evaluating accessors or error causes", () => {
		let evaluations = 0;
		const access = () => {
			evaluations++;
			throw new Error("untrusted accessor must not execute");
		};
		const getter = Object.defineProperty(request(), "secretInput", { enumerable: true, get: access });
		const hidden = Object.defineProperty(request(), "provider", { enumerable: false, get: access });
		const symbolic = Object.assign(request(), { [Symbol("provider")]: access });
		const inherited = Object.assign(Object.create({ provider: "untrusted" }), request());
		const cyclic = request() as unknown as Record<string, unknown>;
		cyclic.self = cyclic;
		for (const value of [getter, hidden, symbolic, inherited, cyclic, { ...request(), provider: access }])
			rejects(value);
		expect(evaluations).toBe(0);
	});

	it("does not evaluate provider diagnostic properties when selecting a public failure code", () => {
		let evaluations = 0;
		const failure = new AwsSecretInputFailure("AWS_FAILED");
		Object.defineProperty(failure, "code", {
			get() {
				evaluations++;
				throw new Error("untrusted diagnostic must not execute");
			},
		});
		const diagnostic = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("untrusted diagnostic prototype");
				},
			},
		);
		expect(safeAwsSecretInputFailure(failure)).toBe("WORKER_FAILED");
		expect(safeAwsSecretInputFailure(diagnostic)).toBe("WORKER_FAILED");
		expect(evaluations).toBe(0);
	});

	it("requires the agreed protocol and exact manifest fingerprint", () => {
		rejects({ action: "secret-input-capabilities", protocol: "aws-secret-input/v0" });
		rejects({ action: "secret-input-capabilities", protocol: AWS_SECRET_INPUT_PROTOCOL, profile: "synthetic-input" });
		for (const capability of [
			`sha256:${"0".repeat(64)}`,
			"sha256:d22786d4a043200a285344d1ce7316ed342e7a7de68e33af4de6e07a1b7f6469",
		]) {
			const value = request();
			value.secretInput.capability = capability;
			rejects(value, "CAPABILITY_INCOMPATIBLE");
		}
	});

	const invalidReference: Array<[string, (value: AwsSecretInputRequest) => unknown]> = [
		[
			"a secret name instead of an exact ARN",
			value => {
				value.parameters.SecretId = "synthetic-input";
			},
		],
		[
			"a wildcard secret ARN",
			value => {
				value.parameters.SecretId += "*";
			},
		],
		[
			"a different secret region",
			value => {
				value.parameters.SecretId = value.parameters.SecretId.replace("us-east-1", "us-west-2");
			},
		],
		[
			"a different principal account",
			value => {
				value.secretInput.expectedIdentity.arn = value.secretInput.expectedIdentity.arn.replace(
					"123456789012",
					"210987654321",
				);
			},
		],
		[
			"an inconsistent partition",
			value => {
				value.secretInput.expectedIdentity.partition = "aws-us-gov";
			},
		],
		[
			"an unpinned version",
			value => {
				Reflect.deleteProperty(value.parameters, "VersionId");
			},
		],
		[
			"a control character in the pinned stage",
			value => {
				value.parameters.VersionStage = "AWSCURRENT\n";
			},
		],
		[
			"an endpoint override",
			value => {
				Object.assign(value.parameters, { EndpointUrl: "https://synthetic.invalid" });
			},
		],
		[
			"a different operation",
			value => {
				Object.assign(value, { operation: "batch-get-secret-value" });
			},
		],
		[
			"a public worker injection",
			value => {
				Object.assign(value.secretInput, { provider: "synthetic" });
			},
		],
		[
			"a public consumer environment",
			value => {
				Object.assign(value.secretInput.consumer, { env: { AWS_PROFILE: "synthetic-input" } });
			},
		],
		[
			"a caller-supplied stdin payload",
			value => {
				Object.assign(value.secretInput.consumer, { stdin: "not-a-secret-reference" });
			},
		],
		[
			"a shell transport override",
			value => {
				Object.assign(value.secretInput.consumer, { shell: true });
			},
		],
	];
	for (const [name, mutate] of invalidReference) {
		it(`rejects ${name}`, () => {
			const value = request();
			mutate(value);
			rejects(value);
		});
	}

	it("rejects relative executables, relative working directories, and NUL command bytes", () => {
		for (const mutate of [
			(value: AwsSecretInputRequest) => {
				value.secretInput.consumer.argv[0] = "synthetic-consumer";
			},
			(value: AwsSecretInputRequest) => {
				value.secretInput.consumer.cwd = ".";
			},
			(value: AwsSecretInputRequest) => {
				value.secretInput.consumer.argv.push("literal\0argument");
			},
			(value: AwsSecretInputRequest) => {
				value.secretInput.consumer.cwd += "\0";
			},
		]) {
			const value = request();
			mutate(value);
			rejects(value);
		}
	});

	it("bounds aggregate argv bytes rather than counting UTF-16 code units", () => {
		const value = request();
		const executableBytes = Buffer.byteLength(value.secretInput.consumer.argv[0]!);
		const remaining = 131_072 - executableBytes;
		const words: string[] = [];
		let bytes = remaining;
		while (bytes > 0) {
			const size = Math.min(bytes, 8_192);
			words.push("é".repeat(Math.floor(size / 2)) + (size % 2 ? "x" : ""));
			bytes -= size;
		}
		value.secretInput.consumer.argv = [value.secretInput.consumer.argv[0]!, ...words];
		const admitted = normalizeAwsSecretInputRequest(value) as AwsSecretInputRequest;
		expect(() => admitted.secretInput.consumer.argv.push("additional-command")).toThrow();
		value.secretInput.consumer.argv.push("é");
		rejects(value);
	});

	it("makes an admitted command independent from subsequent caller mutations", () => {
		const value = request();
		value.parameters.SecretId = value.parameters.SecretId.replace("123456789012", "210987654321");
		value.secretInput.jsonPointer = "/credential";
		const admitted = normalizeAwsSecretInputRequest(value) as AwsSecretInputRequest;
		value.profile = "another-profile";
		value.parameters.SecretId = value.parameters.SecretId.replace("210987654321", "999999999999");
		value.parameters.VersionId = "87654321-4321-4321-4321-210987654321";
		value.secretInput.expectedIdentity.account = "210987654321";
		value.secretInput.consumer.argv.push("--unexpected-write");
		value.secretInput.consumer.cwd = "/another-directory";
		value.secretInput.jsonPointer = "/other";
		expect(admitted.profile).toBe("synthetic-input");
		expect(admitted.parameters.SecretId).toBe(
			"arn:aws:secretsmanager:us-east-1:210987654321:secret:synthetic-input-AbCdEf",
		);
		expect(admitted.parameters.VersionId).toBe("12345678-1234-1234-1234-123456789012");
		expect(admitted.secretInput.expectedIdentity.account).toBe("123456789012");
		expect(admitted.secretInput.consumer.argv).not.toContain("--unexpected-write");
		expect(admitted.secretInput.consumer.cwd).toBe(import.meta.dir);
		expect(admitted.secretInput.jsonPointer).toBe("/credential");
	});

	it.skipIf(process.platform === "win32")(
		"quotes the exact consumer command without shell expansion",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "aws-secret-input-quote-"));
			const literal = [
				"",
				"space word",
				"single'quote",
				'double"quote',
				"$HOME",
				"$(touch unexpected-mutation)",
				"; touch unexpected-mutation",
				"line\nnext",
				"trailing\\",
				"雪",
			];
			try {
				const child = Bun.spawn(
					["/bin/sh", "-c", quoteAwsSecretInputArgv(["/usr/bin/printf", "%s\\000", ...literal])],
					{
						cwd: root,
						env: { HOME: root, PATH: "/usr/bin:/bin" },
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						signal: AbortSignal.timeout(10_000),
					},
				);
				try {
					const [stdout, stderr, exit] = await Promise.all([
						new Response(child.stdout).arrayBuffer(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					expect(exit).toBe(0);
					expect(stderr).toBe("");
					expect(Buffer.from(stdout)).toEqual(Buffer.from(`${literal.join("\0")}\0`));
					expect(await Bun.file(join(root, "unexpected-mutation")).exists()).toBe(false);
				} finally {
					if (child.exitCode === null) child.kill("SIGKILL");
					await child.exited;
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		15_000,
	);
});
