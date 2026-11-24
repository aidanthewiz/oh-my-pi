use super::*;

fn sparse_append_case(mode: u32, whole_file: i32, tail: &[u8]) {
	let mut o = opts();
	o.inplace = true;
	o.sparse_files = true;
	o.append_mode = mode;
	o.whole_file = whole_file;
	let mut fx = Fixture::new(o, P33, SEED);
	fx.ctx.local_server = whole_file < 0;
	std::fs::write(fx.path("f"), b"ABCD").unwrap();
	let want = [&b"ABCD"[..], tail].concat();
	let sum = if mode == 1 { md5(SEED, &[tail]) } else { md5(SEED, &[&want]) };
	let flists = flists_of(vec![entry("f", want.len(), 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let head = SumHead { count: 1, blength: 4, s2length: 2, remainder: 0 };
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, head, &[Tok::Lit(tail)], &sum);
	s.done().done().done();
	let (result, sib) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), want, "append={mode}, whole={whole_file}, tail={tail:?}");
	assert!(!sib.contains(&Sibling::Redo(0)), "{}", fx.messages());
	assert!(!fx.ctx.logger.got_xfer_error(), "{}", fx.messages());
}

#[test]
fn sparse_append_preserves_prefix_and_zero_leading_tails() {
	for mode in [1, 2] {
		for tail in [&b"\0\0\0\0"[..], &b"\0\0\0\0E"[..]] {
			sparse_append_case(mode, 0, tail);
		}
	}
}

#[test]
fn local_sparse_append_preserves_prefix_under_whole_file_selection() {
	for mode in [1, 2] {
		for whole_file in [1, -1] {
			for tail in [&b"E"[..], &b"\0\0\0\0"[..], &b"\0\0\0\0E"[..]] {
				sparse_append_case(mode, whole_file, tail);
			}
		}
	}
}

#[test]
fn failed_copies_release_source_removal_slots_without_authorizing_deletion() {
	let mut o = opts();
	o.remove_source_files = 1;
	let fx = Fixture::new(o, P33, SEED);
	let mut entries = Vec::new();
	let mut s = Stream::new(Compress::None);
	for ndx in 0..51 {
		let name = format!("blocked-{ndx}");
		std::fs::create_dir(fx.path(&name)).unwrap();
		entries.push(entry(&name, 4, 0o100_644, 0));
		s.file(ndx, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"data")], &md5(SEED, &[b"data"]));
	}
	entries.push(entry("ok", 4, 0o100_644, 0));
	s.file(51, ITEM_TRANSFER | ITEM_IS_NEW, SumHead::default(), &[Tok::Lit(b"good")], &md5(SEED, &[b"good"]));
	s.done().done().done();
	let flists = flists_of(entries);
	let trees = fx.trees();
	let (result, sib) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	let mut expected: Vec<Sibling> = (0..51).map(Sibling::NoSend).collect();
	expected.extend([Sibling::Success(51), Sibling::Done, Sibling::Done]);
	assert_eq!(sib, expected);
	assert_eq!(std::fs::read(fx.path("ok")).unwrap(), b"good");
	for ndx in 0..51 {
		assert!(fx.path(&format!("blocked-{ndx}")).is_dir());
	}
	assert!(fx.ctx.logger.got_xfer_error());
}

#[test]
fn zlib_discard_without_basis_does_not_poison_the_next_file() {
	let mut o = opts();
	o.remove_source_files = 1;
	let mut fx = Fixture::new(o, P33, SEED);
	fx.ctx.compress = Compress::Zlib;
	std::fs::create_dir(fx.path("blocked")).unwrap();
	let mut state = 0x1234_5678u32;
	let basis: Vec<u8> = (0..8192).map(|_| {
		state ^= state << 13;
		state ^= state >> 17;
		state ^= state << 5;
		state as u8
	}).collect();
	let flists = flists_of(vec![entry("blocked", basis.len() * 2, 0o100_644, 0), entry("ok", 8, 0o100_644, 0)]);
	let trees = fx.trees();
	let head = SumHead { count: 1, blength: basis.len() as i32, s2length: 2, remainder: 0 };
	let mut s = Stream::new(Compress::Zlib);
	s.file(0, ITEM_TRANSFER, head, &[Tok::Block(0, &basis), Tok::Lit(&basis)], &md5(SEED, &[&basis, &basis]));
	s.file(1, ITEM_TRANSFER | ITEM_IS_NEW, SumHead::default(), &[Tok::Lit(b"survived")], &md5(SEED, &[b"survived"]));
	s.done().done().done();
	let (result, sib) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert!(fx.path("blocked").is_dir());
	assert_eq!(std::fs::read(fx.path("ok")).unwrap(), b"survived");
	assert_eq!(sib, [Sibling::NoSend(0), Sibling::Success(1), Sibling::Done, Sibling::Done]);
	assert!(fx.ctx.logger.got_xfer_error());
}

