//! I/O boundary regressions with owned descriptors and isolated inherited
//! stdin.

#![cfg(unix)]

use std::{
	fs,
	io::{self, BufRead, Read, Seek, Write},
	path::Path,
	process::{Child, Command, Stdio},
	sync::mpsc,
	time::Duration,
};

use brush_core::{
	ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo,
	openfiles::{OpenFile, OpenFiles},
};
use pi_builtins::{BuiltinSet, default_builtins, utility_builtins};
use tokio_util::sync::CancellationToken;

async fn shell_in(root: &Path) -> Shell {
	let mut shell = Shell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.unwrap();
	for (name, builtin) in utility_builtins() {
		shell.register_builtin(name, builtin);
	}
	shell.set_working_dir(root).await.unwrap();
	shell
}

fn text(mut file: &fs::File) -> String {
	file.rewind().unwrap();
	let mut text = String::new();
	file.read_to_string(&mut text).unwrap();
	text
}

#[tokio::test]
async fn find_stdout_broken_pipe_still_returns_141_without_diagnostic() {
	let directory = tempfile::tempdir().unwrap();
	let error = tempfile::tempfile().unwrap();
	let (reader, writer) = io::pipe().unwrap();
	drop(reader);
	let mut shell = shell_in(directory.path()).await;
	let mut parameters = shell.default_exec_params();
	parameters.set_fd(OpenFiles::STDIN_FD, brush_core::openfiles::null().unwrap());
	parameters.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(writer));
	parameters.set_fd(OpenFiles::STDERR_FD, OpenFile::from(error.try_clone().unwrap()));
	let result = shell
		.run_string(
			"find . -maxdepth 0 -printf '%p\\n'",
			&SourceInfo::from("find-broken-pipe-control"),
			&parameters,
		)
		.await
		.unwrap();
	assert_eq!(u8::from(result.exit_code), 141);
	assert_eq!(text(&error), "");
}

#[tokio::test]
async fn find_explicit_fprintf_pipe_failure_remains_status_1() {
	use std::os::fd::OwnedFd;

	let directory = tempfile::tempdir().unwrap();
	let output = tempfile::tempfile().unwrap();
	let error = tempfile::tempfile().unwrap();
	let (reader, writer) = io::pipe().unwrap();
	drop(reader);
	let descriptor: OwnedFd = writer.into();
	let filesystem = pi_vfs::Fs::native()
		.mount_file("fault://output", pi_vfs::File::from(fs::File::from(descriptor)));
	let mut shell = shell_in(directory.path()).await;
	shell.set_filesystem(filesystem);
	let mut parameters = shell.default_exec_params();
	parameters.set_fd(OpenFiles::STDIN_FD, brush_core::openfiles::null().unwrap());
	parameters.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(output.try_clone().unwrap()));
	parameters.set_fd(OpenFiles::STDERR_FD, OpenFile::from(error.try_clone().unwrap()));
	let result = shell
		.run_string(
			"find . -maxdepth 0 -fprintf fault://output '%p\\n'",
			&SourceInfo::from("find-fprintf-control"),
			&parameters,
		)
		.await
		.unwrap();
	assert_eq!(u8::from(result.exit_code), 1);
	assert_eq!(text(&output), "");
	let diagnostic = text(&error);
	assert!(
		diagnostic.contains(&io::Error::from_raw_os_error(libc::EPIPE).to_string()),
		"{diagnostic}"
	);
	assert!(!diagnostic.contains("internal error"), "{diagnostic}");
}

struct OwnedChild(Child);

