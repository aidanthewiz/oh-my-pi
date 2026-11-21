# @oh-my-pi/browser-relay

Chrome extension that lets Coreforge's Eval `browser` API drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the Coreforge CLI (`coreforge browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream Puppeteer connections (Coreforge opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `coreforge browser-relay install` — creates a machine-local relay token, writes the bundled extension with that token, and saves it to `~/.omp/browser-relay/extension`; then load it via `chrome://extensions` → Developer mode → _Load unpacked_. (Or get `coreforge-browser-relay-extension.zip` from an authenticated Coreforce engine release and set the token in the extension options.)
2. Opt in, one of two ways:
   - **Per call** — pass `app: "relay"` to `browser.open(...)` in Eval. Works without any setting and persists nothing: the configured default for every other call and session stays whatever it already was.
   - **As the default** — `coreforge config set browser.relay true` makes the relay the default for **every top-level session using this profile, in every project** (project-level settings, `PI_BROWSER_RELAY`, and an explicit `app` choice still take precedence). Any such session's ordinary `browser.open(...)` call will then drive your real browser, including `coreforge -p` runs and other background sessions you aren't watching; without `target` such a call opens its own background tab in your logged-in profile. Subagents skip the default (and `PI_BROWSER_RELAY=1`) and reach the relay only with `app: "relay"`.

The relay server and extension share the token in `~/.omp/browser-relay/token`. The token file uses mode `0600`; its parent directory uses mode `0700`. Automatic relay startup uses this token. `coreforge browser-relay --token <secret>` replaces it only after the server binds successfully. After changing it, either set the same extension override, or clear the override, rerun `install`, and reload the extension.

The relay server auto-starts under Coreforge's profile-independent global daemon broker the first time Eval's browser API needs it. Every relay consumer holds a broker lease, so one project exiting cannot interrupt another. The server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `coreforge browser-relay` manually only for `--token`, `--no-group`, or a non-default port. A manually started relay is left to its owner; Coreforge can replace its own outdated daemon while no client uses it.

`target` borrows a specific tab by URL/title substring; without it, Coreforge opens its own tab in the background, leaving your selected tab and focus alone, and closes it when the managed tab closes. An older extension selects that tab instead; rerun `coreforge browser-relay install` and reload it. Reopening an open name keeps its tab. Tabs Coreforge actively drives join a per-window **"coreforge" tab group** (cyan); released tabs and user-owned groups stay alone. Disable with `coreforge browser-relay --no-group`.

New tabs prefer the browser Coreforge used last on this relay. If that browser disconnects, the relay waits up to 12 seconds for it to reconnect, then may select another connected browser. This does not guarantee the same signed-in account. Confirm the destination before consequential actions.

After a Coreforge upgrade, the relay updates an older extension only when Chrome loaded it from the owned installation directory, no client is connected, and no extension tab is attached. Chrome retains the extension id, settings, permissions and _Allow access to file URLs_ choice. For a custom `--dir`, run `coreforge browser-relay install` with that directory and click _Reload_ in `chrome://extensions`. A browser restart does not replace an older running worker. A relay open reports an outdated extension.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating Coreforge's supervisor and tab-worker double-connection pattern against a live relay.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Chrome refuses the debugger in a tab while another extension's frame, such as a password manager's inline menu, is in it. In a tab Coreforge drives, the extension empties and hides that frame so Coreforge can continue; your other tabs keep theirs. The call that encountered the frame, or a later call, names the extension and frame page.
- The relay requires the shared token for extension, CDP, and target-list connections. `/json/version` remains unauthenticated for liveness but never includes a tokenized WebSocket URL. The relay binds loopback only.
