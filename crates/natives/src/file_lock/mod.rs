//! Cross-process advisory locks backed by platform ownership primitives.
//!
//! Windows uses named mutexes, so it leaves no filesystem artifact. Unix
//! platforms lock a persistent sidecar: Linux takes an open-file-description
//! record lock, other Unix platforms `flock(2)`. Linux also treats a path as
//! held while an older build still binds its abstract-socket name.

use std::{io, path::Path};

use napi::JsString;
use napi_derive::napi;

use crate::js;

#[cfg(target_os = "linux")]
mod legacy_abstract;
#[cfg(unix)]
mod unix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(unix)]
use unix as platform;
#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(not(any(unix, target_os = "windows")))]
compile_error!("omp-natives file locks require Unix or Windows");

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn memory_lock_name(path: &str) -> String {
	const HIGH_SEED: u64 = 0x4f4d_502d_4c4f_434b;
	const LOW_SEED: u64 = 0x5049_2d46_494c_454c;
	let bytes = path.as_bytes();
	let high = xxhash_rust::xxh64::xxh64(bytes, HIGH_SEED);
	let low = xxhash_rust::xxh64::xxh64(bytes, LOW_SEED);
	format!("omp-file-lock-{high:016x}{low:016x}")
}

enum LockLease {
	Path(platform::PlatformFileLock),
	#[cfg(target_os = "linux")]
	Named(std::os::unix::net::UnixDatagram),
}

/// Process-owned cross-platform advisory lock.
///
/// Acquisition is non-blocking; the returned handle reports whether it won
/// through `acquired`. Ownership ends on `release()`, garbage collection, or
/// process exit; `release()` is idempotent.
#[napi(js_name = "FileLock")]
pub struct FileLock {
	inner: Option<LockLease>,
}

fn acquire(path: &str, create: bool) -> io::Result<Option<platform::PlatformFileLock>> {
	#[cfg(unix)]
	let inner = platform::try_acquire_with_create(path, create)?;
	#[cfg(target_os = "windows")]
	let inner = {
		let _ = create;
		platform::try_acquire(path)?
	};
	#[cfg(target_os = "linux")]
	let inner = if inner.is_some() && legacy_abstract::is_bound(path)? {
		None
	} else {
		inner
	};
	Ok(inner)
}

fn acquire_named(name: &str) -> io::Result<Option<LockLease>> {
	#[cfg(target_os = "linux")]
	{
		legacy_abstract::try_bind(name).map(|lease| lease.map(LockLease::Named))
	}
	#[cfg(not(target_os = "linux"))]
	{
		let _ = name;
		Err(io::ErrorKind::Unsupported.into())
	}
}

