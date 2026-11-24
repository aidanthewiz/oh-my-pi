# @oh-my-pi/pi-natives

Native Rust functionality via N-API.

## What's Inside

- **Grep**: Regex-based search powered by ripgrep's engine with native file walking and matching
- **Find**: Native glob-based file/directory discovery with gitignore support
- **SIXEL**: Terminal image encoding for SIXEL-capable terminals (decode, resize, encode in one pass)
- **Audio**: Cross-platform low-latency microphone capture and gapless speaker playback
- **WebRTC**: Native Opus media, SDP offer/answer negotiation, and data-channel events for live sessions
- **File locking**: Process-owned cross-process locks with in-memory kernel names on Windows, open-file-description lock sidecars on Linux and `flock(2)` sidecars on other Unix platforms
- **Local IPC**: `IpcServer`/`IpcConnection` over Unix sockets and Windows named pipes — owner-only access, single-instance binding with stale-endpoint takeover, newline or raw framing; `ipcEndpoint(dir, name)` names endpoints per platform
- **PDF**: In-memory PDF-to-Markdown extraction with OCR-page classification via `pdf-inspector`
- **Binary patches**: `applyBinaryPatch(oldPath, patchPath, outPath)` applies an HDiffPatch single-stream patch (HDIFFSF20, zstd or uncompressed), streaming from files; callers verify digests