#[test]
fn discarded_zlib_file_still_rejects_out_of_range_blocks() {
	let mut o = opts();
	o.remove_source_files = 1;
	let mut fx = Fixture::new(o, P33, SEED);
	fx.ctx.compress = Compress::Zlib;
	std::fs::create_dir(fx.path("blocked")).unwrap();
	let flists = flists_of(vec![entry("blocked", 4, 0o100_644, 0)]);
	let trees = fx.trees();
	let head = SumHead { count: 1, blength: 4, s2length: 2, remainder: 0 };
	let mut s = Stream::new(Compress::Zlib);
	s.file(0, ITEM_TRANSFER, head, &[Tok::Block(5, b"data")], &[0; 16]);
	let (result, sib) = fx.run(&trees, &flists, s.take());
	assert_eq!(result.unwrap_err().code, RERR_PROTOCOL);
	assert!(!sib.contains(&Sibling::Success(0)));
	assert_eq!(dir_names(fx.dir.path()), ["blocked"]);
	assert!(fx.path("blocked").is_dir());
}

#[test]
fn discarded_zlib_file_requires_complete_frames_and_checksum_trailer() {
	for truncated_frame in [true, false] {
		let mut o = opts();
		o.remove_source_files = 1;
		let mut fx = Fixture::new(o, P33, SEED);
		fx.ctx.compress = Compress::Zlib;
		std::fs::create_dir(fx.path("blocked")).unwrap();
		let flists = flists_of(vec![entry("blocked", 4, 0o100_644, 0)]);
		let trees = fx.trees();
		let mut s = Stream::new(Compress::Zlib);
		let stream = if truncated_frame {
			s.ndx.write(&mut s.buf, 0).unwrap();
			s.buf.write_shortint(ITEM_TRANSFER as u16).unwrap();
			SumHead::default().write(&mut s.buf, P33).unwrap();
			// DEFLATED_DATA announces four bytes, but only one arrives.
			s.buf.extend_from_slice(&[0x40, 4, 1]);
			s.take()
		} else {
			s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"data")], &md5(SEED, &[b"data"]));
			let mut stream = s.take();
			stream.pop();
			stream
		};
		let (result, sib) = fx.run(&trees, &flists, stream);
		assert_eq!(result.unwrap_err().code, crate::rsync::exit::RERR_STREAMIO, "frame={truncated_frame}");
		assert!(!sib.contains(&Sibling::Success(0)));
		assert_eq!(dir_names(fx.dir.path()), ["blocked"]);
		assert!(fx.path("blocked").is_dir());
	}
}

#[cfg(unix)]
#[test]
fn partial_basis_permissions_never_replace_destination_authority() {
	use std::os::unix::fs::PermissionsExt;
	for compat in [0, CF_INPLACE_PARTIAL_DIR] {
		for (dest_mode, partial_mode, source_mode, executability, want_mode) in [
			(Some(0o600), 0o644, 0o666, false, 0o600),
			(None, 0o777, 0o666, false, 0o644),
			(Some(0o600), 0o644, 0o755, true, 0o700),
		] {
			let mut o = opts();
			o.preserve_perms = false;
			o.keep_partial = true;
			o.partial_dir = Some("pdir".into());
			let proto = Proto { version: 33, compat };
			let mut fx = Fixture::new(o, proto, SEED);
			fx.ctx.meta.executability = executability;
			if let Some(mode) = dest_mode {
				std::fs::write(fx.path("f"), b"private-old").unwrap();
				std::fs::set_permissions(fx.path("f"), std::fs::Permissions::from_mode(mode)).unwrap();
			}
			std::fs::create_dir(fx.path("pdir")).unwrap();
			std::fs::write(fx.path("pdir/f"), b"0123456789").unwrap();
			std::fs::set_permissions(fx.path("pdir/f"), std::fs::Permissions::from_mode(partial_mode)).unwrap();
			let flists = flists_of(vec![entry("f", 15, 0o100_000 | source_mode, 1_400_000_000)]);
			let trees = fx.trees();
			let (result, _) = fx.run(&trees, &flists, partial_basis_stream(proto));
			result.unwrap();
			assert_eq!(std::fs::read(fx.path("f")).unwrap(), b"0123456789abcde");
			assert_eq!(mode_of(&fx.path("f")), want_mode, "compat={compat}, dest={dest_mode:?}, exec={executability}");
			assert!(!fx.path("pdir/f").exists());
			assert!(!fx.ctx.logger.got_xfer_error(), "{}", fx.messages());
		}
	}
}

