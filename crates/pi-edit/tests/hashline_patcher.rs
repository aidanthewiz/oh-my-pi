mod common;

use pi_edit::{EditMode, ModeEngine, modes::hashline::HashlineEngine, stream_json::ArgSnapshot};
use serde_json::json;

#[tokio::test]
async fn patcher_apply_cases() {
	common::run_fixture("hashline/patcher.json", EditMode::Hashline).await;
}

#[test]
fn matcher_paths_accept_partial_sections_and_header_noise() {
	let engine = HashlineEngine { enforce_seen_lines: false, max_columns: 512 };
	let inspected = engine.inspect(&ArgSnapshot {
		input: Some(
			"[one.ts#ABCD]\nPUT 1.=1:\n+one\n[*** Update File: dir with spaces/two.ts#1234]\nPUT \
			 2.=2:\n+two"
				.into(),
		),
		..ArgSnapshot::default()
	});
	assert_eq!(inspected.paths, ["one.ts", "dir with spaces/two.ts"]);
	assert_eq!(inspected.entries, [
		("one.ts".into(), "one".into()),
		("dir with spaces/two.ts".into(), "two".into())
	]);
}

#[tokio::test]
async fn identical_noop_escalates_on_third_attempt() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "same\n");
	let tag = workspace.snapshot("a.txt", "same\n", None);
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+same") });
	for _ in 0..2 {
		let outcome = workspace
			.apply_json(&args, &common::DiskWriter::default())
			.await
			.expect("soft no-op");
		assert!(outcome.text.contains("produced no change"));
	}
	let error = workspace
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("third no-op must fail");
	assert!(
		error
			.to_string()
			.starts_with("STOP. Edits to a.txt have been a byte-identical no-op 3 times in a row")
	);
	assert_eq!(error.kind(), "no_change");
}

fn numbered_lines(count: u32) -> String {
	(1..=count)
		.map(|n| format!("line {n}\n"))
		.collect::<Vec<_>>()
		.concat()
}

/// Send `input`, expect a mismatch reply, and return it with the current tag
/// it names.
async fn mismatch_reply(workspace: &common::Workspace, input: &str) -> (String, String) {
	const CURRENT: &str = "current file hashes to #";
	let error = workspace
		.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
		.await
		.expect_err("unknown tag must be rejected")
		.to_string();
	let at = error.find(CURRENT).expect("reply names the current tag") + CURRENT.len();
	let tag = error[at..at + 4].to_owned();
	(error, tag)
}

async fn mismatch_tag(workspace: &common::Workspace, input: &str) -> String {
	mismatch_reply(workspace, input).await.1
}

#[tokio::test]
async fn mismatch_rows_require_an_explicit_read_before_they_authorize_writes() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(30);
	workspace.write("a.txt", &text);
	let tag = mismatch_tag(&workspace, "[a.txt#0000]\nPUT 5.=5:\n+X\n").await;

	let writer = common::DiskWriter::default();
	let error = workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+Y\n") }), &writer)
		.await
		.expect_err("line 20 was never displayed")
		.to_string();
	assert!(error.contains("never displayed"), "{error}");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").as_deref(), Some(text.as_str()));

	for _ in 0..2 {
		workspace
			.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 7.=7:\n+Z\n") }), &writer)
			.await
			.expect_err("an error reveal is not a delivered read");
	}
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").as_deref(), Some(text.as_str()));
	workspace.snapshot("a.txt", &text, Some(&[7]));
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 7.=7:\n+Z\n") }), &writer)
		.await
		.expect("the explicit read displayed line 7");
	assert!(
		workspace
			.read("a.txt")
			.unwrap()
			.contains("line 6\nZ\nline 8\n")
	);
}

#[tokio::test]
async fn mismatch_reply_keeps_the_provenance_of_recorded_content() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(30);
	workspace.write("a.txt", &text);
	let read: Vec<u32> = (1..=30).collect();
	let tag = workspace.snapshot("a.txt", &text, Some(&read));
	assert_eq!(mismatch_tag(&workspace, "[a.txt#0000]\nPUT 5.=5:\n+X\n").await, tag);
	workspace
		.apply_json(
			&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+Y\n") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect("the earlier read displayed line 20");
}