General-purpose image processing (decode/resize/encode for files and buffers)
lives in [`Bun.Image`](https://bun.com/docs/runtime/image) on the JS side; this
crate only ships the SIXEL encoder because no built-in equivalent exists for
that terminal protocol.

## Usage

```typescript
import { encodeSixelAsync, grep, pdfToMarkdown } from "@oh-my-pi/pi-natives";

// Grep for a pattern
const results = await grep({
	pattern: "TODO",
	path: "/path/to/project",
	glob: "*.ts",
	context: 2,
});

// Find files
const files = await find({
	pattern: "*.rs",
	path: "/path/to/project",
	fileType: "file",
});

// SIXEL encode for a terminal cell box (px), off the JS thread
// (`encodeSixel` is the synchronous form)
const backgroundRgb = 0x202040; // Actual terminal background, packed 0xRRGGBB
const sequence = await encodeSixelAsync(pngBytes, widthPx, heightPx, backgroundRgb);

// Extract PDF text and identify pages that still need OCR
const pdf = await pdfToMarkdown(pdfBytes);
console.log(pdf.markdown, pdf.pagesNeedingOcr);
```

Both SIXEL encoder forms require the terminal background as a fourth argument:
a finite integer from `0` through `0xffffff`, packed as `0xRRGGBB`.
Invalid colors throw synchronously or reject the asynchronous promise.
When resizing images with alpha, RGB is
premultiplied before Lanczos filtering so transparent pixels cannot darken or
discolor visible edges. After resizing, the terminal background is composited
without applying alpha twice. Fully transparent pixels remain transparent;
unscaled images retain their existing blending path. Re-encode when the terminal
background RGB changes.

### Line matching

`new LineMatcher(patterns)` compiles Rust regular expressions.
`groupNames()` returns each pattern's named groups in capture order.
`matchLines(text)` returns typed arrays named `lines`, `rules`, and `spans`.
Matches use zero-based line and pattern indices, ordered by line then pattern.
Each pattern reports its first match per line.
Each named group contributes UTF-16 start/end offsets within that line.
An unmatched optional group contributes `-1, -1`.

### Pipeline streams

Create one `PipeStreams` per `Shell.run` and pass it as `streams`.
It mirrors pipeline bytes without changing the shell's output or cancellation owner.
`list()` reports retained streams in opening order, including producer, consumer,
total byte count, and whether more bytes can arrive.
`read(id, from?)` returns `{ start, end, data, open }`, or `null` for an unknown
or evicted stream. Resume from `end`; `start > from` identifies discarded bytes.
Offsets count bytes, not characters. Decode the returned `Buffer` incrementally.
When `open` is false, read any remaining bytes before treating the stream as finished.

Each stream retains its newest 1 MiB. At most 16 streams remain retained.
New pipes evict the oldest finished streams, keeping room for four recent finished
streams. If all 16 streams remain open, additional pipes run without capture.
Dropping the JavaScript handle does not cancel the shell run.

On Unix and Windows, a consumer that closes its pipe releases the relay even
when the producer remains idle. Windows checks native pipe state before reading;
it preserves buffered bytes after producer closure and keeps ordinary write backpressure.
Unsupported Windows pipe queries fail before pipeline stages start.

### HTML conversion

`htmlToMarkdown(html, { hiddenContent })` accepts `"drop"` (the default),
`"reachable"`, or `"all"`.
`"reachable"` includes content that a page can reveal, such as collapsed sections.
`"all"` also includes `<template>` and `<noscript>` content.
Invalid values throw before conversion starts.

### Hashline display limits

`EditPolicy.maxColumns` is the narrowest display limit measured in UTF-8 bytes.
Use zero only when no display tool truncates lines.
Without retained read provenance, hashline rejects guarded lines exceeding this
limit until a full read records them. Block replacements and cuts guard every
affected line, not only the opening anchor.

### PTY dimensions

`normalizePtyDimensions(cols, rows)` returns `{ cols, rows }` with fractional
values truncated toward zero and dimensions clamped to 20–400 columns and
5–200 rows. It shares the native bounds used by `PtySession.start`,
`startArgv`, and `resize`. Use the returned dimensions when sizing a screen
emulator so its viewport matches the native PTY.

### Lazy Windows path helpers

Import `expandWindowsLongPath` and `getWindowsShortPath` from
`@oh-my-pi/pi-natives/path` when importing a module must not load the native addon.
The addon loads only when a helper is called on Windows; other platforms preserve
the input path without loading it. These helpers change long/8.3 spellings without
resolving symlinks or junctions.

### Loaded addon identity

`nativeAddonPathFor(exportName, value)` from `@oh-my-pi/pi-natives/loader-state`
returns the path of an already-opened addon only when its named class or function
is exactly `value`. Foreign, missing and non-function exports return `undefined`.
The lookup does not open another addon or infer identity from package versions.
Use it instead of `require.cache`, which does not track `process.dlopen` loads.

### Git commits

`VcsGitRepo.commitCreate(message, options)` honors configured signing and commit hooks.
With `files`, it commits the selected tracked working copies, not stale staged bytes.
Unrelated staged entries remain staged.
Selected paths staged concurrently during hooks keep their newer staged content.
With `indexPath`, it instead reads the caller's index and leaves the shared index untouched.

Set `expectedHead` to a revision to reject a stale parent.
Set it to `null` to require an unborn HEAD.
Omit it to disable this caller guard; final ref publication still compares the captured HEAD.
Handle `HeadMoved` by rebuilding a private index from the new HEAD before retrying.
Each `commit-msg` hook receives an owned temporary message path through its first argument.

### File locks

`FileLock.tryAcquire(path, create = true)` returns a non-blocking ownership handle.
Check `acquired` and release the handle after the protected operation.
Release is idempotent and cannot release another handle's ownership.

On file-backed Unix platforms, `create = false` opens only an existing non-symlink.
A missing path returns an unacquired handle without creating a file.
Linux and Windows use kernel names and never create filesystem lock files.

## Building

```bash
# Build native addon from workspace root (requires Rust)
bun run build

# Type check
bun run check
```

## Architecture

The loader supports generated platform-specific optional dependency packages
for upstream npm installations. Coreforge instead distributes each fork-built
addon alongside its matching binary on the authenticated Coreforce release:

```
crates/natives/       # Rust source (workspace member)
  src/lib.rs             # N-API exports
  src/sixel.rs           # SIXEL terminal-image encoding
  Cargo.toml             # Rust dependencies
native/                  # Core loader files and local/CI native build outputs
  index.js               # Public native export surface
  loader-state.js        # Platform, ISA variant, and addon resolution
  embedded-addon.js      # Null embed stub; binary builds replace it in memory
  pi_natives.<platform>-<arch>-modern.node   # x64 modern ISA (local/CI artifact)
  pi_natives.<platform>-<arch>-baseline.node # x64 baseline ISA (local/CI artifact)
  pi_natives.<platform>-<arch>.node          # non-x64 build artifact
npm/<platform>-<arch>/   # Generated at publish time, not committed
  package.json           # @oh-my-pi/pi-natives-<platform>-<arch>
  *.node                 # Only that platform's addon binary or x64 ISA variants
```

The upstream npm publishing script can produce leaf packages, but Coreforge
does not publish that channel. Source installs build the addon from this fork;
released installs use the exact-version Coreforce addon archive. x64 archives
include both built ISA variants, and the loader selects `baseline` or `modern`
at runtime.
