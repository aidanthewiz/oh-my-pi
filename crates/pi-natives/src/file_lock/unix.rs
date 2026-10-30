use std::{
	fs::{File, OpenOptions, TryLockError},
	io,
	os::unix::fs::OpenOptionsExt,
};

/// Unix lock held by a persistent sidecar's open file description.
pub struct PlatformFileLock {
	file: Option<File>,
}

pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	try_acquire_with_create(path, true)
}

pub fn try_acquire_with_create(path: &str, create: bool) -> io::Result<Option<PlatformFileLock>> {
	let mut options = OpenOptions::new();
	options
		.read(true)
		.write(true)
		.create(create)
		.truncate(false)
		.mode(0o600);
	if !create {
		options.custom_flags(libc::O_NOFOLLOW);
	}
	let file = match options.open(path) {
		Ok(file) => file,
		Err(error) if !create && error.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error),
	};
	// The lock is attached to this open file description (`flock(2)`).
	match file.try_lock() {
		Ok(()) => Ok(Some(PlatformFileLock { file: Some(file) })),
		Err(TryLockError::WouldBlock) => Ok(None),
		Err(TryLockError::Error(error)) => Err(error),
	}
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.file.take());
		Ok(())
	}
}
