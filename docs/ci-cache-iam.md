# Durable CI cache: owner setup and IAM

This cache is **unconfigured and disabled** until owners complete every gate below. This document does not authorize infrastructure changes.

The cache stores only Bazel disk and repository snapshots. It does not replace build, release, relay, signing, or verification gates. Build jobs receive inert GitHub artifacts, never AWS credentials. The reusable brokers execute `scripts/ci_cache.py` from protected `coreforge`, not PR code.

## Required owner parameters

Choose these values explicitly. There are no production defaults.

| Parameter | Meaning |
| --- | --- |
| `<PARTITION>` | Verified AWS partition, such as `aws` or `aws-us-gov` |
| `<ACCOUNT_ID>` | Verified cache account ID |
| `<REGION>` | Bucket and STS region in that partition |
| `<BUCKET>` | Dedicated private cache bucket name |
| `<PREFIX>` | Dedicated cache prefix without leading or trailing `/`, such as `omp-bazel-v1` |
| `<READ_ROLE>` | Role name for immutable read broker only |
| `<WRITE_ROLE>` | Role name for immutable write broker and controlled pruning only |
| `<BROKER_SHA>` | Full 40-character commit SHA containing the reviewed reusable brokers |

After setup, configure repository variables:

```text
CI_CACHE_BUCKET=<BUCKET>
CI_CACHE_REGION=<REGION>
CI_CACHE_PREFIX=<PREFIX>
CI_CACHE_READ_ROLE=arn:<PARTITION>:iam::<ACCOUNT_ID>:role/<READ_ROLE>
CI_CACHE_WRITE_ROLE=arn:<PARTITION>:iam::<ACCOUNT_ID>:role/<WRITE_ROLE>
CI_CACHE_ENABLED=false
```

Do not store static AWS credentials. Do not add AWS permissions to builders. The broker overrides configured AWS endpoints and does not load local credential/configuration files.

## Enablement gates

1. Merge the helper and brokers into protected `coreforge` through the required review process.
2. Push the signed broker commit before creating callers that reference its immutable SHA.
3. Pin every caller `uses:` to `Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-read.yml@<BROKER_SHA>` or `cf-cache-write.yml@<BROKER_SHA>`.
4. Verify that `<BROKER_SHA>` contains the reviewed broker code. Never replace this pin with a branch or tag.
5. Require protected `coreforge` reviews for helper changes. The helper deliberately follows this protected branch, not `<BROKER_SHA>`.
6. Complete the relay/cosign OIDC compatibility migration below before changing the repository OIDC subject template.
7. Provision the private bucket, OIDC provider, and the two scoped roles after verifying the account and partition.
8. Validate the resulting OIDC claims and role restrictions in the owner's controlled qualification procedure.
9. Validate cold builds, cache hits, corruption fallback, publication refusal, and retention without weakening existing gates.
10. Set `CI_CACHE_ENABLED=true` only after every prerequisite succeeds.

An immutable broker upgrade requires a reviewed SHA, matching IAM trust updates, and caller pin updates. Keep old trust only while approved callers still need it. Never add a wildcard workflow SHA.

### Repository OIDC compatibility blocker

GitHub's default subject does **not** bind AWS trust to a reusable workflow. A repository owner must opt this repository into a custom subject:

```json
{
  "use_default": false,
  "include_claim_keys": ["repo", "context", "job_workflow_ref"]
}
```

`context` expands to `pull_request`, `ref:refs/heads/coreforge`, or `ref:refs/tags/<tag>` when no environment is declared. `job_workflow_ref` identifies the **called reusable workflow**, including the immutable SHA. `workflow_ref` identifies the caller; it is not a substitute for `job_workflow_ref`.

The resulting read PR subject is:

```text
repo:Coreforce-CAD/oh-my-pi:pull_request:job_workflow_ref:Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-read.yml@<BROKER_SHA>
```

The resulting branch writer subject is:

