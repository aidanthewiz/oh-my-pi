use std::{
	collections::BTreeMap,
	fs,
	path::{Path, PathBuf},
	process::Command,
};

use omp_vcs::{
	git::GitRepo,
	types::{WorktreeAddOptions, WorktreeClone},
};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
	let output = Command::new("git")
		.arg("-C")
		.arg(dir)
		.args(args)
		.output()
		.unwrap();
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	String::from_utf8(output.stdout)
		.unwrap()
		.trim_end()
		.to_owned()
}

fn write(root: &Path, relative: &str, contents: &str) {
	let path = root.join(relative);
	fs::create_dir_all(path.parent().unwrap()).unwrap();
	fs::write(path, contents).unwrap();
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
	fn visit(root: &Path, dir: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
		for entry in fs::read_dir(dir).unwrap() {
			let entry = entry.unwrap();
			if entry.file_name() == ".git" {
				continue;
			}
			let path = entry.path();
			let kind = entry.file_type().unwrap();
			if kind.is_dir() {
				visit(root, &path, files);
			} else {
				let bytes = if kind.is_symlink() {
					fs::read_link(&path)
						.unwrap()
						.as_os_str()
						.as_encoded_bytes()
						.to_vec()
				} else {
					fs::read(&path).unwrap()
				};
				files.insert(path.strip_prefix(root).unwrap().to_path_buf(), bytes);
			}
		}
	}
	let mut files = BTreeMap::new();
	visit(root, root, &mut files);
	files
}

fn fixture() -> (TempDir, PathBuf, GitRepo) {
	let temp = tempfile::tempdir().unwrap();
	let source = temp.path().join("source");
	fs::create_dir(&source).unwrap();
	git(&source, &["init", "-q", "-b", "main"]);
	for (key, value) in [
		("user.name", "Test"),
		("user.email", "test@example.com"),
		("commit.gpgsign", "false"),
		("core.autocrlf", "false"),
		("core.excludesFile", ".git/no-global-excludes"),
		("core.hooksPath", ".git/hooks"),
	] {
		git(&source, &["config", key, value]);
	}
	write(&source, "a.txt", "tracked\n");
	write(&source, ".gitignore", "node_modules/\n");
	git(&source, &["add", "."]);
	git(&source, &["commit", "-qm", "base"]);
	write(&source, "node_modules/pkg/index.js", "relocatable cache\n");
	let repo = GitRepo::require(&source).unwrap();
	(temp, source, repo)
}

fn clone_works_on(root: &Path) -> bool {
	let source = root.join("clone-probe-source");
	let target = root.join("clone-probe-target");
	write(&source, "file", "probe\n");
	let works = omp_iso::clone_candidates(None).into_iter().any(|kind| {
		let _ = fs::remove_dir_all(&target);
		omp_iso::backend(kind)
			.clone_tree(&source, &target, &[])
			.is_ok()
	});
	fs::remove_dir_all(source).unwrap();
	let _ = fs::remove_dir_all(target);
	works
}