#[cfg(unix)]
#[test]
fn metadata_only_large_xattr_update_preserves_private_destination_mode() {
	use std::os::unix::fs::PermissionsExt;
	use crate::rsync::xattr::{XattrSender, XattrSet};
	let mut o = opts();
	o.preserve_perms = false;
	o.preserve_xattrs = 1;
	let mut fx = Fixture::new(o, P33, SEED);
	fx.ctx.meta.xattrs = true;
	std::fs::write(fx.path("f"), b"data").unwrap();
	std::fs::set_permissions(fx.path("f"), std::fs::Permissions::from_mode(0o600)).unwrap();
	let trees = fx.trees();
	let name = if xattr::LINUX_XATTRS { b"user.rsynctest.receiver".to_vec() } else { b"rsynctest.receiver".to_vec() };
	trees.dest.set_xattr(Path::new("f"), &bytes_os_lossy(&name), &[b'o'; 64], false).unwrap();
	let wanted = XattrSet { items: vec![(name.clone(), vec![b'n'; 64])], ..XattrSet::default() };
	let mut sender = XattrSender::new();
	let mut wire = Vec::new();
	let snd_ndx = sender.send_indexed(&mut wire, &wanted, P33).unwrap();
	let fr = FlistReceiver::new(&fx.ctx, None);
	let cache = fr.xattrs();
	let mut cache = lock(&cache);
	let rx_ndx = cache.recv_named(&mut Cursor::new(wire), P33, b"f").unwrap();
	assert!(cache.diff(Some(rx_ndx), None, true));
	let mut request = Vec::new();
	assert!(cache.request_missing(&mut request, rx_ndx, 0).unwrap());
	drop(cache);
	let mut answer = Vec::new();
	sender.answer_request_at(&mut Cursor::new(request), &mut answer, Some(snd_ndx), &wanted, b"f", None).unwrap();
	let mut file = entry("f", 4, 0o100_644, mtime_of(&fx.path("f")));
	file.xattr = Some(rx_ndx);
	let flists = flists_of(vec![file]);
	let out = MuxWriter::new(Box::new(io::sink()), fx.ctx.counters.clone(), WriteConfig::default());
	let (sib, _) = crate::rsync::generator::sib_pipe(&flists, false);
	let mut receiver = Receiver::new(&fx.ctx, &trees, &flists, &out, &sib, &fr, None);
	let mut input = MuxReader::new(Box::new(Cursor::new(answer)), fx.ctx.counters.clone(), fx.ctx.cancel.clone(), ReadConfig::default());
	receiver.recv_one(&mut input, Item { ndx: 0, iflags: ITEM_REPORT_XATTR, ftype: FNAMECMP_FNAME, xname: None }).unwrap();
	assert_eq!(trees.dest.get_xattr(Path::new("f"), &bytes_os_lossy(&name), false).unwrap(), Some(vec![b'n'; 64]));
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), b"data");
	assert_eq!(mode_of(&fx.path("f")), 0o600);
	assert!(!fx.ctx.logger.got_xfer_error(), "{}", fx.messages());
}

#[cfg(unix)]
#[test]
fn restrictive_permissions_survive_same_filesystem_temporary_install() {
	use std::os::unix::fs::PermissionsExt;
	for mode in [0, 0o200, 0o400] {
		let fx = Fixture::new(opts(), P33, SEED);
		let flists = flists_of(vec![entry("f", 7, 0o100_000 | mode, 0)]);
		let trees = fx.trees();
		let mut s = Stream::new(Compress::None);
		s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"payload")], &md5(SEED, &[b"payload"]));
		s.done().done().done();
		let (result, _) = fx.run(&trees, &flists, s.take());
		result.unwrap();
		let installed_mode = mode_of(&fx.path("f"));
		std::fs::set_permissions(fx.path("f"), std::fs::Permissions::from_mode(0o600)).unwrap();
		assert_eq!(installed_mode, mode);
		assert_eq!(std::fs::read(fx.path("f")).unwrap(), b"payload");
		assert_eq!(dir_names(fx.dir.path()), ["f"]);
		assert!(!fx.ctx.logger.got_xfer_error(), "{}", fx.messages());
	}
}

