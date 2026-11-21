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
SOURCE_COMMIT = f'{PREFIX}/git/commits/{SOURCE}'
HEAD_COMMIT = f'{PREFIX}/git/commits/{HEAD}'


def fixture():
    return {
        PULLS: [[{
            'number': 17, 'merged_at': '2026-11-18T12:00:00Z', 'merge_commit_sha': SOURCE,
            'base': {'ref': 'coreforge', 'repo': {'full_name': REPOSITORY}},
            'head': {'sha': HEAD, 'repo': {'full_name': REPOSITORY}},
        }]],
        SOURCE_COMMIT: {'sha': SOURCE, 'tree': {'sha': TREE}},
        HEAD_COMMIT: {'sha': HEAD, 'tree': {'sha': TREE}},
    }


class ReleaseAdmissionTests(unittest.TestCase):
    def qualify(self, responses):
        def github_api(endpoint, *, paginate=False):
            value = responses[endpoint]
            if endpoint == PULLS and not paginate:
                return value[0]
            return value
        with patch.object(admission, 'github_api', side_effect=github_api):
            return admission.qualify_release(SOURCE, REPOSITORY)

    def test_accepts_exact_merged_source_without_ci_results(self):
        self.assertEqual(self.qualify(fixture()), (17, HEAD))

    def test_paginates_merged_prs_instead_of_missing_later_matches(self):
        responses = fixture()
        responses[PULLS].insert(0, [{'number': 16, 'merged_at': None}])
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
        with self.assertRaises(ValueError):
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

    def test_rejects_merge_content_different_from_the_pr_head(self):
        responses = fixture()
        responses[SOURCE_COMMIT]['tree']['sha'] = '4' * 40
        with self.assertRaises(ValueError):
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
        for endpoint, value in [(PULLS, {}), (PULLS, [[None]])]:
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