#[test]
fn clone_excludes_self_ignored_environments_and_nested_cmake_caches() {
	let (temp, source, repo) = fixture();
	if !clone_works_on(temp.path()) {
		eprintln!("SKIP: no working clone backend on this filesystem");
		return;
	}
	let environments = [".venv", ".venv-wt", "custom-python", "apps/api/environment"];
	let script = format!("#!{}/.venv/bin/python\n", source.display());
	for dir in environments {
		write(&source, &format!("{dir}/.gitignore"), "*\n");
		write(&source, &format!("{dir}/pyvenv.cfg"), "home = /source/python\n");
		write(&source, &format!("{dir}/bin/pytest"), &script);
	}
	for dir in ["build", "apps/native/build"] {
		write(&source, &format!("{dir}/.gitignore"), "*\n");
		write(
			&source,
			&format!("{dir}/CMakeCache.txt"),
			&format!("CMAKE_HOME_DIRECTORY:INTERNAL={}\n", source.display()),
		);
		write(&source, &format!("{dir}/artifact"), "source-only build\n");
	}
	let source_before = snapshot(&source);
	let target = temp.path().join("target");
	let result = repo
		.worktree_add(&target, "HEAD", WorktreeAddOptions {
			detach:       true,
			clone:        WorktreeClone::Auto,
			keep_changes: false,
		})
		.unwrap();
	assert!(result.cloned_with.is_some(), "{:?}", result.clone_error);
	for dir in environments
		.into_iter()
		.chain(["build", "apps/native/build"])
	{
		assert!(!target.join(dir).exists(), "nonrelocatable directory {dir} was carried");
	}
	assert_eq!(fs::read_to_string(source.join(".venv/bin/pytest")).unwrap(), script);
	assert_eq!(
		fs::read_to_string(target.join("node_modules/pkg/index.js")).unwrap(),
		"relocatable cache\n"
	);
	assert_eq!(git(&target, &["status", "--porcelain", "--untracked-files=all"]), "");
	assert_eq!(snapshot(&source), source_before, "source files changed during clone reconciliation");
}

#[test]
fn clone_exclusion_keeps_tracked_data_and_keep_changes_state() {
	for keep_changes in [false, true] {
		let (temp, source, repo) = fixture();
		if !clone_works_on(temp.path()) {
			eprintln!("SKIP: no working clone backend on this filesystem");
			return;
		}
		write(&source, "tooling/pyvenv.cfg", "tracked configuration\n");
		write(&source, "tooling/config.txt", "committed\n");
		git(&source, &["add", "tooling"]);
		git(&source, &["commit", "-qm", "track environment data"]);
		write(&source, "tooling/.gitignore", "*\n");
		write(&source, "tooling/bin/pytest", "#!/source/python\n");
		write(&source, "tooling/config.txt", "staged\n");
		git(&source, &["add", "tooling/config.txt"]);
		write(&source, "tooling/config.txt", "staged then edited\n");
		let source_before = snapshot(&source);
		let target = temp.path().join("target");
		let result = repo
			.worktree_add(&target, "HEAD", WorktreeAddOptions {
				detach: true,
				clone: WorktreeClone::Auto,
				keep_changes,
			})
			.unwrap();
		assert!(result.cloned_with.is_some(), "{:?}", result.clone_error);
		assert!(!target.join("tooling/bin/pytest").exists(), "source-bound script was carried");
		assert_eq!(
			fs::read_to_string(target.join("tooling/pyvenv.cfg")).unwrap(),
			"tracked configuration\n"
		);
		assert_eq!(
			fs::read_to_string(target.join("tooling/config.txt")).unwrap(),
			if keep_changes {
				"staged then edited\n"
			} else {
				"committed\n"
			}
		);
		assert_eq!(
			git(&target, &["show", ":tooling/config.txt"]),
			if keep_changes { "staged" } else { "committed" }
		);
		assert_eq!(
			fs::read_to_string(source.join("tooling/bin/pytest")).unwrap(),
			"#!/source/python\n"
		);
		assert_eq!(
			snapshot(&source),
			source_before,
			"source files changed during clone reconciliation"
		);
	}
}

#[test]
fn clone_disabled_or_unavailable_uses_an_ordinary_checkout() {
	for clone in [WorktreeClone::Off, WorktreeClone::Auto] {
		let (temp, source, repo) = fixture();
		write(&source, ".venv/.gitignore", "*\n");
		write(&source, ".venv/pyvenv.cfg", "home = /source/python\n");
		if clone == WorktreeClone::Auto {
			fs::remove_file(source.join(".git/index")).unwrap();
		}
		let source_before = snapshot(&source);
		let target = temp.path().join("target");
		let result = repo
			.worktree_add(&target, "HEAD", WorktreeAddOptions {
				detach: true,
				clone,
				keep_changes: false,
			})
			.unwrap();
		assert!(result.cloned_with.is_none());
		assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "tracked\n");
		assert!(!target.join(".venv").exists());
		assert!(!target.join("node_modules").exists());
		assert_eq!(git(&target, &["status", "--porcelain"]), "");
		assert_eq!(snapshot(&source), source_before);
	}
}

