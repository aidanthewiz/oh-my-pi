import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ptree } from "@oh-my-pi/pi-utils";

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function executable(name: string): string {
	for (const directory of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
		const candidate = path.join(directory, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch (error) {
			if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	throw new Error(`Local SSH fixture requires ${name} on the system executable path; no tests were qualified`);
}

async function command(argv: string[], env: Record<string, string>, timeout: number): Promise<string> {
	if (timeout <= 0) throw new Error(`Local SSH fixture deadline expired before ${argv[0]}`);
	const child = Bun.spawn(argv, {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout,
		killSignal: "SIGKILL",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0 || child.signalCode) {
		throw new Error(`Local SSH fixture ${argv[0]} failed (${code}, ${child.signalCode ?? "no signal"}): ${stderr}`);
	}
	return stdout;
}

async function unusedLoopbackPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
	if (!address || typeof address === "string" || address.port <= 1024) {
		throw new Error("Local SSH fixture requires an unprivileged loopback TCP port");
	}
	return address.port;
}

export interface SshProcessTransport {
	exec: typeof ptree.exec;
	spawn: typeof ptree.spawn;
}

export interface LocalSshFixture {
	root: string;
	port: number;
	run(script: string, timeout?: number): Promise<string>;
	adaptTransport(transport: SshProcessTransport): SshProcessTransport;
	close(): Promise<void>;
}

/** Requires OpenSSH ssh/sshd/ssh-keygen, ps, whoami, and a POSIX account allowed to run a private sshd. */
export async function createLocalSshFixture(): Promise<LocalSshFixture> {
	if (process.platform === "win32")
		throw new Error("Local SSH fixture requires a POSIX OpenSSH server; no tests were qualified");
	const ssh = executable("ssh");
	const sshd = executable("sshd");
	const keygen = executable("ssh-keygen");
	executable("ps");
	const deadline = Date.now() + 4_000;
	// SSH must authenticate the effective OS account, not an environment-supplied name.
	const username = (await command([executable("whoami")], { LC_ALL: "C" }, deadline - Date.now())).trim();
	if (!/^[a-zA-Z0-9_.-]+\$?$/.test(username))
		throw new Error("Local SSH fixture cannot encode this account name safely");
	// OpenSSH limits ControlPath to 104 bytes on macOS, independently of TMPDIR.
	const root = fs.mkdtempSync("/tmp/omp-ssh-");
	const home = path.join(root, "home");
	const bin = path.join(root, "bin");
	const env: Record<string, string> = {
		HOME: home,
		ZDOTDIR: home,
		PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
		USER: username,
		LOGNAME: username,
		LC_ALL: "C",
		TMPDIR: root,
	};
	let supervisor: Bun.Subprocess<"pipe", number, number> | undefined;
	let closed = false;

	async function close(): Promise<void> {
		if (closed) return;
		if (supervisor) {
			supervisor.stdin.end();
			const code = await supervisor.exited;
			if (code !== 0) {
				throw new Error(
					`Local SSH fixture cleanup failed (${code}); retained owned fixture ${root}: ${fs.readFileSync(path.join(root, "supervisor.log"), "utf8")}`,
				);
			}
		}
		fs.rmSync(root, { recursive: true, force: true });
		closed = true;
	}

	try {
		fs.chmodSync(root, 0o700);
		fs.mkdirSync(home, { mode: 0o700 });
		fs.mkdirSync(bin, { mode: 0o700 });
		const keys = await Promise.allSettled(
			["host", "client"].map(name =>
				command(
					[
						keygen,
						"-q",
						"-t",
						"ed25519",
						"-N",
						"",
						"-C",
						"omp-owned-localhost-fixture",
						"-f",
						path.join(root, name),
					],
					env,
					deadline - Date.now(),
				),
			),
		);
		const failures = keys.filter(result => result.status === "rejected").map(result => result.reason);
		if (failures.length) throw new AggregateError(failures, "Synthetic SSH key generation failed");
		fs.writeFileSync(path.join(root, "authorized_keys"), fs.readFileSync(path.join(root, "client.pub")), {
			mode: 0o600,
		});
		const port = await unusedLoopbackPort();
		const hostKey = fs.readFileSync(path.join(root, "host.pub"), "utf8").trim();
		fs.writeFileSync(path.join(root, "known_hosts"), `[127.0.0.1]:${port} ${hostKey}\n`, { mode: 0o600 });
		const config = path.join(root, "sshd_config");
		fs.writeFileSync(
			config,
			[
				`Port ${port}`,
				"AddressFamily inet",
				"ListenAddress 127.0.0.1",
				`HostKey ${root}/host`,
				`PidFile ${root}/sshd.pid`,
				`AuthorizedKeysFile ${root}/authorized_keys`,
				"AuthorizedKeysCommand none",
				// Temporary ancestors can be writable; the synthetic key's own root is owner-private.
				"TrustedUserCAKeys none",
				"StrictModes no",
				`AllowUsers ${username}`,
				"PubkeyAuthentication yes",
				"AuthenticationMethods publickey",
				"PasswordAuthentication no",
				"KbdInteractiveAuthentication no",
				"UsePAM no",
				"HostbasedAuthentication no",
				"PermitRootLogin prohibit-password",
				"PermitUserEnvironment no",
				"PermitUserRC no",
				"AllowAgentForwarding no",
				"AllowTcpForwarding no",
				"X11Forwarding no",
				"PermitTunnel no",
				"UseDNS no",
				"PrintMotd no",
				"PrintLastLog no",
				"LoginGraceTime 4",
				"LogLevel VERBOSE",
				`SetEnv HOME=${home} ZDOTDIR=${home} PATH=/usr/bin:/bin:/usr/sbin:/sbin BASH_ENV=/dev/null ENV=/dev/null`,
				`ForceCommand /bin/sh ${root}/remote-command`,
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			path.join(root, "remote-command"),
			`#!/bin/sh\nexport HOME=${quote(home)} ZDOTDIR=${quote(home)}\nexport PATH=/usr/bin:/bin:/usr/sbin:/sbin\nunset SSH_AUTH_SOCK SSH_AGENT_PID\ncd "$HOME" || exit 1\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`,
			{ mode: 0o700 },
		);
		await command([sshd, "-t", "-f", config], env, deadline - Date.now());
		const clientConfig = path.join(root, "ssh_config");
		fs.writeFileSync(
			clientConfig,
			[
				"Host *",
				"  HostName 127.0.0.1",
				`  Port ${port}`,
				`  User ${username}`,
				`  IdentityFile ${root}/client`,
				"  CertificateFile none",
				"  IdentityAgent none",
				"  IdentitiesOnly yes",
				"  PKCS11Provider none",
				"  BatchMode yes",
				"  PreferredAuthentications publickey",
				"  PasswordAuthentication no",
				"  KbdInteractiveAuthentication no",
				"  HostbasedAuthentication no",
				"  StrictHostKeyChecking yes",
				`  UserKnownHostsFile ${root}/known_hosts`,
				"  GlobalKnownHostsFile /dev/null",
				"  UpdateHostKeys no",
				"  VerifyHostKeyDNS no",
				"  ProxyCommand none",
				"  ProxyJump none",
				"  ForwardAgent no",
				"  ClearAllForwardings yes",
				"  RequestTTY no",
				"  ConnectTimeout 4",
				"  ConnectionAttempts 1",
				"  ServerAliveInterval 1",
				"  ServerAliveCountMax 2",
				"  ControlMaster no",
				"  ControlPersist no",
				`  ControlPath ${root}/control`,
				"",
			].join("\n"),
			{ mode: 0o600 },
		);
		// -F excludes both the account's ssh_config and the system ssh_config.
		fs.writeFileSync(
			path.join(bin, "ssh"),
			`#!/bin/sh\nunset SSH_AUTH_SOCK SSH_AGENT_PID SSH_SK_PROVIDER\nexport HOME=${quote(home)}\nprintf '%s' "$0" > ${quote(path.join(root, "wrapper-invoked"))}\nexec ${quote(ssh)} -F ${quote(clientConfig)} -p ${port} -o HostName=127.0.0.1 -o IdentityAgent=none -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quote(`${root}/known_hosts`)} -o GlobalKnownHostsFile=/dev/null -o ProxyCommand=none -o ProxyJump=none -o ControlMaster=no -o ControlPersist=no -o ControlPath=${quote(`${root}/control`)} "$@"\n`,
			{ mode: 0o700 },
		);
		const log = fs.openSync(path.join(root, "supervisor.log"), "wx", 0o600);
		try {
			supervisor = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), "--supervise", root, sshd], {
				env,
				cwd: root,
				stdin: "pipe",
				stdout: log,
				stderr: log,
			});
		} finally {
			fs.closeSync(log);
		}
		while (!fs.existsSync(path.join(root, "listening"))) {
			if (
				supervisor.exitCode !== null ||
				fs.existsSync(path.join(root, "daemon-failed")) ||
				Date.now() >= deadline
			) {
				throw new Error(
					`Private sshd did not become ready: ${fs.readFileSync(path.join(root, "sshd.log"), "utf8")}`,
				);
			}
			await Bun.sleep(10);
		}
		const run = (script: string, timeout = 4_000) =>
			command([path.join(bin, "ssh"), "localhost", script], env, timeout);
		if ((await run("printf omp-owned-ssh-ready", deadline - Date.now())) !== "omp-owned-ssh-ready") {
			throw new Error("Private sshd did not return its authenticated readiness marker");
		}
		const adaptTransport = (transport: SshProcessTransport): SshProcessTransport => ({
			exec(argv, options) {
				if (argv[0] !== "ssh") return transport.exec(argv, options);
				return transport.exec([path.join(bin, "ssh"), ...argv.slice(1)], { ...options, env });
			},
			spawn(argv, options) {
				if (argv[0] !== "ssh") return transport.spawn(argv, options);
				return transport.spawn([path.join(bin, "ssh"), ...argv.slice(1)], { ...options, env });
			},
		});
		return { root, port, run, adaptTransport, close };
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Local SSH fixture setup and cleanup failed");
		}
		throw error;
	}
}

