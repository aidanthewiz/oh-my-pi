import type { MermaidRenderOptions } from "./index.js";

export type { MermaidRenderOptions } from "./index.js";

/** Render Mermaid text, loading the native addon on first use. */
export declare function renderMermaidAscii(text: string, options?: MermaidRenderOptions | null): string;