impl Drop for OwnedChild {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

const CHILD_MODE: &str = "PI_UPSTREAM_IO_STDIN_CHILD";
const INPUT: &[u8] = b"buffered line\nretained line\n";
const READY: &str = "UPSTREAM_IO_STDIN_READY";
const CANCELLED: &str = "UPSTREAM_IO_STDIN_CANCELLED";

fn assert_inherited_stdin(mode: &str) {
	let diagnostics = tempfile::tempfile().unwrap();
	let mut child = OwnedChild(
		Command::new(std::env::current_exe().unwrap())
			.args(["--exact", "inherited_stdin_mapfile_child", "--nocapture"])
			.env(CHILD_MODE, mode)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::from(diagnostics.try_clone().unwrap()))
			.spawn()
			.unwrap(),
	);
	let mut writer = child.0.stdin.take().unwrap();
	let reader = child.0.stdout.take().unwrap();
	let (ready_tx, ready_rx) = mpsc::channel();
	let (cancelled_tx, cancelled_rx) = mpsc::channel();
	let (done_tx, done_rx) = mpsc::channel();
	let drain = std::thread::spawn(move || {
		let mut transcript = String::new();
		let result = (|| -> io::Result<()> {
			for line in io::BufReader::new(reader).lines() {
				let line = line?;
				if line.contains(READY) {
					let _ = ready_tx.send(());
				}
				if line.contains(CANCELLED) {
					let _ = cancelled_tx.send(());
				}
				transcript.push_str(&line);
				transcript.push('\n');
			}
			Ok(())
		})();
		let _ = done_tx.send((transcript, result));
	});
	if mode != "blocking" {
		writer.write_all(INPUT).unwrap();
		writer.flush().unwrap();
	}
	let ready = ready_rx.recv_timeout(Duration::from_secs(10));
	let mut boundary_error = None;
	let mut completed_early = None;
	if mode == "blocking" {
		if let Err(error) = cancelled_rx.recv_timeout(Duration::from_secs(10)) {
			boundary_error = Some(format!("cancellation was not acknowledged: {error}"));
			let _ = child.0.kill();
		} else {
			match done_rx.try_recv() {
				Ok(done) => {
					completed_early = Some(done);
					boundary_error = Some("shared read ended before its input was released".into());
				},
				Err(mpsc::TryRecvError::Empty) => {
					if let Err(error) = writer.write_all(INPUT).and_then(|()| writer.flush()) {
						boundary_error = Some(format!("could not release shared read: {error}"));
						let _ = child.0.kill();
					}
				},
				Err(error) => {
					boundary_error = Some(format!("child output closed before release: {error}"));
					let _ = child.0.kill();
				},
			}
		}
	}
	let finished = match completed_early {
		Some(done) => Ok(done),
		None => done_rx.recv_timeout(Duration::from_secs(10)),
	};
	if finished.is_err() {
		let _ = child.0.kill();
	}
	let status = child.0.wait().unwrap();
	// The writer stays open until the child has finished; EOF cannot complete
	// mapfile.
	drop(writer);
	drain.join().unwrap();
	assert!(ready.is_ok(), "child never prepared inherited stdin: {}", text(&diagnostics));
	assert!(boundary_error.is_none(), "{boundary_error:?}");
	let (transcript, drained) = finished.expect("mapfile child did not unwind after cancellation");
	drained.unwrap();
	assert!(status.success(), "mode={mode}, {status}: {transcript}\n{}", text(&diagnostics));
}

#[test]
fn mapfile_inherited_stdin_completes_one_line_while_writer_stays_open() {
	assert_inherited_stdin("direct");
}

#[test]
fn mapfile_inherited_stdin_uses_already_buffered_bytes_while_writer_stays_open() {
	assert_inherited_stdin("prefilled");
}

#[test]
fn mapfile_precancelled_inherited_stdin_preserves_buffer_and_descriptor_flags() {
	assert_inherited_stdin("precancelled");
}

#[test]
fn mapfile_inflight_shared_stdin_read_waits_for_causal_input_release() {
	assert_inherited_stdin("blocking");
}

#[test]
fn host_utility_reads_buffered_inherited_stdin_while_writer_stays_open() {
	assert_inherited_stdin("host");
}

