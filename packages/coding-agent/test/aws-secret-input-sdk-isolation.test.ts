import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AWS_SECRET_INPUT_FAILURE_CODES } from "../src/tools/aws-secret-input-contract";

const FAILURE_SUBSTAGES = [
	"startup",
	"bounded-read",
	"create-client",
	"wire-protocol",
	"user-agent",
	"sso-request",
	"sigv4-request",
	"sigv4-signature",
	"sts-operation",
	"secret-operation",
	"defaults-provider",
	"sigv4a-provider",
	"sdk-send",
	"consumer-input",
	"scope-run",
	"scope-result",
	"request-counts",
	"ambient-read-check",
	"omission-control",
	"filesystem-guard",
	"network-guard",
	"spawn-guard",
] as const;

async function capture(stream: ReadableStream<Uint8Array>, maxBytes: number) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let overflow = false;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const remaining = maxBytes - size;
			if (value.byteLength > remaining) overflow = true;
			if (remaining > 0) {
				const chunk = value.slice(0, remaining);
				chunks.push(chunk);
				size += chunk.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { text: Buffer.concat(chunks).toString("utf8"), overflow };
}

function safeReceipt(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { controlAmbientReads, ...receipt } = value as Record<string, unknown>;
	return (
		typeof controlAmbientReads === "number" &&
		Number.isSafeInteger(controlAmbientReads) &&
		controlAmbientReads >= 5 &&
		Bun.deepEquals(receipt, {
			passed: true,
			productionScopes: 2,
			identityRequests: 2,
			secretRequests: 2,
			ssoRequests: 1,
			verifiedSigv4Requests: 4,
			verifiedBearerRequests: 1,
			boundedReads: 5,
			destroyedClients: 5,
			resolvedDefaultsProviders: 5,
			resolvedSigv4aProviders: 2,
			productionAmbientReads: 0,
			forbiddenReads: 0,
			networkCalls: 0,
			spawnCalls: 0,
			outputCalls: 0,
			publicResultOnlyConsumer: true,
			secondScopeIndependent: true,
			omissionControlsDetected: 5,
		})
	);
}

test.skipIf(process.platform === "win32")(
	"private AWS SDK scopes sign pinned requests without ambient configuration reads or cross-scope caches",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "aws-secret-input-sdk-isolation-"));
		try {
			const home = path.join(root, "home");
			const temp = path.join(root, "tmp");
			await fs.mkdir(temp, { mode: 0o700 });
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					"--no-install",
					path.resolve(import.meta.dir, "fixtures/aws-secret-input-sdk-isolation.ts"),
					root,
				],
				{
					cwd: root,
					env: {
						HOME: home,
						USERPROFILE: home,
						XDG_CONFIG_HOME: path.join(root, "xdg-config"),
						XDG_CACHE_HOME: path.join(root, "xdg-cache"),
						XDG_DATA_HOME: path.join(root, "xdg-data"),
						XDG_STATE_HOME: path.join(root, "xdg-state"),
						AWS_CONFIG_FILE: path.join(root, "ambient", "config"),
						AWS_SHARED_CREDENTIALS_FILE: path.join(root, "ambient", "credentials"),
						AWS_PROFILE: "ambient-sdk-isolation",
						TMPDIR: temp,
						TMP: temp,
						TEMP: temp,
						PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
						OMP_DOTENV_OVERRIDE: "1",
						OMP_CF_PRODUCT_VERSION: "fixture",
						BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
						DO_NOT_TRACK: "1",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					signal: AbortSignal.timeout(90_000),
				},
			);
			try {
				const [stdout, stderr, exit] = await Promise.all([
					capture(child.stdout, 8_192),
					capture(child.stderr, 4_096),
					child.exited,
				]);
				let receipt: unknown;
				try {
					receipt = JSON.parse(stdout.text);
				} catch {}
				const failure = receipt && typeof receipt === "object" ? (receipt as Record<string, unknown>) : undefined;
				const stage =
					failure?.passed === false &&
					Number.isSafeInteger(failure.stage) &&
					typeof failure.stage === "number" &&
					failure.stage >= 0 &&
					failure.stage <= 6
						? failure.stage
						: 0;
				const substage = FAILURE_SUBSTAGES.find(value => value === failure?.substage) ?? "startup";
				const failureCode =
					[...AWS_SECRET_INPUT_FAILURE_CODES, "UNCLASSIFIED", "FIXTURE_PROOF_FAILED"].find(
						value => value === failure?.failureCode,
					) ?? "UNCLASSIFIED";
				const ambient =
					failure?.ambient && typeof failure.ambient === "object"
						? (failure.ambient as Record<string, unknown>)
						: undefined;
				const ambientReads =
					typeof ambient?.count === "number" &&
					Number.isSafeInteger(ambient.count) &&
					ambient.count >= 0 &&
					ambient.count <= 1_024
						? ambient.count
						: 0;
				const ambientClient =
					["none", "sts", "secretsmanager", "sso"].find(value => value === ambient?.client) ?? "none";
				const ambientSubstage = FAILURE_SUBSTAGES.find(value => value === ambient?.substage) ?? "startup";
				const ambientKind = ["none", "config", "credentials"].find(value => value === ambient?.kind) ?? "none";
				const control =
					[
						"none",
						"authSchemePreference",
						"userAgentAppId",
						"defaultsMode",
						"sigv4aSigningRegionSet",
						"disableClockSkewCorrection",
					].find(value => value === failure?.control) ?? "none";
				const client = ["none", "sts", "secretsmanager", "sso"].find(value => value === failure?.client) ?? "none";
				const signatureKind =
					["none", "sigv4", "sigv4a", "other"].find(value => value === failure?.signatureKind) ?? "none";
				const signatureFailure =
					[
						"none",
						"authorization",
						"empty-signing-region",
						"access-key",
						"region",
						"service",
						"session-token",
						"timestamp",
						"query",
						"signed-headers",
						"payload-hash",
						"signature",
					].find(value => value === failure?.signatureFailure) ?? "none";
				expect(
					exit === 0,
					`SDK isolation fixture failed at stage ${stage}/${substage}/${failureCode}; control=${control}/${client}/${signatureKind}/${signatureFailure}; ambient=${ambientReads}/${ambientClient}/${ambientSubstage}/${ambientKind}; diagnostics are withheld`,
				).toBe(true);
				expect(stdout.overflow || stderr.overflow, "SDK fixture diagnostics exceeded their public bounds").toBe(
					false,
				);
				expect(stderr.text === "", "SDK fixture stderr is withheld").toBe(true);
				expect(safeReceipt(receipt), "SDK isolation evidence is incomplete; receipt is withheld").toBe(true);
			} finally {
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	100_000,
);
