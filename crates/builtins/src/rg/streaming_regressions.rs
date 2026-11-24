use std::{
	io::{self, SeekFrom},
	path::Path,
	sync::{Arc, atomic::{AtomicUsize, Ordering}},
	time::{Duration, Instant},
};
use crate::extras::{self, Fd, Invocation};
use tokio::sync::{Notify, Semaphore};

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
	body: Arc<Vec<u8>>,
	gate: Arc<Semaphore>,
}

impl GatedFs {
	fn new() -> Arc<Self> {
		Arc::new(Self {
			body: Arc::new(RECORD.repeat(512 * 1024 / RECORD.len())),
			gate: Arc::new(Semaphore::new(0)),
		})
	}

	fn metadata_for(&self, path: &Path) -> io::Result<omp_vfs::Metadata> {
		let (kind, size, inode) = match path.to_str() {
			Some(FILE) => (omp_vfs::FileKind::File, self.body.len() as u64, 2),
			_ if [ROOT, "mem://stream", "mem://"].into_iter().any(|root| path == Path::new(root)) => {
				(omp_vfs::FileKind::Dir, 0, 1)
			},
			_ => return Err(io::ErrorKind::NotFound.into()),
		};
		Ok(omp_vfs::Metadata::new(
			omp_vfs::FileType::from_kind(kind), size, omp_vfs::Permissions::from_mode(0o644),
		).with_id(7, inode))
	}
}

#[derive(Debug)]
struct GatedHandle {
	provider: Arc<GatedFs>,
	pos: AtomicUsize,
}

#[async_trait::async_trait]
impl omp_vfs::FileHandle for GatedHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		let start = self.pos.load(Ordering::Relaxed);
		if start >= GATE_AT {
			let permit = self.provider.gate.acquire().await.map_err(io::Error::other)?;
			drop(permit);
		}
		let n = buf.len().min(64 * 1024).min(self.provider.body.len().saturating_sub(start));
		buf[..n].copy_from_slice(&self.provider.body[start..start + n]);
		self.pos.store(start + n, Ordering::Relaxed);
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
		Ok(omp_vfs::File::from_handle(GatedHandle { provider: self.0.clone(), pos: AtomicUsize::new(0) }))
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
			FILE.into(), "dense.txt".into(), Some(metadata.file_type()),
		).with_metadata(metadata))]))
	}
}

#[derive(Clone, Debug, Default)]
struct Recording {
	bytes: Arc<parking_lot::Mutex<Vec<u8>>>,
	seen: Arc<Notify>,
}

#[async_trait::async_trait]
impl omp_vfs::FileHandle for Recording {
	async fn read(&self, _: &mut [u8]) -> io::Result<usize> {
		Ok(0)
	}

	async fn write(&self, bytes: &[u8]) -> io::Result<usize> {
		self.bytes.lock().extend_from_slice(bytes);
		if bytes.contains(&b'\n') {
			self.seen.notify_one();
		}
		Ok(bytes.len())
	}

	async fn seek(&self, _: SeekFrom) -> io::Result<u64> {
		Err(io::ErrorKind::Unsupported.into())
	}

	async fn metadata(&self) -> io::Result<omp_vfs::Metadata> {
		Err(io::ErrorKind::Unsupported.into())
	}

