//! The deliberately small git-CLI escape hatch.
//!
//! Four categories are allowed to spawn `git`, per the hybrid policy:
//! - **Credential-bound network transfers** — clone/fetch/push must reuse the
//!   user's ssh config and credential helpers.
//! - **Commits** — Git owns configured signing and repository hook behavior.
//! - **Reftable ref access** — no in-process reftable implementation exists.
//! - **Whole-worktree status/untracked walks** — a subprocess contains gitoxide
//!   worker-thread spawn failures under host resource exhaustion.
//!
//! The runner ports the hardened subprocess contract of the TS wrapper:
//! non-interactive env (`GIT_TERMINAL_PROMPT=0`, askpass rejection, `LC_ALL`
//! handling), `--no-optional-locks` for reads, fsmonitor/untracked-cache
//! disabled for writes, ambient `GIT_DIR`-family vars stripped, bounded output
//! capture, and deadline + SIGTERM→SIGKILL termination via tokio.

use std::{
	collections::BTreeMap,
	path::{Path, PathBuf},
	process::Stdio,
	time::Duration,
};

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use super::GitRepo;
use crate::{
	error::{Error, Result},
	types::{CloneOptions, PushOptions},
};

/// Default deadline for local git plumbing via the fallback runner.
pub const COMMAND_TIMEOUT: Duration = Duration::from_mins(5);
/// Default deadline for network transfers (`clone`/`fetch`/`push`); large-repo
/// transfers legitimately outlive [`COMMAND_TIMEOUT`].
pub const NETWORK_TIMEOUT: Duration = Duration::from_mins(30);
/// Deadline for synchronous plumbing on render paths (reftable HEAD reads):
/// a stalled invocation degrades instead of freezing the UI.
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum captured bytes per stream before truncation.
pub const OUTPUT_LIMIT_BYTES: usize = 8 * 1024 * 1024;

const TERMINATE_GRACE: Duration = Duration::from_secs(5);
const TRUNCATION_MARKER: &str = "\n[git subprocess output truncated at the capture limit]\n";

/// Captured result of a completed git invocation.
#[derive(Debug, Clone)]
pub(crate) struct CliOutput {
	/// Process exit code (`124` designates a deadline kill).
	pub exit_code: i32,
	/// Captured stdout, possibly truncated.
	pub stdout:    String,
	/// Captured stderr, possibly truncated.
	pub stderr:    String,
}

impl CliOutput {
	/// Convert a non-zero exit into [`Error::Cli`].
	pub fn into_checked(self, args: &[String]) -> Result<Self> {
		if self.exit_code == 0 {
			return Ok(self);
		}
		Err(Error::Cli {
			command:   format!("git {}", args.join(" ")),
			exit_code: self.exit_code,
			stdout:    self.stdout,
			stderr:    self.stderr,
		})
	}
}

/// Options for one fallback invocation.
#[derive(Debug, Default)]
pub(crate) struct RunOptions {
	/// Prefix `--no-optional-locks` instead of pinning fsmonitor/untracked-cache
	/// off.
	pub read_only:  bool,
	/// Deadline; [`COMMAND_TIMEOUT`] when unset.
	pub timeout:    Option<Duration>,
	/// Bytes piped to stdin (commit messages, `update-ref --stdin` scripts).
	pub stdin:      Option<Vec<u8>>,
	/// Cooperative cancellation: the child is terminated when triggered.
	pub cancel:     Option<CancellationToken>,
	/// Complete environment for the child process. Inheritance is disabled when
	/// set.
	pub env:        Option<BTreeMap<String, String>>,
	/// Explicit alternate index; installed after inherited overrides are
	/// stripped.
	pub index_path: Option<PathBuf>,
}

struct ChildGroup {
	#[cfg(unix)]
	pid: Option<libc::pid_t>,
}

impl ChildGroup {
	fn new(pid: Option<u32>) -> Self {
		#[cfg(unix)]
		{
			Self { pid: pid.and_then(|pid| libc::pid_t::try_from(pid).ok()) }
		}
		#[cfg(not(unix))]
		{
			let _ = pid;
			Self {}
		}
	}

	#[cfg(unix)]
	fn signal(&self, signal: libc::c_int) {
		if let Some(pid) = self.pid {
			// SAFETY: the unreaped setsid leader pins this owned group's identity.
			unsafe {
				libc::kill(-pid, signal);
			}
		}
	}

