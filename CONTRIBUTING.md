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

## Dependency releases

A verified pull request merged into `coreforge` triggers `.github/workflows/cf-release.yml`.
The workflow publishes a `v<upstream>.<roll>` engine dependency release.
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
