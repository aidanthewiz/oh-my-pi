//! `pi_shell::process` command-line behavior and interactive prompts,
//! with zsh parity checked against `/bin/zsh`.

#![cfg(unix)]

mod pty_support;

use std::{
	io::{self, prelude::Write as _},
	os::unix::{prelude::OpenOptionsExt as _, process::CommandExt},
	path::Path,
	process::Command,
};

use pty_support::{Spawn, TIMEOUT};

fn run(program: &str, args: &[&str]) -> (Vec<u8>, Vec<u8>, Option<i32>) {
	let out = Command::new(program)
		.arg0("zsh")
		.args(args)
		.env_remove("ZDOTDIR")
		.output()
		.expect("start the shell");
	(out.stdout, out.stderr, out.status.code())
}

fn obash(args: &[&str]) -> (Vec<u8>, Vec<u8>, Option<i32>) {
	run(env!("CARGO_BIN_EXE_obash"), args)
}

fn have_zsh() -> bool {
	Path::new("/bin/zsh").exists()
}

#[test]
fn interactive_bash_and_sh_show_a_prompt_before_and_after_commands() -> io::Result<()> {
	let prompted = |screen: &pty_support::Screen| {
		let text = screen.contents();
		text.ends_with('$') || text.ends_with('#')
	};
	for name in ["bash", "sh"] {
		let mut shell = Spawn::obash_as(name)
			.args(["--noprofile", "--norc"])
			.spawn()?;
		shell.wait_screen(TIMEOUT, prompted)?;
		shell.write("echo $((6 * 7))\r")?;
		shell.read_until("\r\n42\r\n", TIMEOUT)?;
		shell.wait_screen(TIMEOUT, prompted)?;
		shell.write("exit\r")?;
		assert_eq!(shell.wait(TIMEOUT)?.code(), Some(0));
	}
	Ok(())
}

#[test]
fn interactive_prompt_defaults_preserve_imported_values_and_stay_out_of_scripts() {
	for (interactive, prompt, expected) in [
		(true, Some("custom> "), "<custom> >\n"),
		(true, Some(""), "<>\n"),
		(false, None, "<unset>\n"),
	] {
		let mut command = Command::new(env!("CARGO_BIN_EXE_obash"));
		command
			.arg0("bash")
			.args(["--noprofile", "--norc"])
			.env_remove("ENV")
			.env_remove("BASH_ENV")
			.env_remove("PS1");
		if interactive {
			command.arg("-i");
		}
		if let Some(prompt) = prompt {
			command.env("PS1", prompt);
		}
		let out = command
			.args(["-c", "printf '<%s>\\n' \"${PS1-unset}\""])
			.output()
			.expect("start the shell");
		assert_eq!(out.status.code(), Some(0));
		assert_eq!(String::from_utf8_lossy(&out.stdout), expected);
	}
}

#[test]
fn help_is_zshs_in_each_emulation() {
	if !have_zsh() {
		return;
	}
	for args in [
		&["--help"][..],
		&["-f", "--help"],
		&["--emulate", "sh", "--help"],
		&["--emulate", "ksh", "--help"],
		&["-o", "shoptionletters", "--help"],
	] {
		let (out, err, status) = obash(args);
		assert_eq!(
			String::from_utf8_lossy(&out),
			String::from_utf8_lossy(&run("/bin/zsh", args).0),
			"{args:?}"
		);
		assert!(err.is_empty(), "{args:?}: {}", String::from_utf8_lossy(&err));
		assert_eq!(status, Some(0));
	}
}

#[test]
fn version_names_zsh_59() {
	let (out, _, status) = obash(&["--version"]);
	let text = String::from_utf8(out).unwrap();
	assert!(text.starts_with("zsh 5.9 (") && text.ends_with(")\n"), "{text}");
	assert_eq!(status, Some(0));
}

#[test]
fn command_strings_and_exit_statuses_match_zsh() {
	if !have_zsh() {
		return;
	}
	for args in [
		&["-f", "-c", "echo $ZSH_NAME $0; print -l a b"][..],
		&["-f", "-c", "exit 3"],
		&["-f", "-c", "print -r -- $ZSH_EXECUTION_STRING"],
		&["-f", "-c", "exit 300"],
		&["-f", "-c", "yes | head -1"],
		&["-f", "--no-such-option"],
	] {
		assert_eq!(obash(args), run("/bin/zsh", args), "{args:?}");
	}
}

