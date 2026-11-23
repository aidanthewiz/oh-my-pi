# @oh-my-pi/browser-relay

The **Coreforge Browser Relay** extension puts Coreforge in the Chrome side panel and lets Eval's `browser` API drive **your existing Chrome tabs**, including signed-in sessions, without relaunching Chrome with remote debugging.

The extension's native host owns the relay. It binds an OS-assigned loopback port, publishes it for local terminal clients and translates CDP to `chrome.debugger`. Sidebar chats use their own native messaging port and per-chat loopback endpoint. An existing terminal session joined through collab retains its browser configuration.

## Setup

1. Run `coreforge browser-relay install` to write the extension and register the Coreforge native host. By default it prints manual Chrome setup instructions; it does not register a profile or restart Chrome. Load the printed directory through `chrome://extensions` → Developer mode → **Load unpacked**. Use `--chrome` only when you explicitly want profile registration and any required browser restart; `--profile <name>` selects that profile.
2. Click Coreforge in the toolbar, or press Cmd+E (Ctrl+E elsewhere), to open the panel. Start a session in a directory or attach to a terminal session hosting a collab room. The panel supports screenshots, element picks, Teach and scheduled shortcuts. A panel-owned session drives that Chrome, including its subagents; it does not start another browser.
3. To drive Chrome from a terminal session, opt in:
   - **Per call** — pass `app: "relay"` to `browser.open(...)` in Eval. Works without any setting and persists nothing: the configured default for every other call and session stays whatever it already was.
   - **As the default** — `coreforge config set browser.relay true` makes the relay the default for **every top-level session using this profile, in every project** (project-level settings, `PI_BROWSER_RELAY`, and an explicit `app` choice still take precedence). Any such session's ordinary `browser.open(...)` call will then drive your real browser, including `coreforge -p` runs and other background sessions you aren't watching; without `target` such a call opens its own background tab in your logged-in profile. Subagents skip the default (and `PI_BROWSER_RELAY=1`) and reach the relay only with `app: "relay"`.

Nothing needs starting separately: the native host serves the relay while its extension port is open. The old client-started daemon and standalone `--port`/`--token` interface are not retained.

Relay clients and the native host use a profile-local token file with mode `0600` in a `0700` directory. The token is not embedded in extension assets. Forwarding a relay port to another machine also requires its token in the explicitly configured relay URL; reaching the port alone does not authorize control.

`target` borrows a tab by target ID or URL/title substring. Without it, Coreforge opens its own background tab without selecting it. Releasing a managed tab closes only pages Coreforge created; borrowed pages remain open. Driven tabs join a per-window **coreforge** group (cyan); released tabs and user-owned groups are left alone.

Reconnects can select another connected browser. Do not assume it has the same signed-in account; confirm the destination before consequential actions.

### Updates

The registry records each installed extension folder. Explicit `coreforge browser-relay sync`, installation, a verified Coreforge binary update and startup after a version/build change refresh registered folders. The relay reloads an idle extension when its running build differs from the installed folder. Newer installed files are not downgraded by an older relay. Chrome keeps the folder-derived extension ID, settings and file-URL permission.

Register a custom folder once with `coreforge browser-relay install --dir <folder>`. A newer client may request a native-host restart; the request is authenticated, bound to the probed relay instance and refuses an idle-only restart while a client uses it.

## Development

- `bun run build` bundles `dist/extension/`, the Coreforge release ZIP and `packages/coding-agent/src/tools/browser/relay/extension.generated.json`.
- `bun run gen:embedded` refreshes only the generated embedded assets. Regenerate after extension edits; source and compiled installs use this complete bundle.
- `bun scripts/smoke.ts [relay-url] [target-substring]` exercises supervisor/worker connections against a relay. Use a disposable, owned page: the smoke navigates and modifies its selected target.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Chrome refuses debugging while another extension's frame, such as a password manager's inline menu, is present. On a driven tab, the relay may hide that frame and reports the affected extension/page; other tabs are unchanged.
- Extension, CDP, target-list and update/restart endpoints require the shared token. `/json/version` is public liveness metadata and never includes a tokenized WebSocket URL. The server binds loopback only.