#[test]
fn clone_reconciles_carried_paths_using_target_ignore_rules() {
	let (temp, source, repo) = fixture();
	if !clone_works_on(temp.path()) {
		eprintln!("SKIP: no working clone backend on this filesystem");
		return;
	}
	write(&source, ".gitignore", "node_modules/\ntarget-only/\n");
	write(&source, "apps/.gitignore", "cache/\ntarget-only/\n");
	write(&source, "prompt-exports/tracked.txt", "target-tracked\n");
	git(&source, &["add", "."]);
	git(&source, &["commit", "-qm", "target ignore rules"]);
	let target_commit = git(&source, &["rev-parse", "HEAD"]);
	write(&source, ".gitignore", "node_modules/\nprompt-exports/\n");
	write(&source, "apps/.gitignore", "cache/\nsource-only/\n");
	git(&source, &["rm", "-q", "prompt-exports/tracked.txt"]);
	git(&source, &["add", "."]);
	git(&source, &["commit", "-qm", "source ignore rules"]);
	write(&source, "prompt-exports/tracked.txt", "source-ignored collision\n");
	write(&source, "prompt-exports/note with spaces.md", "source-only ignored\n");
	write(&source, "target-only/note with spaces.md", "target-only ignored\n");
	write(&source, "apps/source-only/note.txt", "nested source-only ignored\n");
	write(&source, "apps/target-only/note.txt", "nested target-only ignored\n");
	write(&source, "apps/cache/blob", "ignored at both commits\n");
	let source_before = snapshot(&source);
	let target = temp.path().join("target");
	let result = repo
		.worktree_add(&target, &target_commit, WorktreeAddOptions {
			detach:       true,
			clone:        WorktreeClone::Auto,
			keep_changes: false,
		})
		.unwrap();
	assert!(result.cloned_with.is_some(), "{:?}", result.clone_error);
	assert!(!target.join("prompt-exports/note with spaces.md").exists());
	assert!(!target.join("apps/source-only").exists());
	for (relative, contents) in [
		("prompt-exports/tracked.txt", "target-tracked\n"),
		("target-only/note with spaces.md", "target-only ignored\n"),
		("apps/target-only/note.txt", "nested target-only ignored\n"),
		("apps/cache/blob", "ignored at both commits\n"),
		("node_modules/pkg/index.js", "relocatable cache\n"),
	] {
		assert_eq!(fs::read_to_string(target.join(relative)).unwrap(), contents, "{relative}");
	}
	assert_eq!(git(&target, &["status", "--porcelain", "--untracked-files=all"]), "");
	assert_eq!(snapshot(&source), source_before, "target cleanup changed source files");
}

#[test]
fn clone_target_cleanup_does_not_discard_keep_changes() {
	let (temp, source, repo) = fixture();
	if !clone_works_on(temp.path()) {
		eprintln!("SKIP: no working clone backend on this filesystem");
		return;
	}
	write(&source, "a.txt", "staged\n");
	git(&source, &["add", "a.txt"]);
	write(&source, "a.txt", "staged then edited\n");
	write(&source, "notes/live note.txt", "untracked work\n");
	let source_before = snapshot(&source);
	let source_status = git(&source, &["status", "--porcelain", "--untracked-files=all"]);
	let target = temp.path().join("target");
	let result = repo
		.worktree_add(&target, "HEAD", WorktreeAddOptions {
			detach:       true,
			clone:        WorktreeClone::Auto,
			keep_changes: true,
		})
		.unwrap();
	assert!(result.cloned_with.is_some(), "{:?}", result.clone_error);
	assert_eq!(snapshot(&target), source_before);
	assert_eq!(git(&target, &["status", "--porcelain", "--untracked-files=all"]), source_status);
	assert_eq!(snapshot(&source), source_before);
}

