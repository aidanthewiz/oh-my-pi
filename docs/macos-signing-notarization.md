# macOS signing and notarization

Coreforge macOS release assets use the compatibility filenames
`omp-darwin-arm64` and `omp-darwin-x64`. The release workflow can replace their
initial ad-hoc signatures with **Developer ID Application** signatures and
submit them for Apple notarization.

Signing runs in the Darwin matrix legs of
`.github/workflows/cf-release.yml` through `scripts/ci-macos-sign.sh`. The
workflow skips this step unless all five `APPLE_*` repository secrets exist.
Releases therefore remain ad-hoc signed until Coreforce provisions the signing
credentials. Calling the script directly without every credential is an error.

## Release flow

1. `ci:release:build-binaries` builds and ad-hoc signs the binary so it runs on
   the build host.
2. `scripts/ci-macos-sign.sh`:
   - imports the Developer ID certificate into a temporary keychain;
   - signs with the hardened runtime, secure timestamp, and
     `scripts/macos-entitlements.plist`;
   - runs `--version` and `--smoke-test` under the new signature;
   - submits the binary to Apple with `notarytool submit --wait`.
3. The `verify_release` job downloads the published arm64 asset, verifies the
   signature, and repeats both launch checks. When signing credentials exist,
   it also rejects an ad-hoc published signature.

The signing and notarization calls occur only in the explicit Coreforce release
workflow. They add no end-user telemetry or background network path.

## Required entitlements

The release is a Bun single-file executable. Its hardened-runtime signature
requires these entitlements:

| Entitlement | Reason |
| --- | --- |
| `com.apple.security.cs.allow-jit` | JavaScriptCore generates executable code at runtime. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | JavaScriptCore uses executable memory pages. |
| `com.apple.security.cs.disable-library-validation` | The binary extracts native addons and optional dynamic libraries at runtime. Those files do not share the main binary's Team ID. |

Without `disable-library-validation`, signing and notarization can succeed while
the first real command fails during native-addon loading. The signing script's
post-sign smoke test detects that failure before notarization.

## Stapling limitation

Apple does not support stapling a ticket to a bare Mach-O executable. The
notarization ticket exists on Apple's service and is keyed to the binary's code
directory hash, but a quarantined download needs network access for Gatekeeper
to retrieve it. `verify_release` reports `spctl` output without treating an
offline lookup failure as a signing failure.

An offline-distributable quarantined artifact would require a notarized and
stapled `.pkg` or `.dmg`. The current direct binary release does not provide
that wrapper.

## Required GitHub secrets

Configure all five secrets under **Coreforce-CAD/oh-my-pi → Settings → Secrets
and variables → Actions**:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | Base64-encoded Developer ID Application `.p12` containing the certificate and private key. |
| `APPLE_CERTIFICATE_PASSWORD` | Password used to export the `.p12`. |
| `APPLE_API_KEY_ID` | App Store Connect API key ID. |
| `APPLE_API_ISSUER_ID` | App Store Connect API issuer UUID. |
| `APPLE_API_KEY` | Base64-encoded App Store Connect `.p8` private key. |

All five values must exist before signing activates.

## Prepare and upload credentials

Use Keychain Access to export a **Developer ID Application** identity, including
its private key, as a password-protected `.p12`. Create and download an App
Store Connect API key. Apple permits that `.p8` download only once.

Store these files in a local untracked directory, for example
`~/coreforge-signing`:

| File | Purpose |
| --- | --- |
| `*.p12` | Developer ID certificate and private key. |
| `p12-password.txt` | Export password. |
| `AuthKey_<KEYID>.p8` | App Store Connect API private key. |
| `issuer-id.txt` | App Store Connect issuer UUID. |
| `key-id.txt` | Optional key ID when it cannot be derived from the `.p8` filename. |

### Uploading without printing secret values

The upload helper validates the files and passes each value to `gh secret set`
over standard input. It does not print secret values or place them in process
arguments:

```sh
scripts/ci-macos-upload-secrets.sh ~/coreforge-signing --dry-run
scripts/ci-macos-upload-secrets.sh ~/coreforge-signing
gh secret list --repo Coreforce-CAD/oh-my-pi
```

Re-run the helper when the certificate or API key changes.

## Local validation

On macOS, export the five variables and run:

```sh
RELEASE_TARGETS=darwin-arm64 bun run ci:release:build-binaries
APPLE_CERTIFICATE_P12=… APPLE_CERTIFICATE_PASSWORD=… \
APPLE_API_KEY_ID=… APPLE_API_ISSUER_ID=… APPLE_API_KEY=… \
  bash scripts/ci-macos-sign.sh packages/coding-agent/binaries/omp-darwin-arm64
```

The command performs real signing and notarization. Use only local credential
files or a secret manager; never write the values to tracked files.
