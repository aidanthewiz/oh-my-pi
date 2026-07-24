export type RelayAuthTokenProvider = (signal: AbortSignal) => Promise<string | undefined>;

export class RetryableRelayAuthorizationError extends Error {
	override readonly name = "RetryableRelayAuthorizationError";
}
