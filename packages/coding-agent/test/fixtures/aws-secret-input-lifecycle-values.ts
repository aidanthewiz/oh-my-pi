export const LIFECYCLE_SECRET_TEXT = 'aws_secret_input_fixture_secret_9b7e\0é🙂\r\n"literal\\bytes"';
export const LIFECYCLE_SECRET_BINARY = new Uint8Array([
	...new TextEncoder().encode("aws_secret_input_fixture_binary_5c2a"),
	0,
	255,
	128,
	10,
	13,
	0,
]);
export const LIFECYCLE_SECRET_LIMIT_INPUT = new Uint8Array(65_536).fill(0xa5);
LIFECYCLE_SECRET_LIMIT_INPUT.set(new TextEncoder().encode("aws_secret_input_fixture_limit_8c14"));
export const LIFECYCLE_CREDENTIALS = Object.freeze({
	accessKeyId: "aws_secret_input_fixture_access_6a91",
	secretAccessKey: "aws_secret_input_fixture_credential_3f42",
	sessionToken: "aws_secret_input_fixture_token_17d8",
});
export const LIFECYCLE_DIAGNOSTIC = "aws_secret_input_fixture_diagnostic_e2c3";
export const LIFECYCLE_STDOUT = "public stdout\0é🙂\n";
export const LIFECYCLE_STDERR = "public stderr\0漢字\n";
export const LIFECYCLE_OUTPUT_LIMIT = 1_048_576;
export const LIFECYCLE_FAILURE = "AWS_SECRET_INPUT_LIFECYCLE_FIXTURE_FAILED";
export const LIFECYCLE_SENSITIVE_MARKER = "aws_secret_input_fixture_";

export type AwsSecretInputLifecycleConsumerMode =
	| "text"
	| "success"
	| "write"
	| "newline"
	| "binary"
	| "input-limit"
	| "input-paused"
	| "empty"
	| "hold"
	| "commit-hold"
	| "exit-with-descendant"
	| "boundary"
	| "overflow"
	| "early-exit"
	| "signal";

export function lifecycleExpectedInput(mode: AwsSecretInputLifecycleConsumerMode): Uint8Array {
	if (mode === "binary") return new Uint8Array(LIFECYCLE_SECRET_BINARY);
	if (mode === "input-limit" || mode === "input-paused") return new Uint8Array(LIFECYCLE_SECRET_LIMIT_INPUT);
	if (mode === "empty") return new Uint8Array();
	return new TextEncoder().encode(LIFECYCLE_SECRET_TEXT + (mode === "newline" ? "\n" : ""));
}

export function lifecycleContainsSensitive(value: unknown): boolean {
	const seen = new WeakSet<object>();
	const visit = (item: unknown): boolean => {
		if (typeof item === "string") return item.includes(LIFECYCLE_SENSITIVE_MARKER);
		if (!item || typeof item !== "object" || seen.has(item)) return false;
		seen.add(item);
		if (item instanceof Uint8Array) return visit(Buffer.from(item).toString("utf8"));
		return Reflect.ownKeys(item).some(key => {
			if (visit(String(key))) return true;
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			return !!descriptor && "value" in descriptor && visit(descriptor.value);
		});
	};
	return visit(value);
}
