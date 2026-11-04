# Contributing to the Coreforge engine fork

This repository is `Coreforce-CAD/oh-my-pi`, Coreforce's engine fork.
Upstream contributor admission and authorship requirements do not govern this fork.

## Scope and workflow

- Keep each pull request focused on the requested change.
- Target `coreforge`. The `main` branch mirrors upstream.
- Sign commits. Follow branch protection and required review rules.
- Preserve existing code conventions and required attribution.
- Use `.github/PULL_REQUEST_TEMPLATE.md`. Generated explanations are allowed.
- Human-authored sentences and manual contributor approval are not publication prerequisites.
- Merge only when the user authorizes the merge.

## Verification

Run the relevant checks and exercise the changed behavior.
Report the exact scenario and observed result in `Testing`.
Identify skipped checks and environment blockers. Do not mark them as successful.
Update each affected package's `[Unreleased]` changelog for user-facing changes.
Read back the published pull request description and check only verified items.

Pull request verification uses Bun 1.4.4 in `cf-verify.yml` and `relay.yml`.
Release preparation and packaging also use Bun 1.4.4 without changing the embedded binary runtime.
The release binary compiler and container runtime have separate version contracts.
Qualify those distributions separately before changing their runtime versions.

`cf-verify` retains exact-head native and binary inputs for full engine qualification.
Hosted jobs run complete TypeScript and Rust checks, SDK consumers, synthetic databases, and isolated source/compiled runtime fixtures.
Visual artifacts retain current, historical reference, and peer images; inspection remains a separate evidence requirement.
Coreforge companion qualification runs in its own repository. Engine qualification needs no companion credentials.

## Durable native build caches

The seven Linux/macOS Bazel native jobs in `cf-verify` and `cf-release`, plus relay validation, support private-S3 snapshots.
Windows ARM64 and full Rust qualification use Cargo and retain their existing cache ownership.
No build, test, signing, qualification, or release command is replaced by a cache hit.

Snapshots contain only regular Bazel action/CAS files under `~/.cache/omp-bazel-disk` and repository downloads under `~/.cache/omp-bazel-repo`.
Zero-byte repository canonical-ID markers are included so downloaded archives remain reusable.
Output bases, extracted repository trees, logs, credentials, signing material, and user profiles are excluded.

Compatibility identities include target/runner slot, actual OS and architecture, Bazel 9.2.0, compiler/SDK/tool identities, and pinned toolchain/configuration inputs.
Native source files, dependency lock changes, and commit SHAs do not partition durable snapshots; Bazel action hashes invalidate changed inputs.
S3 restores first. A missing, incompatible, or rejected snapshot falls back to the identity-scoped GitHub hot cache, then a real cold build.
Cache-only failures produce warnings; they never skip required work or turn a failed build into success.

Build jobs receive verified snapshot data through one-day GitHub transfer artifacts, never AWS credentials.
Immutable reusable brokers execute only protected `coreforge` helper code.
The writer verifies the actual source, run attempt, successful predecessor graph, and same-run snapshot provenance before OIDC.
Engine publication waits for all eight platform builds, release publication, and `verify_release`.
Relay cache publication waits for successful validation and the existing guarded relay publication.
PR, `pull_request_target`, and `workflow_run` execution cannot publish shared snapshots.

`scripts/ci_cache.py` publishes immutable archives and manifests before updating each current reference.
Restore verifies the archive digest, complete identity, and every member before replacing either cache root.
Successful publication explicitly prunes obsolete generations, retaining every current snapshot plus two historical generations per dimension.
A full 24-hour grace after supersession protects in-flight readers, including long-idle snapshots. Owners explicitly retire noncurrent dimensions with `prune --retire`; inactivity never expires current snapshots.

The existing governed infrastructure workspace owns [the bucket, IAM roles, and setup procedure](docs/ci-cache-iam.md).
AWS trust uses exact immutable `job_workflow_ref` conditions directly; the repository's default OIDC subject and existing relay/cosign authentication remain unchanged.
Keep `CI_CACHE_ENABLED=false` until governed apply, protected source adoption, and the non-releasing `cf-cache-canary` cold/save/warm proof succeed.

Run `python3 -m unittest discover -s scripts -p 'test_ci_cache*.py'` for cache and real broker-guard boundaries.
Local qualification exercised a real Bazel 9.2.0 C build with isolated output bases and a loopback repository download.
Warm restore produced a disk-cache hit with repository downloads disabled; changed inputs rebuilt correctly, and a miss ran a real cold build.
These checks do not qualify live S3/OIDC, the native-addon matrix, or deployed performance.

## Dependency releases

A verified artifact-changing pull request merged into `coreforge` triggers an engine dependency release through `.github/workflows/cf-release.yml`.
Cache-only CI changes since the latest published engine ancestor do not allocate or publish an engine tag. Unreleased runtime changes retain the release path.
Changes to native build commands, signing, matrices, or release admission retain the release path, even inside the release workflow.
Manual four-part recovery tags retain their existing tip, package-version, and roll safeguards.
Coreforge installers use the exact release and checksums recorded in `engine.lock`.
Do not use upstream's `bun run release` for this fork's dependency channel.

## Contribution licensing

A contribution intentionally submitted for inclusion in OMP is licensed under
the MIT License.

This policy does not relicense third-party or vendored code. You must have the
right to submit your contribution and must preserve applicable copyright,
license, attribution, and notice material. Submitting a contribution does not
require signing a Contributor License Agreement (CLA) or certifying a
Developer Certificate of Origin (DCO).
