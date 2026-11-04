#!/usr/bin/env python3
"""Decide whether a merged coreforge commit needs an artifact release."""

import argparse
import re
import subprocess
import sys


CACHE_FILES = frozenset({
    b'CONTRIBUTING.md',
    b'docs/ci-cache-iam.md',
    b'.github/workflows/cf-verify.yml',
    b'.github/workflows/cf-release.yml',
    b'.github/workflows/relay.yml',
})
CACHE_PATH = re.compile(
    rb'(?:\.github/workflows/cf-cache-[A-Za-z0-9_-]+\.yml'
    rb'|scripts/(?:test_)?ci_cache(?:_[A-Za-z0-9_-]+)?\.py)'
)
COMMIT = re.compile(r'[0-9a-fA-F]{40}')


def is_cache_path(path: bytes) -> bool:
    return path in CACHE_FILES or CACHE_PATH.fullmatch(path) is not None


def should_release(source: str) -> bool:
    if COMMIT.fullmatch(source) is None:
        raise ValueError('source must be a full 40-hex commit ID')
    result = subprocess.run(
        ['git', 'diff', '--name-only', '--no-renames', '-z', f'{source}^1', source, '--'],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    paths = result.stdout.split(b'\0')[:-1]
    return not paths or any(not is_cache_path(path) for path in paths)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='full 40-hex merged commit ID; compare its first parent')
    args = parser.parse_args()
    try:
        release = should_release(args.source)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'cannot classify artifact release: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode('utf-8', errors='replace').rstrip(), file=sys.stderr)
        return 1
    print('true' if release else 'false')
    return 0


if __name__ == '__main__':
    sys.exit(main())
