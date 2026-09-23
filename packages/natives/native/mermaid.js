import { loadNative } from "./loader-state.js";

/** Render Mermaid text, loading the native addon on first use. */
export function renderMermaidAscii(text, options) {
	return loadNative().renderMermaidAscii(text, options);
}