	fn kill(&self) {
		#[cfg(unix)]
		self.signal(libc::SIGKILL);
	}

	const fn disarm(&mut self) {
		#[cfg(unix)]
		{
			self.pid = None;
		}
	}
}

impl Drop for ChildGroup {
	fn drop(&mut self) {
		self.kill();
	}
}

/// Build the hardened argv prefix.
///
/// Reads get `--no-optional-locks`, which already keeps them from rewriting
/// the index, so they keep the repository's fsmonitor and untracked cache: a
/// whole-worktree status on a large repo polled by every open session is far
/// cheaper with both. Writes pin both off so a transient subprocess never
/// mutates fsmonitor/untracked-cache state in the index.
fn hardened_args(args: &[String], read_only: bool) -> Vec<String> {
	let mut out = Vec::with_capacity(args.len() + 4);
	if read_only {
		if !args.iter().any(|arg| arg == "--no-optional-locks") {
			out.push("--no-optional-locks".to_owned());
		}
	} else {
		for pin in ["core.fsmonitor=false", "core.untrackedCache=false"] {
			out.push("-c".to_owned());
			out.push(pin.to_owned());
		}
	}
	out.extend(args.iter().cloned());
	out
}

/// Environment sink for the two command builders. `std::process::Command` and
/// `tokio::process::Command` share no trait, and duplicating the contract per
/// builder is how the synchronous path silently lost the `LC_ALL` removal that
/// [`is_dubious_ownership`] depends on.
trait EnvSink {
	fn clear(&mut self);
	fn set(&mut self, key: &str, value: &str);
	fn unset(&mut self, key: &str);
}

impl EnvSink for std::process::Command {
	fn clear(&mut self) {
		self.env_clear();
	}

	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

impl EnvSink for tokio::process::Command {
	fn clear(&mut self) {
		self.env_clear();
	}

	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

/// Apply the non-interactive environment contract to a command builder:
/// prompts rejected, editors disabled, ambient repo-location and pathspec
/// overrides stripped, `LC_MESSAGES=C` for parseable errors while preserving a
/// UTF-8 character locale. `LC_ALL` must go: it outranks `LC_MESSAGES`, so
/// leaving it inherited would hand back localized diagnostics.
///
/// The `*_PATHSPECS` variables are global pathspec modes, so an inherited
/// `GIT_LITERAL_PATHSPECS=1` would make the `:(literal)` magic this crate
/// builds match a filename containing that prefix (i.e. nothing), and
/// `GIT_ICASE_PATHSPECS=1` would match case variants the caller did not ask
/// for. Explicit magic is only explicit once they are gone.
fn apply_env(cmd: &mut impl EnvSink, env: Option<&BTreeMap<String, String>>) {
	if let Some(env) = env {
		cmd.clear();
		for (key, value) in env {
			cmd.set(key, value);
		}
	}
	for stripped in [
		"GIT_DIR",
		"GIT_COMMON_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_LITERAL_PATHSPECS",
		"GIT_GLOB_PATHSPECS",
		"GIT_NOGLOB_PATHSPECS",
		"GIT_ICASE_PATHSPECS",
	] {
		cmd.unset(stripped);
	}
	let lc_all = match env {
		Some(values) => values.get("LC_ALL").cloned(),
		None => std::env::var("LC_ALL").ok(),
	};
	if let Some(lc_all) = lc_all
		&& is_utf8_locale(&lc_all)
	{
		cmd.set("LC_CTYPE", &lc_all);
	}
	cmd.unset("LC_ALL");
	cmd.set("LC_MESSAGES", "C");
	cmd.set("GIT_OPTIONAL_LOCKS", "0");
	cmd.set("GIT_ASKPASS", "true");
	cmd.set("GIT_EDITOR", "true");
	cmd.set("GIT_TERMINAL_PROMPT", "0");
	cmd.set("SSH_ASKPASS", "false");
}

/// Loose match for a UTF-8 character locale (`en_US.UTF-8`, `C.utf8`, …).
fn is_utf8_locale(value: &str) -> bool {
	let lower = value.to_ascii_lowercase();
	["utf-8", "utf8"].iter().any(|needle| {
		lower
			.split(['.', '_', '-', '@'])
			.any(|part| part == *needle)
			|| lower.ends_with(needle)
			|| lower.contains(&format!(".{needle}"))
	})
}

/// Start `cmd` in a new session with no controlling terminal, the embedded
/// shell's policy for externals. Without it git and everything it starts (ssh,
/// credential helpers, signers, hooks) share the host's terminal: any of them
/// can read the user's keystrokes and the terminal's protocol replies out from
/// under the TUI, or prompt on it. Detached, a `/dev/tty` open fails
/// (`ENXIO`), so a prompt errors out instead.
#[cfg(unix)]
pub(crate) fn detach_from_terminal(cmd: &mut std::process::Command) {
	std::os::unix::process::CommandExt::setsid(cmd, true);
}

#[cfg(not(unix))]
#[allow(
	clippy::needless_pass_by_ref_mut,
	reason = "no controlling terminal to detach from off unix; the signature matches the unix \
	          variant"
)]
pub(crate) const fn detach_from_terminal(_cmd: &mut std::process::Command) {}

