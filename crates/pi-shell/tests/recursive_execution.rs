use std::time::Duration;

use pi_shell::{
	ShellExecuteOptions,
	cancel::{AbortReason, CancelToken},
	execute_shell,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recursive_pipeline_preserves_function_scope_and_output() {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions {
			command: "f() { local level=$1; if [ \"$level\" -lt 200 ]; then f $((level + 1)); else \
			          echo reached=$level; fi; if [ \"$level\" -eq 0 ]; then echo root=$level; fi; \
			          }; f 0 | cat; echo after=$?"
				.to_string(),
			..Default::default()
		},
		Some(tx),
		CancelToken::default(),
	)
	.await
	.expect("shell execution");
	let output: String = rx.try_iter().collect();
	assert_eq!(result.exit_code, Some(0), "{output}");
	assert_eq!(output, "reached=200\nroot=0\nafter=0\n");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_unwinds_nested_execution_and_closes_output() {
	let mut cancel = CancelToken::default();
	let abort = cancel.emplace_abort_token();
	let (tx, rx) = flume::unbounded::<String>();
	let task = tokio::spawn(execute_shell(
		ShellExecuteOptions {
			command: "f() { if [ \"$1\" -lt 200 ]; then f $(( $1 + 1 )); else echo ready; sleep 60; \
			          fi; }; f 0; echo after"
				.to_string(),
			..Default::default()
		},
		Some(tx),
		cancel,
	));
	let mut output = String::new();
	tokio::time::timeout(Duration::from_secs(10), async {
		while !output.contains("ready\n") {
			output.push_str(&rx.recv_async().await.expect("nested execution output"));
		}
	})
	.await
	.expect("nested execution reached its wait");
	abort.abort(AbortReason::Signal);
	let result = tokio::time::timeout(Duration::from_secs(10), task)
		.await
		.expect("nested cancellation completed")
		.expect("execution task")
		.expect("shell execution");
	tokio::time::timeout(Duration::from_secs(10), async {
		while let Ok(chunk) = rx.recv_async().await {
			output.push_str(&chunk);
		}
	})
	.await
	.expect("cancelled execution released output ownership");
	assert!(result.cancelled, "{result:?}");
	assert_eq!(result.exit_code, None);
	assert!(!output.contains("after\n"), "{output}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_suspended_recursion_releases_owned_pipe_descriptors() {
	use std::io::{BufRead, Read};

	use brush_core::{ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo, openfiles::OpenFiles};
	use pi_builtins::{BuiltinSet, default_builtins, process_builtins, utility_builtins};

	let mut shell = Shell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.expect("shell");
	for (name, builtin) in process_builtins().into_iter().chain(utility_builtins()) {
		shell.register_builtin(name, builtin);
	}
	let (reader, writer) = std::io::pipe().expect("output pipe");
	let mut params = shell.default_exec_params();
	params.set_fd(OpenFiles::STDOUT_FD, writer.into());
	let (ready, reached) = tokio::sync::oneshot::channel();
	let output = tokio::task::spawn_blocking(move || {
		let mut reader = std::io::BufReader::new(reader);
		let mut first = String::new();
		reader.read_line(&mut first).expect("ready line");
		ready.send(first).expect("execution observer");
		let mut rest = String::new();
		reader.read_to_string(&mut rest).expect("pipe EOF");
		rest
	});
	let task = tokio::spawn(async move {
		shell
			.run_string(
				"f() { if [ \"$1\" -lt 200 ]; then f $(( $1 + 1 )); else echo ready; sleep 60; fi; }; \
				 f 0; echo after",
				&SourceInfo::from("nested-drop"),
				&params,
			)
			.await
	});
	let first = tokio::time::timeout(Duration::from_secs(10), reached)
		.await
		.expect("nested execution reached its wait")
		.expect("ready observer");
	assert_eq!(first, "ready\n");
	task.abort();
	assert!(
		task
			.await
			.expect_err("execution was aborted")
			.is_cancelled()
	);
	let rest = tokio::time::timeout(Duration::from_secs(10), output)
		.await
		.expect("dropped recursion released every pipe writer")
		.expect("output reader");
	assert_eq!(rest, "");
}