async function supervise(root: string, sshd: string): Promise<void> {
	const log = fs.openSync(path.join(root, "sshd.log"), "wx", 0o600);
	const daemon = spawn(sshd, ["-D", "-e", "-f", path.join(root, "sshd_config")], {
		env: process.env,
		stdio: ["ignore", log, log],
	});
	fs.closeSync(log);
	const exited = new Promise<void>(resolve => {
		daemon.once("error", error => {
			fs.writeFileSync(path.join(root, "daemon-failed"), String(error));
			resolve();
		});
		daemon.once("exit", (code, signal) => {
			fs.writeFileSync(path.join(root, "daemon-failed"), `sshd exited (${code}, ${signal})`);
			resolve();
		});
	});
	function signalOwned(pid: number, signal: NodeJS.Signals): void {
		if (!Number.isInteger(pid) || pid <= 1) throw new Error("Invalid owned SSH fixture PID");
		try {
			process.kill(pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	const readiness = setInterval(() => {
		if (fs.readFileSync(path.join(root, "sshd.log"), "utf8").includes("Server listening on 127.0.0.1")) {
			fs.writeFileSync(path.join(root, "listening"), "ready\n");
			clearInterval(readiness);
		}
	}, 10);
	const requested = new Promise<void>(resolve => {
		process.stdin.resume();
		process.stdin.once("end", resolve);
		process.once("SIGTERM", resolve);
		process.once("SIGINT", resolve);
	});
	try {
		await requested;
		clearInterval(readiness);
		if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null) {
			// Freeze ancestors before inventorying children: no new sessions can escape cleanup.
			signalOwned(daemon.pid, "SIGSTOP");
			const owned = new Set<number>([daemon.pid]);
			const descendants: number[] = [];
			for (let changed = true; changed;) {
				changed = false;
				const snapshot = await command(
					[executable("ps"), "-A", "-o", "pid=,ppid="],
					process.env as Record<string, string>,
					500,
				);
				const rows = snapshot
					.trim()
					.split("\n")
					.map(line => line.trim().split(/\s+/).map(Number));
				for (let found = true; found;) {
					found = false;
					for (const [pid, ppid] of rows) {
						if (pid && ppid && owned.has(ppid) && !owned.has(pid)) {
							signalOwned(pid, "SIGSTOP");
							owned.add(pid);
							descendants.push(pid);
							found = changed = true;
						}
					}
				}
			}
			for (const pid of descendants.reverse()) signalOwned(pid, "SIGKILL");
			daemon.kill("SIGKILL");
		}
		await exited;
		fs.rmSync(root, { recursive: true, force: true });
	} finally {
		process.stdin.destroy();
	}
}

if (import.meta.main) {
	if (process.argv[2] !== "--supervise" || !process.argv[3] || !process.argv[4]) {
		throw new Error("local-ssh-fixture is only executable as its owned daemon supervisor");
	}
	await supervise(process.argv[3], process.argv[4]);
}
