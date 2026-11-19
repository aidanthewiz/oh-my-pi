#!/usr/bin/env python3
"""Classify an exact PR diff before admitting documentation-only CI skips."""

import argparse
from pathlib import Path
import re
import subprocess
import sys

COMMIT = re.compile(r'[0-9a-f]{40}')
ROOT_DOCUMENTS = frozenset((b'README.md', b'CONTRIBUTING.md'))


def is_documentation_change(path: bytes, old_mode: bytes, new_mode: bytes, status: bytes) -> bool:
    if path not in ROOT_DOCUMENTS:
        return False
    if status == b'A':
        return old_mode == b'000000' and new_mode == b'100644'
    if status == b'D':
        return old_mode == b'100644' and new_mode == b'000000'
    return status == b'M' and old_mode == new_mode == b'100644'


def classify_diff(raw: bytes) -> str:
    if not raw:
        return 'full'
    fields = raw.split(b'\0')
    if fields.pop() != b'' or len(fields) % 2:
        raise ValueError('malformed raw Git diff')
    documentation_only = True
    for offset in range(0, len(fields), 2):
        header, path = fields[offset:offset + 2]
        if re.fullmatch(rb':[0-7]{6} [0-7]{6} [0-9a-f]{40} [0-9a-f]{40} [A-Z][0-9]*', header) is None or not path:
            raise ValueError('malformed raw Git diff record')
        old_mode, new_mode, old_oid, new_oid, status = header[1:].split(b' ')
        if ((old_mode == b'000000') != (old_oid == b'0' * 40)
                or (new_mode == b'000000') != (new_oid == b'0' * 40)):
            raise ValueError('inconsistent raw Git diff object identity')
        if not is_documentation_change(path, old_mode, new_mode, status):
            documentation_only = False
    return 'docs' if documentation_only else 'full'


def git(repository: Path, *args: str) -> bytes:
    result = subprocess.run(['git', '--no-replace-objects', *args], cwd=repository,
                            capture_output=True, check=False)
    if result.returncode:
        raise ValueError(f'Git {args[0]} failed: {result.stderr.decode(errors="replace").strip()}')
    return result.stdout


def plan_scope(repository: Path, base_sha: str, source_sha: str) -> str:
    if COMMIT.fullmatch(base_sha) is None or COMMIT.fullmatch(source_sha) is None:
        raise ValueError('base and source must be exact 40-hex commit IDs')
    if git(repository, 'rev-parse', '--verify', 'HEAD').decode().strip() != source_sha:
        raise ValueError('checkout does not match the exact PR head')
    if git(repository, 'rev-parse', '--verify', f'{base_sha}^{{commit}}').decode().strip() != base_sha:
        raise ValueError('base does not identify the exact PR base commit')
    ancestors = git(repository, 'merge-base', '--all', base_sha, source_sha).splitlines()
    if len(ancestors) != 1 or re.fullmatch(rb'[0-9a-f]{40}', ancestors[0]) is None:
        raise ValueError('PR diff requires one unambiguous merge base')
    merge_base = ancestors[0].decode()
    options = ('--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none')
    raw = git(repository, 'diff', '--raw', '-z', '--no-abbrev', *options, merge_base, source_sha, '--')
    scope = classify_diff(raw)
    if scope == 'docs':
        git(repository, '-c', 'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab',
            'diff', '--check', *options, merge_base, source_sha, '--')
    return scope


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('base_sha')
    parser.add_argument('source_sha')
    args = parser.parse_args()
    try:
        scope = plan_scope(Path.cwd(), args.base_sha, args.source_sha)
    except (OSError, ValueError) as error:
        print(f'cannot classify PR scope: {error}', file=sys.stderr)
        return 1
    print(f'scope={scope}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
