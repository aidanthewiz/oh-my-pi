import type { FileDiagnosticsResult } from "@oh-my-pi/pi-tui/tools/lsp";
import type { ToolSession } from "../tools";
import { getToolConversationState } from "../tools/tool-state";
import { unreportedSummary } from "./diagnostics";
import { summarizeDiagnosticMessages } from "./utils";

const DIAGNOSTIC_LOCATION_PREFIX_RE = /^.*?:\d+:\d+\s+/;

export function diagnosticIdentity(message: string): string {
	return message.replace(DIAGNOSTIC_LOCATION_PREFIX_RE, "");
}

export class DiagnosticsLedger {
	readonly #seen = new Map<string, Set<string>>();

	reduce(absPath: string, result: FileDiagnosticsResult): FileDiagnosticsResult {
		const previous = this.#seen.get(absPath);
		const currentIdentities = new Set<string>();
		const fresh: string[] = [];

		for (const message of result.messages) {
			const identity = diagnosticIdentity(message);
			currentIdentities.add(identity);
			if (!previous?.has(identity)) {
				fresh.push(message);
			}
		}
		if (result.unreported?.length && previous) {
			for (const identity of previous) currentIdentities.add(identity);
		}

		if (currentIdentities.size === 0) {
			this.#seen.delete(absPath);
		} else {
			this.#seen.set(absPath, currentIdentities);
		}

		if (fresh.length === result.messages.length) {
			return result;
		}

		const summary = summarizeDiagnosticMessages(fresh);
		return {
			...result,
			messages: fresh,
			...summary,
			summary: result.unreported?.length
				? unreportedSummary(result.unreported, fresh.length > 0 ? summary.summary : undefined)
				: summary.summary,
		};
	}
}

export function getDiagnosticsLedger(session: ToolSession): DiagnosticsLedger {
	const state = getToolConversationState(session);
	state.diagnosticsLedger ??= new DiagnosticsLedger();
	return state.diagnosticsLedger;
}
