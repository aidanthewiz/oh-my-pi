import { describe, expect, it, spyOn } from "bun:test";
import { channel } from "node:diagnostics_channel";
import { AwsDbFailure, type DbLimits, type SafeTemplateResult } from "@oh-my-pi/pi-coding-agent/tools/aws-db-contract";
import {
	createAutomationTemplateReader,
	runAutomationTemplateRead,
} from "@oh-my-pi/pi-coding-agent/tools/aws-db-query";
import { isSafeTemplateStructure } from "@oh-my-pi/pi-coding-agent/tools/aws-db-sanitize";
import { startAwsDbMysqlFixture, type AwsDbMysqlFixtureOptions } from "../helpers/aws-db-mysql-fixture";

interface InspectionOptions {
	maxBytes?: number;
	timeoutMs?: number;
	cancelAt?: "connect" | "read" | "before";
	productionTrust?: boolean;
}

async function inspectFixture(options: AwsDbMysqlFixtureOptions = {}, inspection: InspectionOptions = {}) {
	const fixture = await startAwsDbMysqlFixture(options);
	const credentials = { username: fixture.username, password: fixture.password };
	const controller = new AbortController();
	const logs: string[] = [];
	const observers = ["log", "warn", "error"] as const;
	const spies = observers.map(method =>
		spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logs.push(args.map(value => (typeof value === "string" ? value : String(value))).join(" "));
		}),
	);
	let result: SafeTemplateResult | undefined;
	let code = "SUCCESS";
	let safeFailure = true;
	try {
		if (inspection.cancelAt === "before") controller.abort();
		const limits: DbLimits = { ...fixture.read.limits };
		if (inspection.maxBytes !== undefined) limits.maxBytes = inspection.maxBytes;
		if (inspection.timeoutMs !== undefined) limits.timeoutMs = inspection.timeoutMs;
		const read = { ...fixture.read, limits };
		const reader = inspection.productionTrust
			? runAutomationTemplateRead
			: createAutomationTemplateReader({ tlsCa: fixture.tlsCa });
		const operation = reader(fixture.target, credentials, read, controller.signal).then(
			value => {
				result = value;
			},
			error => {
				code = error instanceof AwsDbFailure ? error.code : "UNSAFE_FAILURE";
				safeFailure =
					error instanceof AwsDbFailure &&
					error.message === error.code &&
					!Object.hasOwn(error, "cause") &&
					!Object.hasOwn(error, "sql") &&
					!fixture.containsSensitive(String(error));
			},
		);
		if (inspection.cancelAt === "connect") {
			if (await Promise.race([fixture.connected.then(() => true), operation.then(() => false)])) controller.abort();
		} else if (inspection.cancelAt === "read") {
			if (await Promise.race([fixture.readStarted.then(() => true), operation.then(() => false)]))
				controller.abort();
		}
		await operation;
		let peerClosedBeforeCleanup = fixture.state.connections === 0;
		if (!peerClosedBeforeCleanup) {
			const observed = Promise.withResolvers<boolean>();
			// Fake clocks do not drive TCP closure; this deadline only bounds a missing peer event.
			const deadline = setTimeout(() => observed.resolve(false), 1_000);
			fixture.peerClosed.then(
				() => observed.resolve(true),
				() => observed.resolve(false),
			);
			try {
				peerClosedBeforeCleanup = await observed.promise;
			} finally {
				clearTimeout(deadline);
			}
		}
		expect(peerClosedBeforeCleanup).toBe(true);
		const surface = JSON.stringify({ result, code, logs, commands: fixture.state.commands });
		return {
			result,
			code,
			safeFailure,
			credentialsReleased: credentials.username === "" && credentials.password === "",
			secretFree: !fixture.containsSensitive(surface) && !logs.some(value => fixture.containsSensitive(value)),
			quiet: logs.length === 0,
			state: { ...fixture.state, commands: [...fixture.state.commands] },
		};
	} finally {
		controller.abort();
		try {
			await fixture.close();
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	}
}