/// Run `git` asynchronously with bounded capture and a deadline.
/// Non-zero exits are returned in [`CliOutput`], not raised.
pub(crate) async fn run(cwd: &Path, args: &[String], options: &RunOptions) -> Result<CliOutput> {
	if options
		.cancel
		.as_ref()
		.is_some_and(CancellationToken::is_cancelled)
	{
		return Err(Error::Canceled);
	}
	let argv = hardened_args(args, options.read_only);
	let mut cmd = tokio::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(if options.stdin.is_some() {
			Stdio::piped()
		} else {
			Stdio::null()
		})
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	apply_env(&mut cmd, options.env.as_ref());
	if let Some(index_path) = &options.index_path {
		cmd.env("GIT_INDEX_FILE", index_path);
	}
	detach_from_terminal(cmd.as_std_mut());
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;
	let mut group = ChildGroup::new(child.id());

	let stdin_pipe = child.stdin.take();
	let write_stdin = async {
		if let Some(stdin) = &options.stdin
			&& let Some(mut pipe) = stdin_pipe
		{
			use tokio::io::AsyncWriteExt;
			// Early exit closes stdin; the exit status remains authoritative.
			let _ = pipe.write_all(stdin).await;
			let _ = pipe.shutdown().await;
		}
	};

	let stdout = child.stdout.take().expect("stdout piped");
	let stderr = child.stderr.take().expect("stderr piped");
	// TERM handlers may write to these pipes before publishing cleanup.
	// Boxing bounds caller futures despite the two 8 KiB read buffers.
	let mut drain = Box::pin(async { tokio::join!(read_capped(stdout), read_capped(stderr)) });
	let mut drained = false;
	let completion = async {
		// Keep the leader unreaped while helpers can still hold captured pipes.
		let ((), (stdout, stderr)) = tokio::join!(write_stdin, async {
			let output = drain.as_mut().await;
			drained = true;
			output
		});
		let status = child.wait().await;
		group.disarm();
		Ok(CliOutput {
			exit_code: status.map_err(Error::Io)?.code().unwrap_or(-1),
			stdout:    stdout?,
			stderr:    stderr?,
		})
	};

	let timeout = options.timeout.unwrap_or(COMMAND_TIMEOUT);
	let cancel = options.cancel.clone().unwrap_or_default();
	let outcome = tokio::select! {
		result = tokio::time::timeout(timeout, completion) => Some(result),
		() = cancel.cancelled() => None,
	};
	let error = match outcome {
		Some(Ok(result)) => return result,
		Some(Err(_elapsed)) => Error::CliTimeout { command: format!("git {}", argv.join(" ")) },
		None => Error::Canceled,
	};
	let termination = terminate(&mut child, &mut group);
	tokio::pin!(termination);
	tokio::select! {
		() = &mut termination => {},
		_ = drain.as_mut(), if !drained => termination.await,
	}
	Err(error)
}

/// Run `git` asynchronously and map a non-zero exit to [`Error::Cli`].
pub(crate) async fn run_checked(
	cwd: &Path,
	args: &[String],
	options: &RunOptions,
) -> Result<CliOutput> {
	run(cwd, args, options).await?.into_checked(args)
}

