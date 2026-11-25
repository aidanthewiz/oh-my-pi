import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from test_ci_cache_release import GitFixture

SPEC = importlib.util.spec_from_file_location('ci_cache_pr', Path(__file__).with_name('ci_cache_pr.py'))
pr = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pr)
cache = pr.cache
STAMP = '2030-01-02T00:01:00Z'
PREFIX = 'repos/' + pr.guard.REPOSITORY
SLOT = 'linux-x64-ubuntu-22.04'


class PRCacheTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ci-pr-cache-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.host_path = os.environ.get('PATH', '')
        self.bazel = shutil.which('bazelisk') or shutil.which('bazel')
        (self.root / 'git').mkdir()
        self.git = GitFixture(self.root / 'git')
        source_files = {
            'crates/runtime.rs': b'fn new_input() {}\n',
            '.bazelversion': b'9.2.0\n',
            'MODULE.bazel': b'module(name = "pr_cache_proof")\n',
            'BUILD.bazel': b'genrule(name = "result", srcs = ["value.txt"], outs = ["result.txt"], cmd = "cat $(location value.txt) > $@")\n',
            'value.txt': b'first input\n',
        }
        self.head = self.git.changed(source_files)
        self.tree = self.git.git('rev-parse', self.head + '^{tree}')
        self.merge = self.git.commit({**self.git.files, **source_files}, [self.git.base, self.head])
        for name, contents in source_files.items():
            self.write(self.git.repo / name, contents)
        self.git.git('update-ref', 'refs/heads/fixture', self.head)
        self.repository = {'full_name': pr.guard.REPOSITORY, 'id': pr.guard.REPOSITORY_ID,
                           'owner': {'id': pr.guard.OWNER_ID}}
        self.pull = {'number': 17, 'merged_at': '2030-01-02T00:10:00Z', 'merge_commit_sha': self.merge,
                     'base': {'ref': 'coreforge', 'repo': copy.deepcopy(self.repository)},
                     'head': {'sha': self.head, 'ref': 'feature', 'repo': copy.deepcopy(self.repository)}}
        self.event = self.root / 'event.json'
        self.event.write_text(json.dumps({'number': 17, 'pull_request': self.pull}))
        self.env = {**self.git.env, 'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': pr.guard.REPOSITORY,
                    'GITHUB_REPOSITORY_ID': str(pr.guard.REPOSITORY_ID),
                    'GITHUB_REPOSITORY_OWNER_ID': str(pr.guard.OWNER_ID),
                    'GITHUB_EVENT_NAME': 'pull_request', 'GITHUB_EVENT_PATH': str(self.event),
                    'GITHUB_REF': 'refs/pull/17/merge', 'GITHUB_SHA': self.merge,
                    'GITHUB_WORKFLOW_SHA': self.merge,
                    'GITHUB_WORKFLOW_REF': pr.guard.REPOSITORY + '/' + pr.VERIFY_WORKFLOW + '@refs/pull/17/merge',
                    'GITHUB_RUN_ID': '100', 'GITHUB_RUN_ATTEMPT': '1', 'RUNNER_TEMP': str(self.root)}
        environment_patch = patch.dict(os.environ, self.env, clear=True)
        environment_patch.start()
        self.addCleanup(environment_patch.stop)
        self.real_run = subprocess.run
        command_patch = patch.object(pr.release_policy, 'command', side_effect=self.git_command)
        command_patch.start()
        self.addCleanup(command_patch.stop)
        self.identity = {'schema': 1, 'format': cache.FORMAT, 'slot': SLOT, 'bazel': '9.2.0',
                         'host': {'os': 'Linux', 'arch': 'x86_64', 'version': 'image-1'},
                         'tools': {'cc': 'compiler-1'}, 'configuration': {'.bazelrc': 'a' * 64},
                         'module_toolchains': ['rust-pinned'], 'native_environment': {}}
        self.identity_path = self.root / 'identity.json'
        cache.atomic_json(self.identity_path, self.identity)
        self.disk = self.root / 'disk'
        self.repo = self.root / 'repository-cache'
        self.payload = b'compiled output from the selected PR'
        digest = hashlib.sha256(self.payload).hexdigest()
        self.cas_name = 'cas/' + digest[:2] + '/' + digest
        self.write(self.disk / self.cas_name, self.payload)
        self.download_name = 'content_addressable/sha256/' + 'b' * 64 + '/file'
        self.write(self.repo / self.download_name, b'verified repository download')
        self.snapshot = self.root / 'snapshot'
        with patch.object(cache, 'timestamp', return_value=STAMP):
            pr.pack(self.identity_path, self.disk, self.repo, self.snapshot, self.head, self.env)
        self.run = {'id': 100, 'run_attempt': 2, 'event': 'pull_request', 'status': 'completed',
                    'conclusion': 'success', 'head_sha': self.head, 'head_branch': 'feature',
                    'path': pr.VERIFY_WORKFLOW, 'workflow_id': 10,
                    'pull_requests': [{'number': 17, 'head': {'sha': self.head}, 'base': {'ref': 'coreforge'}}],
                    'referenced_workflows': [{'path': pr.guard.REPOSITORY + '/' + pr.PRODUCER_WORKFLOW + '@' + self.merge,
                                             'sha': self.merge, 'ref': 'refs/pull/17/merge'}],
                    'repository': copy.deepcopy(self.repository), 'head_repository': copy.deepcopy(self.repository)}
        self.job = {'id': 1001, 'run_id': 100, 'run_attempt': 1,
                    'name': pr.PRODUCER_JOBS[SLOT], 'status': 'completed', 'conclusion': 'success',
                    'head_sha': self.head, 'started_at': '2030-01-02T00:00:00Z',
                    'completed_at': '2030-01-02T00:05:00Z'}
        self.artifacts = []
        self.blobs = {}
        self.rebuild_artifacts()
        self.release_env = {**self.env, 'GITHUB_EVENT_NAME': 'push', 'GITHUB_REF': pr.guard.BRANCH,
                            'GITHUB_SHA': self.merge,
                            'GITHUB_WORKFLOW_REF': pr.guard.REPOSITORY + '/' + pr.RELEASE_WORKFLOW + '@' + pr.guard.BRANCH,
                            'GITHUB_RUN_ID': '200', 'GITHUB_RUN_ATTEMPT': '1',
                            'GH_TOKEN': 'synthetic-job-token'}
        self.git.git('update-ref', 'refs/heads/fixture', self.merge)
        self.calls = []
        self.downloads = []
        self.responses = {
            f'{PREFIX}/commits/{self.merge}/pulls?per_page=100': [[self.pull]],
            f'{PREFIX}/git/commits/{self.merge}': {'sha': self.merge, 'tree': {'sha': self.tree}},
            f'{PREFIX}/git/commits/{self.head}': {'sha': self.head, 'tree': {'sha': self.tree}},
            f'{PREFIX}/pulls/17': self.pull,
            f'{PREFIX}/actions/workflows/cf-verify.yml/runs?event=pull_request&head_sha={self.head}&status=success&per_page=100': [{'workflow_runs': [self.run]}],
            f'{PREFIX}/actions/workflows/10': {'id': 10, 'path': pr.VERIFY_WORKFLOW},
            f'{PREFIX}/actions/runs/100/attempts/2': self.run,
            f'{PREFIX}/actions/runs/100/artifacts?per_page=100': [{'artifacts': self.artifacts}],
            f'{PREFIX}/actions/runs/100/attempts/1/jobs?per_page=100': [{'jobs': [self.job]}],
        }
        api_patch = patch.object(pr.admission, 'github_api', side_effect=self.api)
        api_patch.start()
        self.addCleanup(api_patch.stop)
        transport_patch = patch.object(pr.subprocess, 'run', side_effect=self.transport)
        transport_patch.start()
        self.addCleanup(transport_patch.stop)
        self.restored_disk = self.root / 'restored-disk'
        self.restored_repo = self.root / 'restored-repo'
        self.write(self.restored_disk / 'sentinel', b'keep disk')
        self.write(self.restored_repo / 'sentinel', b'keep repo')

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)

    def git_command(self, args, data=None):
        result = self.real_run(args, input=data, cwd=self.git.repo, env=self.git.env,
                               check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return result.stdout

    def api(self, endpoint, *, paginate=False):
        self.calls.append(endpoint)
        return self.responses[endpoint]

    def transport(self, args, **kwargs):
        if args[:2] == ['gh', 'api']:
            ident = int(args[2].split('/')[-2])
            self.downloads.append(ident)
            kwargs['stdout'].write(self.blobs[ident])
            return subprocess.CompletedProcess(args, 0)
        return self.real_run(args, **kwargs)

    def zip_bytes(self, names, *, extra=None):
        target = io.BytesIO()
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name in names:
                archive.writestr(name, (self.snapshot / name).read_bytes())
            if extra is not None:
                archive.writestr(*extra)
        return target.getvalue()

    def rebuild_artifacts(self, *, metadata_extra=None, payload_extra=None):
        self.blobs = {101: self.zip_bytes(['manifest.json', 'producer.json'], extra=metadata_extra),
                      102: self.zip_bytes(['snapshot.tar.gz'], extra=payload_extra)}
        self.artifacts[:] = [
            {'id': ident, 'name': prefix + SLOT, 'size_in_bytes': len(self.blobs[ident]),
             'digest': 'sha256:' + hashlib.sha256(self.blobs[ident]).hexdigest(), 'expired': False,
             'created_at': '2030-01-02T00:02:00Z',
             'workflow_run': {'id': 100, 'head_sha': self.head, 'repository_id': pr.guard.REPOSITORY_ID,
                              'head_repository_id': pr.guard.REPOSITORY_ID}}
            for ident, prefix in [(101, 'pr-cache-metadata-'), (102, 'pr-cache-snapshot-')]
        ]

    def restore(self):
        return pr.restore(self.identity_path, self.restored_disk, self.restored_repo,
                          self.merge, self.release_env)

    def assert_unchanged(self):
        self.assertEqual((self.restored_disk / 'sentinel').read_bytes(), b'keep disk')
        self.assertEqual((self.restored_repo / 'sentinel').read_bytes(), b'keep repo')
        self.assertFalse((self.restored_disk / self.cas_name).exists())

    def test_release_restores_successful_pr_cache_from_prior_producer_attempt(self):
        self.assertTrue(self.restore())
        self.assertEqual((self.restored_disk / self.cas_name).read_bytes(), self.payload)
        self.assertEqual((self.restored_repo / self.download_name).read_bytes(), b'verified repository download')
        self.assertFalse((self.restored_disk / 'sentinel').exists())
        self.assertEqual(cache.read_json(self.snapshot / 'manifest.json')['source_sha'], self.head)
        self.assertEqual(self.env['GITHUB_SHA'], self.merge)
        self.assertIn(f'{PREFIX}/actions/runs/100/attempts/1/jobs?per_page=100', self.calls)

    @unittest.skipUnless(sys.platform in ('linux', 'darwin'), 'Bazel cache builders run on Linux and macOS')
    def test_real_bazel_pr_cache_hit_and_changed_input_rebuild(self):
        self.assertIsNotNone(self.bazel, 'Bazel is required for the real cache handoff proof')
        env = {**self.git.env, 'PATH': self.host_path,
               'BAZELISK_HOME': str(self.root / 'bazelisk'), 'USE_BAZEL_VERSION': '9.2.0'}

        def build(label, disk, repository, offline=False):
            args = [self.bazel, '--batch', '--ignore_all_rc_files',
                    '--output_user_root=' + str(self.root / (label + '-output')), 'build',
                    '--color=no', '--curses=no', '--disk_cache=' + str(disk),
                    '--repository_cache=' + str(repository)]
            if offline:
                args.append('--repository_disable_download')
            args.append('//:result')
            result = self.real_run(args, cwd=self.git.repo, env=env, capture_output=True,
                                   text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return result.stdout + result.stderr

        cold = build('cold', self.disk, self.repo)
        self.assertEqual((self.git.repo / 'bazel-bin/result.txt').read_bytes(), b'first input\n')
        self.git.git('update-ref', 'refs/heads/fixture', self.head)
        self.snapshot = self.root / 'real-snapshot'
        with patch.object(cache, 'timestamp', return_value=STAMP):
            pr.pack(self.identity_path, self.disk, self.repo, self.snapshot, self.head, self.env)
        self.git.git('update-ref', 'refs/heads/fixture', self.merge)
        self.rebuild_artifacts()
        self.assertTrue(self.restore())
        warm = build('warm', self.restored_disk, self.restored_repo, offline=True)
        hits = sum(int(value) for value in re.findall(r'\b([0-9]+) disk cache hits?\b', warm))
        self.assertGreater(hits, 0, warm)
        self.assertEqual((self.git.repo / 'bazel-bin/result.txt').read_bytes(), b'first input\n')
        (self.git.repo / 'value.txt').write_bytes(b'changed input\n')
        build('changed', self.restored_disk, self.restored_repo, offline=True)
        self.assertEqual((self.git.repo / 'bazel-bin/result.txt').read_bytes(), b'changed input\n')
        print(json.dumps({'realBazelPRCache': 'passed', 'warmDiskHits': hits,
                          'coldDiskHits': sum(int(value) for value in re.findall(r'\b([0-9]+) disk cache hits?\b', cold)),
                          'changedInputRebuilt': True}))

    def test_incompatible_identity_avoids_payload_download_and_keeps_existing_cache(self):
        changed = {**self.identity, 'tools': {'cc': 'compiler-2'}}
        cache.atomic_json(self.identity_path, changed)
        self.assertFalse(self.restore())
        self.assertEqual(self.downloads, [101])
        self.assert_unchanged()

    def test_missing_snapshot_leaves_protected_fallback_available(self):
        self.artifacts.pop()
        self.assertFalse(self.restore())
        self.assertEqual(self.downloads, [])
        self.assert_unchanged()

    def test_changed_merge_tree_never_uses_pr_outputs(self):
        self.responses[f'{PREFIX}/git/commits/{self.merge}']['tree']['sha'] = 'a' * 40
        with self.assertRaisesRegex(ValueError, 'differs'):
            self.restore()
        self.assertEqual(self.downloads, [])
        self.assert_unchanged()

    def test_failed_verification_run_never_uses_its_snapshot(self):
        self.run['conclusion'] = 'failure'
        self.assertFalse(self.restore())
        self.assertEqual(self.downloads, [])
        self.assert_unchanged()

    def test_foreign_run_repository_never_uses_its_snapshot(self):
        self.run['head_repository']['id'] = 999
        self.assertFalse(self.restore())
        self.assertEqual(self.downloads, [])
        self.assert_unchanged()

    def test_unmerged_pull_request_never_uses_its_snapshot(self):
        self.pull['merged_at'] = None
        self.assertFalse(self.restore())
        self.assertEqual(self.downloads, [])
        self.assert_unchanged()

    def test_wrong_workflow_identity_rejects_before_download(self):
        self.responses[f'{PREFIX}/actions/workflows/10']['path'] = '.github/workflows/untrusted.yml'
        with self.assertRaisesRegex(cache.CacheError, 'workflow identity'):
            self.restore()
        self.assertEqual(self.downloads, [])
        self.assert_unchanged()

    def test_expired_and_duplicate_artifacts_are_not_accepted(self):
        for kind in ['expired', 'duplicate']:
            with self.subTest(kind=kind):
                self.rebuild_artifacts()
                if kind == 'expired':
                    self.artifacts[0]['expired'] = True
                else:
                    self.artifacts.append(copy.deepcopy(self.artifacts[0]))
                with self.assertRaises(cache.CacheError):
                    self.restore()
                self.assert_unchanged()

    def test_unsuccessful_producer_job_does_not_promote_cache(self):
        self.job['conclusion'] = 'failure'
        with self.assertRaisesRegex(cache.CacheError, 'producer job'):
            self.restore()
        self.assertEqual(self.downloads, [101])
        self.assert_unchanged()

    def test_future_attempt_is_rejected_without_fetching_payload(self):
        manifest = cache.read_json(self.snapshot / 'manifest.json')
        manifest['run_attempt'] = '3'
        cache.atomic_json(self.snapshot / 'manifest.json', manifest)
        self.rebuild_artifacts()
        with self.assertRaisesRegex(cache.CacheError, 'attempt'):
            self.restore()
        self.assertEqual(self.downloads, [101])
        self.assert_unchanged()

    def test_artifact_outside_producer_interval_is_rejected(self):
        self.artifacts[1]['created_at'] = '2030-01-02T00:06:00Z'
        with self.assertRaisesRegex(cache.CacheError, 'producer interval'):
            self.restore()
        self.assertEqual(self.downloads, [101])
        self.assert_unchanged()

    def test_corrupted_metadata_and_payload_never_replace_cache(self):
        for ident in (101, 102):
            with self.subTest(artifact=ident):
                self.rebuild_artifacts()
                self.blobs[ident] = bytes([self.blobs[ident][0] ^ 1]) + self.blobs[ident][1:]
                with self.assertRaisesRegex(cache.CacheError, 'digest'):
                    self.restore()
                self.assert_unchanged()

    def test_extra_metadata_member_is_rejected_before_payload(self):
        self.rebuild_artifacts(metadata_extra=('../outside', b'untrusted'))
        with self.assertRaisesRegex(cache.CacheError, 'layout'):
            self.restore()
        self.assertEqual(self.downloads, [101])
        self.assert_unchanged()

    def test_symlink_payload_member_is_rejected(self):
        entry = zipfile.ZipInfo('snapshot.tar.gz')
        entry.external_attr = 0o120777 << 16
        content = io.BytesIO()
        with zipfile.ZipFile(content, 'w') as archive:
            archive.writestr(entry, b'outside')
        self.blobs[102] = content.getvalue()
        self.artifacts[1].update(size_in_bytes=len(self.blobs[102]),
                                 digest='sha256:' + hashlib.sha256(self.blobs[102]).hexdigest())
        with self.assertRaises(cache.CacheError):
            self.restore()
        self.assert_unchanged()

    def test_unsafe_inner_archive_is_rejected_without_partial_restore(self):
        with tarfile.open(self.snapshot / 'snapshot.tar.gz', 'w:gz') as archive:
            info = tarfile.TarInfo('../outside')
            info.size = 1
            archive.addfile(info, io.BytesIO(b'x'))
        manifest = cache.read_json(self.snapshot / 'manifest.json')
        manifest.update(sha256=cache.digest_file(self.snapshot / 'snapshot.tar.gz'),
                        size=(self.snapshot / 'snapshot.tar.gz').stat().st_size)
        cache.atomic_json(self.snapshot / 'manifest.json', manifest)
        self.rebuild_artifacts()
        with self.assertRaises(cache.CacheError):
            self.restore()
        self.assert_unchanged()
        self.assertFalse((self.root / 'outside').exists())

    def test_producer_metadata_cannot_claim_a_different_pr(self):
        producer = cache.read_json(self.snapshot / 'producer.json')
        producer['pull_request'] = 99
        cache.atomic_json(self.snapshot / 'producer.json', producer)
        self.rebuild_artifacts()
        with self.assertRaisesRegex(cache.CacheError, 'producer mismatch'):
            self.restore()
        self.assert_unchanged()

    def test_restore_rejects_untrusted_release_context_without_network(self):
        self.release_env['GITHUB_EVENT_NAME'] = 'pull_request_target'
        with self.assertRaisesRegex(cache.CacheError, 'release context'):
            self.restore()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.downloads, [])
        self.assert_unchanged()


    def test_missing_job_token_cannot_use_local_github_credentials(self):
        self.release_env.pop('GH_TOKEN')
        with self.assertRaisesRegex(cache.CacheError, 'job token'):
            self.restore()
        self.assertEqual(self.calls, [])
        self.assert_unchanged()

    def test_different_workflow_revision_is_rejected_before_payload_download(self):
        self.run['referenced_workflows'][0]['sha'] = 'd' * 40
        with self.assertRaisesRegex(cache.CacheError, 'workflow version'):
            self.restore()
        self.assertEqual(self.downloads, [101])
        self.assert_unchanged()

    def test_pack_refuses_a_foreign_pr_before_writing_a_snapshot(self):
        event = json.loads(self.event.read_text())
        event['pull_request']['head']['repo']['id'] = 999
        self.event.write_text(json.dumps(event))
        output = self.root / 'refused-snapshot'
        with self.assertRaisesRegex(cache.CacheError, 'foreign'):
            pr.pack(self.identity_path, self.disk, self.repo, output, self.head, self.env)
        self.assertFalse(output.exists())

    def test_pack_refuses_checkout_drift_before_writing_a_snapshot(self):
        output = self.root / 'drifted-snapshot'
        with self.assertRaisesRegex(cache.CacheError, 'checkout'):
            pr.pack(self.identity_path, self.disk, self.repo, output, self.head, self.env)
        self.assertFalse(output.exists())

    def test_hit_summary_does_not_also_record_an_initial_miss(self):
        summary = self.root / 'step-summary'
        outputs = self.root / 'step-outputs'
        args = [str(Path(pr.__file__)), 'restore', '--identity', str(self.identity_path),
                '--disk', str(self.restored_disk), '--repo', str(self.restored_repo),
                '--source', self.merge]
        with patch.dict(os.environ, {**self.release_env, 'GITHUB_STEP_SUMMARY': str(summary),
                                    'GITHUB_OUTPUT': str(outputs)}, clear=True), patch.object(sys, 'argv', args):
            self.assertEqual(pr.main(), 0)
        self.assertEqual(summary.read_text().count('**hit**'), 1)
        self.assertNotIn('**miss**', summary.read_text())
        self.assertEqual(dict(row.split('=', 1) for row in outputs.read_text().splitlines())['hit'], 'true')


    def test_explicit_empty_source_does_not_fall_back_to_event_commit(self):
        output = self.root / 'empty-source'
        with self.assertRaisesRegex(cache.CacheError, 'source SHA'):
            cache.pack(self.identity_path, self.disk, self.repo, output, source_sha='')
        self.assertFalse(output.exists())

    def test_snapshot_from_another_slot_is_rejected_before_payload(self):
        manifest = cache.read_json(self.snapshot / 'manifest.json')
        manifest['identity']['slot'] = 'darwin-arm64-xcode-27'
        manifest['slot'] = manifest['identity']['slot']
        manifest['dimension'] = cache.dimension(manifest['identity'])
        cache.atomic_json(self.snapshot / 'manifest.json', manifest)
        self.rebuild_artifacts()
        with self.assertRaisesRegex(cache.CacheError, 'source or attempt'):
            self.restore()
        self.assertEqual(self.downloads, [101])
        self.assert_unchanged()

    def test_event_source_tree_must_match_the_qualified_release(self):
        producer = cache.read_json(self.snapshot / 'producer.json')
        producer['event_sha'] = self.git.base
        cache.atomic_json(self.snapshot / 'producer.json', producer)
        self.responses[f'{PREFIX}/git/commits/{self.git.base}'] = {
            'sha': self.git.base, 'tree': {'sha': self.git.git('rev-parse', self.git.base + '^{tree}')},
        }
        self.rebuild_artifacts()
        with self.assertRaisesRegex(cache.CacheError, 'workflow tree'):
            self.restore()
        self.assertEqual(self.downloads, [101])
        self.assert_unchanged()

    def test_unavailable_artifact_reports_fallback_without_replacing_roots(self):
        outputs = self.root / 'failed-step-outputs'
        args = [str(Path(pr.__file__)), 'restore', '--identity', str(self.identity_path),
                '--disk', str(self.restored_disk), '--repo', str(self.restored_repo),
                '--source', self.merge]
        failure = subprocess.CalledProcessError(1, ['gh', 'api'])
        with patch.dict(os.environ, {**self.release_env, 'GITHUB_OUTPUT': str(outputs)}, clear=True), \
                patch.object(sys, 'argv', args), patch.object(pr, 'download', side_effect=failure):
            self.assertEqual(pr.main(), 0)
        values = dict(row.split('=', 1) for row in outputs.read_text().splitlines())
        self.assertEqual(values['hit'], 'false')
        self.assertEqual(values['source'], 'fallback')
        self.assert_unchanged()


if __name__ == '__main__':
    unittest.main()