describe("native database physical reader", () => {
	it("authenticates over verified TLS, binds the exact definition and returns only structure after physical closure", async () => {
		const outcome = await inspectFixture();
		expect(outcome.code).toBe("SUCCESS");
		expect(outcome.result?.disposition).toBe("sanitized");
		expect(isSafeTemplateStructure(outcome.result?.structure)).toBe(true);
		expect(outcome.result?.proof).toEqual({ sameConnection: true, reader: true });
		expect(outcome.result?.teardown).toEqual({ connectionClosed: true, referencesReleased: true });
		expect(outcome.credentialsReleased && outcome.secretFree && outcome.quiet).toBe(true);
		expect(outcome.state.connections).toBe(1);
		expect(outcome.state.tlsConnections).toBe(1);
		expect(outcome.state.closedConnections).toBe(1);
		expect(outcome.state.authenticationVerified).toBe(true);
		expect(outcome.state.definitionBindingsVerified).toBe(true);
		expect(outcome.state.serverExecutionLimitVerified).toBe(true);
		expect(outcome.state.definitionReads).toBe(1);
	});

	it("rejects resultsets, affected rows and warnings in expected zero-row control acknowledgements", async () => {
		for (const controlResponse of ["rows", "affected", "warning"] as const) {
			const outcome = await inspectFixture({ controlResponse });
			expect(outcome.code).toBe("DB_READ_FAILED");
			expect(outcome.state.definitionReads).toBe(0);
			expect(outcome.state.closedConnections).toBe(1);
			expect(outcome.credentialsReleased && outcome.secretFree && outcome.safeFailure).toBe(true);
		}
	});

	it("refuses writable and unknown role reports before any definition read", async () => {
		for (const reader of ["writable", "unknown"] as const) {
			const outcome = await inspectFixture({ reader });
			expect(outcome.code).toBe("DB_READER_REQUIRED");
			expect(outcome.state.definitionReads).toBe(0);
			expect(outcome.state.connections === 1 && outcome.state.closedConnections === 1).toBe(true);
			expect(outcome.credentialsReleased && outcome.secretFree && outcome.safeFailure).toBe(true);
		}
	});

	it("refuses an unexpected Aurora node and an unparseable server identity", async () => {
		for (const options of [{ serverMismatch: true }, { invalidProof: true }]) {
			const outcome = await inspectFixture(options);
			expect(outcome.code).toBe("DB_IDENTITY_CHANGED");
			expect(outcome.state.definitionReads).toBe(0);
			expect(outcome.credentialsReleased && outcome.secretFree && outcome.safeFailure).toBe(true);
		}
	});

	it("rejects promotion, changed sessions, and disconnects without reconnecting or returning a definition", async () => {
		const cases: { options: AwsDbMysqlFixtureOptions; code: string }[] = [
			{ options: { promotion: "during-read" }, code: "DB_READER_REQUIRED" },
			{ options: { promotion: "after-read" }, code: "DB_READER_REQUIRED" },
			{ options: { replaceSession: true }, code: "DB_IDENTITY_CHANGED" },
			{ options: { disconnectAtRead: true }, code: "DB_IDENTITY_CHANGED" },
		];
		for (const entry of cases) {
			const outcome = await inspectFixture(entry.options);
			expect(outcome.code).toBe(entry.code);
			expect(outcome.result === undefined).toBe(true);
			expect(outcome.state.connections === 1 && outcome.state.closedConnections === 1).toBe(true);
			expect(outcome.credentialsReleased && outcome.secretFree && outcome.safeFailure).toBe(true);
		}
	});

	it("rejects write forwarding, writable grants, inherited roles, and unrecognized grants", async () => {
		const cases: AwsDbMysqlFixtureOptions[] = [
			{ forwarding: true },
			{ grants: "writable" },
			{ grants: "role" },
			{ grants: "malformed" },
			{ principalMismatch: true },
		];
		for (const options of cases) {
			const outcome = await inspectFixture(options);
			expect(outcome.code).toBe("DB_POLICY_DENIED");
			expect(outcome.state.definitionReads).toBe(0);
			expect(outcome.credentialsReleased && outcome.secretFree && outcome.safeFailure).toBe(true);
		}
	});

	it("rejects an unobserved execution limit and a server LOCAL INFILE request without releasing raw output", async () => {
		for (const options of [{ executionLimitMismatch: true }, { localInfile: true }]) {
			const outcome = await inspectFixture(options);
			expect(outcome.code).toBe("DB_POLICY_DENIED");
			expect(outcome.result === undefined).toBe(true);
			expect(outcome.state.localInfilePayloadBytes).toBe(0);
			expect(outcome.credentialsReleased && outcome.secretFree && outcome.safeFailure).toBe(true);
		}
	});

	it("rejects views both before and after transaction table pinning", async () => {
		for (const options of [{ view: true }, { tableReplacement: true }]) {
			const outcome = await inspectFixture(options);
			expect(outcome.code).toBe("DB_POLICY_DENIED");
			expect(outcome.state.definitionReads).toBe(0);
			expect(outcome.state.closedConnections).toBe(1);
			expect(outcome.secretFree).toBe(true);
		}
	});

	it("withholds unsupported step classes and executable templates instead of returning source", async () => {
		const sensitive = crypto.randomUUID().replaceAll("-", "");
		for (const options of [
			{ stepType: "CUSTOM CODE", rawTemplate: sensitive },
			{ rawTemplate: `SELECT ${sensitive}(); SELECT 1` },
		]) {
			const outcome = await inspectFixture(options);
			expect(outcome.code).toBe("SUCCESS");
			expect(outcome.result?.disposition).toBe("withheld");
			expect(Object.hasOwn(outcome.result!, "structure")).toBe(false);
			expect(JSON.stringify(outcome.result).includes(sensitive)).toBe(false);
			expect(outcome.secretFree && outcome.credentialsReleased).toBe(true);
		}
	});

	it("dispatches stored records filters without treating them as SQL or reconstructing customer data", async () => {
		const sensitive = `sensitive_${crypto.randomUUID().replaceAll("-", "")}`;
		const outcome = await inspectFixture({
			stepType: "QUERY RECORDS",
			rawTemplate: `data.${sensitive}__nin={steps.one.${sensitive}},${sensitive}&limit=5`,
		});
		expect(outcome.code).toBe("SUCCESS");
		expect(outcome.result?.disposition).toBe("sanitized");
		expect(outcome.result?.structure?.startsWith("RECORDS ")).toBe(true);
		expect(isSafeTemplateStructure(outcome.result?.structure)).toBe(true);
		expect(JSON.stringify(outcome.result).includes(sensitive)).toBe(false);
	});

	it("distinguishes a whole records-template reference from a bound value reference without exposing either path", async () => {
		const sensitive = `sensitive_${crypto.randomUUID().replaceAll("-", "")}`;
		const whole = await inspectFixture({ stepType: "QUERY RECORDS", rawTemplate: `{steps.two.${sensitive}}` });
		const value = await inspectFixture({
			stepType: "QUERY RECORDS",
			rawTemplate: `data.${sensitive}={steps.two.${sensitive}}`,
		});
		expect(whole.code).toBe("SUCCESS");
		expect(value.code).toBe("SUCCESS");
		expect(whole.result?.structure).toBe("RECORDS ( TEMPLATE = PLACEHOLDER )");
		expect(value.result?.structure).toBe("RECORDS ( FILTER IDENTIFIER = VALUE ( PLACEHOLDER ) )");
		expect(isSafeTemplateStructure(whole.result?.structure) && isSafeTemplateStructure(value.result?.structure)).toBe(
			true,
		);
		expect(JSON.stringify({ whole: whole.result, value: value.result }).includes(sensitive)).toBe(false);
		expect(whole.credentialsReleased && value.credentialsReleased && whole.secretFree && value.secretFree).toBe(true);
	});

	it("returns not-found only after a successful reader post-check", async () => {
		const outcome = await inspectFixture({ missing: true });
		expect(outcome.code).toBe("SUCCESS");
		expect(outcome.result?.disposition).toBe("not-found");
		expect(Object.hasOwn(outcome.result!, "structure")).toBe(false);
		expect(outcome.state.closedConnections).toBe(1);
	});

	it("refuses oversized definitions, announced packets, cumulative packets and extra rows", async () => {
		const cases: AwsDbMysqlFixtureOptions[] = [
			{ rawTemplate: `SELECT '${crypto.randomUUID().repeat(150)}'` },
			{ oversizedPacket: true },
			{ cumulativeBytes: true },
			{ extraRows: true },
		];
		for (const options of cases) {
			const outcome = await inspectFixture(options);
			expect(outcome.code).toBe("DB_LIMIT_EXCEEDED");
			expect(outcome.result === undefined).toBe(true);
			expect(outcome.credentialsReleased && outcome.secretFree && outcome.safeFailure).toBe(true);
			expect(outcome.state.closedConnections).toBe(1);
		}
	});

	it("suppresses sensitive driver error messages at proof, grant, transaction, read and teardown stages", async () => {
		for (const errorAt of [1, 2, 3, 5, 8, 9, 10, 11]) {
			const outcome = await inspectFixture({ errorAt });
			expect(outcome.code).toBe("DB_READ_FAILED");
			expect(outcome.safeFailure && outcome.secretFree && outcome.credentialsReleased && outcome.quiet).toBe(true);
			expect(outcome.state.closedConnections).toBe(1);
		}
	});

	it("rejects packet sequence changes before the driver can log a protocol diagnostic", async () => {
		const outcome = await inspectFixture({ badSequence: true });
		expect(outcome.code).toBe("DB_READ_FAILED");
		expect(outcome.quiet && outcome.secretFree && outcome.safeFailure).toBe(true);
	});

	it("closes a late handshake and an active read on cancellation without any reconnect", async () => {
		for (const stage of ["handshake", "read"] as const) {
			const outcome = await inspectFixture(
				{ delay: stage },
				{ cancelAt: stage === "handshake" ? "connect" : "read" },
			);
			expect(outcome.code).toBe("DB_CANCELLED");
			expect(outcome.state.connections === 1 && outcome.state.closedConnections === 1).toBe(true);
			expect(outcome.credentialsReleased && outcome.secretFree && outcome.safeFailure).toBe(true);
		}
	});

	it("bounds both connection and definition-read time and releases credentials before returning an error", async () => {
		for (const delay of ["handshake", "read"] as const) {
			const outcome = await inspectFixture({ delay }, { timeoutMs: 100 });
			expect(outcome.code).toBe("DB_TIMEOUT");
			expect(outcome.state.connections === 1 && outcome.state.closedConnections === 1).toBe(true);
			expect(outcome.credentialsReleased && outcome.secretFree && outcome.safeFailure).toBe(true);
		}
	});

	it("does not connect when already cancelled and still clears owned credentials", async () => {
		const outcome = await inspectFixture({}, { cancelAt: "before" });
		expect(outcome.code).toBe("DB_CANCELLED");
		expect(outcome.state.connections).toBe(0);
		expect(outcome.credentialsReleased && outcome.secretFree).toBe(true);
	});

	it("refuses subscribed driver tracing before authentication or network activity", async () => {
		const trace = channel("tracing:mysql2:query:start");
		let traced = false;
		const subscriber = () => {
			traced = true;
		};
		trace.subscribe(subscriber);
		try {
			const outcome = await inspectFixture();
			expect(outcome.code).toBe("DB_POLICY_DENIED");
			expect(outcome.state.connections).toBe(0);
			expect(outcome.credentialsReleased && !traced).toBe(true);
		} finally {
			trace.unsubscribe(subscriber);
		}
	});

	it("rejects an untrusted TLS root and a trusted certificate for the wrong hostname", async () => {
		const untrusted = await inspectFixture({}, { productionTrust: true });
		expect(untrusted.code).toBe("DB_CONNECT_FAILED");
		expect(untrusted.state.definitionReads).toBe(0);
		const mismatch = await inspectFixture({ certificateHost: "other.invalid" });
		expect(mismatch.code).toBe("DB_CONNECT_FAILED");
		expect(mismatch.state.definitionReads).toBe(0);
		expect(
			untrusted.credentialsReleased && mismatch.credentialsReleased && untrusted.secretFree && mismatch.secretFree,
		).toBe(true);
	});
});
