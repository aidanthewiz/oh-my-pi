"""Receipt regressions using Bun and a host-compiled Node-API addon.

Linux and macOS require Bun and a C compiler on PATH. Other platforms skip
explicitly; missing tools on supported platforms fail rather than claim proof.
No Bazel compilation, credential checks, network access, or real cache roots
are used. The canonical loader and package-version reader run unchanged.
"""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPER = Path(__file__).with_name("ci_cache_canary.py").resolve()
SPEC = importlib.util.spec_from_file_location("ci_cache_canary", HELPER)
canary = importlib.util.module_from_spec(SPEC)
with patch.object(sys, "path", [str(HELPER.parent), *sys.path]):
    SPEC.loader.exec_module(canary)


@unittest.skipUnless(sys.platform in ("linux", "darwin"), "host Node-API fixture supports Linux and macOS")
class CanaryReceiptTests(unittest.TestCase):
    def setUp(self):
        self.compiler = shutil.which("cc") or shutil.which("clang") or shutil.which("gcc")
        if not self.compiler or not shutil.which("bun"):
            self.fail("canary receipt tests require Bun and a C compiler (cc, clang, or gcc) on PATH")
        temporary = tempfile.TemporaryDirectory(prefix="ci-cache-canary-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.runner = self.root / "runner"
        self.runner.mkdir()
        self.checkout = self.root / "build-output"
        self.checkout.mkdir()
        self.addon = self.checkout / "packages/natives/native/pi_natives.linux-x64-baseline.node"
        self.addon.parent.mkdir(parents=True)
        self.evidence = self.root / "native-callbacks"
        self.snapshot = self.root / "snapshot"
        self.snapshot.mkdir()
        (self.snapshot / "status.json").write_text(json.dumps({"state": "miss"}))
        self.receipt = self.runner / "cache-canary-cold.json"
        self.version = json.loads((HELPER.parent.parent / "packages/natives/package.json").read_text())["version"]
        self.identity = {
            "schema": 1,
            "format": canary.cache.FORMAT,
            "slot": canary.SLOT,
            "bazel": "9.2.0",
            "host": {"os": "fixture", "arch": "host"},
            "tools": {"cc": "fixture"},
            "configuration": {},
            "module_toolchains": [],
        }
        self.authority = {
            "source_sha": "1" * 40,
            "aws_credentials_absent": True,
            "oidc_request_authority_absent": True,
            "aws_profile_material_absent": True,
        }
        bin_directory = self.root / "bin"
        bin_directory.mkdir()
        launcher = bin_directory / "bazelisk"
        launcher.write_text('#!/bin/sh\n[ "$2" = "shutdown" ] || exit 1\nexit 0\n')
        launcher.chmod(0o700)
        environment = patch.dict(os.environ, {
            "HOME": str(self.home),
            "TMPDIR": str(self.runner),
            "RUNNER_TEMP": str(self.runner),
            "GITHUB_SHA": self.authority["source_sha"],
            "GITHUB_RUN_ID": "100",
            "GITHUB_RUN_ATTEMPT": "1",
            "PATH": str(bin_directory) + os.pathsep + os.environ.get("PATH", ""),
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def compile_addon(self, version):
        source = self.root / "fixture.c"
        source.write_text(r'''
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern int napi_create_string_utf8(napi_env, const char *, size_t, napi_value *);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_set_named_property(napi_env, napi_value, const char *, napi_value);

static void record(const char *event) {
    FILE *output = fopen(EVIDENCE_PATH, "a");
    if (!output) abort();
    if (fputs(event, output) < 0 || fclose(output) != 0) abort();
}

static napi_value build_version(napi_env env, napi_callback_info info) {
    (void)info;
    record("version:" FIXTURE_VERSION "\n");
    napi_value value;
    if (napi_create_string_utf8(env, FIXTURE_VERSION, sizeof(FIXTURE_VERSION) - 1, &value) != 0) abort();
    return value;
}

napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    record("loaded\n");
    napi_value callback;
    const char *name = "__piNativesBuildVersion";
    if (napi_create_function(env, name, (size_t)-1, build_version, NULL, &callback) != 0) abort();
    if (napi_set_named_property(env, exports, name, callback) != 0) abort();
    return exports;
}
''')
        link_flags = ["-bundle", "-undefined", "dynamic_lookup"] if sys.platform == "darwin" else ["-shared", "-fPIC"]
        result = subprocess.run([
            self.compiler, *link_flags,
            "-DEVIDENCE_PATH=" + json.dumps(str(self.evidence)),
            "-DFIXTURE_VERSION=" + json.dumps(version),
            str(source), "-o", str(self.addon),
        ], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def build_without_bazel(self, rc, log):
        # A real supported cache payload lets the consumer pack its own snapshot.
        payload = self.home / ".cache/omp-bazel-disk/cas/aa" / ("a" * 64)
        payload.parent.mkdir(parents=True, exist_ok=True)
        payload.write_bytes(b"fixture compiled action")
        log.write_text("fixture native build completed\n")
        return log.read_text()

    def run_canary(self):
        output, errors = io.StringIO(), io.StringIO()
        previous = Path.cwd()
        try:
            os.chdir(self.checkout)
            with patch.object(canary, "require_builder", return_value=self.authority), \
                    patch.object(canary.cache, "make_identity", return_value=self.identity), \
                    patch.object(canary, "native_build", side_effect=self.build_without_bazel), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                result = canary.main(["cold", "--snapshot", str(self.snapshot)])
        finally:
            os.chdir(previous)
        return result, output.getvalue(), errors.getvalue()

    def test_unloadable_addon_cannot_produce_success_receipt(self):
        self.addon.write_bytes(b"not a native library\n")
        result, _, errors = self.run_canary()
        self.assertEqual(result, 1, errors)
        self.assertFalse(self.receipt.exists(), "unloadable native bytes received a success receipt")
        self.assertFalse(self.evidence.exists())

    def test_loaded_addon_with_wrong_version_cannot_produce_success_receipt(self):
        wrong_version = self.version + "-canary-wrong"
        self.compile_addon(wrong_version)
        result, _, errors = self.run_canary()
        self.assertEqual(self.evidence.read_text().splitlines(), ["loaded", "version:" + wrong_version])
        self.assertEqual(result, 1, errors)
        self.assertFalse(self.receipt.exists(), "wrong-version native bytes received a success receipt")

    def test_matching_native_callback_allows_receipt_for_exact_loaded_bytes(self):
        self.compile_addon(self.version)
        expected_digest = hashlib.sha256(self.addon.read_bytes()).hexdigest()
        result, _, errors = self.run_canary()
        self.assertEqual(result, 0, errors)
        self.assertEqual(self.evidence.read_text().splitlines(), ["loaded", "version:" + self.version])
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual(receipt["addon_sha256"], expected_digest)
        self.assertEqual(receipt["source_sha"], self.authority["source_sha"])
        self.assertTrue(receipt["confirmed_s3_miss"])
        self.assertFalse(receipt["restored"])


if __name__ == "__main__":
    unittest.main()
