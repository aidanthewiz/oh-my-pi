#!/usr/bin/env python3
"""Decide whether a merged coreforge commit needs an artifact release."""

import argparse
import json
import re
import subprocess
import sys

from ci_pr_scope import is_documentation_change


CACHE_FILES = frozenset({
    b'.github/workflows/cf-verify.yml',
    b'.github/workflows/relay.yml',
})
CACHE_PATH = re.compile(
    rb'(?:\.github/workflows/cf-cache-[A-Za-z0-9_-]+\.yml'
    rb'|scripts/(?:test_)?ci_cache(?:_[A-Za-z0-9_-]+)?\.py)'
)
COMMIT = re.compile(r'[0-9a-fA-F]{40}')
PUBLISHED_TAG = re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+\.[1-9][0-9]*')
RAW_CHANGE = re.compile(rb':([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z][0-9]*)')
RELEASE_WORKFLOW = b'.github/workflows/cf-release.yml'
PR_WORKFLOW = b'.github/workflows/cf-verify-target.yml'
START = '# coreforge-cache-publication:start'
END = '# coreforge-cache-publication:end'
CACHE_STEPS = frozenset({
    ('cache-identity', 'Identify compatible Bazel caches'),
    ('cache-download', 'Download durable Bazel snapshot'),
    ('cache-restore', 'Restore durable Bazel snapshot'),
    ('bazel-cache', 'Restore Bazel native build cache'),
    ('bazel-cache', 'Restore compatible GitHub hot cache'),
    ('cache-pack', 'Prepare successful durable cache candidate'),
    ('pr-cache', 'Restore verified merged-PR cache'),
    (None, 'Report unavailable durable cache'),
    (None, 'Save Bazel native build cache'),
    (None, 'Save successful GitHub hot cache'),
    (None, 'Retain durable cache candidate for successful-release publication'),
})
PR_CACHE_STEPS = frozenset({
    ('cache-preflight', 'Report native cache preflight'),
    ('pr-cache-close', 'Stop successful PR Bazel server before cache export'),
    (None, 'Save successful PR hot cache'),
    ('pr-cache-pack', 'Prepare successful PR cache snapshot'),
    (None, 'Retain PR cache provenance'),
    (None, 'Retain PR cache payload'),
})


def command(args, data=None):
    return subprocess.run(
        args, input=data, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout


def strip_publication_region(run):
    lines = run.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if line.strip() == START]
    ends = [i for i, line in enumerate(lines) if line.strip() == END]
    if not starts and not ends:
        return run
    if len(starts) != 1 or len(ends) != 1 or starts[0] >= ends[0]:
        raise ValueError('malformed cache publication region')
    end = ends[0] + 1
    if end < len(lines) and lines[end] == '\n':
        end += 1
    return ''.join(lines[:starts[0]] + lines[end:])


def parse_workflow(contents):
    parsed = json.loads(command([
        'bun', '-e', 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))',
    ], contents))
    if not isinstance(parsed, dict) or not isinstance(parsed.get('jobs'), dict):
        raise ValueError('workflow must contain jobs')
    return parsed


def workflow_projection(contents):
    parsed = parse_workflow(contents)
    jobs = parsed['jobs']
    jobs.pop('cache_restore', None)
    jobs.pop('cache_publish', None)
    for name in ('build', 'release', 'verify_release'):
        job = jobs.get(name)
        if not isinstance(job, dict):
            raise ValueError(f'release workflow must contain {name}')
        suffix = {'build': '', 'release': " && needs.build.result == 'success'",
                  'verify_release': " && needs.release.result == 'success'"}[name]
        lifted = ("${{ !cancelled() && needs.prepare.result == 'success' && "
                  "needs.prepare.outputs.should_release == 'true'" + suffix + " }}")
        if job.get('if') == lifted:
            job['if'] = "needs.prepare.outputs.should_release == 'true'"
    build = jobs['build']
    if build.get('name') == 'build (${{ matrix.target }})':
        build.pop('name')
    if build.get('permissions') == {'contents': 'read', 'pull-requests': 'read', 'actions': 'read'}:
        build.pop('permissions')
    needs = build.get('needs')
    if isinstance(needs, list):
        needs = [name for name in needs if name != 'cache_restore']
        build['needs'] = needs[0] if len(needs) == 1 else needs
    build['steps'] = [step for step in build['steps']
                      if (step.get('id'), step.get('name')) not in CACHE_STEPS]
    for step in jobs['prepare']['steps']:
        if step.get('id') == 'release':
            step['run'] = strip_publication_region(step['run'])
    return parsed


