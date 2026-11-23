#[cfg(unix)]
mod peer {
	use std::{
		io::{self, Write},
		os::fd::AsFd as _,
	};

	use omp_builtins::extras::{self, Fd, Invocation};
	use tokio_util::sync::CancellationToken;

	async fn run() -> Result<i32, Box<dyn std::error::Error>> {
		let args = std::env::args_os();
		let mut argv = Vec::with_capacity(args.len());
		argv.push("rsync".to_owned());
		for arg in args.skip(1) {
			argv.push(arg.into_string().map_err(|_| {
				io::Error::new(io::ErrorKind::InvalidInput, "builtin entrypoint requires UTF-8 argv")
			})?);
		}
		let mut invocation = Invocation::new(argv, std::env::current_dir()?, omp_vfs::Fs::native());
		invocation.env = std::env::vars().collect();
		invocation.stdio = [
			Fd::File(std::fs::File::from(io::stdin().as_fd().try_clone_to_owned()?)),
			Fd::File(std::fs::File::from(io::stdout().as_fd().try_clone_to_owned()?)),
			Fd::File(std::fs::File::from(io::stderr().as_fd().try_clone_to_owned()?)),
		];
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
		invocation.cancel = Some(cancel);
		let result = extras::run(invocation).await;
		signal_task.abort();
		let _ = signal_task.await;
		Ok(result)
	}

	pub fn main() {
		let code = (|| -> Result<i32, Box<dyn std::error::Error>> {
			let runtime = tokio::runtime::Builder::new_multi_thread()
				.worker_threads(2)
				.enable_all()
				.build()?;
			runtime.block_on(run())
		})();
		match code {
			Ok(code) => std::process::exit(code),
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
