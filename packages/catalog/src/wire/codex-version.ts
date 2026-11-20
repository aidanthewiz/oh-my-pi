import { CODEX_CLIENT_VERSION } from "./codex";

let resolvedVersion: string | undefined;

/**
 * Wire and model-cache version, fixed on first use for the process lifetime.
 * An explicit override never reads a cached record or starts npm discovery.
 */
export function getCodexClientVersion(): string {
	return (resolvedVersion ??= process.env.PI_AI_CODEX_CLIENT_VERSION || CODEX_CLIENT_VERSION);
}
