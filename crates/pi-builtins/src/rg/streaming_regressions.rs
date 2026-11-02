use std::{
	io::{self, Read, SeekFrom, Write},
	path::Path,
	sync::{Arc, atomic::{AtomicUsize, Ordering}},
	time::{Duration, Instant},
};
use brush_core::{
	openfiles::{OpenFile, OpenFiles, Stream},
	ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo,
};
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

	fn metadata_for(&self, path: &Path) -> io::Result<pi_vfs::Metadata> {
		let (kind, size, inode) = match path.to_str() {
			Some(FILE) => (pi_vfs::FileKind::File, self.body.len() as u64, 2),
			_ if [ROOT, "mem://stream", "mem://"].into_iter().any(|root| path == Path::new(root)) => {
				(pi_vfs::FileKind::Dir, 0, 1)
			},
			_ => return Err(io::ErrorKind::NotFound.into()),
		};
		Ok(pi_vfs::Metadata::new(
			pi_vfs::FileType::from_kind(kind), size, pi_vfs::Permissions::from_mode(0o644),
		).with_id(7, inode))
	}
}

#[derive(Debug)]
struct GatedHandle {
	provider: Arc<GatedFs>,
	pos: AtomicUsize,
}

#[async_trait::async_trait]
impl pi_vfs::FileHandle for GatedHandle {
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

	async fn metadata(&self) -> io::Result<pi_vfs::Metadata> {
		self.provider.metadata_for(Path::new(FILE))
	}
}

#[derive(Debug)]
struct Provider(Arc<GatedFs>);

#[async_trait::async_trait]
impl pi_vfs::FileSystem for Provider {
	async fn open(&self, path: &Path, _: &pi_vfs::OpenOptions) -> io::Result<pi_vfs::File> {
		if path != Path::new(FILE) {
			return Err(io::ErrorKind::NotFound.into());
		}
		Ok(pi_vfs::File::from_handle(GatedHandle { provider: self.0.clone(), pos: AtomicUsize::new(0) }))
	}

	async fn metadata(&self, path: &Path) -> io::Result<pi_vfs::Metadata> {
		self.0.metadata_for(path)
	}

	async fn read_dir(&self, path: &Path) -> io::Result<pi_vfs::ReadDir> {
		if path != Path::new(ROOT) {
			return Err(io::ErrorKind::NotFound.into());
		}
		let metadata = self.0.metadata_for(Path::new(FILE))?;
		Ok(pi_vfs::ReadDir::from_entries(vec![Ok(pi_vfs::DirEntry::new(
			FILE.into(), "dense.txt".into(), Some(metadata.file_type()),
		).with_metadata(metadata))]))
	}
}

#[derive(Clone, Default)]
struct Recording {
	bytes: Arc<parking_lot::Mutex<Vec<u8>>>,
	seen: Arc<Notify>,
}

impl Read for Recording {
	fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
		Ok(0)
	}
}

impl Write for Recording {
	fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
		self.bytes.lock().extend_from_slice(bytes);
		if bytes.contains(&b'\n') {
			self.seen.notify_one();
		}
		Ok(bytes.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

impl Stream for Recording {
	fn clone_box(&self) -> Box<dyn Stream> {
		Box::new(self.clone())
	}

	#[cfg(unix)]
	fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, brush_core::Error> {
		Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
	}

	#[cfg(unix)]
	fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, brush_core::Error> {
		Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn file_and_directory_records_reach_the_host_before_late_input() {
	for operand in ["dense.txt", "."] {
		for flags in ["", "--line-buffered", "--no-line-buffered"] {
			let provider = GatedFs::new();
			let _release = ReleaseGate(provider.gate.clone());
			let mut shell = Shell::builder()
				.profile(ProfileLoadBehavior::Skip).rc(RcLoadBehavior::Skip)
				.builtins(crate::factory::default_builtins(crate::factory::BuiltinSet::BashMode))
				.build().await.unwrap();
			for (name, builtin) in crate::factory::utility_builtins() {
				shell.register_builtin(name, builtin);
			}
			shell.set_filesystem(pi_vfs::Fs::new(Arc::new(Provider(provider.clone()))));
			shell.set_working_dir(Path::new(ROOT)).await.unwrap();
			let capture = Recording::default();
			let error = Recording::default();
			let mut params = shell.default_exec_params();
			params.set_fd(OpenFiles::STDIN_FD, OpenFile::Stream(Box::new(Recording::default())));
			params.set_fd(OpenFiles::STDOUT_FD, OpenFile::Stream(Box::new(capture.clone())));
			params.set_fd(OpenFiles::STDERR_FD, OpenFile::Stream(Box::new(error.clone())));
			let script = format!("rg -N --no-filename {flags} needle {operand}");
			let source = SourceInfo::from("rg-streaming-regression");
			let observe = async {
				let early = tokio::time::timeout(Duration::from_secs(5), capture.seen.notified()).await.is_ok();
				provider.gate.add_permits(1);
				early
			};
			let (result, early) = tokio::time::timeout(Duration::from_secs(20), async {
				tokio::join!(shell.run_string(&script, &source, &params), observe)
			}).await.expect("released rg must finish");
			let code = u8::from(result.unwrap().exit_code);
			assert!(early, "{operand} {flags}: output waited for a late input read");
			assert_eq!(code, 0);
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
	let script = format!("rg {flags} needle sample | rg --count needle");
	let (code, out, err) = crate::host::run_script(&script, "", &root).await;
	assert_eq!(code, 0, "{err}");
	assert_eq!(out, "524288\n");
	assert_eq!(err, "");
}