/// The tag an edit response header hands back.
fn response_tag(text: &str) -> String {
	let at = text.find('#').expect("response header carries a tag") + 1;
	text[at..at + 4].to_owned()
}

#[tokio::test]
async fn rows_an_edit_wrote_are_displayed_for_the_next_edit() {
	// #19091: an eight-row insert used to collapse to `…` and hide line 7.
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(6);
	workspace.write("h.txt", &text);
	let tag = workspace.snapshot("h.txt", &text, Some(&(1..=6).collect::<Vec<_>>()));
	let body = ('a'..='h')
		.map(|c| format!("+new {c}\n"))
		.collect::<Vec<_>>()
		.concat();
	let writer = common::DiskWriter::default();
	let outcome = workspace
		.apply_json(&json!({ "input": format!("[h.txt#{tag}]\nPUT >3:\n{body}") }), &writer)
		.await
		.expect("insert applies");
	assert!(outcome.text.contains("\n7:new d\n"), "{}", outcome.text);
	let tag = response_tag(&outcome.text);
	workspace
		.apply_json(&json!({ "input": format!("[h.txt#{tag}]\nPUT 7.=7:\n+new D\n") }), &writer)
		.await
		.expect("the response displayed line 7");
	assert!(
		workspace
			.read("h.txt")
			.unwrap()
			.contains("new c\nnew D\nnew e\n")
	);
}

#[tokio::test]
async fn lines_read_before_an_outside_change_stay_seen_where_unchanged() {
	// #19092: a formatter or other writer changes line 50; a partial re-read
	// must not forget line 5, which kept its number and content.
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(60);
	workspace.write("f.txt", &text);
	workspace.snapshot("f.txt", &text, Some(&(1..=60).collect::<Vec<_>>()));
	let changed = text.replace("line 50\n", "line FIFTY\n");
	workspace.write("f.txt", &changed);
	let tag = workspace.snapshot("f.txt", &changed, Some(&(47..=55).collect::<Vec<_>>()));
	workspace
		.apply_json(
			&json!({ "input": format!("[f.txt#{tag}]\nPUT 5.=5:\n+line FIVE\n") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect("line 5 was read and is unchanged");
	assert!(
		workspace
			.read("f.txt")
			.unwrap()
			.contains("line 4\nline FIVE\nline 6\n")
	);
}

#[tokio::test]
async fn repeated_mismatch_errors_do_not_expand_read_authority() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(30);
	workspace.write("a.txt", &text);
	mismatch_tag(&workspace, "[a.txt#0000]\nPUT 5.=5:\n+X\n").await;
	let tag = mismatch_tag(&workspace, "[a.txt#0000]\nPUT 20.=20:\n+X\n").await;
	let writer = common::DiskWriter::default();
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 12.=12:\n+Y\n") }), &writer)
		.await
		.expect_err("neither reply displayed line 12");
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+Y\n") }), &writer)
		.await
		.expect_err("the error may have been suppressed");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").as_deref(), Some(text.as_str()));
	workspace.snapshot("a.txt", &text, Some(&[20]));
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+Y\n") }), &writer)
		.await
		.expect("an explicit read displayed line 20");
	assert_eq!(
		workspace.read("a.txt").as_deref(),
		Some(text.replacen("line 20\n", "Y\n", 1).as_str())
	);
}

#[tokio::test]
async fn a_complete_wide_error_row_does_not_replace_read_authority() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let wide = format!("{}TAIL", "x".repeat(600));
	let text = format!("{}{wide}\n{}", numbered_lines(10), numbered_lines(10));
	workspace.write("a.txt", &text);
	let (error, tag) = mismatch_reply(&workspace, "[a.txt#0000]\nPUT 11.=11:\n+y\n").await;
	assert!(error.contains(&format!("*11:{wide}")), "the reply prints the whole row");
	let writer = common::DiskWriter::default();
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 18.=18:\n+z\n") }), &writer)
		.await
		.expect_err("line 18 was not displayed");
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 11.=11:\n+y\n") }), &writer)
		.await
		.expect_err("a full error row is not proof of delivery");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").as_deref(), Some(text.as_str()));
	workspace.snapshot("a.txt", &text, Some(&[11]));
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 11.=11:\n+y\n") }), &writer)
		.await
		.expect("an explicit read displayed the full wide row");
	assert_eq!(workspace.read("a.txt").as_deref(), Some(text.replacen(&wide, "y", 1).as_str()));
}

#[tokio::test]
async fn mismatch_reply_with_no_rows_leaves_every_line_unseen() {
	// The file shrank below the stale anchor: the reply prints no rows, yet
	// hands back the current tag.
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(20);
	workspace.write("a.txt", &text);
	let (error, tag) = mismatch_reply(&workspace, "[a.txt#0000]\nPUT 25.=25:\n+X\n").await;
	assert!(!error.contains(":line "), "{error}");
	let writer = common::DiskWriter::default();
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nPUT 10.=10:\n+Y\n") }), &writer)
		.await
		.expect_err("the reply displayed no line");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").as_deref(), Some(text.as_str()));
}

#[test]
fn streaming_preview_keeps_completed_section_when_trailing_header_arrives() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	workspace.write("b.txt", "b\n");
	let tag_a = workspace.snapshot("a.txt", "a\n", None);
	let tag_b = workspace.snapshot("b.txt", "b\n", None);
	let input = format!("[a.txt#{tag_a}]\nPUT 1.=1:\n+A\n[b.txt#{tag_b}]");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": input }).to_string());
	let batch = session.preview();
	assert!(batch.streaming);
	assert_eq!(batch.files.len(), 1);
	assert_eq!(batch.files[0].display, "a.txt");
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("+1|A"))
	);
}

