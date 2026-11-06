import { AWS_SECRET_INPUT_CAPABILITY } from "../../src/tools/aws-secret-input-contract";
import { AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID } from "../../src/tools/aws-secret-input-worker-protocol";
import { connectAwsSecretInputLifecycleControl } from "./aws-secret-input-lifecycle-control";
import { LIFECYCLE_DIAGNOSTIC, LIFECYCLE_FAILURE } from "./aws-secret-input-lifecycle-values";

async function runMalformedWorker() {
	const scenario = process.argv[2];
	const port = Number(process.argv[3]);
	const control = port ? await connectAwsSecretInputLifecycleControl(port, "worker") : undefined;
	control?.send({ kind: "worker-ready", pid: process.pid });
	const stopped = Promise.withResolvers<void>();
	const send = async (message: unknown): Promise<void> => {
		if (!process.send || !process.connected) throw new Error(LIFECYCLE_FAILURE);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		process.send(message, (error: Error | null) => (error ? reject(error) : resolve()));
		await promise;
	};
	const capabilities = {
		type: "capabilities",
		value: AWS_SECRET_INPUT_CAPABILITY,
		consumerAdmission: AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID,
	};
	const result = {
		stdout: "",
		stderr: "",
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		stdoutTruncated: false,
		stderrTruncated: false,
		completion: "exited",
		teardown: { consumerReaped: true, referencesReleased: true },
	};
	const onMessage = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		const message = value as { type?: unknown };
		if (message.type === "stop") {
			stopped.resolve();
			return;
		}
		if (message.type !== "run") return;
		control?.send({ kind: "malformed-worker-run", pid: process.pid });
		void (async () => {
			switch (scenario) {
				case "early-exit":
					process.exit(29);
				case "disconnect":
					process.disconnect?.();
					stopped.resolve();
					return;
				case "unknown-failure":
					await send({ type: "failure", code: LIFECYCLE_DIAGNOSTIC });
					return;
				case "authorization-out-of-order":
					await send({
						type: "authorize",
						id: 2,
						step: { service: "sts", operation: "get-caller-identity", region: "us-east-1" },
					});
					return;
				default:
					throw new Error(LIFECYCLE_FAILURE);
			}
		})().catch(() => stopped.resolve());
	};
	process.on("message", onMessage);
	process.once("disconnect", stopped.resolve);
	try {
		if (scenario === "missing-consumer-admission")
			await send({ type: "capabilities", value: AWS_SECRET_INPUT_CAPABILITY });
		else if (scenario === "malformed-capability") await send({ ...capabilities, cause: LIFECYCLE_DIAGNOSTIC });
		else if (scenario === "skewed-capability")
			await send({
				...capabilities,
				value: {
					...AWS_SECRET_INPUT_CAPABILITY,
					manifest: { ...AWS_SECRET_INPUT_CAPABILITY.manifest, worker: "unavailable-worker/v0" },
				},
			});
		else if (scenario === "result-before-capability") await send({ type: "result", value: result });
		else await send(capabilities);
		await stopped.promise;
	} finally {
		process.off("message", onMessage);
		process.off("disconnect", stopped.resolve);
		if (process.connected) process.disconnect?.();
		await control?.close();
	}
}

if (import.meta.main) {
	void runMalformedWorker().catch(() => {
		process.exitCode = 93;
		if (process.connected) process.disconnect?.();
	});
}
