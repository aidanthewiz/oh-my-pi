use std::{
	cell::RefCell,
	collections::VecDeque,
	os::{fd::AsRawFd, unix::ffi::OsStrExt},
	path::PathBuf,
	sync::atomic::{AtomicUsize, Ordering},
	time::UNIX_EPOCH,
};

use super::*;

thread_local! {
	static ERRORS: RefCell<VecDeque<Option<i32>>> = const { RefCell::new(VecDeque::new()) };
}

pub(super) fn next_bulk_error() -> Option<i32> {
	ERRORS.with(|errors| errors.borrow_mut().pop_front().flatten())
}

struct Faults;

impl Faults {
	fn new(errors: impl IntoIterator<Item = Option<i32>>) -> Self {
		ERRORS.with(|slot| {
			let mut slot = slot.borrow_mut();
			assert!(slot.is_empty(), "nested bulk fault fixture");
			*slot = errors.into_iter().collect();
		});
		Self
	}
}

impl Drop for Faults {
	fn drop(&mut self) {
		ERRORS.with(|slot| slot.borrow_mut().clear());
	}
}

struct Fixture(PathBuf);

impl Fixture {
	fn new() -> Self {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let path = std::env::temp_dir().join(format!(
			"pg-darwin-regression-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, Ordering::Relaxed)
		));
		std::fs::create_dir(&path).unwrap();
		Self(path)
	}
}

impl Drop for Fixture {
	fn drop(&mut self) {
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

fn rows(listing: &Listing, fixture: &Fixture) -> Vec<(Vec<u8>, FileType, Option<u64>)> {
	let mut rows: Vec<_> = listing
		.records()
		.iter()
		.map(|record| {
			let name = listing.name(record);
			let path = fixture.0.join(std::ffi::OsStr::from_bytes(name));
			let meta = std::fs::symlink_metadata(path).unwrap();
			let mtime = meta
				.modified()
				.unwrap()
				.duration_since(UNIX_EPOCH)
				.unwrap()
				.as_nanos() as i64;
			assert_eq!(record.mtime, Some(mtime), "{name:?}");
			(name.to_vec(), record.file_type, record.size)
		})
		.collect();
	rows.sort_by(|a, b| a.0.cmp(&b.0));
	rows
}

#[test]
fn initial_unsupported_bulk_preserves_full_listing_metadata() {
	for errno in [libc::ENOTSUP, libc::EINVAL] {
		let fixture = Fixture::new();
		std::fs::write(fixture.0.join("a"), b"hello").unwrap();
		std::fs::write(fixture.0.join("raw-%20"), b"raw").unwrap();
		std::fs::create_dir(fixture.0.join("sub")).unwrap();
		std::os::unix::fs::symlink("missing", fixture.0.join("link")).unwrap();
		let fifo = std::ffi::CString::new(fixture.0.join("fifo").as_os_str().as_bytes()).unwrap();
		// SAFETY: `fifo` is a NUL-terminated synthetic fixture path.
		assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
		let dir = std::fs::File::open(&fixture.0).unwrap();
		let _faults = Faults::new([Some(errno)]);
		let mut listing = Listing::default();
		list(&mut Scratch::default(), dir.as_raw_fd(), Detail::Full, 0, &mut listing).unwrap();
		assert_eq!(
			rows(&listing, &fixture),
			vec![
				(b"a".to_vec(), FileType::File, Some(5)),
				(b"link".to_vec(), FileType::Symlink, None),
				(b"raw-%20".to_vec(), FileType::File, Some(3)),
				(b"sub".to_vec(), FileType::Dir, None),
			],
			"initial errno {errno}"
		);
	}
}

#[test]
fn unsupported_bulk_after_progress_does_not_restart() {
	for errno in [libc::ENOTSUP, libc::EINVAL] {
		let fixture = Fixture::new();
		std::fs::write(fixture.0.join("a"), b"hello").unwrap();
		let dir = std::fs::File::open(&fixture.0).unwrap();
		let _faults = Faults::new([None, Some(errno)]);
		let mut listing = Listing::default();
		let error =
			list(&mut Scratch::default(), dir.as_raw_fd(), Detail::Full, 0, &mut listing).unwrap_err();
		assert_eq!(error.raw_os_error(), Some(errno));
		assert_eq!(rows(&listing, &fixture), vec![(b"a".to_vec(), FileType::File, Some(5))]);
	}
}

#[test]
fn initial_unrelated_bulk_error_is_not_hidden() {
	let fixture = Fixture::new();
	std::fs::write(fixture.0.join("a"), b"hello").unwrap();
	let dir = std::fs::File::open(&fixture.0).unwrap();
	let _faults = Faults::new([Some(libc::EACCES)]);
	let mut listing = Listing::default();
	let error =
		list(&mut Scratch::default(), dir.as_raw_fd(), Detail::Full, 0, &mut listing).unwrap_err();
	assert_eq!(error.raw_os_error(), Some(libc::EACCES));
	assert!(listing.is_empty());
}
