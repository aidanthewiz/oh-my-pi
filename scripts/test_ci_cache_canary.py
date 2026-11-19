"""Receipt regressions using Bun and a host-compiled Node-API addon.

Linux and macOS require Bun, a C compiler, and AWS CLI on PATH. Missing
tools on supported platforms fail rather than claim proof.
No Bazel compilation, AWS calls, credential checks, or real cache roots are
used. A loopback-only STS fixture exercises the actual CLI request parser.
"""

import base64
import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs

HELPER = Path(__file__).with_name("ci_cache_canary.py").resolve()
SPEC = importlib.util.spec_from_file_location("ci_cache_canary", HELPER)
canary = importlib.util.module_from_spec(SPEC)
with patch.object(sys, "path", [str(HELPER.parent), *sys.path]):
    SPEC.loader.exec_module(canary)
    import ci_cache_probe as probe


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


class CanaryTrustProbeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ci-cache-trust-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.workflow = f"{probe.cache.REPOSITORY}/.github/workflows/cf-cache-canary.yml@refs/heads/coreforge"
        self.claims = {
            "iss": "https://token.actions.githubusercontent.com",
            "aud": "sts.amazonaws.com",
            "repository_id": "1291753113",
            "repository_owner_id": "259898564",
            "ref": "refs/heads/coreforge",
            "sub": f"repo:{probe.cache.REPOSITORY}:ref:refs/heads/coreforge",
        }
        self.env = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": probe.cache.REPOSITORY,
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/coreforge",
            "GITHUB_WORKFLOW_REF": self.workflow,
            "GITHUB_SHA": "1" * 40,
            "GITHUB_RUN_ID": "123",
            "GITHUB_RUN_ATTEMPT": "1",
            "CI_CACHE_REGION": "us-gov-west-1",
            "CI_CACHE_READ_ROLE": "arn:aws-us-gov:iam::800128555654:role/CoreforgeOmpCacheRead",
            "CI_CACHE_WRITE_ROLE": "arn:aws-us-gov:iam::800128555654:role/CoreforgeOmpCacheWrite",
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://example.invalid/oidc",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "synthetic-request-token",
            "RUNNER_TEMP": str(self.root),
        }

    @staticmethod
    def denied(code="AccessDenied"):
        return subprocess.CompletedProcess([], 254, "", f"An error occurred ({code}) when calling the AssumeRoleWithWebIdentity operation")

    def run_probe(self, claims, results=None):
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        self.issued_token = f"header.{payload}.signature"
        response = io.StringIO(json.dumps({"value": self.issued_token}))
        output, errors = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, self.env, clear=True), \
                patch.object(probe.urllib.request, "urlopen", return_value=response), \
                patch.object(probe.subprocess, "run", side_effect=results or [self.denied(), self.denied()]) as sts, \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = probe.main()
        return result, sts.call_count, errors.getvalue()

    def test_direct_canary_workflow_claim_still_requires_both_iam_denials(self):
        result, calls, errors = self.run_probe({**self.claims, "job_workflow_ref": self.workflow})
        self.assertEqual(result, 0, errors)
        self.assertEqual(calls, 2)
        receipt = json.loads((self.root / "cache-canary-trust-denial.json").read_text())
        self.assertEqual([row["result"] for row in receipt["roles"]], ["AccessDenied", "AccessDenied"])
        self.assertEqual(receipt["oidc"]["job_workflow_ref"], self.workflow)
        self.assertTrue(all(not row["broker_claim_absent"] for row in receipt["roles"]))

    def test_legacy_direct_token_without_workflow_claim_is_supported(self):
        result, calls, errors = self.run_probe(self.claims)
        self.assertEqual(result, 0, errors)
        self.assertEqual(calls, 2)

    def test_trusted_broker_tokens_are_rejected_before_sts(self):
        for role in ("read", "write"):
            with self.subTest(role=role):
                workflow = f"{probe.cache.REPOSITORY}/.github/workflows/cf-cache-{role}.yml@" + "a" * 40
                result, calls, _ = self.run_probe({**self.claims, "job_workflow_ref": workflow})
                self.assertEqual(result, 1)
                self.assertEqual(calls, 0)
                self.assertFalse((self.root / "cache-canary-trust-denial.json").exists())

    def test_different_or_empty_workflow_claim_is_rejected(self):
        for workflow in (self.workflow.replace("refs/heads/coreforge", "refs/heads/other"), ""):
            with self.subTest(workflow=workflow):
                result, calls, _ = self.run_probe({**self.claims, "job_workflow_ref": workflow})
                self.assertEqual(result, 1)
                self.assertEqual(calls, 0)

    def test_successful_role_assumption_cannot_produce_denial_evidence(self):
        result, _, _ = self.run_probe(self.claims, [subprocess.CompletedProcess([], 0, "{}", "")])
        self.assertEqual(result, 1)
        self.assertFalse((self.root / "cache-canary-trust-denial.json").exists())

    def test_denial_of_only_the_first_role_is_insufficient(self):
        result, calls, _ = self.run_probe(self.claims, [self.denied(), subprocess.CompletedProcess([], 0, "{}", "")])
        self.assertEqual(result, 1)
        self.assertEqual(calls, 2)
        self.assertFalse((self.root / "cache-canary-trust-denial.json").exists())

    def test_invalid_identity_token_is_not_an_iam_denial(self):
        denied = self.denied("InvalidIdentityToken")
        denied.stderr += ": do-not-log-raw-response"
        result, _, errors = self.run_probe(self.claims, [denied])
        self.assertEqual(result, 1)
        self.assertIn("exit=254 error=InvalidIdentityToken", errors)
        self.assertNotIn("do-not-log-raw-response", errors)
        self.assertFalse((self.root / "cache-canary-trust-denial.json").exists())

    def test_cli_failures_report_safe_categories_without_raw_stderr(self):
        cases = [
            ("Error parsing parameter '--cli-input-json': do-not-log-token", "invalid-cli-json-input"),
            ("Invalid endpoint: do-not-log-endpoint", "invalid-endpoint"),
            ("Unknown options: do-not-log-value", "unsupported-cli-option"),
            ("SSL validation failed for do-not-log-url", "tls-validation-failure"),
            ("Could not connect to the endpoint URL: do-not-log-url", "endpoint-connection-failure"),
            ("Unable to locate credentials. do-not-log-value", "credentials-unavailable"),
            ("Failed to connect to proxy URL: do-not-log-url", "proxy-connection-failure"),
            ("unrecognized failure do-not-log-token", "unclassified-cli-error"),
        ]
        for stderr, code in cases:
            with self.subTest(code=code):
                result, _, errors = self.run_probe(self.claims, [subprocess.CompletedProcess([], 252, "", stderr)])
                self.assertEqual(result, 1)
                self.assertIn(f"exit=252 error={code}", errors)
                self.assertNotIn("do-not-log", errors)
                self.assertFalse((self.root / "cache-canary-trust-denial.json").exists())

    @unittest.skipUnless(os.name == "posix", "the protected Linux canary uses /dev/stdin")
    def test_real_cli_reads_stdin_once_and_reaches_both_local_denials(self):
        aws = shutil.which("aws")
        if aws is None:
            self.fail("the local request-parser regression requires AWS CLI on PATH")
        requests = []

        class DenySTS(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append(self.rfile.read(int(self.headers["Content-Length"])))
                body = (
                    b'<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">'
                    b"<Error><Type>Sender</Type><Code>AccessDenied</Code>"
                    b"<Message>Local test denial</Message></Error>"
                    b"<RequestId>local-only</RequestId></ErrorResponse>"
                )
                self.send_response(403)
                self.send_header("Content-Type", "text/xml")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), DenySTS)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        real_run = subprocess.run

        def invoke_local_sts(arguments, **kwargs):
            return real_run(
                [aws, *arguments[1:], "--endpoint-url", f"http://127.0.0.1:{server.server_port}"],
                **kwargs,
                env={
                    "PATH": os.defpath,
                    "HOME": str(self.root),
                    "AWS_CONFIG_FILE": os.devnull,
                    "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
                    "AWS_EC2_METADATA_DISABLED": "true",
                    "AWS_PAGER": "",
                },
            )

        try:
            result, _, errors = self.run_probe(self.claims, invoke_local_sts)
        finally:
            server.shutdown()
            worker.join()
            server.server_close()
        self.assertEqual(result, 0, errors)
        self.assertEqual(len(requests), 2)
        common = {
            "Action": ["AssumeRoleWithWebIdentity"],
            "Version": ["2011-06-15"],
            "RoleSessionName": ["cache-denial-" + self.env["GITHUB_RUN_ID"]],
            "WebIdentityToken": [self.issued_token],
            "DurationSeconds": ["900"],
        }
        self.assertEqual(
            [parse_qs(request.decode("utf-8"), keep_blank_values=True, strict_parsing=True) for request in requests],
            [
                {**common, "RoleArn": [self.env["CI_CACHE_READ_ROLE"]]},
                {**common, "RoleArn": [self.env["CI_CACHE_WRITE_ROLE"]]},
            ],
        )
        receipt = json.loads((self.root / "cache-canary-trust-denial.json").read_text())
        self.assertEqual([row["result"] for row in receipt["roles"]], ["AccessDenied", "AccessDenied"])



if __name__ == "__main__":
    unittest.main()
