use super::*;

#[test]
fn dropping_an_unpolled_worker_retains_published_path_storage() {
	let fs = Fs::native();
	let (jobs, queue) = flume::unbounded();
	let sink = CollectSink::new(|_: &mut Worker<'_>, _: &mut Entry<'_>| Action::Continue);
	let ctx = Arc::new(Ctx {
		fs: fs.clone(),
		root: PathBuf::new(),
		opts: Options::default(),
		sink,
		ignorer: None,
		cache: None,
		root_dev: None,
		fences: Fences::default(),
		retained: Arc::new(AtomicUsize::new(0)),
		jobs: RwLock::new(Some(jobs)),
		queue: queue.clone(),
		pending: AtomicUsize::new(0),
		scratches: Mutex::new(Vec::new()),
		shared: Arc::new(Shared::default()),
		tx: None,
		total: AtomicUsize::new(0),
	});
	let mut scratch = Scratch::new(&fs, ());
	let published = scratch.arena.push(&[b"root/child"]);
	let (done_tx, done) = flume::unbounded();
	let owned = Owned::new(ctx.clone(), scratch, done_tx);
	let worker = ctx.clone().work(owned, None, None, queue);
	drop(worker);
	assert!(done.recv().is_err());
	let retained = ctx.scratches.lock();
	assert_eq!(retained.len(), 1, "the published path must still have its producer arena");
	// SAFETY: the retained scratch above owns the published arena until this
	// guard drops.
	assert_eq!(unsafe { published.get() }, b"root/child");
}

#[tokio::test]
async fn worker_completion_publishes_entries_before_waking_the_collector() {
	struct Observe<F>(F);
	impl<F: Fn() + Send + Sync> std::task::Wake for Observe<F> {
		fn wake(self: Arc<Self>) {
			(self.0)();
		}
	}

	let tmp = super::super::tests::make_tree("completion-publication", &["child"]);
	let fs = Fs::native();
	let (jobs, queue) = flume::unbounded();
	let sink = CollectSink::new(|_: &mut Worker<'_>, _: &mut Entry<'_>| Action::Continue);
	let ctx = Arc::new(Ctx {
		fs: fs.clone(),
		root: tmp.path().to_path_buf(),
		opts: Options::default(),
		sink,
		ignorer: None,
		cache: None,
		root_dev: None,
		fences: Fences::default(),
		retained: Arc::new(AtomicUsize::new(0)),
		jobs: RwLock::new(Some(jobs)),
		queue: queue.clone(),
		pending: AtomicUsize::new(1),
		scratches: Mutex::new(Vec::new()),
		shared: Arc::new(Shared::default()),
		tx: None,
		total: AtomicUsize::new(0),
	});
	let first = Job {
		parent:   None,
		rel:      Bytes::EMPTY,
		name_len: 0,
		depth:    0,
		count:    0,
		frame:    None,
		out:      None,
	};
	let (done_tx, done) = flume::unbounded();
	let owned = Owned::new(ctx.clone(), Scratch::new(&fs, ()), done_tx);
	let worker = ctx.clone().work(owned, Some(first), None, queue);
	let observed = Arc::new(Mutex::new(None));
	let waker = std::task::Waker::from(Arc::new(Observe({
		let ctx = ctx.clone();
		let observed = observed.clone();
		move || {
			let scratches = ctx.scratches.lock();
			let entries: Vec<Vec<u8>> = scratches
				.iter()
				.flat_map(|scratch| &scratch.out)
				.map(|entry| {
					// SAFETY: the locked scratches own every observed path arena.
					unsafe { entry.path.get() }.to_vec()
				})
				.collect();
			*observed.lock() = Some(entries);
		}
	})));
	let mut completion = std::pin::pin!(done.recv_async());
	assert!(
		completion
			.as_mut()
			.poll(&mut std::task::Context::from_waker(&waker))
			.is_pending()
	);
	worker.await;
	assert_eq!(
		*observed.lock(),
		Some(vec![b"child".to_vec()]),
		"completion must expose all collected entries and their owning arenas"
	);
	assert!(completion.await.is_err());
}