fn stdin_flags() -> libc::c_int {
	use std::os::fd::AsRawFd;
	// SAFETY: Stdin owns a live descriptor; F_GETFL does not mutate it.
	let flags = unsafe { libc::fcntl(io::stdin().as_raw_fd(), libc::F_GETFL) };
	assert!(flags >= 0, "{}", io::Error::last_os_error());
	flags
}

#[test]
fn inherited_stdin_mapfile_child() {
	let Ok(mode) = std::env::var(CHILD_MODE) else {
		return;
	};
	assert!(matches!(mode.as_str(), "direct" | "prefilled" | "host" | "precancelled" | "blocking"));
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.unwrap();
	let directory = tempfile::tempdir().unwrap();
	let output = tempfile::tempfile().unwrap();
	let error = tempfile::tempfile().unwrap();
	let mut shell = runtime.block_on(shell_in(directory.path()));
	let original_flags = stdin_flags();
	if matches!(mode.as_str(), "prefilled" | "host" | "precancelled") {
		assert_eq!(io::stdin().lock().fill_buf().unwrap(), INPUT);
	}
	let mut parameters = shell.default_exec_params();
	parameters.set_fd(OpenFiles::STDIN_FD, OpenFile::Stdin(io::stdin()));
	parameters.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(output.try_clone().unwrap()));
	parameters.set_fd(OpenFiles::STDERR_FD, OpenFile::from(error.try_clone().unwrap()));
	let token = CancellationToken::new();
	let observed_token = token.clone();
	parameters.set_cancel_token(token.clone());
	let (stop_tx, stop_rx) = mpsc::channel();
	let blocking = mode == "blocking";
	let canceller = std::thread::spawn(move || {
		if stop_rx.recv_timeout(Duration::from_secs(2)).is_err() {
			token.cancel();
			if blocking {
				println!("\n{CANCELLED}");
				io::stdout().flush().unwrap();
			}
		}
	});
	if mode == "precancelled" {
		observed_token.cancel();
	}
	let command = if mode == "host" {
		format!("head -c {}", INPUT.len())
	} else {
		"mapfile -t -n 1 lines && printf '<%s>\\n' \"${lines[0]}\"".into()
	};
	println!("\n{READY}");
	io::stdout().flush().unwrap();
	let result = runtime.block_on(shell.run_string(
		&command,
		&SourceInfo::from("inherited-buffered-stdin"),
		&parameters,
	));
	let _ = stop_tx.send(());
	canceller.join().unwrap();
	let result = result.unwrap();
	assert_eq!(stdin_flags(), original_flags, "mapfile changed inherited descriptor flags");
	if mode == "host" {
		assert_eq!(u8::from(result.exit_code), 0, "{}", text(&error));
		assert_eq!(text(&output).as_bytes(), INPUT);
		assert_eq!(text(&error), "");
		return;
	}
	if matches!(mode.as_str(), "precancelled" | "blocking") {
		assert!(observed_token.is_cancelled(), "shared input returned before cancellation");
		assert_eq!(u8::from(result.exit_code), 1);
		assert_eq!(text(&output), "");
		let mut first = String::new();
		io::stdin().read_line(&mut first).unwrap();
		let expected = if mode == "blocking" {
			"uffered line\n"
		} else {
			"buffered line\n"
		};
		assert_eq!(
			first, expected,
			"only an in-flight single-byte read may consume input after cancel"
		);
		let mut second = String::new();
		io::stdin().read_line(&mut second).unwrap();
		assert_eq!(second, "retained line\n");
		return;
	}
	assert_eq!(u8::from(result.exit_code), 0, "{}", text(&error));
	assert_eq!(text(&output), "<buffered line>\n");
	assert_eq!(text(&error), "");
	let mut remaining = String::new();
	io::stdin().read_line(&mut remaining).unwrap();
	assert_eq!(remaining, "retained line\n", "mapfile -n 1 consumed the next line");
}