```text
repo:Coreforce-CAD/oh-my-pi:ref:refs/heads/coreforge:job_workflow_ref:Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-write.yml@<BROKER_SHA>
```

Subject values containing `:` use GitHub's `%3A` encoding inside claim values. The values shown here need no such encoding. Do not add job environments without reviewing their changed `context` subjects and trust.

**Do not apply this template now.** It changes OIDC issuance for the entire repository. Existing `relay.yml` publishes to ECR through `SomaPlatformProdRelayPublish` and performs keyless cosign signing in a non-reusable job. Such jobs lack `job_workflow_ref`; a template requiring it can prevent token issuance, not merely change the AWS subject. Updating the relay role's old subject alone is insufficient.

The owner must first design, review, and qualify compatible reusable relay publication/signing or another GitHub-supported subject migration. Preserve the existing relay role's release restrictions, ECR scope, cosign certificate identity, issuer verification, and required release gates. Confirm both AWS STS and the Sigstore/Fulcio token path remain compatible. Inventory other OIDC consumers before applying a repository-wide change. This PR changes neither relay publication code nor live OIDC configuration. Until that migration is complete, leave this cache disabled; never weaken its trust to the default repository-only subject.

## OIDC role trust

Create or reuse the account's provider for `https://token.actions.githubusercontent.com`, with audience `sts.amazonaws.com`. Use the following read-role trust policy after replacing every placeholder:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:<PARTITION>:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com"},
      "StringLike": {
        "token.actions.githubusercontent.com:sub": [
          "repo:Coreforce-CAD/oh-my-pi:pull_request:job_workflow_ref:Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-read.yml@<BROKER_SHA>",
          "repo:Coreforce-CAD/oh-my-pi:ref:refs/heads/coreforge:job_workflow_ref:Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-read.yml@<BROKER_SHA>",
          "repo:Coreforce-CAD/oh-my-pi:ref:refs/tags/v*.*.*.*:job_workflow_ref:Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-read.yml@<BROKER_SHA>",
          "repo:Coreforce-CAD/oh-my-pi:ref:refs/tags/relay/v*:job_workflow_ref:Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-read.yml@<BROKER_SHA>"
        ]
      }
    }
  }]
}
```

The writer uses the same provider and audience, but only these subjects:

```json
[
  "repo:Coreforce-CAD/oh-my-pi:ref:refs/heads/coreforge:job_workflow_ref:Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-write.yml@<BROKER_SHA>",
  "repo:Coreforce-CAD/oh-my-pi:ref:refs/tags/v*.*.*.*:job_workflow_ref:Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-write.yml@<BROKER_SHA>",
  "repo:Coreforce-CAD/oh-my-pi:ref:refs/tags/relay/v*:job_workflow_ref:Coreforce-CAD/oh-my-pi/.github/workflows/cf-cache-write.yml@<BROKER_SHA>"
]
```

AWS wildcard matching is not a SemVer validator. The pinned broker independently verifies the event, exact caller workflow path and SHA, ref syntax, tag commit, and current protected branch tip before assuming the role. Do not add PR writer trust or trust another repository. Restrict role sessions to the short duration needed for these broker jobs.

## Bucket and role permissions

Enable all four S3 Block Public Access controls. Use Object Ownership `BucketOwnerEnforced`; do not grant ACL permissions. Enable default SSE-S3 encryption with `AES256`. Keep this cache separate from release assets, credentials, and production data.

Read-role identity policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "s3:GetObject",
    "Resource": [
      "arn:<PARTITION>:s3:::<BUCKET>/<PREFIX>/refs/*",
      "arn:<PARTITION>:s3:::<BUCKET>/<PREFIX>/manifests/*",
      "arn:<PARTITION>:s3:::<BUCKET>/<PREFIX>/objects/*"
    ]
  }]
}
```

