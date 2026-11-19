#!/usr/bin/env python3
"""Require the exact CI inventory selected by a verified pull request plan."""

import argparse
import json
import os
import re

FULL_JOBS = (
    'prepare', 'darwin_arm64', 'darwin_x64', 'linux_x64', 'linux_arm64',
    'linux_musl_x64', 'linux_musl_arm64', 'win32_x64', 'win32_arm64', 'browser_relay',
)
REQUIRED_JOBS = frozenset(('plan', *FULL_JOBS))


def require_success(needs, base_sha, source_sha):
    if any(not isinstance(sha, str) or re.fullmatch(r'[0-9a-f]{40}', sha) is None
           for sha in (base_sha, source_sha)):
        raise ValueError('CI requires exact base and source commit IDs')
    if not isinstance(needs, dict) or set(needs) != REQUIRED_JOBS:
        raise ValueError('CI dependency inventory does not match the required jobs')
    plan = needs['plan']
    if not isinstance(plan, dict) or plan.get('result') != 'success':
        raise ValueError('Required CI planning did not succeed')
    outputs = plan.get('outputs')
    if not isinstance(outputs, dict) or outputs.get('base_sha') != base_sha or outputs.get('source_sha') != source_sha:
        raise ValueError('CI plan does not match the exact PR identity')
    scope = outputs.get('scope')
    if scope not in ('docs', 'full'):
        raise ValueError(f'Unknown CI plan scope: {scope!r}')
    expected = 'skipped' if scope == 'docs' else 'success'
    failed = []
    for name in FULL_JOBS:
        dependency = needs[name]
        result = dependency.get('result') if isinstance(dependency, dict) else None
        if result != expected:
            failed.append(f'{name}={result!r}')
    if failed:
        raise ValueError(f'Required CI expected {expected}: ' + ', '.join(failed))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base_sha')
    parser.add_argument('source_sha')
    args = parser.parse_args()
    needs = json.loads(os.environ['NEEDS'])
    require_success(needs, args.base_sha, args.source_sha)
    print(f'Required CI passed: {needs["plan"]["outputs"]["scope"]}')


if __name__ == '__main__':
    try:
        main()
    except (KeyError, TypeError, ValueError) as error:
        raise SystemExit(str(error)) from None
