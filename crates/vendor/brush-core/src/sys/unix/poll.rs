//! File descriptor polling utilities for timeout support.

use std::{
	os::fd::BorrowedFd,
	time::{Duration, Instant},
};

use crate::openfiles::OpenFile;

/// Polls an open file for input readability with a timeout.
///
/// Returns `Ok(true)` if data is available for reading, `Ok(false)` if the
/// timeout elapsed without data becoming available.
///
/// For regular files, always returns `Ok(true)` immediately since they're
/// always "ready" (matching bash behavior where `-t` has no effect on regular
/// files).
///
/// # Arguments
///
/// * `file` - The open file to poll.
/// * `timeout` - Maximum time to wait. Use `Duration::ZERO` to check without
///   blocking.
///
/// # Errors
///
/// Returns an error if polling fails or the file descriptor cannot be borrowed.
pub fn poll_for_input(file: &OpenFile, timeout: Duration) -> std::io::Result<bool> {
	let fd = file
		.try_borrow_as_fd()
		.map_err(|e| std::io::Error::other(e.to_string()))?;

	// Regular files are always ready - timeout has no effect (bash behavior).
	// The null device reads as immediate EOF, but on macOS/BSD `poll()` never
	// reports `/dev/null` as readable. Without this shortcut a `read` builtin
	// with no `-t` deadline polls it forever (the harness wires stdin to
	// `/dev/null`). Treat both as ready and let the caller's `read` observe the
	// data or EOF, matching `read </dev/null` in real bash (instant EOF, exit 1).
	if !pi_vfs::fd_reads_can_block(fd) {
		return Ok(true);
	}

	// Convert timeout to deadline for accurate time tracking across EINTR retries.
	let deadline = Instant::now() + timeout;

	poll_fd_for_input(fd, deadline)
}

/// Polls a file descriptor for input readability with a deadline.
///
/// Returns `Ok(true)` if data is available, `Ok(false)` if deadline passed.
///
/// # Arguments
///
/// * `fd` - File descriptor to poll
/// * `deadline` - Maximum time to wait.
fn poll_fd_for_input(fd: BorrowedFd<'_>, deadline: Instant) -> std::io::Result<bool> {
	let mut first_iteration = true;

	loop {
		let remaining = deadline.saturating_duration_since(Instant::now());
		if remaining.is_zero() && !first_iteration {
			return Ok(false);
		}
		first_iteration = false;

		match pi_vfs::readable_within(fd, remaining) {
			Ok(true) => return Ok(true),
			Ok(false) => {},
			Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
			Err(error) => return Err(error),
		}
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;

	#[test]
	fn null_device_polls_ready() {
		// Regression: on macOS `poll(/dev/null, POLLIN)` times out forever, so a
		// `read` with no `-t` deadline hangs. `poll_for_input` must report ready.
		let Ok(null) = crate::openfiles::null() else { return };
		let ready = poll_for_input(&null, Duration::from_millis(50));
		assert!(matches!(ready, Ok(true)));
	}

	#[test]
	fn regular_file_polls_ready() {
		let Ok(tmp) = tempfile::NamedTempFile::new() else { return };
		let file = crate::openfiles::OpenFile::from(tmp.reopen().expect("reopen temp file"));
		assert!(matches!(poll_for_input(&file, Duration::ZERO), Ok(true)));
	}
}