The reader needs no `ListBucket`, write, delete, KMS, or access outside this prefix. With this permission, S3 can report an absent key as HTTP 403 rather than 404. The helper must treat that ambiguous response as a visible cache error, not a confirmed miss. A new empty bucket may therefore produce a warning and a cold build until the first trusted publication. Do not grant bucket listing merely to hide that distinction.

Writer identity policy, including explicit cache-only pruning:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": [
        "arn:<PARTITION>:s3:::<BUCKET>/<PREFIX>/refs/*",
        "arn:<PARTITION>:s3:::<BUCKET>/<PREFIX>/manifests/*",
        "arn:<PARTITION>:s3:::<BUCKET>/<PREFIX>/objects/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "s3:DeleteObject",
      "Resource": [
        "arn:<PARTITION>:s3:::<BUCKET>/<PREFIX>/manifests/*",
        "arn:<PARTITION>:s3:::<BUCKET>/<PREFIX>/objects/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:<PARTITION>:s3:::<BUCKET>",
      "Condition": {"StringLike": {"s3:prefix": ["<PREFIX>/", "<PREFIX>/*"]}}
    }
  ]
}
```

`DeleteObject` is limited to immutable cache data because the writer runs the validated `prune` command. It cannot delete references, the bucket, other prefixes, or object versions. `AbortMultipartUpload` permits cleanup of interrupted archive uploads. Do not grant `s3:*`, bucket administration, `DeleteObjectVersion`, or unrelated service permissions.

Use this dedicated bucket policy in addition to the role policies:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:<PARTITION>:s3:::<BUCKET>", "arn:<PARTITION>:s3:::<BUCKET>/*"],
      "Condition": {"Bool": {"aws:SecureTransport": "false"}}
    },
    {
      "Sid": "RequireExplicitSSES3ForCacheWrites",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:<PARTITION>:s3:::<BUCKET>/<PREFIX>/*",
      "Condition": {"StringNotEquals": {"s3:x-amz-server-side-encryption": "AES256"}}
    }
  ]
}
```

Do not add public or cross-account allow statements. If the owner requires additional organization or endpoint restrictions, qualify those restrictions without widening these grants.

## Retention and controlled maintenance

Objects are content-addressed. Manifests identify successful generations. The publisher updates `refs/<slot>/current.json` only after immutable archive upload and validation.

Every successful broker publication runs:

```sh
python3 scripts/ci_cache.py prune --keep 2 --apply
```

Pruning preserves every current reference and the newest two historical manifests per compatibility dimension. A 24-hour grace protects in-flight transfers. Invalid references or incomplete listings stop deletion. Retention does not depend on cache activity or object age alone.

Review a dry-run plan before explicitly retiring an obsolete, noncurrent dimension:

```sh
python3 scripts/ci_cache.py prune --keep 2 --retire '<SLOT>/<DIMENSION>'
python3 scripts/ci_cache.py prune --keep 2 --retire '<SLOT>/<DIMENSION>' --apply
```

Run owner maintenance only with the same prefix-scoped permissions and serialization as publication. The broker uses concurrency group `cf-durable-cache-publish` with cancellation disabled. An external maintenance session must exclude concurrent broker publishers; GitHub's concurrency group cannot serialize an external process automatically.

Do not configure lifecycle expiration for snapshots, manifests, or references. Optional lifecycle cleanup may abort incomplete multipart uploads after one day. For a new dedicated bucket, leave versioning disabled unless the owner also supplies a separate noncurrent-version retention policy. The writer deliberately lacks permanent version deletion.

## Broker interfaces and failure behavior

`cf-cache-read.yml` accepts `slots` (required JSON array of valid slot strings) and `enabled` (boolean, default `false`). It has no scalar workflow outputs. For each enabled slot it uploads `cache-restore-<slot>` with one-day retention. A valid snapshot contains `manifest.json` and `snapshot.tar.gz`. `status.json` records the transfer outcome, including misses/errors; it is not evidence of an identity-compatible hit. Consumers perform the helper's full restore validation. Missing manifests mean a cold build.

