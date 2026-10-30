import { beforeAll, describe, expect, it } from "bun:test";
import { describedVisibility, type OutlineTarget } from "../src/chat/transcript-outline";
import { FramedMessageComponent } from "../src/chrome/message-frame";
import { ToolActivityContainer } from "../src/chrome/tool-activity";
import { col, node, row, text } from "../src/native/describe";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { initTheme } from "../src/theme";
import { Container, type Component } from "../src/tui";

const cx: DescribeContext = {
	cols: 60,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

function visibility(blocks: Component[]): boolean[] {
	const targets: OutlineTarget[] = blocks.map((_, index) => ({
		entryId: `entry-${index}`,
		turnId: `entry-${index}`,
		isUserTurn: false,
		start: index,
		end: index + 1,
		entries: [],
	}));
	return describedVisibility(blocks, targets, cx);
}

function framed(component: Component): Component {
	return new FramedMessageComponent({
		message: { customType: "synthetic", content: "" },
		role: "omp.test.custom",
		customRenderer: () => component,
	});
}

class PaintedContainer extends Container {
	override render(width: number): readonly string[] {
		return [`painted at ${width}`];
	}
}

describe("native transcript outline visibility", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("[TuiChat-outline-render-fallback] selects displayed custom messages without selecting empty descriptions", () => {
		const components = [
			framed({ render: () => ["visible sentinel"] }),
			framed({ render: () => ["null descriptor sentinel"], describe: () => null }),
			framed(new PaintedContainer()),
			framed({ render: () => ["   ", ""] }),
			framed({ render: () => ["unused paint"], describe: () => col([]) }),
		];
		try {
			expect(visibility(components)).toEqual([true, true, true, false, false]);
		} finally {
			for (const component of components) component.dispose?.();
		}
	});

	it("[TuiChat-outline-fallback-width] resolves fallback content at a minimum width of one", () => {
		const component: Component = { render: width => (width === 1 ? ["narrow sentinel"] : []) };
		const target: OutlineTarget = {
			entryId: "narrow",
			turnId: "narrow",
			isUserTurn: false,
			start: 0,
			end: 1,
			entries: [],
		};
		expect(describedVisibility([component], [target], { ...cx, cols: 0 })).toEqual([true]);
	});

	it("[TuiChat-outline-hidden-activity] removes hidden activity from selection and restores the same notice", () => {
		const notice: Component = {
			render: () => ["background completion"],
			describe: () => text("background completion"),
		};
		const activity = new ToolActivityContainer(notice);
		try {
			expect(visibility([activity])).toEqual([true]);
			activity.setToolActivityVisible(false);
			expect(activity.render(60)).toEqual([]);
			expect(visibility([activity])).toEqual([false]);
			activity.setToolActivityVisible(true);
			expect(activity.render(60)).toEqual(["background completion"]);
			expect(visibility([activity])).toEqual([true]);
			activity.setToolActivityVisible(false);
			expect(visibility([activity])).toEqual([false]);
		} finally {
			activity.dispose();
		}
	});

	it("[TuiChat-outline-hidden-nodes] excludes hidden leaves, hidden ancestors and blank rows", () => {
		const descriptions: NativeNode[] = [
			text("hidden leaf", { hidden: true }),
			col([row([text("hidden descendant")], { hidden: true })]),
			col([text("visible descendant")]),
			node("rows", { cols: 60, lines: ["   ", ""] }),
			node("rows", { cols: 60, lines: ["visible rows"] }),
		];
		const components = descriptions.map(description => ({ render: () => [], describe: () => description }));
		expect(visibility(components)).toEqual([false, false, true, false, true]);
	});
});
