#!/usr/bin/env python3
"""Authorize credential-broker cache operations before requesting AWS credentials."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import urllib.parse
import urllib.request

REPOSITORY = 'Coreforce-CAD/oh-my-pi'
REPOSITORY_ID = 1291753113
OWNER_ID = 259898564
ACCOUNT = '800128555654'
BRANCH = 'refs/heads/coreforge'
CANARY_PATH = '.github/workflows/cf-cache-canary.yml'
TARGETS = ('darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64',
           'linux-musl-x64', 'linux-musl-arm64', 'win32-x64', 'win32-arm64')
RELEASE_SLOTS = ('darwin-arm64-xcode-27', 'darwin-x64-macos-15-intel',
                 'linux-x64-ubuntu-22.04', 'linux-arm64-ubuntu-24.04-arm',
                 'linux-musl-x64-ubuntu-22.04', 'linux-musl-arm64-ubuntu-24.04-arm',
                 'win32-x64-ubuntu-24.04')
CLAIMS = ('iss', 'aud', 'sub', 'repository_id', 'repository_owner_id', 'job_workflow_ref', 'ref')


class Refused(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise Refused('Cache authorization refused: ' + reason)


class GitHubAPI:
    def __init__(self, token):
        self.token = token

    def __call__(self, suffix):
        request = urllib.request.Request(
            f'https://api.github.com/repos/{REPOSITORY}/{suffix}',
            headers={'Authorization': 'Bearer ' + self.token,
                     'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)


def pages(api, suffix, field):
    result = []
    page = 1
    total = None
    while True:
        data = api(f'{suffix}{"&" if "?" in suffix else "?"}per_page=100&page={page}')
        batch = data[field]
        require(isinstance(batch, list), 'invalid API listing')
        count = data['total_count']
        require(type(count) is int and count >= 0 and (total is None or count == total),
                'inconsistent API listing count')
        total = count
        result.extend(batch)
        if len(result) == total:
            return result
        require(batch and len(result) < total, 'incomplete API listing')
        page += 1


def identity(env):
    require(env['GITHUB_REPOSITORY'] == REPOSITORY
            and env['GITHUB_REPOSITORY_ID'] == str(REPOSITORY_ID)
            and env['GITHUB_REPOSITORY_OWNER_ID'] == str(OWNER_ID), 'unexpected repository identity')


def current_source(env, api, helper_sha, sha):
    require(re.fullmatch(r'[0-9a-f]{40}', sha) is not None, 'invalid source SHA')
    require(sha == env['GITHUB_SHA'] == env['CALLER_WORKFLOW_SHA'] == helper_sha,
            'source/helper/workflow SHA mismatch')
    require(api('git/ref/heads/coreforge')['object']['sha'] == sha,
            'source is no longer current coreforge tip')


def caller(env, path):
    require(env['CALLER_WORKFLOW_REF'] == f'{REPOSITORY}/{path}@{env["GITHUB_REF"]}',
            'unexpected caller workflow')


def run_source(env, api, path, event, sha):
    run_id, attempt = int(env['GITHUB_RUN_ID']), int(env['GITHUB_RUN_ATTEMPT'])
    run = api(f'actions/runs/{run_id}/attempts/{attempt}')
    require(run['id'] == run_id and run['run_attempt'] == attempt
            and run['event'] == event and run['head_sha'] == sha
            and run['repository']['full_name'] == REPOSITORY
            and run['repository']['id'] == REPOSITORY_ID
            and run['repository']['owner']['id'] == OWNER_ID
            and run['head_repository']['full_name'] == REPOSITORY
            and run['head_repository']['id'] == REPOSITORY_ID
            and run['path'].split('@', 1)[0] == path, 'run provenance mismatch')
    require(api(f'actions/workflows/{run["workflow_id"]}')['path'] == path,
            'workflow identity mismatch')
    if event == 'workflow_dispatch' or env['GITHUB_REF'] == BRANCH:
        require(run['head_branch'] == 'coreforge', 'unexpected source branch')
    return run


def canary(env, api, helper_sha):
    canary_id = env.get('CANARY_ID', '')
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,47}', canary_id) is not None, 'invalid canary id')
    require(env['GITHUB_EVENT_NAME'] == 'workflow_dispatch' and env['GITHUB_REF'] == BRANCH,
            'canary requires protected default-branch dispatch')
    caller(env, CANARY_PATH)
    current_source(env, api, helper_sha, env['GITHUB_SHA'])
    return run_source(env, api, CANARY_PATH, 'workflow_dispatch', env['GITHUB_SHA'])


def configuration(env, role):
    missing = [name for name in ('CI_CACHE_BUCKET', 'CI_CACHE_REGION', 'CI_CACHE_PREFIX', role)
               if not env.get(name)]
    require(not missing, 'configuration incomplete: ' + ', '.join(missing))
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]*(?:/[a-z0-9][a-z0-9.-]*)*', env['CI_CACHE_PREFIX'])
            is not None and '/canary/' not in '/' + env['CI_CACHE_PREFIX'] + '/', 'invalid base prefix')
    expected = 'CoreforgeOmpCacheRead' if role == 'READ_ROLE' else 'CoreforgeOmpCacheWrite'
    require(env[role] == f'arn:aws-us-gov:iam::{ACCOUNT}:role/{expected}'
            and env['CI_CACHE_REGION'] == 'us-gov-west-1', 'unexpected AWS role or region')
    return env['CI_CACHE_PREFIX'] + ('/canary/' + env['CANARY_ID'] if env.get('CANARY_ID') else '')


def authorize_read(env, event, api, helper_sha):
    identity(env)
    require(re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,95}', env['CACHE_SLOT']) is not None, 'invalid slot')
    canary_id = env.get('CANARY_ID', '')
    if canary_id:
        canary(env, api, helper_sha)
        require(env.get('TRANSFER') in ('cold', 'warm'), 'invalid canary transfer')
        require(env['CACHE_SLOT'] == 'linux-x64-ubuntu-22.04', 'unexpected canary slot')
        enabled = True
        artifact = f'cache-restore-canary-{env["TRANSFER"]}-{env["CACHE_SLOT"]}'
    else:
        require(not env.get('TRANSFER'), 'transfer is canary-only')
        name = env['CALLER_WORKFLOW_REF'].removeprefix(REPOSITORY + '/').split('@', 1)[0]
        if env['GITHUB_EVENT_NAME'] == 'pull_request':
            base = event['pull_request']['base']
            require(base['repo']['full_name'] == REPOSITORY and base['repo']['id'] == REPOSITORY_ID
                    and base['repo']['owner']['id'] == OWNER_ID and base['ref'] == 'coreforge',
                    'unexpected PR base')
            require(name in ('.github/workflows/cf-verify.yml', '.github/workflows/relay.yml'),
                    'unexpected PR caller')
        elif env['GITHUB_EVENT_NAME'] == 'push':
            ref = env['GITHUB_REF']
            if name == '.github/workflows/cf-release.yml':
                require(ref == BRANCH or re.fullmatch(r'refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+', ref),
                        'unexpected release ref')
            else:
                require(name == '.github/workflows/relay.yml'
                        and re.fullmatch(r'refs/tags/relay/v[0-9A-Za-z.+-]+', ref), 'unexpected push caller/ref')
        else:
            raise Refused('Cache authorization refused: unexpected reader event')
        caller(env, name)
        enabled = env['REQUESTED'] == 'true' and env['ENABLED'] == 'true'
        artifact = 'cache-restore-' + env['CACHE_SLOT']
    return {'enabled': str(enabled).lower(), 'prefix': configuration(env, 'READ_ROLE') if enabled else '',
            'artifact': artifact}


def authorize_write(env, api, helper_sha):
    identity(env)
    workflow = env['EXPECTED_WORKFLOW']
    sha, ref = env['SOURCE_SHA'], env['GITHUB_REF']
    require(env['BUILD_RESULT'] == 'success', 'caller build failed')
    if env.get('CANARY_ID'):
        require(workflow == 'cf-cache-canary' and sha == env['GITHUB_SHA'], 'unexpected canary caller/source')
        run = canary(env, api, helper_sha)
        required, slots = {'cold-build'}, ('linux-x64-ubuntu-22.04',)
    else:
        require(workflow in ('cf-release', 'relay') and env['GITHUB_EVENT_NAME'] == 'push', 'unexpected writer event/caller')
        require(env['REQUESTED'] == 'true' and env['ENABLED'] == 'true', 'publication disabled')
        path = f'.github/workflows/{workflow}.yml'
        caller(env, path)
        valid_ref = ((ref == BRANCH or re.fullmatch(r'refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+', ref))
                     if workflow == 'cf-release' else re.fullmatch(r'refs/tags/relay/v[0-9A-Za-z.+-]+', ref))
        require(valid_ref, 'unexpected writer ref')
        current_source(env, api, helper_sha, sha)
        run = run_source(env, api, path, 'push', sha)
        if ref.startswith('refs/tags/'):
            obj = api('git/ref/tags/' + urllib.parse.quote(ref.removeprefix('refs/tags/'), safe=''))['object']
            seen = set()
            while obj['type'] == 'tag':
                require(obj['sha'] not in seen and len(seen) < 8, 'invalid tag chain')
                seen.add(obj['sha'])
                obj = api('git/tags/' + obj['sha'])['object']
            require(obj['type'] == 'commit' and obj['sha'] == sha, 'tag does not resolve to source')
        required = ({'prepare', 'release', 'verify_release', *(f'build ({target})' for target in TARGETS)}
                    if workflow == 'cf-release' else {'validate', 'publish'})
        slots = RELEASE_SLOTS if workflow == 'cf-release' else ('linux-x64-ubuntu-24.04',)
    prefix = configuration(env, 'WRITE_ROLE')
    run_id, attempt = env['GITHUB_RUN_ID'], env['GITHUB_RUN_ATTEMPT']
    jobs = pages(api, f'actions/runs/{run_id}/attempts/{attempt}/jobs', 'jobs')
    for name in required:
        matches = [job for job in jobs if job['name'] == name]
        require(len(matches) == 1 and matches[0]['status'] == 'completed'
                and matches[0]['conclusion'] == 'success' and matches[0]['completed_at'],
                'predecessor not completed successfully: ' + name)
    if workflow == 'cf-release':
        builds = [job['name'] for job in jobs if job['name'].startswith('build (')]
        require(set(builds) == {f'build ({target})' for target in TARGETS} and len(builds) == len(TARGETS),
                'unexpected build matrix')
    artifacts = [item for item in pages(api, f'actions/runs/{run_id}/artifacts', 'artifacts')
                 if item['name'].startswith('snapshot-')]
    expected = {'snapshot-' + slot for slot in slots}
    require(len(artifacts) == len(expected) and {item['name'] for item in artifacts} == expected,
            'incomplete or unexpected snapshot artifacts')
    for artifact in artifacts:
        source = artifact['workflow_run']
        require(not artifact['expired'] and source['id'] == int(run_id) and source['head_sha'] == sha
                and source['head_repository_id'] == REPOSITORY_ID
                and artifact['created_at'] >= run['run_started_at'], 'artifact source/attempt mismatch')
    return {'slots': slots, 'prefix': prefix}


def snapshots(root, slots, env):
    require(stat.S_ISDIR(root.lstat().st_mode), 'snapshot root is not a directory')
    entries = {entry.name for entry in root.iterdir()}
    # The pinned downloader flattens a single matching artifact.
    flat = len(slots) == 1 and entries == {'manifest.json', 'snapshot.tar.gz'}
    require(flat or entries == {'snapshot-' + slot for slot in slots},
            'unexpected snapshot directories')
    for slot in slots:
        snapshot = root if flat else root / ('snapshot-' + slot)
        require(stat.S_ISDIR(snapshot.lstat().st_mode)
                and {entry.name for entry in snapshot.iterdir()} == {'manifest.json', 'snapshot.tar.gz'},
                'unexpected snapshot layout')
        for name in ('manifest.json', 'snapshot.tar.gz'):
            require(stat.S_ISREG((snapshot / name).lstat().st_mode), 'snapshot is not a regular file')
        manifest = json.loads((snapshot / 'manifest.json').read_text())
        require(manifest.get('slot') == slot and manifest.get('source_sha') == env['SOURCE_SHA']
                and str(manifest.get('run_id')) == env['GITHUB_RUN_ID']
                and str(manifest.get('run_attempt')) == env['GITHUB_RUN_ATTEMPT'], 'manifest provenance mismatch')
        if flat:
            destination = root / ('snapshot-' + slot)
            destination.mkdir()
            for name in ('manifest.json', 'snapshot.tar.gz'):
                (root / name).rename(destination / name)


def oidc_claims(token, env, broker):
    payload = token.split('.')[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    expected_sub = f'repo:{REPOSITORY}:' + ('pull_request' if env['GITHUB_EVENT_NAME'] == 'pull_request'
                                          else 'ref:' + env['GITHUB_REF'])
    require(claims['iss'] == 'https://token.actions.githubusercontent.com'
            and claims['aud'] == 'sts.amazonaws.com' and claims['sub'] == expected_sub
            and str(claims['repository_id']) == str(REPOSITORY_ID)
            and str(claims['repository_owner_id']) == str(OWNER_ID)
            and claims['ref'] == env['GITHUB_REF']
            and re.fullmatch(re.escape(f'{REPOSITORY}/.github/workflows/cf-cache-{broker}.yml@')
                             + r'[0-9a-f]{40}', claims['job_workflow_ref']) is not None,
            'unexpected OIDC claims')
    return {name: claims[name] for name in CLAIMS}


def caller_identity(data, broker):
    role = 'CoreforgeOmpCacheRead' if broker == 'read' else 'CoreforgeOmpCacheWrite'
    require(data['Account'] == ACCOUNT and data['Arn'].startswith(
        f'arn:aws-us-gov:sts::{ACCOUNT}:assumed-role/{role}/'), 'unexpected STS caller identity')
    return {name: data[name] for name in ('Account', 'Arn', 'UserId')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('authorize-read', 'authorize-write', 'snapshots', 'recheck', 'oidc', 'identity'))
    parser.add_argument('--broker', choices=('read', 'write'))
    args = parser.parse_args()
    env = os.environ
    temp = Path(env['RUNNER_TEMP'])
    api = GitHubAPI(env.get('GH_TOKEN', ''))
    if args.command.startswith('authorize-'):
        helper_sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        if args.command == 'authorize-read':
            result = authorize_read(env, json.loads(Path(env['GITHUB_EVENT_PATH']).read_text()), api, helper_sha)
        else:
            result = authorize_write(env, api, helper_sha)
            (temp / 'cache-expected-slots.json').write_text(json.dumps(result.pop('slots')))
        with open(env['GITHUB_OUTPUT'], 'a') as output:
            for name, value in result.items():
                output.write(f'{name}={value}\n')
    elif args.command == 'snapshots':
        snapshots(temp / 'cache-publish', json.loads((temp / 'cache-expected-slots.json').read_text()), env)
    elif args.command == 'recheck':
        current_source(env, api, subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), env['SOURCE_SHA'])
    else:
        require(args.broker is not None, 'receipt requires broker identity')
        if args.command == 'oidc':
            url = env['ACTIONS_ID_TOKEN_REQUEST_URL']
            request = urllib.request.Request(url + ('&' if '?' in url else '?') + 'audience=sts.amazonaws.com',
                                             headers={'Authorization': 'Bearer ' + env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
            with urllib.request.urlopen(request, timeout=30) as response:
                receipt = oidc_claims(json.load(response)['value'], env, args.broker)
        else:
            receipt = caller_identity(json.loads(subprocess.check_output(
                ['aws', 'sts', 'get-caller-identity', '--region', env['CI_CACHE_REGION'], '--output', 'json'], text=True)), args.broker)
        destination = temp / 'cache-receipts'
        destination.mkdir(exist_ok=True)
        name = 'sts' if args.command == 'identity' else 'oidc'
        (destination / (name + '.json')).write_text(json.dumps(receipt, sort_keys=True) + '\n')
        with open(env['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write('Cache broker ' + args.command + ' receipt: `' + json.dumps(receipt, sort_keys=True) + '`\n')


if __name__ == '__main__':
    try:
        main()
    except (Refused, KeyError, ValueError, OSError) as error:
        raise SystemExit(str(error)) from None
