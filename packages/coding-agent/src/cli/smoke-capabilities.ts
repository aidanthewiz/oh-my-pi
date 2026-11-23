import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type BlobBrokerInfo,
	type BlobBrokerStatus,
	type BlobUnitParams,
	type EnsureBlobResponse,
	blobBrokerConfigKey,
} from "../blob-broker/protocol";
import { daemonClient } from "../daemon/client";
import { daemonDir } from "../daemon/paths";
import {
	type DaemonClient,
	type DaemonTunnel,
	type UnitSnapshot,
	GLOBAL_SCOPE,
	projectScope,
} from "../daemon/protocol";
import {
	type DisasmUnitParams,
	disasmUnitKey,
	lineReader,
	parseHostResponse,
	parseHostStatus,
} from "../disasm/protocol";
import {
	LSP_ACQUIRE_METHOD,
	LSP_MODULE_KIND,
	LSP_UNRESERVE_METHOD,
	type LspAcquireResult,
	type LspServerParams,
} from "../lsp/mux/protocol";
import {
	TEXT_PREDICT_KIND,
	type TextPredictCalls,
	type TextPredictOpenParams,
	type TextPredictReply,
	textPredictKey,
} from "../predict/protocol";
import { resolveCliEntryCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../subprocess/worker-client";

async function stopUnit(client: DaemonClient, unit: UnitSnapshot): Promise<void> {
	await client.request({ op: "stop", unit: unit.id, generation: unit.generation, timeoutMs: SMOKE_TEST_TIMEOUT_MS });
}

async function lsp(client: DaemonClient, root: string): Promise<void> {
	const params: LspServerParams = { command: process.execPath, args: [], cwd: root };
	const signal = AbortSignal.timeout(SMOKE_TEST_TIMEOUT_MS);
	const first = await client.call<LspAcquireResult>(LSP_MODULE_KIND, LSP_ACQUIRE_METHOD, params, { signal });
	let second: LspAcquireResult | undefined;
	let reused: LspAcquireResult | undefined;
	try {
		second = await client.call<LspAcquireResult>(LSP_MODULE_KIND, LSP_ACQUIRE_METHOD, params, { signal });
		assert.notEqual(second.key, first.key, "LSP module handed an occupied reservation to a second client");
		await client.call(LSP_MODULE_KIND, LSP_UNRESERVE_METHOD, first, { signal });
		reused = await client.call<LspAcquireResult>(LSP_MODULE_KIND, LSP_ACQUIRE_METHOD, params, { signal });
		assert.equal(reused.key, first.key, "LSP module did not release the first reservation");
	} finally {
		for (const reservation of [first, second, reused]) {
			if (reservation) await client.call(LSP_MODULE_KIND, LSP_UNRESERVE_METHOD, reservation);
		}
	}
}

async function disasm(client: DaemonClient, root: string): Promise<void> {
	const dir = path.join(root, "disasm");
	const missing = path.join(dir, "missing");
	const params: DisasmUnitParams = {
		backend: "ida",
		loc: {
			id: "smoke",
			dir,
			sourcePath: missing,
			stagedPath: missing,
			kind: "store",
			openPath: missing,
			isNew: true,
			lockTarget: path.join(dir, "db"),
		},
		runtime: { pythonPath: "python3", env: {} },
		idleCloseMs: 0,
		maxOpen: 4,
	};
	const signal = AbortSignal.timeout(SMOKE_TEST_TIMEOUT_MS);
	const { unit } = await client.open(
		{ kind: "disasm", scope: GLOBAL_SCOPE, key: disasmUnitKey("ida", "smoke"), params },
		signal,
	);
	let tunnel: DaemonTunnel | undefined;
	try {
		tunnel = await client.attach(unit.id, undefined, signal);
		const pending = Promise.withResolvers<void>();
		const abort = () => pending.reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		try {
			tunnel.start(
				lineReader(line => {
					try {
						const response = parseHostResponse(line);
						if (response.id !== 1) return;
						if (!response.ok) throw new Error(response.error);
						const status = parseHostStatus(response.result);
						assert.equal(status.id, "smoke");
						assert.equal(status.state, "opening");
						pending.resolve();
					} catch (error) {
						pending.reject(error);
					}
				}),
				reason => pending.reject(new Error(reason ?? "Disassembler status tunnel closed")),
			);
			signal.throwIfAborted();
			tunnel.send(`${JSON.stringify({ id: 1, op: "status" })}\n`);
			await pending.promise;
		} finally {
			signal.removeEventListener("abort", abort);
		}
	} finally {
		tunnel?.close();
		await stopUnit(client, unit);
	}
}

async function blob(client: DaemonClient, root: string): Promise<void> {
	const params: BlobUnitParams = {
		config: { kind: "direct", options: {}, credentials: {}, bindHost: "127.0.0.1" },
		spawn: { cwd: root, env: workerEnvFromParent() },
	};
	const signal = AbortSignal.timeout(SMOKE_TEST_TIMEOUT_MS);
	const { unit } = await client.open(
		{ kind: "blob", scope: projectScope(root), key: blobBrokerConfigKey(params.config), params },
		signal,
	);
	try {
		const info = await client.call<BlobBrokerInfo>("blob", "info", {}, { unit: unit.id, signal });
		assert.equal(new URL(info.baseUrl).hostname, "127.0.0.1");
		const { publication } = await client.call<EnsureBlobResponse>(
			"blob",
			"blob",
			{
				key: "smoke",
				mimeType: "image/png",
				data: Buffer.from("smoke-test").toString("base64"),
			},
			{ unit: unit.id, signal },
		);
		assert(publication, "Blob registration returned no publication");
		assert.equal(publication.destination, "direct");
		assert.equal(publication.bytes, 10);
		assert.equal(new URL(publication.url).hostname, "127.0.0.1");
		const response = await fetch(publication.url, { signal });
		assert(response.ok, `Blob retrieval failed: ${response.status}`);
		assert.equal(await response.text(), "smoke-test");
		const status = await client.call<BlobBrokerStatus>("blob", "status", {}, { unit: unit.id, signal });
		assert.equal(status.metrics.activeBlobs, 1);
		assert.equal(status.metrics.hits, 1);
		assert.equal(status.metrics.bytesServed, 10);
	} finally {
		await stopUnit(client, unit);
	}
}

async function terminal(client: DaemonClient, root: string): Promise<void> {
	const [application, ...args] = resolveCliEntryCmd();
	const signal = AbortSignal.timeout(SMOKE_TEST_TIMEOUT_MS);
	const { unit } = await client.open(
		{
			kind: "proc",
			scope: projectScope(root),
			key: "terminal-smoke",
			proc: {
				application,
				args: [...args, "sh", "-c", "printf 'old\\r\\033[2K\\033[1;32mready\\033[0m'"],
				cwd: root,
				env: workerEnvFromParent(),
				pty: true,
			},
			policy: { restart: "no", survive: "none" },
		},
		signal,
	);
	try {
		const done = await client.request(
			{ op: "wait", unit: unit.id, for: "exit", timeoutMs: SMOKE_TEST_TIMEOUT_MS },
			signal,
		);
		assert.equal(done.unit.exitCode, 0, "Terminal smoke child did not exit successfully");
		const output = await client.request(
			{ op: "logs", unit: unit.id, lines: 10, head: false, follow: false, timeoutMs: 0 },
			signal,
		);
		assert.equal(output.terminalOutput, "\x1b[0m\x1b[1;38;5;2mready", "PTY terminal rendering changed");
	} finally {
		await stopUnit(client, unit);
	}
}

async function predict(client: DaemonClient, root: string): Promise<void> {
	const agentDir = path.join(root, "predict");
	const params: TextPredictOpenParams = {
		agentDir,
		historyDbPath: path.join(agentDir, "history.db"),
		modelDir: path.join(agentDir, "models"),
		stateDirs: {
			ngram: path.join(agentDir, "ngram"),
			smollm: path.join(agentDir, "smollm"),
			apple: path.join(agentDir, "apple"),
		},
	};
	const signal = AbortSignal.timeout(SMOKE_TEST_TIMEOUT_MS);
	const { unit } = await client.open(
		{ kind: TEXT_PREDICT_KIND, scope: GLOBAL_SCOPE, key: textPredictKey(agentDir), params },
		signal,
	);
	try {
		const completion = await client.call<TextPredictReply<TextPredictCalls["complete"]["result"]>>(
			TEXT_PREDICT_KIND,
			"complete",
			{ method: "ngram", before: "please ", prefix: "re" },
			{ unit: unit.id, signal },
		);
		if (!completion.ok) throw new Error(completion.error);
		const sync = await client.call<TextPredictReply<TextPredictCalls["sync"]["result"]>>(
			TEXT_PREDICT_KIND,
			"sync",
			{},
			{ unit: unit.id, signal },
		);
		if (!sync.ok) throw new Error(sync.error);
		assert.equal(sync.value.ingested, 0, "Predict smoke read non-synthetic history");
	} finally {
		await stopUnit(client, unit);
	}
}

/** Run in a synthetic HOME inside isolateDaemonForSmokeTest; its cleanup owns this root and every service. */
export async function smokeTestRuntimeCapabilities(): Promise<void> {
	const client = await daemonClient();
	const root = await fs.mkdtemp(path.join(daemonDir(), "capabilities-"));
	await lsp(client, root);
	await disasm(client, root);
	await blob(client, root);
	await terminal(client, root);
	await predict(client, root);
}
