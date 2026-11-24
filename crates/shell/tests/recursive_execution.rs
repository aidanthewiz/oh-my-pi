use std::time::Duration;

use omp_shell::{
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
	#[cfg(unix)]
	use std::os::fd::OwnedFd as Owned;
	#[cfg(windows)]
	use std::os::windows::io::OwnedHandle as Owned;

	use omp_shell::{
		session::{RunStdio, Session, SessionConfig},
		sys::StdFs,
	};

	let mut session = Session::new(SessionConfig {
		env:             Vec::new(),
		cwd:             std::env::current_dir()
			.expect("cwd")
			.as_os_str()
			.as_encoded_bytes()
			.into(),
		fs:              Box::new(StdFs::default()),
		vfs:             None,
		runtime:         tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.expect("session");
	let (reader, writer) = std::io::pipe().expect("output pipe");
	let stdio =
		RunStdio { stdout: Some(std::fs::File::from(Owned::from(writer))), ..Default::default() };
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
		session
			.run(
				"f() { if [ \"$1\" -lt 200 ]; then f $(( $1 + 1 )); else echo ready; sleep 60; fi; }; \
				 f 0; echo after",
				stdio,
				tokio_util::sync::CancellationToken::new(),
			)
			.await
	});
	let first = tokio::time::timeout(Duration::from_secs(10), reached)
		.await
		.expect("nested execution reached its wait")
		.expect("ready observer");
	assert_eq!(first, "ready\n");
	task.abort();
	assert!(matches!(task.await, Err(error) if error.is_cancelled()));
	let rest = tokio::time::timeout(Duration::from_secs(10), output)
		.await
		.expect("dropped recursion released every pipe writer")
		.expect("output reader");
	assert_eq!(rest, "");
}
