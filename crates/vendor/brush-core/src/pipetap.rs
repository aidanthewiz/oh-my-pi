//! Mirrored pipeline pipes: a copy of every byte one stage writes to the next,
//! for embedders that show a running pipeline's intermediate output — the
//! input a later `tail` or `grep` stage is still holding back.
//!
//! A tapped `|` is two pipes joined by a relay thread. The relay forwards each
//! chunk unchanged and hands the [`PipeMirror`] a copy, so both stages still
//! see an ordinary pipe: a slow consumer blocks the producer, the producer's
//! EOF reaches the consumer, and a consumer that exits early (`| head`)
//! widows the producer's pipe at once, because the relay watches for it and
//! lets go of the producer's end (`tail -f log | head -n1` ends with `head`).

use std::{
	io::{self, PipeReader, PipeWriter, Read, Write},
	sync::Arc,
};

use brush_parser::ast;

use crate::{error, ioutils, openfiles::OpenFile};

/// Optional hook mirroring the bytes that cross a pipeline's pipes.
pub trait PipeTap: Send + Sync {
	/// Opens a mirror for the pipe from `producer` into `consumer` (each
	/// stage's source text), or `None` to leave that pipe untapped.
	fn open(&self, producer: &str, consumer: &str) -> Option<Arc<dyn PipeMirror>>;
}

/// Receives a copy of a tapped pipe's bytes from its relay thread.
pub trait PipeMirror: Send + Sync {
	/// Records one chunk, called on the relay thread before the chunk is
	/// forwarded; it must not block.
	fn write(&self, bytes: &[u8]);
	/// Marks the pipe finished — the producer closed it, the consumer went
	/// away, or forwarding failed. Called exactly once per opened mirror,
	/// also when the relay could not start.
	fn close(&self);
}

/// Bytes the relay moves per read: a full pipe buffer on Linux.
const RELAY_CHUNK: usize = 64 * 1024;

/// Creates the pipe carrying `producer`'s output into `consumer` as
/// `(reader, writer)`: a plain pipe, or a relayed one when `tap` opens a
/// mirror for it.
pub(crate) fn pipe(
	tap: Option<&Arc<dyn PipeTap>>,
	producer: &ast::Command,
	consumer: &ast::Command,
) -> Result<(OpenFile, OpenFile), error::Error> {
	let (reader, writer) = ioutils::pipe("pipeline")?;
	let Some(mirror) =
		tap.and_then(|tap| tap.open(&producer.to_string(), &consumer.to_string()))
	else {
		return Ok((reader.into(), writer.into()));
	};
	let guard = MirrorGuard(mirror);
	let (relayed_reader, relayed_writer) = ioutils::pipe("pipeline")?;
	#[cfg(windows)]
	{
		use std::os::windows::io::AsRawHandle;
		for handle in [reader.as_raw_handle(), relayed_writer.as_raw_handle()] {
			windows_pipe_info(handle)?.ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?;
		}
	}
	std::thread::Builder::new()
		.name("brush-pipe-tap".into())
		.spawn(move || {
			if let Err(error) = relay(reader, relayed_writer, guard) {
				tracing::error!(%error, "pipeline pipe relay failed");
			}
		})?;
	Ok((relayed_reader.into(), writer.into()))
}

/// Closes its mirror when dropped, so every way a relay ends — or fails to
/// start — reports the pipe finished exactly once.
struct MirrorGuard(Arc<dyn PipeMirror>);

impl Drop for MirrorGuard {
	fn drop(&mut self) {
		self.0.close();
	}
}

/// Forwards `from` into `to`, copying each chunk to the mirror, until the
/// producer closes `from` or the consumer stops reading `to`. The last
/// parameter drops first: the mirror closes before dropping `to` exposes EOF
/// to the consumer, including on errors and unwinding.
fn relay(mut from: PipeReader, mut to: PipeWriter, guard: MirrorGuard) -> io::Result<()> {
	let mut buf = vec![0; RELAY_CHUNK];
	loop {
		#[cfg(unix)]
		if !wait_for_input(&from, &to) {
			return Ok(());
		}
		#[cfg(windows)]
		let read_limit = match windows_readable(&from, &to)? {
			Some(available) => available.min(buf.len()),
			None => return Ok(()),
		};
		#[cfg(not(windows))]
		let read_limit = buf.len();
		let read = match from.read(&mut buf[..read_limit]) {
			Ok(0) => return Ok(()),
			Ok(read) => read,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
			Err(error) => return Err(error),
		};
		guard.0.write(&buf[..read]);
		if let Err(error) = to.write_all(&buf[..read]) {
			return if error.kind() == io::ErrorKind::BrokenPipe { Ok(()) } else { Err(error) };
		}
	}
}

