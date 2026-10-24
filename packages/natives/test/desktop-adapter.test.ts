import { describe, expect, it } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";

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
			click() {}
			capture() {}
			captureRegion() {}
			cancel() {}
			retire() {}
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
		}
		expect<unknown>(adaptDesktopSession(CurrentDesktopSession)).toBe(CurrentDesktopSession);
		expect(reads).toBe(0);
		expect(opened).toBe(false);
	});
});