/// Whether `err` means the git binary could not be launched at all (missing
/// binary or deleted cwd), as opposed to git running and failing. Callers with
/// an in-process fallback (e.g. porcelain status) branch on this.
pub(crate) fn is_spawn_failure(err: &Error) -> bool {
	matches!(err, Error::Backend { context: "git spawn", .. })
}

/// Whether captured output hit [`OUTPUT_LIMIT_BYTES`] and therefore lost
/// bytes. Callers whose output is a value rather than a diagnostic (path
/// lists) must retry in-process or fail, never return the short result.
pub(crate) fn is_truncated(text: &str) -> bool {
	text.ends_with(TRUNCATION_MARKER)
}

/// Whether git refused the checkout under its `safe.directory` ownership
/// check (`fatal: detected dubious ownership`, exit 128), which happens
/// whenever the process user differs from the checkout owner — a
/// host-mounted repository inside a container is the common case.
///
/// `open::open_options` opens user-chosen checkouts with `Trust::Full` on
/// purpose, so the in-process walk has no such objection: a caller with a
/// gitoxide fallback must take it rather than surface an error the
/// library-backed path would never have produced.
///
/// [`apply_env`] pins `LC_MESSAGES=C` and drops the `LC_ALL` that would
/// outrank it, so the English wording is what git emits. `safe.directory` is
/// matched as well: it is a config key, so it survives translation even if a
/// host manages to localize the diagnostic anyway.
pub(crate) fn is_dubious_ownership(err: &Error) -> bool {
	matches!(
		err,
		Error::Cli { exit_code: 128, stderr, .. }
			if stderr.contains("dubious ownership") || stderr.contains("safe.directory")
	)
}

/// Whether `err` describes a CLI that could not do the work at all while the
/// in-process gitoxide path still can.
pub(crate) fn prefers_in_process(err: &Error) -> bool {
	is_spawn_failure(err) || is_dubious_ownership(err)
}

/// Synchronous bounded runner with a caller-chosen deadline; render paths pass
/// [`SYNC_TIMEOUT`] so a stalled git cannot freeze the UI. Stdout/stderr are
/// drained concurrently with capped retention, so output larger than the OS
/// pipe buffer can never stall the child into a spurious timeout.
pub(crate) fn run_sync(cwd: &Path, args: &[String], timeout: Duration) -> Result<CliOutput> {
	run_sync_capped(cwd, args, timeout, OUTPUT_LIMIT_BYTES)
}

/// [`run_sync`] with an explicit retention cap. The cap is a parameter rather
/// than a constant read inside the reader threads so a test can exercise the
/// truncation contract on one call without lowering the limit for every other
/// invocation in the process.
pub(crate) fn run_sync_capped(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	limit: usize,
) -> Result<CliOutput> {
	let argv = hardened_args(args, true);
	let mut cmd = std::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	apply_env(&mut cmd, None);
	detach_from_terminal(&mut cmd);
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;
	let mut group = ChildGroup::new(Some(child.id()));
	let stdout = spawn_sync_reader("git-cli-stdout", child.stdout.take(), limit);
	let stderr = spawn_sync_reader("git-cli-stderr", child.stderr.take(), limit);
	let deadline = std::time::Instant::now() + timeout;
	let status: std::io::Result<_> = loop {
		let drained = stdout
			.as_ref()
			.is_none_or(std::thread::JoinHandle::is_finished)
			&& stderr
				.as_ref()
				.is_none_or(std::thread::JoinHandle::is_finished);
		if drained {
			match child.try_wait() {
				Ok(Some(status)) => {
					group.disarm();
					break Ok(Some(status));
				},
				Ok(None) => {},
				Err(error) => {
					group.kill();
					group.disarm();
					let _ = child.kill();
					let _ = child.wait();
					break Err(error);
				},
			}
		}
		if std::time::Instant::now() >= deadline {
			group.kill();
			group.disarm();
			let _ = child.kill();
			let _ = child.wait();
			break Ok(None);
		}
		std::thread::sleep(Duration::from_millis(10));
	};
	let stdout = stdout.map_or_default(|h| h.join().unwrap_or_default());
	let stderr = stderr.map_or_default(|h| h.join().unwrap_or_default());
	let Some(status) = status? else {
		return Err(Error::CliTimeout { command: format!("git {}", argv.join(" ")) });
	};
	Ok(CliOutput { exit_code: status.code().unwrap_or(-1), stdout, stderr })
}

