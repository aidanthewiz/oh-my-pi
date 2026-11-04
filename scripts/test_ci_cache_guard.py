import base64
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('ci_cache_guard', Path(__file__).with_name('ci_cache_guard.py'))
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)
SHA = '1' * 40
OTHER_SHA = '2' * 40


class SyntheticAPI:
    def __init__(self, responses):
        self.responses = responses

    def __call__(self, suffix):
        return copy.deepcopy(self.responses[suffix])


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            'GITHUB_REPOSITORY': guard.REPOSITORY,
            'GITHUB_REPOSITORY_ID': str(guard.REPOSITORY_ID),
            'GITHUB_REPOSITORY_OWNER_ID': str(guard.OWNER_ID),
            'GITHUB_EVENT_NAME': 'push',
            'GITHUB_REF': guard.BRANCH,
            'GITHUB_SHA': SHA,
            'GITHUB_RUN_ID': '100',
            'GITHUB_RUN_ATTEMPT': '2',
            'SOURCE_SHA': SHA,
            'CALLER_WORKFLOW_SHA': SHA,
            'EXPECTED_WORKFLOW': 'cf-release',
            'BUILD_RESULT': 'success',
            'REQUESTED': 'true',
            'ENABLED': 'true',
            'CANARY_ID': '',
            'TRANSFER': '',
            'CACHE_SLOT': 'linux-x64-ubuntu-22.04',
            'CI_CACHE_BUCKET': 'coreforge-ci-cache-800128555654-us-gov-west-1',
            'CI_CACHE_REGION': 'us-gov-west-1',
            'CI_CACHE_PREFIX': 'omp-bazel-v1',
            'READ_ROLE': f'arn:aws-us-gov:iam::{guard.ACCOUNT}:role/CoreforgeOmpCacheRead',
            'WRITE_ROLE': f'arn:aws-us-gov:iam::{guard.ACCOUNT}:role/CoreforgeOmpCacheWrite',
        }
        self.repo = {'full_name': guard.REPOSITORY, 'id': guard.REPOSITORY_ID,
                     'owner': {'id': guard.OWNER_ID}}
        self.event = {'pull_request': {'base': {'repo': self.repo, 'ref': 'coreforge'}}}
        self.workflow('cf-release')

    def workflow(self, name):
        self.env['EXPECTED_WORKFLOW'] = name
        path = f'.github/workflows/{name}.yml'
        self.env['CALLER_WORKFLOW_REF'] = f'{guard.REPOSITORY}/{path}@{self.env["GITHUB_REF"]}'
        self.run = {'id': 100, 'run_attempt': 2, 'event': self.env['GITHUB_EVENT_NAME'],
                    'head_sha': SHA, 'repository': copy.deepcopy(self.repo),
                    'head_repository': copy.deepcopy(self.repo), 'head_branch': 'coreforge',
                    'path': path, 'workflow_id': 10, 'run_started_at': '2030-01-02T00:00:00Z'}
        if name == 'cf-release':
            names = ['prepare', 'release', 'verify_release', *(f'build ({target})' for target in guard.TARGETS)]
            slots = guard.RELEASE_SLOTS
        elif name == 'relay':
            names, slots = ['validate', 'publish'], ('linux-x64-ubuntu-24.04',)
        else:
            names, slots = ['cold-build'], ('linux-x64-ubuntu-22.04',)
        self.jobs = [{'name': name, 'status': 'completed', 'conclusion': 'success',
                      'completed_at': '2030-01-02T00:01:00Z'} for name in names]
        self.artifacts = [{'name': 'snapshot-' + slot, 'expired': False,
                           'created_at': '2030-01-02T00:02:00Z',
                           'workflow_run': {'id': 100, 'head_sha': SHA, 'head_repository_id': guard.REPOSITORY_ID}}
                          for slot in slots]
        self.responses = {
            'git/ref/heads/coreforge': {'object': {'sha': SHA}},
            'actions/runs/100/attempts/2': self.run,
            'actions/workflows/10': {'path': path},
            'actions/runs/100/attempts/2/jobs?per_page=100&page=1': {'jobs': self.jobs, 'total_count': len(self.jobs)},
            'actions/runs/100/artifacts?per_page=100&page=1': {'artifacts': self.artifacts, 'total_count': len(self.artifacts)},
        }
        self.api = SyntheticAPI(self.responses)

    def canary(self):
        self.env.update(GITHUB_EVENT_NAME='workflow_dispatch', CANARY_ID='proof-123',
                        REQUESTED='false', ENABLED='false', TRANSFER='cold')
        self.workflow('cf-cache-canary')

    def writer(self, helper_sha=SHA):
        return guard.authorize_write(self.env, self.api, helper_sha)

    def reader(self, helper_sha=SHA):
        return guard.authorize_read(self.env, self.event, self.api, helper_sha)

    def test_release_authorizes_complete_eight_target_build_and_seven_snapshot_inventory(self):
        result = self.writer()
        self.assertEqual(result['slots'], guard.RELEASE_SLOTS)
        self.assertEqual(result['prefix'], 'omp-bazel-v1')

    def test_release_requires_every_successful_predecessor(self):
        for job in self.jobs:
            with self.subTest(job=job['name']):
                job['conclusion'] = 'failure'
                with self.assertRaisesRegex(guard.Refused, 'predecessor'):
                    self.writer()
                job['conclusion'] = 'success'

    def test_predecessor_must_be_completed_with_completion_timestamp(self):
        for status, completed in [('in_progress', None), ('completed', None)]:
            with self.subTest(status=status):
                self.jobs[0].update(status=status, completed_at=completed)
                with self.assertRaisesRegex(guard.Refused, 'predecessor'):
                    self.writer()

    def test_duplicate_successful_predecessor_is_ambiguous(self):
        self.jobs.append(copy.deepcopy(self.jobs[0]))
        self.responses['actions/runs/100/attempts/2/jobs?per_page=100&page=1']['total_count'] += 1
        with self.assertRaisesRegex(guard.Refused, 'predecessor'):
            self.writer()

    def test_unexpected_release_matrix_target_is_rejected(self):
        self.jobs.append({'name': 'build (linux-unreviewed)', 'status': 'completed',
                          'conclusion': 'success', 'completed_at': '2030-01-02T00:01:00Z'})
        self.responses['actions/runs/100/attempts/2/jobs?per_page=100&page=1']['total_count'] += 1
        with self.assertRaisesRegex(guard.Refused, 'build matrix'):
            self.writer()

    def test_successful_caller_claim_does_not_replace_api_predecessors(self):
        self.jobs[-1]['conclusion'] = 'skipped'
        with self.assertRaisesRegex(guard.Refused, 'predecessor'):
            self.writer()
        self.jobs[-1]['conclusion'] = 'success'
        self.env['BUILD_RESULT'] = 'failure'
        with self.assertRaisesRegex(guard.Refused, 'caller build failed'):
            self.writer()

    def test_production_writer_requires_both_enablement_controls(self):
        for name in ('REQUESTED', 'ENABLED'):
            with self.subTest(name=name):
                self.env[name] = 'false'
                with self.assertRaisesRegex(guard.Refused, 'disabled'):
                    self.writer()
                self.env[name] = 'true'

    def test_writer_rejects_stale_source_helper_and_workflow(self):
        for name in ('SOURCE_SHA', 'GITHUB_SHA', 'CALLER_WORKFLOW_SHA'):
            with self.subTest(name=name):
                self.env[name] = OTHER_SHA
                with self.assertRaises(guard.Refused):
                    self.writer()
                self.env[name] = SHA
        with self.assertRaisesRegex(guard.Refused, 'SHA mismatch'):
            self.writer(OTHER_SHA)
        self.responses['git/ref/heads/coreforge']['object']['sha'] = OTHER_SHA
        with self.assertRaisesRegex(guard.Refused, 'current coreforge tip'):
            self.writer()

    def test_run_api_rejects_wrong_attempt_event_source_repository_and_path(self):
        for field, value in [('id', 101), ('run_attempt', 1), ('event', 'workflow_dispatch'),
                             ('head_sha', OTHER_SHA), ('head_branch', 'feature'),
                             ('path', '.github/workflows/attacker.yml'),
                             ('repository', {**self.repo, 'id': 999}),
                             ('head_repository', {**self.repo, 'id': 999})]:
            with self.subTest(field=field):
                original = self.run[field]
                self.run[field] = value
                with self.assertRaises(guard.Refused):
                    self.writer()
                self.run[field] = original

    def test_run_api_rejects_repository_owner_and_workflow_identity_mismatch(self):
        self.run['repository']['owner']['id'] = 999
        with self.assertRaisesRegex(guard.Refused, 'run provenance'):
            self.writer()
        self.run['repository']['owner']['id'] = guard.OWNER_ID
        self.responses['actions/workflows/10']['path'] = '.github/workflows/attacker.yml'
        with self.assertRaisesRegex(guard.Refused, 'workflow identity'):
            self.writer()

    def test_repository_name_does_not_replace_immutable_identity(self):
        for field in ('GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID'):
            original = self.env[field]
            with self.subTest(field=field):
                self.env[field] = '999'
                with self.assertRaisesRegex(guard.Refused, 'repository identity'):
                    self.writer()
                with self.assertRaisesRegex(guard.Refused, 'repository identity'):
                    self.reader()
                self.env[field] = original

    def test_relay_annotated_tag_authorizes_only_validate_publish_and_relay_slot(self):
        self.env['GITHUB_REF'] = 'refs/tags/relay/v1.2.3'
        self.workflow('relay')
        self.responses['git/ref/tags/relay%2Fv1.2.3'] = {'object': {'type': 'tag', 'sha': OTHER_SHA}}
        self.responses['git/tags/' + OTHER_SHA] = {'object': {'type': 'commit', 'sha': SHA}}
        self.assertEqual(self.writer()['slots'], ('linux-x64-ubuntu-24.04',))
        for job in self.jobs:
            with self.subTest(job=job['name']):
                job['conclusion'] = 'failure'
                with self.assertRaisesRegex(guard.Refused, 'predecessor'):
                    self.writer()
                job['conclusion'] = 'success'

    def test_release_lightweight_tag_must_resolve_to_current_source(self):
        self.env['GITHUB_REF'] = 'refs/tags/v1.2.3.4'
        self.workflow('cf-release')
        self.responses['git/ref/tags/v1.2.3.4'] = {'object': {'type': 'commit', 'sha': SHA}}
        self.assertEqual(self.writer()['prefix'], 'omp-bazel-v1')
        self.responses['git/ref/tags/v1.2.3.4']['object']['sha'] = OTHER_SHA
        with self.assertRaisesRegex(guard.Refused, 'tag does not resolve'):
            self.writer()

    def test_tag_cycle_is_rejected(self):
        self.env['GITHUB_REF'] = 'refs/tags/v1.2.3.4'
        self.workflow('cf-release')
        obj = {'object': {'type': 'tag', 'sha': OTHER_SHA}}
        self.responses['git/ref/tags/v1.2.3.4'] = obj
        self.responses['git/tags/' + OTHER_SHA] = obj
        with self.assertRaisesRegex(guard.Refused, 'invalid tag chain'):
            self.writer()

    def test_release_and_relay_cannot_exchange_tag_namespaces(self):
        for workflow, ref in [('cf-release', 'refs/tags/relay/v1.2.3'), ('relay', guard.BRANCH),
                              ('cf-release', 'refs/tags/v1.2.3')]:
            with self.subTest(workflow=workflow, ref=ref):
                self.env['GITHUB_REF'] = ref
                self.workflow(workflow)
                with self.assertRaisesRegex(guard.Refused, 'writer ref'):
                    self.writer()

    def test_api_pagination_consumes_required_predecessor_on_second_page(self):
        self.responses['actions/runs/100/attempts/2/jobs?per_page=100&page=1'] = {
            'jobs': self.jobs[:-1], 'total_count': len(self.jobs)}
        self.responses['actions/runs/100/attempts/2/jobs?per_page=100&page=2'] = {
            'jobs': self.jobs[-1:], 'total_count': len(self.jobs)}
        self.assertEqual(self.writer()['slots'], guard.RELEASE_SLOTS)
        self.jobs[-1]['conclusion'] = 'cancelled'
        with self.assertRaisesRegex(guard.Refused, 'predecessor'):
            self.writer()

    def test_incomplete_api_listing_fails_closed(self):
        self.responses['actions/runs/100/attempts/2/jobs?per_page=100&page=1']['total_count'] += 1
        self.responses['actions/runs/100/attempts/2/jobs?per_page=100&page=2'] = {'jobs': [], 'total_count': len(self.jobs) + 1}
        with self.assertRaisesRegex(guard.Refused, 'incomplete API listing'):
            self.writer()

    def test_canary_cannot_claim_a_production_writer_workflow(self):
        self.canary()
        self.env['EXPECTED_WORKFLOW'] = 'cf-release'
        with self.assertRaisesRegex(guard.Refused, 'unexpected canary caller/source'):
            self.writer()

    def test_api_listing_cannot_shrink_count_to_hide_missing_predecessor(self):
        self.responses['actions/runs/100/attempts/2/jobs?per_page=100&page=1'] = {
            'jobs': self.jobs[:-1], 'total_count': len(self.jobs)}
        self.responses['actions/runs/100/attempts/2/jobs?per_page=100&page=2'] = {
            'jobs': [], 'total_count': len(self.jobs) - 1}
        with self.assertRaisesRegex(guard.Refused, 'inconsistent API listing count'):
            self.writer()

    def test_artifacts_require_same_run_source_repository_and_attempt_window(self):
        artifact = self.artifacts[0]
        for field, value in [('id', 101), ('head_sha', OTHER_SHA), ('head_repository_id', 999)]:
            with self.subTest(field=field):
                old = artifact['workflow_run'][field]
                artifact['workflow_run'][field] = value
                with self.assertRaisesRegex(guard.Refused, 'artifact source/attempt'):
                    self.writer()
                artifact['workflow_run'][field] = old
        artifact['created_at'] = '2030-01-01T00:02:00Z'
        with self.assertRaisesRegex(guard.Refused, 'artifact source/attempt'):
            self.writer()
        artifact['created_at'] = '2030-01-02T00:02:00Z'
        artifact['expired'] = True
        with self.assertRaisesRegex(guard.Refused, 'artifact source/attempt'):
            self.writer()

    def test_artifact_inventory_rejects_missing_extra_and_duplicate_snapshots(self):
        for change in ('missing', 'extra', 'duplicate'):
            with self.subTest(change=change):
                self.workflow('cf-release')
                if change == 'missing':
                    self.artifacts.pop()
                else:
                    extra = copy.deepcopy(self.artifacts[0])
                    if change == 'extra':
                        extra['name'] = 'snapshot-unreviewed-slot'
                    self.artifacts.append(extra)
                self.responses['actions/runs/100/artifacts?per_page=100&page=1']['total_count'] = len(self.artifacts)
                with self.assertRaisesRegex(guard.Refused, 'snapshot artifacts'):
                    self.writer()

    def test_canary_authorizes_before_global_enablement_with_derived_namespace(self):
        self.canary()
        self.jobs.append({'name': 'warm-build', 'status': 'queued', 'conclusion': None, 'completed_at': None})
        self.responses['actions/runs/100/attempts/2/jobs?per_page=100&page=1']['total_count'] += 1
        result = self.writer()
        self.assertEqual(result, {'slots': ('linux-x64-ubuntu-22.04',), 'prefix': 'omp-bazel-v1/canary/proof-123'})
        self.assertEqual(self.reader()['artifact'], 'cache-restore-canary-cold-linux-x64-ubuntu-22.04')
        self.env['TRANSFER'] = 'warm'
        self.assertEqual(self.reader()['artifact'], 'cache-restore-canary-warm-linux-x64-ubuntu-22.04')
        self.assertEqual(self.reader()['prefix'], result['prefix'])

    def test_canary_cold_build_must_be_completed_successfully(self):
        self.canary()
        self.jobs[0]['conclusion'] = 'failure'
        with self.assertRaisesRegex(guard.Refused, 'cold-build'):
            self.writer()

    def test_canary_id_cannot_escape_namespace(self):
        self.canary()
        for value in ('../production', 'a/b', 'a\n', '-leading', 'A', 'a' * 49):
            with self.subTest(value=value):
                self.env['CANARY_ID'] = value
                with self.assertRaisesRegex(guard.Refused, 'canary id'):
                    self.writer()
                with self.assertRaisesRegex(guard.Refused, 'canary id'):
                    self.reader()
        self.env['CANARY_ID'] = 'a' * 48
        self.assertEqual(self.writer()['prefix'], 'omp-bazel-v1/canary/' + 'a' * 48)

    def test_canary_requires_actual_dispatch_workflow_branch_and_repository(self):
        self.canary()
        for field, value in [('GITHUB_EVENT_NAME', 'pull_request'), ('GITHUB_EVENT_NAME', 'push'),
                             ('GITHUB_REF', 'refs/heads/feature'),
                             ('CALLER_WORKFLOW_REF', guard.REPOSITORY + '/.github/workflows/cf-release.yml@' + guard.BRANCH),
                             ('GITHUB_REPOSITORY', 'attacker/oh-my-pi')]:
            with self.subTest(field=field, value=value):
                old = self.env[field]
                self.env[field] = value
                with self.assertRaises(guard.Refused):
                    self.writer()
                with self.assertRaises(guard.Refused):
                    self.reader()
                self.env[field] = old

    def test_canary_api_path_and_tip_are_authoritative(self):
        self.canary()
        self.run['path'] = '.github/workflows/cf-release.yml'
        with self.assertRaisesRegex(guard.Refused, 'run provenance'):
            self.reader()
        self.run['path'] = guard.CANARY_PATH
        self.responses['git/ref/heads/coreforge']['object']['sha'] = OTHER_SHA
        with self.assertRaisesRegex(guard.Refused, 'current coreforge tip'):
            self.reader()
        with self.assertRaises(guard.Refused):
            self.writer()

    def test_canary_reader_rejects_stale_helper_or_caller_source(self):
        self.canary()
        with self.assertRaisesRegex(guard.Refused, 'SHA mismatch'):
            self.reader(OTHER_SHA)
        self.env['CALLER_WORKFLOW_SHA'] = OTHER_SHA
        with self.assertRaisesRegex(guard.Refused, 'SHA mismatch'):
            self.reader()

    def test_canary_reader_transfer_and_slot_are_bounded(self):
        self.canary()
        for value in ('', 'hot', '../cold'):
            with self.subTest(value=value):
                self.env['TRANSFER'] = value
                with self.assertRaisesRegex(guard.Refused, 'transfer'):
                    self.reader()
        self.env['TRANSFER'] = 'cold'
        self.env['CACHE_SLOT'] = 'linux-x64-ubuntu-24.04'
        with self.assertRaisesRegex(guard.Refused, 'canary slot'):
            self.reader()

    def test_normal_pr_reader_uses_protected_helper_without_requiring_pr_sha_match(self):
        self.env.update(GITHUB_EVENT_NAME='pull_request', GITHUB_REF='refs/pull/7/merge',
                        GITHUB_SHA=OTHER_SHA, CALLER_WORKFLOW_SHA=OTHER_SHA)
        self.env['CALLER_WORKFLOW_REF'] = guard.REPOSITORY + '/.github/workflows/cf-verify.yml@refs/pull/7/merge'
        result = self.reader()
        self.assertEqual(result, {'enabled': 'true', 'prefix': 'omp-bazel-v1',
                                  'artifact': 'cache-restore-linux-x64-ubuntu-22.04'})

    def test_reader_rejects_other_pr_base_and_unknown_caller(self):
        self.env.update(GITHUB_EVENT_NAME='pull_request', GITHUB_REF='refs/pull/7/merge')
        self.env['CALLER_WORKFLOW_REF'] = guard.REPOSITORY + '/.github/workflows/cf-verify.yml@refs/pull/7/merge'
        self.event['pull_request']['base']['ref'] = 'main'
        with self.assertRaisesRegex(guard.Refused, 'PR base'):
            self.reader()
        self.event['pull_request']['base']['ref'] = 'coreforge'
        self.event['pull_request']['base']['repo'] = {**self.repo, 'id': 999}
        with self.assertRaisesRegex(guard.Refused, 'PR base'):
            self.reader()
        self.event['pull_request']['base']['repo'] = self.repo
        self.env['CALLER_WORKFLOW_REF'] = guard.REPOSITORY + '/.github/workflows/untrusted.yml@refs/pull/7/merge'
        with self.assertRaisesRegex(guard.Refused, 'PR caller'):
            self.reader()

    def test_normal_reader_disabled_without_configuration_and_transfer_is_canary_only(self):
        self.env['ENABLED'] = 'false'
        del self.env['READ_ROLE']
        self.assertEqual(self.reader()['enabled'], 'false')
        self.env['TRANSFER'] = 'cold'
        with self.assertRaisesRegex(guard.Refused, 'canary-only'):
            self.reader()

    def test_reader_cannot_enable_dispatch_without_canary_id(self):
        self.env['GITHUB_EVENT_NAME'] = 'workflow_dispatch'
        with self.assertRaisesRegex(guard.Refused, 'reader event'):
            self.reader()

    def test_configuration_rejects_other_role_region_and_arbitrary_prefix(self):
        for field, value in [('READ_ROLE', f'arn:aws:iam::{guard.ACCOUNT}:role/CoreforgeOmpCacheRead'),
                             ('CI_CACHE_REGION', 'us-east-1'), ('CI_CACHE_PREFIX', 'omp/../production'),
                             ('CI_CACHE_PREFIX', 'omp/canary/injected'), ('CI_CACHE_PREFIX', 'omp\nother=x')]:
            with self.subTest(field=field):
                old = self.env[field]
                self.env[field] = value
                with self.assertRaises(guard.Refused):
                    self.reader()
                self.env[field] = old

    def make_snapshot(self, root):
        slot = 'linux-x64-ubuntu-22.04'
        destination = root / ('snapshot-' + slot)
        destination.mkdir()
        manifest = {'slot': slot, 'source_sha': SHA, 'run_id': 100, 'run_attempt': 2}
        (destination / 'manifest.json').write_text(json.dumps(manifest))
        (destination / 'snapshot.tar.gz').write_bytes(b'inert synthetic archive')
        return slot, destination, manifest

    def test_snapshot_provenance_binds_every_manifest_field_to_current_run_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slot, destination, manifest = self.make_snapshot(root)
            guard.snapshots(root, (slot,), self.env)
            for field, value in [('slot', 'another-slot'), ('source_sha', OTHER_SHA), ('run_id', 101), ('run_attempt', 1)]:
                with self.subTest(field=field):
                    (destination / 'manifest.json').write_text(json.dumps({**manifest, field: value}))
                    with self.assertRaisesRegex(guard.Refused, 'manifest provenance'):
                        guard.snapshots(root, (slot,), self.env)

    def test_snapshot_layout_rejects_extra_files_and_symlink_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slot, destination, _ = self.make_snapshot(root)
            (destination / 'extra').write_text('unapproved')
            with self.assertRaisesRegex(guard.Refused, 'snapshot layout'):
                guard.snapshots(root, (slot,), self.env)
            (destination / 'extra').unlink()
            archive = destination / 'snapshot.tar.gz'
            archive.unlink()
            archive.symlink_to(destination / 'manifest.json')
            with self.assertRaisesRegex(guard.Refused, 'regular file'):
                guard.snapshots(root, (slot,), self.env)

    def test_snapshot_directory_symlink_is_not_trusted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = root / 'payload'
            payload.mkdir()
            slot, destination, _ = self.make_snapshot(payload)
            transfer = root / 'transfer'
            transfer.mkdir()
            (transfer / destination.name).symlink_to(destination, target_is_directory=True)
            with self.assertRaisesRegex(guard.Refused, 'snapshot layout'):
                guard.snapshots(transfer, (slot,), self.env)

    def claims(self):
        return {'iss': 'https://token.actions.githubusercontent.com', 'aud': 'sts.amazonaws.com',
                'sub': f'repo:{guard.REPOSITORY}:ref:{guard.BRANCH}',
                'repository_id': str(guard.REPOSITORY_ID), 'repository_owner_id': str(guard.OWNER_ID),
                'job_workflow_ref': guard.REPOSITORY + '/.github/workflows/cf-cache-write.yml@' + SHA,
                'ref': guard.BRANCH}

    @staticmethod
    def token(claims):
        encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
        return 'header.' + encoded + '.signature'

    def test_oidc_receipt_excludes_nonallowlisted_claims(self):
        claims = self.claims()
        claims['private-claim'] = 'must-not-be-recorded'
        result = guard.oidc_claims(self.token(claims), self.env, 'write')
        self.assertNotIn('private-claim', result)
        self.assertNotIn('must-not-be-recorded', json.dumps(result))
        self.assertEqual(set(result), set(guard.CLAIMS))

    def test_oidc_receipt_rejects_wrong_audience_subject_repository_ref_and_broker(self):
        for field, value in [('iss', 'https://attacker.invalid'), ('aud', 'other-role'),
                             ('sub', f'repo:{guard.REPOSITORY}:environment:release'),
                             ('repository_id', '999'), ('repository_owner_id', '999'),
                             ('ref', 'refs/heads/feature'),
                             ('job_workflow_ref', guard.REPOSITORY + '/.github/workflows/cf-release.yml@' + SHA),
                             ('job_workflow_ref', guard.REPOSITORY + '/.github/workflows/cf-cache-write.yml@refs/heads/coreforge')]:
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(guard.Refused, 'OIDC claims'):
                    guard.oidc_claims(self.token({**self.claims(), field: value}), self.env, 'write')

    def test_oidc_pr_read_receipt_preserves_default_pr_subject(self):
        self.env.update(GITHUB_EVENT_NAME='pull_request', GITHUB_REF='refs/pull/7/merge')
        claims = self.claims()
        claims.update(sub=f'repo:{guard.REPOSITORY}:pull_request', ref='refs/pull/7/merge',
                      job_workflow_ref=guard.REPOSITORY + '/.github/workflows/cf-cache-read.yml@' + SHA)
        self.assertEqual(guard.oidc_claims(self.token(claims), self.env, 'read')['sub'],
                         f'repo:{guard.REPOSITORY}:pull_request')

    def test_sts_receipt_requires_actual_account_partition_and_role(self):
        identity = {'Account': guard.ACCOUNT,
                    'Arn': f'arn:aws-us-gov:sts::{guard.ACCOUNT}:assumed-role/CoreforgeOmpCacheWrite/cache-write-100-2',
                    'UserId': 'synthetic-role:cache-write-100-2'}
        self.assertEqual(guard.caller_identity(identity, 'write')['Account'], guard.ACCOUNT)
        for field, value in [('Account', '999999999999'),
                             ('Arn', identity['Arn'].replace('aws-us-gov', 'aws')),
                             ('Arn', identity['Arn'].replace('CoreforgeOmpCacheWrite', 'CoreforgeOmpCacheRead'))]:
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(guard.Refused, 'STS caller'):
                    guard.caller_identity({**identity, field: value}, 'write')


if __name__ == '__main__':
    unittest.main()
