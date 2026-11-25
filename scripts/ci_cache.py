#!/usr/bin/env python3
"""Private, content-addressed Bazel cache snapshots. Python 3.11+, no dependencies."""

import argparse
import ast
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import uuid

SCHEMA = 1
FORMAT = "bazel-9.2-disk-repository-v1"
SLOT = r"[a-z0-9][a-z0-9.-]{0,95}"
HEX = r"[0-9a-f]{64}"
REPOSITORY = "Coreforce-CAD/oh-my-pi"
GRACE = dt.timedelta(hours=24)
JSON_LIMIT = 4 * 1024 * 1024
CHUNK = 1024 * 1024
DIGESTS = {"sha1": 40, "sha256": 64, "sha384": 96, "sha512": 128, "blake3": 64}
# Bazel 9.2.0: remote/disk/DiskCacheClient.java::toPath and
# bazel/repository/cache/DownloadCache.java::{KeyType,hasCanonicalId}.
DISK_LENGTHS = {32, 40, 64, 96, 128}


class CacheError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CacheError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()


def dimension(identity):
    return hashlib.sha256(canonical(identity)).hexdigest()


def timestamp():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value):
    require(isinstance(value, str), "timestamp must be a string")
    try:
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise CacheError("invalid timestamp") from error
    require(result.tzinfo is not None, "timestamp requires timezone")
    return result.astimezone(dt.timezone.utc)


def digest_file(path):
    result = hashlib.sha256()
    with regular_open(path) as source:
        while block := source.read(CHUNK):
            result.update(block)
    return result.hexdigest()


@contextlib.contextmanager
def regular_open(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        metadata = os.fstat(source.fileno())
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, f"not a private regular file: {path}")
        yield source


def strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path):
    with regular_open(path) as source:
        data = source.read(JSON_LIMIT + 1)
    require(len(data) <= JSON_LIMIT, "JSON exceeds size limit")
    try:
        return json.loads(data, object_pairs_hook=strict_pairs, parse_constant=lambda value: require(False, "invalid JSON constant"))
    except (ValueError, UnicodeError) as error:
        raise CacheError(f"invalid JSON: {path}") from error


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".cache-json-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(canonical(value) + b"\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def validate_identity(value):
    require(isinstance(value, dict), "identity must be an object")
    require(type(value.get("schema")) is int and value["schema"] == SCHEMA and value.get("format") == FORMAT, "unsupported identity schema/format")
    require(isinstance(value.get("slot"), str) and re.fullmatch(SLOT, value["slot"]), "invalid slot")
    require(isinstance(value.get("host"), dict) and isinstance(value.get("tools"), dict), "missing host/tool identity")
    require(isinstance(value.get("configuration"), dict) and isinstance(value.get("module_toolchains"), list), "missing configuration/toolchain identity")
    require(value.get("bazel") == "9.2.0", "unsupported Bazel version")
    return value


def probe(command, required=False):
    executable = shutil.which(command[0])
    if not executable:
        require(not required, f"required tool missing: {command[0]}")
        return None
    result = subprocess.run([executable, *command[1:]], capture_output=True, text=True, timeout=60)
    require(result.returncode == 0, f"tool identity probe failed: {' '.join(command)}: {result.stderr.strip()}")
    return result.stdout.strip()