The reader checks the actual repository, event, and protected base before checkout or OIDC. It never checks out the PR source. Disabled operation needs no credentials. Incomplete enabled configuration, STS failures, fetch failures, and artifact-transfer failures produce cache-only warnings, never invented hits.

`cf-cache-write.yml` accepts `enabled` (boolean, default `false`), `source-sha` (required full commit SHA), `expected-workflow` (required `cf-release` or `relay`), and `build-result` (required string). It has no workflow outputs. `build-result=success` is necessary but insufficient.

Before OIDC, the writer queries GitHub for the actual run attempt, event, repository, head SHA, workflow ID/path, and current `coreforge` tip. Tags must resolve to that same commit. The writer requires these completed-success predecessor jobs:

- `cf-release`: `prepare`, all eight `build (<target>)` jobs, `release`, and `verify_release`.
- `relay`: `validate` and `publish`.

The writer accepts only the expected `snapshot-*` artifacts from the same run and validates manifest source SHA, run ID, attempt, and slot. It downloads no caller-selected run, executes no artifact, and checks out only protected `coreforge`. Reruns must regenerate every required snapshot for the current attempt; older artifacts cannot authorize publication.

Release snapshot slots are `darwin-arm64-xcode-27`, `darwin-x64-macos-15-intel`, `linux-x64-ubuntu-22.04`, `linux-arm64-ubuntu-24.04-arm`, `linux-musl-x64-ubuntu-22.04`, `linux-musl-arm64-ubuntu-24.04-arm`, and `win32-x64-ubuntu-24.04`. Relay uses `linux-x64-ubuntu-24.04`. Windows ARM64 remains a required release gate but uses Cargo, not this cache.

Only the dedicated broker jobs request `id-token: write`. The writer additionally needs `actions: read` for authoritative provenance checks. Neither broker has `contents: write`. Cache publication failure remains visible in annotations and the step summary, but cannot convert a failed original gate into success. Callers must retain their original `needs` and failure conditions independently of these cache jobs.

## Observed local qualification

- Python 3.15.2: all 28 cache regression tests passed, including long SHA-512 repository paths, integrity failures, atomic rollback, trust refusal, and retention.
- Ten subprocess scenarios executed the actual writer's pre-OIDC guard against exact synthetic GitHub API responses. Unknown network destinations were forbidden.
- A real Bazel 9.2.0 C compilation used a loopback HTTP header dependency and separate cold/warm output bases. Restored disk and repository caches produced `1 disk cache hit` with `--repository_disable_download` and the HTTP fixture stopped.
- The warm executable returned `42`; changed source returned `43`; a cache miss fetched the dependency and compiled a working executable.
- Snapshot archives use GNU tar long-name support for valid SHA-512 paths. Extraction still rejects traversal, duplicate paths, links, special files, sparse entries, and unapproved payload layouts.
- Storage publication used the isolated filesystem object-store interface, not AWS. No OIDC token, STS role, real S3 transfer, hosted native matrix, or deployed speed/cost claim was qualified locally.

## Primary references

- [GitHub OIDC reusable-workflow claims](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)
- [GitHub subject customization](https://docs.github.com/en/actions/reference/security/oidc#customizing-the-subject-claims-for-an-organization-or-repository)
- [GitHub cache inactivity eviction](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)
- [Bazel 9.2 disk cache layout](https://github.com/bazelbuild/bazel/blob/9.2.0/src/main/java/com/google/devtools/build/lib/remote/disk/DiskCacheClient.java)
- [Bazel 9.2 repository download cache](https://github.com/bazelbuild/bazel/blob/9.2.0/src/main/java/com/google/devtools/build/lib/bazel/repository/cache/DownloadCache.java)
- [S3 SSE-S3 and multipart encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-s3-encryption.html)
