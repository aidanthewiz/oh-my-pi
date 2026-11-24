use super::*;

#[cfg(windows)]
#[test]
fn safe_links_respects_windows_roots_and_both_separators() {
	for (target, link, unsafe_target) in [
		(r"C:\outside\marker", "link", true),
		(r"C:outside\marker", "link", true),
		(r"\outside\marker", "link", true),
		(r"\\server\share\marker", "link", true),
		(r"..\outside\marker", "link", true),
		(r"..\../outside", "dir/link", true),
		(r"dir\..\outside", "dir/link", true),
		(r"..\sibling", r"dir\link", false),
		(r"..\..\outside", r"dir\link", true),
		(r"sub\marker", "link", false),
		("sub/marker", "link", false),
	] {
		assert_eq!(
			unsafe_symlink(target.as_bytes(), link.as_bytes()),
			unsafe_target,
			"{target} from {link}",
		);
	}
}

#[cfg(unix)]
#[test]
fn safe_links_preserves_literal_unix_backslashes() {
	for target in [r"C:\outside\marker", r"..\outside\marker", r"sub\..\marker"] {
		assert!(!unsafe_symlink(target.as_bytes(), b"link"), "{target}");
	}
	assert!(unsafe_symlink(b"../outside", b"link"));
	assert!(!unsafe_symlink(b"../sibling", b"dir/link"));
	assert!(unsafe_symlink(b"../sibling", br"dir\link"));
}

#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos", target_os = "ios"))]
#[test]
fn operator_walk_reads_only_the_approved_symlink_object() {
	use std::{cell::Cell, fs, os::unix::fs::{PermissionsExt, symlink}};

	let guard = tempfile::tempdir().unwrap();
	let private = fs::canonicalize(guard.path()).unwrap();
	let base = private.join("writable");
	fs::create_dir(&base).unwrap();
	fs::write(base.join("approved"), b"- approved-only\n").unwrap();
	fs::write(base.join("replacement"), b"+ replacement-only\n").unwrap();
	symlink("approved", base.join("rules")).unwrap();
	fs::set_permissions(&base, fs::Permissions::from_mode(0o777)).unwrap();
	let replaced = Cell::new(false);
	let trusted = |_uid| {
		if !replaced.replace(true) {
			fs::rename(base.join("rules"), base.join("retained-link")).unwrap();
			symlink("replacement", base.join("rules")).unwrap();
		}
		true
	};
	let walk = OwnerWalk { confine: None, trusted: &trusted };
	let path = base.join("rules");
	let opened = owner_walk_open(path.as_os_str().as_bytes(), libc::O_RDONLY, 0, &walk);
	assert!(replaced.get(), "the ownership decision must reach the replacement seam");
	match opened {
		Ok(fd) => assert_eq!(
			std::io::read_to_string(fs::File::from(fd)).unwrap(),
			"- approved-only\n",
		),
		Err(error) => assert!(is_untrusted_symlink(&error), "{error}"),
	}
	assert_eq!(fs::read_link(base.join("rules")).unwrap(), PathBuf::from("replacement"));
}
