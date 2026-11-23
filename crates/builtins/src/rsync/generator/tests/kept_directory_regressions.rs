use super::*;
use std::{
	fs,
	os::unix::fs::{MetadataExt, PermissionsExt},
	path::PathBuf,
};

struct RestoreMode(PathBuf);

impl Drop for RestoreMode {
	fn drop(&mut self) {
		let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
	}
}

#[test]
fn directories_restore_owner_bits_and_time_after_child_creation() {
	for kept_link in [false, true] {
		for mode in [0o300, 0o600, 0o700] {
			let tmp = tempfile::tempdir().unwrap();
			let target = tmp.path().join(if kept_link { "target" } else { "d" });
			fs::create_dir(&target).unwrap();
			fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
			let _restore = RestoreMode(target.clone());
			set_mtime(&target, T - 100);
			let link = tmp.path().join("d");
			let original_link = if kept_link {
				std::os::unix::fs::symlink("target", &link).unwrap();
				Some(fs::symlink_metadata(&link).unwrap())
			} else {
				None
			};
			let mut opts = base_opts();
			opts.keep_dirlinks = kept_link;
			opts.preserve_perms = true;
			opts.am_root = 0;
			let log = Buf::default();
			let ctx = make_ctx(opts, tmp.path(), &log);
			let mut child = entry("d/child", 0o120777, 7, T);
			child.link = Some(b"payload".as_slice().into());
			let flists = publish(vec![entry("d", 0o040000 | mode, 0, T), child], &ctx.logger);
			generate(&ctx, &trees_for(tmp.path()), &flists);
			ctx.fs.drain_closes().unwrap();

			let st = fs::metadata(&target).unwrap();
			assert_eq!(st.permissions().mode() & 0o777, mode, "kept_link={kept_link}");
			assert_eq!(st.mtime(), T, "kept_link={kept_link}, mode={mode:o}");
			if let Some(before) = original_link {
				let after = fs::symlink_metadata(&link).unwrap();
				assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
				assert_eq!(after.modified().unwrap(), before.modified().unwrap());
				assert_eq!(fs::read_link(&link).unwrap(), Path::new("target"));
			}
			assert!(!ctx.logger.got_xfer_error());
			fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
			assert_eq!(fs::read_link(target.join("child")).unwrap(), Path::new("payload"));
		}
	}
}
