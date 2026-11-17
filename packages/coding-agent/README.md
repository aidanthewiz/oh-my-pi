# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.

## AWS secret delivery to a process

`xd://aws` supports ordinary AWS operations and an optional `secretInput` handoff.
It delivers a pinned Secrets Manager value directly to one local process through finite stdin.
The native API does not provide a database interface, query layer, client adapter, or receiver allowlist.
The receiving CLI controls its own reads and writes.

### Preflight and approval

1. Read `xd://aws/schema` and compare the complete registered JSON input schema with the expected contract.
2. Call `{"action":"secret-input-capabilities","protocol":"aws-secret-input/v1"}` before authentication or access approval.
3. Verify the complete capability, manifest, limits, supported providers, and `sha256:` fingerprint against the expected implementation.
4. Stop on missing, old, incompatible, or unsupported schema, host, lifecycle, or private worker support.
5. Submit the pinned request with the verified fingerprint in `secretInput.capability`.
6. Approve that exact immutable request once. Session grants do not replace this approval.

Capability discovery performs no authentication, credential access, or AWS request.
Discovery checks loaded host and private worker capabilities; it does not authorize an unsupported execution path.
Execution requires actual invocation ownership under `native-tool-host/v2`, not merely a canonical registered tool wrapper.
The actual native Agent dispatcher and native Write → `xd://aws` route support secret input with intrinsic `await-cleanup` and session lifecycle ownership, whether AWS is active or mounted.
JavaScript/Python Eval and naked SDK/direct `.execute(...)` invocations are unsupported, even through a canonical registered wrapper or nested Write → `xd://aws`.
They fail with `CAPABILITY_INCOMPATIBLE` before approval UI, provider work, or receiver execution.
Discover and verify the current fingerprint at runtime; do not reuse a fingerprint from another host contract.
The manifest requires `hostPolicy:"native-tool-host/v2"` and retains `executionPolicy:"tool-cancellation-cleanup/v1"`.
Scope and lifecycle remain `aws-secret-input-sdk-scope/v2` and `tool-session-lifecycle/v2`; delivery requires `finite-stdin-owned-process-group/v3`.
Output remains `raw-bounded-consumer-output/v1`.
Native schema and description discovery no longer enumerate AWS profiles; schema and capability discovery read no profile or credential files.
Use an operator-approved, caller-known operational profile, never an inferred ambient, default, or model/relay profile.
Ordinary explicit-profile execution and the existing commercial MCP profile metadata route remain unchanged.
No new native profile metadata API is provided.

The request requires explicit `profile`, `region`, `service:"secretsmanager"`, and `operation:"get-secret-value"`.
Its `parameters` bind the full `SecretId` ARN, exact `VersionId`, and optional exact `VersionStage`.
`secretInput` requires `protocol:"aws-secret-input/v1"`, the capability fingerprint, and `expectedIdentity` with exact `account`, principal `arn`, and `partition`.
The partition must be `aws`, `aws-us-gov`, or `aws-cn`.
The principal account may differ from the secret account; the full secret ARN and version remain independently pinned.
Identity, region, partition, resource, and version mismatches fail closed.

`secretInput.consumer.argv` supplies an absolute executable followed by literal public arguments.
`secretInput.consumer.cwd` supplies the absolute local working directory.
No shell expands these arguments.
Approval binds the full AWS reference, expected identity, exact argv/cwd, input transformations, timeout, and fixed input/output limits.
Any request, session, or settings change invalidates earlier approval.
Native AWS policy and command guards apply to internal AWS operations.
The receiver also requires bash/exec policy and command-guard approval for its properly quoted exact command.
Denials are not bypassed.
Each actual SDK dispatch rechecks current authority, settings, and guards.
A distinct consumer admission repeats these checks after secret retrieval without prompting.
Receiver denial, authority revision, or replacement while retrieval is pending prevents receiver execution.

### Input and authentication

