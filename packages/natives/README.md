# @oh-my-pi/pi-natives

Native Rust functionality via N-API.

## What's Inside

- **Grep**: Regex-based search powered by ripgrep's engine with native file walking and matching
- **Find**: Native glob-based file/directory discovery with gitignore support
- **SIXEL**: Terminal image encoding for SIXEL-capable terminals (decode, resize, encode in one pass)
- **Audio**: Cross-platform low-latency microphone capture and gapless speaker playback
- **WebRTC**: Native Opus media, SDP offer/answer negotiation, and data-channel events for live sessions
- **File locking**: Process-owned cross-process locks with in-memory kernel names on Linux/Windows and `flock(2)` sidecars on other Unix platforms
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

### Lazy Windows path helpers

Import `expandWindowsLongPath` and `getWindowsShortPath` from
`@oh-my-pi/pi-natives/path` when importing a module must not load the native addon.
The addon loads only when a helper is called on Windows; other platforms preserve
the input path without loading it. These helpers change long/8.3 spellings without
resolving symlinks or junctions.

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
crates/pi-natives/       # Rust source (workspace member)
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
