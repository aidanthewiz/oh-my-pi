mod common;

use common::{DiskWriter, Workspace};
use omp_edit::{
	ApplyRequest, EditMode, FileOp, ModeEngine, files::FileCache, modes::sloppy::SloppyEngine,
	stream_json::ArgSnapshot,
};
use serde_json::json;

const BEFORE: &str =
	"alpha_header\nblock_start\nobsolete_row\nanchor_inside\nblock_end\nfile_tail\n";
const FIRST: (&str, &str) = ("alpha_header\nblock_start", "alpha_header\nkeep_one\nblock_start");
const MIDDLE: (&str, &str) = (
	"block_start\nobsolete_row\nanchor_inside\nblock_end",
	"block_start\nmiddle_new\nanchor_inside\nblock_end",
);
const LAST: (&str, &str) = ("anchor_inside\nblock_end", "anchor_inside\nkeep_three\nblock_end");

fn replacements(operations: &[(&str, &str)]) -> String {
	let mut input = String::from("*** Edit File: a.txt\n");
	for (find, replace) in operations {
		input.push_str(&format!("*** Find\n{find}\n*** Replace\n{replace}\n"));
	}
	input
}

async fn assert_session_result(before: &str, input: &str, expected: &str) {
	let workspace = Workspace::new(EditMode::Sloppy);
	let path = workspace.write("a.txt", before);
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": input }).to_string());
	session.finish();
	let preview = session.preview();

	let engine = SloppyEngine { allow_fuzzy: true, fuzzy_threshold: 0.95 };
	let mut files = FileCache::new(workspace.config.policy.clone());
	let args =
		ArgSnapshot { input: Some(input.to_owned()), complete: true, ..ArgSnapshot::default() };
	let staged = engine.stage(&args, &mut files, &workspace.store);
	assert_eq!(std::fs::read(&path).unwrap(), before.as_bytes(), "preview/stage mutated disk");

	let writer = DiskWriter::default();
	let outcome = session
		.apply(ApplyRequest::default(), &writer)
		.await
		.expect("every authored operation must apply");
	assert_eq!(std::fs::read(&path).unwrap(), expected.as_bytes(), "persisted bytes");
	let requests = writer.requests.lock();
	assert_eq!(requests.len(), 1, "one atomic file update");
	assert_eq!(requests[0].op, FileOp::Update);
	assert_eq!(requests[0].absolute, path);
	assert_eq!(requests[0].content.as_deref(), Some(expected), "exact writer payload");

	let staged = staged.expect("complete payload stages");
	assert_eq!(staged.len(), 1);
	assert_eq!(staged[0].after.as_bytes(), expected.as_bytes());
	assert_eq!(preview.files.len(), 1);
	assert_eq!(preview.files[0].error, None);
	assert_eq!(preview.files[0].diff.as_deref(), Some(staged[0].diff.as_str()));
	assert_eq!(outcome.files.len(), 1);
	assert_eq!(outcome.files[0].diff, staged[0].diff);
	assert_eq!(outcome.files[0].new_text.as_deref(), Some(expected));
}

#[tokio::test]
async fn transitive_overlap_preserves_the_third_authored_change() {
	let input = replacements(&[FIRST, MIDDLE, LAST]);
	assert_session_result(
		BEFORE,
		&input,
		concat!(
			"alpha_header\nkeep_one\nblock_start\nmiddle_new\n",
			"anchor_inside\nkeep_three\nblock_end\nfile_tail\n",
		),
	)
	.await;
}

#[tokio::test]
async fn disjoint_operations_keep_original_anchors_in_both_input_orders() {
	let before = "header\nkeep_left\nobsolete_row\nkeep_right\nfile_tail\n";
	let first = ("header", "header\ninserted_😀");
	let middle = ("obsolete_row", "");
	let last = ("keep_left\nobsolete_row\nkeep_right\n⟪file_tail⟫", "tail_changed");
	for operations in [[first, middle, last], [last, middle, first]] {
		assert_session_result(
			before,
			&replacements(&operations),
			"header\ninserted_😀\nkeep_left\nkeep_right\ntail_changed\n",
		)
		.await;
	}
}

