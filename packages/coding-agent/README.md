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

## Memory-only AWS database inspection

`xd://aws_db` is a separate native device. It does not capture generic `aws` output.

1. Call `{"action":"capabilities"}` before authentication or access approval.
2. Require the exact host, lifecycle, execution, schema, worker, scope, read/sanitizer, TLS trust, SDK, and driver manifest.
3. Submit `inspect-automation-template` with that capability and an explicit launcher-selected profile.
4. Bind the expected account, partition, principal ARN, region, tenant, cluster, node, endpoint, database, and secret version.
5. Bind the distinct agency ID, automation ID, step ID, and limits.
6. Approve the exact immutable request once. Session grants do not replace this approval.

The active host must prove a non-null session identity, early disposal, session-change invalidation, and actual dispatcher cleanup support.
A matching worker module alone is insufficient. Unsupported or older embedding hosts fail before approval or provider work.
The manifest pins the loaded partition-specific Amazon RDS root material and qualified region table.
Unknown or uncovered regions fail before approval or provider work.

The device schema defines the complete strict request. Unknown fields fail closed.
Maximum limits are one definition, 65,536 bytes, and 10,000 milliseconds.
The fixed read joins `automations` and `automation_steps`, scoped by agency and both record IDs.
It inspects stored `query_text`; it never reads configuration or executes the saved template.
Known SQL and record-filter forms produce generic structure. Unsupported forms are withheld.

The scope uses official AWS SDK clients with one attempt and no automatic authentication.
It supports existing explicit static credentials and an unexpired, read-only SSO token.
It rejects role chains, `credential_process`, web identity, custom endpoints, and ambient credential providers.
Every internal AWS operation retains the `aws_db`, `aws`, and operation-specific native policy.
Command-guard asks require a separate approval for that step.

### Required verification metadata

Cluster, instance, and secret tags must contain `coreforge:tenant-id` with the expected tenant value.
The dedicated secret must also contain `coreforge:database-reader=true`.
These are fixed native policy keys, not caller-selected tag names.
Missing tags fail closed; source delivery does not establish that deployed resources have them.
The caller must bind the exact secret version that is currently `AWSCURRENT`.
The secret must bind the verified endpoint, port, database, and dedicated reader account.
The account must have only the definition-read grants accepted by the fixed database policy.
Unsupported engines, writable nodes, forwarding, executable views, and ambiguous resource bindings are denied.
TLS uses source-shipped production G1 roots from the official commercial, GovCloud, and China bundles, with exact hostname verification.
No AWS or database permission changes are part of this feature.

### Isolation, evidence, and limits

One short-lived process owns provider credentials, secret responses, database authentication, and raw definitions.
Its arguments and environment contain no credentials. Standard output and error are discarded.
A private empty startup directory isolates runtime configuration and is removed after process exit.
Bun crash uploads and the shared transpiler cache are disabled in that process.
Only validated capability data, bounded guard descriptors, and safe results cross its private IPC boundary.
The scope closes its physical connection and releases owned references before returning a result.
Cancellation and timeout stop the owned process without retry or replacement.
The intrinsic `await-cleanup` execution policy keeps outer device wrappers pending until owned teardown completes.
Results contain only capability/policy identifiers, approved limits, structural disposition, reader proof, and teardown evidence.
The approved request supplies the non-secret identity and resource audit binding.
There are no credential files, `capturePath`, raw-result artifacts, or shell AWS fallback.

Reader checks use the same physical connection before, during, and after the fixed read.
A read-only transaction and same-statement role predicate add protection.
The fixed session also sets and verifies the approved server execution deadline.
Local socket closure does not prove instantaneous remote statement cancellation.
Separated probes cannot exclude an unobserved transient role change atomically.
GC, immutable strings, SDK/driver buffers, allocator copies, privileged OS access, swap, and crash memory prevent secure-erasure guarantees.

This source change does not publish an engine release or update an installed Coreforge runtime.
Publication, immutable `engine.lock` adoption, matching managed skill/helper installation, and independent operational authorization remain separate gates.
No real credentials, production records, or SRI-704 evidence were collected for this implementation.
