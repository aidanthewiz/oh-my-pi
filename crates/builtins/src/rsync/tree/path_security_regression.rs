use super::*;

fn native_tree(root: &Path) -> Tree {
	Tree::open(&BlockingFs::native(), root, &TreeOpts::default()).unwrap()
}

#[test]
#[ignore = "subprocess worker; invoked by fifo_replacement_* tests"]
fn fifo_open_worker() {
	use std::os::unix::fs::OpenOptionsExt;

	let root = std::env::var_os("COREFORGE_RSYNC_FIFO_FIXTURE").expect("worker fixture");
	let mode = std::env::var("COREFORGE_RSYNC_FIFO_MODE").expect("worker mode");
	let root = Path::new(&root);
	let tree = native_tree(root);
	let _reader = (mode == "write-with-reader").then(|| {
		std::fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(root.join("file"))
			.unwrap()
	});
	let error = match mode.as_str() {
		"read" => tree.open_read(Path::new("file"), false).unwrap_err(),
		"write" | "write-with-reader" => tree.open_write(Path::new("file"), false, false).unwrap_err(),
		_ => panic!("unknown worker mode"),
	};
	let expected = if mode == "write" { libc::ENXIO } else { libc::EINVAL };
	assert_eq!(error.raw_os_error(), Some(expected));
	std::fs::write(root.join("worker-result"), mode.as_bytes()).unwrap();
}

fn check_fifo_replacement(mode: &str) {
	use std::{process::{Child, Command, Stdio}, time::{Duration, Instant}};

	struct Worker(Child);
	impl Drop for Worker {
		fn drop(&mut self) {
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}
	let guard = tempfile::tempdir().unwrap();
	let root = std::fs::canonicalize(guard.path()).unwrap();
	std::fs::write(root.join("file"), b"previous regular file").unwrap();
	let tree = native_tree(&root);
	std::fs::remove_file(root.join("file")).unwrap();
	tree.mknod(Path::new("file"), NodeKind::Fifo, 0o600).unwrap();
	let mut worker = Worker(Command::new(std::env::current_exe().unwrap())
		.args([
			"--ignored", "--exact", "rsync::tree::path_security_regression::fifo_open_worker",
			"--nocapture", "--test-threads=1",
		])
		.env("COREFORGE_RSYNC_FIFO_FIXTURE", &root)
		.env("COREFORGE_RSYNC_FIFO_MODE", mode)
		.stdin(Stdio::null())
		.spawn()
		.unwrap());
	let deadline = Instant::now() + Duration::from_secs(5);
	loop {
		if let Some(status) = worker.0.try_wait().unwrap() {
			assert!(status.success(), "{mode}: {status}");
			break;
		}
		assert!(Instant::now() < deadline, "FIFO file open blocked: {mode}");
		std::thread::sleep(Duration::from_millis(10));
	}
	assert_eq!(std::fs::read(root.join("worker-result")).unwrap(), mode.as_bytes());
}

#[test]
fn fifo_replacement_read_without_writer_is_rejected() {
	check_fifo_replacement("read");
}

#[test]
fn fifo_replacement_write_without_reader_is_rejected() {
	check_fifo_replacement("write");
}

#[test]
fn fifo_replacement_write_with_reader_is_rejected() {
	check_fifo_replacement("write-with-reader");
}

#[cfg(target_os = "macos")]
mod apple {
	use std::{fs, os::unix::fs::symlink};

	use super::*;

	const ATTR: &str = "user.coreforge.rsync-boundary";

	struct Fixture {
		_guard: tempfile::TempDir,
		root: PathBuf,
		tree: Tree,
		held: Tree,
		outside: Tree,
	}

	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = fs::remove_file(&self.root);
		}
	}

	fn replaced_root() -> Fixture {
		let guard = tempfile::tempdir().unwrap();
		let base = fs::canonicalize(guard.path()).unwrap();
		let root = base.join("root");
		let held = base.join("held");
		let outside = base.join("outside");
		fs::create_dir(&root).unwrap();
		fs::create_dir(&outside).unwrap();
		fs::write(root.join("file"), b"held file").unwrap();
		for leaf in ["file", "node"] {
			fs::write(outside.join(leaf), b"outside file").unwrap();
		}
		let tree = native_tree(&root);
		tree.mknod(Path::new("node"), NodeKind::Socket, 0o600).unwrap();
		let outside_tree = native_tree(&outside);
		let name = OsStr::new(ATTR);
		tree.set_xattr(Path::new("file"), name, b"held-marker", false).unwrap();
		for leaf in ["file", "node"] {
			outside_tree.set_xattr(Path::new(leaf), name, b"outside-marker", false).unwrap();
		}
		fs::rename(&root, &held).unwrap();
		symlink(&outside, &root).unwrap();
		Fixture { _guard: guard, root, tree, held: native_tree(&held), outside: outside_tree }
	}

	#[test]
	fn xattr_get_never_discloses_a_replaced_root_path() {
		let fixture = replaced_root();
		let result = fixture.tree.get_xattr(Path::new("node"), OsStr::new(ATTR), false);
		assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EOPNOTSUPP));
	}

	#[test]
	fn xattr_list_never_discloses_a_replaced_root_path() {
		let fixture = replaced_root();
		let result = fixture.tree.list_xattr(Path::new("node"), false);
		assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EOPNOTSUPP));
	}

	#[test]
	fn xattr_set_never_modifies_a_replaced_root_path() {
		let fixture = replaced_root();
		let leaf = Path::new("node");
		let name = OsStr::new(ATTR);
		let result = fixture.tree.set_xattr(leaf, name, b"replaced", false);
		assert_eq!(fixture.outside.get_xattr(leaf, name, false).unwrap(), Some(b"outside-marker".to_vec()));
		assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EOPNOTSUPP));
	}

	#[test]
	fn xattr_remove_never_modifies_a_replaced_root_path() {
		let fixture = replaced_root();
		let leaf = Path::new("node");
		let name = OsStr::new(ATTR);
		let result = fixture.tree.remove_xattr(leaf, name, false);
		assert_eq!(fixture.outside.get_xattr(leaf, name, false).unwrap(), Some(b"outside-marker".to_vec()));
		assert_eq!(result.unwrap_err().raw_os_error(), Some(libc::EOPNOTSUPP));
	}

	#[test]
	fn readable_xattrs_stay_on_the_held_root() {
		let fixture = replaced_root();
		let leaf = Path::new("file");
		let name = OsStr::new(ATTR);
		assert_eq!(fixture.tree.get_xattr(leaf, name, false).unwrap(), Some(b"held-marker".to_vec()));
		assert!(fixture.tree.list_xattr(leaf, false).unwrap().iter().any(|n| n == name));
		fixture.tree.set_xattr(leaf, name, b"held-updated", false).unwrap();
		assert_eq!(fixture.held.get_xattr(leaf, name, false).unwrap(), Some(b"held-updated".to_vec()));
		assert_eq!(fixture.outside.get_xattr(leaf, name, false).unwrap(), Some(b"outside-marker".to_vec()));
		fixture.tree.remove_xattr(leaf, name, false).unwrap();
		assert_eq!(fixture.held.get_xattr(leaf, name, false).unwrap(), None);
		assert_eq!(fixture.outside.get_xattr(leaf, name, false).unwrap(), Some(b"outside-marker".to_vec()));
	}
}
