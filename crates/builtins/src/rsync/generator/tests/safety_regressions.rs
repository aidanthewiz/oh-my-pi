use super::*;
use std::{
	ffi::{OsStr, OsString},
	fs,
	io::SeekFrom,
	os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
	path::PathBuf,
	sync::atomic::{AtomicUsize, Ordering},
};
use async_trait::async_trait;
use crate::rsync::{
	consts::{DEL_RECURSE, FLAG_HLINKED, IOERR_DEL_LIMIT, IOERR_GENERAL, MSG_SUCCESS},
	delete::{Deleter, DelResult, test_support as ds},
	exit::RsyncError,
	flist::Hlink,
	matcher::Sums,
	scan::Scanner,
};

#[derive(Debug, Default)]
struct FaultFs {
	cross_temp: Option<PathBuf>,
	deny_backup: Option<PathBuf>,
	backup_fault: Option<(PathBuf, usize, bool)>,
	untrusted_link: Option<PathBuf>,
}

impl FaultFs {
	fn denied(&self, path: &Path) -> bool {
		self.deny_backup.as_ref().is_some_and(|backup| path.starts_with(backup))
	}
}

#[async_trait]
impl omp_vfs::FileSystem for FaultFs {
	async fn open(&self, path: &Path, opts: &omp_vfs::OpenOptions) -> io::Result<omp_vfs::File> {
		if opts.is_write() && self.denied(path) {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		let file = omp_vfs::Fs::native().open_with(path, opts).await?;
		if opts.is_write()
			&& let Some((backup, limit, fail_close)) = &self.backup_fault
			&& path.starts_with(backup)
		{
			return Ok(omp_vfs::File::from_handle(FaultFile {
				inner: file,
				remaining: AtomicUsize::new(*limit),
				exhausted_errno: if *limit == 0 { libc::ENOSPC } else { libc::EIO },
				fail_close: *fail_close,
			}));
		}
		Ok(file)
	}

	async fn metadata(&self, path: &Path) -> io::Result<omp_vfs::Metadata> {
		omp_vfs::Fs::native().metadata(path).await
	}

	async fn symlink_metadata(&self, path: &Path) -> io::Result<omp_vfs::Metadata> {
		let st = omp_vfs::Fs::native().symlink_metadata(path).await?;
		if self.untrusted_link.as_deref() == Some(path) {
			let uid = if crate::rsync::ids::effective_uid() == Some(1) { 2 } else { 1 };
			return Ok(omp_vfs::Metadata::new(st.file_type(), st.len(), st.permissions()).with_owner(uid, uid));
		}
		Ok(st)
	}

	async fn read_dir(&self, path: &Path) -> io::Result<omp_vfs::ReadDir> {
		omp_vfs::Fs::native().read_dir(path).await
	}

	async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
		omp_vfs::Fs::native().read_link(path).await
	}

	async fn create_dir(&self, path: &Path, mode: Option<u32>) -> io::Result<()> {
		let opts = omp_vfs::DirOptions::new();
		if let Some(mode) = mode {
			opts.mode(mode);
		}
		omp_vfs::Fs::native().create_dir_with(path, &opts).await
	}

	async fn remove_file(&self, path: &Path) -> io::Result<()> {
		omp_vfs::Fs::native().remove_file(path).await
	}

	async fn remove_dir(&self, path: &Path) -> io::Result<()> {
		omp_vfs::Fs::native().remove_dir(path).await
	}

	async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		if self.denied(to) {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		if self.cross_temp.as_ref().is_some_and(|temp| from.starts_with(temp) && !to.starts_with(temp)) {
			return Err(omp_vfs::crosses_devices());
		}
		omp_vfs::Fs::native().rename(from, to).await
	}

