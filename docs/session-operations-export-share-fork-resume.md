# Session operations: export, transfer, share, fresh, clear, fork, and resume

This document describes operator-visible behavior for session export, sharing, conversation reset, lifecycle, fork, and resume operations as currently implemented.

## Implementation files

- [`src/slash-commands/builtin-collaboration.ts`](../packages/coding-agent/src/slash-commands/builtin-collaboration.ts) — export/dump/share command specs
- [`src/slash-commands/builtin-lifecycle.ts`](../packages/coding-agent/src/slash-commands/builtin-lifecycle.ts) — lifecycle command specs
- [`src/slash-commands/seance.ts`](../packages/coding-agent/src/slash-commands/seance.ts) — `/seance` command and session-picker adapter
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — TUI execution
- [`src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts) — resume/import picker and cwd transition
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`src/export/share.ts`](../packages/coding-agent/src/export/share.ts)
- [`src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`src/cli/flag-tables.ts`](../packages/coding-agent/src/cli/flag-tables.ts) — restart argument rewriting
- [`src/main.ts`](../packages/coding-agent/src/main.ts)

## Operation matrix

| Operation                               | Entry path                   | Session mutation                              | Session file creation/switch                                                               | Output artifact                                                                     |
| --------------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `/dump [all]`                           | Slash command (TUI/headless) | No                                            | No                                                                                         | Clipboard/command text plus best-effort temporary JSON sidecar; `all`: temp zip    |
| `/export [--themes] [path]`             | Slash command (TUI/headless) | No                                            | No                                                                                         | HTML file                                                                           |
| `--export <session.jsonl> [outputPath]` | CLI startup fast-path        | No runtime session mutation                   | No active session; reads target file                                                       | HTML file                                                                           |
| `/share`                                | Slash command (TUI/headless) | No                                            | No                                                                                         | Encrypted share link (gist or share server); temp HTML only for TUI custom handlers |
| `/new`                                  | Interactive slash command    | Yes (starts an empty conversation)            | Switches identity and materializes a new header in persistent mode                         | None                                                                                |
| `/fresh`                                | Slash command (TUI/headless) | Yes (provider-facing in-memory id/state only) | No; keeps current session file/header                                                      | None                                                                                |
| `/clear`                                | Interactive slash command    | Yes (clears live/model conversation context)  | Retains identity/file/history; a lazy session still follows the normal persistence gate    | Appends `reset_boundary`                                                            |
| `/delete`                               | Interactive slash command    | Yes (starts an empty conversation)            | Attempts to delete the current persisted session and artifacts, then switches to a lazy successor (no empty file until content) | None                                                                                |
| `/fork`                                 | Interactive slash command    | Normally yes; existing Tern pane specialization retains the parent | Forks in place, except the existing Tern pane flow | Copies artifacts according to the selected flow |
| `/fork pane`, `/fork window`, `/fork tab` | Interactive slash command  | No (parent session retained)                   | Opens a child OMP process from the flushed current transcript in a multiplexer pane/group (tmux window, Zellij/Herdr/Orca tab, or CMUX workspace) | Child receives a separate forked session                                            |
| `--fork <id\|path>`                     | CLI startup                  | Yes after session creation                    | Creates a new session fork from the selected source into current cwd/session dir           | Copies source artifacts recursively by default                                      |
| `/seance [id\|path] [--model sel]`      | Interactive slash command    | No (active session and model unchanged)       | Forks the source transcript into a read-only consultant subagent under the current session  | None; the consultant reads the source's artifacts in place                          |
| `/resume [id\|@claude\|@codex]`         | Interactive slash command    | Yes (active in-memory state replaced)         | Switches to a selected/matched session, or imports a selected foreign session              | None                                                                                |
| `--resume`                              | CLI startup picker           | Yes after session creation                    | Opens selected existing session file (picker opens in current-folder scope; the global list is preloaded only for the empty-everything early exit and instant Tab switching) | None                |
| `--resume <id\|path>`                   | CLI startup                  | Yes after session creation                    | Opens existing session; a missing recorded cwd may be re-rooted into the current directory | None                                                                                |
| `/restart` | Interactive slash command | Yes (process relaunches) | Keeps configuration flags; restores a materialized session (`--restore`), otherwise starts fresh | None |
| `--continue`                            | CLI startup                  | Yes after session creation                    | Opens terminal breadcrumb or most-recent session; creates new one if none exists           | None                                                                                |
| `--restore [id\|path]` | CLI startup | Yes after session creation | Resumes the selected session and restores unfinished turns and eligible subagent runs; interactive only | None |

## Export and dump

### `/export [--themes] [outputPath]` (slash command)

Flow:

1. The collaboration command spec (`src/slash-commands/builtin-collaboration.ts`) parses headless arguments with `parseExportArgs`; the TUI delegates to `CommandController.handleExportCommand`, which uses the same parser.
2. `--themes` selects the configured dark/light TUI themes instead of the standalone web palette. After removing that flag, at most one whitespace-delimited path is accepted; extra tokens produce `Usage: /export [--themes] [path]`.
3. `AgentSession.exportToHtml()` calls `exportSessionToHtml(sessionManager, state, { outputPath, palette, themeNames })`.
4. The TUI shows the path and opens the file in a browser. Headless command execution prints the path without opening it.

In the TUI, `/export` targets `viewSession`: a focused subagent exports its own
transcript and descendants, not the main session. `/dump` and `/share` still
target the main session.

Behavior details:

