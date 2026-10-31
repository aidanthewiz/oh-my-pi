//! Output normalization. Each rule masks one value that legitimately differs
//! between two runs of the *same* binary (or between two correct builds), and
//! nothing else:
//!
//! 1. The side's absolute work directory becomes `{W}`: each side runs in its
//!    own copy of the fixture, and diagnostics quote full paths.
//! 2. Wire byte counts and their derived rate/speedup become `#`: multiplexed
//!    frame boundaries depend on scheduling, even between identical reference
//!    runs. Logical file/literal/matched sizes and file-list statistics stay exact.
//! 3. `File list generation time:` / `File list transfer time:` seconds (in
//!    `--stats`) become `#`.
//! 4. Local-time stamps `YYYY/MM/DD hh:mm:ss` that fall inside the run's
//!    wall-clock window (± 2 s) become `{TIME}`: that is `%t` and the
//!    log-file line prefix. Stamps of pinned fixture mtimes (`--list-only`
//!    columns, `%M`) lie years outside the window and are compared as is.
//! 5. A `[pid]` right after a `{TIME}` at the start of a line (log files)
//!    becomes `[PID]`: the reference logs from forked processes.
//! 6. In `--version`, the indented lines under `Capabilities:` and
//!    `Optimizations:` are dropped: they describe the build (this
//!    implementation's capability set and its lack of SIMD/asm/OpenSSL code)
//!    rather than behavior. The header lines, the version line, the checksum,
//!    compress, and daemon-auth lists, and the license text still compare.

use std::sync::LazyLock;

use chrono::{Local, NaiveDateTime, TimeZone};
use regex::bytes::{Captures, Regex};

static RATE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?m)^(sent \S+ bytes  received \S+ bytes  )\S+( bytes/sec)$").unwrap());
static LIST_TIME: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?m)^(File list (?:generation|transfer) time: )[0-9.]+( seconds)$").unwrap());
static STAMP: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\d{4}/\d\d/\d\d \d\d:\d\d:\d\d").unwrap());
static PID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\{TIME\} \[\d+\]").unwrap());
static WIRE_TOTALS: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?m)^(Total bytes (?:sent|received): )[0-9][0-9,.]*[kMGTPE]?$").unwrap()
});
static WIRE_SUMMARY: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?m)^((?:\{TIME\} \[PID\] )?sent )[0-9][0-9,.]*[kMGTPE]?( bytes  received )[0-9][0-9,.]*[kMGTPE]?( bytes(?:  [^\n]+)?)$",
	)
	.unwrap()
});
static SPEEDUP: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?m)^(total size is [0-9][0-9,.]*[kMGTPE]?  speedup is )[0-9][0-9,.]*((?: \([A-Z ]+\))?)$").unwrap()
});

/// Applies every rule above to `data` produced in work directory `w` while
/// the wall clock was within `window` (Unix seconds, inclusive).
pub(super) fn normalize(data: &[u8], w: &[u8], window: (i64, i64)) -> Vec<u8> {
	let data = replace_all(data, w, b"{W}");
	let data = RATE.replace_all(&data, &b"${1}#${2}"[..]);
	let data = LIST_TIME.replace_all(&data, &b"${1}#${2}"[..]);
	let data = STAMP.replace_all(&data, |caps: &Captures<'_>| {
		let stamp = &caps[0];
		let during_run = std::str::from_utf8(stamp)
			.ok()
			.and_then(|s| NaiveDateTime::parse_from_str(s, "%Y/%m/%d %H:%M:%S").ok())
			.and_then(|local| Local.from_local_datetime(&local).earliest())
			.is_some_and(|t| (window.0 - 2..=window.1 + 2).contains(&t.timestamp()));
		if during_run { b"{TIME}".to_vec() } else { stamp.to_vec() }
	});
	let data = PID.replace_all(&data, &b"{TIME} [PID]"[..]);
	let data = WIRE_TOTALS.replace_all(&data, &b"${1}#"[..]);
	let data = WIRE_SUMMARY.replace_all(&data, &b"${1}#${2}#${3}"[..]);
	let data = SPEEDUP.replace_all(&data, &b"${1}#${2}"[..]);
	let mut out = Vec::with_capacity(data.len());
	let mut in_build_block = false;
	for (index, line) in data.split(|&b| b == b'\n').enumerate() {
		if in_build_block && line.starts_with(b"    ") {
			continue;
		}
		in_build_block = line == b"Capabilities:" || line == b"Optimizations:";
		if index > 0 {
			out.push(b'\n');
		}
		out.extend_from_slice(line);
	}
	out
}

fn replace_all(data: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(data.len());
	let mut rest = data;
	while let Some(at) = memchr::memmem::find(rest, needle) {
		out.extend_from_slice(&rest[..at]);
		out.extend_from_slice(with);
		rest = &rest[at + needle.len()..];
	}
	out.extend_from_slice(rest);
	out
}

#[cfg(test)]
mod tests {
	use super::normalize;

	#[test]
	fn framing_totals_do_not_change_logical_transfer_comparison() {
		let before = b"Total file size: 100 bytes\nLiteral data: 80 bytes\nMatched data: 20 bytes\nTotal bytes sent: 1,047\nTotal bytes received: 120\nsent 1,047 bytes  received 120 bytes  5 bytes/sec\ntotal size is 100  speedup is 0.09 (DRY RUN)\n";
		let after = b"Total file size: 100 bytes\nLiteral data: 80 bytes\nMatched data: 20 bytes\nTotal bytes sent: 1,051\nTotal bytes received: 124\nsent 1,051 bytes  received 124 bytes  7 bytes/sec\ntotal size is 100  speedup is 0.08 (DRY RUN)\n";
		assert_eq!(normalize(before, b"/fixture", (0, 0)), normalize(after, b"/fixture", (0, 0)));
		for [old_value, new_value] in [
			["Total file size: 100", "Total file size: 101"],
			["Literal data: 80", "Literal data: 81"],
			["Matched data: 20", "Matched data: 21"],
		] {
			let changed = std::str::from_utf8(before).unwrap().replace(old_value, new_value);
			assert_ne!(normalize(before, b"/fixture", (0, 0)), normalize(changed.as_bytes(), b"/fixture", (0, 0)));
		}
	}

	#[test]
	fn log_totals_preserve_file_events_and_logical_size() {
		let a = b"{TIME} [PID] >f+++++++++ source\n{TIME} [PID] sent 2065725 bytes  received 481 bytes  total size 2063417\n";
		let b = b"{TIME} [PID] >f+++++++++ source\n{TIME} [PID] sent 2065721 bytes  received 477 bytes  total size 2063417\n";
		assert_eq!(normalize(a, b"/fixture", (0, 0)), normalize(b, b"/fixture", (0, 0)));
		let changed_name = b"{TIME} [PID] >f+++++++++ other\n{TIME} [PID] sent 2065721 bytes  received 477 bytes  total size 2063417\n";
		let changed_size = b"{TIME} [PID] >f+++++++++ source\n{TIME} [PID] sent 2065721 bytes  received 477 bytes  total size 2063418\n";
		for changed in [changed_name.as_slice(), changed_size] {
			assert_ne!(normalize(a, b"/fixture", (0, 0)), normalize(changed, b"/fixture", (0, 0)));
		}
	}
}