	async fn symlink(&self, target: &Path, path: &Path, kind: omp_vfs::SymlinkKind) -> io::Result<()> {
		if self.denied(path) {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		omp_vfs::Fs::native().symlink_with(target, path, kind).await
	}

	async fn hard_link(&self, from: &Path, to: &Path) -> io::Result<()> {
		if self.denied(to) {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		omp_vfs::Fs::native().hard_link(from, to).await
	}

	async fn make_node(&self, path: &Path, kind: omp_vfs::NodeKind, mode: u32) -> io::Result<()> {
		if self.denied(path) {
			return Err(io::ErrorKind::PermissionDenied.into());
		}
		if matches!(kind, omp_vfs::NodeKind::Regular) {
			let mut opts = omp_vfs::OpenOptions::new();
			opts.write(true).create_new(true).mode(mode);
			return omp_vfs::Fs::native().open_with(path, &opts).await?.close_async().await;
		}
		omp_vfs::Fs::native().make_node(path, kind, mode).await
	}

	async fn set_permissions(&self, path: &Path, mode: omp_vfs::Permissions) -> io::Result<()> {
		omp_vfs::Fs::native().set_permissions(path, mode).await
	}

	async fn set_times(&self, path: &Path, atime: omp_vfs::FileTime, mtime: omp_vfs::FileTime, follow: bool) -> io::Result<()> {
		omp_vfs::Fs::native().set_times(path, atime, mtime, follow).await
	}

	async fn get_xattr(&self, path: &Path, name: &OsStr, follow: bool) -> io::Result<Option<Vec<u8>>> {
		omp_vfs::Fs::native().get_xattr(path, name, follow).await
	}
}

#[derive(Debug)]
struct FaultFile {
	inner: omp_vfs::File,
	remaining: AtomicUsize,
	exhausted_errno: i32,
	fail_close: bool,
}

#[async_trait]
impl omp_vfs::FileHandle for FaultFile {
	async fn read(&self, bytes: &mut [u8]) -> io::Result<usize> {
		self.inner.read_async(bytes).await
	}

	async fn write(&self, bytes: &[u8]) -> io::Result<usize> {
		let left = self.remaining.load(Ordering::Relaxed);
		if left == 0 {
			return Err(io::Error::from_raw_os_error(self.exhausted_errno));
		}
		let n = self.inner.write_async(&bytes[..bytes.len().min(left)]).await?;
		self.remaining.fetch_sub(n, Ordering::Relaxed);
		Ok(n)
	}

	async fn seek(&self, pos: SeekFrom) -> io::Result<u64> {
		self.inner.seek_async(pos).await
	}

	async fn metadata(&self) -> io::Result<omp_vfs::Metadata> {
		self.inner.metadata_async().await
	}

	async fn flush(&self) -> io::Result<()> {
		self.inner.flush_async().await
	}

	async fn close(&self) -> io::Result<()> {
		if self.fail_close {
			return Err(io::Error::from_raw_os_error(libc::EIO));
		}
		self.inner.flush_async().await
	}
}

fn provider(ctx: &mut Ctx, faults: FaultFs) {
	ctx.fs = omp_vfs::Fs::new(Arc::new(faults)).blocking();
}

fn provider_trees(ctx: &Ctx, dest: &Path) -> DestTrees {
	let mut trees = trees_for(dest);
	trees.dest = Tree::open(&ctx.fs, dest, &TreeOpts::default()).unwrap();
	trees
}

fn run_capture(ctx: &Ctx, trees: &DestTrees, flists: &Flists) -> (Result<(), RsyncError>, io::Result<()>, Vec<u8>) {
	let (_sender, receiver) = finished_pipe(ctx, flists);
	let wire = Buf::default();
	let mut out = MuxWriter::new(Box::new(wire.clone()), IoCounters::default(), WriteConfig::default());
	let xattrs = Arc::new(Mutex::new(XattrReceiver::new(1 << 30)));
	let acls = Arc::new(Mutex::new(AclReceiver::new(AclOpts::default(), 1 << 30)));
	let result = run(ctx, trees, flists, xattrs, acls, Filters::new(FilterConfig::default()), &out, &receiver);
	out.flush().unwrap();
	let closed = ctx.fs.drain_closes();
	(result, closed, wire.bytes())
}

fn sender_admits_transfer(ctx: &Ctx, wire: &[u8], append: u32) -> bool {
	let mut reader = wire;
	let mut codec = NdxCodec::new(ctx.proto);
	let Ok(ndx) = codec.read(&mut reader) else { return false };
	if ndx < 0 {
		return false;
	}
	let Ok(flags) = reader.read_shortint().map(u32::from) else { return false };
	if flags & ITEM_TRANSFER == 0 {
		return false;
	}
	if flags & ITEM_BASIS_TYPE_FOLLOWS != 0 && reader.read_u8().is_err() {
		return false;
	}
	if flags & ITEM_XNAME_FOLLOWS != 0
		&& reader.read_vstring(MAXPATHLEN, RERR_PROTOCOL, ("rsync.c", 410)).is_err()
	{
		return false;
	}
	Sums::read(&mut reader, ctx.proto, 16, 0, append, 0, &mut || Ok(()), &ctx.logger).is_ok()
}

#[test]
fn source_removal_preserves_same_symlink_but_removes_distinct_source() {
	for target in ["payload", "missing"] {
		for same_destination in [true, false] {
			let tmp = tempfile::tempdir().unwrap();
			let root = fs::canonicalize(tmp.path()).unwrap();
			let source = root.join("source");
			let dest = if same_destination { source.clone() } else { root.join("dest") };
			fs::create_dir(&source).unwrap();
			if !same_destination {
				fs::create_dir(&dest).unwrap();
			}
			fs::write(source.join("payload"), b"source payload").unwrap();
			std::os::unix::fs::symlink(target, source.join("link")).unwrap();
			if !same_destination {
				fs::write(dest.join("payload"), b"destination payload").unwrap();
				std::os::unix::fs::symlink(target, dest.join("link")).unwrap();
			}
			let mut opts = base_opts();
			opts.remove_source_files = 1;
			let log = Buf::default();
			let mut ctx = make_ctx(opts, &source, &log);
			ctx.local_server = true;
			let filters = Filters::new(FilterConfig::default());
			let mut scanner = Scanner::new(&ctx, &[OsString::from("link")], filters, None).unwrap();
			let scan_out = MuxWriter::new(Box::new(Buf::default()), IoCounters::default(), WriteConfig::default());
			let flists = Flists::new();
			scanner.send_initial(&scan_out, &flists).unwrap();
			assert!(flists.is_eof());
			let (_sender, receiver) = finished_pipe(&ctx, &flists);
			let xattrs = Arc::new(Mutex::new(XattrReceiver::new(1 << 30)));
			let (wire, _) = generate_with(&ctx, &trees_for(&dest), &flists, xattrs, &receiver, true);
			let ack = frames(&wire).into_iter().find(|(code, _)| *code == MSG_SUCCESS).unwrap().1;
			let ndx = i32::from_le_bytes(ack[..4].try_into().unwrap());
			let identity = (
				u64::from_le_bytes(ack[4..12].try_into().unwrap()),
				u64::from_le_bytes(ack[12..20].try_into().unwrap()),
			);
			scanner.remove_source_checked(ndx, &flists, Some(identity)).unwrap();
			ctx.fs.drain_closes().unwrap();

			assert_eq!(fs::symlink_metadata(source.join("link")).is_ok(), same_destination);
			assert_eq!(fs::read_link(dest.join("link")).unwrap(), Path::new(target));
			assert_eq!(fs::read(source.join("payload")).unwrap(), b"source payload");
			if !same_destination {
				assert_eq!(fs::read(dest.join("payload")).unwrap(), b"destination payload");
			}
		}
	}
}

#[test]
fn dry_quick_check_preserves_partial_bytes() {
	for dry in [true, false] {
		let tmp = tempfile::tempdir().unwrap();
		fs::create_dir(tmp.path().join(".partial")).unwrap();
		write_file(&tmp.path().join("f"), b"same", T);
		fs::write(tmp.path().join(".partial/f"), b"retained-partial").unwrap();
		let mut opts = base_opts();
		opts.dry_run = dry;
		opts.do_xfers = !dry;
		opts.size_only = true;
		opts.partial_dir = Some(".partial".into());
		let log = Buf::default();
		let ctx = make_ctx(opts, tmp.path(), &log);
		let flists = publish(vec![entry("f", 0o100644, 4, T)], &ctx.logger);
		let mut trees = trees_for(tmp.path());
		trees.partial_dir = Some(b".partial".to_vec());
		generate(&ctx, &trees, &flists);
		ctx.fs.drain_closes().unwrap();
		assert_eq!(fs::read(tmp.path().join("f")).unwrap(), b"same");
		if dry {
			assert_eq!(fs::read(tmp.path().join(".partial/f")).unwrap(), b"retained-partial");
			assert!(tmp.path().join(".partial").is_dir());
		} else {
			assert!(matches!(fs::symlink_metadata(tmp.path().join(".partial/f")), Err(err) if err.kind() == io::ErrorKind::NotFound));
		}
	}
}

#[test]
fn safe_links_rejects_hardlink_members_in_both_orders() {
	for (dir, unsafe_name) in [("a", "z_escape"), ("z", "a_escape")] {
		let tmp = tempfile::tempdir().unwrap();
		let dest = tmp.path().join("dest");
		fs::create_dir(&dest).unwrap();
		fs::write(tmp.path().join("sentinel"), b"outside fixture sentinel").unwrap();
		let mut opts = base_opts();
		opts.preserve_hard_links = 1;
		opts.safe_symlinks = true;
		let log = Buf::default();
		let ctx = make_ctx(opts, &dest, &log);
		let safe_name = format!("{dir}/ok");
		let mut safe = entry(&safe_name, 0o120777, 11, T);
		safe.link = Some(b"../sentinel".as_slice().into());
		safe.flags |= FLAG_HLINKED;
		safe.hlink = Hlink::DevIno(1, 1);
		let mut unsafe_link = entry(unsafe_name, 0o120777, 11, T);
		unsafe_link.link = safe.link.clone();
		unsafe_link.flags |= FLAG_HLINKED;
		unsafe_link.hlink = Hlink::DevIno(1, 1);
		let mut list = FileList {
			entries: vec![entry(dir, 0o040755, 0, T), safe, unsafe_link],
			ndx_start: 0,
			parent_ndx: -1,
		};
		list.sort_and_clean(proto(), false, &ctx.logger);
		crate::rsync::hlink::match_hard_links(&mut list, proto());
		let flists = Flists::new();
		flists.push(list);
		flists.set_eof();
		generate(&ctx, &trees_for(&dest), &flists);
		ctx.fs.drain_closes().unwrap();
		assert_eq!(fs::read_link(dest.join(&safe_name)).unwrap(), Path::new("../sentinel"));
		assert!(matches!(fs::symlink_metadata(dest.join(unsafe_name)), Err(err) if err.kind() == io::ErrorKind::NotFound));
		assert_eq!(fs::read(tmp.path().join("sentinel")).unwrap(), b"outside fixture sentinel");
	}
}

fn delete_opts(dry: bool) -> Options {
	Options { recurse: 2, delete_mode: true, delete_during: 2, do_xfers: !dry, dry_run: dry, ..Options::default() }
}

#[test]
fn delayed_delete_keeps_inherited_merge_rules_after_leave_all() {
	for delayed in [false, true] {
		let tmp = tempfile::tempdir().unwrap();
		ds::put(tmp.path(), ".rsync-filter", "P important\n");
		ds::put(tmp.path(), "gone/important", "keep");
		ds::put(tmp.path(), "gone/discard", "remove");
		let mut opts = delete_opts(false);
		opts.delete_during = if delayed { 2 } else { 1 };
		let (ctx, trees, _) = ds::setup(tmp.path(), opts, &ds::VERBOSE);
		let mut filters = ds::filters(&ctx, tmp.path(), &[b": .rsync-filter"], false);
		let flists = ds::flists(&ctx, &[(".rsync-filter", ds::REG)]);
		let mut del = Deleter::new(&ctx);
		del.delete_in_dir(&ctx, &trees, &flists, &mut filters, b".", ds::ndx_of(&flists, ".")).unwrap();
		del.leave_all(&mut filters);
		del.run_delayed(&ctx, &trees).unwrap();
		ctx.fs.drain_closes().unwrap();
		assert_eq!(fs::read(tmp.path().join("gone/important")).unwrap(), b"keep");
		assert!(matches!(fs::metadata(tmp.path().join("gone/discard")), Err(err) if err.kind() == io::ErrorKind::NotFound));
		assert_eq!(ctx.stats.lock().unwrap().deleted_files, 1);
		assert_eq!(ctx.stats.lock().unwrap().deleted_dirs, 0);
	}
}

#[test]
fn late_io_error_blocks_delayed_removal_unless_explicitly_ignored() {
	for ignore in [false, true] {
		let tmp = tempfile::tempdir().unwrap();
		ds::put(tmp.path(), "extra", "keep-on-error");
		let mut opts = delete_opts(false);
		opts.ignore_errors = ignore;
		let (ctx, trees, _) = ds::setup(tmp.path(), opts, &ds::VERBOSE);
		let mut filters = ds::filters(&ctx, tmp.path(), &[], false);
		let flists = ds::flists(&ctx, &[]);
		let mut del = Deleter::new(&ctx);
		del.delete_in_dir(&ctx, &trees, &flists, &mut filters, b".", ds::ndx_of(&flists, ".")).unwrap();
		assert_eq!(fs::read(tmp.path().join("extra")).unwrap(), b"keep-on-error");
		ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
		del.leave_all(&mut filters);
		del.run_delayed(&ctx, &trees).unwrap();
		ctx.fs.drain_closes().unwrap();
		if ignore {
			assert!(matches!(fs::metadata(tmp.path().join("extra")), Err(err) if err.kind() == io::ErrorKind::NotFound));
		} else {
			assert_eq!(fs::read(tmp.path().join("extra")).unwrap(), b"keep-on-error");
		}
		assert_eq!(ctx.stats.lock().unwrap().deleted_files, i32::from(ignore));
	}
}

#[test]
fn dry_delete_counts_only_removable_entries() {
	for dry in [true, false] {
		let tmp = tempfile::tempdir().unwrap();
		ds::put(tmp.path(), "gone/sub/keep", "protected");
		ds::put(tmp.path(), "gone/discard", "discard");
		let (ctx, trees, _) = ds::setup(tmp.path(), delete_opts(dry), &ds::ITEMIZE);
		let filters = ds::filters(&ctx, tmp.path(), &[b"P keep"], false);
		let mut del = Deleter::new(&ctx);
		let result = del.delete_item(&ctx, &trees, &filters, b"gone", ds::DIR, DEL_RECURSE);
		ctx.fs.drain_closes().unwrap();
		assert_eq!(result, DelResult::DirNotEmpty);
		assert_eq!(ctx.stats.lock().unwrap().deleted_dirs, 0);
		assert_eq!(ctx.stats.lock().unwrap().deleted_files, 1);
		assert_eq!(fs::read(tmp.path().join("gone/sub/keep")).unwrap(), b"protected");
		if dry {
			assert_eq!(fs::read(tmp.path().join("gone/discard")).unwrap(), b"discard");
		} else {
			assert!(matches!(fs::metadata(tmp.path().join("gone/discard")), Err(err) if err.kind() == io::ErrorKind::NotFound));
		}
	}
}

#[test]
fn failed_nonregular_backup_never_authorizes_unlink() {
	for special in [0, 1, 2] {
		for denied in [false, true] {
			let tmp = tempfile::tempdir().unwrap();
			let root = fs::canonicalize(tmp.path()).unwrap();
			let dest = root.join("dest");
			let back = root.join("backup");
			fs::create_dir(&dest).unwrap();
			fs::create_dir(&back).unwrap();
			if special == 0 {
				std::os::unix::fs::symlink("target", dest.join("victim")).unwrap();
			} else {
				open_tree(&dest).mknod(Path::new("victim"), omp_vfs::NodeKind::Fifo, 0o600).unwrap();
			}
			let mut opts = delete_opts(false);
			opts.make_backups = true;
			opts.backup_dir = Some(back.clone().into_os_string());
			opts.preserve_links = true;
			opts.preserve_specials = special != 0;
			if special == 2 {
				opts.am_root = -1;
			}
			let log = Buf::default();
			let mut ctx = make_ctx(opts, &dest, &log);
			ctx.meta.fake_super = special == 2;
			provider(&mut ctx, FaultFs { deny_backup: denied.then(|| back.clone()), ..FaultFs::default() });
			let mut trees = provider_trees(&ctx, &dest);
			trees.backup_dir = Some(Tree::open(&ctx.fs, &back, &TreeOpts::default()).unwrap());
			let filters = Filters::new(FilterConfig::default());
			let mut del = Deleter::new(&ctx);
			let mode = if special == 0 { 0o120777 } else { 0o010600 };
			let result = del.delete_item(&ctx, &trees, &filters, b"victim", mode, 0);
			ctx.fs.drain_closes().unwrap();
			assert_eq!(result, if denied { DelResult::Error } else { DelResult::Deleted });
			let retained = if denied { dest.join("victim") } else { back.join("victim") };
			let absent = if denied { back.join("victim") } else { dest.join("victim") };
			let st = fs::symlink_metadata(&retained).unwrap();
			if special == 0 {
				assert!(st.file_type().is_symlink());
				assert_eq!(fs::read_link(retained).unwrap(), Path::new("target"));
			} else {
				assert!(st.file_type().is_fifo());
			}
			assert!(matches!(fs::symlink_metadata(absent), Err(err) if err.kind() == io::ErrorKind::NotFound));
			assert_eq!(ctx.stats.lock().unwrap().deleted_files, i32::from(!denied));
		}
	}
}

#[test]
fn failed_backup_cannot_complete_sender_checksum_admission() {
	for append in [0, 1, 2] {
		for (limit, close_error) in [(0, false), (2, false), (usize::MAX, true)] {
			let tmp = tempfile::tempdir().unwrap();
			let root = fs::canonicalize(tmp.path()).unwrap();
			let dest = root.join("dest");
			let back = root.join("backup");
			fs::create_dir(&dest).unwrap();
			fs::create_dir(&back).unwrap();
			write_file(&dest.join("f"), b"OLD!", T - 100);
			let mut opts = base_opts();
			opts.inplace = true;
			opts.make_backups = true;
			opts.backup_dir = Some(back.clone().into_os_string());
			opts.block_size = 2;
			opts.append_mode = append;
			let log = Buf::default();
			let mut ctx = make_ctx(opts, &dest, &log);
			provider(&mut ctx, FaultFs { backup_fault: Some((back.clone(), limit, close_error)), ..FaultFs::default() });
			let mut trees = provider_trees(&ctx, &dest);
			trees.backup_dir = Some(Tree::open(&ctx.fs, &back, &TreeOpts::default()).unwrap());
			let flists = publish(vec![entry("f", 0o100644, 9, T)], &ctx.logger);
			let (result, closed, wire) = run_capture(&ctx, &trees, &flists);
			if !close_error {
				closed.unwrap();
			}
			assert!(!sender_admits_transfer(&ctx, &wire, append), "append={append}, limit={limit}, close={close_error}");
			assert_eq!(result.unwrap_err().code, crate::rsync::exit::RERR_FILEIO);
			assert_eq!(fs::read(dest.join("f")).unwrap(), b"OLD!");
			let expected = if close_error { b"OLD!".as_slice() } else if limit == 2 { b"OL".as_slice() } else { b"".as_slice() };
			assert_eq!(fs::read(back.join("f")).unwrap(), expected);
		}
	}
}

#[test]
fn successful_backup_preserves_exact_basis_and_admits_sender() {
	for append in [0, 1, 2] {
		for old in [b"".as_slice(), b"OLD!".as_slice()] {
			let tmp = tempfile::tempdir().unwrap();
			let root = fs::canonicalize(tmp.path()).unwrap();
			let dest = root.join("dest");
			let back = root.join("backup");
			fs::create_dir(&dest).unwrap();
			fs::create_dir(&back).unwrap();
			write_file(&dest.join("f"), old, T - 100);
			let mut opts = base_opts();
			opts.inplace = true;
			opts.make_backups = true;
			opts.backup_dir = Some(back.clone().into_os_string());
			opts.block_size = 2;
			opts.append_mode = append;
			let log = Buf::default();
			let mut ctx = make_ctx(opts, &dest, &log);
			provider(&mut ctx, FaultFs { backup_fault: Some((back.clone(), usize::MAX, false)), ..FaultFs::default() });
			let mut trees = provider_trees(&ctx, &dest);
			trees.backup_dir = Some(Tree::open(&ctx.fs, &back, &TreeOpts::default()).unwrap());
			let flists = publish(vec![entry("f", 0o100644, 9, T)], &ctx.logger);
			let (result, closed, wire) = run_capture(&ctx, &trees, &flists);
			closed.unwrap();
			result.unwrap();
			assert!(sender_admits_transfer(&ctx, &wire, append));
			assert_eq!(fs::read(back.join("f")).unwrap(), old);
			assert_eq!(fs::read(dest.join("f")).unwrap(), old);
		}
	}
}

#[test]
fn copy_dest_completes_across_temp_devices_without_xfer_error() {
	for cross in [false, true] {
		let tmp = tempfile::tempdir().unwrap();
		let root = fs::canonicalize(tmp.path()).unwrap();
		let dest = root.join("dest");
		let alt = root.join("alt");
		let temp = root.join("temp");
		for path in [&dest, &alt, &temp] {
			fs::create_dir(path).unwrap();
		}
		write_file(&alt.join("f"), b"matching-local-copy", T);
		fs::set_permissions(alt.join("f"), fs::Permissions::from_mode(0o640)).unwrap();
		let mut opts = base_opts();
		opts.alt_dest_type = crate::rsync::consts::COPY_DEST;
		opts.preserve_perms = true;
		let log = Buf::default();
		let mut ctx = make_ctx(opts, &dest, &log);
		provider(&mut ctx, FaultFs { cross_temp: cross.then(|| temp.clone()), ..FaultFs::default() });
		let mut trees = provider_trees(&ctx, &dest);
		trees.alt_dirs.push(Tree::open(&ctx.fs, &alt, &TreeOpts::default()).unwrap());
		trees.temp_dir = Some(Tree::open(&ctx.fs, &temp, &TreeOpts::default()).unwrap());
		let flists = publish(vec![entry("f", 0o100640, 19, T)], &ctx.logger);
		let (result, closed, wire) = run_capture(&ctx, &trees, &flists);
		closed.unwrap();
		result.unwrap();
		assert_eq!(fs::read(dest.join("f")).unwrap(), b"matching-local-copy");
		assert_eq!(fs::read(alt.join("f")).unwrap(), b"matching-local-copy");
		let st = fs::metadata(dest.join("f")).unwrap();
		assert_eq!(st.mode() & 0o777, 0o640);
		assert_eq!(st.mtime(), T);
		assert!(!ctx.logger.got_xfer_error());
		assert!(transferred(&ctx, &flists, &parse(&wire).0).is_empty());
		assert_eq!(fs::read_dir(&temp).unwrap().count(), 0);
		let names: Vec<_> = fs::read_dir(&dest).unwrap().map(|entry| entry.unwrap().file_name()).collect();
		assert_eq!(names, [OsString::from("f")]);
	}
}

#[test]
fn destination_rejects_untrusted_parent_before_creating_directories() {
	for mkpath in [false, true] {
		for untrusted in [false, true] {
			for dry in [false, true] {
				let tmp = tempfile::tempdir().unwrap();
				let root = fs::canonicalize(tmp.path()).unwrap();
				let victim = root.join("victim");
				fs::create_dir(&victim).unwrap();
				let planted = root.join("planted");
				std::os::unix::fs::symlink(&victim, &planted).unwrap();
				let mut opts = base_opts();
				opts.mkpath_dest_arg = mkpath;
				opts.dry_run = dry;
				opts.do_xfers = !dry;
				let log = Buf::default();
				let mut ctx = make_ctx(opts, &root, &log);
				provider(&mut ctx, FaultFs { untrusted_link: untrusted.then(|| planted.clone()), ..FaultFs::default() });
				let flists = publish(vec![entry("f", 0o100644, 1, T)], &ctx.logger);
				let name = if mkpath { "planted/new/deeper/file" } else { "planted/new/" };
				let result = DestTrees::open(&ctx, Some(OsStr::new(name)), &flists);
				ctx.fs.drain_closes().unwrap();
				if untrusted || dry {
					assert_eq!(fs::read_dir(&victim).unwrap().count(), 0);
				} else {
					assert!(victim.join("new").is_dir());
					if mkpath {
						assert!(victim.join("new/deeper").is_dir());
					}
				}
				assert_eq!(result.is_err(), untrusted && !dry);
			}
		}
	}
}

#[test]
fn max_delete_stops_at_signed_maximum_without_adding_category_totals() {
	let tmp = tempfile::tempdir().unwrap();
	ds::put(tmp.path(), "first", "one");
	ds::put(tmp.path(), "second", "two");
	let mut opts = delete_opts(false);
	opts.max_delete = i32::MAX;
	let (ctx, trees, _) = ds::setup(tmp.path(), opts, &ds::VERBOSE);
	ctx.stats.lock().unwrap().deleted_files = i32::MAX - 1;
	let filters = ds::filters(&ctx, tmp.path(), &[], false);
	let mut del = Deleter::new(&ctx);
	assert_eq!(del.delete_item(&ctx, &trees, &filters, b"first", ds::REG, 0), DelResult::Deleted);
	assert_eq!(del.delete_item(&ctx, &trees, &filters, b"second", ds::REG, 0), DelResult::Skipped);
	del.finish(&ctx);
	ctx.fs.drain_closes().unwrap();
	assert_eq!(ctx.stats.lock().unwrap().deleted_files, i32::MAX);
	assert_eq!(fs::read(tmp.path().join("second")).unwrap(), b"two");
	assert!(matches!(fs::metadata(tmp.path().join("first")), Err(err) if err.kind() == io::ErrorKind::NotFound));
	assert_ne!(ctx.io_error.load(Ordering::Relaxed) & IOERR_DEL_LIMIT, 0);
}