#[tokio::test]
async fn rejection_names_the_path_a_foreign_tag_was_issued_for() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let worktree = workspace.write("wt/crates/a/mcp.rs", "worktree\n");
	workspace.write("crates/a/mcp.rs", "parent\n");
	let tag = workspace.snapshot("wt/crates/a/mcp.rs", "worktree\n", None);
	let writer = common::DiskWriter::default();
	let input = format!("[crates/a/mcp.rs#{tag}]\nPUT 1.=1:\n+changed\n");
	let error = workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect_err("foreign tag must be rejected")
		.to_string();
	let origin = pi_edit::path_policy::canonical_key(&worktree);
	assert!(
		error.contains(&format!("Hash #{tag} was issued in this session for {}.", origin.display())),
		"{error}"
	);
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("crates/a/mcp.rs").as_deref(), Some("parent\n"));
	assert_eq!(workspace.read("wt/crates/a/mcp.rs").as_deref(), Some("worktree\n"));
}

async fn refusal_kind(workspace: &common::Workspace, input: &str) -> &'static str {
	workspace
		.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
		.await
		.expect_err(input)
		.kind()
}

#[tokio::test]
async fn each_refusal_carries_the_kind_of_check_that_made_it() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let text = numbered_lines(30);
	workspace.write("a.txt", &text);
	let shown = workspace.snapshot("a.txt", &text, Some(&[1, 2, 3]));
	workspace.write("b.txt", "old\n");
	let stale = workspace.snapshot("b.txt", "old\n", None);
	workspace.write("b.txt", "new\n");
	for (input, kind) in [
		(format!("[a.txt#{shown}]\nPUT 20.=20:\n+X\n"), "unseen_lines"),
		(format!("[b.txt#{stale}]\nPUT 1.=1:\n+X\n"), "stale_tag"),
		(format!("[b.txt#{shown}]\nPUT 1.=1:\n+X\n"), "other_file_tag"),
		("[a.txt#0000]\nPUT 1.=1:\n+X\n".into(), "unknown_tag"),
		("[a.txt]\nPUT 1.=1:\n+X\n".into(), "missing_tag"),
		(format!("[a.txt#{shown}]\n"), "header_only"),
		("[new.txt]\nPUT 1.=1:\n+X\n".into(), "file_not_found"),
		("PUT 1.=1:\n+X\n".into(), "parse"),
	] {
		assert_eq!(refusal_kind(&workspace, &input).await, kind, "{input}");
	}
}

