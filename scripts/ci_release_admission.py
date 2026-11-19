#!/usr/bin/env python3
"""Require a merged pull request and qualified source before an automatic release."""

import argparse
import json
import os
import re
import subprocess
import sys


COMMIT = re.compile(r'[0-9a-f]{40}')
REPOSITORY = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+')


def github_api(endpoint, *, paginate=False):
    args = ['gh', 'api', endpoint]
    if paginate:
        args.extend(['--paginate', '--slurp'])
    result = subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return json.loads(result.stdout)


def paged_items(endpoint, collection=None):
    pages = github_api(endpoint, paginate=True)
    if not isinstance(pages, list):
        raise ValueError('GitHub returned malformed paginated release qualification metadata')
    items = []
    for page in pages:
        values = page if collection is None else page.get(collection) if isinstance(page, dict) else None
        if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
            raise ValueError('GitHub returned malformed release qualification metadata')
        items.extend(values)
    return items


def merged_pull(pulls, source, repository):
    matches = [pull for pull in pulls
               if pull.get('merged_at') and pull.get('merge_commit_sha') == source
               and isinstance(pull.get('base'), dict) and pull['base'].get('ref') == 'coreforge']
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError(f'{source} must identify exactly one merged coreforge pull request')
    pull = matches[0]
    number = pull.get('number')
    if type(number) is not int or number <= 0:
        raise ValueError('Merged pull request has no valid number')
    head = pull.get('head')
    if not isinstance(head, dict) or not isinstance(head.get('sha'), str) or not COMMIT.fullmatch(head['sha']):
        raise ValueError(f'PR #{number} has no exact qualified head SHA')
    for side in (pull['base'], head):
        repo = side.get('repo')
        if not isinstance(repo, dict) or repo.get('full_name') != repository:
            raise ValueError(f'PR #{number} must qualify a head from {repository}')
    return pull


def require_required_ci(checks, head):
    required = [check for check in checks
                if check.get('name') == 'required CI' and isinstance(check.get('app'), dict)
                and check['app'].get('slug') == 'github-actions']
    if not required:
        raise ValueError(f'No GitHub Actions required CI check exists for PR head {head}; automatic release denied')
    if any(type(check.get('id')) is not int or check['id'] <= 0 for check in required):
        raise ValueError('required CI check has no valid GitHub check-run identity')
    check = max(required, key=lambda candidate: candidate['id'])
    if check.get('head_sha') != head:
        raise ValueError(f'required CI does not qualify the exact PR head {head}')
    if check.get('status') != 'completed' or check.get('conclusion') != 'success':
        raise ValueError(
            f'required CI for {head} is {check.get("status")}/{check.get("conclusion")}; '
            'a completed successful check is required before automatic release'
        )


def commit_tree(commit, expected_sha):
    if not isinstance(commit, dict) or commit.get('sha') != expected_sha:
        raise ValueError(f'GitHub did not return the requested commit {expected_sha}')
    tree = commit.get('tree')
    sha = tree.get('sha') if isinstance(tree, dict) else None
    if not isinstance(sha, str) or not COMMIT.fullmatch(sha):
        raise ValueError(f'Commit {expected_sha} has no valid Git tree')
    return sha


def qualify_release(source, repository):
    if not isinstance(source, str) or not COMMIT.fullmatch(source):
        raise ValueError('release source must be a full lowercase 40-hex commit ID')
    if not isinstance(repository, str) or not REPOSITORY.fullmatch(repository):
        raise ValueError('GITHUB_REPOSITORY must identify the release repository')
    prefix = f'repos/{repository}'
    pulls = paged_items(f'{prefix}/commits/{source}/pulls?per_page=100')
    pull = merged_pull(pulls, source, repository)
    if pull is None:
        return None
    head = pull['head']['sha']
    checks = paged_items(
        f'{prefix}/commits/{head}/check-runs?check_name=required%20CI&filter=latest&per_page=100',
        'check_runs',
    )
    require_required_ci(checks, head)
    source_tree = commit_tree(github_api(f'{prefix}/git/commits/{source}'), source)
    head_tree = commit_tree(github_api(f'{prefix}/git/commits/{head}'), head)
    if source_tree != head_tree:
        raise ValueError(
            f'Merged source {source} differs from qualified PR #{pull["number"]} head {head}; '
            'merge an up-to-date PR with required CI for the complete release content'
        )
    return pull['number'], head


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', help='full 40-hex automatic release source commit')
    args = parser.parse_args()
    try:
        qualified = qualify_release(args.source, os.environ.get('GITHUB_REPOSITORY'))
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        print(f'cannot qualify automatic engine release: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode('utf-8', errors='replace').rstrip(), file=sys.stderr)
        return 1
    if qualified is None:
        print(f'{args.source} is not an exact merged coreforge PR source; no automatic release', file=sys.stderr)
        print('false')
    else:
        number, head = qualified
        print(f'Automatic release source matches qualified PR #{number} head {head}', file=sys.stderr)
        print('true')
    return 0


if __name__ == '__main__':
    sys.exit(main())
