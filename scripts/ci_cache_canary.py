#!/usr/bin/env python3
"""Non-releasing Linux native build proof for the private S3 cache brokers."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

import ci_cache as cache

SLOT = "linux-x64-ubuntu-22.04"
TARGET = "linux-x64-baseline"
AUTH_NAMES = (
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
    "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
)


def require_builder():
    cache.require(os.environ.get("GITHUB_ACTIONS") == "true", "canary requires an isolated GitHub Actions builder")
    cache.require(os.environ.get("GITHUB_REPOSITORY") == cache.REPOSITORY, "unexpected canary repository")
    cache.require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "canary requires deliberate dispatch")
    cache.require(os.environ.get("GITHUB_REF") == "refs/heads/coreforge", "canary requires protected coreforge")
    expected = f"{cache.REPOSITORY}/.github/workflows/cf-cache-canary.yml@refs/heads/coreforge"
    cache.require(os.environ.get("GITHUB_WORKFLOW_REF") == expected, "unexpected canary workflow source")
    cache.require(platform.system() == "Linux" and platform.machine() == "x86_64", "canary requires Linux x64")
    present = [name for name in AUTH_NAMES if os.environ.get(name)]
    cache.require(not present, "builder received forbidden credential authority: " + ", ".join(present))
    auth_root = Path.home() / ".aws"
    cache.require(not auth_root.exists() or not any(auth_root.iterdir()), "builder has AWS profile material")
    head = subprocess.run(["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    cache.require(head == os.environ.get("GITHUB_SHA"), "builder checkout does not match dispatched source")
    return {"aws_credentials_absent": True, "oidc_request_authority_absent": True, "aws_profile_material_absent": True, "source_sha": head}


def native_build(rc, log):
    environment = dict(os.environ)
    environment["OMP_BAZEL_RC"] = str(rc)
    command = ["bun", "scripts/bazel-natives.ts", TARGET]
    with log.open("wb") as output:
        child = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            for block in iter(lambda: child.stdout.read(65536), b""):
                output.write(block)
                output.flush()
                sys.stdout.buffer.write(block)
                sys.stdout.buffer.flush()
            result = child.wait()
        except BaseException:
            child.kill()
            child.wait()
            raise
        finally:
            child.stdout.close()
    cache.require(result == 0, f"actual native build/probe failed with exit {result}")
    return log.read_text(errors="replace")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("cold", "warm"))
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--cold-receipt")
    arguments = parser.parse_args(argv)
    try:
        authority = require_builder()
        temporary = Path(os.environ["RUNNER_TEMP"])
        snapshot = Path(arguments.snapshot)
        identity_path = temporary / "cache-canary-identity.json"
        identity = cache.make_identity(SLOT)
        cache.atomic_json(identity_path, identity)
        disk = Path.home() / ".cache/omp-bazel-disk"
        repository = Path.home() / ".cache/omp-bazel-repo"
        for root in (disk, repository):
            cache.require(not root.exists() or not any(root.iterdir()), "canary cache root is not fresh: " + str(root))
        status = cache.read_json(snapshot / "status.json")
        if arguments.phase == "cold":
            cache.require(status.get("state") == "miss", "cold canary did not observe a confirmed S3 miss")
            cache.require(not (snapshot / "manifest.json").exists(), "cold namespace already contains a snapshot")
        else:
            cache.require(status.get("state") == "snapshot", "warm broker did not fetch a real S3 snapshot")
            cache.require(arguments.cold_receipt is not None, "warm canary requires cold consumer receipt")
        restored = cache.restore(identity_path, snapshot, disk, repository)
        cache.require(restored == (arguments.phase == "warm"), "canary restore did not match its cold/warm phase")
        incompatible_missed = False
        manifest = None
        if restored:
            manifest = cache.validate_manifest(cache.read_json(snapshot / "manifest.json"))
            alternate = {**identity, "slot": "canary-incompatible-linux-arm64"}
            alternate_path = temporary / "cache-canary-incompatible.json"
            cache.atomic_json(alternate_path, alternate)
            other_disk, other_repo = temporary / "incompatible-disk", temporary / "incompatible-repository"
            incompatible_missed = not cache.restore(alternate_path, snapshot, other_disk, other_repo)
            cache.require(incompatible_missed and not other_disk.exists() and not other_repo.exists(), "incompatible S3 snapshot crossed cache dimensions")
        disk.mkdir(parents=True, exist_ok=True)
        repository.mkdir(parents=True, exist_ok=True)
        rc = temporary / "cache-canary.bazelrc"
        lines = [
            f"startup --output_user_root={temporary / 'cache-canary-output'}",
            "common --config=ci",
            f"common --disk_cache={disk}",
            f"common --repository_cache={repository}",
            "build --jobs=2",
        ]
        if arguments.phase == "warm":
            lines.append("common --repository_disable_download")
        rc.write_text("\n".join(lines) + "\n")
        log = temporary / "cache-canary-build.log"
        build_log = native_build(rc, log)
        authority_after = require_builder()
        cache.require(authority_after == authority, "builder credential/source boundary changed during compilation")
        hits = sum(int(value) for value in re.findall(r"\b([0-9]+) disk cache hits?\b", build_log))
        if arguments.phase == "warm":
            cache.require(hits > 0, "warm native build did not consume restored disk actions")
        addon = Path("packages/natives/native/pi_natives.linux-x64-baseline.node")
        probe = (
            'import { verifyHostAddonLoads } from "./scripts/bazel-natives.ts";'
            'import { nativesPackageVersion } from "./scripts/stamp-native-version.ts";'
            'await verifyHostAddonLoads(process.argv[1], undefined, await nativesPackageVersion());'
        )
        subprocess.run(["bun", "-e", probe, str(addon.resolve())], cwd=Path(__file__).resolve().parent.parent, check=True, timeout=90)
        addon_sha = cache.digest_file(addon)
        if arguments.phase == "warm":
            cold = cache.read_json(arguments.cold_receipt)
            cache.require(cold.get("source_sha") == authority["source_sha"] and cold.get("slot") == SLOT, "cold receipt identity mismatch")
            cache.require(cold.get("addon_sha256") == addon_sha, "cold/warm native consumer bytes differ")
        bazel = shutil.which("bazelisk") or shutil.which("bazel")
        cache.require(bazel is not None, "Bazel launcher disappeared")
        subprocess.run([bazel, f"--bazelrc={rc}", "shutdown"], check=True)
        receipt = {
            "schema": 1, "phase": arguments.phase, "slot": SLOT, "target": TARGET,
            "source_sha": authority["source_sha"], "run_id": os.environ["GITHUB_RUN_ID"],
            "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"], "identity": identity,
            "dimension": cache.dimension(identity), "restored": restored,
            "confirmed_s3_miss": arguments.phase == "cold", "disk_cache_hits": hits,
            "repository_downloads_disabled": arguments.phase == "warm",
            "addon_sha256": addon_sha, "addon_load_probe": "passed explicit baseline load and version check",
            "incompatible_snapshot_missed": incompatible_missed,
            **authority,
        }
        if manifest is not None:
            receipt["s3_snapshot"] = {key: manifest[key] for key in ("slot", "dimension", "sha256", "size", "source_sha", "run_id", "run_attempt")}
        if arguments.phase == "cold":
            cache.pack(identity_path, disk, repository, temporary / "cache-snapshot")
        cache.atomic_json(temporary / f"cache-canary-{arguments.phase}.json", receipt)
        print(json.dumps({key: receipt[key] for key in ("phase", "slot", "source_sha", "restored", "disk_cache_hits", "repository_downloads_disabled", "addon_sha256", "aws_credentials_absent", "oidc_request_authority_absent")}, sort_keys=True))
        return 0
    except (cache.CacheError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"Canary error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
