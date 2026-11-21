# Durable CI cache: governed setup and verification

The cache uses ephemeral build runners and private S3 snapshots. It does not replace build, test, qualification, signing, or release gates.

## Infrastructure authority

[`Coreforce-CAD/github-org-management/iam/omp_cache.tf`](https://github.com/Coreforce-CAD/github-org-management/blob/main/iam/omp_cache.tf) owns the cache bucket, runtime roles, and narrowly scoped Terraform administration grants. The existing protected `iam/` plan/apply workflow owns deployment and state. Do not create competing manual resources or use the application Terraform stacks.

| Input | Governed value |
| --- | --- |
| Account | `800128555654` |
| Partition | `aws-us-gov` |
| Region | `us-gov-west-1` |
| Bucket | `coreforge-ci-cache-800128555654-us-gov-west-1` |
| Prefix | `omp-bazel-v1` |
| Read role | `arn:aws-us-gov:iam::800128555654:role/CoreforgeOmpCacheRead` |
| Write role | `arn:aws-us-gov:iam::800128555654:role/CoreforgeOmpCacheWrite` |

These are intended resource identities, not evidence that an unapplied infrastructure PR has created them. Require successful governed apply and authoritative readback before a canary.

The bucket blocks all public access, requires BucketOwnerEnforced ownership and TLS, and uses SSE-S3 `AES256`. It has `prevent_destroy`, no force deletion, and only incomplete-multipart cleanup after one day. No lifecycle rule expires usable snapshots. Existing release/artifact buckets and the shared OIDC provider are unchanged.

## Compatible GitHub OIDC

AWS IAM supports GitHub's `job_workflow_ref` directly in role trust. Cache roles require all of these conditions:

- Audience `sts.amazonaws.com`.
- Immutable repository ID `1291753113` and owner ID `259898564`.
- Exact `Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-read.yml@<BROKER_SHA>` or corresponding write workflow.
- The existing default subject and allowed ref context. Only readers admit PR refs; writers admit protected `coreforge` or validated engine/relay release tags.

`<BROKER_SHA>` is the reviewed immutable 40-character source revision sealed in governed IAM and every caller. Updates require matching reviewed source and IAM changes; never wildcard the workflow ref.

**Do not customize the repository subject template.** Keep `use_default=true` and the existing provider audience/thumbprints. The default relay AWS subject and cosign issuer/certificate identity remain unchanged. A new audience alone is not a workflow identity boundary: arbitrary code can request that audience. A direct non-broker token must fail both cache-role assumptions.

Broker jobs check out only protected `coreforge` helper code. They validate actual source/event/run/attempt, repository IDs, caller workflow, completed predecessors, and artifact provenance before requesting AWS credentials. Builders never receive AWS credentials or OIDC request authority.

## Runtime permissions

The read role can read only cache references, manifests, and immutable archives. It can list only the exact-pointer lookup prefixes under `omp-bazel-v1/refs/*` and `omp-bazel-v1/canary/*/refs/*`. This bounded lookup distinguishes a confirmed missing object from ambiguous S3 `AccessDenied`; access failures are never called misses.

The writer can get/put cache data and abort its multipart uploads. It can delete only obsolete manifests, archives, and retirement markers under the cache prefix. It cannot delete current references, administer the bucket, read secrets, mutate IAM, or access another bucket. Prefix-scoped listing supports immutable-object existence checks and pruning. Runtime roles have no ACL permissions. Terraform administration has separate exact-bucket configuration/refresh grants, not object-data access.

## Repository configuration

After governed resources exist, set these non-secret variables:

```text
CI_CACHE_BUCKET=coreforge-ci-cache-800128555654-us-gov-west-1
CI_CACHE_REGION=us-gov-west-1
CI_CACHE_PREFIX=omp-bazel-v1
CI_CACHE_READ_ROLE=arn:aws-us-gov:iam::800128555654:role/CoreforgeOmpCacheRead
CI_CACHE_WRITE_ROLE=arn:aws-us-gov:iam::800128555654:role/CoreforgeOmpCacheWrite
CI_CACHE_ENABLED=false
```

Staging these values does not enable the backend. Never store static AWS keys, tokens, or profile files in variables, source, logs, or artifacts. Set `CI_CACHE_ENABLED=true` only after the protected-source cloud canary succeeds and the resource/trust readback matches governed source.

## Non-releasing real-cloud canary

`cf-cache-canary.yml` accepts only deliberate dispatch from protected `coreforge`. It publishes no release, tag, package, image, or application deployment. The workflow must first exist on the protected default branch; a feature-only source proposal is not an operational cache.

1. Apply the approved infrastructure change through its existing protected plan/apply path.
2. Merge approved source through required independent/latest-push review and an authorized merge commit. Compare the candidate with the latest published engine ancestor using the actual classifier. For a cache-only `false` result, retain `should_release=false` without allocating an engine tag. A release-significant `true` result requires explicit normal-publication authority and successful signed release verification before the canary. Never broaden classifier exemptions or bypass publication gates.
3. Verify bucket controls, exact IAM workflow pins, default OIDC metadata, and cache variables while `CI_CACHE_ENABLED=false`.
4. Dispatch the bounded verification:

   ```sh
   gh workflow run cf-cache-canary.yml --repo Coreforce-CAD/oh-my-pi --ref coreforge
   ```

5. Require the entire run to succeed before enablement.

Canary broker failures are fatal, including pruning after a usable snapshot is published.
Production cache failures remain optional and cannot change the original build or release result.

The non-releasing exemption admits only explicit cache documentation/workflows and direct cache-helper/test namespaces. The release workflow additionally requires identical non-cache semantics after removing owned cache jobs/steps, exact cache status conditions, and the marked cache-publication region. Native commands, signing, matrices, permissions, admission, and tag allocation remain significant.

The baseline is the latest published roll in the current package family, not an unpublished tag or the merge's first parent. Pending runtime, mixed, unknown, renamed/deleted artifact input, and empty diffs retain the normal release decision. A missing published baseline cannot suppress publication. Git, metadata, and parse errors abort preparation.

The classifier runs after merged-PR/current-tip checks and before branch release-tag allocation. It never handles the manual tag path.

Each fresh dispatch creates `omp-bazel-v1/canary/probe-<run-id>-<attempt>/`. Use a fresh dispatch rather than reusing stale snapshot artifacts from a failed attempt.

The canary proves:

- A real GitHub OIDC token from a non-broker job receives IAM `AccessDenied` for both roles. Network, invalid-token, and configuration failures do not count as successful denials.
- The read broker's actual OIDC claims and STS role match the intended identities. Tokens are never persisted or logged; receipts include only allowlisted claims.
- A confirmed S3 miss runs the canonical `linux-x64-baseline` native build and addon load probe in a credential-free builder.
- The same production writer broker validates the successful cold job and same-run/attempt snapshot, then publishes to the derived canary prefix and prunes safely.
- A separate runner restores the real S3 archive, rejects an incompatible identity, and rebuilds/loads the same native addon with `--repository_disable_download` and observed disk-cache hits.
- Cold and warm addon hashes agree. Build receipts verify AWS keys, profiles, and OIDC request authority are absent before and after compilation.

Receipts are `cache-canary-trust-denial`, `cache-canary-cold-consumer`, `cache-canary-warm-consumer`, reader transfer `receipts/`, and `cache-write-receipts-canary-<id>`. The source SHA, run ID/attempt, snapshot digest/size, exact role, and actual cache hits are evidence. A version string or a local administrator upload is not this proof.

No Linux proof qualifies Darwin, musl, Windows, or deployed performance/cost. Existing platform qualification remains authoritative. Optional cache jobs must not transitively skip full qualification or release work; downstream jobs explicitly require successful original predecessors while tolerating a skipped optional cache job.

## Cache contents and restore order

Only the existing Bazel `--disk_cache` and `--repository_cache` roots are snapshotted: `~/.cache/omp-bazel-disk` and `~/.cache/omp-bazel-repo`. Allowlisted contents are regular action/CAS files, repository downloads, and zero-byte canonical-ID markers. Output bases, extracted repository trees, logs, credentials/profiles, signing material, and unrelated workspaces are excluded. Windows ARM64 and full Rust qualification retain Cargo ownership.

Compatibility separates target/runner, actual OS/architecture, Bazel 9.2.0, compiler/SDK/tool identities, pinned toolchains, native configuration, and snapshot format. Native source and commit SHAs do not partition the durable cache; Bazel action hashes invalidate changed inputs.

S3 restores first. A confirmed miss or incompatible snapshot falls back to the identity-scoped GitHub hot cache, then the real cold build. Corrupt, partial, denied, or unreachable snapshots produce scoped warnings. They never skip required work or convert failed builds into success.

Generated Bazel configuration scopes `--config=ci` to `build`, not `common`. The named configuration contains build options and does not apply to `shutdown`. Release and relay builders shut down the same Bazel server before packing its cache; a failed shutdown prevents snapshot publication.

Archives/manifests are immutable; current references update last. Restore checks identity, size/SHA256, and every member before atomically replacing either root with rollback. GNU tar long names support valid SHA-512 repository paths; traversal, duplicate paths, links, devices, sparse entries, and unapproved layouts are rejected.

## Retention and cleanup

Every successful publication runs `python3 scripts/ci_cache.py prune --keep 2 --apply`. Pruning retains current references plus two historical generations per compatibility dimension. A retirement marker is written before a current reference changes and completed afterward. Previously current data receives a full 24-hour reader grace after supersession, even after long idle periods. Interrupted pending markers retain their targets safely; malformed or incomplete metadata stops deletion.

Review an explicit plan before retiring an obsolete noncurrent dimension:

```sh
python3 scripts/ci_cache.py prune --keep 2 --retire '<SLOT>/<DIMENSION>'
python3 scripts/ci_cache.py prune --keep 2 --retire '<SLOT>/<DIMENSION>' --apply
```

Use the writer's prefix-scoped authority and serialize maintenance with publisher concurrency group `cf-durable-cache-publish`. An external maintenance session must exclude concurrent publishers; GitHub cannot serialize an unrelated external process.

After retaining canary receipts, remove only its exact owned S3 namespace through the approved native operational route. Runtime writers intentionally cannot delete references. Preserve production snapshots and unrelated data. Do not enable versioning or add lifecycle expiration without a governed retention design.

## Focused source verification

```sh
python3 -m unittest discover -s scripts -p 'test_ci_cache*.py'
```

The permanent suite covers actual authorization predicates, source/run/attempt boundaries, denied or malformed S3 existence lookups, safe archive/restore/publication, reader grace after supersession, and explicit pruning. Source tests do not establish live S3/OIDC deployment; retain real cloud canary receipts separately.

## Primary references

- [AWS IAM GitHub-specific OIDC condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_iam-condition-keys.html#condition-keys-wif)
- [AWS required shared-provider controls](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc_secure-by-default.html)
- [GitHub reusable-workflow OIDC claims](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)
- [GitHub cache inactivity eviction](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)
- [Bazel 9.2 repository cache](https://github.com/bazelbuild/bazel/blob/9.2.0/src/main/java/com/google/devtools/build/lib/bazel/repository/cache/DownloadCache.java)