#[tokio::test]
async fn anchors_past_the_end_are_out_of_range_for_puts_cuts_and_pastes() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "one\ntwo\n");
	let tag = workspace.snapshot("a.txt", "one\ntwo\n", None);
	for ops in ["PUT 99.=99:\n+X\n", "CUT 99\n", "CUT 1 @x\nPUT 99.=99 @x\n"] {
		assert_eq!(
			refusal_kind(&workspace, &format!("[a.txt#{tag}]\n{ops}")).await,
			"out_of_range",
			"{ops}"
		);
	}
	assert_eq!(workspace.read("a.txt").as_deref(), Some("one\ntwo\n"));
}

const UNTAGGED_TEXT: &str = "alpha\nbeta\ngamma\n";

#[tokio::test]
async fn untagged_sections_get_the_current_tag_like_an_unknown_one() {
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	for header in ["a.txt#AUTO", "a.txt#????", "a.txt#", "a.txt#PLACEHOLDER", "a.txt"] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.txt", UNTAGGED_TEXT);
		let writer = common::DiskWriter::default();
		let error = workspace
			.apply_json(&json!({ "input": format!("[{header}]\nPUT 2.=2:\n+BETA\n") }), &writer)
			.await
			.expect_err("an untagged section must not apply")
			.to_string();
		assert!(
			error.contains(&format!("the header needs this file's current tag, #{current}.")),
			"{header}: {error}"
		);
		assert!(
			error.contains(&format!("The current file hashes to #{current}.")),
			"{header}: {error}"
		);
		assert!(error.contains("*2:beta"), "{header}: {error}");
		assert!(writer.requests.lock().is_empty(), "{header}");
		assert_eq!(workspace.read("a.txt").as_deref(), Some(UNTAGGED_TEXT), "{header}");

		// The returned tag is enough to apply the same body without a read.
		workspace
			.apply_json(&json!({ "input": format!("[a.txt#{current}]\nPUT 2.=2:\n+BETA\n") }), &writer)
			.await
			.expect("resend with the returned tag");
		assert_eq!(workspace.read("a.txt").as_deref(), Some("alpha\nBETA\ngamma\n"), "{header}");
	}
}

#[tokio::test]
async fn untagged_head_and_tail_inserts_do_not_apply() {
	// An unknown hex tag lets a `PUT >$:` through with a drift warning; a
	// section with no tag at all never applies.
	for header in ["a.txt#AUTO", "a.txt"] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.txt", UNTAGGED_TEXT);
		let error = workspace
			.apply_json(
				&json!({ "input": format!("[{header}]\nPUT >$:\n+delta\n") }),
				&common::DiskWriter::default(),
			)
			.await
			.expect_err("an untagged append must not apply")
			.to_string();
		assert!(error.contains("the header needs this file's current tag"), "{header}: {error}");
		assert_eq!(workspace.read("a.txt").as_deref(), Some(UNTAGGED_TEXT), "{header}");
	}
}

#[tokio::test]
async fn header_only_input_gets_the_current_tag() {
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	for header in [
		"[a.txt#AUTO]",
		"[a.txt#0000]",
		"[a.txt]",
		&format!("[a.txt#{current}]"),
		"\u{feff}[a.txt#AUTO]",
		&format!("\u{feff}[a.txt#{current}]"),
	] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.txt", UNTAGGED_TEXT);
		let writer = common::DiskWriter::default();
		let error = workspace
			.apply_json(&json!({ "input": format!("{header}\n") }), &writer)
			.await
			.expect_err("a header with no ops must not apply")
			.to_string();
		assert!(
			error.starts_with(&format!(
				"Edit rejected for a.txt: no ops follow the header; put them under this file's \
				 current tag, #{current}."
			)),
			"{header}: {error}"
		);
		assert!(writer.requests.lock().is_empty(), "{header}");
	}
}

