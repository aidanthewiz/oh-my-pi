import templateCss from "./template.css" with { type: "text" };
import templateHtml from "./template.html" with { type: "text" };
import templateJs from "./template.js" with { type: "text" };
import toolViewsJs from "./tool-views.generated.js" with { type: "text" };

let cachedTemplate: string | undefined;

/** Compose the standalone export template: minified CSS, tool renderers, and viewer JS inlined. */
export function getTemplate(): string {
	if (cachedTemplate) return cachedTemplate;
	const minifiedCss = templateCss
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([{}:;,])\s*/g, "$1")
		.trim();
	cachedTemplate = (templateHtml as unknown as string)
		.replace("<template-css/>", () => `<style>${minifiedCss}</style>`)
		.replace("<template-tool-views/>", () => `<script>${toolViewsJs}</script>`)
		.replace("<template-js/>", () => `<script>${templateJs}</script>`);
	return cachedTemplate;
}