#[napi]
impl FileLock {
	/// Try to acquire a lock directly from native Rust code.
	///
	/// This is crate-only so native subsystems share the same kernel-backed
	/// ownership primitive without exposing another JavaScript API.
	pub(crate) fn try_acquire_path(path: &Path) -> io::Result<Self> {
		let path = path.to_str().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "lock path is not valid UTF-8")
		})?;
		acquire(path, true).map(|inner| Self { inner: inner.map(LockLease::Path) })
	}

	pub(crate) fn is_held_path(path: &str) -> io::Result<bool> {
		let held = platform::is_held(path)?;
		#[cfg(target_os = "linux")]
		let held = held || legacy_abstract::is_bound(path)?;
		Ok(held)
	}

	/// Try to acquire `path` without blocking.
	///
	/// File-backed Unix locks create their file by default. `create = false`
	/// refuses symlinks and leaves missing files unacquired.
	/// Name-only Windows locks never create files.
	#[napi(factory)]
	pub fn try_acquire(path: JsString, create: Option<bool>) -> napi::Result<Self> {
		let path = js::utf8(path)?;
		acquire(&path, create.unwrap_or(true))
			.map(|inner| Self { inner: inner.map(LockLease::Path) })
			.map_err(|error| {
				napi::Error::from_reason(format!(
					"Failed to acquire native file lock for {}: {error}",
					&*path
				))
			})
	}

	/// Try to acquire a Linux abstract-socket name without filesystem access.
	///
	/// The exact name bytes select the existing kernel lease protocol. The
	/// socket is retained until release, garbage collection, or process exit.
	/// Coordination is within one network namespace; other platforms reject
	/// this operation.
	#[napi(factory)]
	pub fn try_acquire_named(name: JsString) -> napi::Result<Self> {
		let name = js::utf8(name)?;
		acquire_named(&name)
			.map(|inner| Self { inner })
			.map_err(|error| {
				napi::Error::from_reason(format!(
					"Failed to acquire native named lock for {}: {error}",
					&*name
				))
			})
	}

	/// Whether any handle, in any process including this one, holds `path`.
	///
	/// Observes without taking the lock: an `F_OFD_GETLK` query plus a
	/// `connect(2)` probe of the older abstract-socket name on Linux, an
	/// `F_GETLK` query on other Unix platforms, a `\BaseNamedObjects` directory
	/// listing on Windows. A concurrent `tryAcquire()` never meets it.
	#[napi]
	pub fn is_held(path: JsString) -> napi::Result<bool> {
		let path = js::utf8(path)?;
		Self::is_held_path(&path).map_err(|error| {
			napi::Error::from_reason(format!(
				"Failed to probe native file lock for {}: {error}",
				&*path
			))
		})
	}

	/// Whether this handle owns the requested lock.
	#[napi(getter)]
	#[allow(clippy::missing_const_for_fn, reason = "napi method signature")]
	pub fn acquired(&self) -> bool {
		self.is_acquired()
	}

	/// Whether this native handle owns the requested lock.
	pub(crate) const fn is_acquired(&self) -> bool {
		self.inner.is_some()
	}

	/// Release this handle's ownership without affecting a successor.
	#[napi]
	pub fn release(&mut self) -> napi::Result<()> {
		self.release_native().map_err(|error| {
			napi::Error::from_reason(format!("Failed to release native file lock: {error}"))
		})
	}

	/// Release native ownership while preserving the handle on failure.
	pub(crate) fn release_native(&mut self) -> io::Result<()> {
		let Some(inner) = self.inner.take() else {
			return Ok(());
		};
		match inner {
			LockLease::Path(mut lease) => {
				if let Err(error) = lease.release() {
					self.inner = Some(LockLease::Path(lease));
					return Err(error);
				}
			},
			#[cfg(target_os = "linux")]
			LockLease::Named(lease) => drop(lease),
		}
		Ok(())
	}
}

impl Drop for FileLock {
	fn drop(&mut self) {
		let _ = self.release_native();
	}
}

// Android has no probe (`unix::is_held` reports Unsupported).
#[cfg(all(test, not(target_os = "android")))]
mod tests {
	use std::time::{SystemTime, UNIX_EPOCH};

	use super::{acquire, platform::is_held};

	fn unique_lock_path(label: &str) -> String {
		let nonce = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock")
			.as_nanos();
		let path =
			std::env::temp_dir().join(format!("omp-file-lock-{label}-{}-{nonce}", std::process::id()));
		path.to_str().expect("utf-8 temp path").to_owned()
	}

