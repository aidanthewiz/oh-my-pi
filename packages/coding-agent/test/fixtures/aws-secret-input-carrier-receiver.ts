const input = new Uint8Array(await Bun.stdin.arrayBuffer());
try {
	const digest = new Bun.CryptoHasher("sha256").update(input).digest("hex");
	if (digest !== process.argv[2]) process.exitCode = 41;
	else process.stdout.write("carrier-input-approved\n");
} finally {
	input.fill(0);
}

export {};
