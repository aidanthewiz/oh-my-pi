# @oh-my-pi/browser-relay

Chrome extension that lets the Coreforge `browser` tool drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the Coreforge CLI (`coreforge browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). It impersonates Chrome's CDP discovery endpoint, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream Puppeteer connections (Coreforge opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

1. `coreforge browser-relay install` — writes the bundled extension to `~/.omp/browser-relay/extension`, then load it via `chrome://extensions` → Developer mode → *Load unpacked*. (Or get `coreforge-browser-relay-extension.zip` from GitHub releases.)
2. `coreforge config set browser.relay true` — routes the browser tool through the relay. Per-call `app.relay: true` works without the setting.

The relay server starts automatically under Coreforge's profile-independent global daemon broker when the browser tool first needs it. Every relay consumer holds a broker lease, so one project exiting cannot interrupt another. The server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `coreforge browser-relay` manually only for `--token`, `--no-group`, or a non-default port. A relay already serving the port is adopted.

`app.target` picks a specific tab by URL/title substring. Without it, Coreforge adopts the visible tab without stealing focus. Tabs Coreforge actively drives are gathered into a per-window **"coreforge" tab group** (cyan). Coreforge releases each tab when done and dissolves the group on disconnect. Other tabs, pinned tabs, existing groups, and tabs you drag out remain unchanged. Disable grouping with `coreforge browser-relay --no-group`.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [target-substring]` — end-to-end smoke replicating Coreforge's supervisor and tab-worker double-connection pattern against a live relay.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- Anything that can reach the relay port can drive your logged-in browser. The relay binds loopback only; use `coreforge browser-relay --token <secret>` (mirrored in the extension options) if untrusted local processes are a concern.
