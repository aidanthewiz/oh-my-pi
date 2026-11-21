#!/usr/bin/env python3
"""Prove cache roles reject a real OIDC token outside the pinned broker jobs."""

import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse
import urllib.request

import ci_cache as cache


def _failure_code(stderr):
    match = re.search(r"An error occurred \(([A-Za-z][A-Za-z0-9]{0,63})\)", stderr)
    if match:
        return match[1]
    for marker, code in (
        ("Error parsing parameter '--cli-input-json'", "invalid-cli-json-input"),
        ("Invalid endpoint:", "invalid-endpoint"),
        ("Unknown options:", "unsupported-cli-option"),
        ("SSL validation failed", "tls-validation-failure"),
        ("Could not connect to the endpoint URL", "endpoint-connection-failure"),
        ("Unable to locate credentials", "credentials-unavailable"),
        ("Failed to connect to proxy URL", "proxy-connection-failure"),
    ):
        if marker in stderr:
            return code
    return "unclassified-cli-error"


def main():
    try:
        expected_workflow = f"{cache.REPOSITORY}/.github/workflows/cf-cache-canary.yml@refs/heads/coreforge"
        cache.require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_REPOSITORY") == cache.REPOSITORY, "probe requires the owned GitHub canary")
        cache.require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and os.environ.get("GITHUB_REF") == "refs/heads/coreforge", "probe requires protected deliberate dispatch")
        cache.require(os.environ.get("GITHUB_WORKFLOW_REF") == expected_workflow, "unexpected probe workflow source")
        region = os.environ["CI_CACHE_REGION"]
        cache.require(region == "us-gov-west-1", "unexpected probe region")
        url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
        parsed = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        query = [(key, value) for key, value in query if key != "audience"] + [("audience", "sts.amazonaws.com")]
        url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]})
        with urllib.request.urlopen(request, timeout=30) as response:
            token = json.load(response)["value"]
        parts = token.split(".")
        cache.require(len(parts) == 3, "invalid OIDC token shape")
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        cache.require(claims.get("iss") == "https://token.actions.githubusercontent.com" and claims.get("aud") == "sts.amazonaws.com", "unexpected probe OIDC issuer/audience")
        cache.require(claims.get("repository_id") == "1291753113" and claims.get("repository_owner_id") == "259898564", "unexpected probe repository identity")
        cache.require(claims.get("ref") == "refs/heads/coreforge" and claims.get("sub") == f"repo:{cache.REPOSITORY}:ref:refs/heads/coreforge", "default subject/ref changed")
        cache.require(claims.get("job_workflow_ref") in (None, expected_workflow), "negative probe token identifies a different workflow")
        receipt = {"schema": 1, "source_sha": os.environ["GITHUB_SHA"], "run_id": os.environ["GITHUB_RUN_ID"], "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"], "oidc": {key: claims.get(key) for key in ("iss", "aud", "sub", "repository_id", "repository_owner_id", "job_workflow_ref", "ref")}, "roles": []}
        for name, role_name in (("CI_CACHE_READ_ROLE", "CoreforgeOmpCacheRead"), ("CI_CACHE_WRITE_ROLE", "CoreforgeOmpCacheWrite")):
            role = os.environ[name]
            cache.require(role == f"arn:aws-us-gov:iam::800128555654:role/{role_name}", "unexpected probe role")
            result = subprocess.run(
                ["aws", "sts", "assume-role-with-web-identity",
                 "--role-arn", role,
                 "--role-session-name", "cache-denial-" + os.environ["GITHUB_RUN_ID"],
                 "--web-identity-token", "file:///dev/stdin",
                 "--duration-seconds", "900", "--region", region,
                 "--output", "json", "--no-cli-pager", "--no-sign-request"],
                input=token, text=True, capture_output=True, timeout=60,
            )
            cache.require(result.returncode != 0, "cache role incorrectly admitted non-broker OIDC source: " + role_name)
            error_code = _failure_code(result.stderr)
            cache.require(error_code == "AccessDenied", f"cache denial probe failed for {role_name}: exit={result.returncode} error={error_code}")
            receipt["roles"].append({"arn": role, "result": "AccessDenied", "broker_claim_absent": claims.get("job_workflow_ref") is None})
        output = Path(os.environ["RUNNER_TEMP"]) / "cache-canary-trust-denial.json"
        cache.atomic_json(output, receipt)
        print("Both cache roles rejected the real non-broker OIDC identity with IAM AccessDenied.")
        return 0
    except (cache.CacheError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"Cache trust probe error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