/// Drain a child stream on a helper thread, mirroring [`read_capped`].
///
/// `None` when the stream is absent or the thread cannot be spawned (e.g.
/// under the same memory pressure that motivates the CLI path); dropping the
/// stream then closes the pipe, so a chatty child fails with EPIPE and
/// surfaces as a non-zero exit instead of a hang.
fn spawn_sync_reader(
	name: &'static str,
	stream: Option<impl std::io::Read + Send + 'static>,
	limit: usize,
) -> Option<std::thread::JoinHandle<String>> {
	let stream = stream?;
	std::thread::Builder::new()
		.name(name.into())
		.spawn(move || read_capped_sync(stream, limit))
		.ok()
}

/// Synchronous mirror of [`read_capped`]: cap retention at `limit` while
/// draining to EOF so the child never blocks.
fn read_capped_sync(mut stream: impl std::io::Read, limit: usize) -> String {
	let mut retained: Vec<u8> = Vec::new();
	let mut buf = [0u8; 8 * 1024];
	let mut truncated = false;
	loop {
		let n = match stream.read(&mut buf) {
			Ok(0) | Err(_) => break,
			Ok(n) => n,
		};
		if truncated {
			continue;
		}
		let remaining = limit - retained.len();
		if n <= remaining {
			retained.extend_from_slice(&buf[..n]);
		} else {
			retained.extend_from_slice(&buf[..remaining]);
			truncated = true;
		}
	}
	let mut text = String::from_utf8_lossy_owned(retained);
	if truncated {
		text.push_str(TRUNCATION_MARKER);
	}
	text
}

fn spawn_error(cwd: &Path, err: std::io::Error) -> Error {
	if err.kind() == std::io::ErrorKind::NotFound {
		// A deleted cwd also surfaces as spawn ENOENT; only blame the binary
		// when the working directory actually exists.
		let message = if cwd.exists() {
			"git is not installed.".to_owned()
		} else {
			format!("working directory does not exist: {}", cwd.display())
		};
		return Error::backend("git spawn", message);
	}
	Error::Io(err)
}

/// Read a stream to completion, capping retention at [`OUTPUT_LIMIT_BYTES`]
/// while continuing to drain so the child never blocks on a full pipe.
async fn read_capped(mut stream: impl tokio::io::AsyncRead + Unpin) -> Result<String> {
	let mut retained: Vec<u8> = Vec::new();
	let mut buf = [0u8; 8 * 1024];
	let mut truncated = false;
	loop {
		let n = stream.read(&mut buf).await.map_err(Error::Io)?;
		if n == 0 {
			break;
		}
		if truncated {
			continue;
		}
		let remaining = OUTPUT_LIMIT_BYTES - retained.len();
		if n <= remaining {
			retained.extend_from_slice(&buf[..n]);
		} else {
			retained.extend_from_slice(&buf[..remaining]);
			truncated = true;
		}
	}
	let mut text = String::from_utf8_lossy_owned(retained);
	if truncated {
		text.push_str(TRUNCATION_MARKER);
	}
	Ok(text)
}

/// Keep the session leader unreaped through TERM grace and group escalation.
async fn terminate(child: &mut tokio::process::Child, group: &mut ChildGroup) {
	#[cfg(unix)]
	{
		group.signal(libc::SIGTERM);
		tokio::time::sleep(TERMINATE_GRACE).await;
		group.kill();
		group.disarm();
	}
	let _ = child.kill().await;
	let _ = tokio::time::timeout(TERMINATE_GRACE, child.wait()).await;
	group.disarm();
}

// ═══════════════════════════════════════════════════════════════════════════
// Network operations (public API)
// ═══════════════════════════════════════════════════════════════════════════