#[tokio::test]
async fn transitive_overlap_defers_every_span_of_one_operation() {
	let input = concat!(
		"*** Edit File: a.txt\n",
		"*** Find\nalpha_header\nblock_start\n",
		"*** Replace\nalpha_header\nkeep_one\nblock_start\n",
		"*** Find\n⟪block_start│block_start\nmiddle_new⟫\n…\n",
		"⟪anchor_inside\nblock_end│anchor_inside\nblock_end\nkeep_two_tail⟫\n",
		"*** Find\nanchor_inside\nblock_end\n",
		"*** Replace\nanchor_inside\nkeep_three\nblock_end\n",
	);
	assert_session_result(
		BEFORE,
		input,
		concat!(
			"alpha_header\nkeep_one\nblock_start\nmiddle_new\nobsolete_row\n",
			"anchor_inside\nkeep_three\nblock_end\nkeep_two_tail\nfile_tail\n",
		),
	)
	.await;
}

#[tokio::test]
async fn transitive_overlap_preserves_a_deleted_block_reemitted_by_the_last_operation() {
	let before = format!("move_me\n{BEFORE}");
	let input = replacements(&[
		("move_me", ""),
		FIRST,
		MIDDLE,
		(LAST.0, "anchor_inside\nkeep_three\nblock_end\n»1"),
	]);
	assert_session_result(
		&before,
		&input,
		concat!(
			"alpha_header\nkeep_one\nblock_start\nmiddle_new\n",
			"anchor_inside\nkeep_three\nblock_end\nmove_me\nfile_tail\n",
		),
	)
	.await;
}

#[tokio::test]
async fn later_transitive_rematch_failure_reports_partial_result_and_preserves_failed_target() {
	let workspace = Workspace::new(EditMode::Sloppy);
	let path = workspace.write("a.txt", BEFORE);
	let sibling = workspace.write("sibling.txt", "sibling_before\n");
	let untouched = workspace.write("untouched.txt", "untouched_before\n");
	let chain = replacements(&[FIRST, (MIDDLE.0, "block_start\nmiddle_new\n"), LAST]);
	let input = format!(
		"*** Edit File: sibling.txt\n*** Find\nsibling_before\n*** \
		 Replace\nsibling_after\n{chain}*** Edit File: untouched.txt\n*** \
		 Find\nthis_anchor_was_never_present\n*** Replace\nmust_not_appear\n"
	);
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": input }).to_string());
	session.finish();
	let preview = session.preview();
	assert_eq!(std::fs::read(&path).unwrap(), BEFORE.as_bytes());
	assert_eq!(std::fs::read(&sibling).unwrap(), b"sibling_before\n");

	let writer = DiskWriter::default();
	let result = session
		.apply(ApplyRequest::default(), &writer)
		.await
		.expect("successful independent operations persist with explicit partial results");
	let expected = "alpha_header\nkeep_one\nblock_start\nmiddle_new\nfile_tail\n";
	assert_eq!(std::fs::read(&path).unwrap(), expected.as_bytes());
	assert_eq!(std::fs::read(&sibling).unwrap(), b"sibling_after\n");
	assert_eq!(std::fs::read(&untouched).unwrap(), b"untouched_before\n");
	let requests = writer.requests.lock();
	assert_eq!(requests.len(), 2);
	assert!(requests.iter().all(|request| request.absolute != untouched));
	let partial = result
		.files
		.iter()
		.find(|file| file.absolute == path)
		.unwrap();
	assert_eq!(partial.op, FileOp::Update);
	assert_eq!(partial.new_text.as_deref(), Some(expected));
	assert!(partial.text.contains("Operation 3"), "failed operation missing: {}", partial.text);
	let failed = result
		.files
		.iter()
		.find(|file| file.absolute == untouched)
		.unwrap();
	assert_eq!(failed.op, FileOp::Noop);
	assert_eq!(failed.old_text, failed.new_text);
	assert!(failed.text.contains("Operation 1"), "failed target missing: {}", failed.text);
	let changed = result
		.files
		.iter()
		.find(|file| file.absolute == sibling)
		.unwrap();
	assert_eq!(changed.op, FileOp::Update);
	assert_eq!(changed.new_text.as_deref(), Some("sibling_after\n"));
	let preview = preview
		.files
		.iter()
		.find(|file| file.display == "a.txt")
		.unwrap();
	assert_eq!(preview.diff.as_deref(), Some(partial.diff.as_str()));
}