#[cfg(unix)]
#[test]
fn clone_target_cleanup_keeps_nested_repositories_and_unlinks_only_symlinks() {
	let (temp, source, repo) = fixture();
	if !clone_works_on(temp.path()) {
		eprintln!("SKIP: no working clone backend on this filesystem");
		return;
	}
	let target_commit = git(&source, &["rev-parse", "HEAD"]);
	write(&source, ".gitignore", "node_modules/\nlinks/\nrepositories/\n");
	git(&source, &["add", ".gitignore"]);
	git(&source, &["commit", "-qm", "ignore source-only containers"]);
	let outside = temp.path().join("outside");
	write(&outside, "pyvenv.cfg", "external environment\n");
	write(&outside, "precious.txt", "must not change\n");
	let nested = source.join("repositories/nested");
	fs::create_dir_all(&nested).unwrap();
	git(&nested, &["init", "-q", "-b", "main"]);
	write(&nested, "data.txt", "nested repository data\n");
	git(&nested, &["add", "."]);
	git(&nested, &[
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"nested data",
	]);
	fs::create_dir(source.join("links")).unwrap();
	std::os::unix::fs::symlink(&outside, source.join("links/external")).unwrap();
	let source_before = snapshot(&source);
	let outside_before = snapshot(&outside);
	let target = temp.path().join("target");
	let result = repo
		.worktree_add(&target, &target_commit, WorktreeAddOptions {
			detach:       true,
			clone:        WorktreeClone::Auto,
			keep_changes: false,
		})
		.unwrap();
	assert!(result.cloned_with.is_some(), "{:?}", result.clone_error);
	assert!(target.join("repositories/nested/.git").is_dir());
	assert_eq!(
		fs::read_to_string(target.join("repositories/nested/data.txt")).unwrap(),
		"nested repository data\n"
	);
	assert!(!target.join("links").exists(), "source-only symlink was not unlinked");
	assert_eq!(snapshot(&outside), outside_before, "cleanup followed a symlink outside the clone");
	assert_eq!(snapshot(&source), source_before);
}

