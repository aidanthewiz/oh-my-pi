# @oh-my-pi/browser-relay

Chrome extension that lets the Coreforge `browser` tool drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the Coreforge CLI (`coreforge browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream Puppeteer connections (Coreforge opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `coreforge browser-relay install` — creates a machine-local relay token, writes the bundled extension with that token, and saves it to `~/.omp/browser-relay/extension`; then load it via `chrome://extensions` → Developer mode → *Load unpacked*. (Or get `coreforge-browser-relay-extension.zip` from GitHub releases and set the token in the extension options.)
2. `coreforge config set browser.relay true` — routes the browser tool through the relay. Per-call `app.relay: true` works without the setting.

The relay server and extension share the token in `~/.omp/browser-relay/token`. The token file uses mode `0600`; its parent directory uses mode `0700`. Automatic relay startup uses this token. `coreforge browser-relay --token <secret>` replaces it only after the server binds successfully. After changing it, either set the same extension override, or clear the override, rerun `install`, and reload the extension.

The relay server starts automatically under Coreforge's profile-independent global daemon broker when the browser tool first needs it. Every relay consumer holds a broker lease, so one project exiting cannot interrupt another. The server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `coreforge browser-relay` manually only for `--token`, `--no-group`, or a non-default port. A relay already serving the port is adopted.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating Coreforge's supervisor and tab-worker double-connection pattern against a live relay.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- The relay requires the shared token for extension, CDP, and target-list connections. `/json/version` remains unauthenticated for liveness but never includes a tokenized WebSocket URL. The relay binds loopback only.
