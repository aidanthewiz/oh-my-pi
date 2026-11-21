import copy
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name('ci_release_admission.py').resolve()
SPEC = importlib.util.spec_from_file_location('ci_release_admission', SCRIPT)
admission = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(admission)

SOURCE = '1' * 40
HEAD = '2' * 40
TREE = '3' * 40
REPOSITORY = 'fixture/repo'
PREFIX = f'repos/{REPOSITORY}'
PULLS = f'{PREFIX}/commits/{SOURCE}/pulls?per_page=100'
CHECKS = f'{PREFIX}/commits/{HEAD}/check-runs?check_name=required%20CI&filter=latest&per_page=100'
SOURCE_COMMIT = f'{PREFIX}/git/commits/{SOURCE}'
HEAD_COMMIT = f'{PREFIX}/git/commits/{HEAD}'


def fixture():
    return {
        PULLS: [[{
            'number': 17, 'merged_at': '2026-11-18T12:00:00Z', 'merge_commit_sha': SOURCE,
            'base': {'ref': 'coreforge', 'repo': {'full_name': REPOSITORY}},
            'head': {'sha': HEAD, 'repo': {'full_name': REPOSITORY}},
        }]],
        CHECKS: [{'check_runs': [{
            'id': 1,
            'name': 'required CI', 'app': {'slug': 'github-actions'}, 'head_sha': HEAD,
            'status': 'completed', 'conclusion': 'success',
        }]}],
        SOURCE_COMMIT: {'sha': SOURCE, 'tree': {'sha': TREE}},
        HEAD_COMMIT: {'sha': HEAD, 'tree': {'sha': TREE}},
    }