Without `jsonPointer`, stdin contains exact SecretString UTF-8 bytes or SecretBinary bytes.
With `secretInput.jsonPointer`, an RFC 6901 pointer selects only a string leaf from parsed SecretString JSON.
`secretInput.appendNewline` defaults to `false`; `true` appends one newline.
The native route does not infer fields or combine credentials with application commands.
The receiver must already support this finite stdin channel and normal non-echoing configuration.
A receiver that requires another credential channel is unsupported.
Do not substitute secret argv, environment variables, files, memfds, named FIFOs, RAM disks, PTY injection, or a shell AWS fallback.

Input is limited to 65,536 bytes.
`maxStdoutBytes` and `maxStderrBytes` each bound retained output to 1,048,576 bytes: at most 2 MiB combined.
The default timeout is 30 seconds; `timeout` uses seconds and cannot exceed 120 seconds.
Per-stream truncation, exit, cancellation, timeout, and uncertain completion remain explicit.

One short-lived private worker owns provider credentials, the secret response, and input buffers until the consumer completes.
It uses official AWS SDK clients with one attempt and no automatic sign-in or retry.
Only explicit existing static profile credentials or an existing unexpired SSO token are supported.
Role chains, `credential_process`, web identity, custom endpoints, and ambient credential providers are unsupported.
Missing or expired authentication requires a separate explicit user-authorized operation, followed by fresh preflight and approval.
Ordinary AWS operations retain their existing authentication behavior.

### Output, cleanup, and disclosure limits

Consumer stdout and stderr are raw, agent-visible normal output and may persist in transcripts or artifacts.
They are not sanitized, masked, or interpreted as queries.
The receiver sees stdin and can intentionally print, store, or transmit it.
This feature protects delivery, not confidentiality against arbitrary receiving programs.
Do not enable receiver credential echo, history, or caches.

The consumer runs in a detached owned process group without a controlling terminal.
It receives no inherited AWS credential environment or private worker control descriptors.
The guardian starts in a fresh neutral owned directory with a minimal Bun startup environment that blocks project and global preloads.
Only the receiver uses the approved working directory, environment, and argv.
Stdin closes after the bounded input.
Delivery uses an actual anonymous pipe or unnamed Unix stream, not a runtime's typed-array-to-file optimization.
The input writer applies backpressure and closes the finite stream after all approved bytes.
Cancellation, timeout, and session disposal terminate and reap the owned consumer group and worker, close streams, and release owned references.
An independent owned finite-input guardian handles worker SIGKILL or disconnect and receiver leader exit while foreground descendants or pipes remain.
The intrinsic `await-cleanup` policy keeps admitted native invocations pending until owned teardown completes or reports an ownership failure.
There is no automatic retry or replacement.
Interrupted writes may already have committed; uncertain completion does not imply rollback or retry safety.
After worker execution starts, failures report `{ok:false,code,completion:"uncertain"}`; pre-run failures report only `{ok:false,code}`.
Successful `completion:"exited"` means process exit, not transaction atomicity or rollback.
Consumers that deliberately daemonize or escape the owned process group are outside the cleanup guarantee.
External forced termination of all independent owners and OS crashes also exceed that guarantee.
Lost ownership does not establish successful teardown.
Known receiver identities are recovered independently if the guardian exits.
Unproved cleanup returns `WORKER_FAILED`, and the affected native handler rejects later handoffs.
That error does not prove that every process exited.

Audit evidence contains only non-secret request bindings and lifecycle metadata, never a secret payload hash.
Provider and IPC errors expose fixed non-secret codes, not SDK diagnostic objects.
GC, immutable strings, SDK buffers, allocator copies, swap, core dumps, and privileged OS inspection prevent secure-erasure guarantees.

Source delivery does not publish an engine release or adopt an installed runtime.
Publication, immutable `engine.lock` adoption, matching package preflight, and operational authorization remain separate gates.