def make_identity(slot, root=None):
    require(re.fullmatch(SLOT, slot), "invalid slot")
    root = Path.cwd() if root is None else Path(root)
    expected = (root / ".bazelversion").read_text().strip()
    bazel = shutil.which("bazelisk") or shutil.which("bazel")
    require(bazel is not None, "neither bazelisk nor bazel found on PATH")
    actual = probe([bazel, "--version"], required=True)
    require(actual == f"bazel {expected}" and expected == "9.2.0", f"Bazel version mismatch: pinned {expected}, actual {actual}")
    files = {root / name for name in (".bazelrc", ".bazelversion", "rust-toolchain.toml", "bazel/defs.bzl")}
    for name in ("toolchains", "platforms", "variants", "patches", "triples"):
        files.update(path for path in (root / "bazel" / name).rglob("*") if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc")
    files.add(root / "bazel/clippy.bazelrc")
    configuration = {path.relative_to(root).as_posix(): digest_file(path) for path in sorted(files)}
    tree = ast.parse((root / "MODULE.bazel").read_text())
    calls = []
    for node in tree.body:
        call = node.value if isinstance(node, (ast.Expr, ast.Assign)) else None
        if not isinstance(call, ast.Call):
            continue
        name = ast.unparse(call.func)
        if name.startswith("crate.") or name in {"module", "use_repo"}:
            continue
        calls.append(ast.dump(call, annotate_fields=True, include_attributes=False))
    tools = {}
    for name, arguments in {"cc": ["--version"], "c++": ["--version"], "cmake": ["--version"], "ninja": ["--version"]}.items():
        tools[name] = probe([name, *arguments], required=name == "cc")
    host = {"os": platform.system(), "version": platform.version(), "release": platform.release(), "arch": platform.machine()}
    if platform.system() == "Darwin":
        tools["xcode"] = probe(["xcodebuild", "-version"], required=True)
        tools["sdk"] = probe(["xcrun", "--sdk", "macosx", "--show-sdk-version"], required=True)
        tools["sdk_build"] = probe(["xcrun", "--sdk", "macosx", "--show-sdk-build-version"], required=True)
        tools["swiftc"] = probe(["xcrun", "swiftc", "--version"], required=True)
        if override := os.environ.get("OMP_APPLEFM_SWIFTC"):
            tools["swiftc_override"] = probe([override, "--version"], required=True)
        tools["clang"] = probe(["xcrun", "clang", "--version"], required=True)
        host["version"] = platform.mac_ver()[0]
    elif platform.system() == "Linux":
        host["distribution"] = platform.freedesktop_os_release()
        host["libc"] = list(platform.libc_ver())
    else:
        raise CacheError("only Linux and macOS cache hosts are supported")
    native_env = {key: os.environ[key] for key in ("CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS", "RUSTFLAGS", "MACOSX_DEPLOYMENT_TARGET", "SDKROOT", "DEVELOPER_DIR", "OMP_APPLEFM_SWIFTC", "BAZEL_CXXOPTS", "BAZEL_LINKOPTS") if key in os.environ}
    return validate_identity({"schema": SCHEMA, "format": FORMAT, "slot": slot, "bazel": expected, "host": host, "tools": tools, "configuration": configuration, "module_toolchains": calls, "native_environment": native_env})


def validate_manifest(value):
    fields = {"schema", "slot", "identity", "dimension", "sha256", "size", "source_sha", "run_id", "run_attempt", "created_at"}
    require(isinstance(value, dict) and set(value) == fields, "invalid manifest fields")
    require(type(value["schema"]) is int and value["schema"] == SCHEMA, "invalid manifest schema")
    identity = validate_identity(value["identity"])
    require(value["slot"] == identity["slot"], "manifest slot disagrees with identity")
    require(value["dimension"] == dimension(identity), "manifest identity digest mismatch")
    require(isinstance(value["sha256"], str) and re.fullmatch(HEX, value["sha256"]), "invalid archive digest")
    require(type(value["size"]) is int and value["size"] > 0, "invalid archive size")
    require(isinstance(value["source_sha"], str) and re.fullmatch(r"[0-9a-f]{40}", value["source_sha"]), "invalid source SHA")
    for key in ("run_id", "run_attempt"):
        require(isinstance(value[key], str) and re.fullmatch(r"[1-9][0-9]{0,19}", value[key]), f"invalid {key}")
    parse_time(value["created_at"])
    return value


def manifest_key(manifest):
    return f"manifests/{manifest['slot']}/{manifest['dimension']}/{manifest['run_id']}-{manifest['run_attempt']}.json"


def object_key(manifest):
    return f"objects/{manifest['sha256']}.tar.gz"


def pointer_for(manifest):
    return {"schema": SCHEMA, "manifest_key": manifest_key(manifest), "object_key": object_key(manifest), "manifest": manifest}


def validate_pointer(value, slot):
    require(isinstance(value, dict) and set(value) == {"schema", "manifest_key", "object_key", "manifest"}, "invalid current pointer")
    require(type(value["schema"]) is int and value["schema"] == SCHEMA, "invalid pointer schema")
    manifest = validate_manifest(value["manifest"])
    require(manifest["slot"] == slot and value == pointer_for(manifest), "pointer key/slot mismatch")
    return manifest


def retirement_key(manifest):
    return f"retired/{manifest['slot']}/{manifest['dimension']}/{manifest['run_id']}-{manifest['run_attempt']}.json"


def retirement_for(manifest, retired_at):
    return {"schema": SCHEMA, "pointer": pointer_for(manifest), "retired_at": retired_at}


def validate_retirement(value, key):
    match = re.fullmatch(r"retired/(" + SLOT + ")/" + HEX + r"/[1-9][0-9]{0,19}-[1-9][0-9]{0,19}\.json", key)
    require(match is not None, "unknown/incomplete retirement listing")
    require(isinstance(value, dict) and set(value) == {"schema", "pointer", "retired_at"}, "invalid retirement fields")
    require(type(value["schema"]) is int and value["schema"] == SCHEMA, "invalid retirement schema")
    manifest = validate_pointer(value["pointer"], match[1])
    require(retirement_key(manifest) == key, "retirement key mismatch")
    retired_at = None if value["retired_at"] is None else parse_time(value["retired_at"])
    return manifest, retired_at


def valid_member(name, size):
    if type(size) is not int or size < 0:
        return False
    parts = name.split("/")
    if any(part in {"", ".", ".."} for part in parts) or "\\" in name or "\x00" in name:
        return False
    if parts[0] == "disk":
        rest = parts[1:]
        lengths = DISK_LENGTHS
        if rest and rest[0] == "blake3":
            rest = rest[1:]
            lengths = {64}
        return (len(rest) == 3 and rest[0] in {"ac", "cas"} and len(rest[2]) in lengths and re.fullmatch(r"[0-9a-f]+", rest[2]) is not None and rest[1] == rest[2][:2])
    if parts[0] == "repo" and len(parts) == 5 and parts[1] == "content_addressable":
        length = DIGESTS.get(parts[2])
        if length is None or re.fullmatch(rf"[0-9a-f]{{{length}}}", parts[3]) is None:
            return False
        return parts[4] == "file" or (size == 0 and re.fullmatch(rf"id-[0-9a-f]{{{length}}}", parts[4]) is not None)
    return False


def root_path(path):
    path = Path(path).expanduser().absolute()
    require(not path.is_symlink(), f"cache root cannot be a symlink: {path}")
    path = path.resolve()
    require(path != Path(path.anchor) and path != Path.home().resolve(), "unsafe cache root")
    return path


def disjoint(paths):
    for index, left in enumerate(paths):
        for right in paths[index + 1:]:
            require(left != right and left not in right.parents and right not in left.parents, "cache/snapshot paths overlap")


@contextlib.contextmanager
def staging(output):
    output = root_path(output)
    require(not output.exists() or (output.is_dir() and not any(output.iterdir())), f"output is not empty: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".cache-stage-", dir=output.parent))
    try:
        yield temporary
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def cache_files(root, kind):
    if not root.exists():
        return
    require(root.is_dir(), f"not a cache directory: {root}")
    selected = {"disk": {"ac", "cas", "blake3"}, "repo": {"content_addressable"}}[kind]
    for top in sorted(root.iterdir()):
        if top.name not in selected:
            continue
        require(top.is_dir() and not top.is_symlink(), f"invalid cache directory: {top}")
        for directory, directories, files in os.walk(top, followlinks=False):
            for name in directories:
                require(not (Path(directory) / name).is_symlink(), "symlink in cache")
            for name in sorted(files):
                path = Path(directory) / name
                metadata = path.lstat()
                require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, f"not a private regular cache file: {path}")
                member = kind + "/" + path.relative_to(root).as_posix()
                if valid_member(member, metadata.st_size):
                    yield path, member


def pack(identity_path, disk, repo, output, *, source_sha=None):
    identity = validate_identity(read_json(identity_path))
    disk, repo, output = root_path(disk), root_path(repo), root_path(output)
    disjoint([disk, repo, output])
    with staging(output) as temporary:
        count = 0
        with tarfile.open(temporary / "snapshot.tar.gz", "w:gz", format=tarfile.GNU_FORMAT, compresslevel=1) as archive:
            for kind, root in (("disk", disk), ("repo", repo)):
                for path, name in cache_files(root, kind):
                    with regular_open(path) as source:
                        metadata = os.fstat(source.fileno())
                        require(valid_member(name, metadata.st_size), "cache member changed during pack")
                        info = tarfile.TarInfo(name)
                        info.size = metadata.st_size
                        info.mode = 0o644
                        info.mtime = int(metadata.st_mtime)
                        archive.addfile(info, source)
                        after = os.fstat(source.fileno())
                        require((metadata.st_size, metadata.st_mtime_ns) == (after.st_size, after.st_mtime_ns), "cache file changed during pack")
                    if not name.rsplit("/", 1)[-1].startswith("id-"):
                        count += 1
        require(count > 0, "no supported cache payloads to pack")
        archive_path = temporary / "snapshot.tar.gz"
        source = os.environ.get("GITHUB_SHA", "") if source_sha is None else source_sha
        manifest = validate_manifest({"schema": SCHEMA, "slot": identity["slot"], "identity": identity, "dimension": dimension(identity), "sha256": digest_file(archive_path), "size": archive_path.stat().st_size, "source_sha": source, "run_id": os.environ.get("GITHUB_RUN_ID", ""), "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1"), "created_at": timestamp()})
        atomic_json(temporary / "manifest.json", manifest)
    print(f"Packed {count} files: {manifest['sha256']}")
    return manifest