fn assert_clone_preserves_ignored_cmake_repository(marked_ancestor: bool) {
	for keep_changes in [false, true] {
		let (temp, source, repo) = fixture();
		if !clone_works_on(temp.path()) {
			eprintln!(
				"SKIP: no working clone backend on this filesystem (keep_changes={keep_changes}, \
				 marked_ancestor={marked_ancestor})"
			);
			return;
		}
		write(&source, ".gitignore", "node_modules/\nrepositories/\n");
		git(&source, &["add", ".gitignore"]);
		git(&source, &["commit", "-qm", "ignore independent repositories"]);
		let relative = if marked_ancestor {
			write(
				&source,
				"repositories/build/CMakeCache.txt",
				&format!("CMAKE_HOME_DIRECTORY:INTERNAL={}\n", source.display()),
			);
			write(&source, "repositories/build/artifact", "source-only build output\n");
			"repositories/build/nested"
		} else {
			"repositories/nested"
		};
		let nested = source.join(relative);
		fs::create_dir_all(&nested).unwrap();
		git(&nested, &["init", "-q", "-b", "main"]);
		for (key, value) in [
			("user.name", "Test"),
			("user.email", "test@example.com"),
			("commit.gpgsign", "false"),
			("core.autocrlf", "false"),
			("core.excludesFile", ".git/no-global-excludes"),
			("core.hooksPath", ".git/hooks"),
		] {
			git(&nested, &["config", key, value]);
		}
		write(
			&nested,
			"CMakeCache.txt",
			&format!("CMAKE_HOME_DIRECTORY:INTERNAL={}\n", nested.display()),
		);
		write(&nested, "committed.txt", "committed independent data\n");
		write(&nested, "edited.txt", "committed edit base\n");
		write(&nested, "staged.txt", "committed stage base\n");
		git(&nested, &["add", "."]);
		git(&nested, &["commit", "-qm", "independent repository data"]);
		let nested_head = git(&nested, &["rev-parse", "HEAD"]);
		write(&nested, "edited.txt", "unstaged independent data\n");
		write(&nested, "staged.txt", "staged independent data\n");
		git(&nested, &["add", "staged.txt"]);
		write(&nested, "staged.txt", "staged then edited independent data\n");
		write(&nested, "untracked.txt", "untracked independent data\n");
		write(&source, "a.txt", "outer staged\n");
		git(&source, &["add", "a.txt"]);
		write(&source, "a.txt", "outer staged then edited\n");
		let source_before = snapshot(&source);
		let nested_before = snapshot(&nested);
		let metadata_before = snapshot(&nested.join(".git"));
		let target = temp.path().join("target");
		let result = repo
			.worktree_add(&target, "HEAD", WorktreeAddOptions {
				detach: true,
				clone: WorktreeClone::Auto,
				keep_changes,
			})
			.unwrap();
		assert!(result.cloned_with.is_some(), "{:?}", result.clone_error);
		let carried = target.join(relative);
		assert!(
			carried.join(".git").is_dir(),
			"clone lost the independent repository (keep_changes={keep_changes}, \
			 marked_ancestor={marked_ancestor})"
		);
		assert_eq!(snapshot(&carried), nested_before, "clone changed nested working files");
		assert_eq!(
			snapshot(&carried.join(".git")),
			metadata_before,
			"clone changed nested repository metadata"
		);
		assert_eq!(git(&carried, &["rev-parse", "HEAD"]), nested_head);
		assert_eq!(git(&carried, &["show", "HEAD:committed.txt"]), "committed independent data");
		assert_eq!(git(&carried, &["show", "HEAD:edited.txt"]), "committed edit base");
		assert_eq!(git(&carried, &["show", ":staged.txt"]), "staged independent data");
		if marked_ancestor {
			assert!(!target.join("repositories/build/CMakeCache.txt").exists());
			assert!(!target.join("repositories/build/artifact").exists());
		}
		assert_eq!(
			fs::read_to_string(target.join("a.txt")).unwrap(),
			if keep_changes {
				"outer staged then edited\n"
			} else {
				"tracked\n"
			}
		);
		assert_eq!(
			git(&target, &["show", ":a.txt"]),
			if keep_changes {
				"outer staged"
			} else {
				"tracked"
			}
		);
		assert_eq!(snapshot(&source), source_before, "clone changed source working files");
		assert_eq!(
			snapshot(&nested.join(".git")),
			metadata_before,
			"clone changed source nested repository metadata"
		);
	}
}

#[test]
fn clone_preserves_ignored_in_source_cmake_repositories_for_both_keep_changes_modes() {
	assert_clone_preserves_ignored_cmake_repository(false);
}

#[test]
fn clone_preserves_ignored_cmake_repositories_beneath_marked_ancestors() {
	assert_clone_preserves_ignored_cmake_repository(true);
}

