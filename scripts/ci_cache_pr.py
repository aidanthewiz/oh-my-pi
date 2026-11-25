#!/usr/bin/env python3
"""Carry inert PR build caches into an exact-tree protected release."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile

import ci_cache as cache
import ci_cache_guard as guard
import ci_cache_release as release_policy
import ci_release_admission as admission

VERIFY_WORKFLOW = '.github/workflows/cf-verify.yml'
PRODUCER_WORKFLOW = '.github/workflows/cf-verify-target.yml'
RELEASE_WORKFLOW = '.github/workflows/cf-release.yml'
PRODUCER_JOBS = {
    'darwin-arm64-xcode-27': 'macOS ARM64 / Build native addon and CLI',
    'darwin-x64-macos-15-intel': 'macOS x64 / Build native addon and CLI',
    'linux-x64-ubuntu-22.04': 'Linux x64 / Build native addon and CLI',
    'linux-arm64-ubuntu-24.04-arm': 'Linux ARM64 / Build native addon and CLI',
    'linux-musl-x64-ubuntu-22.04': 'Linux musl x64 / Build native addon and CLI',
    'linux-musl-arm64-ubuntu-24.04-arm': 'Linux musl ARM64 / Build native addon and CLI',
    'win32-x64-ubuntu-24.04': 'Windows x64 / Build native addon and CLI',
}
PRODUCER_FIELDS = {'schema', 'repository_id', 'owner_id', 'pull_request', 'source_tree',
                   'workflow', 'workflow_sha', 'event_sha'}


def require(condition, message):
    cache.require(condition, 'PR cache: ' + message)


def same_repository(repository):
    return (isinstance(repository, dict)
            and repository.get('full_name') == guard.REPOSITORY
            and repository.get('id') == guard.REPOSITORY_ID
            and isinstance(repository.get('owner'), dict)
            and repository['owner'].get('id') == guard.OWNER_ID)


def local_source(source):
    require(isinstance(source, str) and admission.COMMIT.fullmatch(source), 'invalid source SHA')
    head = release_policy.command(['git', '--no-replace-objects', 'rev-parse', 'HEAD']).decode().strip()
    require(head == source, 'checkout does not match source')
    return release_policy.command(['git', '--no-replace-objects', 'rev-parse', 'HEAD^{tree}']).decode().strip()


def pack(identity_path, disk, repo, output, source, env):
    guard.identity(env)
    require(env.get('GITHUB_ACTIONS') == 'true', 'producer requires GitHub Actions')
    require(env.get('GITHUB_EVENT_NAME') == 'pull_request', 'snapshot requires a pull request')
    event = cache.read_json(env['GITHUB_EVENT_PATH'])
    pull = event['pull_request']
    number = event['number']
    require(type(number) is int and number > 0, 'invalid pull request number')
    require(same_repository(pull['base']['repo']) and same_repository(pull['head']['repo']),
            'foreign pull request repository')
    require(pull['base']['ref'] == 'coreforge' and pull['head']['sha'] == source,
            'unexpected pull request source or base')
    ref = f'refs/pull/{number}/merge'
    require(env.get('GITHUB_REF') == ref
            and env.get('GITHUB_WORKFLOW_REF') == f'{guard.REPOSITORY}/{VERIFY_WORKFLOW}@{ref}',
            'unexpected producer workflow')
    require(admission.COMMIT.fullmatch(env.get('GITHUB_SHA', ''))
            and admission.COMMIT.fullmatch(env.get('GITHUB_WORKFLOW_SHA', '')),
            'missing immutable event or workflow source')
    identity = cache.validate_identity(cache.read_json(identity_path))
    require(identity['slot'] in PRODUCER_JOBS, 'unsupported cache slot')
    tree = local_source(source)
    manifest = cache.pack(identity_path, disk, repo, output, source_sha=source)
    cache.atomic_json(Path(output) / 'producer.json', {
        'schema': 1,
        'repository_id': guard.REPOSITORY_ID,
        'owner_id': guard.OWNER_ID,
        'pull_request': number,
        'source_tree': tree,
        'workflow': VERIFY_WORKFLOW,
        'workflow_sha': env['GITHUB_WORKFLOW_SHA'],
        'event_sha': env['GITHUB_SHA'],
    })
    return manifest


def valid_run(run, head, number):
    return (isinstance(run, dict) and type(run.get('id')) is int and run['id'] > 0
            and type(run.get('run_attempt')) is int and run['run_attempt'] > 0
            and type(run.get('workflow_id')) is int and run['workflow_id'] > 0
            and run.get('event') == 'pull_request'
            and run.get('status') == 'completed' and run.get('conclusion') == 'success'
            and run.get('head_sha') == head
            and same_repository(run.get('repository')) and same_repository(run.get('head_repository'))
            and run.get('path', '').split('@', 1)[0] == VERIFY_WORKFLOW
            and any(pull.get('number') == number and pull.get('head', {}).get('sha') == head
                    and pull.get('base', {}).get('ref') == 'coreforge'
                    for pull in run.get('pull_requests', []) if isinstance(pull, dict)))


def artifact_pair(run, slot):
    names = [f'pr-cache-metadata-{slot}', f'pr-cache-snapshot-{slot}']
    artifacts = admission.paged_items(
        f'repos/{guard.REPOSITORY}/actions/runs/{run["id"]}/artifacts?per_page=100', 'artifacts')
    pair = []
    for name in names:
        matches = [artifact for artifact in artifacts if artifact.get('name') == name]
        if not matches:
            return None
        require(len(matches) == 1, 'ambiguous snapshot artifact')
        artifact = matches[0]
        origin = artifact.get('workflow_run', {})
        require(type(artifact.get('id')) is int and artifact['id'] > 0
                and type(artifact.get('size_in_bytes')) is int and artifact['size_in_bytes'] > 0
                and not artifact.get('expired', True)
                and re.fullmatch(r'sha256:[0-9a-f]{64}', artifact.get('digest', ''))
                and origin.get('id') == run['id'] and origin.get('head_sha') == run['head_sha']
                and origin.get('repository_id') == guard.REPOSITORY_ID
                and origin.get('head_repository_id') == guard.REPOSITORY_ID,
                'invalid snapshot artifact provenance')
        pair.append(artifact)
    return pair


def resolve(source, slot, env):
    guard.identity(env)
    require(env.get('GITHUB_ACTIONS') == 'true' and bool(env.get('GH_TOKEN')),
            'missing Actions context or job token')
    ref = env.get('GITHUB_REF', '')
    require(env.get('GITHUB_EVENT_NAME') == 'push'
            and (ref == guard.BRANCH or re.fullmatch(r'refs/tags/v[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+', ref))
            and env.get('GITHUB_WORKFLOW_REF') == f'{guard.REPOSITORY}/{RELEASE_WORKFLOW}@{ref}'
            and env.get('GITHUB_SHA') == source, 'unexpected release context')
    tree = local_source(source)
    qualified = admission.qualify_release(source, guard.REPOSITORY)
    if qualified is None:
        return None
    number, head = qualified
    pull = admission.github_api(f'repos/{guard.REPOSITORY}/pulls/{number}')
    require(same_repository(pull['base']['repo']) and same_repository(pull['head']['repo'])
            and pull['head']['sha'] == head and pull['base']['ref'] == 'coreforge'
            and pull.get('merged_at') and pull.get('merge_commit_sha') == source,
            'merged pull request changed')
    require(slot in PRODUCER_JOBS, 'unsupported cache slot')
    runs = admission.paged_items(
        f'repos/{guard.REPOSITORY}/actions/workflows/cf-verify.yml/runs'
        f'?event=pull_request&head_sha={head}&status=success&per_page=100', 'workflow_runs')
    for listed in sorted((run for run in runs if valid_run(run, head, number)),
                         key=lambda run: run['id'], reverse=True):
        run = admission.github_api(
            f'repos/{guard.REPOSITORY}/actions/runs/{listed["id"]}/attempts/{listed["run_attempt"]}')
        require(valid_run(run, head, number) and run['id'] == listed['id']
                and run['run_attempt'] == listed['run_attempt'], 'verification attempt changed')
        workflow = admission.github_api(f'repos/{guard.REPOSITORY}/actions/workflows/{run["workflow_id"]}')
        require(workflow.get('id') == run['workflow_id'] and workflow.get('path') == VERIFY_WORKFLOW,
                'unexpected verification workflow identity')
        pair = artifact_pair(run, slot)
        if pair is not None:
            return {'run': run, 'pull_request': number, 'head': head, 'tree': tree,
                    'metadata': pair[0], 'snapshot': pair[1]}
    return None


def download(artifact, output):
    with open(output, 'xb') as destination:
        subprocess.run(
            ['gh', 'api', f'repos/{guard.REPOSITORY}/actions/artifacts/{artifact["id"]}/zip'],
            stdout=destination, stderr=subprocess.DEVNULL, check=True, timeout=300,
        )
    require(Path(output).stat().st_size == artifact['size_in_bytes'], 'artifact size mismatch')
    require('sha256:' + cache.digest_file(output) == artifact['digest'], 'artifact digest mismatch')


def members(archive, expected, limits):
    entries = archive.infolist()
    require(len(entries) == len(expected) and {entry.filename for entry in entries} == expected,
            'unexpected artifact layout')
    for entry in entries:
        mode = entry.external_attr >> 16
        require(not entry.is_dir() and not stat.S_ISLNK(mode)
                and (stat.S_IFMT(mode) in (0, stat.S_IFREG))
                and entry.file_size <= limits[entry.filename], 'unsafe artifact member')


def validate_producer(metadata, producer, candidate, slot):
    cache.validate_manifest(metadata)
    require(isinstance(producer, dict) and set(producer) == PRODUCER_FIELDS
            and type(producer['schema']) is int and producer['schema'] == 1
            and producer['repository_id'] == guard.REPOSITORY_ID
            and producer['owner_id'] == guard.OWNER_ID
            and type(producer['pull_request']) is int
            and producer['pull_request'] == candidate['pull_request']
            and producer['source_tree'] == candidate['tree']
            and producer['workflow'] == VERIFY_WORKFLOW, 'snapshot producer mismatch')
    run = candidate['run']
    references = [ref for ref in run.get('referenced_workflows', [])
                  if isinstance(ref, dict)
                  and ref.get('path', '').split('@', 1)[0] == f'{guard.REPOSITORY}/{PRODUCER_WORKFLOW}']
    require(len(references) == 1 and references[0].get('sha') == producer['workflow_sha']
            and references[0].get('ref') == f'refs/pull/{candidate["pull_request"]}/merge',
            'producer workflow version mismatch')
    for source in {producer['workflow_sha'], producer['event_sha']}:
        require(isinstance(source, str) and admission.COMMIT.fullmatch(source),
                'invalid producer workflow source')
        tree = admission.commit_tree(
            admission.github_api(f'repos/{guard.REPOSITORY}/git/commits/{source}'), source)
        require(tree == candidate['tree'], 'producer workflow tree differs from release')
    attempt = int(metadata['run_attempt'])
    require(metadata['source_sha'] == candidate['head'] and metadata['slot'] == slot
            and int(metadata['run_id']) == run['id'] and 0 < attempt <= run['run_attempt'],
            'snapshot source or attempt mismatch')
    jobs = admission.paged_items(
        f'repos/{guard.REPOSITORY}/actions/runs/{run["id"]}/attempts/{attempt}/jobs?per_page=100', 'jobs')
    matches = [job for job in jobs if job.get('name') == PRODUCER_JOBS[slot]]
    require(len(matches) == 1, 'ambiguous producer job')
    job = matches[0]
    require(type(job.get('id')) is int and job['id'] > 0
            and job.get('run_id') == run['id'] and job.get('run_attempt') == attempt
            and job.get('status') == 'completed' and job.get('conclusion') == 'success'
            and job.get('head_sha') == candidate['head'], 'producer job did not succeed')
    started = cache.parse_time(job['started_at'])
    completed = cache.parse_time(job['completed_at'])
    require(started <= cache.parse_time(metadata['created_at']) <= completed,
            'snapshot was not created by producer interval')
    for artifact in (candidate['metadata'], candidate['snapshot']):
        require(started <= cache.parse_time(artifact['created_at']) <= completed,
                'artifact was not created by producer interval')


def restore(identity_path, disk, repo, source, env):
    identity = cache.validate_identity(cache.read_json(identity_path))
    candidate = resolve(source, identity['slot'], env)
    if candidate is None:
        return False
    with tempfile.TemporaryDirectory(prefix='coreforge-pr-cache-', dir=env.get('RUNNER_TEMP')) as work:
        work = Path(work)
        metadata_zip = work / 'metadata.zip'
        require(candidate['metadata']['size_in_bytes'] <= 2 * cache.JSON_LIMIT,
                'metadata artifact too large')
        download(candidate['metadata'], metadata_zip)
        with zipfile.ZipFile(metadata_zip) as archive:
            members(archive, {'manifest.json', 'producer.json'},
                    {'manifest.json': cache.JSON_LIMIT, 'producer.json': cache.JSON_LIMIT})
            metadata = json.loads(archive.read('manifest.json'), object_pairs_hook=cache.strict_pairs)
            producer = json.loads(archive.read('producer.json'), object_pairs_hook=cache.strict_pairs)
        validate_producer(metadata, producer, candidate, identity['slot'])
        if metadata['identity'] != identity:
            print('PR cache miss: incompatible identity; retaining protected-cache fallback')
            return False
        payload_zip = work / 'snapshot.zip'
        download(candidate['snapshot'], payload_zip)
        snapshot = work / 'snapshot'
        snapshot.mkdir()
        cache.atomic_json(snapshot / 'manifest.json', metadata)
        with zipfile.ZipFile(payload_zip) as archive:
            members(archive, {'snapshot.tar.gz'}, {'snapshot.tar.gz': metadata['size']})
            with archive.open('snapshot.tar.gz') as incoming, open(snapshot / 'snapshot.tar.gz', 'xb') as output:
                shutil.copyfileobj(incoming, output, cache.CHUNK)
        payload_zip.unlink()
        restored = cache.restore(identity_path, snapshot, disk, repo)
    if restored:
        print(f'PR cache hit: verified PR #{candidate["pull_request"]}, run {candidate["run"]["id"]}, '
              f'producer attempt {metadata["run_attempt"]}')
    return restored


def report(hit, reason):
    cache.output_value('hit', str(hit).lower())
    cache.output_value('source', 'merged-pr' if hit else 'fallback')
    if summary := os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(summary, 'a', encoding='utf-8') as output:
            output.write(f'Merged-PR Bazel cache: **{"hit" if hit else "miss"}** ({reason}).\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('pack', 'restore'))
    parser.add_argument('--identity', required=True)
    parser.add_argument('--disk', required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.command == 'pack':
        require(args.output, 'snapshot output is required')
        pack(args.identity, args.disk, args.repo, args.output, args.source, os.environ)
        return 0
    cache.output_value('hit', 'false')
    try:
        hit = restore(args.identity, args.disk, args.repo, args.source, os.environ)
    except (cache.CacheError, guard.Refused, OSError, ValueError, KeyError, TypeError,
            zipfile.BadZipFile, subprocess.SubprocessError) as error:
        message = str(error)
        reason = (message.removeprefix('PR cache: ')
                  if isinstance(error, cache.CacheError) and message.startswith('PR cache: ')
                  else f'candidate unavailable or rejected ({type(error).__name__})')
        print(f'PR cache miss: {reason}; retaining protected-cache fallback')
        report(False, reason)
        return 0
    report(hit, 'verified exact tree and build inputs' if hit else 'no compatible completed PR snapshot')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