#[cfg(unix)]
#[test]
#[ignore = "requires unprivileged UID and RSYNC_RECEIVER_EXDEV_ROOT on a separate filesystem"]
fn restrictive_permissions_survive_cross_filesystem_temporary_install() {
	use std::os::unix::fs::{MetadataExt, PermissionsExt};
	// SAFETY: geteuid has no preconditions.
	assert_ne!(unsafe { libc::geteuid() }, 0, "run this qualification as an unprivileged user");
	let root = std::env::var_os("RSYNC_RECEIVER_EXDEV_ROOT").expect("set a writable private separate-filesystem fixture root");
	for mode in [0, 0o200, 0o400] {
		let tmp = tempfile::TempDir::new_in(&root).unwrap();
		let mut o = opts();
		o.remove_source_files = 1;
		o.tmpdir = Some(tmp.path().as_os_str().to_owned());
		let fx = Fixture::new(o, P33, SEED);
		assert_ne!(std::fs::metadata(fx.dir.path()).unwrap().dev(), std::fs::metadata(tmp.path()).unwrap().dev(), "fixture must force real EXDEV");
		let mut trees = fx.trees();
		trees.temp_dir = Some(Tree::open(&fx.ctx.fs, tmp.path(), &TreeOpts::default()).unwrap());
		let flists = flists_of(vec![entry("f", 7, 0o100_000 | mode, 0)]);
		let mut s = Stream::new(Compress::None);
		s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"payload")], &md5(SEED, &[b"payload"]));
		s.done().done().done();
		let (result, sib) = fx.run(&trees, &flists, s.take());
		result.unwrap();
		let installed_mode = mode_of(&fx.path("f"));
		std::fs::set_permissions(fx.path("f"), std::fs::Permissions::from_mode(0o600)).unwrap();
		assert_eq!(installed_mode, mode, "{}", fx.messages());
		assert_eq!(std::fs::read(fx.path("f")).unwrap(), b"payload");
		assert_eq!(sib, [Sibling::Success(0), Sibling::Done, Sibling::Done]);
		assert!(!fx.ctx.logger.got_xfer_error(), "{}", fx.messages());
		assert!(dir_names(tmp.path()).is_empty());
	}
}

#[test]
fn missing_batch_update_releases_source_removal_request_except_in_dry_run() {
	for dry_run in [false, true] {
		let mut o = opts();
		o.remove_source_files = 1;
		o.dry_run = dry_run;
		o.do_xfers = !dry_run;
		let fx = Fixture::new(o, P33, SEED);
		std::fs::write(fx.path("missing"), b"untouched").unwrap();
		let flists = flists_of(vec![entry("missing", 9, 0o100_644, 0), entry("ok", 4, 0o100_644, 0)]);
		let trees = fx.trees();
		let mut s = Stream::new(Compress::None);
		s.file(1, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"good")], &md5(SEED, &[b"good"]));
		s.done().done().done();
		let mut batch = Vec::new();
		for ndx in [0, 1, -1] {
			batch.write_int(ndx).unwrap();
		}
		let mut batch = Cursor::new(batch);
		let mut fr = FlistReceiver::new(&fx.ctx, None);
		let mut input = MuxReader::new(
			Box::new(Cursor::new(s.take())),
			fx.ctx.counters.clone(),
			fx.ctx.cancel.clone(),
			ReadConfig::default(),
		);
		let out = MuxWriter::new(Box::new(io::sink()), fx.ctx.counters.clone(), WriteConfig::default());
		let (sib_out, sib_in) = crate::rsync::generator::sib_pipe(&flists, false);
		run_batch(&fx.ctx, &trees, &flists, &mut fr, &mut input, &out, &sib_out, Some(&mut batch)).unwrap();
		sib_out.flush_all();
		let statuses: Vec<_> = sib_in.drain().into_iter().filter(|s| !matches!(s, Sibling::List | Sibling::ListEof)).collect();
		let expected = if dry_run {
			vec![Sibling::Done, Sibling::Done]
		} else {
			vec![Sibling::NoSend(0), Sibling::Success(1), Sibling::Done, Sibling::Done]
		};
		assert_eq!(statuses, expected, "dry_run={dry_run}");
		assert_eq!(std::fs::read(fx.path("missing")).unwrap(), b"untouched");
		if dry_run {
			assert!(!fx.path("ok").exists());
		} else {
			assert_eq!(std::fs::read(fx.path("ok")).unwrap(), b"good");
		}
		assert!(fx.ctx.logger.got_xfer_error());
	}
}
