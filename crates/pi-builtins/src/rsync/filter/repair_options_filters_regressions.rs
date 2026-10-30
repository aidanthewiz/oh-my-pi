use super::*;

#[test]
fn ancestor_rules_survive_distinct_root_visits_without_local_leaks() {
	for roots in [[b"a".as_slice(), b"b".as_slice()], [b"b".as_slice(), b"a".as_slice()]] {
		let mut filters = Filters::new(FilterConfig { am_sender: true, ..FilterConfig::default() });
		filters.set_curr_dir(b"/synthetic/src");
		filters.add(RuleArg::Filter(b": /.rsync-filter"), &|_| Ok(Vec::new())).unwrap();
		let read = |path: &[u8]| -> io::Result<Option<Vec<u8>>> {
			Ok(match path {
				b".rsync-filter" => Some(b"- secret.dat\n".to_vec()),
				b"a/.rsync-filter" => Some(b"- only-a.dat\n".to_vec()),
				b"/synthetic/other/.rsync-filter" => Some(b"- other-secret.dat\n".to_vec()),
				_ => None,
			})
		};
		for root in roots {
			let mark = filters.enter_dir(root, &read).unwrap();
			assert_eq!(filters.check(b"secret.dat", false, Side::Sender), Verdict::Exclude);
			let local = if root == b"a" { Verdict::Exclude } else { Verdict::NoMatch };
			assert_eq!(filters.check(b"only-a.dat", false, Side::Sender), local);
			assert_eq!(filters.check(b"public.dat", false, Side::Sender), Verdict::NoMatch);
			let nested = filters.enter_dir(&[root, b"/nested"].concat(), &read).unwrap();
			assert_eq!(filters.check(b"secret.dat", false, Side::Sender), Verdict::Exclude);
			assert_eq!(filters.check(b"only-a.dat", false, Side::Sender), local);
			filters.leave_dir(nested);
			filters.leave_dir(mark);
			assert_eq!(filters.check(b"secret.dat", false, Side::Sender), Verdict::NoMatch);
			assert_eq!(filters.check(b"only-a.dat", false, Side::Sender), Verdict::NoMatch);
		}
		let other = filters.enter_dir(b"/synthetic/other/child", &read).unwrap();
		assert_eq!(filters.check(b"other-secret.dat", false, Side::Sender), Verdict::Exclude);
		assert_eq!(filters.check(b"secret.dat", false, Side::Sender), Verdict::NoMatch);
		filters.leave_dir(other);
	}
}

#[test]
fn receiver_only_cvs_container_does_not_police_sender_names() {
	for independent_sender_rule in [false, true] {
		let mut filters = Filters::new(FilterConfig::default());
		filters.add(RuleArg::Filter(b"-rC"), &|_| Ok(Vec::new())).unwrap();
		if independent_sender_rule {
			filters.add(RuleArg::Filter(b"-sC"), &|_| Ok(Vec::new())).unwrap();
		}
		filters.send(&mut Vec::new(), Proto::new(33, 0), true).unwrap();
		let sender = if independent_sender_rule { Verdict::Exclude } else { Verdict::NoMatch };
		assert_eq!(filters.check(b"a.o", false, Side::Sender), sender);
		assert_eq!(filters.check(b"a.o", false, Side::Receiver), Verdict::Exclude);
		assert_eq!(filters.check(b"b.c", false, Side::Sender), Verdict::NoMatch);
		assert_eq!(filters.check(b"b.c", false, Side::Receiver), Verdict::NoMatch);
	}
}