#[test]
fn sorted_slots_release_deep_and_shared_subtrees_iteratively() {
	if super::super::tests::isolated_case(
		"PI_WALKER_SLOT_DROP_CHILD",
		"walk::parallel::regression140::sorted_slots_release_deep_and_shared_subtrees_iteratively",
	) {
		return;
	}
	std::thread::Builder::new()
		.stack_size(256 * 1024)
		.spawn(|| {
			let mut arena = Arena::default();
			let path = arena.push(&[b"leaf"]);
			let mut root = Arc::new(Slot::default());
			let _ = root.items.set(vec![Item {
				name: path,
				kind: ItemKind::Entry(Stored {
					path,
					file_type: FileType::File,
					depth: 4096,
					size: None,
					mtime: None,
				}),
			}]);
			let shared = root.clone();
			for _ in 0..4096 {
				let parent = Arc::new(Slot::default());
				let _ = parent
					.items
					.set(vec![Item { name: path, kind: ItemKind::Dir(root) }]);
				root = parent;
			}
			let mut out = Vec::new();
			flatten(&root, &mut out);
			// SAFETY: arena remains alive through flattening and both subtree
			// owners.
			assert_eq!(
				out.iter()
					.map(|e| unsafe { e.path.get() })
					.collect::<Vec<_>>(),
				[b"leaf".as_slice()]
			);
			drop(root);
			assert_eq!(Arc::strong_count(&shared), 1);
			let mut remaining = Vec::new();
			flatten(&shared, &mut remaining);
			// SAFETY: arena still owns every stored byte.
			assert_eq!(
				remaining
					.iter()
					.map(|e| unsafe { e.path.get() })
					.collect::<Vec<_>>(),
				[b"leaf".as_slice()]
			);
			drop(shared);
		})
		.unwrap()
		.join()
		.unwrap();
}

static DELAYED_OBSERVATION: Mutex<Option<PathBuf>> = Mutex::new(None);

pub(super) fn freshen_delayed_observation(path: &Path) {
	if DELAYED_OBSERVATION.lock().as_deref() == Some(path) {
		std::fs::write(path.join("fresh-marker"), "").expect("fresh directory mutation");
	}
}

pub(super) async fn delay_cache_observation(path: &Path, stamp: crate::fs::Stamp) {
	let active = DELAYED_OBSERVATION.lock().as_deref() == Some(path);
	if active {
		let now = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let age = i128::try_from(now).unwrap() - i128::from(stamp.latest());
		assert!(
			(0..50_000_000).contains(&age),
			"fixture prerequisite: directory observation must still be within its racy window"
		);
		tokio::time::sleep(std::time::Duration::from_millis(120)).await;
	}
}

#[tokio::test]
async fn delayed_store_cannot_age_a_fresh_directory_observation() {
	let tmp = super::super::tests::make_tree("delayed-observation", &["keep"]);
	let fs = Fs::native();
	let mut session = fs.session();
	let dir = session.open_dir(tmp.path()).await.unwrap();
	let stamp = session.stat_dir(&dir).await.unwrap();
	if !session.stable_stamps(&dir, &stamp) {
		eprintln!("observation-time cache regression unavailable on this filesystem");
		return;
	}
	struct Reset;
	impl Drop for Reset {
		fn drop(&mut self) {
			*DELAYED_OBSERVATION.lock() = None;
		}
	}
	*DELAYED_OBSERVATION.lock() = Some(tmp.path().to_path_buf());
	let reset = Reset;
	static CACHE: std::sync::LazyLock<Cache> = std::sync::LazyLock::new(|| Cache::new(1 << 20));
	let cache = &*CACHE;
	let opts = Options { cache: true, workers: Some(1), ..Default::default() };
	let found =
		super::super::collect_in(&fs, tmp.path(), &opts, true, |_, _| Action::Continue, Some(cache))
			.await
			.unwrap();
	assert_eq!(found.iter().map(|e| e.path.to_vec()).collect::<Vec<_>>(), [
		b"fresh-marker".to_vec(),
		b"keep".to_vec()
	]);
	drop(found);
	drop(reset);
	assert!(
		cache
			.lookup(&mut session, tmp.path(), false, &mut Vec::new())
			.await
			.is_none(),
		"elapsed storage delay must not authorize a fresh observation"
	);
	let found =
		super::super::collect_in(&fs, tmp.path(), &opts, true, |_, _| Action::Continue, Some(cache))
			.await
			.unwrap();
	assert_eq!(found.iter().map(|e| e.path.to_vec()).collect::<Vec<_>>(), [
		b"fresh-marker".to_vec(),
		b"keep".to_vec()
	]);
	assert!(
		cache
			.lookup(&mut session, tmp.path(), false, &mut Vec::new())
			.await
			.is_some(),
		"a later settled observation remains cacheable"
	);
	drop(found);
	drop(dir);
	let removed = tmp.path().to_path_buf();
	drop(tmp);
	assert!(
		cache
			.lookup(&mut session, &removed, false, &mut Vec::new())
			.await
			.is_none()
	);
}
