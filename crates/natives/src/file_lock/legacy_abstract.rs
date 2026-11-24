use std::{
	io,
	os::{
		linux::net::SocketAddrExt,
		unix::net::{SocketAddr, UnixDatagram},
	},
};

/// Acquire a logical name using the unchanged abstract-socket protocol.
pub fn try_bind(key: &str) -> io::Result<Option<UnixDatagram>> {
	let address = SocketAddr::from_abstract_name(super::memory_lock_name(key).as_bytes())?;
	match UnixDatagram::bind_addr(&address) {
		Ok(socket) => Ok(Some(socket)),
		Err(error) if error.kind() == io::ErrorKind::AddrInUse => Ok(None),
		Err(error) => Err(error),
	}
}

/// Whether an older omp build holds `path` by binding its abstract-socket
/// name. `connect(2)` resolves the name without binding it. An LSM or seccomp
/// policy can refuse that connect (`EACCES`/`EPERM`); the probe then cannot
/// tell, and reads the name as not bound so a sandboxed process can still take
/// leases (accepting that it may miss an older build outside the sandbox).
pub fn is_bound(path: &str) -> io::Result<bool> {
	let address = SocketAddr::from_abstract_name(super::memory_lock_name(path).as_bytes())?;
	match UnixDatagram::unbound()?.connect_addr(&address) {
		Ok(()) => Ok(true),
		Err(error)
			if matches!(
				error.kind(),
				io::ErrorKind::ConnectionRefused | io::ErrorKind::PermissionDenied
			) =>
		{
			Ok(false)
		},
		Err(error) => Err(error),
	}
}