/// A standalone shell abandons the externals still running when it exits:
/// a background job without `nohup` gets `TERM` and is gone shortly after.
#[test]
fn a_standalone_exit_ends_running_background_externals() {
	let out = Command::new(env!("CARGO_BIN_EXE_obash"))
		.args(["-c", "/bin/sleep 31 >/dev/null 2>&1 </dev/null & echo $!"])
		.output()
		.expect("start obash");
	assert_eq!(out.status.code(), Some(0));
	let pid: libc::pid_t = String::from_utf8(out.stdout)
		.expect("utf-8 pid")
		.trim()
		.parse()
		.expect("the job's pid");
	let deadline = std::time::Instant::now() + TIMEOUT;
	// SAFETY: signal 0 only checks that the process exists.
	while unsafe { libc::kill(pid, 0) } == 0 {
		assert!(std::time::Instant::now() < deadline, "sleep {pid} still runs after obash exited");
		std::thread::sleep(std::time::Duration::from_millis(20));
	}
}

/// `$!` of a background pipeline is its last process's pid (zsh runs that
/// stage in the job's shell), as the process reports `$$` itself; it was
/// the shell's virtual pid, unknown to the system.
#[test]
fn a_background_pipelines_bang_is_its_last_process() {
	let script = "T=$(/usr/bin/mktemp); /bin/sleep 0.1 | /bin/sh -c 'echo $$ >\"$1\"; exec \
	              /bin/sleep 0.1' sh $T & p=$!; wait; [[ $p == $(<$T) ]] && print last; /bin/rm -f \
	              $T";
	let args = ["-f", "-c", script];
	let ours = obash(&args);
	assert_eq!(ours, (b"last\n".to_vec(), Vec::new(), Some(0)));
	if have_zsh() {
		assert_eq!(ours, run("/bin/zsh", &args));
	}
}

struct OwnedPipeline {
	root:   pi_shell::proctree::Process,
	stages: [Option<pi_shell::proctree::Process>; 2],
}
impl Drop for OwnedPipeline {
	fn drop(&mut self) {
		for stage in self.stages.iter().flatten() {
			let _ = stage.signal(libc::SIGKILL);
		}
		let _ = self.root.kill_tree(Some(libc::SIGKILL));
	}
}

impl OwnedPipeline {
	fn observe_stage(&mut self, index: usize, pidfile: &Path) -> io::Result<i32> {
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
		loop {
			if let Some(process) = std::fs::read_to_string(pidfile)
				.ok()
				.and_then(|text| text.trim().parse::<i32>().ok())
				.filter(|pid| *pid > 0)
				.and_then(pi_shell::proctree::Process::from_pid)
				.filter(|process| process.status() == pi_shell::proctree::ProcessStatus::Running)
			{
				let pid = process.pid();
				self.stages[index] = Some(process);
				return Ok(pid);
			}
			if std::time::Instant::now() >= deadline {
				return Err(io::Error::new(io::ErrorKind::TimedOut, "owned stage did not start"));
			}
			std::thread::sleep(std::time::Duration::from_millis(10));
		}
	}

	fn wait_stopped(&self, index: usize) -> io::Result<()> {
		let process = self.stages[index].as_ref().expect("observed native stage");
		let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
		loop {
			if process.status() == pi_shell::proctree::ProcessStatus::Exited {
				return Err(io::Error::other("owned stage exited before stopping"));
			}
			if pi_builtins::ProcInfo::all()
				.iter()
				.any(|info| info.pid() == process.pid() && info.state() == 'T')
			{
				return Ok(());
			}
			if std::time::Instant::now() >= deadline {
				return Err(io::Error::new(io::ErrorKind::TimedOut, "owned stage did not stop"));
			}
			std::thread::sleep(std::time::Duration::from_millis(10));
		}
	}
}