- `--copy`, `clipboard`, and `copy` arguments are explicitly rejected with a warning to use `/dump`.
- Export embeds session header/entries/leaf plus current `systemPrompt` and tool descriptions from agent state. `previousSessionFiles` is omitted from exported headers.
- The viewer uses the `/stats` design, with Auto/Light/Dark themes; Light uses soft-gray surfaces and high-contrast secondary text. The sidebar lists the main session, nested subagents, and advisors; selecting a session or a task-card agent opens its transcript and conversation tree. Session and message links preserve the selected transcript.
- Child transcripts stored next to the session file (`<session>/<AgentId>.jsonl`, recursively for nested spawns) are embedded as `subSessions`, including advisor and gzip-compressed transcripts. Discovery descends only into real child directories and flags tombstoned agents as `aborted`. `includeSubSessions: false` in `ExportOptions` excludes child transcripts and their trace tracks.
- The bottom **Timeline** drawer and **Trace** view reuse `/trace`'s span assembly and viewer: duration/turn/call axes, idle compression, search, zoom, nested tracks, entry details, and tool aggregates. **Jump to transcript** opens the corresponding session and message. All transcript and trace data remain embedded; no stats server is needed.
- Tool calls use `<omp-tool-view>` (shared with collab-web); traces use `<omp-session-trace>` (shared with stats). `bun gen:export-viewer` uses one local producer to bundle the shell, styles, default themes, Markdown, highlighting, and tool/trace renderers. Source, bundled, and compiled exports inline that generated viewer. Export does not fetch executable viewer dependencies from upstream services or upload viewer code or session data.
- `--themes` embeds the selected TUI theme overrides in addition to the session data.
- No session entries are appended during export.
- The default filename is `omp-session-<session-file-stem>.html` in the current directory. HTML export is not secret-redacted or encrypted; it can contain raw context, image data, and extension payloads.

Caveat:

- Parsing is whitespace-based, so quoted paths with spaces are not preserved. Use a path without spaces.
- A source checkout needs `bun gen:export-viewer` before exporting. A missing generated viewer reports the command to run. Distribution builds must include the matching locally generated viewer asset.

### `--export <inputSessionFile> [outputPath]` (CLI)

Flow in `main.ts`:

1. Handled early (before interactive/session startup).
2. Calls `exportFromFile(inputPath, outputPath?)`.
3. `SessionManager.open(inputPath, ..., { suppressBreadcrumb: true, throwIfMissing: true })` loads entries, then HTML is generated and written.
4. Process prints `Exported to: ...` and exits.

Behavior details:

- Missing input file surfaces as `File not found: <path>`; empty/malformed-header files fail without creating or replacing the input.
- This path does not create an `AgentSession`, update terminal breadcrumbs, or mutate any running session.
- Standalone export has no live agent state, so it does not add current system-prompt/tool descriptions. It embeds the loaded entries and subagent transcripts.

### `/dump` (clipboard/headless text export)

Flow:

1. The command calls `session.formatSessionAsText()`.
2. If it returns an empty string, the command reports `No messages to dump yet.`
3. Otherwise it also attempts `session.dumpLlmRequestToTmpDir()` and appends the resulting path to the transcript. The TUI copies the combined text to the clipboard; headless/ACP command execution returns it as command output.

Dump uses the live agent message array, not every branch or every historical
JSONL entry. After `/clear` or compaction it reflects the current live context;
use HTML export for the persisted conversation graph.

Dump transcript content includes:

- System prompt
- Active model/thinking level
- Tool definitions + parameters
- User/developer/assistant messages
- Thinking blocks and tool calls
- Tool results and execution blocks (except `excludeFromContext` bash/python entries)
- Custom/hook/file mention/branch summary/compaction summary entries

The best-effort JSON sidecar is named `omp-llm-request-<id>.json` under the OS temporary directory. It contains the current model, thinking level, service tier, system prompt, wire tool schemas, and LLM-converted messages. It persists after the command and can contain raw context or secrets; protect or remove it accordingly. A sidecar failure does not suppress the transcript (the TUI reports the failure; headless execution silently omits the path).

No session persistence entries are appended by dumping.

### `/dump all` (zip of per-agent dumps)

`/dump all` calls `session.dumpSessionArchiveToTmpDir()`, which writes
`omp-dump-<id>.zip` under the OS temporary directory with:

- `session.md` — the same main transcript `/dump` copies
- `llm-request.json` — the same payload as the `/dump` sidecar (best-effort; omitted if conversion fails)
- `subagents/<path>.md` — one file per persisted subagent found by `collectSubSessions` (e.g. `subagents/Scout.md`, `subagents/Scout/Helper.md`), headed `# Subagent: <path>` with the persisted model, thinking level, `Status: aborted` for killed agents, and the messages on the subagent's last-entry branch, deobfuscated like the main session

Subagent system prompts and tool inventories are not persisted, so subagent files omit them. Subagents with no messages are skipped. If subagent discovery fails, the archive still holds the main dump and the report says why subagents are missing. The TUI copies the archive path to the clipboard and lists its members; headless/ACP returns the same report as command output. Like the sidecar, the archive persists and can contain raw context or secrets.

Discovery skips linked transcript files, linked directories, and unsafe archive-member stems. A failed child read or render does not discard readable siblings. Dumping never publishes data or contacts a share server. Archives use exclusive file creation and owner-only permissions on Unix; they remain unencrypted local artifacts.

## Move a session between machines

1. Pack the source transcript and its artifacts:

   ```sh
   coreforge session pack /path/to/session.jsonl /private/path/session.tar
   ```

2. Copy the archive through an encrypted transport.
3. Unpack it on the destination:

   ```sh
   coreforge session unpack /private/path/session.tar --cwd /path/to/project
   ```

4. Mark the source copy moved away:

   ```sh
   coreforge session moved /path/to/session.jsonl --to target-machine
   ```

Unpack restores the transcript, artifacts, and referenced blobs. It does not grant launcher or account-pool authority on the destination.
Unpack holds session and subagent ownership leases while comparing and replacing local data.
It replaces a local prefix only when all local artifact bytes also occur unchanged in the archive.
Local journal or artifact changes create an incoming fork. Live owners prevent unpacking until they close.
Resuming a copy marked moved away forks it; later resumes use that fork normally.

