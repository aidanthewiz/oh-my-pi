use std::{
	io::{self, SeekFrom},
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

use tokio::sync::{Semaphore, mpsc};

use super::super::{Engine, GrepOptions, MAX_FILE_BYTES, Mode, SearchOptions, grep, search};
use crate::{fs::Fs, walk};

const ROOT: &str = "mem://stream/dir";
const FILE: &str = "mem://stream/dir/dense.txt";
const RECORD: &[u8] = b"needle 000000000000000000000000\n";
const GATE_AT: usize = 128 * 1024;

struct ReleaseGate(Arc<Semaphore>);
impl Drop for ReleaseGate {
	fn drop(&mut self) {
		self.0.add_permits(1);
	}
}

#[derive(Debug)]
struct GatedFs {
	body:       Arc<Vec<u8>>,
	gate:       Arc<Semaphore>,
	read_bytes: AtomicUsize,
}

impl GatedFs {
	fn new(size: usize) -> Arc<Self> {
		Arc::new(Self {
			body:       Arc::new(RECORD.repeat(size / RECORD.len())),
			gate:       Arc::new(Semaphore::new(0)),
			read_bytes: AtomicUsize::new(0),
		})
	}

	fn metadata_for(&self, path: &Path) -> io::Result<omp_vfs::Metadata> {
		let (kind, size, inode) = match path.to_str() {
			Some(FILE) => (omp_vfs::FileKind::File, self.body.len() as u64, 2),
			Some(ROOT | "mem://stream" | "mem://") => (omp_vfs::FileKind::Dir, 0, 1),
			_ => return Err(io::ErrorKind::NotFound.into()),
		};
		Ok(omp_vfs::Metadata::new(
			omp_vfs::FileType::from_kind(kind),
			size,
			omp_vfs::Permissions::from_mode(0o644),
		)
		.with_id(7, inode))
	}
}

#[derive(Debug)]
struct GatedHandle {
	provider: Arc<GatedFs>,
	pos:      AtomicUsize,
}

#[async_trait::async_trait]
impl omp_vfs::FileHandle for GatedHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		let start = self.pos.load(Ordering::Relaxed);
		if start >= GATE_AT {
			let permit = self
				.provider
				.gate
				.acquire()
				.await
				.map_err(io::Error::other)?;
			drop(permit);
		}
		let n = buf
			.len()
			.min(64 * 1024)
			.min(self.provider.body.len().saturating_sub(start));
		buf[..n].copy_from_slice(&self.provider.body[start..start + n]);
		self.pos.store(start + n, Ordering::Relaxed);
		self.provider.read_bytes.fetch_add(n, Ordering::Relaxed);
		Ok(n)
	}

	async fn write(&self, _: &[u8]) -> io::Result<usize> {
		Err(io::ErrorKind::Unsupported.into())
	}

	async fn seek(&self, pos: SeekFrom) -> io::Result<u64> {
		let next = match pos {
			SeekFrom::Start(n) => i128::from(n),
			SeekFrom::Current(n) => self.pos.load(Ordering::Relaxed) as i128 + i128::from(n),
			SeekFrom::End(n) => self.provider.body.len() as i128 + i128::from(n),
		};
		let next = usize::try_from(next).map_err(|_| io::ErrorKind::InvalidInput)?;
		self.pos.store(next, Ordering::Relaxed);
		Ok(next as u64)
	}

	async fn metadata(&self) -> io::Result<omp_vfs::Metadata> {
		self.provider.metadata_for(Path::new(FILE))
	}
}

#[derive(Debug)]
struct Provider(Arc<GatedFs>);

#[async_trait::async_trait]
impl omp_vfs::FileSystem for Provider {
	async fn open(&self, path: &Path, _: &omp_vfs::OpenOptions) -> io::Result<omp_vfs::File> {
		if path != Path::new(FILE) {
			return Err(io::ErrorKind::NotFound.into());
		}
		Ok(omp_vfs::File::from_handle(GatedHandle {
			provider: self.0.clone(),
			pos:      AtomicUsize::new(0),
		}))
	}

	async fn metadata(&self, path: &Path) -> io::Result<omp_vfs::Metadata> {
		self.0.metadata_for(path)
	}

	async fn read_dir(&self, path: &Path) -> io::Result<omp_vfs::ReadDir> {
		if path != Path::new(ROOT) {
			return Err(io::ErrorKind::NotFound.into());
		}
		let metadata = self.0.metadata_for(Path::new(FILE))?;
		Ok(omp_vfs::ReadDir::from_entries(vec![Ok(omp_vfs::DirEntry::new(
			FILE.into(),
			"dense.txt".into(),
			Some(metadata.file_type()),
		)
		.with_metadata(metadata))]))
	}
}