def verify_archive(path, manifest):
    with regular_open(path) as source:
        require(os.fstat(source.fileno()).st_size == manifest["size"], "archive size mismatch")
    require(digest_file(path) == manifest["sha256"], "archive SHA256 mismatch")


def walk_archive(path, destinations=None):
    seen = set()
    payloads = 0
    with regular_open(path) as source, tarfile.open(fileobj=source, mode="r|gz") as archive:
        for member in archive:
            require(member.isfile() and not member.issparse() and not member.linkname and not member.pax_headers and not archive.pax_headers, f"unsafe archive member: {member.name}")
            require(valid_member(member.name, member.size), f"unsupported archive member: {member.name}")
            require(member.name not in seen, f"duplicate archive member: {member.name}")
            seen.add(member.name)
            kind, relative = member.name.split("/", 1)
            extracted = archive.extractfile(member)
            require(extracted is not None, "missing archive payload")
            with extracted:
                if destinations is not None:
                    destination = destinations[kind] / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with destination.open("xb") as target:
                        shutil.copyfileobj(extracted, target, CHUNK)
                    os.chmod(destination, 0o644)
                    os.utime(destination, (member.mtime, member.mtime))
                else:
                    while extracted.read(CHUNK):
                        pass
            if not relative.rsplit("/", 1)[-1].startswith("id-"):
                payloads += 1
            archive.members.clear()
        while block := archive.fileobj.read(CHUNK):
            require(not any(block), "nonzero trailing archive data")
    require(payloads > 0, "archive contains no supported cache payloads")


