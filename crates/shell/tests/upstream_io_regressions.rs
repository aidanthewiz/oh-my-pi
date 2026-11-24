//! I/O boundary regressions with owned descriptors and isolated inherited
//! stdin.

#![cfg(unix)]

use std::{
	fs,
	io::{self, BufRead, Read, Seek, Write},
	os::fd::OwnedFd,
	path::Path,
	process::{Child, Command, Stdio},
	sync::mpsc,
	time::Duration,
};

use omp_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, MemStore, Profile, Script, Shell, ShellInit, Signal, Step,
		Vpid,
	},
	process::{self, NativeHost},
	session::{RunStdio, Session, SessionConfig},
	vfs::VfsFs,
};
use tokio_util::sync::CancellationToken;

fn shell_in(root: &Path, filesystem: omp_vfs::Fs) -> Session {
	let runtime = tokio::runtime::Handle::current();
	let vfs = VfsFs::new(filesystem, runtime.clone());
	Session::new(SessionConfig {
		env: Vec::new(),
		cwd: root.as_os_str().as_encoded_bytes().into(),
		fs: Box::new(vfs.clone()),
		vfs: Some(vfs),
		runtime,
		output_decoding: None,
	})
	.unwrap()
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
	let descriptor: OwnedFd = writer.into();
	let mut shell = shell_in(directory.path(), omp_vfs::Fs::native());
	let result = shell
		.run(
			"find . -maxdepth 0 -printf '%p\\n'",
			RunStdio {
				stdin:  None,
				stdout: Some(fs::File::from(descriptor)),
				stderr: Some(error.try_clone().unwrap()),
			},
			CancellationToken::new(),
		)
		.await
		.unwrap();
	assert_eq!(result.status, 141);
	assert_eq!(text(&error), "");
}