#[tokio::test]
async fn header_only_reply_records_nothing_so_the_resend_meets_the_unread_guard() {
	// The reply shows no rows, so it records no snapshot: a resend under its
	// tag gets the guard a tag with no retained read gets, which applies short
	// lines and rejects one that may have been shown cut.
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let wide = "x".repeat(600);
	let text = format!("alpha\n{wide}\ngamma\n");
	workspace.write("a.txt", &text);
	let current = pi_edit::store::file_hash(&text);
	let writer = common::DiskWriter::default();
	workspace
		.apply_json(&json!({ "input": "[a.txt#AUTO]\n" }), &writer)
		.await
		.expect_err("a header with no ops must not apply");
	let error = workspace
		.apply_json(&json!({ "input": format!("[a.txt#{current}]\nPUT 2.=2:\n+y\n") }), &writer)
		.await
		.expect_err("a wide line no read showed whole")
		.to_string();
	assert!(error.contains("no retained read shows them in full"), "{error}");
	assert!(writer.requests.lock().is_empty());
	workspace
		.apply_json(&json!({ "input": format!("[a.txt#{current}]\nPUT 1.=1:\n+ALPHA\n") }), &writer)
		.await
		.expect("a short line applies under the returned tag");
	assert_eq!(workspace.read("a.txt").unwrap(), format!("ALPHA\n{wide}\ngamma\n"));
}

#[tokio::test]
async fn placeholder_section_does_not_borrow_a_same_path_tag() {
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	for placeholder in ["AUTO", "????", ""] {
		for input in [
			format!("[a.txt#{placeholder}]\nPUT 1.=1:\n+A\n[a.txt#{current}]\nPUT 2.=2:\n+B\n"),
			format!("[a.txt#{current}]\nPUT 1.=1:\n+A\n[a.txt#{placeholder}]\nPUT 2.=2:\n+B\n"),
		] {
			let workspace = common::Workspace::new(EditMode::Hashline);
			workspace.write("a.txt", UNTAGGED_TEXT);
			let writer = common::DiskWriter::default();
			let error = workspace
				.apply_json(&json!({ "input": input }), &writer)
				.await
				.expect_err("a placeholder section must not apply under another header's tag")
				.to_string();
			assert!(
				error.contains(&format!("the header needs this file's current tag, #{current}.")),
				"{input}: {error}"
			);
			assert!(writer.requests.lock().is_empty(), "{input}");
			assert_eq!(workspace.read("a.txt").as_deref(), Some(UNTAGGED_TEXT), "{input}");
		}
	}
}

#[tokio::test]
async fn untagged_section_for_a_missing_file_points_at_write() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	for input in
		["[new.txt#AUTO]\nPUT 1.=1:\n+x\n", "[new.txt]\nPUT 1.=1:\n+x\n", "[new.txt#????]\n"]
	{
		let error = workspace
			.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
			.await
			.expect_err("missing file")
			.to_string();
		assert_eq!(
			error, "File not found: new.txt. Use the write tool to create new files.",
			"{input}"
		);
	}
}

#[test]
fn completed_preview_surfaces_the_current_tag_for_an_untagged_section() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", UNTAGGED_TEXT);
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": "[a.txt#AUTO]\nPUT 1.=1:\n+A\n" }).to_string());
	session.finish();
	let batch = session.preview();
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	let error = batch.files[0].error.as_deref().unwrap_or_default();
	assert!(error.contains(&format!("The current file hashes to #{current}.")), "{error}");
}

