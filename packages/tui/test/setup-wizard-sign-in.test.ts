import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { AuthStorage, getOAuthProviders, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks, OAuthProviderId, OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { providersSetupScene, SignInScene } from "@oh-my-pi/pi-tui/setup/scenes/sign-in";
import type { SetupHost, SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { Input } from "@oh-my-pi/pi-tui/components/input";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SetupWizardComponent } from "@oh-my-pi/pi-tui/setup/wizard-overlay";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

type Login = (provider: OAuthProviderId, callbacks: OAuthLoginCallbacks) => Promise<void>;

/** A scene host over a credential store where a finished `login` signs the provider in. */
function sceneHost(login: Login) {
	const signedIn = new Set<string>();
	const state = {
		focus: undefined as (Component & { pasteText?(text: string): void }) | undefined,
		finished: [] as string[],
		refreshed: [] as string[],
		copied: [] as string[],
		opened: [] as string[],
		signedIn,
		restores: 0,
		/** Settles when the scene hands focus back (the login dialog closed). */
		restored: Promise.withResolvers<void>(),
	};
	const authStorage = {
		credentials: { has: (id: string) => signedIn.has(id) },
		keys: { source: (id: string) => (signedIn.has(id) ? { kind: "oauth" } : undefined) },
		oauth: {
			async login(provider: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
				await login(provider, callbacks);
				signedIn.add(provider);
			},
		},
	} as unknown as AuthStorage;
	const host = {
		ctx: {
			authStorage,
			disabledProviders: [],
			copyToClipboard: async (text: string) => {
				state.copied.push(text);
			},
			refreshProvider: async (provider: string) => {
				state.refreshed.push(provider);
			},
			captureBrowserSession: async () => "",
			openInBrowser(url: string): void {
				state.opened.push(url);
			},
		},
		requestRender(): void {},
		finish(result: string): void {
			state.finished.push(result);
		},
		setFocus(component: Component | null): void {
			state.focus = component ?? undefined;
		},
		restoreFocus(): void {
			state.restores++;
			state.focus = undefined;
			state.restored.resolve();
		},
	} as unknown as SetupSceneHost;
	return { host, state };
}

/** The provider sheet the scene presents, or undefined while the login dialog is up. */
function providerSheet(scene: SignInScene): { props: TspPickerProps; owner: Component } | undefined {
	const owner = scene.describe(pickerCx).c?.[0];
	if (!owner || !("render" in owner) || !owner.describe) return undefined;
	const picker = (owner.describe(pickerCx)?.c?.[0] as NativeNode | undefined) ?? undefined;
	if (picker?.k !== "picker") return undefined;
	return { props: picker.p as TspPickerProps, owner };
}

function signInTo(scene: SignInScene, provider: string): void {
	for (const char of provider) scene.handleInput(char);
	scene.handleInput("\r");
}

describe("SignInScene", () => {
	it("preserves the complete authorization target and pending answer when the focused dialog copies it", async () => {
		const url = `https://example.com/oauth/authorize?state=${"a".repeat(96)}&code_challenge_method=S256`;
		const answered = Promise.withResolvers<string>();
		const { host, state } = sceneHost(async (_provider, callbacks) => {
			callbacks.onAuth({ url, launchUrl: "http://127.0.0.1:1455/short" });
			answered.resolve(await callbacks.onPrompt({ message: "Authorization code" }));
			callbacks.signal?.throwIfAborted();
		});
		const scene = new SignInScene(host);
		try {
			signInTo(scene, "anthropic");
			const clipped = scene.render(36, 8);
			const targets = [...clipped.join("\n").matchAll(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)].map(
				match => match[1],
			);
			expect(targets).toContain(url);
			expect(targets.every(target => target === url)).toBe(true);
			expect(state.opened).toEqual([url]);
			expect(state.copied).toEqual([url]);
			expect(state.focus).toBeInstanceOf(LoginDialogComponent);
			state.focus!.pasteText!("before-");
			state.focus!.handleInput!("c");
			state.focus!.handleInput!("\x1bc");
			expect(state.copied).toEqual([url, url]);
			state.focus!.pasteText!("-after");
			state.focus!.handleInput!("\r");
			await expect(answered.promise).resolves.toBe("before-c-after");
			await state.restored.promise;
		} finally {
			state.focus?.handleInput?.("\x1b");
			scene.dispose();
			for (let tick = 0; tick < 8; tick++) await Promise.resolve();
		}
	});

	it("exposes clipboard rejection without settling or editing the pending answer", async () => {
		const url = "https://example.com/oauth/authorize?state=copy-error";
		const answered = Promise.withResolvers<string>();
		let submitted = false;
		const attempts: string[] = [];
		const { host, state } = sceneHost(async (_provider, callbacks) => {
			callbacks.onAuth({ url });
			const value = await callbacks.onPrompt({ message: "Authorization code" });
			callbacks.signal?.throwIfAborted();
			submitted = true;
			answered.resolve(value);
		});
		host.ctx.copyToClipboard = async text => {
			attempts.push(text);
			throw new Error("synthetic clipboard unavailable");
		};
		const scene = new SignInScene(host);
		try {
			signInTo(scene, "anthropic");
			const dialog = state.focus!;
			dialog.pasteText!("keep");
			for (let tick = 0; tick < 8; tick++) await Promise.resolve();
			dialog.handleInput!("\x1bc");
			for (let tick = 0; tick < 8; tick++) await Promise.resolve();
			expect(attempts).toEqual([url, url]);
			expect(submitted).toBe(false);
			const failure = scene
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			dialog.pasteText!("-answer");
			dialog.handleInput!("\r");
			await expect(answered.promise).resolves.toBe("keep-answer");
			await state.restored.promise;
			expect(failure).toContain("synthetic clipboard unavailable");
		} finally {
			state.focus?.handleInput?.("\x1b");
			scene.dispose();
			for (let tick = 0; tick < 8; tick++) await Promise.resolve();
		}
	});

	it("settles a pending secret prompt on disposal without credentials, refresh, or restored focus", async () => {
		let settled = false;
		const { host, state } = sceneHost(async (_provider, callbacks) => {
			try {
				await callbacks.onPrompt({ message: "Synthetic secret", secret: true });
				callbacks.signal?.throwIfAborted();
			} finally {
				settled = true;
			}
		});
		const scene = new SignInScene(host);
		signInTo(scene, "anthropic");
		const dialog = state.focus as LoginDialogComponent;
		try {
			expect(dialog).toBeInstanceOf(LoginDialogComponent);
			dialog.pasteText("synthetic-secret");
			scene.dispose();
			scene.dispose();
			for (let tick = 0; tick < 8; tick++) await Promise.resolve();
			expect(settled).toBe(true);
			expect(dialog.signal.aborted).toBe(true);
			expect([...state.signedIn]).toEqual([]);
			expect(state.refreshed).toEqual([]);
			expect(state.restores).toBe(0);
			expect(state.finished).toEqual([]);
		} finally {
			dialog.handleInput("\x1b");
			scene.dispose();
			for (let tick = 0; tick < 8; tick++) await Promise.resolve();
		}
	});

	for (const kind of ["prompt", "manual"] as const) {
		it(`rejects detached ${kind} input after scene disposal`, async () => {
			const loginGate = Promise.withResolvers<void>();
			const { host, state } = sceneHost(async (_provider, callbacks) => {
				callbacks.onAuth({ url: "https://example.com/oauth/authorize?state=disposed" });
				await loginGate.promise;
				callbacks.signal?.throwIfAborted();
			});
			const scene = new SignInScene(host);
			signInTo(scene, "anthropic");
			const dialog = state.focus as LoginDialogComponent;
			let outcome: "pending" | "resolved" | "rejected" = "pending";
			try {
				scene.dispose();
				const input =
					kind === "prompt"
						? dialog.showPrompt({ message: "Detached prompt" })
						: dialog.showManualInput("Detached manual input");
				const observed = input.then(
					() => {
						outcome = "resolved";
					},
					() => {
						outcome = "rejected";
					},
				);
				for (let tick = 0; tick < 8; tick++) await Promise.resolve();
				expect<string>(outcome).toBe("rejected");
				await observed;
				expect([...state.signedIn]).toEqual([]);
				expect(state.refreshed).toEqual([]);
				expect(state.restores).toBe(0);
			} finally {
				dialog.handleInput("\x1b");
				loginGate.resolve();
				scene.dispose();
				for (let tick = 0; tick < 8; tick++) await Promise.resolve();
			}
		});
	}

	it("returns from pending manual entry when the browser callback completes without submitting the draft", async () => {
		const callbackDone = Promise.withResolvers<void>();
		const manualReady = Promise.withResolvers<void>();
		const settled = new AbortController();
		let submitted: string | undefined;
		const { host, state } = sceneHost(async (_provider, callbacks) => {
			callbacks.onAuth({ url: "https://example.com/oauth/authorize?state=callback" });
			const manual = callbacks.onManualCodeInput!(settled.signal).then(value => {
				submitted = value;
			});
			manualReady.resolve();
			await callbackDone.promise;
			settled.abort(new Error("browser callback completed"));
			await manual.catch(() => {});
		});
		const scene = new SignInScene(host);
		try {
			signInTo(scene, "anthropic");
			await manualReady.promise;
			state.focus?.pasteText?.("unused-manual-draft");
			callbackDone.resolve();
			await state.restored.promise;
			expect(submitted).toBeUndefined();
			expect(state.focus).toBeUndefined();
			expect(providerSheet(scene)?.props.selected).toBe("anthropic");
			expect(state.refreshed).toEqual(["anthropic"]);
		} finally {
			callbackDone.resolve();
			settled.abort();
			scene.dispose();
		}
	});

	it("Enter on a provider starts its login in the focused dialog; paste reaches the masked field", async () => {
		const secret = `sk-${crypto.randomUUID()}`;
		const answered = Promise.withResolvers<string>();
		const providers: string[] = [];
		const { host, state } = sceneHost(async (provider, callbacks) => {
			providers.push(provider);
			callbacks.onAuth({ url: "https://example.com/oauth/authorize?state=paste" });
			answered.resolve(await callbacks.onPrompt({ message: "Consumer key", secret: true }));
		});
		const scene = new SignInScene(host);
		try {
			signInTo(scene, "anthropic");
			expect(providers).toEqual(["anthropic"]);
			expect(providerSheet(scene)).toBeUndefined();
			// Enhanced paste targets the focused component's `pasteText`.
			state.focus?.pasteText?.(secret);
			expect(scene.render(120).join("\n")).not.toContain(secret);
			state.focus?.handleInput?.("\r");
			await expect(answered.promise).resolves.toBe(secret);
		} finally {
			scene.dispose();
		}
	});

	it("a successful login refreshes the provider and returns to its now signed-in row", async () => {
		const { host, state } = sceneHost(async (_provider, callbacks) => {
			callbacks.onAuth({ url: "https://example.com/oauth/authorize?state=ok" });
		});
		const scene = new SignInScene(host);
		try {
			expect(providerSheet(scene)?.props.items?.find(item => item.id === "anthropic")?.dot).toBe("muted");
			signInTo(scene, "anthropic");
			await state.restored.promise;
			expect(state.refreshed).toEqual(["anthropic"]);
			expect(state.focus).toBeUndefined();
			const sheet = providerSheet(scene)!;
			expect(sheet.props.selected).toBe("anthropic");
			expect(sheet.props.items?.find(item => item.id === "anthropic")?.dot).toBe("success");
		} finally {
			scene.dispose();
		}
	});

	it("Esc in the login dialog aborts the flow and returns to the list without an error", async () => {
		const aborted = Promise.withResolvers<void>();
		const { host, state } = sceneHost(async (_provider, callbacks) => {
			callbacks.onAuth({ url: "https://example.com/oauth/authorize?state=cancel" });
			const pending = Promise.withResolvers<void>();
			callbacks.signal?.addEventListener("abort", () => pending.reject(new Error("Login cancelled")));
			try {
				await pending.promise;
			} finally {
				aborted.resolve();
			}
		});
		const scene = new SignInScene(host);
		try {
			signInTo(scene, "anthropic");
			state.focus?.handleInput?.("\x1b");
			expect(state.focus).toBeUndefined();
			// The aborted flow settles after the list is back; drain its rejection before reading the sheet.
			await aborted.promise;
			for (let tick = 0; tick < 5; tick++) await Promise.resolve();
			expect(providerSheet(scene)?.props.strip).toBeUndefined();
			expect(state.refreshed).toEqual([]);
		} finally {
			scene.dispose();
		}
	});

	it("a failed login returns to the list with the error on the sheet", async () => {
		const { host, state } = sceneHost(async () => {
			throw new Error("token exchange failed");
		});
		const scene = new SignInScene(host);
		try {
			signInTo(scene, "anthropic");
			await state.restored.promise;
			expect(JSON.stringify(providerSheet(scene)?.props.strip?.label)).toContain("token exchange failed");
		} finally {
			scene.dispose();
		}
	});

	it("the sheet's skip action and Esc on the list leave the step", () => {
		const { host, state } = sceneHost(async () => {});
		const pointer = new SignInScene(host);
		const sheet = providerSheet(pointer)!;
		const skip = sheet.props.actions?.find(action => action.keys?.includes("esc"));
		expect(skip?.id).toBe("skip");
		sheet.owner.handleNativeEvent?.({ type: "action", key: "^picker", act: skip!.id, mods: [] });
		const keyboard = new SignInScene(host);
		keyboard.handleInput("\x1b");
		expect(state.finished).toEqual(["skipped", "skipped"]);
	});
});

async function mountPaidSignIn(managed = true, providerId = "inception") {
	const provider = getOAuthProviders().find(entry => entry.id === providerId);
	if (!provider) throw new Error("expected login provider");
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await storage.credentials.reload();
	const policy: {
		providers: readonly OAuthProviderInfo[] | undefined;
		disabled: string[];
		error: Error | undefined;
	} = { providers: managed ? [{ ...provider, available: true }] : undefined, disabled: [], error: undefined };
	const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
	const fetchHandler = Object.assign(
		async (url: string | Request | URL, init?: RequestInit) => {
			requests.push({ url: String(url), init });
			return Response.json({});
		},
		{ preconnect: fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchHandler);
	const login = vi.spyOn(storage.oauth, "login");
	const prompted = Promise.withResolvers<void>();
	let focused: Component | undefined;
	const openInBrowser = vi.fn((_url: string) => {});
	const host = {
		ctx: {
			authStorage: storage,
			get oauthProviders() {
				if (policy.error) throw policy.error;
				return policy.providers;
			},
			get disabledProviders() {
				return policy.disabled;
			},
			copyToClipboard: async (_text: string) => {},
			refreshProvider: async (_providerId: string) => {},
			openInBrowser,
		},
		requestRender() {},
		finish() {},
		setFocus(component: Component | null) {
			focused = component ?? undefined;
			if (focused) prompted.resolve();
		},
		restoreFocus() {},
	} as unknown as SetupSceneHost;
	const scene = new SignInScene(host);
	return {
		scene,
		storage,
		policy,
		requests,
		login,
		openInBrowser,
		prompted: prompted.promise,
		start() {
			for (const char of provider.id) scene.handleInput(char);
			scene.handleInput("\n");
		},
		enterKey() {
			if (!focused?.handleInput) throw new Error("expected focused credential input");
			focused.handleInput("setup-synthetic-inception-key");
			focused.handleInput("\n");
		},
		result() {
			const result = login.mock.results[0];
			if (!result || result.type !== "return") throw new Error("expected actual login attempt");
			return result.value;
		},
		async close() {
			scene.dispose();
			await storage.close();
		},
	};
}

describe("setup paid login admission", () => {
	it("rejects a removed provider from a previously rendered roster before login or browser dispatch", async () => {
		const harness = await mountPaidSignIn();
		try {
			harness.policy.providers = [];
			harness.start();
			expect(harness.login).not.toHaveBeenCalled();
			expect(harness.openInBrowser).not.toHaveBeenCalled();
			expect(harness.requests).toEqual([]);
			expect(harness.storage.credentials.list("inception")).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it("denies a selected login alias when its credential provider becomes disabled", async () => {
		const harness = await mountPaidSignIn(true, "openai-codex-device");
		try {
			harness.policy.disabled.push("openai-codex");
			harness.start();
			expect(harness.login).not.toHaveBeenCalled();
			expect(harness.openInBrowser).not.toHaveBeenCalled();
			expect(harness.requests).toEqual([]);
			expect(harness.storage.credentials.list("openai-codex")).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it("refuses removed, unavailable, and throwing managed rosters after delayed credential entry", async () => {
		for (const mode of ["removed", "unavailable", "throwing"] as const) {
			const harness = await mountPaidSignIn();
			try {
				harness.start();
				await harness.prompted;
				if (mode === "throwing") harness.policy.error = new Error("policy unavailable");
				else harness.policy.providers = mode === "removed" ? [] : undefined;
				harness.enterKey();
				await expect(harness.result()).rejects.toThrow();
				expect(harness.requests).toEqual([]);
				expect(harness.storage.credentials.list("inception")).toEqual([]);
			} finally {
				await harness.close();
				vi.restoreAllMocks();
			}
		}
	});

	it("refuses a provider disabled while credential input waits without validating or saving the key", async () => {
		const harness = await mountPaidSignIn();
		try {
			harness.start();
			await harness.prompted;
			harness.policy.disabled.push("inception");
			harness.enterKey();
			await expect(harness.result()).rejects.toThrow();
			expect(harness.requests).toEqual([]);
			expect(harness.storage.credentials.list("inception")).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it("preserves explicit unmanaged login when the host never supplies a roster", async () => {
		const harness = await mountPaidSignIn(false);
		try {
			harness.start();
			await harness.prompted;
			harness.enterKey();
			await harness.result();
			expect(harness.requests).toHaveLength(1);
			expect(harness.requests[0].url).toBe("https://api.inceptionlabs.ai/v1/chat/completions");
			expect(JSON.parse(String(harness.requests[0].init?.body))).toMatchObject({
				model: "mercury-3",
				max_completion_tokens: 1,
			});
			expect(harness.storage.credentials.list("inception")).toMatchObject([
				{ credential: { type: "api_key", key: "setup-synthetic-inception-key" } },
			]);
		} finally {
			await harness.close();
		}
	});
});

class SignInTerminal extends VirtualTerminal {
	cursorVisible = false;
	#writes: string[] = [];

	override write(data: string): void {
		this.#writes.push(data);
		for (const match of data.matchAll(/\x1b\[\?25([hl])/g)) {
			this.cursorVisible = match[1] === "h";
		}
		super.write(data);
	}

	takeWrites(): string {
		const result = this.#writes.join("");
		this.#writes.length = 0;
		return result;
	}
}

describe("fullscreen setup sign-in cursor", () => {
	for (const hardware of [true, false]) {
		it(`keeps the real prompt glyph and restores focus with hardware cursor ${hardware ? "on" : "off"}`, async () => {
			const terminal = new SignInTerminal(100, 32);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, hardware, { renderScheduler: scheduler });
			const base = new Input();
			base.setValue("restored");
			tui.addChild(base);
			tui.setFocus(base);
			const cancelled = Promise.withResolvers<void>();
			const copied: string[] = [];
			const authStorage = {
				credentials: { has: (_providerId: string) => false },
				keys: { source: (_providerId: string) => undefined },
				oauth: {
					async login(_provider: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
						try {
							callbacks.onAuth({ url: "https://example.com/offline-login" });
							await callbacks.onPrompt({ message: "Authorization code" });
							callbacks.signal?.throwIfAborted();
						} finally {
							cancelled.resolve();
						}
					},
				},
			} as unknown as AuthStorage;
			const host = {
				ui: tui,
				authStorage,
				disabledProviders: [],
				copyToClipboard: async (text: string) => {
					copied.push(text);
				},
				refreshProvider: async () => {},
				openInBrowser(): void {},
			} as unknown as SetupHost;
			const wizard = new SetupWizardComponent(host, [providersSetupScene]);
			tui.start();
			await scheduler.settle(terminal);
			const normalCursor = terminal.getCursor();
			const overlay = tui.showOverlay(wizard, {
				fullscreen: true,
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				margin: 0,
			});
			try {
				void wizard.run();
				terminal.sendInput("\r");
				// Reuse the wizard tests' clock-based dissolve skip, not a wall-clock sleep.
				const afterDissolve = performance.now() + 1000;
				vi.spyOn(performance, "now").mockReturnValue(afterDissolve);
				await scheduler.settle(terminal);
				for (const char of "anthropic") terminal.sendInput(char);
				terminal.sendInput("\r");
				await scheduler.settle(terminal);
				const prompt = tui.getFocused();
				expect(prompt).not.toBe(wizard);
				expect(wizard.ownsOverlayFocusTarget(prompt!)).toBe(true);

				terminal.sendInput("abcd");
				terminal.sendInput("\x1bc");
				expect(copied).toEqual(["https://example.com/offline-login", "https://example.com/offline-login"]);
				await scheduler.settle(terminal);
				const atEnd = terminal.getCursor();
				terminal.sendInput("\x1b[D");
				await scheduler.settle(terminal);
				const beforeMove = tui.getDebugPaint()?.lines;
				terminal.takeWrites();
				terminal.sendInput("\x1b[D");
				await scheduler.settle(terminal);
				const movement = terminal.takeWrites();
				const caret = { row: atEnd.row, col: atEnd.col - 2 };
				expect(terminal.getCursor()).toEqual(caret);
				const row = terminal.getViewport()[caret.row]!;
				expect(row).toContain("abcd");
				expect(row[caret.col]).toBe("c");
				expect(tui.getDebugPaint()).toMatchObject({
					altScreen: true,
					cursor: { x: caret.col, y: caret.row, visible: hardware },
				});
				expect(terminal.cursorVisible).toBe(hardware);
				const paintedRow = tui.getDebugPaint()!.lines[caret.row]!;
				if (hardware) {
					expect(paintedRow).not.toContain("\x1b[7m");
					expect(tui.getDebugPaint()?.lines).toEqual(beforeMove);
					expect([...movement.matchAll(/\x1b\[(\d+);1H/g)]).toEqual([]);
				} else {
					expect(paintedRow).toContain("\x1b[7mc\x1b[27m");
					expect(movement).not.toContain("\x1b[?25h");
				}

				terminal.sendInput("\x1b");
				await cancelled.promise;
				await Promise.resolve();
				await scheduler.settle(terminal);
				expect(tui.getFocused()).toBe(wizard);
				expect(terminal.cursorVisible).toBe(false);
				expect(tui.getDebugPaint()?.cursor).toBeUndefined();
				expect(terminal.getViewport().join("\n")).not.toContain("Authorization code");
				overlay.hide();
				await scheduler.settle(terminal);
				expect(tui.getFocused()).toBe(base);
				expect(base.focused).toBe(true);
				expect(terminal.cursorVisible).toBe(hardware);
				expect(terminal.getCursor()).toEqual(normalCursor);
				terminal.sendInput("!");
				await scheduler.settle(terminal);
				expect(base.getValue()).toBe("restored!");
			} finally {
				tui.getFocused()?.handleInput?.("\x1b");
				wizard.dispose();
				overlay.hide();
				tui.stop();
				scheduler.reset();
				for (let tick = 0; tick < 8; tick++) await Promise.resolve();
			}
		});
	}
});