	async fn flush(&self) -> io::Result<()> {
		Ok(())
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn file_and_directory_records_reach_the_host_before_late_input() {
	for operand in ["dense.txt", "."] {
		for flags in ["", "--line-buffered", "--no-line-buffered"] {
			let provider = GatedFs::new();
			let _release = ReleaseGate(provider.gate.clone());
			let capture = Recording::default();
			let error = Recording::default();
			let mut argv = vec!["rg".to_owned(), "-N".to_owned(), "--no-filename".to_owned()];
			if !flags.is_empty() {
				argv.push(flags.to_owned());
			}
			argv.extend(["needle".to_owned(), operand.to_owned()]);
			let mut invocation = Invocation::new(
				argv,
				Path::new(ROOT).to_path_buf(),
				omp_vfs::Fs::new(Arc::new(Provider(provider.clone()))),
			);
			invocation.stdio = [
				Fd::Closed,
				Fd::from(omp_vfs::File::from_handle(capture.clone())),
				Fd::from(omp_vfs::File::from_handle(error.clone())),
			];
			let observe = async {
				let early = tokio::time::timeout(Duration::from_secs(5), capture.seen.notified()).await.is_ok();
				provider.gate.add_permits(1);
				early
			};
			let (result, early) = tokio::time::timeout(Duration::from_secs(20), async {
				tokio::join!(extras::run(invocation), observe)
			}).await.expect("released rg must finish");
			assert!(early, "{operand} {flags}: output waited for a late input read");
			assert_eq!(result, 0);
			assert_eq!(*capture.bytes.lock(), *provider.body);
			assert!(error.bytes.lock().is_empty());
		}
	}
}

struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

#[test]
fn buffering_flags_do_not_block_current_thread_pipeline_consumers() {
	for flags in ["", "--line-buffered", "--no-line-buffered"] {
		let temp = tempfile::tempdir().unwrap();
		let records = 512 * 1024;
		std::fs::write(temp.path().join("sample"), RECORD.repeat(records)).unwrap();
		let child = std::process::Command::new(std::env::current_exe().unwrap())
			.args(["--exact", "rg::streaming_regressions::pipeline_child", "--ignored", "--nocapture"])
			.env("PI_RG_STREAM_TEST_FLAGS", flags)
			.env("PI_RG_STREAM_TEST_ROOT", temp.path())
			.spawn().unwrap();
		let mut child = ChildGuard(child);
		let deadline = Instant::now() + Duration::from_secs(20);
		let status = loop {
			if let Some(status) = child.0.try_wait().unwrap() {
				break Some(status);
			}
			if Instant::now() >= deadline {
				break None;
			}
			std::thread::sleep(Duration::from_millis(10));
		};
		assert!(status.is_some_and(|status| status.success()), "pipeline stalled or failed: {flags}");
	}
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "isolated current-thread child with an external kill-and-reap watchdog"]
async fn pipeline_child() {
	let flags = std::env::var("PI_RG_STREAM_TEST_FLAGS").expect("watchdog child only");
	let root = std::path::PathBuf::from(std::env::var_os("PI_RG_STREAM_TEST_ROOT").expect("parent-owned fixture"));
	let output = tempfile::NamedTempFile::new().unwrap();
	let error = tempfile::NamedTempFile::new().unwrap();
	let (reader, writer) = std::io::pipe().unwrap();
	let mut argv = vec!["rg".to_owned()];
	if !flags.is_empty() {
		argv.push(flags);
	}
	argv.extend(["needle".to_owned(), "sample".to_owned()]);
	let mut producer = Invocation::new(argv, root.clone(), omp_vfs::Fs::native());
	producer.stdio = [Fd::Closed, Fd::from(writer), Fd::from(error.as_file().try_clone().unwrap())];
	let mut consumer = Invocation::new(
		vec!["rg".to_owned(), "--count".to_owned(), "needle".to_owned()],
		root,
		omp_vfs::Fs::native(),
	);
	consumer.stdio = [
		Fd::from(reader),
		Fd::from(output.as_file().try_clone().unwrap()),
		Fd::from(error.as_file().try_clone().unwrap()),
	];
	let (producer_code, consumer_code) = tokio::join!(extras::run(producer), extras::run(consumer));
	let err = std::fs::read_to_string(error.path()).unwrap();
	assert_eq!(producer_code, 0, "{err}");
	assert_eq!(consumer_code, 0, "{err}");
	assert_eq!(std::fs::read_to_string(output.path()).unwrap(), "524288\n");
	assert_eq!(err, "");
}