#[tokio::test]
async fn recovered_rem_reports_authored_and_deleted_paths() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let target = workspace.write("correct/target.ts", "const value = 1;\n");
	let tag = workspace.snapshot("correct/target.ts", "const value = 1;\n", None);
	let input = format!("[wrong/target.ts#{tag}]\nREM\n");
	let outcome = workspace
		.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
		.await
		.expect("recovered delete");

	assert!(!target.exists());
	let deleted = pi_edit::path_policy::canonical_key(&target);
	assert!(
		outcome
			.text
			.contains(&format!("Deleted {}", deleted.display())),
		"{}",
		outcome.text
	);
	assert!(
		outcome.text.contains(&format!(
			"Warnings:\nPath \"wrong/target.ts\" does not exist; matched its filename and snapshot \
			 tag #{tag} to {}",
			deleted.display()
		)),
		"{}",
		outcome.text
	);
}

#[test]
fn completed_preview_surfaces_stale_hash_error() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": "[a.txt#FFFF]\nPUT 1.=1:\n+A\n" }).to_string());
	session.finish();
	let batch = session.preview();
	assert!(!batch.streaming);
	assert!(
		batch.files[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("not from this session"))
	);
}

#[tokio::test]
async fn file_ops_reject_a_tag_that_does_not_match_the_file() {
	for op in ["REM", "MV b.txt"] {
		for recorded in [false, true] {
			let workspace = common::Workspace::new(EditMode::Hashline);
			workspace.write("a.txt", "current\n");
			let tag = if recorded {
				workspace.snapshot("a.txt", "old\n", None)
			} else {
				"0000".to_owned()
			};
			assert_ne!(tag, pi_edit::store::file_hash("current\n"));
			let writer = common::DiskWriter::default();
			let error = workspace
				.apply_json(&json!({ "input": format!("[a.txt#{tag}]\n{op}\n") }), &writer)
				.await
				.expect_err("a file op under a non-matching tag must be rejected")
				.to_string();
			let reason = if recorded {
				"file changed between read and edit"
			} else {
				"not from this session"
			};
			assert!(error.contains(reason), "{op} recorded={recorded}: {error}");
			assert!(writer.requests.lock().is_empty());
			assert_eq!(workspace.read("a.txt").as_deref(), Some("current\n"));
			assert_eq!(workspace.read("b.txt"), None);
		}
	}
}

#[tokio::test]
async fn head_insert_still_applies_across_a_stale_tag() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "current\n");
	let tag = workspace.snapshot("a.txt", "old\n", None);
	let outcome = workspace
		.apply_json(
			&json!({ "input": format!("[a.txt#{tag}]\nPUT <1:\n+head\nMV b.txt\n") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect("head insert is content-independent");
	assert_eq!(workspace.read("a.txt"), None);
	assert_eq!(workspace.read("b.txt").as_deref(), Some("head\ncurrent\n"));
	assert!(outcome.text.contains("despite a stale snapshot tag"), "{}", outcome.text);
}

#[tokio::test]
async fn undecodable_rem_rejects_invented_and_previously_valid_tags_without_writes() {
	for recorded in [false, true] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		let path = workspace.write("a.txt", "previously readable\n");
		let tag = if recorded {
			workspace.snapshot("a.txt", "previously readable\n", Some(&[1]))
		} else {
			"0000".to_owned()
		};
		let original = b"current\xff\n";
		std::fs::write(&path, original).unwrap();
		let writer = common::DiskWriter::default();
		let error = workspace
			.apply_json(&json!({ "input": format!("[a.txt#{tag}]\nREM\n") }), &writer)
			.await
			.expect_err("undecodable bytes cannot validate the tag");
		assert!(error.is_invalid_utf8(), "{error}");
		assert!(writer.requests.lock().is_empty());
		assert_eq!(std::fs::read(&path).unwrap(), original);
	}
}

#[tokio::test]
async fn discarded_completed_previews_do_not_grant_write_provenance() {
	for header in ["a.txt#AUTO", "a.txt#0000"] {
		let mut workspace = common::Workspace::new(EditMode::Hashline);
		workspace.config.enforce_seen_lines = true;
		let text = numbered_lines(30);
		workspace.write("a.txt", &text);
		let tag = workspace.snapshot("a.txt", &text, Some(&[1]));
		assert_ne!(tag, "0000");
		let mut session = workspace.session();
		session.set_args_json(
			&json!({ "input": format!("[{header}]\nPUT 20.=20:\n+replacement\n") }).to_string(),
		);
		session.finish();
		let preview = session.preview();
		assert!(preview.files[0].error.is_some());
		let writer = common::DiskWriter::default();
		workspace
			.apply_json(
				&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+replacement\n") }),
				&writer,
			)
			.await
			.expect_err("a discarded preview never displayed line 20 to the caller");
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("a.txt").as_deref(), Some(text.as_str()));
	}
}

