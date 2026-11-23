use std::io;

use async_trait::async_trait;
use omp_vfs::FileSystem;

use super::*;

const DEPTH: usize = 4096;

#[derive(Debug)]
struct Chain;

impl Chain {
	fn node(path: &Path) -> io::Result<(usize, bool)> {
		let rest = path
			.to_str()
			.and_then(|s| s.strip_prefix("deep://root"))
			.ok_or(io::ErrorKind::NotFound)?;
		let mut depth = 0;
		let mut file = false;
		for name in rest.split('/').filter(|s| !s.is_empty()) {
			if file {
				return Err(io::ErrorKind::NotADirectory.into());
			}
			if name == "d" && depth < DEPTH {
				depth += 1;
			} else if name == "leaf" && depth == DEPTH {
				file = true;
			} else {
				return Err(io::ErrorKind::NotFound.into());
			}
		}
		Ok((depth, file))
	}
}

#[async_trait]
impl FileSystem for Chain {
	async fn open(&self, _: &Path, _: &omp_vfs::OpenOptions) -> io::Result<omp_vfs::File> {
		Err(io::ErrorKind::Unsupported.into())
	}

	async fn metadata(&self, path: &Path) -> io::Result<omp_vfs::Metadata> {
		let (depth, file) = Self::node(path)?;
		let kind = if file {
			omp_vfs::FileKind::File
		} else {
			omp_vfs::FileKind::Dir
		};
		Ok(omp_vfs::Metadata::new(
			omp_vfs::FileType::from_kind(kind),
			u64::from(file),
			omp_vfs::Permissions::from_mode(0o755),
		)
		.with_id(91, depth as u64 + 1 + u64::from(file)))
	}

	async fn read_dir(&self, path: &Path) -> io::Result<omp_vfs::ReadDir> {
		let (depth, file) = Self::node(path)?;
		if file {
			return Err(io::ErrorKind::NotADirectory.into());
		}
		let name = if depth == DEPTH { "leaf" } else { "d" };
		let child = omp_vfs::child_path(path, std::ffi::OsStr::new(name));
		let meta = self.metadata(&child).await?;
		Ok(omp_vfs::ReadDir::from_entries(vec![Ok(omp_vfs::DirEntry::new(
			child,
			name.into(),
			Some(meta.file_type()),
		)
		.with_metadata(meta))]))
	}
}

#[test]
fn sorted_collection_returns_from_an_iterative_deep_provider() {
	if isolated_case(
		"PI_WALKER_DEEP_COLLECT_CHILD",
		"walk::tests::regression140_deep::sorted_collection_returns_from_an_iterative_deep_provider",
	) {
		return;
	}
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.unwrap();
	runtime.block_on(async {
		on_small_stack(async {
			let fs = Fs::Provider(omp_vfs::Fs::new(Arc::new(Chain)));
			let expected = format!("{}leaf", "d/".repeat(DEPTH));
			for sorted in [false, true] {
				let opts = Options { workers: Some(2), ..Default::default() };
				let got = collect(&fs, Path::new("deep://root"), &opts, sorted, |_, e| {
					if e.file_type == FileType::File {
						Action::Continue
					} else {
						Action::Skip
					}
				})
				.await
				.unwrap();
				assert_eq!(
					got.iter()
						.map(|e| e.path_lossy().into_owned())
						.collect::<Vec<_>>(),
					[expected.clone()]
				);
				drop(got);
			}
		})
		.await;
	});
}