/// Blocks until `from` has bytes or EOF to read, or `to` lost its reader.
/// Returns `false` for the latter, so the relay stops without waiting for the
/// producer's next write and releases `from` at once, as the consumer's exit
/// would have done to an untapped pipe.
#[cfg(unix)]
fn wait_for_input(from: &PipeReader, to: &PipeWriter) -> bool {
	use std::os::fd::AsFd;

	use nix::{
		errno::Errno,
		poll::{PollFd, PollFlags, PollTimeout, poll},
	};

	loop {
		// POLLRDBAND like GNU tee: never ready on a pipe's write end, so only a
		// missing reader wakes that entry.
		let mut fds = [
			PollFd::new(from.as_fd(), PollFlags::POLLIN),
			PollFd::new(to.as_fd(), PollFlags::POLLRDBAND),
		];
		match poll(&mut fds, PollTimeout::NONE) {
			Ok(_) => {
				// Linux reports a widowed write end as POLLERR, Darwin as POLLHUP.
				let widowed = fds[1].revents().is_none_or(|revents| {
					revents.intersects(PollFlags::POLLERR | PollFlags::POLLHUP | PollFlags::POLLNVAL)
				});
				if widowed {
					return false;
				}
				if fds[0].revents().is_none_or(|revents| !revents.is_empty()) {
					return true;
				}
			},
			Err(Errno::EINTR) => {},
			// Let the read surface whatever went wrong.
			Err(_) => return true,
		}
	}
}

#[cfg(windows)]
fn windows_pipe_info(
	handle: std::os::windows::io::RawHandle,
) -> io::Result<Option<windows_sys::Wdk::Storage::FileSystem::FILE_PIPE_LOCAL_INFORMATION>> {
	use std::mem::MaybeUninit;

	use windows_sys::{
		Wdk::Storage::FileSystem::{
			FILE_PIPE_LOCAL_INFORMATION, FilePipeLocalInformation, NtQueryInformationFile,
		},
		Win32::{
			Foundation::{
				RtlNtStatusToDosError, STATUS_PIPE_BROKEN, STATUS_PIPE_CLOSING, STATUS_PIPE_DISCONNECTED,
			},
			System::IO::IO_STATUS_BLOCK,
		},
	};

	let mut status = MaybeUninit::<IO_STATUS_BLOCK>::uninit();
	let mut info = MaybeUninit::<FILE_PIPE_LOCAL_INFORMATION>::uninit();
	// The relay owns a synchronous pipe handle. STATUS_SUCCESS initializes
	// the complete fixed-size information buffer before this call returns.
	let result = unsafe {
		NtQueryInformationFile(
			handle,
			status.as_mut_ptr(),
			info.as_mut_ptr().cast(),
			size_of::<FILE_PIPE_LOCAL_INFORMATION>() as u32,
			FilePipeLocalInformation,
		)
	};
	match result {
		0 => {
			// STATUS_SUCCESS guarantees the query initialized `info`.
			Ok(Some(unsafe { info.assume_init() }))
		},
		STATUS_PIPE_BROKEN | STATUS_PIPE_CLOSING | STATUS_PIPE_DISCONNECTED => Ok(None),
		_ => {
			// NTSTATUS does not update the thread's Win32 last-error value.
			let code = unsafe { RtlNtStatusToDosError(result) };
			Err(io::Error::new(
				io::Error::from_raw_os_error(code as i32).kind(),
				format!("pipe state query failed (NTSTATUS {result:#010x}, Win32 {code})"),
			))
		},
	}
}

#[cfg(windows)]
fn windows_readable(from: &PipeReader, to: &PipeWriter) -> io::Result<Option<usize>> {
	use std::{os::windows::io::AsRawHandle, time::Duration};

	use windows_sys::Wdk::Storage::FileSystem::{
		FILE_PIPE_CLOSING_STATE, FILE_PIPE_CONNECTED_STATE, FILE_PIPE_DISCONNECTED_STATE,
	};

	loop {
		let Some(output) = windows_pipe_info(to.as_raw_handle())? else {
			return Ok(None);
		};
		match output.NamedPipeState {
			FILE_PIPE_CONNECTED_STATE => {},
			FILE_PIPE_CLOSING_STATE | FILE_PIPE_DISCONNECTED_STATE => return Ok(None),
			state => return Err(io::Error::other(format!("unexpected output pipe state {state}"))),
		}
		let Some(input) = windows_pipe_info(from.as_raw_handle())? else {
			return Ok(None);
		};
		if input.ReadDataAvailable > 0 {
			return Ok(Some(input.ReadDataAvailable as usize));
		}
		match input.NamedPipeState {
			FILE_PIPE_CONNECTED_STATE => {},
			FILE_PIPE_CLOSING_STATE | FILE_PIPE_DISCONNECTED_STATE => return Ok(None),
			state => return Err(io::Error::other(format!("unexpected input pipe state {state}"))),
		}
		// Anonymous synchronous pipes have no read-readiness event. Never
		// block ReadFile on an empty pipe while its consumer may disappear.
		std::thread::sleep(Duration::from_millis(10));
	}
}

#[cfg(all(test, any(unix, windows)))]
mod tests {
	use std::{sync::mpsc, time::Duration};

