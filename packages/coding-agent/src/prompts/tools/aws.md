Invoke an AWS CLI operation through the trusted native route.

Provide an explicit profile, service, operation, and structured parameters. Supply a region when the selected profile has no configured region. The route never uses a shell, a repository PATH, or ambient credentials.

Use AWS CLI operation names such as `get-caller-identity`, not managed MCP's Smithy PascalCase names.

For ordinary AWS requests, an authentication failure can offer one approved sign-in and retry the original operation once. Later credential expiry can renew authentication again. A declined or failed sign-in pauses automatic recovery for that SSO group. Without an interactive surface, the tool returns an explicit login command. Do not add automatic sign-in loops. Use `service: "sso", operation: "login"` only for a user-requested sign-in, including retries after an earlier decline, failure, or completed login. Secret-input requests never sign in or retry automatically.

Read calls are identified through AWS's public service authorization reference. Missing mappings and known stateful IAM reads, including SQS consumption, workload invocation, and credential issuance, require approval. Read-only queries can still incur charges.

Ordinary approval offers **Allow for the rest of this session** alongside one-call approval and denial. This explicit grant covers later native AWS commands and profiles, not other sessions or managed MCP command approvals. It is not persisted. Do not infer a grant from an earlier one-call approval. Browser SSO authentication still requires the user when necessary.

Mutations require verified STS Account, ARN, Region, and partition checks even with session approval. Identity changes after approval reject execution. Explicit tool-policy denies, mandatory per-command Destructive Command Guard asks or denies, and provider safety checks remain enforced.

## Secret delivery through finite stdin

Use the existing `aws` device with optional `secretInput`, not a separate database API.
The receiving CLI owns application reads and writes; no query parser, client adapter, or receiver allowlist applies.

1. Read `xd://aws/schema` and compare its complete JSON input schema with the expected implementation.
2. Call `{"action":"secret-input-capabilities","protocol":"aws-secret-input/v1"}` before authentication or access approval.
3. Verify the complete capability, manifest, limits, supported providers, and fingerprint, including actual host lifecycle and private worker support.
4. Stop if schema or capability support is missing, old, skewed, or incompatible.
5. Bind the verified `capability` fingerprint in the exact request's `secretInput`.

Capability discovery needs no profile, credentials, authentication, or network access.
Discovery does not authorize unsupported execution paths.
Require actual invocation ownership under `native-tool-host/v2`, not merely a canonical registered tool wrapper.
Use the actual native Agent dispatcher or native Write → `xd://aws`, with intrinsic `await-cleanup` and session lifecycle ownership.
JavaScript/Python Eval and naked SDK/direct `.execute(...)` calls reject with `CAPABILITY_INCOMPATIBLE` before approval UI, provider work, or receiver execution.
Canonical registered wrappers and nested Write → `xd://aws` calls do not make those unsupported invocations admissible.
Discover the current fingerprint at runtime; do not reuse one from another host contract.
Require manifest `hostPolicy:"native-tool-host/v2"`; retain `executionPolicy:"tool-cancellation-cleanup/v1"` and `outputPolicy:"raw-bounded-consumer-output/v1"`.
Scope and lifecycle remain `aws-secret-input-sdk-scope/v2` and `tool-session-lifecycle/v2`.
Require `deliveryPolicy:"finite-stdin-owned-process-group/v3"` and capability `sha256:4936396a3a935e4582d42be1d73ef096353d23802dcea2394f7e969ffb42a358`.
Reject older or mixed delivery-policy/fingerprint tuples.
Native schema and description discovery no longer enumerate AWS profiles; schema and capability discovery read no profile or credential files.
Use an operator-approved, caller-known operational profile; never infer ambient, default, or model/relay profiles.
Ordinary explicit-profile execution and the existing commercial MCP profile metadata route remain unchanged.
There is no new native profile metadata API.
Require explicit `profile`, `region`, `service:"secretsmanager"`, `operation:"get-secret-value"`, and `parameters` with full `SecretId` ARN and pinned `VersionId`.
An optional `VersionStage` must also match exactly.
Supply `secretInput.protocol:"aws-secret-input/v1"` and `expectedIdentity:{account,arn,partition}` with the exact expected STS identity.
The principal account may differ from the secret ARN account; keep both exact bindings.
Require an absolute executable in `consumer.argv[0]`, literal public arguments, and an absolute local `consumer.cwd`.
Approve the immutable AWS reference, identity, argv/cwd, transformation, duration, and output limits once.
Session grants do not replace this approval; changed arguments, settings, or session invalidate it.
Honor native AWS and receiving-process bash/exec policy and command guards, including their asks and denies, before provider work.
Each actual SDK dispatch and a distinct post-secret consumer admission recheck current authority, settings, and guards.
Consumer admission never prompts after secret retrieval.
Denial, authority revision, or receiver replacement during retrieval prevents receiver execution.

Without `jsonPointer`, stdin receives exact SecretString UTF-8 bytes or SecretBinary bytes.
Optional `jsonPointer` selects only a string leaf from parsed SecretString using RFC 6901.
`appendNewline` defaults to false.
Maximum input is 65,536 bytes.
`maxStdoutBytes` and `maxStderrBytes` each limit retained output to 1,048,576 bytes, at most 2 MiB combined.
Report truncation separately for each stream.
`timeout` is seconds: default 30, maximum 120.
Do not infer secret fields or combine credentials with application commands.
The receiver must support finite stdin and non-echoing normal configuration; otherwise report it unsupported.
Never substitute credential argv, environment, files, FIFOs, RAM disks, unsafe PTY input, or shell AWS calls.

Only explicit existing static profile credentials and existing unexpired SSO tokens are supported.
Do not assume role chains, credential_process, web identity, endpoints, or ambient credential providers work.
Authenticate separately only when explicitly authorized; repeat preflight and exact approval afterward.

Consumer stdout/stderr is raw, agent-visible normal output and may persist normally.
It is not sanitized or masked.
The receiver sees stdin and can intentionally disclose it; protected delivery does not guarantee arbitrary-program confidentiality.
Avoid receiver credential echo, history, and caches.
The detached consumer gets no inherited AWS credential environment or private worker control descriptors.
The guardian uses a fresh neutral owned startup directory and minimal Bun startup environment, blocking project and global preloads.
Only the receiver uses its approved cwd, environment, and argv.
Cancellation, timeout, and session disposal reap the owned consumer group and worker without retry or replacement.
An independent owned finite-input guardian also covers worker SIGKILL/disconnect and receiver leader exit with foreground descendants or pipes remaining.
The intrinsic `await-cleanup` policy keeps admitted native invocations pending until owned teardown completes.
Interrupted writes can have committed: report uncertain completion, not rollback or retry safety.
After worker execution starts, failures report `{ok:false,code,completion:"uncertain"}`; pre-run failures report `{ok:false,code}`.
Successful `completion:"exited"` means process exit only, not transaction atomicity or rollback.
Deliberate daemonization or process-group escape exceeds the cleanup guarantee.
External forced termination of all independent owners and OS crashes are also outside that guarantee.
Never claim successful teardown after ownership is lost.
GC, SDK/allocator copies, swap, core dumps, and privileged OS inspection prevent secure-erasure promises.