#[tokio::test]
async fn mismatch_context_bounds_never_promote_omitted_rows() {
	for wide in [false, true] {
		let mut workspace = common::Workspace::new(EditMode::Hashline);
		workspace.config.enforce_seen_lines = true;
		let text = if wide {
			format!("{}TAIL\n", "界".repeat(3000))
		} else {
			numbered_lines(100)
		};
		workspace.write("a.txt", &text);
		let input = if wide {
			"[a.txt#0000]\nPUT 1.=1:\n+replacement\n"
		} else {
			"[a.txt#0000]\nPUT 1.=100:\n+replacement\n"
		};
		let (error, tag) = mismatch_reply(&workspace, input).await;
		assert!(error.len() < 9 * 1024);
		assert!(!error.contains(if wide { "TAIL" } else { "90:line 90" }));
		let line = if wide { 1 } else { 90 };
		let writer = common::DiskWriter::default();
		workspace
			.apply_json(
				&json!({ "input": format!("[a.txt#{tag}]\nPUT {line}.={line}:\n+replacement\n") }),
				&writer,
			)
			.await
			.expect_err("an omitted row cannot gain write provenance");
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("a.txt").as_deref(), Some(text.as_str()));
	}
}

#[tokio::test]
async fn stale_recovery_cannot_write_rows_missing_from_its_restricted_snapshot() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let previous = numbered_lines(30);
	workspace.write("a.txt", &previous);
	let tag = workspace.snapshot("a.txt", &previous, Some(&[1]));
	let current = format!("external header\n{previous}");
	workspace.write("a.txt", &current);
	let writer = common::DiskWriter::default();
	workspace
		.apply_json(
			&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+replacement\n") }),
			&writer,
		)
		.await
		.expect_err("stale recovery must not bypass the snapshot's displayed rows");
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("a.txt").as_deref(), Some(current.as_str()));
}

#[tokio::test]
async fn trailing_comma_and_ambiguous_placement_rejections_preserve_file_bytes() {
	let list = "{\n  \"a\": [\n    \"x\",\n    \"y\"\n  ]\n}\n";
	for (before, body) in [
		(list, "    \"z\","),
		(list, "    \"z\",  \n+"),
		(list, "    \"z\",\u{a0}"),
		("{\n  \"a\": [\n    \"x\"\n  ],\n  \"b\": 1\n}\n", "  \"c\": 2,"),
	] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.json", before);
		let tag = workspace.snapshot("a.json", before, None);
		let writer = common::DiskWriter::default();
		workspace
			.apply_json(&json!({ "input": format!("[a.json#{tag}]\nPUT 4.=4:\n+{body}\n") }), &writer)
			.await
			.expect_err("invalid payload must not be repaired by silently dropping its comma");
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("a.json").as_deref(), Some(before));
	}
}