Packing refuses source/artifact output aliases and linked or nonregular artifact roots. Invalid journals and corrupt blobs fail before local replacement.
Archives use owner-only permissions on Unix and remain unencrypted. Review their contents before transfer.

## Share

`/share` publishes an end-to-end encrypted snapshot of the session and prints
a viewer link. Implementation: [`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts).

### TUI phase 1: custom share handler (if present)

The interactive TUI's `loadCustomShare()` checks the active agent directory
(default `~/.omp/agent`) for the first existing candidate:

- `share.ts`
- `share.js`
- `share.mjs`

Requirements:

- Module must default-export a function `(htmlPath) => Promise<CustomShareResult | string | undefined>`.

If present and valid, the legacy contract is preserved: the session is
exported to a temp HTML file (`${os.tmpdir()}/${Snowflake.next()}.html`),
the handler receives its path, and the temp file is removed afterwards.
Handler result interpretation:

- string => treated as URL, shown and opened
- object => `url` and/or `message` shown; `url` opened
- `undefined`/falsy => generic `Session shared`

Critical fallback behavior:

- If custom handler exists but loading fails, command errors and returns.
- If custom handler executes and throws, command errors and returns.
- In both failure cases, it **does not** fall back to the default flow.
- The default flow runs only when no custom share script exists.
- Headless/ACP slash-command execution does not load custom share scripts; it always uses the default encrypted flow.

Custom handlers receive ordinary HTML export, not the default redacted/encrypted
snapshot. Their publishing, encryption, and privacy policy are entirely their
own. The HTML-export contract also means a custom handler cannot share an
in-memory session through this path.

### Default encrypted share

For headless execution, or in the TUI only when no custom share handler is found, `shareSession()`:

1. Builds the main-session snapshot (`header`, `entries`, `leafId`, plus current
   `systemPrompt` and tool descriptions from agent state), omitting header
   `previousSessionFiles`. Unlike HTML export, this flow does not collect
   subagent transcript files.
2. If `share.redactSecrets` is enabled (default) and the obfuscator has configured or regex-discovered secrets, a typed per-field redaction pass rewrites text-bearing header, prompt, tool, entry, sub-session, and message fields. Inline image bytes remain for the later size pass. Opaque provider replay fields and untyped extension payloads (`details`, `data`, `outputSchema`, compaction preserve data) are dropped rather than traversed.
3. The JSON is gzipped and sealed with a fresh AES-256-GCM key
   (`[12B IV][ciphertext+tag]`).
4. Upload target is chosen by `share.store`:
   - **Share server** (default, `store: "blob"`) — `POST <share.serverUrl>`
     (default `https://agent-collab.internal.somahub.io/s`) with the raw blob, capped at 1 MB.
     Oversized snapshots are trimmed until they fit: inline images first,
     then long strings (32,768 → 8,192 → 2,048 → 512 character caps), then
     oldest entries. If the reduced snapshot still exceeds the budget, sharing
     fails rather than uploading an oversized blob.
   - **Secret gist** (`store: "gist"`) — when `gh` is installed and
     authenticated, the sealed blob is pushed base64-encoded as
     `session.ompshare.txt` (budget 5 MB sealed; gist raw fetches cap at
     10 MB), falling back to the share server when `gh` is unusable or gist
     creation fails.
5. The link is `<share.serverUrl>/<id>#<base64url key>` in both cases. The
   viewer page served there fetches the blob (hex ids via the GitHub gist
   API, anything else from the server's blob store) and decrypts it
   client-side; the key lives only in the URL fragment and never appears in
   any HTTP request.

The UI reports the share URL (plus the underlying gist URL and a truncation
note when applicable). Headless `/share` prints the same lines. Unlike
`/export`, `/share` works for in-memory (`--no-session`) sessions: the
snapshot is built from live entries, no session file required.

Cancellation/abort semantics in share:

- Loader has `onAbort` hook that restores editor UI and reports `Share cancelled`.
- The upload itself is not aborted mid-flight; cancellation is UI-level and
  checked after the upload returns.

## New and delete

Interactive `/new` starts a new conversation identity. The TUI first aborts any
active compaction; `AgentSession.newSession()` emits the cancellable
`session_before_switch` event, aborts the old run, cancels owned async jobs,
closes provider state, and drains outgoing writes/advisor recorders. Persistent
`SessionManager.newSession()` writes the new header before returning, even
before the first assistant response.

The new session keeps the current model/settings and configured thinking
selector, but clears conversation/queues, todo/checkpoint/tool state, inherited
cache identity, advisor spend, and promoted memory context. Workspace roots are
seeded from current settings, and project instructions are refreshed from disk.
The TUI leaves a focused subagent view and clears its transcript.

`/delete` uses the same transition with `drop: true`. It requires a session-file
path, attempts to delete the old JSONL and artifact tree instead of retaining
them, and still starts a new session if deletion fails. Unlike `/new`, that
successor is lazy: no header is written until it has content, so quitting
without a message leaves no zero-turn session behind. A before-switch hook can
cancel either operation. Both are rejected while vibe mode is active.

## Fresh

`/fresh` (TUI/headless) resets the provider-facing stream state of the current
session **without touching the local transcript, session file, or header**. Use
it to recover from a wedged or corrupted provider stream (stale prompt cache,
a mid-turn glitch, or a server-side conversation id that has drifted) while
keeping the conversation you can see.

`AgentSession.freshSession()`:

- Is rejected while the agent is streaming — wait for the response to finish or
  abort it first.
- Closes every cached provider-session state entry (server-side conversation /
  prompt-cache handles) and reports how many were pruned.
- Mints a fresh provider session id, re-keys memory state, and invalidates the
  append-only context so the next turn rebuilds from the local conversation.
- Leaves the local transcript, session file, and OMP session-manager identity
  unchanged; the provider-facing `AgentSession.sessionId` changes.

Because it keeps both the visible and model-facing conversation, `/fresh`
differs from `/clear` (clear the live/model conversation in place), `/new`
(start a brand-new empty session), and `/delete` (attempt to delete the current
session and start a new one). Only `/fresh` preserves the existing conversation
while giving the provider stream state a clean slate.

## Clear

Interactive `/clear` clears the current conversation context in place. It is
available only in the TUI and is rejected while a response is streaming or a
foreground bash/Python execution is running. If compaction is active, the
command aborts it and waits for it to stop before resetting.

`AgentSession.resetSessionContext()`:

- Drops live messages, queued steer/follow-up turns, pending tool calls, error
  state, checkpoint/rewind and deferred tool state, and session-stop
  continuation state. It also cancels this agent's queued continuation work and
  async bash/task jobs.
- Rotates provider-side session state, re-primes advisors, invalidates
  append-only model context, and resets memory promotion so the next turn
  rebuilds from the base system prompt and current project instructions.
- Retains the session id, title, cwd, model, settings, active plan path, and
  transcript file.
- Appends `reset_boundary` through the normal persistence pipeline. For an
  already materialized session it is durable; an in-memory or still-lazy
  session retains the marker in memory. The collapsed live transcript and
  rebuilt model context begin after the latest boundary, while persisted JSONL
  and full-transcript export retain the pre-reset history.
- After the reset and system-prompt refresh succeed, awaits the `session_clear`
  notification to hooks/extensions so they can invalidate context-dependent
  caches. Empty successful clears also notify; busy/rejected resets do not.
  This does not emit `session_switch` or allow handlers to cancel the clear.

The TUI clears its rendered transcript after a successful clear. This differs
from `/fresh`, which rotates provider stream state without clearing the
conversation; `/new`, which creates a new session identity and transcript file;
and `/delete`, which attempts to delete the old persisted session before starting
a new one.

## BTW history

`/btw` history is stored alongside session artifacts and remains outside the main
conversation. See the [BTW command reference](slash-command-internals.md#11-built-in-command-note-btw)
for keyboard controls, follow-ups, persistence, and migration safety.

## Fork

Bare `/fork` normally creates a new session and switches the active session
identity. The existing Tern pane specialization instead keeps the parent running.
Explicit `/fork pane`, `/fork window`, and `/fork tab` use the generic multiplexer
launcher. They do not infer generic placement support from a Tern host.
`window` and `tab` open a multiplexer group: a tmux window, Zellij/Herdr/Orca tab,
or CMUX workspace. The child starts from the flushed persisted transcript while
the parent session stays active.

Typing `/fork ` shows `[pane|window|tab]` as dim inline text, and Enter still
runs the existing bare-fork flow. Typing a prefix (`/fork w`) opens suggestions
with the rest of the selected argument as dim inline text; Tab accepts it.

Placement commands autodetect tmux, Zellij, Herdr, CMUX, or Orca from the terminal;
`/fork auto` is not a subcommand (valid arguments are `pane`, `window`, and
`tab`). `window` maps to a tmux window, a Zellij/Herdr/Orca tab, or a CMUX workspace.
Plain terminals, `screen`, and `wmux` cannot host this fork placement and receive
an explicit error; use bare `/fork` there instead.

### Preconditions and immediate guards

- Bare `/fork` first tries the current Tern pane, including during streaming. If that launch is declined or unconfirmed, in-place fallback stays blocked while streaming.
- A placement fork during streaming asks before launching. The child can omit
  the partial response, and confirming does not stop the parent response.
- Forking is rejected while vibe mode is active.
- Placement forks require an already persisted session transcript. Pending Bash
  output and session writes are flushed before the snapshot and launch.
  The parent never switches sessions.
- A CLI `--api-key` override cannot be safely passed through a multiplexer command;
  placement forks refuse it rather than exposing the key.
- Explicit placements reject process-local SDK OAuth account-pool policy, including
  parked or released leases. The child cannot inherit that authorization scope.
- UI status/loading indicators are cleared only for the original bare `/fork`
  flow.
- Bare forks checkpoint active BTW answers and flush pending history writes before copying artifacts.
  External, declined, rejected, and no-op forks retain the original side sheet and focus.
- A successful in-place fork retires only outgoing session owners after `session_switch`.
  Extension handlers and side views created by the incoming hook remain active.

### Terminal placement flow

For a placement command, the controller rebuilds the child CLI command from the
current CLI entry point and restart-safe launch flags (one-shot selectors such
as `--goal` and positional prompts are dropped). It replaces stale startup
model, thinking, profile, prompt-cache-key, session-directory and working-directory
flags with active values. Routed model selection and the parent's prompt-cache
key remain pinned. The child receives effective agent/config directories,
resolved config overlays, the resolved managed-config path, absolute session
directory and XDG bases. These paths retain their meaning after `/move`.
Absent scope variables are unset, not exported empty. Captured launcher policy
wins over stale multiplexer-server environment. The command starts with `--fork`
and the absolute path of the current transcript. The
generic terminal launcher handles provider-specific execution and reports
capability or launch failures in the TUI. CMUX and Orca launches require
explicit confirmation that the destination's configured interactive shell
accepts POSIX syntax; this is never inferred from the local OS or `SHELL`.
Declining confirmation stops before the session is flushed or a terminal is
launched. `window` and `tab` both map to the multiplexer group placement. The Orca
CLI is resolved in Orca's documented order (`ORCA_CLI_COMMAND`, then `orca-dev` in an
Orca development checkout, then `orca-ide` on Linux outside an Orca terminal, then
`orca`).

Orca's CLI `--command` accepts shell text, not argv, and has no `--cwd`; after
confirmation, OMP supplies `cd <quoted-cwd> && <quoted-command>` using shared
POSIX shell quoting. When Orca cannot show the new tab and starts the child in a
background terminal instead, `/fork` reports that as a warning rather than a
visible tab.

Source forks start Bun from a neutral directory with dotenv loading disabled and
the trusted source preload restoring the session cwd before CLI imports.
Compiled forks retain the captured env-file policy. A successful launch result
is provider acknowledgement, not proof that the child started or completed.

### Session-level flow

The original bare `/fork` uses `AgentSession.fork()`:

1. Emits `session_before_switch` with `reason: "fork"` (cancellable).
2. Flushes pending bash/session writes and drains/detaches advisor recorders.
3. Calls `SessionManager.fork()`, preserving the conversation and its usage attribution.
4. Copies artifacts directory from old session namespace to new namespace (best-effort; non-ENOENT copy failures are logged, not fatal).
5. Updates `agent.sessionId` and inherits the previous provider prompt-cache key unless an explicit prompt-cache key is already pinned.
6. Emits `session_switch` with `reason: "fork"`.

`SessionManager.fork()` behavior:

- Requires persistent mode and an assigned session-file path; the source need not already be materialized on disk.
- Creates new session id and new JSONL file path.
- Rewrites header with:
   - new `id`
   - new timestamp
   - `cwd` unchanged
   - `parentSession` set to previous session id
   - `providerPromptCacheKey` set to the previous header's inherited key, or the previous session id when none was pinned
- Keeps all non-header entries unchanged in the new file.

### Non-persistent behavior

- In-memory session manager returns `undefined` from `fork()`.
- `AgentSession.fork()` returns `false`.
- UI reports `Fork failed (session not persisted or cancelled)`.

### Fork at an entry (`AgentSession.fork(entryId)`, RPC `fork`)

`AgentSession.fork(entryId)` forks from a transcript point instead of the whole session. The RPC `fork` command calls it when `entryId` is given and plain `fork()` otherwise.

- Like the whole-session fork, it is rejected while vibe mode is active.
- `entryId` must be a `message` entry (user, assistant, or any other message role); anything else throws `Invalid entry ID for forking`.
- It throws `SessionBusyError` while `AgentSession.isBusyForSnapshot` is true (a response is streaming, or user bash/eval, compaction, handoff, or retry work is running). The check runs before `session_before_branch`, again after it, and once more after pending bash output and session writes flush. That last check comes before anything of the old session is discarded (pending next-turn messages, async jobs, the auto-learn capture), so a refused fork leaves the session as it was. A prompt admitted during the remaining drain awaits is dropped by the prompt-generation bump at the cut, as for `branch()`. `/btw` branches use the same predicate.
- When `entryId` sits inside an assistant tool-call batch (the assistant message, or a tool result answering it), the cut extends through the batch's recorded tool results, following the tree from `entryId` and stepping over lone non-message entries between results. A fork therefore never ends on tool calls whose results exist in the source session; calls that never got a result stay as they are.
- The transition is the one `AgentSession.branch()` uses, cut at the resolved entry rather than before it: `session_before_branch` with reason `"fork"` (cancellable; `entryId` is the last kept entry, not a dropped one as for `branch()`), `SessionManager.createBranchedSession(leafId, { copyArtifacts: true })`, rebuilt agent messages, then `session_branch` with reason `"fork"`.
- The new file keeps the root-to-entry path including the resolved entry, carries labels for kept entries, keeps the title, and sets `parentSession` to the previous session file. The whole artifact directory is copied in the background (including artifacts only cited by dropped entries), and the new session's artifact manager waits for the copy before allocating ids or resolving `artifact://`, so kept `artifact://N` references still resolve and new artifacts get fresh ids. Unlike the whole-session fork, the provider prompt-cache key is not inherited (same as `branch()`).
- Works in non-persistent mode (in-memory replacement), unlike the whole-session fork.
- `AgentSession.fork(undefined, { requireIdle: true })` applies the same idle rule to the whole-session fork (before `session_before_switch` and again after the flushes). RPC `fork` passes it for both variants, so both reject with `code: "session_busy"`. Interactive `/fork` does not, so it can still carry a running bash command into the new session.

### CLI `--fork <id|path>`

Startup `--fork` is resolved before normal session creation:

1. `--fork` is rejected with `--no-session`.
2. Path-like values (`/`, `\`, or `.jsonl`) fork directly from the given path.
3. Other values resolve via `resolveResumableSession(...)`: local sessions first, then global search when `sessionDir` is not forced. Matching accepts lowercased session id prefixes, full JSONL filename prefixes, and timestamp-stripped filename id suffixes.
4. The forked file is created in the current cwd/session-dir scope and becomes the active session manager for startup. Source artifacts are copied recursively by default. Missing source files fail instead of producing an empty fork.
   An unresolved tool call on the copied active branch is paired with an
   outcome-unknown result in the child, rather than being marked never executed.
   For a length stop, the never-executed guard is retained only when no
   execution-start marker exists. A source whose process exit was recorded
   after its last message is not repaired here: the child warns about the
   pending calls and pairs them through the normal process-exit recovery.
   The parent transcript is unchanged.
5. Full-context forks automatically seed `providerPromptCacheKey` from the source header's inherited key, falling back to the source session id. Startup drops that automatic inheritance for explicit `--model`, `--thinking`, `--system-prompt`, `--system-prompt-template`, `--append-system-prompt`, `--tools`, or `--no-tools` overrides, or an applicable scoped-model override.

Use `--prompt-cache-key <key>` to pin the provider prompt-cache identity explicitly and independently from both the OMP session id and `--provider-session-id`. `--provider-session-id` continues to control provider session/routing headers and sticky credential selection; `--prompt-cache-key` controls the OpenAI Responses `prompt_cache_key` payload where supported.

## Seance

`/seance [id|path] [--model selector]` opens a source picker when no source is supplied; an id or path (`~` expands) selects directly. Typed ids search the current project, then every project. The source is read without opening a writer and is never modified.

File-backed sources resolve to their canonical journal path before forking. A journal symlink uses the target journal's artifact directory, not the link's directory.

Each consult forks only the source transcript, into `<current session artifacts>/<ConsultId>.jsonl`, with `seanceSource` in its header. Artifacts are not copied: the consultant's `history://`, `artifact://`, and `agent://` read the source's artifacts directory in place, and its own new artifact ids are allocated past the source's so inherited `artifact://<n>` references keep naming the source artifact. Consulting the current session repeatedly adds one transcript per consult, not a copy of the tree.

Source-bound agent reads do not expose the host registry's progress, known IDs, or supersession metadata. A selection from an earlier session is discarded if its initiating session changes before launch.

The model comes from the source's active branch when restorable; `--model selector` overrides it. When the source has no saved model, the model picker opens directly.

The parent session's admission hooks can reject a consult. They cannot replace the selected source model; routing notes remain available.

The consult excludes additional workspace roots, the workspace tree, context files, skills, rules, inherited agents, extensions, MCP, IRC, and LSP; the source's `session_init` contracts become inert `source_session_init` entries. Tools are limited to `read`, `grep`, and `glob` (as enabled); `task.structured` adds `yield`. Cold revival requires the `seanceSource` header and restores the persisted prompt with the same read-only tools.

Inherited source charges are zeroed; new consultation turns use existing task/Agent Hub usage tracking.

Ownership: [`src/slash-commands/seance.ts`](../packages/coding-agent/src/slash-commands/seance.ts) (command and pickers), [`src/task/seance.ts`](../packages/coding-agent/src/task/seance.ts) (source/model resolution, revival contract), [`src/task/seance-policy.ts`](../packages/coding-agent/src/task/seance-policy.ts) (isolation options), and `SessionManager.forkFrom(..., { seance: true })` (fork).

## Resume and continue

## Interactive `/resume [value]`

Without an argument:

1. Opens the session selector populated via `SessionManager.listForPicker(currentCwd, currentSessionDir)`. Pinned sessions come first; untitled, prompt-less zero-turn stubs are hidden unless pinned. The picker always opens in current-folder scope; the empty state invites Tab into all-projects instead of auto-switching.
2. Tab toggles to all-projects scope, lazily loading and caching `SessionManager.listAllForPicker()`.
3. On selection, `SelectorController.handleResumeSession(sessionPath)` opens the exact selected file through `session.switchSession(sessionPath)`, without continuation redirection. Captured source-session and selection ownership guards reject stale completions. If the switch is rejected, it returns `false` and the selector stops without applying the new-session UI state.
4. After a successful switch, UI clears/rebuilds chat and todos, then reports `Resumed session` (or `Resumed session in <dir>` when the resumed session belongs to another project, in which case the process cwd and cwd-derived caches are re-pointed via `applyCwdChange`).

With an argument:

- `/resume <id>` resolves an id/filename prefix with local-first, then global fallback, and opens the copy `resolveResumeTarget` picks, the same one the CLI's `--resume <id>` opens (see CLI `--resume <value>`); an unknown value reports `Session "<value>" not found`.
- `/resume @claude` and `/resume @codex` open a foreign-session picker. Selecting one converts and persists it under a fresh OMP session identity, then switches to that new session.

## CLI `--resume`

### `--resume` (no value)

- `main.ts` uses `SessionManager.listForPicker()` for the current cwd/sessionDir and opens the picker in current-folder scope. When that list is empty it preloads `SessionManager.listAllForPicker()` so a user-initiated Tab switch is immediate; it does not auto-switch scopes. `No sessions found` is printed only when the global picker list is also empty.
- The selected session opens before agent-session creation. Its recorded cwd supplies the project scope when enterable; otherwise the launch cwd remains active. The process reloads scoped settings and plugin caches and re-resolves models. An explicit `--session-dir` remains the live continuation directory; it does not replace the source transcript's recorded cwd.

### `--resume <value>`

`createSessionManager()` resolution order:

1. If value looks like path (`/`, `\`, or `.jsonl`), open directly. A path that does not exist fails with `Session "<path>" not found.` rather than creating a session there.
2. Else `resolveResumableSession(...)` searches:
   - current scope (`SessionManager.list(cwd, sessionDir)`)
   - global sessions (`SessionManager.listAll()`) only when no explicit `sessionDir` was provided
3. Matching accepts case-insensitive session id prefixes, full JSONL filename prefixes, and the id suffix after the timestamp in `<timestamp>_<sessionId>.jsonl`.
4. When nothing matches, the resolver (`resolveResumeTarget`) looks in the same scopes for a `<timestamp>_<sessionId>.jsonl` file whose name matches but which no longer reads as a session (the listing skips it), and takes the copy that continues it (see below). Otherwise resolution fails with `Session "<value>" not found.`

Id/filename-prefix discovery follows the session's continuations (`findSessionContinuation`, through `resolveResumeTarget`): when its conversation continued in a sibling file whose header names it in `continuationOf`, the newest copy opens unless the named session has turns that copy lacks. A notice names both files. Discovery can recover an unlisted replaced generated filename through its recorded id. Literal path arguments remain exact. The startup picker first reads the selected file's authoritative session metadata, then can follow a validated continuation; that chosen session supplies both the open path and recorded cwd. The interactive in-session picker retains exact selection.

Id/filename-prefix match behavior (local or global):

- If the matched session's recorded directory no longer exists, CLI asks `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`.
   - On yes (default), `SessionManager.openRelocated(session.path, session.cwd, cwd, sessionDir)` re-roots the existing session under the session ownership and publication fences. A live writer refuses the move; the runtime does not duplicate or silently replace its transcript.
   - On no, startup is cancelled. In non-TTY mode, startup fails with an error directing the user to run interactively.
- If the recorded directory still exists, the matched session is opened directly. Startup later changes the process/project scope to the resumed session's cwd and reloads cwd-scoped settings and plugin caches. It is not implicitly forked.

Path-valued resume opens directly rather than using the missing-directory move
prompt. If its recorded cwd is missing or permission-blocked, startup retains
the launch cwd without relocating the transcript; a failed cwd switch/rescope
also prints a fallback warning.
The same enterability policy applies to picker selections. A missing direct path
fails with `Session "<path>" not found.`; an existing empty file or malformed
non-empty header fails closed without modifying or redirecting the file.

## CLI `--restore`

`--restore [value]` selects and opens its session exactly as `--resume [value]`
does, then, once the interactive TUI is up, goes on with what the session's last
process left unfinished when it ended (`task/restore.ts`, `restoreSession`). Tern's
session daemon relaunches omp panes with it after a crash: omp reports
`omp_restore=1` (OSC 1337 user variable) beside its session file to say it
understands the flag. `/restart` relaunches with it too.

A subagent whose turn the process teardown cut off counts as left mid-turn, even
though the teardown was clean: its owner's shutdown aborts the run with
`INTERRUPTED_TURN_ERROR` and records its `session_exit` as a process exit
(`postmortem.Reason.EXIT`), both for a first run the task executor drives and for
a revived agent's turn the lifecycle teardown disposes.

1. **Subagents first.** Every persisted subagent transcript under the session
   (`<session>/<AgentId>.jsonl`, nested ones included) that its process left
   mid-turn, that was not killed (no tombstone) and that a cold revive can rebuild
   (a `session_init` contract, not isolated) runs one more monitored turn as a
   background job of its parent, under the subagent's id. The lifecycle reviver
   rebuilds it from its transcript, the turn goes on as below, and the parent
   receives the result as the job's ordinary `async-result`, so a parent waiting on
   that job finds it again.
2. **Then the session's own turn** (`AgentSession.restoreInterruptedTurn`). A turn
   cut off without a `session_exit` record is first closed through exit recovery:
   unfinished tool calls receive "outcome unknown" results and an interrupted-turn
   abort ends it. Automatic restoration uses `TurnRecovery.retry({ replayTools: false })`.
   It preserves those tool/result pairs and resumes model continuation without
   directly reexecuting cut-off calls, even when the entire tool batch was interrupted.
   Explicit operator `/retry` retains its deliberate tool-retry behavior.

Repeated or concurrent restoration in one live session does not start another copy
of the same interrupted turn or child job. Existing running, completed, and failed
jobs retain their identities and outcomes. Rejected job admission remains retryable
when capacity becomes available.

A changed or disposed root or branch stops pending discovery from restoring old
work. `/new` also cancels registered child jobs before they can dispatch pending
tools or model requests after cold revival.

Restoration cannot determine whether an unrecorded tool effect occurred before
the crash. Review uncertain effects before replaying interrupted work.

Nothing is continued when the last turn finished, failed, or the user interrupted
it, or when a normal exit was recorded after it (the user quit with it
interrupted). `--restore` is interactive only, takes no prompt, and cannot be
combined with `--continue`, `--fork`, imports, `--goal` or `--no-session`.
`/restart` drops a launch `--restore` like the other one-shot selectors and adds
its own for the current session.

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`:

1. Resolves the session directory for the current cwd.
2. Reads the terminal-scoped breadcrumb. A fresh breadcrumb whose lazy JSONL is still absent starts fresh rather than reopening an older conversation. Explicit `newSession()` boundaries already have a durable header.
3. If it points into a nested artifact/subagent session, resolution walks up to the top-level interactive parent session (up to eight levels).
4. A matching-cwd breadcrumb is used when it lies within an explicitly supplied session directory, if any. Otherwise discovery chooses the newest session with resumable content, skipping untitled, prompt-less zero-turn stubs.
5. For a different, missing recorded cwd, automatic re-rooting additionally requires the current directory's device/inode to match the breadcrumb's recorded directory identity and no genuine current-project session to take precedence. A deleted/unmounted path, legacy breadcrumb without identity, or cross-filesystem move is not enough evidence to relocate history.
6. When the chosen session's conversation went on in another file of the same directory (its header names the chosen session in `continuationOf`), chooses that copy instead and reports it to the `onSessionContinuation` option (the CLI prints a notice); step 5 re-roots that copy, not the file the breadcrumb names. A session the breadcrumb names is kept when it has turns its continuation lacks, as with id-based resume discovery; a pick by write time takes the linked copy with the newest turn in either direction.
7. Opens the chosen session, or creates a new one when no candidate exists.

For compatibility, `--continue <full-UUID>` is normalized to `--resume <UUID>` when the UUID is the sole positional message. The `autoResume` setting invokes the same `continueRecent` behavior when no explicit session flag/session directory is supplied, and restores session model/thinking state when a prior transcript was found.

If implicit interactive auto-resume exhausts the saved models and model-fallback policy forbids substitution, startup closes the skipped session, warns, and starts a new session without its history or provider cache identity. It does not retry older transcripts or weaken restoration policy. When `--max-time` is set, the new session keeps the launch's original absolute deadline; time spent on the failed restore is not added back to the budget. Explicit `--continue`/`--resume`, runtime `/resume`, and headless/SDK hosts still fail closed under the same policy; an explicit model override remains an intentional way to restore the transcript with another model.

This is startup-only behavior; there is no interactive `/continue` slash command.

## Restart

Interactive `/restart` performs normal teardown, flushes postmortem cleanup and
stdout, then relaunches the CLI. `restartArgv()` preserves launch configuration
flags but strips original prompts/`@file` positionals and one-shot session
selectors (`--session`, `--resume`, `--restore`, `--continue`, `--fork`, and
foreign imports). It adds `--restore <session-file>` only when the session
actually exists on disk, so the subagents the teardown cut off mid-turn go on in
the new process (see [CLI `--restore`](#cli---restore)); an in-memory or
never-materialized session restarts fresh.

Restart preserves the live cwd, current session directory, and resolved overlay
and managed configuration paths. Relative startup flags cannot redirect these
paths after `/move`.

Source restarts share the terminal-fork bootstrap: Bun starts in a neutral
directory with Bun's project dotenv loading disabled. Trusted runtime flags and
preloads survive, and the source shim restores the live cwd before CLI imports.
Compiled restarts retain the launcher-captured env-file policy.

Sessions governed by an SDK OAuth account pool refuse restart before teardown,
including after their restriction leases have been released. A transcript cannot
transfer this process-local authorization policy.

POSIX uses process-image replacement when available. Windows or a failed exec
falls back to spawning the replacement with inherited terminal streams.
The POSIX exec boundary pins named, non-secret configuration and launcher scope
through `/usr/bin/env`; it does not serialize provider credentials into argv.
The spawn fallback receives the same scope through its explicit environment.

## How session switching actually mutates runtime state

`AgentSession.switchSession(sessionPath)` does the runtime transition used by resume-like operations:

1. Emit `session_before_switch` with `reason: "resume"` and `targetSessionFile` (cancellable).
2. Disconnect the agent event subscription, abort in-flight work, and run the optional pre-switch reconciler.
3. Flush pending bash/session writes and capture rollback state: session manager state; agent messages and all queues; model/thinking/service tiers; tools and prompts; provider/cache ids; memory promotion; and checkpoint rewind state.
4. Clear agent and next-turn queues. For a different file, drain/detach advisor recorders.
5. `sessionManager.setSessionFile(sessionPath)`, update provider-cache/session ids and memory keys, build the display context, resolve the recorded model, and rehydrate checkpoint state. When no recorded model can be restored for a different file, the switch fails here with `Could not restore model <provider/id>` (see below).
6. Emit `session_switch` with `reason: "resume"`.
7. Replace agent messages, reset advisor state, and synchronize todos. Close cached provider sessions for a different file, or for a same-file reload whose replay messages changed.
8. Apply the resolved (or explicitly requested) model. If the loaded branch ended with an interrupted turn, append its synthetic abort message and rebuild context.
9. Restore configured/effective thinking and per-family service tiers, falling back to current settings when the target branch has no corresponding entries.
10.   For a different transcript, reset memory context; for any conversation rewrite, clear session-scoped tool state.
11.   Reconnect agent events, run the optional session-switch reconciler (interactive mode uses it to re-enter persisted modes such as plan), and best-effort refresh the workspace-root system-prompt block. Reconciler/prompt-refresh errors are logged rather than rolling back the committed switch.
12.   Restore target advisor cost state, finish the bash transition, notify session-change callbacks when the session id changed, and return `true`.
      `switchSession()` returns `false` when a before-switch hook cancels or cwd policy rejects the transition. A cross-project switch without a cwd-change callback is rejected rather than silently adopting the target cwd; callback rejection is also cancellation. The interactive selector checks this result and leaves the existing session/UI unchanged.

If a throwing step in the guarded transition fails, `switchSession()` restores the captured session, agent queues/messages, tools/prompts, model/thinking/service-tier, provider/cache, memory, and checkpoint state; it reconnects the prior agent subscription and re-runs mode reconciliation before rethrowing.

Normal resume switching opens an existing transcript. Because it delegates to
`setSessionFile()`, a missing/empty explicit target can instead materialize a
new session at that path; malformed non-empty headers are rejected.

Model restoration fails closed, like startup resume: a switch never silently moves a transcript to a model it did not record. Only a session created with `hasUI` and `allowSessionModelFallback` (the TUI), with `retry.modelFallback` on, keeps its current model instead, and warns `Could not restore model <provider/id>. Using <provider/id>`. An explicit `model` option (RPC `open_session`/`switch_session` with `provider`/`modelId`) replaces the recorded model, and a same-file reload keeps the current one.

## Event emissions and cancellation points

### Switch/fork lifecycle hooks

For `newSession`, `fork`, and `switchSession`:

- Before event: `session_before_switch`
   - reasons: `new`, `fork`, `resume`
   - cancellable by returning `{ cancel: true }`
- After event: `session_switch`
   - same reason set
   - includes `previousSessionFile`

`ExtensionRunner.emit()` returns early on the first cancelling before-event result.
When a before-switch hook cancels, `switchSession()` returns `false` and does not emit the after-switch event.

### Custom tool `onSession` behavior

SDK bridges extension session events to custom tool `onSession` callbacks:

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

These callbacks are observational; they do not cancel switch/fork.

### Other cancellation surfaces relevant to this doc

- In-place `/fork` fallback is blocked while streaming; a successful Tern pane fork leaves the original response running.
- `/resume` selector can be cancelled by user closing selector.
- Cross-project `--resume <id>` can be cancelled by declining the missing-directory move/re-root prompt.
- `/share` has a UI abort path (`Share cancelled`); the upload itself is not killed mid-flight.

## Non-persistent (in-memory) session behavior

When session manager is created with `SessionManager.inMemory()` (`--no-session`):

- Session file path is absent.
- `/export` fails with `Cannot export in-memory session to HTML` (propagated to command error UI). `/share` still works: the snapshot is built from live entries.
- `/fork` fails because `SessionManager.fork()` requires persistence.
- `/dump` still works because it serializes in-memory agent state.
- Native CLI `--resume`, `--continue`, and `--fork` are rejected with `--no-session`; the preliminary startup parse may allocate an in-memory manager, but validation rejects these combinations before normal execution.

## Known implementation caveats (as of current code)

- `/share` custom-share failures do not degrade to the default encrypted share flow; they terminate the TUI command with an error.
- `/export` argument tokenization does not preserve quoted paths with spaces.
- `/delete` treats deletion as best-effort: it attempts to delete the current
  session JSONL and artifact directory, logs any deletion failure, and still
  creates and switches to a new session. A failed or partial deletion can leave
  the old session or its artifacts on disk, so `/delete` is not a guaranteed
  erasure boundary.