fn assert_root_marker_checkout(marker: &str, clone: WorktreeClone, keep_changes: bool) {
	let (temp, source, repo) = fixture();
	if clone == WorktreeClone::Auto && !clone_works_on(temp.path()) {
		eprintln!("SKIP: no working clone backend on this filesystem");
		return;
	}
	write(&source, ".gitignore", "node_modules/\nignored/\nenvironments/\n");
	write(&source, "clean.txt", "clean tracked bytes\n");
	write(&source, "environments/cmake/tracked.txt", "committed nested data\n");
	git(&source, &["add", ".gitignore", "clean.txt"]);
	git(&source, &["add", "-f", "environments/cmake/tracked.txt"]);
	git(&source, &["commit", "-qm", "track root and nested data"]);
	write(&source, "a.txt", "staged outer bytes\n");
	git(&source, &["add", "a.txt"]);
	write(&source, "a.txt", "staged then edited outer bytes\n");
	write(&source, "environments/cmake/tracked.txt", "staged nested bytes\n");
	git(&source, &["add", "-f", "environments/cmake/tracked.txt"]);
	write(&source, "environments/cmake/tracked.txt", "staged then edited nested bytes\n");
	let literal = "[scratch] #1.txt";
	let literal_bytes = b"literal untracked bytes\0\xff\r\n";
	fs::write(source.join(literal), literal_bytes).unwrap();
	let nested_file = "notes/space dir/nontrivial.bin";
	let nested_bytes = b"nested untracked bytes\0\xfe\n";
	fs::create_dir_all(source.join("notes/space dir")).unwrap();
	fs::write(source.join(nested_file), nested_bytes).unwrap();
	write(&source, marker, "checkout-root configuration\n");
	write(&source, "ignored/local.bin", "ignored user work\n");
	write(&source, "environments/cmake/CMakeCache.txt", "CMAKE_HOME_DIRECTORY:INTERNAL=/source\n");
	write(&source, "environments/cmake/generated.bin", "nonrelocatable cmake bytes\n");
	write(&source, "environments/python/pyvenv.cfg", "home = /source/python\n");
	write(&source, "environments/python/bin/tool", "#!/source/python\n");
	let nested = source.join("environments/cmake/independent");
	fs::create_dir_all(&nested).unwrap();
	git(&nested, &["init", "-q", "-b", "main"]);
	for (key, value) in [
		("user.name", "Test"),
		("user.email", "test@example.com"),
		("commit.gpgsign", "false"),
		("core.autocrlf", "false"),
		("core.excludesFile", ".git/no-global-excludes"),
		("core.hooksPath", ".git/hooks"),
	] {
		git(&nested, &["config", key, value]);
	}
	write(&nested, "CMakeCache.txt", "independent root configuration\n");
	write(&nested, "data.bin", "committed independent bytes\n");
	git(&nested, &["add", "."]);
	git(&nested, &["commit", "-qm", "independent base"]);
	write(&nested, "data.bin", "dirty independent bytes\n");
	write(&nested, "untracked.bin", "independent untracked bytes\n");
	let nested_head = git(&nested, &["rev-parse", "HEAD"]);
	let nested_before = snapshot(&nested);
	let nested_metadata_before = snapshot(&nested.join(".git"));
	#[cfg(unix)]
	let outside = {
		let outside = temp.path().join("outside-checkout");
		write(&outside, "CMakeCache.txt", "outside marker\n");
		write(&outside, "precious.bin", "outside sentinel bytes\n");
		std::os::unix::fs::symlink(&outside, source.join("external-link")).unwrap();
		std::os::unix::fs::symlink(&outside, source.join("environments/cmake/external-link"))
			.unwrap();
		outside
	};
	let source_status = git(&source, &["status", "--porcelain", "--untracked-files=all"]);
	let source_before = snapshot(&source);
	let source_index = fs::read(source.join(".git/index")).unwrap();
	let source_head = fs::read(source.join(".git/HEAD")).unwrap();
	let target = temp.path().join("root-marker-target");
	let result = repo
		.worktree_add(&target, "HEAD", WorktreeAddOptions { detach: true, clone, keep_changes })
		.unwrap();
	assert_eq!(
		result.cloned_with.is_some(),
		clone == WorktreeClone::Auto,
		"{:?}",
		result.clone_error
	);
	assert_eq!(snapshot(&source), source_before, "source working bytes changed");
	assert_eq!(fs::read(source.join(".git/index")).unwrap(), source_index);
	assert_eq!(fs::read(source.join(".git/HEAD")).unwrap(), source_head);
	assert_eq!(snapshot(&nested.join(".git")), nested_metadata_before);
	if keep_changes {
		assert_eq!(fs::read(target.join(literal)).unwrap(), literal_bytes);
		assert_eq!(fs::read(target.join(nested_file)).unwrap(), nested_bytes);
		assert_eq!(fs::read(target.join(marker)).unwrap(), b"checkout-root configuration\n");
	} else {
		assert!(!target.join(literal).exists());
		assert!(!target.join("notes").exists());
		assert!(!target.join(marker).exists());
	}
	assert_eq!(fs::read(target.join("clean.txt")).unwrap(), b"clean tracked bytes\n");
	assert_eq!(
		fs::read(target.join("a.txt")).unwrap(),
		if keep_changes {
			b"staged then edited outer bytes\n".as_slice()
		} else {
			b"tracked\n".as_slice()
		}
	);
	assert_eq!(
		git(&target, &["show", ":a.txt"]),
		if keep_changes {
			"staged outer bytes"
		} else {
			"tracked"
		}
	);
	assert_eq!(
		fs::read(target.join("environments/cmake/tracked.txt")).unwrap(),
		if keep_changes {
			b"staged then edited nested bytes\n".as_slice()
		} else {
			b"committed nested data\n".as_slice()
		}
	);
	assert_eq!(
		git(&target, &["show", ":environments/cmake/tracked.txt"]),
		if keep_changes {
			"staged nested bytes"
		} else {
			"committed nested data"
		}
	);
	assert!(!target.join("environments/cmake/generated.bin").exists());
	assert!(!target.join("environments/cmake/CMakeCache.txt").exists());
	assert!(!target.join("environments/python").exists());
	if clone == WorktreeClone::Auto {
		assert_eq!(fs::read(target.join("ignored/local.bin")).unwrap(), b"ignored user work\n");
		assert_eq!(
			fs::read(target.join("node_modules/pkg/index.js")).unwrap(),
			b"relocatable cache\n"
		);
		let carried = target.join("environments/cmake/independent");
		assert_eq!(snapshot(&carried), nested_before);
		assert_eq!(snapshot(&carried.join(".git")), nested_metadata_before);
		assert_eq!(git(&carried, &["rev-parse", "HEAD"]), nested_head);
		assert_eq!(git(&carried, &["show", "HEAD:data.bin"]), "committed independent bytes");
	} else {
		assert!(!target.join("ignored").exists());
		assert!(!target.join("node_modules").exists());
		assert!(!target.join("environments/cmake/independent").exists());
	}
	#[cfg(unix)]
	{
		if keep_changes {
			assert!(
				fs::symlink_metadata(target.join("external-link"))
					.unwrap()
					.file_type()
					.is_symlink()
			);
			assert_eq!(fs::read_link(target.join("external-link")).unwrap(), outside);
		} else {
			assert!(fs::symlink_metadata(target.join("external-link")).is_err());
		}
		assert!(fs::symlink_metadata(target.join("environments/cmake/external-link")).is_err());
		assert_eq!(fs::read(outside.join("CMakeCache.txt")).unwrap(), b"outside marker\n");
		assert_eq!(fs::read(outside.join("precious.bin")).unwrap(), b"outside sentinel bytes\n");
	}
	assert_eq!(
		git(&target, &["status", "--porcelain", "--untracked-files=all"]),
		if keep_changes {
			source_status
		} else {
			String::new()
		}
	);
	assert!(repo.worktree_remove(&target, true).unwrap());
	assert!(!target.exists());
}

#[test]
fn clone_root_cmake_marker_keeps_checkout_work() {
	assert_root_marker_checkout("CMakeCache.txt", WorktreeClone::Auto, true);
}

#[test]
fn clone_root_pyvenv_marker_keeps_checkout_work() {
	assert_root_marker_checkout("pyvenv.cfg", WorktreeClone::Auto, true);
}

#[test]
fn clone_root_markers_reconcile_without_keep_changes() {
	for marker in ["CMakeCache.txt", "pyvenv.cfg"] {
		assert_root_marker_checkout(marker, WorktreeClone::Auto, false);
	}
}

#[test]
fn clone_disabled_keeps_root_marked_uncommitted_work() {
	for marker in ["CMakeCache.txt", "pyvenv.cfg"] {
		assert_root_marker_checkout(marker, WorktreeClone::Off, true);
	}
}
