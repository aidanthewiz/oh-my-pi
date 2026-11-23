use super::*;
use crate::rsync::token::{Token, TokenDecoder};

fn reconstruct(stream: &[u8], basis: &[u8], head: SumHead) -> Vec<u8> {
	let mut decoder = TokenDecoder::new(Compress::None);
	let mut input = stream;
	let mut bytes = Vec::new();
	loop {
		match decoder.recv(&mut input).unwrap() {
			Token::Literal(data) => bytes.extend_from_slice(data),
			Token::Block(index) => {
				let at = index as usize * head.blength as usize;
				let len = head.block_len(index as i32) as usize;
				bytes.extend_from_slice(&basis[at..at + len]);
			},
			Token::End => break,
		}
	}
	assert!(input.is_empty());
	bytes
}

#[test]
fn rejected_realignment_preserves_source_bytes() {
	let ctx = test_ctx();
	let mut collision = vec![0u8; 700];
	collision[10..13].copy_from_slice(&[1, 254, 1]);
	let basis = [vec![2u8; 700], vec![3u8; 700], vec![0u8; 700], vec![0x7fu8; 700], collision.clone()].concat();
	let source = [vec![0x7fu8; 700], vec![5u8; 10], vec![0u8; 700], vec![1, 254, 1], vec![0u8; 687]].concat();
	let strong = Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto };
	assert_eq!(checksum::checksum1(&collision), checksum::checksum1(&vec![0u8; 700]));
	assert_ne!(strong.block(&collision), strong.block(&vec![0u8; 700]));
	let head = SumHead { count: 5, blength: 700, s2length: 16, remainder: 0 };
	for inplace in [false, true] {
		let mut sums = Sums::from_parts(
			head,
			basis.chunks(700).map(checksum::checksum1).collect(),
			basis.chunks(700).flat_map(|block| strong.block(block)).collect(),
		);
		sums.updating_basis = inplace;
		let mut enc = TokenEncoder::new(Compress::None, None);
		let mut stream = Vec::new();
		let mut digest = strong.file();
		match_file(&ctx, &sums, &mut source.as_slice(), source.len() as u64, &mut enc, &mut stream, &mut digest).unwrap();
		assert_eq!(reconstruct(&stream, &basis, head), source, "inplace={inplace}");
		let mut expected = strong.file();
		expected.update(&source);
		assert_eq!(digest.finish(), expected.finish());
	}
}

#[test]
fn append_verify_bounds_retention_and_hashes_prefix() {
	let ctx = test_ctx();
	let prefix = 3 << 20;
	let source = rand(87, prefix + 17);
	let mut sums = Sums::from_parts(
		SumHead::for_len(prefix as i64, 700, ctx.proto, 16), Vec::new(), Vec::new(),
	);
	sums.append_mode = 2;
	let strong = Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto };
	let mut digest = strong.file();
	let mut enc = TokenEncoder::new(Compress::None, None);
	let mut stream = Vec::new();
	let stats = match_file(&ctx, &sums, &mut source.as_slice(), source.len() as u64, &mut enc, &mut stream, &mut digest).unwrap();
	assert_eq!(stats.literal, 17);
	assert_eq!(reconstruct(&stream, &[], SumHead::default()), source[prefix..]);
	let mut expected = strong.file();
	expected.update(&source);
	assert_eq!(digest.finish(), expected.finish());
	assert!(stats.peak_window <= MAX_MAP_SIZE + CHUNK_SIZE, "retained {} bytes", stats.peak_window);
}

#[test]
fn zero_count_large_block_obeys_window_allocation_limit() {
	let mut ctx = test_ctx();
	ctx.proto = Proto::new(29, 0);
	let mut opts = (*ctx.opts).clone();
	opts.max_alloc = 1 << 20;
	ctx.opts = std::sync::Arc::new(opts);
	let header: Vec<u8> = [0i32, 512 << 10, 0, 0].into_iter().flat_map(i32::to_le_bytes).collect();
	let mut keepalive = || Ok(());
	let sums = Sums::read(&mut header.as_slice(), ctx.proto, 16, ctx.opts.max_alloc, 0, 0, &mut keepalive, &ctx.logger).unwrap();
	let strong = Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto };
	let short = vec![0x42u8; CHUNK_SIZE];
	let mut short_stream = Vec::new();
	match_file(&ctx, &sums, &mut short.as_slice(), CHUNK_SIZE as u64, &mut TokenEncoder::new(Compress::None, None), &mut short_stream, &mut strong.file()).unwrap();
	assert_eq!(reconstruct(&short_stream, &[], sums.head), short);
	let mut source = io::Cursor::new(vec![0x42u8; 2 << 20]);
	let mut enc = TokenEncoder::new(Compress::None, None);
	let mut stream = Vec::new();
	let err = match_file(&ctx, &sums, &mut source, 2 << 20, &mut enc, &mut stream, &mut strong.file()).unwrap_err();
	assert_eq!(err.code, exit::RERR_MALLOC);
	assert_eq!(source.position(), 0);
	assert!(stream.is_empty());
}
