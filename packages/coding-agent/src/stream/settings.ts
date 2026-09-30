/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

const EMPTY_STRING_ARRAY: string[] = [];

// Live streaming requires an explicitly configured server.
export const cfgStreamServerUrl = register({
	id: "stream.serverUrl",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Stream",
		label: "Stream Server",
		description: "Live stream server used by the configured stream command; no public server is selected by default",
	},
});

export const cfgStreamRedactPatterns = register({
	id: "stream.redactPatterns",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	ui: {
		tab: "interaction",
		group: "Stream",
		label: "Extra Redaction Patterns",
		description:
			"Additional regular expressions redacted from every streamed row, on top of env/secrets.yml values and built-in credential shapes",
	},
});
