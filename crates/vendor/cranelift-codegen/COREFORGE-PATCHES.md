# Maintained Cranelift security backport

This directory contains the exact `cranelift-codegen` 0.116.1 registry source, plus the changes listed below.

- Archive: <https://static.crates.io/crates/cranelift-codegen/cranelift-codegen-0.116.1.crate>
- Archive SHA-256: `2c22032c4cb42558371cf516bb47f26cdad1819d3475c133e93c49f50ebf304e`
- Archive size: 1,051,844 bytes.
- Original VCS commit: `58282df898d79a787a726d829b166272dde155b9`.
- Original VCS path: `cranelift/codegen`.
- License: `Apache-2.0 WITH LLVM-exception`. Preserve the complete original `LICENSE` and source notices.

The original `.cargo_vcs_info.json`, manifests, lockfile, README and license remain unchanged. The archive contains 201 members. `BUILD.bazel`, `rustfmt.toml`, this provenance file and `patches/0001-full-value-indices.patch` are local additions.

`rustfmt.toml` uses the existing vendored-crate policy to preserve upstream source formatting. It does not exclude unit, integration or feature tests.

## Maintained source change

`patches/0001-full-value-indices.patch` records every change to `src/ir/dfg.rs` against the original archive. It backports the private `ValueDataPacked` representation from maintainer commit [ba8f7d70caa1825b7f64fa75cd9d03f4a438dae0](https://github.com/bytecodealliance/wasmtime/commit/ba8f7d70caa1825b7f64fa75cd9d03f4a438dae0). The representation retains full `u32` entity indices instead of narrowing them to 24 bits. Its tag and type fields remain 16 bits together.

This addresses the Cranelift bit-packing defect described in [GHSA-897f-g5gm-fmxm](https://github.com/bytecodealliance/wasmtime/security/advisories/GHSA-897f-g5gm-fmxm). It does not upgrade Wasmtime 29.0.1 or resolve all advisories against that runtime.

The same patch adds small direct representation tests around the former 24-bit boundary and the reserved sentinel. It also tests type changes without losing definition indices. The serialization roundtrip uses the existing optional `postcard` dependency under `incremental-cache`, which enables `enable-serde`. These tests do not compile malicious or oversized WebAssembly.

## Build ownership

The root Cargo workspace and patch declaration select this source for Cargo and Bazel. `BUILD.bazel` preserves the production feature set: `gimli`, `host-arch`, `std`, `timing`, and `unwind`.

The original `build.rs` must run for each target. It consumes `TARGET`, generates Rust and ISLE output into `OUT_DIR`, and supplies the ISA configuration and `ISLE_DIR`. Its build dependencies are `cranelift-codegen-meta` 0.116.1 and `cranelift-isle` 0.116.1. No generated host output replaces those inputs.

The Bazel build script sets `GIT_OPTIONAL_LOCKS=0` and `GIT_NO_REPLACE_OBJECTS=1`. It sets `GIT_DIR=.` to the non-repository crate directory. The original script then uses its package-version fallback without discovering host checkout metadata. No `.git` input is required.

Regenerate workspace locks and aliases from the root declarations. Preserve the license in distribution notices. Qualify the source through the repository's canonical Cargo, Bazel, native-addon and supported-target checks. Include debug and release boundary tests, `enable-serde` compilation, and `incremental-cache` serialization tests.

## Updating

1. Verify a replacement registry archive against its recorded checksum.
2. Preserve its original provenance and complete license.
3. Apply the maintained patch to that exact source, or remove it only when upstream provides the full index guarantee.
4. Update portable build dependencies and target features from the resolved graph.
5. Regenerate locks and aliases through the canonical root tools.
6. Qualify the actual linked source and the affected supported targets before claiming the correction is complete.