impl GitRepo {
	/// Push the current branch (branch-scoped: never follows tags).
	///
	/// `--no-follow-tags` overrides a user's `push.followTags = true`, which
	/// would otherwise ride every reachable annotated tag along with the
	/// branch — rejected refs on remotes the user cannot tag (e.g. PR-head
	/// forks) would fail the call after the branch itself already updated.
	pub async fn push(
		&self,
		options: &PushOptions,
		cancel: Option<CancellationToken>,
	) -> Result<()> {
		let mut args =
			vec!["push".to_owned(), "--no-verify".to_owned(), "--no-follow-tags".to_owned()];
		if options.force_with_lease {
			args.push("--force-with-lease".to_owned());
		}
		if let Some(remote) = &options.remote {
			args.push(remote.clone());
		}
		if let Some(refspec) = &options.refspec {
			args.push(refspec.clone());
		}
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(NETWORK_TIMEOUT),
			cancel,
			env: options.env.clone(),
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}

	/// Fetch `+source:target` from a remote.
	pub async fn fetch(
		&self,
		remote: &str,
		source: &str,
		target: &str,
		timeout: Option<Duration>,
		cancel: Option<CancellationToken>,
		env: Option<BTreeMap<String, String>>,
	) -> Result<()> {
		let args = vec!["fetch".to_owned(), remote.to_owned(), format!("+{source}:{target}")];
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(timeout.unwrap_or(NETWORK_TIMEOUT)),
			cancel,
			env,
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}
}

