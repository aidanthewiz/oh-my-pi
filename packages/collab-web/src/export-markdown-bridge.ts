/** Supply the standalone transcript with the same parser bundled for tool cards. */
import { Marked } from "@oh-my-pi/pi-utils/marked";

declare global {
	var ompMarkdown: { Marked: typeof Marked };
}

globalThis.ompMarkdown = { Marked };

export { Marked };