def pr_workflow_projection(contents):
    parsed = parse_workflow(contents)
    build = parsed['jobs'].get('build')
    if not isinstance(build, dict):
        raise ValueError('PR workflow must contain build')
    build['steps'] = [step for step in build['steps']
                      if (step.get('id'), step.get('name')) not in PR_CACHE_STEPS]
    for step in build['steps']:
        if step.get('name') == 'Restore compatible GitHub hot cache' and step.get('id') == 'bazel-cache':
            step.pop('id')
    return parsed


def cache_only_workflow_change(base, source, path=RELEASE_WORKFLOW):
    old = command(['git', 'show', f'{base}:{path.decode()}'])
    new = command(['git', 'show', f'{source}:{path.decode()}'])
    projection = pr_workflow_projection if path == PR_WORKFLOW else workflow_projection
    return projection(old) == projection(new)


def is_cache_path(path: bytes) -> bool:
    return path in CACHE_FILES or CACHE_PATH.fullmatch(path) is not None


def should_release(source: str, published_ref: str | None = None) -> bool:
    if COMMIT.fullmatch(source) is None:
        raise ValueError('source must be a full 40-hex commit ID')
    command(['git', 'rev-parse', '--verify', f'{source}^1'])
    if not published_ref:
        return True
    if COMMIT.fullmatch(published_ref):
        ref = published_ref
    elif PUBLISHED_TAG.fullmatch(published_ref):
        ref = f'refs/tags/{published_ref}'
    else:
        raise ValueError('published ref must be a full commit ID or four-part engine tag')
    base = command(['git', 'rev-parse', '--verify', f'{ref}^{{commit}}']).decode().strip()
    command(['git', 'merge-base', '--is-ancestor', base, source])
    output = command([
        'git', 'diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, source, '--',
    ])
    if not output:
        return True
    records = output.split(b'\0')
    if records[-1] != b'' or len(records) % 2 != 1:
        raise ValueError('malformed NUL-delimited release diff')
    for index in range(0, len(records) - 1, 2):
        header, path = records[index:index + 2]
        change = RAW_CHANGE.fullmatch(header)
        if change is None or not path:
            raise ValueError('malformed release diff entry')
        old_mode, new_mode, status = change.groups()
        regular = (
            status == b'A' and old_mode == b'000000' and new_mode in (b'100644', b'100755')
            or status == b'D' and old_mode in (b'100644', b'100755') and new_mode == b'000000'
            or status == b'M' and old_mode == new_mode and old_mode in (b'100644', b'100755')
        )
        if not regular:
            return True
        if is_documentation_change(path, old_mode, new_mode, status):
            continue
        if path in (RELEASE_WORKFLOW, PR_WORKFLOW):
            if status != b'M' or not cache_only_workflow_change(base, source, path):
                return True
        elif not is_cache_path(path):
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='full 40-hex merged commit ID')
    parser.add_argument('--published-ref', help='published engine tag or commit; absent means release required')
    args = parser.parse_args()
    try:
        release = should_release(args.source, args.published_ref)
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        print(f'cannot classify artifact release: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode('utf-8', errors='replace').rstrip(), file=sys.stderr)
        return 1
    print('true' if release else 'false')
    return 0


if __name__ == '__main__':
    sys.exit(main())