/// Clone `url` into `target_dir`, removing the partial clone on any failure.
///
/// Shallow (`--depth 1 --single-branch`) unless a specific SHA is pinned:
/// a shallow clone only fetches the tip, so checking out a non-tip commit
/// would fail with "reference is not a tree".
pub async fn clone(
	url: &str,
	target_dir: &Path,
	options: &CloneOptions,
	cancel: Option<CancellationToken>,
) -> Result<()> {
	let absolute = std::path::absolute(target_dir)?;
	let parent = absolute
		.parent()
		.map_or_else(|| absolute.clone(), Path::to_owned);
	tokio::fs::create_dir_all(&parent).await?;

	let shallow = options.sha.is_none();
	let mut args = vec!["clone".to_owned()];
	args.push("--no-checkout".to_owned());
	if shallow {
		args.push("--depth".to_owned());
		args.push("1".to_owned());
	}
	if let Some(ref_name) = &options.ref_name {
		args.push("--branch".to_owned());
		args.push(ref_name.clone());
		args.push("--single-branch".to_owned());
	} else if shallow {
		args.push("--single-branch".to_owned());
	}
	args.push(url.to_owned());
	args.push(absolute.to_string_lossy().into_owned());

	let run_options = RunOptions {
		timeout: Some(options.timeout.unwrap_or(NETWORK_TIMEOUT)),
		cancel: cancel.clone(),
		env: options.env.clone(),
		..RunOptions::default()
	};
	let outcome = run_checked(&parent, &args, &run_options).await;
	if let Err(err) = outcome {
		let _ = tokio::fs::remove_dir_all(&absolute).await;
		return Err(err);
	}

	let checkout = GitRepo::require(&absolute)
		.and_then(|repo| repo.checkout(options.sha.as_deref().unwrap_or("HEAD")));
	if let Err(err) = checkout {
		let _ = tokio::fs::remove_dir_all(&absolute).await;
		return Err(if let Some(sha) = &options.sha {
			Error::backend(
				"failed to checkout SHA",
				format!("{sha} in cloned repository {url}: {err}"),
			)
		} else {
			err
		});
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn cancelled_run_rejects_before_process_admission() {
		let root = tempfile::tempdir().unwrap();
		let cancel = CancellationToken::new();
		cancel.cancel();
		let result = run(&root.path().join("absent"), &["status".into()], &RunOptions {
			cancel: Some(cancel),
			..RunOptions::default()
		})
		.await;
		assert!(matches!(result, Err(Error::Canceled)), "{result:?}");
	}

	#[cfg(unix)]
	async fn wait_for_fixture(path: &Path) {
		tokio::time::timeout(Duration::from_secs(5), async {
			while !path.exists() {
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		})
		.await
		.expect("git helper did not reach its fixture boundary");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn cancellation_completes_owned_helper_term_cleanup() {
		use std::os::unix::fs::PermissionsExt;

		let root = tempfile::tempdir().unwrap();
		let git = root.path().join("git");
		std::fs::write(&git, "#!/bin/sh\n/bin/sh ./helper &\nwait\n").unwrap();
		std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
		std::fs::write(
			root.path().join("helper"),
			"trap '/bin/cat cleanup-output || exit 1; /bin/cat cleanup-output >&2 || exit 1; printf \
			 cleaned > cleaned; printf done > done; exit 0' TERM\nprintf ready > ready\n/bin/sleep \
			 2\nprintf late > late\nprintf done > done\n",
		)
		.unwrap();
		std::fs::write(root.path().join("cleanup-output"), "output\n".repeat(32 * 1024)).unwrap();
		let cancel = CancellationToken::new();
		let args = ["custody".into()];
		let options = RunOptions {
			cancel: Some(cancel.clone()),
			env: Some(BTreeMap::from([("PATH".into(), root.path().to_str().unwrap().to_owned())])),
			..RunOptions::default()
		};
		let trigger = async {
			wait_for_fixture(&root.path().join("ready")).await;
			cancel.cancel();
		};
		let (result, ()) = tokio::join!(run(root.path(), &args, &options), trigger);
		assert!(matches!(result, Err(Error::Canceled)), "{result:?}");
		assert_eq!(std::fs::read(root.path().join("cleaned")).unwrap(), b"cleaned");
		assert_eq!(std::fs::read(root.path().join("done")).unwrap(), b"done");
		assert!(!root.path().join("late").exists());
	}

	#[cfg(unix)]
	#[test]
	fn sync_deadline_includes_inherited_output_pipes() {
		let root = tempfile::tempdir().unwrap();
		let ready = root.path().join("ready");
		let observed_ready = ready.clone();
		let release = root.path().join("release");
		let releaser = std::thread::spawn(move || {
			let deadline = std::time::Instant::now() + Duration::from_secs(5);
			while !ready.exists() && std::time::Instant::now() < deadline {
				std::thread::sleep(Duration::from_millis(10));
			}
			std::thread::sleep(Duration::from_secs(2));
			std::fs::write(release, b"release").unwrap();
		});
		let result = run_sync(
			root.path(),
			&[
				"-c".into(),
				"alias.held=!{ printf ready > ready; while [ ! -f release ]; do sleep 0.01; done; \
				 printf escaped > escaped; } &"
					.into(),
				"held".into(),
			],
			Duration::from_secs(1),
		);
		releaser.join().unwrap();
		assert!(observed_ready.exists(), "git helper never started");
		assert!(matches!(result, Err(Error::CliTimeout { .. })), "{result:?}");
		assert!(!root.path().join("escaped").exists());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn async_runner_drains_output_while_delivering_stdin() {
		let dir = tempfile::tempdir().unwrap();
		let init = std::process::Command::new("git")
			.args(["init", "-q"])
			.current_dir(dir.path())
			.status()
			.unwrap();
		assert!(init.success());
		let prefix = "output\n".repeat(32 * 1024);
		let input = "input\n".repeat(32 * 1024);
		std::fs::write(dir.path().join("output-prefix"), &prefix).unwrap();
		let output = tokio::time::timeout(
			Duration::from_secs(10),
			run(
				dir.path(),
				&["-c".into(), "alias.pipeprobe=!cat output-prefix; cat".into(), "pipeprobe".into()],
				&RunOptions {
					stdin: Some(input.as_bytes().to_vec()),
					timeout: Some(Duration::from_secs(5)),
					..RunOptions::default()
				},
			),
		)
		.await
		.expect("stdin delivery must not block the runner deadline")
		.unwrap();
		assert_eq!(output.exit_code, 0);
		assert_eq!(output.stdout, prefix + &input);
		assert_eq!(output.stderr, "");
	}

	/// Set on the re-executed child; carries the fixture repository it should
	/// probe. Its presence is what tells the test body which side it is on.
	const ENV_PROBE_REPO: &str = "PI_VCS_TEST_ENV_PROBE_REPO";

	/// Asks git to report the ambient variables it was started with. A `!`-alias
	/// is the only way to make git print its own environment.
	const ENV_PROBE_ALIAS: &str = r#"!printf 'LC_ALL=[%s] LC_CTYPE=[%s] LC_MESSAGES=[%s] LITERAL=[%s] ICASE=[%s]' "$LC_ALL" "$LC_CTYPE" "$LC_MESSAGES" "$GIT_LITERAL_PATHSPECS" "$GIT_ICASE_PATHSPECS""#;

	/// A git left in the host's process group shares its terminal and can read
	/// the TUI's keystrokes and terminal replies (Tern TSP events leaked into
	/// the composer with their leading bytes missing). Both runners must start
	/// it in its own session.
	#[cfg(unix)]
	#[tokio::test]
	async fn runners_start_git_outside_the_host_process_group() {
		let dir = tempfile::tempdir().expect("tempdir");
		let args = ["-c".to_owned(), "alias.pgid=!ps -o pgid= -p $$".to_owned(), "pgid".to_owned()];
		// SAFETY: getpgrp has no preconditions.
		let host = unsafe { libc::getpgrp() };
		let sync = run_sync(dir.path(), &args, SYNC_TIMEOUT).expect("sync runner");
		let spawned = run(dir.path(), &args, &RunOptions::default())
			.await
			.expect("async runner");
		for out in [sync, spawned] {
			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			let pgid: i32 = out.stdout.trim().parse().expect("pgid");
			assert_ne!(pgid, host, "git shares the host's process group: {out:?}");
		}
	}

	/// Two guarantees this crate builds on top of, both of which depend on what
	/// the child process actually receives:
	///
	/// - The ownership fallback reads git's diagnostic, and `LC_ALL` outranks
	///   `LC_MESSAGES`, so an inherited one hands back a translated message that
	///   [`is_dubious_ownership`] cannot match.
	/// - The `:(literal)` magic this crate builds is only explicit once the
	///   global pathspec modes are gone; `GIT_LITERAL_PATHSPECS=1` would turn
	///   the prefix into filename text and match nothing.
	///
	/// Asserted through [`run_sync`] rather than [`apply_env`] directly, because
	/// the regression this covers was the synchronous builder not calling the
	/// helper. The variables have to be present before the process starts, and
	/// `set_var` in a running test binary is observable by every other thread,
	/// so the probe runs in a re-executed copy of this test binary spawned with
	/// them already in its environment.
	#[test]
	fn sync_runner_pins_message_locale_and_scrubs_pathspec_modes() {
		if let Some(repo) = std::env::var_os(ENV_PROBE_REPO) {
			let out = run_sync(
				Path::new(&repo),
				&["-c".to_owned(), format!("alias.envprobe={ENV_PROBE_ALIAS}"), "envprobe".to_owned()],
				SYNC_TIMEOUT,
			)
			.expect("run alias");

			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			assert!(out.stdout.contains("LC_ALL=[]"), "LC_ALL leaked: {out:?}");
			assert!(out.stdout.contains("LC_MESSAGES=[C]"), "messages not pinned: {out:?}");
			// The character locale is preserved so paths keep round-tripping as
			// UTF-8; only the message locale is forced.
			assert!(
				out.stdout.contains("LC_CTYPE=[fr_FR.UTF-8]"),
				"UTF-8 character locale dropped: {out:?}"
			);
			assert!(out.stdout.contains("LITERAL=[]"), "literal pathspec mode leaked: {out:?}");
			assert!(out.stdout.contains("ICASE=[]"), "icase pathspec mode leaked: {out:?}");
			return;
		}

		let dir = tempfile::tempdir().expect("tempdir");
		let init = std::process::Command::new("git")
			.args(["init", "-q", "-b", "main"])
			.current_dir(dir.path())
			.status()
			.expect("spawn git init");
		assert!(init.success(), "git init failed");

		let name = format!(
			"{}::sync_runner_pins_message_locale_and_scrubs_pathspec_modes",
			module_path!()
				.split_once("::")
				.expect("crate-qualified module path")
				.1
		);
		let child = std::process::Command::new(std::env::current_exe().expect("test binary"))
			.args(["--exact", &name, "--nocapture", "--test-threads=1"])
			.env(ENV_PROBE_REPO, dir.path())
			.env("LC_ALL", "fr_FR.UTF-8")
			.env("GIT_LITERAL_PATHSPECS", "1")
			.env("GIT_ICASE_PATHSPECS", "1")
			.output()
			.expect("re-exec test binary");
		assert!(
			child.status.success(),
			"environment probe failed:\n{}{}",
			String::from_utf8_lossy(&child.stdout),
			String::from_utf8_lossy(&child.stderr)
		);
	}
}