#[tokio::test]
async fn find_explicit_fprintf_pipe_failure_remains_status_1() {
	let directory = tempfile::tempdir().unwrap();
	let output = tempfile::tempfile().unwrap();
	let error = tempfile::tempfile().unwrap();
	let (reader, writer) = io::pipe().unwrap();
	drop(reader);
	let descriptor: OwnedFd = writer.into();
	let filesystem = omp_vfs::Fs::native()
		.mount_file("fault://output", omp_vfs::File::from(fs::File::from(descriptor)));
	let mut shell = shell_in(directory.path(), filesystem);
	let result = shell
		.run(
			"find . -maxdepth 0 -fprintf fault://output '%p\\n'",
			RunStdio {
				stdin:  None,
				stdout: Some(output.try_clone().unwrap()),
				stderr: Some(error.try_clone().unwrap()),
			},
			CancellationToken::new(),
		)
		.await
		.unwrap();
	assert_eq!(result.status, 1);
	assert_eq!(text(&output), "");
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
	let regular = if mode == "regular" {
		let mut file = tempfile::tempfile().unwrap();
		file.write_all(INPUT).unwrap();
		file.rewind().unwrap();
		Some(file)
	} else {
		None
	};
	let diagnostics = tempfile::tempfile().unwrap();
	let mut child = OwnedChild(
		Command::new(std::env::current_exe().unwrap())
			.args(["--exact", "inherited_stdin_mapfile_child", "--nocapture"])
			.env(CHILD_MODE, mode)
			.env("PI_DISABLE_UUTILS_BUILTINS", "0")
			.stdin(regular.map_or_else(Stdio::piped, Stdio::from))
			.stdout(Stdio::piped())
			.stderr(Stdio::from(diagnostics.try_clone().unwrap()))
			.spawn()
			.unwrap(),
	);
	let mut writer = child.0.stdin.take();
	let reader = child.0.stdout.take().unwrap();
	let (ready_tx, ready_rx) = mpsc::channel();
	let (cancelled_tx, cancelled_rx) = mpsc::channel();
	let (forwarded_tx, forwarded_rx) = mpsc::channel();
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
				if line == "retained line" {
					let _ = forwarded_tx.send(());
				}
				transcript.push_str(&line);
				transcript.push('\n');
			}
			Ok(())
		})();
		let _ = done_tx.send((transcript, result));
	});
	if !matches!(mode, "pending_cancel" | "regular" | "ready_empty" | "ready_buffered") {
		let writer = writer.as_mut().unwrap();
		writer.write_all(INPUT).unwrap();
		writer.flush().unwrap();
	}
	if mode == "external_closed" {
		drop(writer.take());
	}
	let ready = ready_rx.recv_timeout(Duration::from_secs(10));
	let mut boundary_error = None;
	if mode == "external_open" {
		if let Err(error) = forwarded_rx.recv_timeout(Duration::from_secs(10)) {
			boundary_error = Some(format!("cat did not receive remaining input before EOF: {error}"));
			let _ = child.0.kill();
		}
		drop(writer.take());
	}
	if mode == "pending_cancel" {
		if let Err(error) = cancelled_rx.recv_timeout(Duration::from_secs(10)) {
			boundary_error = Some(format!("pending read did not cancel before input: {error}"));
			let _ = child.0.kill();
		} else {
			let writer = writer.as_mut().unwrap();
			if let Err(error) = writer.write_all(INPUT).and_then(|()| writer.flush()) {
				boundary_error = Some(format!("cancelled stdin could not accept later input: {error}"));
				let _ = child.0.kill();
			}
		}
	}
	let finished = done_rx.recv_timeout(Duration::from_secs(10));
	if finished.is_err() {
		let _ = child.0.kill();
	}
	let status = child.0.wait().unwrap();
	// Except for cat's EOF cases, the child must finish before its writer
	// closes.
	drop(writer);
	drain.join().unwrap();
	assert!(ready.is_ok(), "child never prepared inherited stdin: {}", text(&diagnostics));
	assert!(boundary_error.is_none(), "{boundary_error:?}");
	let (transcript, drained) = finished.expect("stdin child did not complete");
	drained.unwrap();
	assert!(status.success(), "mode={mode}, {status}: {transcript}\n{}", text(&diagnostics));
	match mode {
		"mapfile" | "regular" | "external_finite" | "precancelled" | "pending_cancel" => {
			assert!(
				transcript.contains("BOUNDARY:<buffered line><retained line>\n"),
				"sequential stdin consumers lost input: {transcript}"
			);
		},
		"utility" | "external_closed" | "external_open" => {
			assert!(
				transcript.contains("BOUNDARY:<buffered line>\nretained line\n"),
				"stdin handoff lost input: {transcript}"
			);
		},
		"ready_empty" => {
			assert!(transcript.contains("BOUNDARY:empty=1\n"), "{transcript}");
		},
		"ready_readable" => {
			for expected in [
				"BOUNDARY:readable=0\n",
				"BOUNDARY:remaining=0\n",
				"BOUNDARY:empty=1\n",
				"BOUNDARY:<buffered line><retained line>\n",
			] {
				assert!(transcript.contains(expected), "missing {expected:?}: {transcript}");
			}
		},
		"ready_buffered" => {
			assert!(transcript.contains("BOUNDARY:buffered=0\n"), "{transcript}");
			assert!(
				transcript.contains("BOUNDARY:<buffered line><retained line>\n"),
				"readiness consumed buffered input: {transcript}"
			);
		},
		_ => unreachable!(),
	}
}

#[test]
fn mapfile_leaves_the_next_line_for_another_builtin_while_writer_stays_open() {
	assert_inherited_stdin("mapfile");
}

#[test]
fn mapfile_leaves_remaining_stdin_for_a_host_utility_while_writer_stays_open() {
	assert_inherited_stdin("utility");
}

#[test]
fn precancelled_stdin_preserves_input_and_descriptor_flags() {
	assert_inherited_stdin("precancelled");
}

#[test]
fn pending_stdin_read_cancels_before_later_input_without_consuming_it() {
	assert_inherited_stdin("pending_cancel");
}

#[test]
fn builtin_to_external_preserves_remaining_input_after_pipe_eof() {
	assert_inherited_stdin("external_closed");
}

#[test]
fn builtin_to_external_forwards_remaining_input_before_pipe_eof() {
	assert_inherited_stdin("external_open");
}

#[test]
fn finite_external_after_builtin_completes_while_writer_stays_open() {
	assert_inherited_stdin("external_finite");
}

#[test]
fn consecutive_reads_preserve_regular_file_stdin() {
	assert_inherited_stdin("regular");
}

#[test]
fn zero_timeout_read_rejects_empty_pipe_while_writer_stays_open() {
	assert_inherited_stdin("ready_empty");
}

#[test]
fn zero_timeout_read_checks_readable_pipe_without_consuming() {
	assert_inherited_stdin("ready_readable");
}

