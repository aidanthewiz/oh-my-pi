import { describe, expect, test } from "bun:test";
import {
	awsSecretInputLifecycleSocketIdentitiesAvailable,
	measureAwsSecretInputLifecycleDescriptors,
} from "./fixtures/aws-secret-input-lifecycle-control";
import {
	isSupportedFiniteStdinDescriptor,
	isVerifiedFiniteStdinHandoff,
	isVerifiedStdinProducerWitness,
	type StdinPrivateChannelEvidence,
	type StdinProducerWitness,
} from "./fixtures/aws-secret-input-stdin-metadata";

function producer(empty = false): StdinProducerWitness {
	return {
		origin: "observed-anonymous-stdin-writes",
		observerPid: 101,
		guardianPid: 102,
		receiverPid: 103,
		pipeConfigured: true,
		inputUnmodified: true,
		inputWasEmpty: empty,
		exactWrites: true,
		bytesAccepted: empty ? 0 : 65_536,
		maxChunkBytes: empty ? 0 : 4096,
		flushesCompleted: true,
		eofClosed: true,
		writeFailed: false,
		backpressureObserved: true,
	};
}

const STREAM: StdinPrivateChannelEvidence = {
	verified: true,
	kind: "anonymous-unix-stream",
	isRegularFile: false,
	isTerminal: false,
	isSocket: true,
	isFifo: false,
	isCharacterDevice: false,
	matchesDevNull: false,
	socketFamily: "unix",
	localSocketFamily: "unix",
	peerSocketFamily: "unix",
	socketType: "stream",
	localAddress: "unnamed",
	peerAddress: "unnamed",
	failure: "none",
};

function handoff(descriptor: unknown, witness: unknown, empty = false) {
	return isVerifiedFiniteStdinHandoff(
		descriptor,
		witness,
		{ pid: 103, inputWasEmpty: empty, exactInput: true, eof: true },
		{ pid: 102, receiverPid: 103, workerPid: 101 },
	);
}

describe("finite stdin evidence admission", () => {
	for (const empty of [false, true]) {
		test(`requires an anonymous kernel channel for ${empty ? "empty" : "nonempty"} input`, () => {
			const witness = producer(empty);
			expect(handoff(STREAM, witness, empty)).toBe(true);
			expect(
				handoff({ ...STREAM, verified: false, isRegularFile: true, failure: "regular-file" }, witness, empty),
			).toBe(false);
			expect(handoff({ ...STREAM, localAddress: "named" }, witness, empty)).toBe(false);
			expect(handoff({ ...STREAM, socketType: "unavailable" }, witness, empty)).toBe(false);
		});
	}

	test("rejects null-device EOF as either an empty or nonempty finite stdin handoff", () => {
		const descriptor: StdinPrivateChannelEvidence = {
			verified: false,
			kind: "unverified",
			isRegularFile: false,
			isTerminal: false,
			isSocket: false,
			isFifo: false,
			isCharacterDevice: true,
			matchesDevNull: true,
			socketFamily: null,
			localSocketFamily: null,
			peerSocketFamily: null,
			socketType: null,
			localAddress: null,
			peerAddress: null,
			failure: "unsupported-channel",
		};
		expect(isSupportedFiniteStdinDescriptor(descriptor)).toBe(false);
		expect(handoff(descriptor, producer(true), true)).toBe(false);
		expect(handoff(descriptor, producer(false), false)).toBe(false);
	});

	for (const patch of [
		{ pipeConfigured: false },
		{ inputUnmodified: false },
		{ maxChunkBytes: 0 },
		{ exactWrites: false },
		{ bytesAccepted: 0 },
		{ maxChunkBytes: 65_536 },
		{ flushesCompleted: false },
		{ eofClosed: false },
		{ writeFailed: true },
		{ guardianPid: 103 },
		{ origin: "observed-bun-spawn-stdio0" },
	]) {
		test(`rejects incomplete producer evidence: ${Object.keys(patch)[0]}`, () => {
			const witness = { ...producer(), ...patch };
			expect(isVerifiedStdinProducerWitness(witness)).toBe(false);
			expect(handoff(STREAM, witness)).toBe(false);
		});
	}
});

describe("kernel descriptor alias evidence", () => {
	test("keeps proved socket aliases distinct from independent and conflicting kernel identities", () => {
		const descriptors = measureAwsSecretInputLifecycleDescriptors([
			{ fd: 7, dev: "9", ino: "4321", target: "socket:[4321]", kind: "socket" },
			{ fd: 19, dev: "9", ino: "4321", target: "socket:[4321]", kind: "socket" },
			{ fd: 20, dev: "9", ino: "4322", target: "socket:[4322]", kind: "socket" },
			{ fd: 21, dev: "9", ino: "4323", target: "socket:[4324]", kind: "socket" },
		]);
		expect(descriptors).toEqual([
			{ fd: 7, dev: "9", ino: "4321", target: "socket:[4321]", kind: "socket", measurable: true, aliases: [19] },
			{ fd: 20, dev: "9", ino: "4322", target: "socket:[4322]", kind: "socket", measurable: true, aliases: [] },
			{ fd: 21, dev: "9", ino: "4323", target: "socket:[4324]", kind: "socket", measurable: false, aliases: [] },
		]);
		expect(awsSecretInputLifecycleSocketIdentitiesAvailable(descriptors.slice(0, 2))).toBe(true);
		expect(awsSecretInputLifecycleSocketIdentitiesAvailable(descriptors)).toBe(false);
	});

	for (const target of ["", "socket:[9876]", "pipe:[4321]"]) {
		test(`keeps conflicting or unknown descriptor identities unmeasurable: ${target || "missing"}`, () => {
			const descriptors = measureAwsSecretInputLifecycleDescriptors([
				{ fd: 7, dev: "9", ino: "4321", target: "socket:[4321]", kind: "socket" },
				{ fd: 19, dev: "9", ino: "4321", target, kind: "socket" },
			]);
			expect(descriptors.map(descriptor => descriptor.measurable)).toEqual([false, false]);
			expect(descriptors.map(descriptor => descriptor.aliases)).toEqual([[], []]);
			expect(awsSecretInputLifecycleSocketIdentitiesAvailable(descriptors)).toBe(false);
		});
	}
});