#[test]
fn fallback_matchers_evaluate_every_isolated_line() {
	for pattern in [r"foo(?!\s)", r"foo(?:\nbar)?\z"] {
		let engine = Engine::compile(pattern, false, false).unwrap();
		for body in [b"foo\nqux\n".as_slice(), b"foo\nqux".as_slice()] {
			for mode in [Mode::Content, Mode::Count] {
				let result =
					search(&engine, body, &SearchOptions { mode, ..Default::default() }).unwrap();
				assert_eq!(result.match_count, 1, "{pattern} {mode:?}");
				if mode == Mode::Content {
					assert_eq!(
						result
							.matches
							.iter()
							.map(|m| (m.line, m.text.as_str()))
							.collect::<Vec<_>>(),
						[(1, "foo")]
					);
				} else {
					assert!(result.matches.is_empty());
				}
			}
		}
	}
	let engine = Engine::compile(r"foo(?!\s)", false, false).unwrap();
	let result = search(&engine, b"foo\nqux\nfooZ\n", &SearchOptions::default()).unwrap();
	assert_eq!(
		result
			.matches
			.iter()
			.map(|m| (m.line, m.text.as_str()))
			.collect::<Vec<_>>(),
		[(1, "foo"), (3, "fooZ")]
	);
	let engine = Engine::compile(r"foo(?:\nbar)?\z", false, true).unwrap();
	assert_eq!(
		search(&engine, b"foo\nqux\n", &SearchOptions { multiline: true, ..Default::default() })
			.unwrap()
			.match_count,
		0
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn provider_streaming_delivers_before_late_reads_and_keeps_prefix_and_cap() {
	for root in [ROOT, FILE] {
		for cap in [None, Some(1500)] {
			let provider = GatedFs::new(MAX_FILE_BYTES as usize + 64 * 1024);
			let _release = ReleaseGate(provider.gate.clone());
			let fs = Fs::Provider(omp_vfs::Fs::new(Arc::new(Provider(provider.clone()))));
			let (sender, mut receiver) = mpsc::channel(1);
			let opts = GrepOptions {
				sink: Some(sender),
				max_count_per_file: cap,
				walk: walk::Options {
					hidden: true,
					gitignore: false,
					workers: Some(1),
					..Default::default()
				},
				..GrepOptions::new(Arc::new(Engine::compile("needle", false, false).unwrap()))
			};
			let observe = async {
				let first = tokio::time::timeout(Duration::from_secs(5), receiver.recv()).await;
				let early = matches!(&first, Ok(Some(batch)) if !batch.is_empty());
				let early_bytes = provider.read_bytes.load(Ordering::Relaxed);
				provider.gate.add_permits(1);
				let mut batches = Vec::new();
				if let Ok(Some(batch)) = first {
					batches.push(batch);
				}
				while let Some(batch) = receiver.recv().await {
					batches.push(batch);
				}
				(early, early_bytes, batches)
			};
			let (result, (early, early_bytes, batches)) =
				tokio::time::timeout(Duration::from_secs(20), async {
					tokio::join!(grep(&fs, Path::new(root), opts), observe)
				})
				.await
				.expect("released search must finish");
			let result = result.unwrap();
			assert!(early, "root {root}, cap {cap:?}: search waited for the late-read gate");
			assert!(early_bytes <= GATE_AT);
			let available = if root == FILE {
				provider.body.len()
			} else {
				MAX_FILE_BYTES as usize
			} / RECORD.len();
			let expected = cap.unwrap_or(available as u64);
			assert!(
				batches
					.iter()
					.all(|batch| !batch.is_empty() && batch.len() <= 1024)
			);
			let delivered: Vec<_> = batches.into_iter().flatten().collect();
			assert_eq!(delivered.len() as u64, expected);
			for (index, found) in delivered.iter().enumerate() {
				assert_eq!(found.line, index as u64 + 1);
				assert_eq!(found.text.as_bytes(), &RECORD[..RECORD.len() - 1]);
				assert_eq!(found.path, if root == FILE { FILE } else { "dense.txt" });
			}
			assert_eq!(result.total_matches, expected + u64::from(cap.is_some()));
			assert_eq!((result.files_searched, result.files_with_matches), (1, 1));
			assert!(result.matches.is_empty());
			assert_eq!(result.limit_reached, cap.is_some());
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_file_root_while_delivery_is_full_closes_its_sender() {
	let temp = super::TempDir::new();
	let file =
		temp.write("dense.txt", RECORD.repeat((MAX_FILE_BYTES as usize + 65536) / RECORD.len()));
	let (sender, mut receiver) = mpsc::channel(1);
	let mut opts = GrepOptions::new(Arc::new(Engine::compile("needle", false, false).unwrap()));
	opts.sink = Some(sender);
	let task = tokio::spawn(async move { grep(&Fs::native(), &file, opts).await });
	let first = tokio::time::timeout(Duration::from_secs(5), receiver.recv()).await;
	let ready = tokio::time::timeout(Duration::from_secs(5), async {
		while receiver.is_empty() {
			tokio::task::yield_now().await;
		}
	})
	.await;
	task.abort();
	let _ = task.await;
	let drained = tokio::time::timeout(Duration::from_secs(5), async {
		let mut remaining = 0;
		while receiver.recv().await.is_some() {
			remaining += 1;
		}
		remaining
	})
	.await;
	drop(receiver);
	assert!(matches!(first, Ok(Some(_))));
	assert!(ready.is_ok(), "the sink was never observed full");
	assert!(
		matches!(drained, Ok(remaining) if remaining <= 1),
		"cancelled task continued delivery: {drained:?}"
	);
}