#[test]
fn zero_timeout_read_checks_engine_buffer_without_consuming() {
	assert_inherited_stdin("ready_buffered");
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
	let original_flags = stdin_flags();
	let mut host = NativeHost::new(None, false, Vec::new(), Default::default(), 0, true);
	host.offer_extras(&[]);
	let config = EngineConfig::default();
	let engine = Engine::new(config);
	let mut store = MemStore::new();
	let directory = tempfile::tempdir().unwrap();
	let create = |host: &mut NativeHost, store: &mut MemStore| {
		Shell::create(&engine, &mut Cx { host, store }, ShellInit {
			cwd: directory.path().as_os_str().as_encoded_bytes().into(),
			profile: Profile::Tool,
			..ShellInit::default()
		})
		.unwrap()
	};
	let mut shell = create(&mut host, &mut store);
	let two_lines =
		"read -r first && read -r second && printf 'BOUNDARY:<%s><%s>\\n' \"$first\" \"$second\"";
	let command = match mode.as_str() {
		"mapfile" => "mapfile -t -n 1 lines && read -r second && printf 'BOUNDARY:<%s><%s>\\n' \
		              \"${lines[0]}\" \"$second\""
			.into(),
		"utility" => {
			format!(
				"mapfile -t -n 1 lines && printf 'BOUNDARY:<%s>\\n' \"${{lines[0]}}\" && head -c {}",
				b"retained line\n".len()
			)
		},
		"precancelled" | "pending_cancel" => "mapfile -t -n 1 lines".into(),
		"external_closed" | "external_open" => {
			"read -r first && printf 'BOUNDARY:<%s>\\n' \"$first\" && /bin/cat".into()
		},
		"external_finite" => "read -r first && printf 'BOUNDARY:<%s>' \"$first\" && /bin/sh -c \
		                      'IFS= read -r second && printf \"<%s>\\n\" \"$second\"'"
			.into(),
		"regular" => two_lines.into(),
		"ready_empty" => "read -t 0; printf 'BOUNDARY:empty=%s\\n' \"$?\"".into(),
		"ready_readable" => "read -t 0; printf 'BOUNDARY:readable=%s\\n' \"$?\"; read -r first; \
		                     read -t 0; printf 'BOUNDARY:remaining=%s\\n' \"$?\"; read -r second; \
		                     read -t 0; printf 'BOUNDARY:empty=%s\\n' \"$?\"; printf \
		                     'BOUNDARY:<%s><%s>\\n' \"$first\" \"$second\""
			.into(),
		"ready_buffered" => {
			let input = directory.path().join("stdin");
			fs::write(&input, INPUT).unwrap();
			let input = input.display().to_string().replace('\'', "'\\''");
			format!(
				"{{ read -r first; read -t 0; printf 'BOUNDARY:buffered=%s\\n' \"$?\"; read -r \
				 second; printf 'BOUNDARY:<%s><%s>\\n' \"$first\" \"$second\"; }} <'{input}'"
			)
		},
		_ => panic!("unknown stdin mode: {mode}"),
	};
	let run = shell.submit(Script::command(command.into_bytes()));
	if mode == "pending_cancel" {
		loop {
			match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
				Step::Blocked => break,
				Step::Yield => {},
				_ => panic!("empty inherited stdin did not suspend mapfile"),
			}
		}
	}
	if matches!(mode.as_str(), "precancelled" | "pending_cancel") {
		shell.control().cancel(Signal::Term);
	}
	println!("\n{READY}");
	io::stdout().flush().unwrap();
	let status = process::drive(&mut host, &mut store, &mut shell, run, Vpid(config.vpid_base));
	drop(shell);
	assert_eq!(stdin_flags(), original_flags, "inherited descriptor flags changed");
	if matches!(mode.as_str(), "precancelled" | "pending_cancel") {
		assert_eq!(status, 143);
		println!("\n{CANCELLED}");
		io::stdout().flush().unwrap();
		let mut recovered = create(&mut host, &mut store);
		let run = recovered.submit(Script::command(two_lines.as_bytes()));
		assert_eq!(
			process::drive(&mut host, &mut store, &mut recovered, run, Vpid(config.vpid_base)),
			0
		);
		drop(recovered);
		assert_eq!(stdin_flags(), original_flags, "recovered input changed descriptor flags");
	} else {
		assert_eq!(status, 0);
	}
}
