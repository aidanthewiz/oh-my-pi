import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HELPER = Path(__file__).with_name("ci_cache.py")
SPEC = importlib.util.spec_from_file_location("ci_cache", HELPER)
cache = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cache)

DISK_NAME = "cas/aa/" + "a" * 64
REPO_NAME = "content_addressable/sha256/" + "b" * 64 + "/file"
ID_NAME = "content_addressable/sha256/" + "b" * 64 + "/id-" + "c" * 64
CANARY_ENV = {
    "GITHUB_EVENT_NAME": "workflow_dispatch",
    "GITHUB_REF": "refs/heads/coreforge",
    "GITHUB_WORKFLOW_REF": cache.REPOSITORY + "/.github/workflows/cf-cache-canary.yml@refs/heads/coreforge",
    "CI_CACHE_CANARY_ID": "proof-123",
    "CI_CACHE_PREFIX": "omp-bazel-v1/canary/proof-123",
}
NOW = dt.datetime(2030, 1, 10, tzinfo=dt.timezone.utc)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ci-cache-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.environment = {
            "GITHUB_ACTIONS": "false",
            "GITHUB_REPOSITORY": cache.REPOSITORY,
            "GITHUB_EVENT_NAME": "push",
            "CACHE_BUILD_RESULT": "success",
            "GITHUB_SHA": "1" * 40,
            "GITHUB_RUN_ID": "100",
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_REF": "refs/heads/coreforge",
            "GITHUB_WORKFLOW_REF": cache.REPOSITORY + "/.github/workflows/cf-release.yml@refs/heads/coreforge",
            "PATH": os.environ.get("PATH", ""),
        }
        self.env = patch.dict(os.environ, self.environment, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.identity = {
            "schema": 1,
            "format": cache.FORMAT,
            "slot": "linux-x64-test",
            "bazel": "9.2.0",
            "host": {"os": "Linux", "arch": "x86_64", "version": "test-image-1"},
            "tools": {"cc": "test-cc-1"},
            "configuration": {".bazelrc": "d" * 64},
            "module_toolchains": ["rust-nightly-2026-10-06"],
            "native_environment": {},
        }
        self.identity_path = self.root / "identity.json"
        cache.atomic_json(self.identity_path, self.identity)
        self.disk = self.root / "disk"
        self.repo = self.root / "repo"
        self.write(self.disk / DISK_NAME, b"compiled action output")
        self.write(self.repo / REPO_NAME, b"repository download")
        self.write(self.repo / ID_NAME, b"")
        self.store = cache.LocalStore(self.root / "store")

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def snapshot(self, name="snapshot", generation="100", identity=None):
        os.environ["GITHUB_RUN_ID"] = generation
        if identity is not None:
            cache.atomic_json(self.identity_path, identity)
        snapshot = self.root / name
        manifest = cache.pack(self.identity_path, self.disk, self.repo, snapshot)
        return snapshot, manifest

    def publish(self, name="snapshot", generation="100", identity=None):
        snapshot, manifest = self.snapshot(name, generation, identity)
        cache.publish(snapshot, self.store)
        return snapshot, manifest

    @contextlib.contextmanager
    def publication_time(self, when):
        original_put = self.store.put
        def put(key, source, immutable=False):
            exists = self.store.path(key).exists()
            original_put(key, source, immutable)
            if not immutable or not exists:
                os.utime(self.store.path(key), (when.timestamp(),) * 2)
        with patch.object(cache, "timestamp", return_value=when.isoformat().replace("+00:00", "Z")), patch.object(self.store, "put", side_effect=put):
            yield

    def roots(self):
        disk, repo = self.root / "restored-disk", self.root / "restored-repo"
        self.write(disk / "sentinel", b"keep disk")
        self.write(repo / "sentinel", b"keep repo")
        return disk, repo

    def assert_roots_unchanged(self, disk, repo):
        self.assertEqual((disk / "sentinel").read_bytes(), b"keep disk")
        self.assertEqual((repo / "sentinel").read_bytes(), b"keep repo")
        self.assertEqual([path.name for path in disk.iterdir()], ["sentinel"])
        self.assertEqual([path.name for path in repo.iterdir()], ["sentinel"])

    def repack_archive(self, snapshot, entries):
        with tarfile.open(snapshot / "snapshot.tar.gz", "w:gz", format=tarfile.USTAR_FORMAT) as archive:
            for name, kind, body, link in entries:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.linkname = link
                info.size = len(body) if kind == tarfile.REGTYPE else 0
                archive.addfile(info, io.BytesIO(body) if info.isfile() else None)
        manifest = cache.read_json(snapshot / "manifest.json")
        manifest["sha256"] = cache.digest_file(snapshot / "snapshot.tar.gz")
        manifest["size"] = (snapshot / "snapshot.tar.gz").stat().st_size
        cache.atomic_json(snapshot / "manifest.json", manifest)
        return manifest

    def age_store(self):
        for row in self.store.listing():
            os.utime(self.store.path(row["key"]), ((NOW - dt.timedelta(days=2)).timestamp(),) * 2)

    def test_real_cli_roundtrip_restores_disk_repository_and_canonical_ids(self):
        snapshot, manifest = self.publish()
        fetched = self.root / "fetched"
        result = subprocess.run([sys.executable, str(HELPER), "fetch", "--slot", self.identity["slot"], "--output", str(fetched), "--local-store", str(self.store.root)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        disk, repo = self.roots()
        output = self.root / "github-output"
        os.environ["GITHUB_OUTPUT"] = str(output)
        result = subprocess.run([sys.executable, str(HELPER), "restore", "--identity", str(self.identity_path), "--snapshot", str(fetched), "--disk", str(disk), "--repo", str(repo)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((disk / DISK_NAME).read_bytes(), b"compiled action output")
        self.assertEqual((repo / REPO_NAME).read_bytes(), b"repository download")
        self.assertEqual((repo / ID_NAME).read_bytes(), b"")
        self.assertFalse((disk / "sentinel").exists())
        self.assertEqual(output.read_text().splitlines()[-1], "hit=true")
        self.assertEqual(cache.read_json(fetched / "manifest.json"), manifest)

    @unittest.skipUnless(sys.platform in ("linux", "darwin"), "Bazel cache builders run on Linux and macOS")
    def test_workflow_shutdown_allows_packing_a_restorable_cache(self):
        bazel = shutil.which("bazelisk") or shutil.which("bazel")
        bun = shutil.which("bun")
        self.assertIsNotNone(bazel, "workflow cache regression requires Bazel")
        self.assertIsNotNone(bun, "workflow cache regression requires Bun")
        repository = HELPER.resolve().parent.parent
        for workflow, job in (("cf-release.yml", "build"), ("relay.yml", "validate")):
            with self.subTest(workflow=workflow):
                parsed = subprocess.run(
                    [bun, "--no-env-file", "-e", "console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))"],
                    input=(repository / ".github/workflows" / workflow).read_text(),
                    capture_output=True, text=True, check=True, timeout=20,
                )
                steps = json.loads(parsed.stdout)["jobs"][job]["steps"]
                build = next(step for step in steps if step.get("name") == "Build native addon from Coreforge sources")
                pack = next(step for step in steps if step.get("id") == "cache-pack")
                setup, separator, _ = build["run"].partition("export OMP_BAZEL_RC=")
                self.assertTrue(separator, "native build must expose its generated Bazel configuration")
                root = self.root / workflow / "workspace"
                root.mkdir(parents=True)
                home, temporary = root.parent / "home", root.parent / "runner"
                home.mkdir()
                temporary.mkdir()
                (root / "MODULE.bazel").write_text('module(name = "cache_shutdown_test")\n')
                (root / ".bazelrc").write_text("build:ci --announce_rc\n")
                (root / ".bazelversion").write_bytes((repository / ".bazelversion").read_bytes())
                (root / "scripts").mkdir()
                (root / "scripts/ci_cache.py").symlink_to(HELPER.resolve())
                environment = {
                    **os.environ, "HOME": str(home), "RUNNER_TEMP": str(temporary),
                    "BAZELISK_HOME": str(self.root / "bazelisk"),
                }
                configured = subprocess.run(
                    ["bash", "-e", "-c", setup], cwd=root, env=environment,
                    capture_output=True, text=True, timeout=20,
                )
                self.assertEqual(configured.returncode, 0, configured.stderr)
                rc = temporary / "coreforge-bazel.rc"
                output_root = root.parent / "bazel-output"
                with rc.open("a") as stream:
                    stream.write(f"startup --output_user_root={output_root}\n")
                disk, repo = home / ".cache/omp-bazel-disk", home / ".cache/omp-bazel-repo"
                self.write(disk / DISK_NAME, b"compiled action output")
                self.write(repo / REPO_NAME, b"repository download")
                self.write(repo / ID_NAME, b"")
                cache.atomic_json(temporary / "cache-identity.json", self.identity)
                try:
                    started = subprocess.run(
                        [bazel, "--nosystem_rc", "--nohome_rc", f"--bazelrc={rc}", "info", "output_base"],
                        cwd=root, env=environment, capture_output=True, text=True, timeout=90,
                    )
                    self.assertEqual(started.returncode, 0, started.stderr)
                    self.assertFalse(
                        Path(started.stdout.strip()).resolve().is_relative_to(root.resolve()),
                        "Bazel output must remain outside the source workspace",
                    )
                    packed = subprocess.run(
                        ["bash", "-e", "-c", pack["run"]], cwd=root, env=environment,
                        capture_output=True, text=True, timeout=90,
                    )
                    self.assertEqual(packed.returncode, 0, packed.stdout + packed.stderr)
                finally:
                    closed = subprocess.run(
                        [bazel, "--ignore_all_rc_files", f"--output_user_root={output_root}", "shutdown"],
                        cwd=root, env=environment, capture_output=True, text=True, timeout=30,
                    )
                    self.assertEqual(closed.returncode, 0, closed.stderr)
                restored_disk, restored_repo = root / "restored-disk", root / "restored-repo"
                cache.restore(temporary / "cache-identity.json", temporary / "cache-snapshot", restored_disk, restored_repo)
                self.assertEqual((restored_disk / DISK_NAME).read_bytes(), b"compiled action output")
                self.assertEqual((restored_repo / REPO_NAME).read_bytes(), b"repository download")
                self.assertEqual((restored_repo / ID_NAME).read_bytes(), b"")

    def test_cold_miss_keeps_roots_and_writes_no_fake_manifest(self):
        fetched = self.root / "cold"
        self.assertFalse(cache.fetch(self.identity["slot"], fetched, self.store))
        self.assertFalse((fetched / "manifest.json").exists())
        disk, repo = self.roots()
        self.assertFalse(cache.restore(self.identity_path, fetched, disk, repo))
        self.assert_roots_unchanged(disk, repo)
        absent_disk, absent_repo = self.root / "absent-disk", self.root / "absent-repo"
        self.assertFalse(cache.restore(self.identity_path, fetched, absent_disk, absent_repo))
        self.assertFalse(absent_disk.exists())
        self.assertFalse(absent_repo.exists())

    def test_each_changed_dimension_is_a_clean_miss(self):
        snapshot, _ = self.snapshot()
        disk, repo = self.roots()
        for key, value in (("slot", "linux-arm64-test"), ("host", {"os": "Darwin"}), ("tools", {"cc": "test-cc-2"}), ("configuration", {".bazelrc": "e" * 64}), ("module_toolchains", ["new-nightly"])):
            with self.subTest(dimension=key):
                cache.atomic_json(self.identity_path, {**self.identity, key: value})
                self.assertFalse(cache.restore(self.identity_path, snapshot, disk, repo))
                self.assert_roots_unchanged(disk, repo)

    def test_corruption_never_changes_existing_roots_or_exposes_fetch(self):
        snapshot, manifest = self.publish()
        archive = self.store.path(cache.object_key(manifest))
        with archive.open("r+b") as target:
            target.seek(10)
            byte = target.read(1)
            target.seek(10)
            target.write(bytes([byte[0] ^ 1]))
        fetched = self.root / "corrupt-fetch"
        with self.assertRaises(cache.CacheError):
            cache.fetch(self.identity["slot"], fetched, self.store)
        self.assertFalse(fetched.exists())
        (snapshot / "snapshot.tar.gz").write_bytes(archive.read_bytes())
        disk, repo = self.roots()
        with self.assertRaises(cache.CacheError):
            cache.restore(self.identity_path, snapshot, disk, repo)
        self.assert_roots_unchanged(disk, repo)

    def test_missing_current_archive_is_error_not_cold_miss(self):
        _, manifest = self.publish()
        self.store.delete(cache.object_key(manifest))
        fetched = self.root / "missing-object"
        with self.assertRaisesRegex(cache.CacheError, "archive missing"):
            cache.fetch(self.identity["slot"], fetched, self.store)
        self.assertFalse(fetched.exists())

    def test_access_failure_is_not_a_cold_miss(self):
        class Denied(cache.LocalStore):
            def get(inner, key, destination):
                raise PermissionError("synthetic AccessDenied")
        output = self.root / "denied"
        with self.assertRaises(PermissionError):
            cache.fetch(self.identity["slot"], output, Denied(self.store.root))
        self.assertFalse(output.exists())

    def identity_fixture(self):
        root = self.root / "identity-workspace"
        for name in (".bazelrc", ".bazelversion", "rust-toolchain.toml", "bazel/defs.bzl", "bazel/clippy.bazelrc"):
            self.write(root / name, b"9.2.0\n" if name == ".bazelversion" else b"configuration\n")
        self.write(root / "MODULE.bazel", b'bazel_dep(name="rules_rust", version="0.71.3")\nrust.toolchain(versions=["nightly/2026-10-06"], sha256s={"rust.tar.xz": "abc"})\n')
        binary = self.root / "identity-bin"
        for tool in ("cc", "c++", "cmake", "ninja"):
            self.executable(binary / tool, "printf '%s\\n' '" + tool + " version 1'\n")
        for tool in ("rustc", "cargo"):
            self.executable(binary / tool, "printf invoked > '" + str(self.root / "rustup-was-invoked") + "'\nexit 1\n")
        return root, binary

    def executable(self, path, body):
        self.write(path, ("#!/bin/sh\n" + body).encode())
        path.chmod(0o755)

    def s3_fixture(self):
        remote = self.root / "synthetic-s3"
        data = remote / "data"
        data.mkdir(parents=True)
        control = remote / "control.json"
        cache.atomic_json(control, {})
        binary = self.root / "synthetic-bin" / "aws"
        self.write(binary, (f"#!{sys.executable}\n" + """import hashlib
import json
import os
from pathlib import Path
import sys

root = Path(os.environ["SYNTHETIC_S3_ROOT"])
data = root / "data"
control = json.loads((root / "control.json").read_text())
args = sys.argv[1:]
operation = args[1]

def argument(name):
    return args[args.index(name) + 1]

def deny(operation, code="AccessDenied"):
    print(f"An error occurred ({code}) when calling the {operation} operation: synthetic denial", file=sys.stderr)
    sys.exit(255)

if operation == "list-objects-v2":
    if control.get("deny_list") or control.get("deny_list_prefix") == argument("--prefix"):
        deny("ListObjectsV2")
    if "list_raw" in control:
        print(control["list_raw"])
        sys.exit()
    if "list_response" in control:
        print(json.dumps(control["list_response"]))
        sys.exit()
    prefix = argument("--prefix")
    maximum = int(argument("--max-keys")) if "--max-keys" in args else 1000
    keys = sorted(path.relative_to(data).as_posix() for path in data.rglob("*") if path.is_file() and path.relative_to(data).as_posix().startswith(prefix))
    selected = keys[:maximum]
    print(json.dumps({"Prefix": prefix, "MaxKeys": maximum, "KeyCount": len(selected), "IsTruncated": len(keys) > maximum, "Contents": [{"Key": key, "Size": (data / key).stat().st_size, "LastModified": "2030-01-01T00:00:00Z"} for key in selected]}))
elif operation in {"get-object", "head-object"}:
    path = data / argument("--key")
    if control.get("deny_get" if operation == "get-object" else "deny_head") or not path.exists():
        deny("GetObject" if operation == "get-object" else "HeadObject", control.get("error_code", "AccessDenied"))
    body = path.read_bytes()
    if operation == "get-object":
        Path(args[args.index("--key") + 2]).write_bytes(body)
    print(json.dumps({"ContentLength": len(body), "Metadata": {"sha256": hashlib.sha256(body).hexdigest()}, "LastModified": "2030-01-01T00:00:00Z"}))
elif operation == "cp":
    if control.get("deny_copy"):
        deny("PutObject")
    destination = data / args[3].split("/", 3)[3]
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(Path(args[2]).read_bytes())
else:
    raise RuntimeError("unexpected synthetic AWS operation: " + operation)
""").encode())
        binary.chmod(0o755)
        environment = patch.dict(os.environ, {
            "PATH": str(binary.parent) + os.pathsep + os.environ["PATH"],
            "SYNTHETIC_S3_ROOT": str(remote),
            "CI_CACHE_BUCKET": "synthetic-cache",
            "CI_CACHE_REGION": "us-east-1",
            "CI_CACHE_PREFIX": "synthetic/cache",
        })
        environment.start()
        self.addCleanup(environment.stop)
        return cache.S3Store(), data, control

    def test_identity_accepts_bazelisk_without_bazel_and_never_invokes_rustup(self):
        root, binary = self.identity_fixture()
        self.executable(binary / "bazelisk", "printf 'bazel 9.2.0\\n'\n")
        with patch.dict(os.environ, {"PATH": str(binary)}), patch.object(cache.platform, "system", return_value="Linux"), patch.object(cache.platform, "freedesktop_os_release", return_value={"ID": "test-linux"}):
            first = cache.make_identity("linux-x64-test", root)
            self.write(root / "Cargo.lock", b"changed crate graph")
            self.write(root / "crates/native/src/lib.rs", b"changed native source")
            source_change = cache.make_identity("linux-x64-test", root)
            self.assertEqual(cache.dimension(first), cache.dimension(source_change))
            self.write(root / "MODULE.bazel", b'bazel_dep(name="rules_rust", version="0.71.3")\nrust.toolchain(versions=["nightly/2026-10-07"], sha256s={"rust.tar.xz": "def"})\n')
            toolchain_change = cache.make_identity("linux-x64-test", root)
            self.assertNotEqual(cache.dimension(first), cache.dimension(toolchain_change))
            self.executable(binary / "cc", "printf 'cc version 2\\n'\n")
            compiler_change = cache.make_identity("linux-x64-test", root)
            self.assertNotEqual(cache.dimension(toolchain_change), cache.dimension(compiler_change))
        self.assertFalse((self.root / "rustup-was-invoked").exists())

    def test_identity_falls_back_to_bazel_and_rejects_wrong_bazel_version(self):
        root, binary = self.identity_fixture()
        self.executable(binary / "bazel", "printf 'bazel 9.2.0\\n'\n")
        with patch.dict(os.environ, {"PATH": str(binary)}), patch.object(cache.platform, "system", return_value="Linux"), patch.object(cache.platform, "freedesktop_os_release", return_value={"ID": "test-linux"}):
            cache.make_identity("linux-x64-test", root)
            self.executable(binary / "bazel", "printf 'bazel 8.0.0\\n'\n")
            with self.assertRaisesRegex(cache.CacheError, "Bazel version mismatch"):
                cache.make_identity("linux-x64-test", root)
        self.assertFalse((self.root / "rustup-was-invoked").exists())

    def test_darwin_selected_swift_compiler_changes_identity(self):
        root, binary = self.identity_fixture()
        self.executable(binary / "bazelisk", "printf 'bazel 9.2.0\\n'\n")
        self.executable(binary / "xcodebuild", "printf 'Xcode 27.0\\nBuild version test\\n'\n")
        swift_version = self.root / "swift-version"
        swift_version.write_text("Apple Swift version 6.4")
        # The selected compiler is deliberately absent from PATH.
        self.executable(binary / "xcrun", 'if [ "$1" = swiftc ]; then IFS= read -r value < "' + str(swift_version) + '"; printf "%s\\n" "$value"; else printf "%s\\n" "SDK or clang identity"; fi\n')
        with patch.dict(os.environ, {"PATH": str(binary)}), patch.object(cache.platform, "system", return_value="Darwin"), patch.object(cache.platform, "mac_ver", return_value=("27.0", (), "arm64")):
            first = cache.make_identity("darwin-arm64-test", root)
            swift_version.write_text("Apple Swift version 6.5")
            second = cache.make_identity("darwin-arm64-test", root)
            self.assertNotEqual(cache.dimension(first), cache.dimension(second))
        self.assertFalse((self.root / "rustup-was-invoked").exists())

    def test_pointer_cannot_redirect_to_arbitrary_keys(self):
        _, manifest = self.publish()
        pointer_path = self.store.path(f"refs/{self.identity['slot']}/current.json")
        pointer = cache.read_json(pointer_path)
        pointer["object_key"] = "objects/" + "f" * 64 + ".tar.gz"
        cache.atomic_json(pointer_path, pointer)
        with self.assertRaises(cache.CacheError):
            cache.fetch(self.identity["slot"], self.root / "redirect", self.store)

    def test_interrupted_archive_or_manifest_upload_preserves_current_pointer(self):
        _, original = self.publish()
        pointer_path = self.store.path(f"refs/{self.identity['slot']}/current.json")
        pointer_bytes = pointer_path.read_bytes()
        self.write(self.disk / DISK_NAME, b"new compiled output")
        snapshot, newer = self.snapshot("next", "101")
        for failure in ("objects/", "manifests/"):
            with self.subTest(failure=failure):
                class Interrupted(cache.LocalStore):
                    def put(inner, key, source, immutable=False):
                        if key.startswith(failure):
                            raise OSError("synthetic interrupted upload")
                        return super().put(key, source, immutable)
                with self.assertRaises(OSError):
                    cache.publish(snapshot, Interrupted(self.store.root))
                self.assertEqual(pointer_path.read_bytes(), pointer_bytes)
                self.assertEqual(cache.validate_pointer(cache.read_json(pointer_path), self.identity["slot"]), original)

    def test_untrusted_and_failed_publications_are_denied_before_any_write(self):
        snapshot, _ = self.snapshot()
        cases = [
            {"GITHUB_REPOSITORY": "fork/oh-my-pi"},
            {"GITHUB_EVENT_NAME": "pull_request"},
            {"GITHUB_EVENT_NAME": "pull_request_target"},
            {"GITHUB_EVENT_NAME": "workflow_run"},
            {"GITHUB_EVENT_NAME": "workflow_dispatch"},
            {"CACHE_BUILD_RESULT": "failure"},
            {"GITHUB_SHA": "2" * 40},
            {"GITHUB_RUN_ID": "999"},
            {"GITHUB_RUN_ATTEMPT": "2"},
            {"GITHUB_REF": "refs/heads/feature/test"},
            {"GITHUB_WORKFLOW_REF": cache.REPOSITORY + "/.github/workflows/evil.yml@refs/heads/coreforge"},
            {"GITHUB_REF": "refs/tags/relay/v1", "GITHUB_WORKFLOW_REF": cache.REPOSITORY + "/.github/workflows/cf-release.yml@refs/tags/relay/v1"},
        ]
        for environment in cases:
            with self.subTest(environment=environment), patch.dict(os.environ, environment):
                with self.assertRaises(cache.CacheError):
                    cache.publish(snapshot, self.store)
                self.assertEqual(self.store.listing(), [])

    def test_protected_engine_and_relay_tags_are_accepted(self):
        for index, (workflow, ref) in enumerate((("cf-release.yml", "refs/tags/v1.2.3.4"), ("relay.yml", "refs/tags/relay/v1.2.3"))):
            snapshot, manifest = self.snapshot("tag-" + str(index), str(101 + index))
            with patch.dict(os.environ, {"GITHUB_REF": ref, "GITHUB_WORKFLOW_REF": cache.REPOSITORY + "/.github/workflows/" + workflow + "@" + ref}):
                cache.publish(snapshot, self.store)
            pointer = cache.read_json(self.store.path(f"refs/{self.identity['slot']}/current.json"))
            self.assertEqual(pointer["manifest"]["source_sha"], manifest["source_sha"])

    def test_protected_canary_can_publish_fetch_and_apply_prune(self):
        snapshot, manifest = self.snapshot()
        with patch.dict(os.environ, CANARY_ENV):
            cache.publish(snapshot, self.store)
            orphan_key = "objects/" + "e" * 64 + ".tar.gz"
            self.write(self.store.path(orphan_key), b"expired canary orphan")
            self.age_store()
            with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}):
                plan = cache.prune(self.store, apply=True, now=NOW)
            self.assertIn(orphan_key, plan["delete"])
            self.assertFalse(self.store.path(orphan_key).exists())
            fetched = self.root / "protected-canary-fetch"
            cache.fetch(self.identity["slot"], fetched, self.store)
            self.assertEqual(cache.read_json(fetched / "manifest.json"), manifest)
            disk, repo = self.roots()
            cache.restore(self.identity_path, fetched, disk, repo)
            self.assertEqual((disk / DISK_NAME).read_bytes(), b"compiled action output")

    def assert_canary_operations_denied(self, cases):
        snapshot, _ = self.snapshot()
        self.write(self.store.path("objects/" + "e" * 64 + ".tar.gz"), b"eligible orphan")
        self.age_store()
        before = {row["key"] for row in self.store.listing()}
        for changes in cases:
            with self.subTest(environment=changes), patch.dict(os.environ, {**CANARY_ENV, **changes}):
                with self.assertRaises(cache.CacheError):
                    cache.publish(snapshot, self.store)
                self.assertEqual({row["key"] for row in self.store.listing()}, before)
                with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), self.assertRaises(cache.CacheError):
                    cache.prune(self.store, apply=True, now=NOW)
                self.assertEqual({row["key"] for row in self.store.listing()}, before)

    def test_canary_rejects_other_events_and_missing_or_unsafe_mode(self):
        cases = [{"GITHUB_EVENT_NAME": event} for event in ("push", "pull_request", "pull_request_target", "workflow_run")]
        cases.extend({"CI_CACHE_CANARY_ID": value} for value in ("", "-proof", "Proof", "proof_123", "proof/123", "a" * 49))
        cases.append({"GITHUB_EVENT_NAME": "push", "GITHUB_WORKFLOW_REF": cache.REPOSITORY + "/.github/workflows/cf-release.yml@refs/heads/coreforge"})
        self.assert_canary_operations_denied(cases)

    def test_canary_rejects_other_refs_workflows_and_repositories(self):
        self.assert_canary_operations_denied([
            {"GITHUB_REF": "refs/heads/feature/proof"},
            {"GITHUB_REF": "refs/tags/v1.2.3.4"},
            {"GITHUB_WORKFLOW_REF": cache.REPOSITORY + "/.github/workflows/cf-cache-canary.yml@refs/heads/feature/proof"},
            {"GITHUB_WORKFLOW_REF": cache.REPOSITORY + "/.github/workflows/cf-release.yml@refs/heads/coreforge"},
            {"GITHUB_WORKFLOW_REF": "fork/oh-my-pi/.github/workflows/cf-cache-canary.yml@refs/heads/coreforge"},
            {"GITHUB_REPOSITORY": "fork/oh-my-pi"},
        ])

    def test_canary_rejects_missing_production_and_mismatched_prefixes(self):
        self.assert_canary_operations_denied([
            {"CI_CACHE_PREFIX": prefix}
            for prefix in ("", "omp-bazel-v1", "omp-bazel-v1/canary/other", "omp-bazel-v1/canary/proof-123/", "omp-bazel-v1/canary/proof-123/nested")
        ])

    def test_canary_preserves_success_source_and_run_provenance_guards(self):
        self.assert_canary_operations_denied([{"CACHE_BUILD_RESULT": "failure"}])
        snapshot, _ = self.snapshot("canary-provenance")
        before = {row["key"] for row in self.store.listing()}
        for changes in ({"GITHUB_SHA": "2" * 40}, {"GITHUB_RUN_ID": "999"}, {"GITHUB_RUN_ATTEMPT": "2"}):
            with self.subTest(environment=changes), patch.dict(os.environ, {**CANARY_ENV, **changes}):
                with self.assertRaises(cache.CacheError):
                    cache.publish(snapshot, self.store)
                self.assertEqual({row["key"] for row in self.store.listing()}, before)

    def test_archive_rejects_traversal_links_duplicate_special_and_unknown_members(self):
        snapshot, _ = self.snapshot()
        valid = ("disk/" + DISK_NAME, tarfile.REGTYPE, b"data", "")
        bad_entries = [
            [("disk/../../escape", tarfile.REGTYPE, b"bad", "")],
            [("/absolute", tarfile.REGTYPE, b"bad", "")],
            [("disk/" + DISK_NAME, tarfile.SYMTYPE, b"", "/tmp/escape")],
            [("disk/" + DISK_NAME, tarfile.LNKTYPE, b"", "disk/" + DISK_NAME)],
            [("disk/" + DISK_NAME, tarfile.FIFOTYPE, b"", "")],
            [("disk/" + DISK_NAME, tarfile.CHRTYPE, b"", "")],
            [valid, valid],
            [("disk/logs/credentials", tarfile.REGTYPE, b"secret", "")],
            [("repo/contents/repository/archive", tarfile.REGTYPE, b"tree", "")],
            [("disk/cas/bb/" + "a" * 64, tarfile.REGTYPE, b"bad shard", "")],
            [("repo/" + ID_NAME, tarfile.REGTYPE, b"not empty", "")],
            [],
            [("repo/" + ID_NAME, tarfile.REGTYPE, b"", "")],
        ]
        disk, repo = self.roots()
        for entries in bad_entries:
            with self.subTest(entries=entries):
                self.repack_archive(snapshot, entries)
                with self.assertRaises(cache.CacheError):
                    cache.restore(self.identity_path, snapshot, disk, repo)
                self.assert_roots_unchanged(disk, repo)
        self.assertFalse((self.root / "escape").exists())

    def test_last_invalid_member_cannot_partially_restore(self):
        snapshot, _ = self.snapshot()
        self.repack_archive(snapshot, [("disk/" + DISK_NAME, tarfile.REGTYPE, b"first valid", ""), ("repo/../../escape", tarfile.REGTYPE, b"bad last", "")])
        disk, repo = self.roots()
        with self.assertRaises(cache.CacheError):
            cache.restore(self.identity_path, snapshot, disk, repo)
        self.assert_roots_unchanged(disk, repo)

    def test_atomic_restore_rolls_back_when_second_root_replacement_fails(self):
        snapshot, _ = self.snapshot()
        disk, repo = self.roots()
        original_replace = os.replace
        def fail_second(source, destination):
            if Path(destination) == repo.resolve() and Path(source).name == "root":
                raise OSError("synthetic second-root rename failure")
            return original_replace(source, destination)
        with patch.object(cache.os, "replace", side_effect=fail_second):
            with self.assertRaises(OSError):
                cache.restore(self.identity_path, snapshot, disk, repo)
        self.assert_roots_unchanged(disk, repo)

    def test_pack_excludes_logs_output_trees_and_temporary_files(self):
        self.write(self.disk / "tmp/uncommitted", b"partial")
        self.write(self.disk / "command.log", b"private log")
        self.write(self.repo / "contents/some-repo/secrets", b"not download cache")
        self.write(self.repo / REPO_NAME.replace("file", "tmp-partial"), b"partial")
        snapshot, _ = self.snapshot()
        disk, repo = self.roots()
        self.assertTrue(cache.restore(self.identity_path, snapshot, disk, repo))
        self.assertEqual({path.relative_to(disk).as_posix() for path in disk.rglob("*") if path.is_file()}, {DISK_NAME})
        self.assertEqual({path.relative_to(repo).as_posix() for path in repo.rglob("*") if path.is_file()}, {REPO_NAME, ID_NAME})

    def test_pack_rejects_source_symlink_hardlink_and_special_file(self):
        target = self.disk / DISK_NAME
        original = target.read_bytes()
        for kind in ("symlink", "hardlink", "fifo"):
            with self.subTest(kind=kind):
                target.unlink()
                source = self.root / ("source-" + kind)
                source.write_bytes(original)
                if kind == "symlink":
                    target.symlink_to(source)
                elif kind == "hardlink":
                    os.link(source, target)
                else:
                    os.mkfifo(target)
                output = self.root / ("invalid-" + kind)
                with self.assertRaises(cache.CacheError):
                    cache.pack(self.identity_path, self.disk, self.repo, output)
                self.assertFalse(output.exists())
                target.unlink()
                target.write_bytes(original)

    def test_bazel_digest_layouts_roundtrip(self):
        self.write(self.disk / ("blake3/ac/cc/" + "c" * 64), b"blake3 action")
        self.write(self.repo / ("content_addressable/sha512/" + "d" * 128 + "/file"), b"sha512 repository")
        snapshot, _ = self.snapshot()
        disk, repo = self.roots()
        self.assertTrue(cache.restore(self.identity_path, snapshot, disk, repo))
        self.assertEqual((disk / ("blake3/ac/cc/" + "c" * 64)).read_bytes(), b"blake3 action")
        self.assertEqual((repo / ("content_addressable/sha512/" + "d" * 128 + "/file")).read_bytes(), b"sha512 repository")

    def test_manifest_duplicate_fields_wrong_schema_and_mismatched_dimension_fail(self):
        snapshot, original = self.snapshot()
        disk, repo = self.roots()
        for key, value in (("schema", 2), ("dimension", "0" * 64), ("slot", "another-slot"), ("size", True), ("unexpected", "field")):
            cache.atomic_json(snapshot / "manifest.json", {**original, key: value})
            with self.subTest(key=key), self.assertRaises(cache.CacheError):
                cache.restore(self.identity_path, snapshot, disk, repo)
            self.assert_roots_unchanged(disk, repo)
        (snapshot / "manifest.json").write_text('{"schema":1,"schema":1}')
        with self.assertRaises(cache.CacheError):
            cache.restore(self.identity_path, snapshot, disk, repo)

    def test_local_mode_and_endpoint_overrides_are_refused_in_ci(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}):
            with self.assertRaises(cache.CacheError):
                cache.LocalStore(self.root / "forbidden")
            with patch.dict(os.environ, {"CI_CACHE_BUCKET": "synthetic-cache", "CI_CACHE_REGION": "us-east-1", "CI_CACHE_PREFIX": "synthetic/cache", "AWS_ENDPOINT_URL": "https://untrusted.invalid"}):
                with self.assertRaises(cache.CacheError):
                    cache.S3Store()

    def test_s3_pointer_lookup_confirms_absence_and_reads_exact_match_among_neighbors(self):
        store, remote, _ = self.s3_fixture()
        key = f"refs/{self.identity['slot']}/current.json"
        destination = self.root / "s3-pointer"
        self.assertFalse(store.get(key, destination))
        self.assertFalse(destination.exists())
        self.write(remote / store.key(key + ".backup"), b"not the current pointer")
        self.assertFalse(store.get(key, destination))
        self.assertFalse(destination.exists())
        self.write(remote / store.key(key), b"the exact current pointer")
        self.assertTrue(store.get(key, destination))
        self.assertEqual(destination.read_bytes(), b"the exact current pointer")

    def test_s3_immutable_first_upload_reuse_and_collision_preserve_bytes(self):
        store, remote, control = self.s3_fixture()
        key = "objects/" + "a" * 64 + ".tar.gz"
        source = self.root / "s3-source"
        source.write_bytes(b"original")
        self.write(remote / store.key(key + ".backup"), b"neighbor")
        store.put(key, source, immutable=True)
        self.assertEqual((remote / store.key(key)).read_bytes(), b"original")
        cache.atomic_json(control, {"deny_copy": True})
        store.put(key, source, immutable=True)
        self.assertEqual((remote / store.key(key)).read_bytes(), b"original")
        source.write_bytes(b"modified")
        with self.assertRaisesRegex(cache.CacheError, "digest collision"):
            store.put(key, source, immutable=True)
        self.assertEqual((remote / store.key(key)).read_bytes(), b"original")
        source.write_bytes(b"different size")
        with self.assertRaisesRegex(cache.CacheError, "size collision"):
            store.put(key, source, immutable=True)
        self.assertEqual((remote / store.key(key)).read_bytes(), b"original")

    def test_s3_lookup_denial_blocks_pointer_read_and_first_immutable_upload(self):
        store, remote, control = self.s3_fixture()
        pointer_key = f"refs/{self.identity['slot']}/current.json"
        self.write(remote / store.key(pointer_key), b"private pointer")
        cache.atomic_json(control, {"deny_list": True})
        destination = self.root / "denied-s3-pointer"
        with self.assertRaisesRegex(cache.CacheError, "AccessDenied"):
            store.get(pointer_key, destination)
        self.assertFalse(destination.exists())
        source = self.root / "denied-s3-upload"
        source.write_bytes(b"must not upload")
        object_key = "objects/" + "a" * 64 + ".tar.gz"
        with self.assertRaisesRegex(cache.CacheError, "AccessDenied"):
            store.put(object_key, source, immutable=True)
        self.assertFalse((remote / store.key(object_key)).exists())

    def test_s3_invalid_exact_lookup_blocks_pointer_read_and_immutable_upload(self):
        store, remote, control = self.s3_fixture()
        source = self.root / "invalid-list-source"
        source.write_bytes(b"must not upload")
        destination = self.root / "invalid-list-pointer"
        for operation, key in (("get", f"refs/{self.identity['slot']}/current.json"), ("put", "objects/" + "a" * 64 + ".tar.gz")):
            full_key = store.key(key)
            empty = {"Prefix": full_key, "MaxKeys": 1, "KeyCount": 0, "IsTruncated": False, "Contents": []}
            entry = {"Key": full_key, "Size": 10, "LastModified": "2030-01-01T00:00:00Z"}
            single = {**empty, "KeyCount": 1, "Contents": [entry]}
            responses = [
                [],
                {**empty, "Prefix": "another/prefix"},
                {**empty, "MaxKeys": 2},
                {**empty, "KeyCount": True},
                {**empty, "KeyCount": 1},
                {**empty, "IsTruncated": True},
                {**empty, "IsTruncated": None},
                {**empty, "Contents": {}},
                {**single, "KeyCount": 2, "Contents": [entry, entry]},
                {**single, "Contents": [None]},
                {**single, "Contents": [{**entry, "Key": "another/key"}]},
                {**single, "Contents": [{**entry, "Size": -1}]},
                {**single, "Contents": [{**entry, "Size": True}]},
                {**single, "Contents": [{**entry, "LastModified": "2030-01-01T00:00:00"}]},
            ]
            configurations = [{"list_response": response} for response in responses] + [{"list_raw": "{"}]
            for configuration in configurations:
                with self.subTest(operation=operation, configuration=configuration):
                    cache.atomic_json(control, configuration)
                    with self.assertRaises((cache.CacheError, ValueError)):
                        if operation == "get":
                            store.get(key, destination)
                        else:
                            store.put(key, source, immutable=True)
                    self.assertFalse(destination.exists())
                    self.assertFalse((remote / store.key(key)).exists())

    def test_s3_referenced_get_and_existing_pointer_or_head_errors_are_not_misses(self):
        store, remote, control = self.s3_fixture()
        destination = self.root / "unreadable-s3-object"
        object_key = "objects/" + "a" * 64 + ".tar.gz"
        for code in ("AccessDenied", "NoSuchKey"):
            with self.subTest(code=code):
                cache.atomic_json(control, {"error_code": code})
                with self.assertRaisesRegex(cache.CacheError, code):
                    store.get(object_key, destination)
                self.assertFalse(destination.exists())
        pointer_key = f"refs/{self.identity['slot']}/current.json"
        self.write(remote / store.key(pointer_key), b"unreadable pointer")
        cache.atomic_json(control, {"deny_get": True})
        with self.assertRaisesRegex(cache.CacheError, "AccessDenied"):
            store.get(pointer_key, destination)
        self.assertFalse(destination.exists())
        source = self.root / "unreadable-head-source"
        source.write_bytes(b"original")
        self.write(remote / store.key(object_key), b"original")
        cache.atomic_json(control, {"deny_head": True})
        with self.assertRaisesRegex(cache.CacheError, "AccessDenied"):
            store.put(object_key, source, immutable=True)
        self.assertEqual((remote / store.key(object_key)).read_bytes(), b"original")

    def test_s3_cli_prune_failure_after_publication_leaves_snapshot_readable(self):
        store, _, control = self.s3_fixture()
        snapshot, manifest = self.snapshot()
        result = subprocess.run([sys.executable, str(HELPER), "publish", "--snapshot", str(snapshot)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        cache.atomic_json(control, {"deny_list_prefix": store.prefix + "/"})
        result = subprocess.run([sys.executable, str(HELPER), "prune", "--apply"], capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0, result.stderr)
        fetched = self.root / "after-failed-prune"
        result = subprocess.run([sys.executable, str(HELPER), "fetch", "--slot", self.identity["slot"], "--output", str(fetched)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        disk, repo = self.roots()
        result = subprocess.run([sys.executable, str(HELPER), "restore", "--identity", str(self.identity_path), "--snapshot", str(fetched), "--disk", str(disk), "--repo", str(repo)], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((disk / DISK_NAME).read_bytes(), b"compiled action output")
        self.assertEqual((repo / REPO_NAME).read_bytes(), b"repository download")
        self.assertEqual((repo / ID_NAME).read_bytes(), b"")
        self.assertEqual(cache.read_json(fetched / "manifest.json"), manifest)

    def test_prune_preserves_current_latest_historical_shared_and_grace_objects(self):
        generations = []
        for generation in range(100, 105):
            self.write(self.disk / DISK_NAME, str(generation).encode())
            generations.append(self.publish("generation-" + str(generation), str(generation))[1])
        self.age_store()
        unknown = self.store.path("operator-note.txt")
        self.write(unknown, b"never delete")
        orphan = self.store.path("objects/" + "e" * 64 + ".tar.gz")
        self.write(orphan, b"in flight")
        os.utime(orphan, ((NOW - dt.timedelta(hours=1)).timestamp(),) * 2)
        dry = cache.prune(self.store, keep=2, now=NOW)
        expected = {key for manifest in generations[:2] for key in (cache.manifest_key(manifest), cache.object_key(manifest))}
        expected.update(cache.retirement_key(manifest) for manifest in generations[:-1])
        self.assertEqual(set(dry["delete"]), expected)
        self.assertTrue(self.store.path(cache.manifest_key(generations[0])).exists())
        applied = cache.prune(self.store, keep=2, apply=True, now=NOW)
        self.assertEqual(applied["delete"], dry["delete"])
        for manifest in generations[2:]:
            self.assertTrue(self.store.path(cache.manifest_key(manifest)).exists())
            self.assertTrue(self.store.path(cache.object_key(manifest)).exists())
        self.assertTrue(unknown.exists())
        self.assertTrue(orphan.exists())
        fetched = self.root / "after-prune"
        self.assertTrue(cache.fetch(self.identity["slot"], fetched, self.store))

    def test_prune_counts_generations_not_idle_days_and_keeps_shared_objects(self):
        first_snapshot, first = self.publish()
        second_snapshot, second = self.snapshot("second", "101")
        # Two successful generations may reference identical immutable bytes.
        second["sha256"], second["size"] = first["sha256"], first["size"]
        (second_snapshot / "snapshot.tar.gz").write_bytes((first_snapshot / "snapshot.tar.gz").read_bytes())
        cache.atomic_json(second_snapshot / "manifest.json", second)
        cache.publish(second_snapshot, self.store)
        self.age_store()
        plan = cache.prune(self.store, keep=1, apply=True, now=NOW + dt.timedelta(days=3650))
        self.assertEqual(plan["delete"], [cache.retirement_key(first)])
        self.assertTrue(self.store.path(cache.object_key(first)).exists())

    def test_prune_requires_explicit_retirement_and_refuses_current_dimension(self):
        _, old = self.publish()
        changed = {**self.identity, "tools": {"cc": "new compiler"}}
        _, current = self.publish("new-dimension", "101", changed)
        self.age_store()
        ordinary = cache.prune(self.store, keep=1, now=NOW)
        self.assertNotIn(cache.manifest_key(old), ordinary["delete"])
        retired = old["slot"] + "/" + old["dimension"]
        plan = cache.prune(self.store, keep=1, retire=[retired], apply=True, now=NOW)
        self.assertIn(cache.manifest_key(old), plan["delete"])
        self.assertTrue(self.store.path(cache.object_key(current)).exists())
        before = {row["key"] for row in self.store.listing()}
        with self.assertRaises(cache.CacheError):
            cache.prune(self.store, retire=[current["slot"] + "/" + current["dimension"]], apply=True, now=NOW)
        self.assertEqual({row["key"] for row in self.store.listing()}, before)

    def test_long_idle_current_survives_quick_supersessions_for_full_reader_grace(self):
        with self.publication_time(NOW - dt.timedelta(days=30)):
            _, original = self.publish()
        generations = []
        class InFlightReader(cache.LocalStore):
            def get(inner, key, destination):
                result = super().get(key, destination)
                if key == f"refs/{self.identity['slot']}/current.json":
                    for index in range(4):
                        self.write(self.disk / DISK_NAME, f"generation {index}".encode())
                        with self.publication_time(NOW + dt.timedelta(minutes=index)):
                            generations.append(self.publish(f"quick-{index}", str(101 + index))[1])
                    plan = cache.prune(self.store, apply=True, now=NOW + cache.GRACE - dt.timedelta(seconds=1))
                    self.assertNotIn(cache.manifest_key(original), plan["delete"])
                    self.assertNotIn(cache.object_key(original), plan["delete"])
                return result
        fetched = self.root / "in-flight-reader"
        self.assertTrue(cache.fetch(self.identity["slot"], fetched, InFlightReader(self.store.root)))
        disk, repo = self.roots()
        cache.restore(self.identity_path, fetched, disk, repo)
        self.assertEqual((disk / DISK_NAME).read_bytes(), b"compiled action output")
        plan = cache.prune(self.store, apply=True, now=NOW + cache.GRACE)
        self.assertIn(cache.manifest_key(original), plan["delete"])
        self.assertIn(cache.object_key(original), plan["delete"])
        self.assertIn(cache.retirement_key(original), plan["delete"])
        self.assertFalse(self.store.path(cache.object_key(original)).exists())
        for manifest in generations[1:]:
            self.assertTrue(self.store.path(cache.manifest_key(manifest)).exists())
            self.assertTrue(self.store.path(cache.object_key(manifest)).exists())
        latest = self.root / "latest-after-grace"
        cache.fetch(self.identity["slot"], latest, self.store)
        cache.restore(self.identity_path, latest, disk, repo)
        self.assertEqual((disk / DISK_NAME).read_bytes(), b"generation 3")

    def test_retired_manifest_expiry_does_not_delete_archive_shared_with_current(self):
        with self.publication_time(NOW - dt.timedelta(days=30)):
            original_snapshot, original = self.publish()
        for index in range(3):
            self.write(self.disk / DISK_NAME, f"different {index}".encode())
            with self.publication_time(NOW + dt.timedelta(minutes=index)):
                self.publish(f"different-{index}", str(101 + index))
        with self.publication_time(NOW + dt.timedelta(minutes=3)):
            snapshot, current = self.snapshot("shared-current", "104")
            current["sha256"], current["size"] = original["sha256"], original["size"]
            (snapshot / "snapshot.tar.gz").write_bytes((original_snapshot / "snapshot.tar.gz").read_bytes())
            cache.atomic_json(snapshot / "manifest.json", current)
            cache.publish(snapshot, self.store)
        plan = cache.prune(self.store, apply=True, now=NOW + cache.GRACE + dt.timedelta(hours=1))
        self.assertIn(cache.manifest_key(original), plan["delete"])
        self.assertNotIn(cache.object_key(original), plan["delete"])
        fetched = self.root / "shared-fetch"
        cache.fetch(self.identity["slot"], fetched, self.store)
        disk, repo = self.roots()
        cache.restore(self.identity_path, fetched, disk, repo)
        self.assertEqual((disk / DISK_NAME).read_bytes(), b"compiled action output")

    def test_retirement_grace_starts_after_slow_pointer_replacement(self):
        with self.publication_time(NOW - dt.timedelta(days=30)):
            _, original = self.publish("slow-original")
        retired = original["slot"] + "/" + original["dimension"]
        self.write(self.disk / DISK_NAME, b"new dimension")
        changed = {**self.identity, "tools": {"cc": "new compiler"}}
        clock = [NOW]
        original_put = self.store.put
        def slow_pointer(key, source, immutable=False):
            original_put(key, source, immutable)
            if key.startswith("refs/"):
                clock[0] += dt.timedelta(days=2)
            os.utime(self.store.path(key), (clock[0].timestamp(),) * 2)
            if key.startswith("refs/"):
                plan = cache.prune(self.store, retire=[retired], apply=True, now=clock[0])
                self.assertNotIn(cache.manifest_key(original), plan["delete"])
                self.assertNotIn(cache.object_key(original), plan["delete"])
        with patch.object(cache, "timestamp", side_effect=lambda: clock[0].isoformat().replace("+00:00", "Z")):
            snapshot, _ = self.snapshot("slow-replacement", "101", changed)
            with patch.object(self.store, "put", side_effect=slow_pointer):
                cache.publish(snapshot, self.store)
        plan = cache.prune(self.store, retire=[retired], apply=True, now=clock[0] + cache.GRACE - dt.timedelta(seconds=1))
        self.assertNotIn(cache.manifest_key(original), plan["delete"])
        self.assertNotIn(cache.object_key(original), plan["delete"])
        plan = cache.prune(self.store, retire=[retired], apply=True, now=clock[0] + cache.GRACE)
        self.assertIn(cache.manifest_key(original), plan["delete"])
        self.assertIn(cache.object_key(original), plan["delete"])

    def test_interrupted_retirement_and_pointer_writes_preserve_readers(self):
        for failure in ("pending", "pointer", "completion"):
            with self.subTest(failure=failure):
                self.store = cache.LocalStore(self.root / ("interrupted-" + failure))
                self.write(self.disk / DISK_NAME, b"original")
                with self.publication_time(NOW - dt.timedelta(days=30)):
                    _, original = self.publish("original-" + failure)
                self.write(self.disk / DISK_NAME, b"replacement")
                with self.publication_time(NOW):
                    snapshot, replacement = self.snapshot("replacement-" + failure, "101")
                    original_put = self.store.put
                    def interrupt(key, source, immutable=False):
                        if key.startswith("retired/"):
                            pending = cache.read_json(source)["retired_at"] is None
                            if (failure == "pending" and pending) or (failure == "completion" and not pending):
                                raise OSError("synthetic retirement interruption")
                        if failure == "pointer" and key.startswith("refs/"):
                            raise OSError("synthetic pointer interruption")
                        return original_put(key, source, immutable)
                    with patch.object(self.store, "put", side_effect=interrupt), self.assertRaises(OSError):
                        cache.publish(snapshot, self.store)
                pointer = cache.read_json(self.store.path(f"refs/{self.identity['slot']}/current.json"))
                self.assertEqual(pointer["manifest"], replacement if failure == "completion" else original)
                if failure == "completion":
                    for index in range(3):
                        self.write(self.disk / DISK_NAME, f"later {index}".encode())
                        with self.publication_time(NOW + dt.timedelta(minutes=index + 1)):
                            self.publish(f"later-{index}", str(102 + index))
                plan = cache.prune(self.store, apply=True, now=NOW + dt.timedelta(days=2))
                self.assertNotIn(cache.manifest_key(original), plan["delete"])
                self.assertNotIn(cache.object_key(original), plan["delete"])
                self.assertTrue(self.store.path(cache.manifest_key(original)).exists())
                self.assertTrue(self.store.path(cache.object_key(original)).exists())
                if failure == "completion":
                    marker = cache.read_json(self.store.path(cache.retirement_key(original)))
                    self.assertIsNone(marker["retired_at"])
                fetched = self.root / ("interrupted-fetch-" + failure)
                cache.fetch(self.identity["slot"], fetched, self.store)
                disk, repo = self.roots()
                cache.restore(self.identity_path, fetched, disk, repo)
                self.assertEqual((disk / DISK_NAME).read_bytes(), b"later 2" if failure == "completion" else b"original")

    def test_retry_after_failed_pointer_write_starts_new_full_retirement_grace(self):
        with self.publication_time(NOW - dt.timedelta(days=30)):
            _, original = self.publish()
        self.write(self.disk / DISK_NAME, b"retry output")
        with self.publication_time(NOW):
            snapshot, _ = self.snapshot("failed-pointer", "101")
            original_put = self.store.put
            def interrupt(key, source, immutable=False):
                if key.startswith("refs/"):
                    raise OSError("synthetic pointer interruption")
                return original_put(key, source, immutable)
            with patch.object(self.store, "put", side_effect=interrupt), self.assertRaises(OSError):
                cache.publish(snapshot, self.store)
        resumed_at = NOW + dt.timedelta(days=2)
        with self.publication_time(resumed_at):
            cache.publish(snapshot, self.store)
        for index in range(3):
            self.write(self.disk / DISK_NAME, f"after retry {index}".encode())
            with self.publication_time(resumed_at + dt.timedelta(minutes=index + 1)):
                self.publish(f"after-retry-{index}", str(102 + index))
        plan = cache.prune(self.store, apply=True, now=resumed_at + cache.GRACE - dt.timedelta(seconds=1))
        self.assertNotIn(cache.manifest_key(original), plan["delete"])
        self.assertNotIn(cache.object_key(original), plan["delete"])
        plan = cache.prune(self.store, apply=True, now=resumed_at + cache.GRACE)
        self.assertIn(cache.manifest_key(original), plan["delete"])
        self.assertIn(cache.object_key(original), plan["delete"])

    def test_malformed_or_incomplete_retirement_prevents_all_deletions(self):
        generations = []
        for index in range(5):
            self.write(self.disk / DISK_NAME, f"generation {index}".encode())
            with self.publication_time(NOW - dt.timedelta(days=2) + dt.timedelta(minutes=index)):
                generations.append(self.publish(f"metadata-{index}", str(100 + index))[1])
        key = cache.retirement_key(generations[0])
        path = self.store.path(key)
        marker = cache.read_json(path)
        cases = [
            {**marker, "schema": 2},
            {**marker, "unexpected": True},
            {**marker, "retired_at": "2030-01-01T00:00:00"},
            {**marker, "retired_at": 123},
            {**marker, "pointer": cache.pointer_for(generations[1])},
            {name: value for name, value in marker.items() if name != "retired_at"},
        ]
        for invalid in cases:
            with self.subTest(marker=invalid):
                cache.atomic_json(path, invalid)
                before = {row["key"] for row in self.store.listing()}
                with self.assertRaises(cache.CacheError):
                    cache.prune(self.store, apply=True, now=NOW)
                self.assertEqual({row["key"] for row in self.store.listing()}, before)
        cache.atomic_json(path, marker)
        unknown = self.store.path("retired/unknown.json")
        cache.atomic_json(unknown, marker)
        before = {row["key"] for row in self.store.listing()}
        with self.assertRaises(cache.CacheError):
            cache.prune(self.store, apply=True, now=NOW)
        self.assertEqual({row["key"] for row in self.store.listing()}, before)
        unknown.unlink()
        self.store.delete(cache.manifest_key(generations[0]))
        before = {row["key"] for row in self.store.listing()}
        with self.assertRaisesRegex(cache.CacheError, "retirement manifest missing"):
            cache.prune(self.store, apply=True, now=NOW)
        self.assertEqual({row["key"] for row in self.store.listing()}, before)

    def test_interrupted_prune_removes_expired_markers_before_targets(self):
        generations = []
        for index in range(5):
            self.write(self.disk / DISK_NAME, f"generation {index}".encode())
            with self.publication_time(NOW - dt.timedelta(days=2) + dt.timedelta(minutes=index)):
                generations.append(self.publish(f"prune-interruption-{index}", str(100 + index))[1])
        original_delete = self.store.delete
        def interrupt(key):
            if key == cache.manifest_key(generations[0]):
                raise OSError("synthetic prune interruption")
            return original_delete(key)
        with patch.object(self.store, "delete", side_effect=interrupt), self.assertRaises(OSError):
            cache.prune(self.store, apply=True, now=NOW)
        self.assertFalse(self.store.path(cache.retirement_key(generations[0])).exists())
        self.assertTrue(self.store.path(cache.manifest_key(generations[0])).exists())
        plan = cache.prune(self.store, apply=True, now=NOW)
        self.assertIn(cache.manifest_key(generations[0]), plan["delete"])
        self.assertIn(cache.object_key(generations[0]), plan["delete"])
        self.assertTrue(self.store.path(cache.manifest_key(generations[-1])).exists())

    def test_invalid_or_incomplete_listing_prevents_all_deletions(self):
        self.publish()
        self.age_store()
        self.write(self.store.path("objects/" + "f" * 64 + ".tar.gz"), b"old orphan")
        self.age_store()
        original = {row["key"] for row in self.store.listing()}
        class Incomplete(cache.LocalStore):
            def listing(inner):
                return [row for row in super().listing() if not row["key"].startswith("manifests/")]
        class Duplicate(cache.LocalStore):
            def listing(inner):
                rows = super().listing()
                return rows + rows[:1]
        for store in (Incomplete(self.store.root), Duplicate(self.store.root)):
            with self.subTest(store=type(store).__name__), self.assertRaises(cache.CacheError):
                cache.prune(store, apply=True, now=NOW)
            self.assertEqual({row["key"] for row in self.store.listing()}, original)
        pointer = self.store.path(f"refs/{self.identity['slot']}/current.json")
        pointer.write_text("{broken")
        with self.assertRaises(cache.CacheError):
            cache.prune(self.store, apply=True, now=NOW)
        self.assertEqual({row["key"] for row in self.store.listing()}, original)

    def test_empty_or_metadata_only_pack_never_creates_snapshot(self):
        (self.disk / DISK_NAME).unlink()
        (self.repo / REPO_NAME).unlink()
        output = self.root / "metadata-only"
        with self.assertRaisesRegex(cache.CacheError, "no supported cache payloads"):
            cache.pack(self.identity_path, self.disk, self.repo, output)
        self.assertFalse(output.exists())

    def test_existing_generation_is_immutable_and_keeps_current_pointer(self):
        _, original = self.publish()
        pointer = self.store.path(f"refs/{self.identity['slot']}/current.json")
        before = pointer.read_bytes()
        self.write(self.disk / DISK_NAME, b"conflicting same-generation payload")
        snapshot, _ = self.snapshot("conflict", "100")
        with self.assertRaisesRegex(cache.CacheError, "immutable object collision"):
            cache.publish(snapshot, self.store)
        self.assertEqual(pointer.read_bytes(), before)
        self.assertEqual(cache.read_json(self.store.path(cache.manifest_key(original))), original)

    def test_prune_mutation_in_ci_rejects_privileged_trigger(self):
        self.publish()
        before = {row["key"] for row in self.store.listing()}
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "pull_request_target"}):
            with self.assertRaises(cache.CacheError):
                cache.prune(self.store, apply=True, now=NOW)
        self.assertEqual({row["key"] for row in self.store.listing()}, before)


class PreflightTests(unittest.TestCase):
    def test_verified_durable_restore_does_not_require_a_hot_lookup(self):
        result = cache.preflight_state("success", "success", "true", "skipped", "", "")
        self.assertEqual((result["state"], result["source"]), ("restored", "durable"))

    def test_exact_and_prefix_hot_restores_remain_distinct(self):
        exact = cache.preflight_state("success", "success", "false", "success", "true", "exact-key")
        partial = cache.preflight_state("success", "success", "false", "success", "false", "older-key")
        self.assertEqual((exact["state"], exact["source"]), ("restored", "github"))
        self.assertEqual((partial["state"], partial["source"]), ("partial", "github"))

    def test_completed_misses_report_cold(self):
        result = cache.preflight_state("success", "success", "false", "success", "", "")
        self.assertEqual((result["state"], result["source"]), ("cold", "none"))

    def test_unknown_or_inconsistent_state_never_claims_a_restored_cache(self):
        cases = [
            ("failure", "success", "true", "skipped", "", ""),
            ("success", "failure", "", "success", "false", ""),
            ("success", "skipped", "", "skipped", "", ""),
            ("success", "success", "false", "success", "true", ""),
            ("success", "success", "false", "success", "invalid", "key"),
        ]
        for values in cases:
            with self.subTest(values=values):
                result = cache.preflight_state(*values)
                self.assertEqual((result["state"], result["source"]), ("unknown", "none"))

    def test_successful_hot_restore_survives_an_unavailable_durable_source(self):
        result = cache.preflight_state("success", "failure", "", "success", "true", "key")
        self.assertEqual((result["state"], result["source"]), ("restored", "github"))


if __name__ == "__main__":
    unittest.main()
