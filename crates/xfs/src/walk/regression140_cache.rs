use super::*;

#[cfg(unix)]
#[tokio::test]
#[ignore = "requires PI_WALKER_UNSTABLE_IGNORE_ROOT on a filesystem excluded by stable_stamps"]
async fn followed_ignore_source_requires_its_own_stable_filesystem() {
	use std::path::PathBuf;

	struct ExternalDir(PathBuf);
	impl Drop for ExternalDir {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}
	let external_root = std::env::var_os("PI_WALKER_UNSTABLE_IGNORE_ROOT")
		.expect("parent must provision an unsupported/coarse filesystem root");
	let nonce = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap()
		.as_nanos();
	let external_path = PathBuf::from(external_root)
		.join(format!("pi-walker-ignore-source-{}-{nonce}", std::process::id()));
	std::fs::create_dir(&external_path).expect("create owned external fixture");
	let external = ExternalDir(external_path);
	let target = external.0.join("rules");
	std::fs::write(&target, "drop\n").unwrap();
	let tmp = super::super::tests::make_tree("source-filesystem", &["drop", "keep"]);
	std::os::unix::fs::symlink(&target, tmp.path().join(".gitignore")).unwrap();
	let mut session = crate::Fs::native().session();
	let dir = session.open_dir(tmp.path()).await.unwrap();
	let stamp = session.stat_dir(&dir).await.unwrap();
	assert!(session.stable_stamps(&dir, &stamp), "local fixture must support cache admission");
	let foreign_dir = session.open_dir(&external.0).await.unwrap();
	let foreign_stamp = session.stat_dir(&foreign_dir).await.unwrap();
	assert!(
		!session.stable_stamps(&foreign_dir, &foreign_stamp),
		"external fixture must exclude stable stamps"
	);

	let mut listing = Listing::default();
	listing.push(b"drop", crate::FileType::File, None, None, 0);
	listing.push(b"keep", crate::FileType::File, None, None, 0);
	let mut names = Names::default();
	names.record(b".gitignore", crate::FileType::Symlink, None);
	let ignores =
		DirIgnores::load(&mut session, &dir, tmp.path(), names, CACHED_SOURCES, true).await;
	assert_eq!(
		ignores.files[2].as_ref().unwrap().matched(b"drop", false),
		crate::ignore::Match::Ignore
	);
	tokio::time::sleep(std::time::Duration::from_millis(120)).await;
	let cache = Cache::new(1 << 20);
	cache.store(&mut session, tmp.path(), &dir, now_nanos(), stamp, &listing, names, Some(&ignores));
	assert!(
		cache
			.lookup(&mut session, tmp.path(), true, &mut Vec::new())
			.await
			.is_none(),
		"a stable containing directory cannot authorize caching coarse ignore-source stamps"
	);
}

#[tokio::test]
async fn settled_local_ignore_sources_remain_cacheable() {
	let tmp =
		super::super::tests::make_tree("stable-source-cache", &[".gitignore=drop\n", "drop", "keep"]);
	let mut session = crate::Fs::native().session();
	let dir = session.open_dir(tmp.path()).await.unwrap();
	let stamp = session.stat_dir(&dir).await.unwrap();
	if !session.stable_stamps(&dir, &stamp) {
		eprintln!("stable-source cache control unavailable on this filesystem");
		return;
	}
	let mut listing = Listing::default();
	listing.push(b"drop", crate::FileType::File, None, None, 0);
	listing.push(b"keep", crate::FileType::File, None, None, 0);
	let mut names = Names::default();
	names.record(b".gitignore", crate::FileType::File, None);
	let ignores =
		DirIgnores::load(&mut session, &dir, tmp.path(), names, CACHED_SOURCES, true).await;
	tokio::time::sleep(std::time::Duration::from_millis(120)).await;
	let cache = Cache::new(1 << 20);
	cache.store(&mut session, tmp.path(), &dir, now_nanos(), stamp, &listing, names, Some(&ignores));
	let admitted = cache
		.lookup(&mut session, tmp.path(), true, &mut Vec::new())
		.await
		.expect("stable settled sources admit cached filtering");
	assert_eq!(
		admitted.ignores.as_ref().unwrap().files[2]
			.as_ref()
			.unwrap()
			.matched(b"drop", false),
		crate::ignore::Match::Ignore
	);
	assert_eq!(
		admitted.ignores.as_ref().unwrap().files[2]
			.as_ref()
			.unwrap()
			.matched(b"keep", false),
		crate::ignore::Match::None
	);
	assert_eq!(
		admitted
			.listing
			.records()
			.iter()
			.map(|r| admitted.listing.name(r))
			.collect::<Vec<_>>(),
		[b"drop".as_slice(), b"keep".as_slice()]
	);
}