#[tokio::test]
async fn stale_recovery_preserves_authority_for_explicitly_read_rows() {
	let mut workspace = common::Workspace::new(EditMode::Hashline);
	workspace.config.enforce_seen_lines = true;
	let previous = numbered_lines(30);
	workspace.write("a.txt", &previous);
	let tag = workspace.snapshot("a.txt", &previous, Some(&[20]));
	workspace.write("a.txt", &format!("external header\n{previous}"));
	workspace
		.apply_json(
			&json!({ "input": format!("[a.txt#{tag}]\nPUT 20.=20:\n+replacement\n") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect("a fully read stale anchor can follow a uniform line shift");
	let expected =
		format!("external header\n{}", previous.replacen("line 20\n", "replacement\n", 1));
	assert_eq!(workspace.read("a.txt").as_deref(), Some(expected.as_str()));
}

#[tokio::test]
async fn refuses_a_short_body_that_restates_both_neighbours_and_applies_the_resend() {
	const PROBE: &str = "class Probe {\n\talive = true;\n\n\tconstructor() {}\n\n\tisAlive(): \
	                     boolean {\n\t\treturn this.alive;\n\t}\n}\n";
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("probe.ts", PROBE);
	let tag = workspace.snapshot("probe.ts", PROBE, None);
	let error = workspace
		.apply_json(
			&json!({
				"input": format!(
					"[probe.ts#{tag}]\nPUT 3.=5:\n+\talive = true;\n+\n+\tisAlive(): boolean {{\n"
				)
			}),
			&common::DiskWriter::default(),
		)
		.await
		.expect_err("a body too short between two echoes must not apply");
	assert_eq!(error.kind(), "ambiguous_boundary", "{error}");
	assert_eq!(workspace.read("probe.ts").as_deref(), Some(PROBE));
	workspace
		.apply_json(
			&json!({ "input": format!("[probe.ts#{tag}]\nPUT 3.=5:\n+\n") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect("the resend covers exactly the changed lines");
	assert_eq!(
		workspace.read("probe.ts").as_deref(),
		Some(
			"class Probe {\n\talive = true;\n\n\tisAlive(): boolean {\n\t\treturn \
			 this.alive;\n\t}\n}\n"
		)
	);
}

#[tokio::test]
async fn refuses_echo_shapes_that_lost_rows_and_leaves_the_file_unchanged() {
	const ROWS: &str = "x = 1\ny = 2\nz = 3\nw = 4\n";
	const MULTI: &str =
		"const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nfunction f() {\n\treturn 1;\n}\n";
	let cases = [
		("r.txt", ROWS, "PUT 2.=3:\n+x = 1\n+x = 1\n+Y = 2\n"),
		("m.ts", MULTI, "PUT 2.=3:\n+const a = 1;\n+const B = 2;\nPUT 6.=6:\n+\treturn 1;\n+}\n"),
	];
	for (path, text, ops) in cases {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write(path, text);
		let tag = workspace.snapshot(path, text, None);
		let error = workspace
			.apply_json(
				&json!({ "input": format!("[{path}#{tag}]\n{ops}") }),
				&common::DiskWriter::default(),
			)
			.await
			.expect_err(path);
		assert_eq!(error.kind(), "ambiguous_boundary", "{path}: {error}");
		assert_eq!(workspace.read(path).as_deref(), Some(text), "{path}");
	}
}

#[tokio::test]
async fn refuses_a_repair_whose_kept_row_hides_a_restated_copy() {
	const GRID: &str = "\t\t<div\n\t\t\tclassName=\"stat-grid \
	                    rise\"\n\t\t\tstyle={min}\n\t\t>\n\t\t\t{children}\n\t\t</div>\n";
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("Stat.tsx", GRID);
	let tag = workspace.snapshot("Stat.tsx", GRID, None);
	let error = workspace
		.apply_json(
			&json!({
				"input": format!(
					"[Stat.tsx#{tag}]\nPUT 2.=4:\n+\t\t\tclassName=\"stat-grid rise\"\n+\t\t\t{{children}}\n"
				)
			}),
			&common::DiskWriter::default(),
		)
		.await
		.expect_err("a repair that keeps a row must not hide the restated copy");
	assert_eq!(error.kind(), "ambiguous_boundary", "{error}");
	assert_eq!(workspace.read("Stat.tsx").as_deref(), Some(GRID));
}
