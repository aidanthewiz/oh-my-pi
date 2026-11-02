//! A reference `rsync --daemon` per side, killed on drop.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Message of the day every listing and transfer prints (unless `--no-motd`).
const MOTD: &str = "Welcome to the conformance daemon\n";

/// Fresh ports tried before giving up.
const ATTEMPTS: usize = 6;

/// How long one attempt waits for the daemon to accept connections. Generous:
/// a loaded machine can take seconds to schedule a freshly spawned process.
const READY_DEADLINE: Duration = Duration::from_secs(30);

/// A running daemon serving `w`'s modules:
///
/// - `rw`: `w/rw`, writable;
/// - `ro`: `w/src`, read-only (the default);
/// - `auth`: `w/src`, user `alice` with password `sekrit` (`{BIN}/pw`);
/// - `hidden`: `w/src`, unlisted.
pub(super) struct Daemon {
	child: Child,
	/// The port it listens on.
	pub(super) port: u16,
}

/// Why one start attempt failed.
enum Failure {
	/// The daemon exited (typically: another process took the port between
	/// our probe and its bind).
	Exited(String),
	/// It never answered with a greeting before the deadline.
	NotReady,
}

fn ready_module(dir: &Path) -> String {
	let mut hash = DefaultHasher::new();
	dir.hash(&mut hash);
	format!("__conformance_ready_{:016x}", hash.finish())
}

impl Daemon {
	/// Starts the daemon with its config, secrets, motd, and log under `dir`
	/// and waits until it greets on its port. A port race (the probed port is
	/// taken before the daemon binds it) or a slow start retries on a fresh
	/// port; after [`ATTEMPTS`] failures this panics with the daemon log.
	pub(super) fn start(reference: &Path, dir: &Path, w: &Path) -> Self {
		fs::create_dir_all(dir).unwrap();
		let secrets = dir.join("secrets");
		fs::write(&secrets, "alice:sekrit\n").unwrap();
		fs::set_permissions(&secrets, fs::Permissions::from_mode(0o600)).unwrap();
		fs::write(dir.join("motd"), MOTD).unwrap();
		let log = dir.join("log");
		let readiness = ready_module(dir);
		let (d, w) = (dir.display(), w.display());
		let conf = format!(
			"pid file = {d}/pid\nlog file = {d}/log\nmotd file = {d}/motd\nuse chroot = no\n\
			 munge symlinks = no\naddress = 127.0.0.1\n\n\
			 [rw]\n\tpath = {w}/rw\n\tcomment = read-write module\n\tread only = no\n\n\
			 [ro]\n\tpath = {w}/src\n\tcomment = read-only module\n\n\
			 [auth]\n\tpath = {w}/src\n\tcomment = needs a password\n\tauth users = alice\n\
			 \tsecrets file = {d}/secrets\n\n\
			 [hidden]\n\tpath = {w}/src\n\tlist = no\n\n\
			 [{readiness}]\n\tpath = {d}\n\tlist = no\n"
		);
		let config = dir.join("rsyncd.conf");
		fs::write(&config, conf).unwrap();
		let mut history = String::new();
		for attempt in 1..=ATTEMPTS {
			// A stale pid file from a failed attempt makes the daemon refuse
			// to start; a fresh log keeps each attempt's report separate.
			let _ = fs::remove_file(dir.join("pid"));
			let _ = fs::remove_file(&log);
			let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
			let mut child = Command::new(reference)
				.arg("--daemon")
				.arg("--no-detach")
				.arg("--address=127.0.0.1")
				.arg(format!("--port={port}"))
				.arg(format!("--config={}", config.display()))
				.env_clear()
				.stdin(Stdio::null())
				.stdout(Stdio::null())
				.stderr(Stdio::null())
				.spawn()
				.unwrap();
			let failure = match wait_ready(&mut child, port, &readiness) {
				Ok(()) => return Self { child, port },
				Err(failure) => failure,
			};
			let _ = child.kill();
			let _ = child.wait();
			let why = match failure {
				Failure::Exited(status) => format!("exited ({status})"),
				Failure::NotReady => format!("did not greet within {READY_DEADLINE:?}"),
			};
			let log_text = fs::read_to_string(&log).unwrap_or_else(|e| format!("<no log: {e}>"));
			history.push_str(&format!("attempt {attempt}, port {port}: {why}; log:\n{log_text}\n"));
		}
		panic!("reference daemon failed to start after {ATTEMPTS} attempts:\n{history}");
	}
}

/// Waits for this config's hidden module, rejecting unrelated rsync listeners.
fn wait_ready(child: &mut Child, port: u16, readiness: &str) -> Result<(), Failure> {
	let deadline = Instant::now() + READY_DEADLINE;
	loop {
		if let Ok(Some(status)) = child.try_wait() {
			return Err(Failure::Exited(status.to_string()));
		}
		if greets(port, readiness) {
			// Still ours: a daemon that lost the bind race exits.
			return match child.try_wait() {
				Ok(Some(status)) => Err(Failure::Exited(status.to_string())),
				_ => Ok(()),
			};
		}
		if Instant::now() >= deadline {
			return Err(Failure::NotReady);
		}
		std::thread::sleep(Duration::from_millis(25));
	}
}

/// A generic greeting alone cannot establish ownership of a recycled port.
fn greets(port: u16, readiness: &str) -> bool {
	let Ok(stream) = TcpStream::connect(("127.0.0.1", port)) else { return false };
	let timeout = Duration::from_secs(5);
	let deadline = Instant::now() + timeout;
	if stream.set_read_timeout(Some(timeout)).is_err() || stream.set_write_timeout(Some(timeout)).is_err() {
		return false;
	}
	let mut reader = BufReader::new(stream);
	let mut line = String::new();
	if reader.read_line(&mut line).is_err() || !line.starts_with("@RSYNCD: ") {
		return false;
	}
	if write!(reader.get_mut(), "@RSYNCD: 31.0\n{readiness}\n").is_err() {
		return false;
	}
	for _ in 0..4 {
		let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { return false };
		if reader.get_mut().set_read_timeout(Some(remaining)).is_err() {
			return false;
		}
		line.clear();
		if !matches!(reader.read_line(&mut line), Ok(size) if size > 0) {
			return false;
		}
		if line.trim_end() == "@RSYNCD: OK" {
			return true;
		}
		if line.starts_with("@ERROR") {
			return false;
		}
	}
	false
}

impl Drop for Daemon {
	fn drop(&mut self) {
		let _ = self.child.kill();
		let _ = self.child.wait();
	}
}

#[cfg(test)]
mod tests {
	use super::{Daemon, greets, ready_module};

	#[test]
	fn readiness_requires_the_owned_daemon_configuration() {
		let Some(reference) = super::super::reference() else { return };
		let root = tempfile::tempdir().unwrap();
		let work = root.path().join("work");
		std::fs::create_dir_all(work.join("src")).unwrap();
		std::fs::create_dir(work.join("rw")).unwrap();
		let config = root.path().join("daemon");
		let daemon = Daemon::start(&reference, &config, &work);
		assert!(greets(daemon.port, &ready_module(&config)));
		assert!(!greets(daemon.port, &ready_module(&root.path().join("foreign-daemon"))));
	}
}
