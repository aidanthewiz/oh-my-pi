import { afterEach, describe, expect, it, vi } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";
import { desktopEscapeStops, forgetDesktopEscapeStops } from "../native/desktop.js";
import * as loaderState from "../native/loader-state.js";

describe("desktop native ABI requirements", () => {
	it.each([
		["missing desktop export", undefined],
		[
			"legacy execute ABI",
			class {
				execute() {}
			},
		],
		[
			"pre-zoom ABI",
			class {
				click() {}
				cancel() {}
			},
		],
		[
			"uncancellable ABI",
			class {
				click() {}
				captureRegion() {}
			},
		],
	])("defers rejection of %s until desktop use without constructing the addon", (_label, NativeSession) => {
		// Importing the shared native module must remain safe for non-desktop tools.
		const DesktopSession = adaptDesktopSession(NativeSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow(/^Unsupported:/);
	});

	it("rejects the pre-screen-state ABI before opening a native desktop session", () => {
		let opened = false;
		class PriorDesktopSession {
			constructor() {
				opened = true;
			}
			click() {}
			capture() {}
			captureRegion() {}
			cancel() {}
			retire() {}
			setRunDeadline() {}
			get escapeStops() {
				throw new Error("Native Escape state requires an instance");
			}
			observe() {}
			listApplications() {}
			openApplication() {}
			menuItems() {}
			menuSelect() {}
			holdKeys() {}
			holdMouse() {}
			acquireControl() {}
			releaseControl() {}
			controlState() {}
			bringToCurrentSpace() {}
			axSelectText() {}
			axType() {}
			axKeyChord() {}
			holdDisplayUntilReleased() {}
			releaseDisplayAwake() {}
		}
		const DesktopSession = adaptDesktopSession(PriorDesktopSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow(/Unsupported:.*screenState/);
		expect(opened).toBe(false);
	});

	it("validates the current ABI without reading native state or opening a desktop session", () => {
		let opened = false;
		let reads = 0;
		class CurrentDesktopSession {
			constructor() {
				opened = true;
			}
			get screenState() {
				reads++;
				throw new Error("Native screen state requires an instance");
			}
			get escapeStops() {
				reads++;
				throw new Error("Native Escape state requires an instance");
			}
			click() {}
			capture() {}
			captureRegion() {}
			cancel() {}
			retire() {}
			setRunDeadline() {}
			observe() {}
			listApplications() {}
			openApplication() {}
			menuItems() {}
			menuSelect() {}
			holdKeys() {}
			holdMouse() {}
			acquireControl() {}
			releaseControl() {}
			controlState() {}
			bringToCurrentSpace() {}
			axSelectText() {}
			axType() {}
			axKeyChord() {}
			holdDisplayUntilReleased() {}
			releaseDisplayAwake() {}
		}
		expect<unknown>(adaptDesktopSession(CurrentDesktopSession)).toBe(CurrentDesktopSession);
		expect(reads).toBe(0);
		expect(opened).toBe(false);
	});

	it.each([
		"holdDisplayUntilReleased",
		"releaseDisplayAwake",
		"setRunDeadline",
		"axSelectText",
		"axType",
		"axKeyChord",
	] as const)("rejects an addon without %s before opening a native desktop session", method => {
		let opened = false;
		class PriorDesktopSession {
			constructor() {
				opened = true;
			}
			get screenState() {
				throw new Error("Native screen state requires an instance");
			}
			get escapeStops() {
				throw new Error("Native Escape state requires an instance");
			}
			click() {}
			capture() {}
			captureRegion() {}
			cancel() {}
			retire() {}
			setRunDeadline() {}
			observe() {}
			listApplications() {}
			openApplication() {}
			menuItems() {}
			menuSelect() {}
			holdKeys() {}
			holdMouse() {}
			acquireControl() {}
			releaseControl() {}
			controlState() {}
			bringToCurrentSpace() {}
			axSelectText() {}
			axType() {}
			axKeyChord() {}
			holdDisplayUntilReleased() {}
			releaseDisplayAwake() {}
		}
		Reflect.deleteProperty(PriorDesktopSession.prototype, method);
		const DesktopSession = adaptDesktopSession(PriorDesktopSession);
		expect(() => new DesktopSession({ display: "active" })).toThrow(/^Unsupported:/);
		expect(opened).toBe(false);
	});
	it("rejects an addon built before the Escape stop count", () => {
		// Every method present, so only the getter can decide; without it the worker reads each run as stopped.
		const prototype = (escapeStops: boolean) =>
			new Proxy(
				{},
				{
					get: () => () => {},
					has: (_target, key) => escapeStops || key !== "escapeStops",
					getOwnPropertyDescriptor: (_target, key) =>
						key === "screenState" ? { configurable: true, get: () => undefined } : undefined,
				},
			);
		const Current = { prototype: prototype(true) };
		expect<unknown>(adaptDesktopSession(Current)).toBe(Current);
		const Stale = adaptDesktopSession({ prototype: prototype(false) });
		expect(() => new Stale({ display: "active" })).toThrow(/^Unsupported: .*\(missing escapeStops\)/);
	});
});

describe("lazy desktop exports", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("report a stale addon's missing Escape exports with the stale-addon stub", () => {
		// A workspace addon built before the Escape exports, which the loader tolerates as stale.
		const missingNativeExport = loaderState.missingNativeExport;
		const stale = {
			path: "/w/packages/natives/native/pi_natives.darwin-arm64.node",
			version: "18.8.7",
			packageVersion: "18.12.1",
			stale: true,
		};
		vi.spyOn(loaderState, "loadNative").mockReturnValue({});
		vi.spyOn(loaderState, "missingNativeExport").mockImplementation(name => missingNativeExport(name, stale));
		for (const [name, call] of [
			["desktopEscapeStops", () => desktopEscapeStops("k")],
			["forgetDesktopEscapeStops", () => forgetDesktopEscapeStops("k")],
		] as const) {
			expect(call).toThrow(`\`${name}\` is missing`);
			expect(call).toThrow("bun run build:native");
		}
	});
});
