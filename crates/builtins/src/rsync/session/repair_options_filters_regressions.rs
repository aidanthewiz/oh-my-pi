use std::fs;

use crate::host::run_util;
use crate::rsync::Rsync;

#[test]
fn supplied_nonpositive_deletion_caps_never_mean_unlimited() {
	for limit in [Some("-2147483648"), Some("-1"), Some("0"), Some("1"), None] {
		let tree = tempfile::tempdir().unwrap();
		fs::create_dir(tree.path().join("src")).unwrap();
		fs::create_dir(tree.path().join("dst")).unwrap();
		fs::write(tree.path().join("src/keep"), b"same").unwrap();
		fs::write(tree.path().join("dst/keep"), b"same").unwrap();
		fs::write(tree.path().join("dst/extra"), b"synthetic sentinel").unwrap();
		let option = limit.map(|limit| format!("--max-delete={limit}"));
		let mut args = vec!["-r", "--delete-before"];
		if let Some(option) = &option {
			args.push(option);
		}
		args.extend(["src/", "dst/"]);
		let (code, capture) = run_util::<Rsync>(&args, "", tree.path());
		assert_eq!(fs::read(tree.path().join("dst/keep")).unwrap(), b"same");
		if matches!(limit, Some("-2147483648" | "-1" | "0")) {
			assert_eq!(fs::read(tree.path().join("dst/extra")).unwrap(), b"synthetic sentinel");
			assert_eq!(code, 25, "limit={limit:?}: {}", capture.err());
		} else {
			assert!(!tree.path().join("dst/extra").exists());
			assert_eq!(code, 0, "limit={limit:?}: {}", capture.err());
		}
	}
}

#[test]
fn multiple_source_roots_keep_ancestor_exclusions_and_local_precedence() {
	for reverse in [false, true] {
		let tree = tempfile::tempdir().unwrap();
		for root in ["a", "b"] {
			fs::create_dir_all(tree.path().join(format!("src/{root}/nested"))).unwrap();
			for prefix in [format!("src/{root}"), format!("src/{root}/nested")] {
				fs::write(tree.path().join(format!("{prefix}/secret.dat")), b"synthetic secret").unwrap();
				fs::write(tree.path().join(format!("{prefix}/only-a.dat")), b"local precedence").unwrap();
				fs::write(tree.path().join(format!("{prefix}/public.dat")), b"public").unwrap();
			}
		}
		fs::write(tree.path().join("src/.rsync-filter"), b"- secret.dat\n").unwrap();
		fs::write(tree.path().join("src/a/.rsync-filter"), b"- only-a.dat\n").unwrap();
		fs::create_dir(tree.path().join("dst")).unwrap();
		let roots = if reverse { ["src/b", "src/a"] } else { ["src/a", "src/b"] };
		let (code, cap) = run_util::<Rsync>(
			&["-r", "--no-inc-recursive", "-F", roots[0], roots[1], "dst/"],
			"",
			tree.path(),
		);
		assert_eq!(code, 0, "{}", cap.err());
		for root in ["a", "b"] {
			for prefix in [format!("dst/{root}"), format!("dst/{root}/nested")] {
				assert!(!tree.path().join(format!("{prefix}/secret.dat")).exists());
				assert_eq!(fs::read(tree.path().join(format!("{prefix}/public.dat"))).unwrap(), b"public");
				if root == "a" {
					assert!(!tree.path().join(format!("{prefix}/only-a.dat")).exists());
				} else {
					assert_eq!(fs::read(tree.path().join(format!("{prefix}/only-a.dat"))).unwrap(), b"local precedence");
				}
			}
		}
	}
}

#[cfg(unix)]
#[tokio::test]
async fn invocation_umask_controls_client_and_server_only_symbolic_chmod() {
	use std::os::unix::fs::PermissionsExt;
	use crate::extras::{self, Fd, Invocation};

	async fn run(mask: u32, args: &[&str], cwd: &std::path::Path) -> (i32, String) {
		let error = tempfile::NamedTempFile::new().unwrap();
		let mut invocation = Invocation::new(
			args.iter().map(ToString::to_string).collect(),
			cwd.to_path_buf(),
			omp_vfs::Fs::native().with_creation_mask(Some(mask)),
		);
		invocation.stdio[2] = Fd::File(error.as_file().try_clone().unwrap());
		let code = extras::run(invocation).await;
		(code, fs::read_to_string(error.path()).unwrap())
	}

	let tree = tempfile::tempdir().unwrap();
	fs::write(tree.path().join("src"), b"synthetic payload").unwrap();
	fs::set_permissions(tree.path().join("src"), fs::Permissions::from_mode(0o400)).unwrap();
	for (mask, expected) in [(0o077, 0o600), (0o000, 0o666)] {
		for (kind, option) in [("client", "--chmod=+rw"), ("server", "-M--chmod=+rw")] {
			let dest = format!("{kind}-{mask:o}");
			let (code, err) = run(mask, &["rsync", "-p", option, "src", &dest], tree.path()).await;
			assert_eq!(code, 0, "{err}");
			assert_eq!(fs::metadata(tree.path().join(&dest)).unwrap().permissions().mode() & 0o777, expected);
			assert_eq!(fs::read(tree.path().join(dest)).unwrap(), b"synthetic payload");
		}
		let dest = format!("explicit-{mask:o}");
		let (code, err) =
			run(mask, &["rsync", "-p", "--chmod=u=rw,g=r,o=r", "src", &dest], tree.path()).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(fs::metadata(tree.path().join(&dest)).unwrap().permissions().mode() & 0o777, 0o644);
		assert_eq!(fs::read(tree.path().join(dest)).unwrap(), b"synthetic payload");
	}
}