def output_value(name, value):
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as target:
            target.write(f"{name}={value}\n")


def preflight_state(identity_outcome, durable_outcome, durable_hit, hot_outcome, hot_hit, hot_matched_key):
    outcomes = {"", "success", "skipped", "failure", "cancelled"}
    if (any(value not in outcomes for value in (identity_outcome, durable_outcome, hot_outcome))
            or durable_hit not in {"", "true", "false"} or hot_hit not in {"", "true", "false"}
            or len(hot_matched_key) > 1024):
        return {"state": "unknown", "source": "none", "reason": "invalid restore metadata"}
    if identity_outcome != "success":
        return {"state": "unknown", "source": "none", "reason": "cache identity unavailable"}
    if durable_outcome == "success" and durable_hit == "true":
        return {"state": "restored", "source": "durable", "reason": "compatible snapshot restored"}
    if hot_outcome == "success" and hot_matched_key:
        if hot_hit == "true":
            return {"state": "restored", "source": "github", "reason": "exact hot-cache key restored"}
        return {"state": "partial", "source": "github", "reason": "prefix-matched hot cache restored"}
    if hot_hit == "true" or durable_hit == "true":
        return {"state": "unknown", "source": "none", "reason": "inconsistent restore metadata"}
    if "failure" in (durable_outcome, hot_outcome) or "cancelled" in (durable_outcome, hot_outcome):
        return {"state": "unknown", "source": "none", "reason": "cache restore unavailable"}
    if hot_outcome == "success":
        return {"state": "cold", "source": "none", "reason": "no cache restored"}
    return {"state": "unknown", "source": "none", "reason": "cache lookup did not complete"}


def record_preflight(output):
    result = preflight_state(*(os.environ.get(name, "") for name in (
        "CACHE_IDENTITY_OUTCOME", "CACHE_DURABLE_OUTCOME", "CACHE_DURABLE_HIT",
        "CACHE_HOT_OUTCOME", "CACHE_HOT_HIT", "CACHE_HOT_MATCHED_KEY",
    )))
    atomic_json(output, result)
    for key in ("state", "source"):
        output_value(key, result[key])
    message = f"Native cache preflight: {result['state']} ({result['source']}; {result['reason']})."
    print(message + " Cache availability is not a guarantee of Bazel action hits.")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as target:
            target.write(message + " Required build and test commands are unchanged.\n")
    return result


def replace_roots(staged):
    backups = {}
    installed = []
    try:
        for destination, source in staged:
            if destination.exists():
                backup = destination.parent / (".cache-backup-" + uuid.uuid4().hex)
                os.replace(destination, backup)
                backups[destination] = backup
            os.replace(source, destination)
            installed.append(destination)
    except BaseException:
        for destination in reversed(installed):
            shutil.rmtree(destination)
        for destination, backup in backups.items():
            os.replace(backup, destination)
        raise
    else:
        for backup in backups.values():
            shutil.rmtree(backup, ignore_errors=True)


