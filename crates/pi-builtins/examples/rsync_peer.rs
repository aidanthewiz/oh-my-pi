#[cfg(unix)]
mod peer {
	use std::io::{self, Write};

	use brush_core::{
		ExecutionContext, ProfileLoadBehavior, RcLoadBehavior, Shell,
		commands::CommandArg,
		extensions::DefaultShellExtensions,
		openfiles::{OpenFile, OpenFiles},
	};
	use tokio_util::sync::CancellationToken;

	async fn run() -> Result<u8, Box<dyn std::error::Error>> {
		let args = std::env::args_os();
		let mut argv = Vec::with_capacity(args.len());
		argv.push(CommandArg::String("rsync".to_owned()));
		for arg in args.skip(1) {
			argv.push(CommandArg::String(arg.into_string().map_err(|_| {
				io::Error::new(io::ErrorKind::InvalidInput, "builtin entrypoint requires UTF-8 argv")
			})?));
		}
		let mut shell: Shell = Shell::builder()
			.profile(ProfileLoadBehavior::Skip)
			.rc(RcLoadBehavior::Skip)
			.build()
			.await?;
		shell.set_working_dir(std::env::current_dir()?).await?;
		let registration = pi_builtins::utility_builtins::<DefaultShellExtensions>()
			.into_iter()
			.find(|(name, _)| *name == "rsync")
			.map(|(_, registration)| registration)
			.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "rsync builtin is unavailable"))?;
		let cancel = CancellationToken::new();
		let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
		let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
		let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())?;
		let signal_cancel = cancel.clone();
		let signal_task = tokio::spawn(async move {
			tokio::select! {
				_ = interrupt.recv() => {},
				_ = terminate.recv() => {},
				_ = hangup.recv() => {},
			}
			signal_cancel.cancel();
		});
		let mut params = shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, OpenFile::Stdin(io::stdin()));
		params.set_fd(OpenFiles::STDOUT_FD, OpenFile::Stdout(io::stdout()));
		params.set_fd(OpenFiles::STDERR_FD, OpenFile::Stderr(io::stderr()));
		params.set_cancel_token(cancel);
		let result = (registration.execute_func)(
			ExecutionContext { shell: &mut shell, command_name: "rsync".to_owned(), params },
			argv,
		)
		.await;
		signal_task.abort();
		let _ = signal_task.await;
		Ok(u8::from(result?.exit_code))
	}

	pub fn main() {
		let code = (|| -> Result<u8, Box<dyn std::error::Error>> {
			let runtime = tokio::runtime::Builder::new_multi_thread()
				.worker_threads(2)
				.enable_all()
				.build()?;
			runtime.block_on(run())
		})();
		match code {
			Ok(code) => std::process::exit(i32::from(code)),
			Err(error) => {
				let _ = writeln!(io::stderr(), "rsync peer fixture: {error}");
				std::process::exit(125);
			},
		}
	}
}

#[cfg(unix)]
fn main() {
	peer::main();
}

#[cfg(not(unix))]
fn main() -> Result<(), &'static str> {
	Err("rsync peer fixture requires Unix")
}
