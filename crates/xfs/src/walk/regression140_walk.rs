use std::io;

use async_trait::async_trait;
use omp_vfs::FileSystem;

use super::*;

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn dangling_root_links_preserve_both_missing_target_errors() {
	let tmp = make_tree("root-link-errors", &["target=regular"]);
	for (name, target) in [("notdir", "target/child"), ("missing", "absent/child")] {
		let link = tmp.path().join(name);
		symlink(target, &link);
		for follow in [Follow::Never, Follow::Roots, Follow::Always] {
			let opts = TreeOptions { follow, emit_root: true, min_depth: 0, ..Default::default() };
			let mut tree = Tree::new(&Fs::native(), &link, &opts)
				.await
				.expect("dangling root");
			let Some(Event::Entry(entry)) = tree.next().await else {
				panic!("root entry");
			};
			assert_eq!((entry.path, entry.file_type, entry.depth), (&b""[..], FileType::Symlink, 0));
			assert!(tree.next().await.is_none());
		}
	}
	for follow in [Follow::Never, Follow::Roots, Follow::Always] {
		let opts = TreeOptions { follow, ..Default::default() };
		assert!(
			Tree::new(&Fs::native(), &tmp.path().join("absent"), &opts)
				.await
				.is_err()
		);
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn followed_directory_links_use_full_path_order() {
	let tmp = make_tree("followed-path-order", &["z/x", "a-b", "a.txt"]);
	symlink("z", &tmp.path().join("a"));
	for (order, follow, expected) in [
		(Order::Paths, Follow::Always, vec!["a-b", "a.txt", "a/x", "z/x"]),
		(Order::Names, Follow::Always, vec!["a/x", "a-b", "a.txt", "z/x"]),
		(Order::Paths, Follow::Never, vec!["a-b", "a.txt", "z/x"]),
		(Order::Paths, Follow::Roots, vec!["a-b", "a.txt", "z/x"]),
	] {
		let opts = TreeOptions { order, follow, ..Default::default() };
		let mut tree = Tree::new(&Fs::native(), tmp.path(), &opts).await.unwrap();
		let mut files = Vec::new();
		while let Some(event) = tree.next().await {
			match event {
				Event::Entry(entry) if entry.file_type == FileType::File => {
					files.push(String::from_utf8(entry.path.to_vec()).unwrap());
				},
				Event::Error(error) => panic!("{error:?}"),
				_ => {},
			}
		}
		assert_eq!(files, expected, "{order:?} {follow:?}");
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn symlinked_exclude_directories_filter_root_and_child() {
	let tmp = make_tree("exclude-directory-links", &[
		".git/",
		"rules/exclude=drop.txt\n",
		"drop.txt",
		"keep.txt",
		"sub/drop.txt",
		"sub/keep.txt",
	]);
	symlink("../rules", &tmp.path().join(".git/info"));
	settle();
	for root in [tmp.path().to_path_buf(), tmp.path().join("sub")] {
		let expected = if root == tmp.path() {
			vec!["keep.txt", "rules/exclude", "sub/keep.txt"]
		} else {
			vec!["keep.txt"]
		};
		for cache in [false, true] {
			let opts = Options { gitignore: true, cache, ..Default::default() };
			for sorted in [false, true] {
				for _ in 0..2 {
					let found = collect(&Fs::native(), &root, &opts, sorted, |_, e| {
						if e.file_type == FileType::File {
							Action::Continue
						} else {
							Action::Skip
						}
					})
					.await
					.unwrap();
					let mut paths: Vec<_> = found.iter().map(|e| e.path_lossy().into_owned()).collect();
					paths.sort();
					assert_eq!(paths, expected);
				}
			}
		}
		let opts = TreeOptions { gitignore: true, hidden: false, ..Default::default() };
		let mut tree = Tree::new(&Fs::native(), &root, &opts).await.unwrap();
		let mut paths = Vec::new();
		while let Some(event) = tree.next().await {
			match event {
				Event::Entry(entry) if entry.file_type == FileType::File => {
					paths.push(String::from_utf8(entry.path.to_vec()).unwrap());
				},
				Event::Error(error) => panic!("{error:?}"),
				_ => {},
			}
		}
		assert_eq!(paths, expected);
	}
}

#[derive(Debug)]
struct Hybrid {
	root:     PathBuf,
	external: Arc<MemFs>,
}

impl Hybrid {
	fn denied(&self, path: &Path) -> bool {
		self
			.root
			.parent()
			.is_some_and(|parent| path == parent.join(".ignore"))
	}
}

#[async_trait]
impl FileSystem for Hybrid {
	fn is_native_local(&self, path: &Path) -> bool {
		path.starts_with(&self.root)
	}

	async fn open(&self, path: &Path, opts: &omp_vfs::OpenOptions) -> io::Result<omp_vfs::File> {
		if self.denied(path) {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		self.external.open(path, opts).await
	}

	async fn metadata(&self, path: &Path) -> io::Result<omp_vfs::Metadata> {
		if self.denied(path) {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		self.external.metadata(path).await
	}

	async fn read_dir(&self, path: &Path) -> io::Result<omp_vfs::ReadDir> {
		self.external.read_dir(path).await
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn native_root_retains_provider_authority_for_ancestor_rules() {
	let tmp = make_tree("hybrid-ignore", &[
		".git/",
		".ignore=keep.txt\n",
		".gitignore=host-only.txt\n",
		"repo/host-only.txt",
		"repo/provider-only.txt",
		"repo/keep.txt",
	]);
	let ignore_path = tmp.path().join(".gitignore");
	let (external, _) = MemFs::with_files(&[(ignore_path.to_str().unwrap(), "provider-only.txt\n")]);
	external.add_dir(tmp.path().join(".git").to_str().unwrap());
	let root = tmp.path().join("repo");
	let facade = omp_vfs::Fs::new(Arc::new(Hybrid { root: root.clone(), external }));
	let fs = Fs::new(&facade, &root);
	let opts = Options { gitignore: true, ..Default::default() };
	for sorted in [false, true] {
		let found = collect(&fs, &root, &opts, sorted, |_, _| Action::Continue)
			.await
			.unwrap();
		let mut paths: Vec<_> = found.iter().map(|e| e.path.to_vec()).collect();
		paths.sort();
		assert_eq!(paths, [b"host-only.txt".to_vec(), b"keep.txt".to_vec()]);
	}
	let (paths, errors) =
		tree_events(&fs, &root, &TreeOptions { gitignore: true, ..Default::default() }).await;
	assert!(errors.is_empty(), "{errors:?}");
	assert_eq!(paths, ["host-only.txt", "keep.txt"]);
}