def restore(identity_path, snapshot, disk, repo):
    output_value("hit", "false")
    identity = validate_identity(read_json(identity_path))
    snapshot = root_path(snapshot)
    if not (snapshot / "manifest.json").exists():
        print("Cache miss: no manifest")
        return False
    manifest = validate_manifest(read_json(snapshot / "manifest.json"))
    if identity != manifest["identity"]:
        print("Cache miss: incompatible identity")
        return False
    disk, repo = root_path(disk), root_path(repo)
    disjoint([disk, repo, snapshot])
    for root in (disk, repo):
        require(not root.exists() or root.is_dir(), "cache root must be a directory")
    archive = snapshot / "snapshot.tar.gz"
    verify_archive(archive, manifest)
    with contextlib.ExitStack() as stack:
        destinations = {}
        for kind, root in (("disk", disk), ("repo", repo)):
            root.parent.mkdir(parents=True, exist_ok=True)
            destinations[kind] = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix=".cache-restore-", dir=root.parent))) / "root"
            destinations[kind].mkdir()
        walk_archive(archive, destinations)
        replace_roots([(disk, destinations["disk"]), (repo, destinations["repo"])])
    output_value("hit", "true")
    print(f"Cache hit: {manifest['dimension']}")
    return True


class LocalStore:
    def __init__(self, root):
        require(os.environ.get("GITHUB_ACTIONS", "").lower() != "true", "local store forbidden in GitHub Actions")
        self.root = root_path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key):
        require(isinstance(key, str) and key and all(part not in {"", ".", ".."} for part in key.split("/")) and "\\" not in key and not key.startswith("/"), "invalid object key")
        path = self.root / key
        require(self.root in path.resolve().parents, "object escapes store")
        require(not path.is_symlink(), "symlink object")
        return path

    def get(self, key, destination):
        path = self.path(key)
        try:
            with regular_open(path) as source, Path(destination).open("xb") as target:
                shutil.copyfileobj(source, target, CHUNK)
        except FileNotFoundError:
            return False
        return True

    def put(self, key, source, immutable=False):
        path = self.path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        if immutable and path.exists():
            require(digest_file(path) == digest_file(source), "immutable object collision")
            return
        fd, temporary = tempfile.mkstemp(prefix=".cache-upload-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as target, regular_open(source) as origin:
                shutil.copyfileobj(origin, target, CHUNK)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def head(self, key):
        with regular_open(self.path(key)) as source:
            metadata = os.fstat(source.fileno())
        return {"key": key, "size": metadata.st_size, "modified": dt.datetime.fromtimestamp(metadata.st_mtime, dt.timezone.utc)}

    def listing(self):
        result = []
        for directory, directories, files in os.walk(self.root, followlinks=False):
            for name in directories:
                require(not (Path(directory) / name).is_symlink(), "symlink in store listing")
            for name in files:
                result.append(self.head((Path(directory) / name).relative_to(self.root).as_posix()))
        return result

    def delete(self, key):
        self.path(key).unlink()


class S3Store:
    def __init__(self):
        self.bucket = os.environ.get("CI_CACHE_BUCKET", "")
        self.region = os.environ.get("CI_CACHE_REGION", "")
        self.prefix = os.environ.get("CI_CACHE_PREFIX", "").strip("/")
        require(re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", self.bucket) is not None, "CI_CACHE_BUCKET is required")
        require(re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-[0-9]+", self.region) is not None, "CI_CACHE_REGION is required")
        require(self.prefix and all(re.fullmatch(r"[a-zA-Z0-9._-]+", part) and part not in {".", ".."} for part in self.prefix.split("/")), "CI_CACHE_PREFIX is required and must be a safe key prefix")
        self.environment = dict(os.environ)
        if self.environment.get("GITHUB_ACTIONS", "").lower() == "true":
            require(not any(key.startswith("AWS_ENDPOINT_URL") and value for key, value in self.environment.items()), "AWS endpoint overrides forbidden in CI")
            self.environment["AWS_IGNORE_CONFIGURED_ENDPOINT_URLS"] = "true"
        self.environment["AWS_PAGER"] = ""

    def command(self, arguments):
        result = subprocess.run(["aws", *arguments, "--region", self.region], capture_output=True, text=True, env=self.environment)
        if result.returncode:
            raise CacheError(f"AWS cache operation failed: {result.stderr.strip()}")
        return result.stdout

    def key(self, key):
        return self.prefix + "/" + key

    def exists(self, key):
        full_key = self.key(key)
        value = json.loads(self.command(["s3api", "list-objects-v2", "--bucket", self.bucket, "--prefix", full_key, "--max-keys", "1", "--no-paginate", "--output", "json"]))
        require(isinstance(value, dict) and value.get("Prefix") == full_key and type(value.get("MaxKeys")) is int and value["MaxKeys"] == 1, "invalid exact-key S3 listing scope")
        entries = value.get("Contents", [])
        require(type(value.get("IsTruncated")) is bool and type(value.get("KeyCount")) is int and isinstance(entries, list) and value["KeyCount"] == len(entries) and len(entries) <= 1, "invalid exact-key S3 listing count")
        require(not value["IsTruncated"] or len(entries) == 1, "incomplete exact-key S3 listing")
        for item in entries:
            require(isinstance(item, dict) and isinstance(item.get("Key"), str) and item["Key"].startswith(full_key) and type(item.get("Size")) is int and item["Size"] >= 0, "invalid exact-key S3 listing entry")
            parse_time(item.get("LastModified"))
        # General-purpose S3 listings sort exact keys before longer prefix matches.
        return bool(entries) and entries[0]["Key"] == full_key

    def get(self, key, destination):
        if key.startswith("refs/") and not self.exists(key):
            return False
        self.command(["s3api", "get-object", "--bucket", self.bucket, "--key", self.key(key), str(destination), "--output", "json"])
        return True

    def head(self, key):
        value = json.loads(self.command(["s3api", "head-object", "--bucket", self.bucket, "--key", self.key(key), "--output", "json"]))
        return {"key": key, "size": value["ContentLength"], "modified": parse_time(value["LastModified"])}

    def put(self, key, source, immutable=False):
        if immutable and self.exists(key):
            value = json.loads(self.command(["s3api", "head-object", "--bucket", self.bucket, "--key", self.key(key), "--output", "json"]))
            require(value.get("ContentLength") == Path(source).stat().st_size, "immutable object size collision")
            require(value.get("Metadata", {}).get("sha256") == digest_file(source), "immutable object digest collision")
            return
        self.command(["s3", "cp", str(source), f"s3://{self.bucket}/{self.key(key)}", "--sse", "AES256", "--metadata", "sha256=" + digest_file(source), "--only-show-errors"])

    def listing(self):
        result = []
        token = None
        tokens = set()
        while True:
            arguments = ["s3api", "list-objects-v2", "--bucket", self.bucket, "--prefix", self.prefix + "/", "--no-paginate", "--output", "json"]
            if token:
                arguments += ["--continuation-token", token]
            value = json.loads(self.command(arguments))
            require(type(value.get("IsTruncated")) is bool and isinstance(value.get("KeyCount"), int), "incomplete S3 listing")
            entries = value.get("Contents", [])
            require(isinstance(entries, list) and value["KeyCount"] == len(entries), "invalid S3 listing count")
            for item in entries:
                require(isinstance(item.get("Key"), str) and item["Key"].startswith(self.prefix + "/") and type(item.get("Size")) is int, "invalid S3 listing entry")
                result.append({"key": item["Key"][len(self.prefix) + 1:], "size": item["Size"], "modified": parse_time(item["LastModified"])})
            if not value["IsTruncated"]:
                break
            token = value.get("NextContinuationToken")
            require(isinstance(token, str) and token and token not in tokens, "incomplete S3 pagination")
            tokens.add(token)
        return result

    def delete(self, key):
        self.command(["s3api", "delete-object", "--bucket", self.bucket, "--key", self.key(key), "--output", "json"])


def store_for(local_store):
    return LocalStore(local_store) if local_store is not None else S3Store()


def fetch(slot, output, store):
    require(re.fullmatch(SLOT, slot), "invalid slot")
    with staging(output) as temporary:
        pointer_path = temporary / "current.json"
        if not store.get(f"refs/{slot}/current.json", pointer_path):
            print(f"Cache miss: no current snapshot for {slot}")
            return False
        pointer = read_json(pointer_path)
        manifest = validate_pointer(pointer, slot)
        require(store.get(pointer["manifest_key"], temporary / "manifest.json"), "current manifest missing")
        require(read_json(temporary / "manifest.json") == manifest, "current manifest disagrees with pointer")
        require(store.get(pointer["object_key"], temporary / "snapshot.tar.gz"), "current archive missing")
        verify_archive(temporary / "snapshot.tar.gz", manifest)
        pointer_path.unlink()
    print(f"Fetched snapshot: {manifest['sha256']}")
    return True


def trusted_publication(manifest):
    environment = os.environ
    require(environment.get("GITHUB_REPOSITORY") == REPOSITORY, "publication requires protected repository")
    require(environment.get("CACHE_BUILD_RESULT") == "success", "publication requires successful build")
    require(environment.get("GITHUB_SHA") == manifest["source_sha"], "publication source SHA mismatch")
    require(environment.get("GITHUB_RUN_ID") == manifest["run_id"] and environment.get("GITHUB_RUN_ATTEMPT", "1") == manifest["run_attempt"], "publication run mismatch")
    ref = environment.get("GITHUB_REF", "")
    workflow = environment.get("GITHUB_WORKFLOW_REF", "")
    canary_id = environment.get("CI_CACHE_CANARY_ID", "")
    if canary_id:
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,47}", canary_id), "invalid canary ID")
        canary_workflow = f"{REPOSITORY}/.github/workflows/cf-cache-canary.yml@refs/heads/coreforge"
        require(environment.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and ref == "refs/heads/coreforge" and workflow == canary_workflow, "untrusted canary publication source")
        require(environment.get("CI_CACHE_PREFIX", "").endswith("/canary/" + canary_id), "canary prefix mismatch")
        return
    require(environment.get("GITHUB_EVENT_NAME") == "push", "publication requires push event")
    release = f"{REPOSITORY}/.github/workflows/cf-release.yml@{ref}"
    relay = f"{REPOSITORY}/.github/workflows/relay.yml@{ref}"
    trusted_release = workflow == release and (ref == "refs/heads/coreforge" or re.fullmatch(r"refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+", ref))
    trusted_relay = workflow == relay and re.fullmatch(r"refs/tags/relay/v[A-Za-z0-9._-]+", ref)
    require(trusted_release or trusted_relay, "untrusted publication ref/workflow source")


def publish(snapshot, store):
    snapshot = root_path(snapshot)
    manifest = validate_manifest(read_json(snapshot / "manifest.json"))
    trusted_publication(manifest)
    archive = snapshot / "snapshot.tar.gz"
    verify_archive(archive, manifest)
    walk_archive(archive)
    store.put(object_key(manifest), archive, immutable=True)
    require(store.head(object_key(manifest))["size"] == manifest["size"], "uploaded archive size mismatch")
    store.put(manifest_key(manifest), snapshot / "manifest.json", immutable=True)
    with tempfile.TemporaryDirectory(prefix="ci-cache-ref-") as temporary:
        directory = Path(temporary)
        pointer_path = directory / "current.json"
        current_key = f"refs/{manifest['slot']}/current.json"
        previous = None
        if store.get(current_key, pointer_path):
            previous = validate_pointer(read_json(pointer_path), manifest["slot"])
            require(get_json(store, manifest_key(previous), directory) == previous, "current manifest mismatch")
            require(store.head(object_key(previous))["size"] == previous["size"], "current object size mismatch")
        replacing = previous is not None and previous != manifest
        retirement_path = directory / "retired.json"
        if replacing:
            atomic_json(retirement_path, retirement_for(previous, None))
            store.put(retirement_key(previous), retirement_path)
        atomic_json(pointer_path, pointer_for(manifest))
        store.put(current_key, pointer_path)
        if replacing:
            atomic_json(retirement_path, retirement_for(previous, timestamp()))
            store.put(retirement_key(previous), retirement_path)
    print(f"Published snapshot: {manifest['sha256']}")
    return manifest


def get_json(store, key, directory):
    destination = directory / uuid.uuid4().hex
    require(store.get(key, destination), f"listed object disappeared: {key}")
    return read_json(destination)


def prune(store, keep=2, retire=(), apply=False, now=None):
    require(type(keep) is int and keep >= 1, "keep must be at least one")
    if apply and os.environ.get("GITHUB_ACTIONS", "").lower() == "true":
        trusted_publication({"source_sha": os.environ.get("GITHUB_SHA"), "run_id": os.environ.get("GITHUB_RUN_ID"), "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "1")})
    retired = set(retire)
    for entry in retired:
        require(re.fullmatch(SLOT + "/" + HEX, entry), "retire must be SLOT/DIMENSION")
    now = dt.datetime.now(dt.timezone.utc) if now is None else now
    listing = store.listing()
    rows = {}
    for row in listing:
        require(isinstance(row, dict) and isinstance(row.get("key"), str) and type(row.get("size")) is int and row["size"] >= 0 and isinstance(row.get("modified"), dt.datetime), "invalid object listing")
        require(row["key"] not in rows, "duplicate listing key")
        rows[row["key"]] = row
    protected = set()
    manifests = {}
    retirements = {}
    with tempfile.TemporaryDirectory(prefix="ci-cache-prune-") as temporary:
        directory = Path(temporary)
        for key in sorted(rows):
            if not key.startswith("refs/"):
                continue
            match = re.fullmatch(r"refs/(" + SLOT + r")/current\.json", key)
            require(match is not None, "unknown/incomplete current-ref listing")
            pointer = get_json(store, key, directory)
            manifest = validate_pointer(pointer, match[1])
            group = manifest["slot"] + "/" + manifest["dimension"]
            require(group not in retired, "cannot retire a current dimension")
            require(pointer["manifest_key"] in rows and pointer["object_key"] in rows, "current reference target missing from listing")
            require(rows[pointer["object_key"]]["size"] == manifest["size"], "current object size mismatch")
            protected.update((pointer["manifest_key"], pointer["object_key"]))
            manifests[pointer["manifest_key"]] = manifest
        groups = {}
        for key in sorted(rows):
            if not key.startswith("manifests/"):
                continue
            if re.fullmatch(r"manifests/" + SLOT + "/" + HEX + r"/[1-9][0-9]{0,19}-[1-9][0-9]{0,19}\.json", key) is None:
                continue
            manifest = validate_manifest(get_json(store, key, directory))
            require(manifest_key(manifest) == key, "manifest key mismatch")
            require(key not in manifests or manifests[key] == manifest, "current manifest mismatch")
            require(object_key(manifest) in rows and rows[object_key(manifest)]["size"] == manifest["size"], "historical manifest object missing/corrupt")
            manifests[key] = manifest
            group = manifest["slot"] + "/" + manifest["dimension"]
            groups.setdefault(group, []).append(key)
        for group, keys in groups.items():
            keys.sort(key=lambda key: (parse_time(manifests[key]["created_at"]), int(manifests[key]["run_id"]), int(manifests[key]["run_attempt"])), reverse=True)
            if group not in retired:
                historical = [key for key in keys if key not in protected]
                protected.update(historical[:keep])
        for key in sorted(rows):
            if not key.startswith("retired/"):
                continue
            manifest, retired_at = validate_retirement(get_json(store, key, directory), key)
            require(manifests.get(manifest_key(manifest)) == manifest, "retirement manifest missing/mismatch")
            require(object_key(manifest) in rows and rows[object_key(manifest)]["size"] == manifest["size"], "retirement object missing/corrupt")
            retirements[key] = manifest
            if retired_at is None or now - max(retired_at, rows[key]["modified"]) < GRACE:
                protected.update((key, manifest_key(manifest), object_key(manifest)))
        # Grace-protected manifests also retain their objects, including shared objects.
        for key, manifest in manifests.items():
            if key in protected or now - rows[key]["modified"] < GRACE:
                protected.add(key)
                protected.add(object_key(manifest))
        deletions = []
        # Expired markers must disappear before their targets if deletion is interrupted.
        for key, row in sorted(rows.items(), key=lambda item: (not item[0].startswith("retired/"), item[0])):
            known = key in manifests or key in retirements or re.fullmatch(r"objects/" + HEX + r"\.tar\.gz", key) is not None
            if known and key not in protected and now - row["modified"] >= GRACE:
                deletions.append(key)
        plan = {"apply": apply, "delete": deletions, "keep_generations": keep, "retire": sorted(retired)}
        print(canonical(plan).decode())
        if apply:
            for key in deletions:
                store.delete(key)
    return plan


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    identity = commands.add_parser("identity")
    identity.add_argument("--slot", required=True)
    identity.add_argument("--output", required=True)
    pack_parser = commands.add_parser("pack")
    preflight_parser = commands.add_parser("preflight")
    preflight_parser.add_argument("--output", required=True)
    restore_parser = commands.add_parser("restore")
    for command in (pack_parser, restore_parser):
        command.add_argument("--identity", required=True)
        command.add_argument("--disk", required=True)
        command.add_argument("--repo", required=True)
    pack_parser.add_argument("--output", required=True)
    restore_parser.add_argument("--snapshot", required=True)
    fetch_parser = commands.add_parser("fetch")
    fetch_parser.add_argument("--slot", required=True)
    fetch_parser.add_argument("--output", required=True)
    publish_parser = commands.add_parser("publish")
    publish_parser.add_argument("--snapshot", required=True)
    prune_parser = commands.add_parser("prune")
    prune_parser.add_argument("--keep", type=int, default=2)
    prune_parser.add_argument("--retire", action="append", default=[])
    prune_parser.add_argument("--apply", action="store_true")
    for command in (fetch_parser, publish_parser, prune_parser):
        command.add_argument("--local-store")
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "identity":
            value = make_identity(arguments.slot)
            atomic_json(arguments.output, value)
            key = dimension(value)
            print(key)
            output_value("key", key)
        elif arguments.command == "preflight":
            record_preflight(arguments.output)
        elif arguments.command == "pack":
            pack(arguments.identity, arguments.disk, arguments.repo, arguments.output)
        elif arguments.command == "restore":
            restore(arguments.identity, arguments.snapshot, arguments.disk, arguments.repo)
        elif arguments.command == "fetch":
            fetch(arguments.slot, arguments.output, store_for(arguments.local_store))
        elif arguments.command == "publish":
            # Trust checks precede construction of an AWS client or any network call.
            manifest = validate_manifest(read_json(Path(arguments.snapshot) / "manifest.json"))
            trusted_publication(manifest)
            publish(arguments.snapshot, store_for(arguments.local_store))
        else:
            prune(store_for(arguments.local_store), arguments.keep, arguments.retire, arguments.apply)
    except (CacheError, OSError, ValueError, KeyError, TypeError, tarfile.TarError, EOFError, subprocess.SubprocessError) as error:
        print(f"Cache error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