	use super::*;

	enum MirrorEvent {
		Bytes(Vec<u8>),
		Closed,
	}

	struct RecordingMirror(mpsc::Sender<MirrorEvent>);

	impl PipeMirror for RecordingMirror {
		fn write(&self, bytes: &[u8]) {
			self.0.send(MirrorEvent::Bytes(bytes.to_vec())).unwrap();
		}

		fn close(&self) {
			self.0.send(MirrorEvent::Closed).unwrap();
		}
	}

	fn captured(events: mpsc::Receiver<MirrorEvent>) -> (Vec<u8>, usize) {
		let mut bytes = Vec::new();
		let mut closes = 0;
		for event in events.try_iter() {
			match event {
				MirrorEvent::Bytes(chunk) => bytes.extend(chunk),
				MirrorEvent::Closed => closes += 1,
			}
		}
		(bytes, closes)
	}

	#[test]
	fn idle_producer_is_released_when_consumer_exits() {
		let (from, mut producer) = io::pipe().unwrap();
		let (mut consumer, to) = io::pipe().unwrap();
		let (events, recorded) = mpsc::channel();
		let guard = MirrorGuard(Arc::new(RecordingMirror(events)));
		let (finished, completion) = mpsc::channel();
		let worker = std::thread::spawn(move || {
			relay(from, to, guard).unwrap();
			finished.send(()).unwrap();
		});

		let bytes = "界𝄞".as_bytes();
		producer.write_all(bytes).unwrap();
		let mut forwarded = [0; 7];
		consumer.read_exact(&mut forwarded).unwrap();
		drop(consumer);
		let closed_while_idle = completion.recv_timeout(Duration::from_secs(2));
		let producer_error = closed_while_idle
			.is_ok()
			.then(|| producer.write_all(b"late").unwrap_err().kind());
		// Release a regressed blocking read before joining, even on failure.
		drop(producer);
		worker.join().unwrap();

		assert!(closed_while_idle.is_ok(), "relay waited for the idle producer to write again");
		assert_eq!(producer_error, Some(io::ErrorKind::BrokenPipe));
		assert_eq!(forwarded, bytes);
		assert_eq!(captured(recorded), (bytes.to_vec(), 1));
	}

	#[test]
	fn producer_eof_preserves_every_byte_and_closes_the_mirror() {
		let (from, mut producer) = io::pipe().unwrap();
		let (mut consumer, to) = io::pipe().unwrap();
		let (events, recorded) = mpsc::channel();
		let guard = MirrorGuard(Arc::new(RecordingMirror(events)));
		let relay_worker = std::thread::spawn(move || relay(from, to, guard).unwrap());
		let bytes: Vec<u8> = (0..RELAY_CHUNK * 3 + 17).map(|n| n as u8).collect();
		let expected = bytes.clone();
		let producer_worker = std::thread::spawn(move || producer.write_all(&bytes).unwrap());

		let mut forwarded = Vec::new();
		consumer.read_to_end(&mut forwarded).unwrap();
		producer_worker.join().unwrap();
		relay_worker.join().unwrap();

		assert_eq!(forwarded, expected);
		assert_eq!(captured(recorded), (expected, 1));
	}

	#[cfg(unix)]
	#[test]
	fn mirror_closes_before_consumer_eof() {
		use std::os::fd::AsFd;

		use nix::poll::{PollFd, PollFlags, PollTimeout, poll};

		struct EofOrderMirror {
			consumer: PipeReader,
			events:   RecordingMirror,
		}

		impl PipeMirror for EofOrderMirror {
			fn write(&self, bytes: &[u8]) {
				self.events.write(bytes);
			}

			fn close(&self) {
				let mut fds = [PollFd::new(self.consumer.as_fd(), PollFlags::POLLIN)];
				poll(&mut fds, PollTimeout::ZERO).unwrap();
				assert!(
					!fds[0].revents().unwrap().contains(PollFlags::POLLHUP),
					"consumer received EOF before the mirror closed",
				);
				self.events.close();
			}
		}

		let (from, mut producer) = io::pipe().unwrap();
		let (mut consumer, to) = io::pipe().unwrap();
		let (events, recorded) = mpsc::channel();
		let guard = MirrorGuard(Arc::new(EofOrderMirror {
			consumer: consumer.try_clone().unwrap(),
			events:   RecordingMirror(events),
		}));
		let worker = std::thread::spawn(move || relay(from, to, guard).unwrap());
		let bytes = "界𝄞".as_bytes();
		producer.write_all(bytes).unwrap();
		drop(producer);
		let mut forwarded = Vec::new();
		consumer.read_to_end(&mut forwarded).unwrap();
		worker.join().unwrap();

		assert_eq!(forwarded, bytes);
		assert_eq!(captured(recorded), (bytes.to_vec(), 1));
	}

	#[cfg(windows)]
	#[test]
	fn windows_query_failure_is_not_eof() {
		assert!(windows_pipe_info(std::ptr::null_mut()).is_err());
	}
}