class ReleaseAdmissionTests(unittest.TestCase):
    def qualify(self, responses):
        def github_api(endpoint, *, paginate=False):
            expected_pagination = endpoint in (PULLS, CHECKS)
            if paginate != expected_pagination:
                raise AssertionError('release metadata pagination contract changed')
            return responses[endpoint]
        with patch.object(admission, 'github_api', side_effect=github_api):
            return admission.qualify_release(SOURCE, REPOSITORY)

    def test_qualifies_exact_merged_head_with_successful_ci_and_identical_content(self):
        self.assertEqual(self.qualify(fixture()), (17, HEAD))

    def test_paginates_merged_prs_and_checks_instead_of_missing_later_matches(self):
        responses = fixture()
        responses[PULLS].insert(0, [{'number': 16, 'merged_at': None}])
        responses[CHECKS].insert(0, {'check_runs': [{'name': 'optional', 'status': 'completed'}]})
        self.assertEqual(self.qualify(responses), (17, HEAD))

    def test_does_not_promote_an_associated_but_different_merged_source(self):
        for mutate in [
            lambda pull: pull.update(merged_at=None),
            lambda pull: pull.update(merge_commit_sha='4' * 40),
            lambda pull: pull['base'].update(ref='main'),
        ]:
            with self.subTest(mutate=mutate):
                responses = fixture()
                mutate(responses[PULLS][0][0])
                self.assertIsNone(self.qualify(responses))

    def test_rejects_ambiguous_merged_source(self):
        responses = fixture()
        duplicate = copy.deepcopy(responses[PULLS][0][0])
        duplicate['number'] = 18
        responses[PULLS].append([duplicate])
        with self.assertRaisesRegex(ValueError, 'exactly one merged'):
            self.qualify(responses)

    def test_rejects_foreign_head_and_malformed_head_identity(self):
        for head in [
            {'sha': HEAD, 'repo': {'full_name': 'other/repo'}},
            {'sha': 'branch-name', 'repo': {'full_name': REPOSITORY}},
            {'sha': HEAD},
        ]:
            with self.subTest(head=head):
                responses = fixture()
                responses[PULLS][0][0]['head'] = head
                with self.assertRaises(ValueError):
                    self.qualify(responses)

    def test_rejects_unqualified_or_wrong_provider_checks(self):
        checks = [
            [],
            [{'name': 'optional', 'app': {'slug': 'github-actions'}, 'head_sha': HEAD,
              'status': 'completed', 'conclusion': 'success'}],
            [{'name': 'required CI', 'app': {'slug': 'other-app'}, 'head_sha': HEAD,
              'status': 'completed', 'conclusion': 'success'}],
        ]
        for check_runs in checks:
            with self.subTest(check_runs=check_runs):
                responses = fixture()
                responses[CHECKS][0]['check_runs'] = check_runs
                with self.assertRaisesRegex(ValueError, 'No GitHub Actions required CI'):
                    self.qualify(responses)

    def test_rejects_pending_failed_cancelled_skipped_or_stale_ci(self):
        for status, conclusion in [
            ('queued', None), ('in_progress', None), ('completed', 'failure'),
            ('completed', 'cancelled'), ('completed', 'skipped'),
            ('completed', 'neutral'), ('completed', 'timed_out'),
        ]:
            with self.subTest(status=status, conclusion=conclusion):
                responses = fixture()
                responses[CHECKS][0]['check_runs'][0].update(status=status, conclusion=conclusion)
                with self.assertRaisesRegex(ValueError, 'completed successful check'):
                    self.qualify(responses)
        responses = fixture()
        responses[CHECKS][0]['check_runs'][0]['head_sha'] = '4' * 40
        with self.assertRaisesRegex(ValueError, 'exact PR head'):
            self.qualify(responses)

    def test_success_cannot_mask_another_pending_latest_required_check(self):
        responses = fixture()
        responses[CHECKS].append({'check_runs': [{
            'id': 2,
            'name': 'required CI', 'app': {'slug': 'github-actions'}, 'head_sha': HEAD,
            'status': 'in_progress', 'conclusion': None,
        }]})
        with self.assertRaisesRegex(ValueError, 'completed successful check'):
            self.qualify(responses)

    def test_latest_success_replaces_older_failure_even_when_pages_arrive_out_of_order(self):
        responses = fixture()
        responses[CHECKS][0]['check_runs'][0]['id'] = 2
        responses[CHECKS].append({'check_runs': [{
            'id': 1, 'name': 'required CI', 'app': {'slug': 'github-actions'}, 'head_sha': HEAD,
            'status': 'completed', 'conclusion': 'failure',
        }]})
        self.assertEqual(self.qualify(responses), (17, HEAD))

    def test_unorderable_required_checks_cannot_authorize_release(self):
        for check_id in [None, 0, True, '2']:
            with self.subTest(check_id=check_id):
                responses = fixture()
                responses[CHECKS][0]['check_runs'][0]['id'] = check_id
                with self.assertRaisesRegex(ValueError, 'check-run identity'):
                    self.qualify(responses)

    def test_rejects_merge_content_not_qualified_by_the_head_check(self):
        responses = fixture()
        responses[SOURCE_COMMIT]['tree']['sha'] = '4' * 40
        with self.assertRaisesRegex(ValueError, 'differs from qualified PR #17 head'):
            self.qualify(responses)

    def test_rejects_wrong_commit_objects_and_missing_trees(self):
        for endpoint, value in [
            (SOURCE_COMMIT, {'sha': HEAD, 'tree': {'sha': TREE}}),
            (HEAD_COMMIT, {'sha': HEAD, 'tree': {'sha': 'invalid'}}),
            (HEAD_COMMIT, {'sha': HEAD}),
        ]:
            with self.subTest(endpoint=endpoint, value=value):
                responses = fixture()
                responses[endpoint] = value
                with self.assertRaises(ValueError):
                    self.qualify(responses)

    def test_malformed_metadata_and_api_errors_never_qualify(self):
        for endpoint, value in [(PULLS, {}), (PULLS, [[None]]), (CHECKS, [{}])]:
            with self.subTest(endpoint=endpoint, value=value):
                responses = fixture()
                responses[endpoint] = value
                with self.assertRaises(ValueError):
                    self.qualify(responses)
        with patch.object(admission, 'github_api', side_effect=subprocess.CalledProcessError(1, ['gh', 'api'])):
            with self.assertRaises(subprocess.CalledProcessError):
                admission.qualify_release(SOURCE, REPOSITORY)

    def test_rejects_nonimmutable_source_and_malformed_repository(self):
        for source, repository in [('HEAD', REPOSITORY), (SOURCE, '../other/repo'), (SOURCE, None)]:
            with self.subTest(source=source, repository=repository):
                with self.assertRaises(ValueError):
                    admission.qualify_release(source, repository)


if __name__ == '__main__':
    unittest.main()
