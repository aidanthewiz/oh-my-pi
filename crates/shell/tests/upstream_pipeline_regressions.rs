#![cfg(unix)]

use std::{
	io::Read as _,
	os::unix::{fs::PermissionsExt as _, prelude::OpenOptionsExt as _},
	path::{Path, PathBuf},
	time::Duration,
};

use omp_shell::{Shell, ShellOptions, ShellRunOptions, ShellRunResult, cancel::CancelToken};

async fn run(command: &str, cwd: &Path) -> (ShellRunResult, String) {
	let shell = Shell::new(Some(ShellOptions { clear_env: true, ..Default::default() }));
	run_in_shell(&shell, command, cwd).await
}

async fn run_in_shell(shell: &Shell, command: &str, cwd: &Path) -> (ShellRunResult, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = tokio::time::timeout(
		Duration::from_secs(20),
		shell.run(
			ShellRunOptions {
				command: command.to_owned(),
				cwd: Some(cwd.to_string_lossy().into_owned()),
				timeout_ms: Some(5_000),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(Some(5_000)),
		),
	)
	.await
	.expect("bounded shell execution")
	.expect("shell execution");
	let output = rx.drain().collect();
	assert!(!result.cancelled && !result.timed_out, "shell did not finish: {output}");
	(result, output)
}

fn external_command(root: &Path, name: &str) -> String {
	let search_path = std::env::var_os("PATH")
		.map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
		.unwrap_or_default();
	let executable = [PathBuf::from("/usr/bin"), PathBuf::from("/bin")]
		.into_iter()
		.chain(search_path)
		.map(|directory| directory.join(name))
		.find(|candidate| {
			candidate
				.metadata()
				.is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
		})
		.unwrap_or_else(|| panic!("external {name} executable"));
	let directory = std::fs::canonicalize(executable.parent().expect("executable directory"))
		.expect("absolute executable directory");
	let local_directory = format!("external-{name}-bin");
	std::os::unix::fs::symlink(directory, root.join(&local_directory))
		.expect("owned external-directory symlink");
	format!("./{local_directory}/{name}")
}

#[tokio::test(flavor = "multi_thread")]
async fn background_missing_pipeline_expands_side_effect_once() {
	let root = tempfile::tempdir().expect("pipeline directory");
	let (result, output) =
		run("./missing-a \"$(printf x >> count)\" | ./missing-b & wait %1", root.path()).await;

	assert_eq!(
		std::fs::read(root.path().join("count")).expect("substitution side effect"),
		b"x",
		"a failed launch must not replay an already expanded pipeline: {output}",
	);
	assert_eq!(result.exit_code, Some(127), "{output}");
}

#[tokio::test(flavor = "multi_thread")]
async fn background_pipeline_preserves_missing_final_stage_status() {
	let root = tempfile::tempdir().expect("pipeline directory");
	let external_true = external_command(root.path(), "true");
	let (control, output) =
		run(&format!("{external_true} | {external_true} & wait %1"), root.path()).await;
	assert_eq!(control.exit_code, Some(0), "{output}");

	let (result, output) =
		run(&format!("{external_true} | ./missing-final & wait %1"), root.path()).await;
	assert_eq!(result.exit_code, Some(127), "{output}");
}

#[tokio::test(flavor = "multi_thread")]
async fn background_pipeline_uses_launch_time_pipefail() {
	let root = tempfile::tempdir().expect("pipeline directory");
	let external_true = external_command(root.path(), "true");
	for (launch, wait, expected) in [("+o", "-o", 0), ("-o", "+o", 7)] {
		let command = format!(
			"set {launch} pipefail; /bin/sh -c 'exit 7' | {external_true} & set {wait} pipefail; \
			 wait %1"
		);
		let (result, output) = run(&command, root.path()).await;
		assert_eq!(result.exit_code, Some(expected), "{command}: {output}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn background_command_name_substitution_is_not_a_dispatch_probe() {
	for background in [false, true] {
		let root = tempfile::tempdir().expect("command expansion directory");
		let suffix = if background { " & wait %1" } else { "" };
		let (result, output) =
			run(&format!("$(printf x >> count; printf ./missing-command){suffix}"), root.path()).await;
		assert_eq!(std::fs::read(root.path().join("count")).unwrap(), b"x", "{output}");
		assert_eq!(result.exit_code, Some(127), "{output}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_status_tracks_stage_order_and_launch_policy() {
	let root = tempfile::tempdir().expect("ordered pipeline directory");
	let external_true = external_command(root.path(), "true");
	for (pipeline, pipefail, expected, wait) in [
		(format!("./missing-first | {external_true}"), false, 0, "wait \"$!\""),
		(format!("./missing-first | {external_true}"), true, 127, "wait \"$!\""),
		(
			format!("/bin/sh -c 'exit 7' | ./missing-middle | {external_true}"),
			true,
			127,
			"wait \"$!\"",
		),
		(
			"/bin/sh -c 'exit 7' | ./missing-middle | /bin/sh -c 'exit 3'".to_owned(),
			true,
			3,
			"wait \"$!\"",
		),
		("./missing-first | ./missing-last".to_owned(), false, 127, "wait %1"),
	] {
		let launch = if pipefail { "-o" } else { "+o" };
		let later = if pipefail { "+o" } else { "-o" };
		for background in [false, true] {
			let command = if background {
				format!("set {launch} pipefail; {pipeline} & set {later} pipefail; {wait}")
			} else {
				format!("set {launch} pipefail; {pipeline}")
			};
			let (result, output) = run(&command, root.path()).await;
			assert_eq!(result.exit_code, Some(expected), "{command}: {output}");
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn blocked_fifo_spawn_does_not_hold_another_jobs_pipe_open() {
	let root = tempfile::tempdir().expect("independent pipe directory");
	let external_cat = external_command(root.path(), "cat");
	for name in ["producer-gate", "blocked"] {
		omp_vfs::BlockingFs::native()
			.make_node(root.path().join(name), omp_vfs::NodeKind::Fifo, 0o600)
			.expect("owned FIFO");
	}
	let command = format!(
		"{{ /bin/sh -c 'read -r token < producer-gate; printf \"hi\\n\"' | {external_cat} \
		 >pipe.payload & reader=$!; /bin/sh -c 'printf retained >&7' <blocked & fifo=$!; printf \
		 'release\\n' >producer-gate; wait \"$reader\"; reader_status=$?; : >blocked; wait \
		 \"$fifo\"; fifo_status=$?; printf '%s|%s\\n' \"$reader_status\" \"$fifo_status\"; }} \
		 7>extra.payload"
	);
	let (result, output) = run(&command, root.path()).await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "0|0\n");
	assert_eq!(std::fs::read(root.path().join("pipe.payload")).unwrap(), b"hi\n");
	assert_eq!(std::fs::read(root.path().join("extra.payload")).unwrap(), b"retained");
}

#[tokio::test(flavor = "multi_thread")]
async fn command_expansions_keep_ambient_descriptors_outside_own_redirects() {
	let root = tempfile::tempdir().expect("expansion descriptor directory");
	let external_printf = external_command(root.path(), "printf");
	let external_cat = external_command(root.path(), "cat");
	std::fs::write(root.path().join("input"), b"INPUT\n").unwrap();
	for fifo in ["words", "operand", "assignment"] {
		omp_vfs::BlockingFs::native()
			.make_node(root.path().join(fifo), omp_vfs::NodeKind::Fifo, 0o600)
			.expect("create owned FIFO");
	}
	let commands = [
		format!(
			"{{ /bin/sh -c 'printf \"[%s]\" \"$1\"; printf OUTER >&2' _ >words 2>&1 \"$(/bin/sh -c \
			 'read -r value <&3; printf \"%s\" \"$value\"; printf INNER >&2; printf EXTRA >&4')\" & \
			 {external_cat} <words >words.payload; wait %1; }} 3<input 4>extra 2>words.err"
		),
		format!(
			"{{ {external_printf} PAYLOAD >operand 2>\"$(printf child.err; printf OPERAND >&2)\" & \
			 {external_cat} <operand >operand.payload; wait %1; }} 2>operand.err"
		),
		format!(
			"{{ VALUE=\"$(printf VALUE; printf ASSIGN >&2)\" /bin/sh -c 'printf \"[%s]\" \"$VALUE\"' \
			 >assignment 2>&1 & {external_cat} <assignment >assignment.payload; wait %1; }} \
			 2>assignment.err"
		),
		format!(
			"{{ {external_printf} '[%s]' </dev/null \"$({external_cat})\" >stdin.payload; \
			 >only.redirect VALUE=\"$(printf ONLY; printf ASSIGNMENT_ONLY >&2)\"; printf '%s' \
			 \"$VALUE\" >only.value; }} <input 2>only.err"
		),
	];
	for command in commands {
		let (result, output) = run(&command, root.path()).await;
		assert_eq!(result.exit_code, Some(0), "{command}: {output}");
	}
	for (file, expected) in [
		("words.payload", "[INPUT]OUTER"),
		("words.err", "INNER"),
		("extra", "EXTRA"),
		("operand.payload", "PAYLOAD"),
		("operand.err", "OPERAND"),
		("assignment.payload", "[VALUE]"),
		("assignment.err", "ASSIGN"),
		("stdin.payload", "[INPUT]"),
		("only.value", "ONLY"),
		("only.err", "ASSIGNMENT_ONLY"),
	] {
		assert_eq!(std::fs::read(root.path().join(file)).unwrap(), expected.as_bytes(), "{file}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn background_fifo_redirect_preserves_command_substitution_stdout() {
	let root = tempfile::tempdir().expect("FIFO directory");
	let external_printf = external_command(root.path(), "printf");
	let fifo = root.path().join("f");
	omp_vfs::BlockingFs::native()
		.make_node(&fifo, omp_vfs::NodeKind::Fifo, 0o600)
		.expect("create owned FIFO");
	let mut endpoint = std::fs::OpenOptions::new()
		.read(true)
		.write(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(&fifo)
		.expect("hold both FIFO ends without a blocking rendezvous");

	let (control, output) =
		run(&format!("{external_printf} '[%s]' > regular \"$({external_printf} SUB)\""), root.path())
			.await;
	assert_eq!(control.exit_code, Some(0), "{output}");
	assert_eq!(std::fs::read(root.path().join("regular")).unwrap(), b"[SUB]");

	let (result, output) = run(
		&format!("{external_printf} '[%s]' > f \"$({external_printf} SUB)\" & wait %1"),
		root.path(),
	)
	.await;
	assert_eq!(result.exit_code, Some(0), "{output}");
	let mut bytes = [0_u8; 64];
	let count = endpoint.read(&mut bytes).expect("completed FIFO payload");
	assert_eq!(&bytes[..count], b"[SUB]", "outer redirection captured substitution output");
	assert_eq!(
		endpoint.read(&mut bytes).unwrap_err().kind(),
		std::io::ErrorKind::WouldBlock,
		"the FIFO must contain exactly the command's payload",
	);
}

async fn stopped_pipeline_pids(root: &Path) -> [i32; 2] {
	tokio::time::timeout(Duration::from_secs(5), async {
		loop {
			let pids = ["first.pid", "last.pid"].map(|file| {
				std::fs::read_to_string(root.join(file))
					.ok()
					.and_then(|text| text.parse::<i32>().ok())
					.filter(|pid| *pid > 0)
			});
			if let [Some(first), Some(last)] = pids {
				let processes = omp_builtins::ProcInfo::all();
				if [first, last].iter().all(|pid| {
					processes
						.iter()
						.any(|process| process.pid() == *pid && process.state() == 'T')
				}) {
					break [first, last];
				}
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("both owned stages must stop before bg")
}

async fn isolated_stopped_job_test(name: &str) -> bool {
	const MARKER: &str = "PI_SHELL_UPSTREAM_BG_PID_REGRESSION";
	if std::env::var_os(MARKER).as_deref() == Some(std::ffi::OsStr::new(name)) {
		return false;
	}
	let mut isolated = tokio::process::Command::new(std::env::current_exe().unwrap());
	isolated
		.args(["--exact", name])
		.env(MARKER, name)
		.kill_on_drop(true);
	let status = tokio::time::timeout(Duration::from_secs(30), isolated.status())
		.await
		.expect("bounded isolated stopped-job test")
		.expect("isolated stopped-job test");
	assert!(status.success(), "isolated stopped-job test: {status}");
	true
}

#[tokio::test(flavor = "multi_thread")]
async fn bg_resumed_foreground_pid_replaces_empty_or_older_background_pid() {
	if isolated_stopped_job_test("bg_resumed_foreground_pid_replaces_empty_or_older_background_pid")
		.await
	{
		return;
	}

	let mut observed_pids = Vec::new();
	for earlier_background in [false, true] {
		let root = tempfile::tempdir().expect("stopped-job directory");
		let prefix = if earlier_background {
			omp_vfs::BlockingFs::native()
				.make_node(root.path().join("earlier.release"), omp_vfs::NodeKind::Fifo, 0o600)
				.expect("create earlier child's release gate");
			"/bin/sh -c 'read -r token < earlier.release' & printf '%s' \"$!\" > earlier.pid; "
		} else {
			""
		};
		let jobspec = if earlier_background { "%2" } else { "%1" };
		let cleanup = if earlier_background {
			"printf 'release\\n' > earlier.release; wait %1; "
		} else {
			""
		};
		let command = format!(
			"set -m; {prefix}/bin/sh -c 'printf \"%s\" \"$$\" > stopped.pid; kill -STOP \"$$\"; exit \
			 23'; bg {jobspec}; resumed=$?; printf '%s' \"$!\" > resumed.pid; wait {jobspec}; \
			 waited=$?; {cleanup}printf '%s|%s' \"$resumed\" \"$waited\" > statuses"
		);
		let (result, output) = run(&command, root.path()).await;
		assert_eq!(result.exit_code, Some(0), "{output}");
		assert_eq!(
			std::fs::read(root.path().join("statuses")).expect("recorded bg and wait statuses"),
			b"0|23",
			"bg must resume the owned child and preserve its wait status: {output}",
		);
		let stopped = std::fs::read_to_string(root.path().join("stopped.pid")).unwrap();
		let resumed = std::fs::read_to_string(root.path().join("resumed.pid")).unwrap();
		assert!(stopped.parse::<i32>().is_ok_and(|pid| pid > 0));
		if earlier_background {
			let earlier = std::fs::read_to_string(root.path().join("earlier.pid")).unwrap();
			assert_ne!(earlier, stopped, "fixture needs distinct background identities");
		}
		observed_pids.push((resumed, stopped));
	}
	for (resumed, stopped) in observed_pids {
		assert_eq!(resumed, stopped, "successful bg must replace the cached $! value");
	}
	for (pipeline, launch, later, expected) in [
		("./missing-first | /bin/sh -c 'kill -STOP \"$$\"; exit 0'", "-o", "+o", 127),
		("/bin/sh -c 'exit 7' | /bin/sh -c 'kill -STOP \"$$\"; exit 0'", "-o", "+o", 7),
		("/bin/sh -c 'kill -STOP \"$$\"; exit 7' | ./missing-last", "+o", "-o", 127),
	] {
		let root = tempfile::tempdir().expect("stopped pipeline directory");
		let command = format!(
			"set -m; set {launch} pipefail; {pipeline}; set {later} pipefail; bg %1; wait \"$!\""
		);
		let (result, output) = run(&command, root.path()).await;
		assert_eq!(result.exit_code, Some(expected), "{command}: {output}");
	}

	let root = tempfile::tempdir().expect("all-stopped pipeline directory");
	let shell = Shell::new(Some(ShellOptions { clear_env: true, ..Default::default() }));
	let command = "set -m; set +o pipefail; /bin/sh -c 'printf \"%s\" \"$$\" > first.pid; kill \
	               -STOP \"$$\"; exit 0' | /bin/sh -c 'printf \"%s\" \"$$\" > last.pid; kill -STOP \
	               \"$$\"; exit 23'";
	let (stopped, output) = run_in_shell(&shell, command, root.path()).await;
	assert_eq!(stopped.exit_code, Some(128 + libc::SIGSTOP), "{output}");
	let pids = stopped_pipeline_pids(root.path()).await;
	assert_ne!(pids[0], pids[1]);
	let (result, output) = run_in_shell(
		&shell,
		"set -o pipefail; bg %1; printf '%s' \"$!\" > resumed.pid; wait \"$!\"",
		root.path(),
	)
	.await;
	assert_eq!(result.exit_code, Some(23), "{output}");
	assert_eq!(
		std::fs::read_to_string(root.path().join("resumed.pid")).unwrap(),
		pids[1].to_string(),
		"resumed pipeline retains its original last-stage PID",
	);

	let root = tempfile::tempdir().expect("completed-last-stage directory");
	omp_vfs::BlockingFs::native()
		.make_node(root.path().join("release"), omp_vfs::NodeKind::Fifo, 0o600)
		.expect("create last-stage exit gate");
	let command = "set -m; set +o pipefail; /bin/sh -c 'read -r last < release; while kill -0 \
	               \"$last\" 2>/dev/null; do /bin/sleep 0.01; done; kill -STOP \"$$\"; exit 7' | \
	               /bin/sh -c 'printf \"%s\" \"$$\" > last.pid; printf \"%s\\n\" \"$$\" > release; \
	               exit 0'; set -o pipefail; bg %1; printf '%s' \"$!\" > resumed.pid; wait \"$!\"";
	let (result, output) = run(command, root.path()).await;
	assert_eq!(result.exit_code, Some(0), "{command}: {output}");
	assert_eq!(
		std::fs::read(root.path().join("resumed.pid")).unwrap(),
		std::fs::read(root.path().join("last.pid")).unwrap(),
		"bg retains the original last-stage PID after that stage was reaped",
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn fifo_mapfile_observes_writer_close_after_consuming_a_line() {
	let root = tempfile::tempdir().expect("FIFO line-input directory");
	let fifo = root.path().join("input");
	omp_vfs::BlockingFs::native()
		.make_node(&fifo, omp_vfs::NodeKind::Fifo, 0o600)
		.expect("create owned FIFO");
	let consumed = root.path().join("consumed");
	let writer = tokio::task::spawn_blocking(move || {
		use std::io::Write as _;
		let mut writer = std::fs::OpenOptions::new().write(true).open(fifo).unwrap();
		writer.write_all(b"line\n").unwrap();
		let deadline = std::time::Instant::now() + Duration::from_secs(5);
		while !consumed.exists() && std::time::Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(10));
		}
		let observed_consumption = consumed.exists();
		drop(writer);
		observed_consumption
	});
	let (result, output) = run(
		"consumed() { printf ready > consumed; }; mapfile -t -c 1 -C consumed values < input; \
		 printf '[%s]' \"${values[0]}\"",
		root.path(),
	)
	.await;
	assert!(writer.await.unwrap(), "writer must stay open until the line callback runs");
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "[line]");
}
