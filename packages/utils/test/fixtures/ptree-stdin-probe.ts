const mode = process.argv[2];
if (mode === "payload") {
	process.stdout.write((await Bun.stdin.text()).toUpperCase());
	process.exit(0);
}

process.stdin.once("end", () => {
	process.stdout.write("stdin-eof\n");
	process.exit(86);
});
process.stdin.resume();

if (mode === "child") {
	process.stdout.write(`child:${process.pid}\n`);
	setInterval(() => {}, 1000);
} else if (mode === "hang") {
	process.stdout.write(`root:${process.pid}\n`);
	Bun.spawn([process.execPath, import.meta.path, "child"], {
		env: { ...Bun.env, BUN_BE_BUN: "1" },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	setInterval(() => {}, 1000);
} else {
	await Bun.sleep(120);
	process.stdout.write("remote-complete\n");
	process.exit(0);
}