	#[test]
	fn probe_sees_holder_without_taking_the_lock() {
		let path = unique_lock_path("probe");
		let path = path.as_str();
		assert!(!is_held(path).expect("probe unlocked path"));
		let mut lease = acquire(path, true).expect("acquire").expect("free lease");
		assert!(is_held(path).expect("probe held path"));
		lease.release().expect("release");
		assert!(!is_held(path).expect("probe released path"));
		// A probe never leaves the path held for the next acquirer.
		let mut successor = acquire(path, true)
			.expect("reacquire")
			.expect("probe left the lease free");
		successor.release().expect("release successor");
		let _ = std::fs::remove_file(path);
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn lock_held_by_an_older_build_is_respected() {
		use std::{
			os::{
				linux::net::SocketAddrExt,
				unix::net::{SocketAddr, UnixDatagram},
			},
			path::Path,
		};

		use super::FileLock;

		let path = unique_lock_path("legacy");
		let name = super::memory_lock_name(&path);
		let address = SocketAddr::from_abstract_name(name.as_bytes()).expect("abstract name");
		let older_build = UnixDatagram::bind_addr(&address).expect("bind the older build's name");

		let refused = FileLock::try_acquire_path(Path::new(&path)).expect("acquire attempt");
		assert!(!refused.is_acquired());
		assert!(FileLock::is_held_path(&path).expect("probe while the older build holds it"));
		for create in [false, true] {
			assert!(
				super::acquire(&path, create)
					.expect("shared acquisition")
					.is_none()
			);
		}

		drop(older_build);
		assert!(!FileLock::is_held_path(&path).expect("probe after the older build exits"));
		let mut lock = FileLock::try_acquire_path(Path::new(&path)).expect("acquire");
		assert!(lock.is_acquired());
		lock.release_native().expect("release");
		let _ = std::fs::remove_file(&path);
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn named_lease_excludes_old_and_intermediate_owners_until_release_or_drop() {
		use std::os::{
			linux::net::SocketAddrExt,
			unix::net::{SocketAddr, UnixDatagram},
		};

		use super::{FileLock, acquire_named};

		let root = tempfile::tempdir().expect("private lock directory");
		let sidecar = root.path().join("publication.lock");
		std::fs::write(&sidecar, []).expect("prepare intermediate sidecar");
		let sidecar = sidecar.to_str().expect("UTF-8 sidecar");
		let key_path = root.path().join("logical name α");
		let key = key_path.to_str().expect("UTF-8 logical name");
		let address =
			SocketAddr::from_abstract_name(super::memory_lock_name(key).as_bytes()).expect("address");

		let old_owner = UnixDatagram::bind_addr(&address).expect("old protocol owner");
		assert!(acquire_named(key).expect("old owner contention").is_none());
		drop(old_owner);

		let intermediate_file = acquire(sidecar, false)
			.expect("intermediate file")
			.expect("free file");
		let intermediate_name = UnixDatagram::bind_addr(&address).expect("intermediate named owner");
		assert!(
			acquire_named(key)
				.expect("intermediate contention")
				.is_none()
		);
		drop(intermediate_name);

		// The name and sidecar are distinct resources; the file alone cannot
		// prevent acquiring the logical lease.
		let mut owner = FileLock { inner: acquire_named(key).expect("new owner") };
		assert!(owner.is_acquired());
		assert!(!key_path.exists());
		assert!(acquire_named(key).expect("new owner contention").is_none());
		assert_eq!(
			UnixDatagram::bind_addr(&address)
				.expect_err("new owner excludes old protocol")
				.kind(),
			std::io::ErrorKind::AddrInUse
		);
		drop(intermediate_file);

		// An intermediate owner can take its file first, but cannot enter
		// while the new owner retains the same kernel name.
		let intermediate_file = acquire(sidecar, false)
			.expect("intermediate file")
			.expect("free file");
		assert_eq!(
			UnixDatagram::bind_addr(&address)
				.expect_err("new owner excludes intermediate")
				.kind(),
			std::io::ErrorKind::AddrInUse
		);
		drop(intermediate_file);
		assert!(!is_held(sidecar).expect("no leaked intermediate file lease"));
		owner.release_native().expect("release name");
		owner.release_native().expect("idempotent release");
		drop(UnixDatagram::bind_addr(&address).expect("old protocol after release"));

		let owner = FileLock { inner: acquire_named(key).expect("reacquire") };
		assert!(owner.is_acquired());
		drop(owner);
		drop(UnixDatagram::bind_addr(&address).expect("old protocol after owner drop"));
	}

	#[cfg(not(target_os = "linux"))]
	#[test]
	fn named_lease_rejects_unsupported_platforms() {
		let error = super::acquire_named("logical name")
			.err()
			.expect("unsupported named lease");
		assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
	}
}
