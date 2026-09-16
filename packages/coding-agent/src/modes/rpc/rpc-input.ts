import { readLines } from "@oh-my-pi/pi-utils";
export interface RpcInputTerminal {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?: (mode: boolean) => unknown;
}

/**
 * Disable terminal canonical input buffering for RPC transports. Canonical
 * PTYs cap one line before the process can read it, which can truncate a
 * valid JSON frame before the protocol's own size limit applies.
 */
export function configureRpcInputTerminal(stdin: RpcInputTerminal = process.stdin): () => void {
	if (!stdin.isTTY || typeof stdin.setRawMode !== "function" || stdin.isRaw) {
		return () => {};
	}
	stdin.setRawMode(true);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		stdin.setRawMode?.(false);
	};
}

/**
 * Claims Bun's singleton stdin reader immediately and exposes a separately readable stream.
 * RPC startup uses this before extension discovery so in-process modules cannot steal protocol input.
 */
export function claimRpcInput(): ReadableStream<Uint8Array> {
	const restoreTerminal = configureRpcInputTerminal();
	const reader = (() => {
		try {
			return Bun.stdin.stream().getReader();
		} catch (error) {
			restoreTerminal();
			throw error;
		}
	})();
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			reader.releaseLock();
		} catch {}
		restoreTerminal();
	};
	return new ReadableStream({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					release();
					controller.close();
				} else {
					controller.enqueue(result.value);
				}
			} catch (error) {
				release();
				controller.error(error);
			}
		},
		async cancel() {
			try {
				await reader.cancel();
			} finally {
				release();
			}
		},
	});
}

/**
 * Parses newline-delimited RPC input without letting one malformed line stop
 * subsequent protocol frames.
 */
export async function readRpcInputFrames(
	input: ReadableStream<Uint8Array>,
	onFrame: (frame: unknown) => void,
	onParseError: (message: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	for await (const line of readLines(input)) {
		const text = decoder.decode(line).trim();
		if (!text) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			onParseError(`Failed to parse command: ${message}`);
			continue;
		}
		onFrame(parsed);
	}
}