fn owned_fifo(path: &Path) -> io::Result<std::fs::File> {
	pi_vfs::BlockingFs::native()
		.make_node(path, pi_vfs::NodeKind::Fifo, 0o600)
		.expect("owned native FIFO");
	std::fs::OpenOptions::new()
		.read(true)
		.write(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(path)
}

#[test]
fn stopped_pipeline_jobs_use_the_group_while_bg_uses_the_last_stage() -> io::Result<()> {
	let root = tempfile::tempdir()?;
	let mut shell = Spawn::obash_as("bash")
		.args(["--noprofile", "--norc"])
		.env("PS1", "custody> ")
		.cwd(root.path())
		.spawn()?;
	let mut owned = OwnedPipeline {
		root:   pi_shell::proctree::Process::from_pid(shell.pid()).expect("owned PTY shell"),
		stages: [None, None],
	};
	shell.read_until("custody> ", TIMEOUT)?;
	shell.write(
		"set -m; set +o pipefail; /bin/sh -c 'printf \"%s\" \"$$\" > first.pid; kill -STOP \"$$\"; \
		 exit 0' | /bin/sh -c 'printf \"%s\" \"$$\" > last.pid; kill -STOP \"$$\"; exit 23'\r",
	)?;
	let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
	let pids = loop {
		let processes = pi_builtins::ProcInfo::all();
		for (i, file) in ["first.pid", "last.pid"].iter().enumerate() {
			if owned.stages[i].is_some() {
				continue;
			}
			if let Some(pid) = std::fs::read_to_string(root.path().join(file))
				.ok()
				.and_then(|text| text.parse::<i32>().ok())
				.filter(|pid| {
					*pid > 0
						&& processes
							.iter()
							.any(|process| process.pid() == *pid && process.state() == 'T')
				}) {
				owned.stages[i] = pi_shell::proctree::Process::from_pid(pid);
			}
		}
		if let [Some(first), Some(last)] = &owned.stages {
			break [first.pid(), last.pid()];
		}
		assert!(std::time::Instant::now() < deadline, "both owned stages must stop");
		std::thread::sleep(std::time::Duration::from_millis(10));
	};
	assert_ne!(pids[0], pids[1]);
	for stage in owned.stages.iter().flatten() {
		assert_eq!(stage.group_id(), Some(pids[0]), "stages share their native process group");
	}
	shell.read_until("custody> ", TIMEOUT)?;
	shell.write(
		"jobs -p %1 > listed.pid; jobs -x /bin/echo %1 > expanded.pid; printf 'QUERY_DONE\\n'\r",
	)?;
	shell.read_until("\r\nQUERY_DONE\r\n", TIMEOUT)?;
	let listed = std::fs::read_to_string(root.path().join("listed.pid"))?;
	let expanded = std::fs::read_to_string(root.path().join("expanded.pid"))?;
	let pgid = pids[0].to_string();
	assert_eq!(
		(listed.trim(), expanded.trim()),
		(pgid.as_str(), pgid.as_str()),
		"jobs -p and jobs -x retain the process group rather than the final-stage PID",
	);
	shell.write(
		"bg %1; printf '%s' \"$!\" > bang.pid; wait %1; status=$?; printf '%s' \"$status\" > \
		 waited; printf 'RESUMED_DONE\\n'\r",
	)?;
	shell.read_until("\r\nRESUMED_DONE\r\n", TIMEOUT)?;
	assert_eq!(std::fs::read_to_string(root.path().join("bang.pid"))?, pids[1].to_string());
	assert_eq!(std::fs::read(root.path().join("waited"))?, b"23");
	shell.write("exit\r")?;
	assert_eq!(shell.wait(TIMEOUT)?.code(), Some(0));
	Ok(())
}

#[test]
fn inline_builtin_observer_resolves_before_resumed_stage_needs_release() -> io::Result<()> {
	let root = tempfile::tempdir()?;
	let budget = std::time::Duration::from_secs(5);
	let _release = owned_fifo(&root.path().join("release"))?;
	let mut shell = Spawn::zsh()
		.arg("-f")
		.env("PS1", "custody> ")
		.cwd(root.path())
		.spawn()?;
	let mut owned = OwnedPipeline {
		root:   pi_shell::proctree::Process::from_pid(shell.pid()).expect("owned PTY shell"),
		stages: [None, None],
	};
	shell.read_until("custody> ", budget)?;
	shell.write(
		"set -o pipefail; /bin/sh -c 'printf \"%s\" \"$$\" > first.pid; kill -STOP \"$$\"; read -r \
		 token < release; printf resumed > stage.done; exit 7' | true\r",
	)?;
	owned.observe_stage(0, &root.path().join("first.pid"))?;
	owned.wait_stopped(0)?;
	shell.read_until("custody> ", budget)?;
	shell.write(
		"set +o pipefail; jobs -p %1 > job.info; queried=$?; bg %1; job=$!; printf 'release\\n' > \
		 release; wait \"$job\"; waited=$?; printf '%s|%s' \"$queried\" \"$waited\" > statuses; \
		 printf 'INLINE_QUERY_DONE\\n'\r",
	)?;
	shell.read_until("\r\nINLINE_QUERY_DONE\r\n", budget)?;
	assert_eq!(std::fs::read(root.path().join("statuses"))?, b"0|7");
	assert_eq!(std::fs::read(root.path().join("stage.done"))?, b"resumed");
	shell.write("exit\r")?;
	assert_eq!(shell.wait(budget)?.code(), Some(0));
	Ok(())
}

#[test]
fn reaped_inline_pid_does_not_signal_the_suspended_pipeline() -> io::Result<()> {
	let root = tempfile::tempdir()?;
	let budget = std::time::Duration::from_secs(5);
	let _release = owned_fifo(&root.path().join("release"))?;
	let mut last_release = owned_fifo(&root.path().join("last.release"))?;
	let mut shell = Spawn::zsh()
		.arg("-f")
		.env("PS1", "custody> ")
		.cwd(root.path())
		.spawn()?;
	let mut owned = OwnedPipeline {
		root:   pi_shell::proctree::Process::from_pid(shell.pid()).expect("owned PTY shell"),
		stages: [None, None],
	};
	shell.read_until("custody> ", budget)?;
	shell.write(
		"set +o pipefail; /bin/sh -c 'printf \"%s\" \"$$\" > first.pid; read -r last < release; \
		 while kill -0 \"$last\" 2>/dev/null; do /bin/sleep 0.01; done; kill -STOP \"$$\"; printf \
		 resumed > first.done; exit 7' | /bin/sh -c 'printf \"%s\\n\" \"$$\" > last.pid; read -r \
		 token < last.release; printf \"%s\\n\" \"$$\" > release; exit 0'\r",
	)?;
	let first = owned.observe_stage(0, &root.path().join("first.pid"))?;
	let last = owned.observe_stage(1, &root.path().join("last.pid"))?;
	assert_ne!(first, last);
	last_release.write_all(b"release\n")?;
	owned.wait_stopped(0)?;
	assert_eq!(
		owned.stages[1]
			.as_ref()
			.expect("observed last stage")
			.status(),
		pi_shell::proctree::ProcessStatus::Exited,
	);
	shell.read_until("custody> ", budget)?;
	shell.write(
		"read -r last < last.pid; kill -TERM \"$last\"; killed=$?; bg %1; resumed=$?; wait %1; \
		 waited=$?; printf '%s|%s|%s' \"$killed\" \"$resumed\" \"$waited\" > statuses; printf \
		 'RETIRED_BEFORE_BG_DONE\\n'\r",
	)?;
	shell.read_until("\r\nRETIRED_BEFORE_BG_DONE\r\n", budget)?;
	assert_eq!(std::fs::read(root.path().join("statuses"))?, b"1|0|0");
	assert_eq!(std::fs::read(root.path().join("first.done"))?, b"resumed");
	shell.write("exit\r")?;
	assert_eq!(shell.wait(budget)?.code(), Some(0));
	Ok(())
}

#[test]
fn inline_pid_reaped_after_bg_does_not_signal_the_remaining_pipeline() -> io::Result<()> {
	let root = tempfile::tempdir()?;
	let budget = std::time::Duration::from_secs(5);
	let _release = owned_fifo(&root.path().join("release"))?;
	let mut shell = Spawn::zsh()
		.arg("-f")
		.env("PS1", "custody> ")
		.cwd(root.path())
		.spawn()?;
	let mut owned = OwnedPipeline {
		root:   pi_shell::proctree::Process::from_pid(shell.pid()).expect("owned PTY shell"),
		stages: [None, None],
	};
	shell.read_until("custody> ", budget)?;
	shell.write(
		"set +o pipefail; /bin/sh -c 'printf \"%s\" \"$$\" > first.pid; kill -STOP \"$$\"; read -r \
		 token < release; printf resumed > first.done; exit 7' | /bin/sh -c 'printf \"%s\" \"$$\" > \
		 last.pid; kill -STOP \"$$\"; exit 0'\r",
	)?;
	let first = owned.observe_stage(0, &root.path().join("first.pid"))?;
	let last = owned.observe_stage(1, &root.path().join("last.pid"))?;
	assert_ne!(first, last);
	owned.wait_stopped(0)?;
	owned.wait_stopped(1)?;
	shell.read_until("custody> ", budget)?;
	shell.write(
		"bg %1; read -r last < last.pid; /bin/sh -c 'while kill -0 \"$1\" 2>/dev/null; do \
		 /bin/sleep 0.01; done' _ \"$last\"; kill -TERM \"$last\"; killed=$?; printf 'release\\n' > \
		 release; wait %1; waited=$?; printf '%s|%s' \"$killed\" \"$waited\" > statuses; printf \
		 'RETIRED_AFTER_BG_DONE\\n'\r",
	)?;
	shell.read_until("\r\nRETIRED_AFTER_BG_DONE\r\n", budget)?;
	assert_eq!(
		owned.stages[1]
			.as_ref()
			.expect("observed last stage")
			.status(),
		pi_shell::proctree::ProcessStatus::Exited,
	);
	assert_eq!(std::fs::read(root.path().join("statuses"))?, b"1|0");
	assert_eq!(std::fs::read(root.path().join("first.done"))?, b"resumed");
	shell.write("exit\r")?;
	assert_eq!(shell.wait(budget)?.code(), Some(0));
	Ok(())
}
