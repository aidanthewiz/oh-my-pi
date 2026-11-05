import stsPackage from "@aws-sdk/client-sts/package.json" with { type: "json" };
import rdsPackage from "@aws-sdk/client-rds/package.json" with { type: "json" };
import secretPackage from "@aws-sdk/client-secrets-manager/package.json" with { type: "json" };
import ssoPackage from "@aws-sdk/client-sso/package.json" with { type: "json" };
import mysqlPackage from "mysql2/package.json" with { type: "json" };
import { TOOL_CANCELLATION_CLEANUP_VERSION } from "@oh-my-pi/pi-agent-core/tool-cancellation";
import {
	AWS_DB_CAPABILITY,
	AWS_DB_MANIFEST,
	AwsDbFailure,
	canonicalAwsDbJson,
	normalizeAwsDbRequest,
	safeAwsDbFailure,
} from "./aws-db-contract";
import { AWS_DB_PROVIDER_POLICY_ID } from "./aws-db-provider";
import { DB_READ_POLICY_ID } from "./aws-db-query";
import { DB_SANITIZER_POLICY_ID } from "./aws-db-sanitize";
import { DB_TLS_POLICY_ID, DB_TLS_SUPPORTED_REGIONS, DB_TLS_TRUST_FINGERPRINT } from "./aws-db-tls";
import { AWS_DB_SCOPE_ID, runAwsDbScope, type AwsDbScopeDependencies, type AwsDbStep } from "./aws-db-scope";
import {
	AWS_DB_WORKER_ID,
	assertSafeTemplateResult,
	workerFailureCode,
	type AwsDbWorkerInbound,
	type AwsDbWorkerOutbound,
} from "./aws-db-worker-protocol";

function loadedCapability() {
	if (
		AWS_DB_WORKER_ID !== AWS_DB_MANIFEST.worker ||
		AWS_DB_SCOPE_ID !== AWS_DB_MANIFEST.scope ||
		TOOL_CANCELLATION_CLEANUP_VERSION !== AWS_DB_MANIFEST.executionPolicy ||
		AWS_DB_PROVIDER_POLICY_ID !== AWS_DB_MANIFEST.authPolicy ||
		DB_READ_POLICY_ID !== AWS_DB_MANIFEST.readPolicy ||
		DB_SANITIZER_POLICY_ID !== AWS_DB_MANIFEST.sanitizerPolicy ||
		DB_TLS_POLICY_ID !== AWS_DB_MANIFEST.tlsPolicy ||
		DB_TLS_TRUST_FINGERPRINT !== AWS_DB_MANIFEST.tlsTrust ||
		canonicalAwsDbJson(DB_TLS_SUPPORTED_REGIONS) !== canonicalAwsDbJson(AWS_DB_MANIFEST.tlsRegions) ||
		`mysql2@${mysqlPackage.version}` !== AWS_DB_MANIFEST.driver ||
		[stsPackage, rdsPackage, secretPackage, ssoPackage].some(value => value.version !== "3.1150.0")
	)
		throw new AwsDbFailure("CAPABILITY_INCOMPATIBLE");
	return AWS_DB_CAPABILITY;
}

export async function startAwsDbWorker(dependencies?: AwsDbScopeDependencies): Promise<void> {
	const controller = new AbortController();
	const pending = new Map<number, { resolve: () => void; reject: (error: AwsDbFailure) => void }>();
	const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
	let sequence = 0;
	let started = false;
	let completed = false;
	let hardStop: Timer | undefined;
	const send = async (message: AwsDbWorkerOutbound): Promise<void> => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		if (!process.send || !process.connected) throw new AwsDbFailure("CANCELLED");
		try {
			process.send(message, (error: Error | null) =>
				error ? reject(new AwsDbFailure("WORKER_FAILED")) : resolve(),
			);
		} catch {
			reject(new AwsDbFailure("WORKER_FAILED"));
		}
		await promise;
	};
	const close = (): void => {
		if (completed) return;
		completed = true;
		clearTimeout(hardStop);
		for (const waiter of pending.values()) waiter.reject(new AwsDbFailure("CANCELLED"));
		pending.clear();
		stop();
	};
	const cancel = (): void => {
		if (completed) return;
		controller.abort();
		for (const waiter of pending.values()) waiter.reject(new AwsDbFailure("CANCELLED"));
		pending.clear();
		if (!started) close();
		else hardStop ??= setTimeout(() => process.exit(1), 750);
	};
	const authorize = async (step: AwsDbStep): Promise<void> => {
		controller.signal.throwIfAborted();
		const id = ++sequence;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		pending.set(id, { resolve, reject });
		try {
			await send({ type: "authorize", id, step });
			await promise;
		} finally {
			pending.delete(id);
		}
	};
	const onMessage = (unknown: unknown): void => {
		if (!unknown || typeof unknown !== "object" || Array.isArray(unknown)) {
			cancel();
			return;
		}
		const message = unknown as AwsDbWorkerInbound;
		if (message.type === "stop") {
			cancel();
			return;
		}
		if (message.type === "authorize-result") {
			const waiter = pending.get(message.id);
			if (!waiter || typeof message.allowed !== "boolean") {
				cancel();
				return;
			}
			message.allowed
				? waiter.resolve()
				: waiter.reject(
						new AwsDbFailure(message.code === undefined ? "GUARD_DENIED" : workerFailureCode(message.code)),
					);
			return;
		}
		if (message.type !== "inspect" || started) {
			cancel();
			return;
		}
		started = true;
		void (async () => {
			try {
				loadedCapability();
				const request = normalizeAwsDbRequest(message.request);
				if (request.action !== "inspect-automation-template") throw new AwsDbFailure("INVALID_REQUEST");
				const result = await runAwsDbScope(request, message.launch, authorize, controller.signal, dependencies);
				assertSafeTemplateResult(result);
				await send({ type: "result", value: result });
			} catch (error) {
				try {
					await send({ type: "failure", code: controller.signal.aborted ? "CANCELLED" : safeAwsDbFailure(error) });
				} catch {
					/* The disconnected parent cannot receive a result. */
				}
			} finally {
				close();
			}
		})();
	};
	process.on("message", onMessage);
	process.once("disconnect", cancel);
	process.once("SIGTERM", cancel);
	process.once("SIGINT", cancel);
	process.once("uncaughtException", cancel);
	process.once("unhandledRejection", cancel);
	try {
		await send({ type: "capabilities", value: loadedCapability() });
	} catch {
		try {
			await send({ type: "failure", code: "CAPABILITY_INCOMPATIBLE" });
		} catch {
			/* No diagnostic output. */
		}
		close();
	}
	await stopped;
	process.off("message", onMessage);
	process.off("disconnect", cancel);
	process.off("SIGTERM", cancel);
	process.off("SIGINT", cancel);
	process.off("uncaughtException", cancel);
	process.off("unhandledRejection", cancel);
	if (process.connected) process.disconnect?.();
}

if (import.meta.main) {
	void startAwsDbWorker().catch(async () => {
		process.exitCode = 1;
		try {
			if (process.connected && process.send) {
				const { promise, resolve } = Promise.withResolvers<void>();
				process.send({ type: "failure", code: "WORKER_FAILED" }, () => resolve());
				await Promise.race([promise, Bun.sleep(250)]);
			}
		} catch {
			/* The parent maps an unexpected process exit to a fixed failure. */
		} finally {
			try {
				if (process.connected) process.disconnect?.();
			} catch {}
		}
	});
}
