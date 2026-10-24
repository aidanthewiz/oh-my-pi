import { describe, expect, it } from "bun:test";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { WidthAwareText } from "@oh-my-pi/pi-tui/render/width-aware-text";
import { truncateToWidth } from "../src/utils";

function makeCx(cols: number): DescribeContext {
	return {
		cols,
		reduceMotion: false,
		dark: true,
		supports: () => true,
		feature: () => false,
	};
}

/** The text a native surface would show for the component's inner `Text`. */
function describedText(component: WidthAwareText, cx: DescribeContext): string {
	const described = component.describe(cx);
	const child = described.c?.[0];
	const inner = child && "k" in child ? child : child?.describe?.(cx);
	const spans = inner?.k === "text" ? inner.p?.spans : undefined;
	return spans ? spans.map(span => span.t).join("") : "";
}

describe("WidthAwareText describe width budget", () => {
	it("re-describes at cx.cols after a render instead of reusing the render-time text", () => {
		const source = "0123456789".repeat(8);
		const component = new WidthAwareText(width => truncateToWidth(source, width), 1, 1);

		expect(describedText(component, makeCx(80))).toBe(source);
		component.render(80);
		expect(describedText(component, makeCx(80))).toBe(source);
	});
});
