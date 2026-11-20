import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('ci_pr_scope.py').resolve()
SPEC = importlib.util.spec_from_file_location('ci_pr_scope', SCRIPT)
SCOPE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCOPE)


def raw_record(path=b'README.md', old_mode=b'100644', new_mode=b'100644', status=b'M'):
    old_oid = (b'0' if old_mode == b'000000' else b'1') * 40
    new_oid = (b'0' if new_mode == b'000000' else b'2') * 40
    return b':' + b' '.join((old_mode, new_mode, old_oid, new_oid, status)) + b'\0' + path + b'\0'


class DocumentationPolicyTests(unittest.TestCase):
    def test_only_nonexecutable_root_documents_are_exempt(self):
        for path in (b'README.md', b'CONTRIBUTING.md'):
            for old_mode, new_mode, status in ((b'000000', b'100644', b'A'),
                                               (b'100644', b'000000', b'D'),
                                               (b'100644', b'100644', b'M')):
                with self.subTest(path=path, status=status):
                    self.assertTrue(SCOPE.is_documentation_change(path, old_mode, new_mode, status))
        for path in (b'docs/help.md', b'docs/ci-cache-iam.md', b'packages/example/README.md',
                     b'.omp/skills/example/SKILL.md', b'CHANGELOG.md', b'README.MD',
                     b'./README.md', b'README.md/child', b'README.md\nsrc/runtime.ts', b'\xff.md', b''):
            with self.subTest(path=path):
                self.assertFalse(SCOPE.is_documentation_change(path, b'100644', b'100644', b'M'))

    def test_executable_nonregular_mode_changes_and_unknown_statuses_are_full(self):
        for old_mode, new_mode, status in ((b'100644', b'100755', b'M'),
                                           (b'100755', b'100755', b'M'),
                                           (b'000000', b'100755', b'A'),
                                           (b'100755', b'000000', b'D'),
                                           (b'100644', b'120000', b'T'),
                                           (b'000000', b'120000', b'A'),
                                           (b'120000', b'000000', b'D'),
                                           (b'000000', b'160000', b'A'),
                                           (b'120000', b'120000', b'M'),
                                           (b'100644', b'100644', b'U'),
                                           (b'100644', b'100644', b'X')):
            with self.subTest(old_mode=old_mode, new_mode=new_mode, status=status):
                self.assertFalse(SCOPE.is_documentation_change(b'README.md', old_mode, new_mode, status))
                self.assertEqual(SCOPE.classify_diff(raw_record(old_mode=old_mode, new_mode=new_mode, status=status)),
                                 'full')

    def test_empty_mixed_and_malformed_diff_evidence_cannot_select_docs(self):
        self.assertEqual(SCOPE.classify_diff(b''), 'full')
        self.assertEqual(SCOPE.classify_diff(raw_record() + raw_record(b'src/runtime.ts')), 'full')
        for malformed in (b'\0', raw_record()[:-1], raw_record() + b'junk\0',
                          b':100644 100644 short short M\0README.md\0',
                          raw_record().replace(b':100644', b':000000', 1),
                          raw_record(path=b'')):
            with self.subTest(malformed=malformed), self.assertRaises(ValueError):
                SCOPE.classify_diff(malformed)


class GitScopeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cf-pr-scope-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        home = self.root / 'home'
        home.mkdir()
        self.env = {
            'PATH': os.environ.get('PATH', os.defpath),
            'HOME': str(home), 'TMPDIR': str(self.root),
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C',
            **({'SystemRoot': os.environ['SystemRoot']} if 'SystemRoot' in os.environ else {}),
        }
        self.git('init', '--quiet', '--object-format=sha1', '--initial-branch=fixture')
        self.files = {
            'README.md': ('100644', b'# Readme\n'),
            'src/runtime.ts': ('100644', b'export const value = 1;\n'),
            'docs/runtime.md': ('100644', b'# Runtime documentation\n'),
        }
        self.base = self.commit(self.files)

    def git(self, *args, data=None):
        result = subprocess.run(['git', *args], cwd=self.repo, env=self.env,
                                input=data, capture_output=True, check=False)
        if result.returncode:
            self.fail(result.stderr.decode(errors='replace'))
        return result.stdout.decode().strip()

    def object(self, kind, data):
        return self.git('hash-object', '-t', kind, '-w', '--stdin', data=data)

    def tree(self, files):
        entries = {}
        for name, contents in files.items():
            node = entries
            components = name.split('/')
            for component in components[:-1]:
                node = node.setdefault(component, {})
            node[components[-1]] = contents

        def write_tree(node):
            records = []
            for name, contents in node.items():
                if isinstance(contents, dict):
                    mode, kind, oid = '040000', 'tree', write_tree(contents)
                else:
                    mode, data = contents
                    kind = 'commit' if mode == '160000' else 'blob'
                    oid = data if kind == 'commit' else self.object(kind, data)
                records.append(f'{mode} {kind} {oid}\t{name}'.encode() + b'\0')
            return self.git('mktree', '-z', data=b''.join(records))

        return write_tree(entries)

    def commit(self, files, parents=()):
        headers = [f'tree {self.tree(files)}', *(f'parent {parent}' for parent in parents),
                   'author Fixture <fixture@invalid> 1700000000 +0000',
                   'committer Fixture <fixture@invalid> 1700000000 +0000']
        return self.object('commit', ('\n'.join(headers) + '\n\nfixture data\n').encode())

    def changed(self, changes, *, parents=None):
        files = dict(self.files)
        for name, contents in changes.items():
            if contents is None:
                files.pop(name)
            else:
                files[name] = contents
        return self.commit(files, (self.base,) if parents is None else parents)

    def plan(self, source, *, base=None, checkout=None):
        self.git('checkout', '--quiet', '--detach', checkout or source)
        return subprocess.run([sys.executable, str(SCRIPT), base or self.base, source],
                              cwd=self.repo, env=self.env, capture_output=True, text=True, check=False)

    def assert_scope(self, expected, source, **kwargs):
        result = self.plan(source, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, f'scope={expected}\n')

    def test_actual_root_document_add_modify_and_delete_are_docs(self):
        for changes in ({'README.md': ('100644', b'# Updated readme\n')},
                        {'CONTRIBUTING.md': ('100644', b'# Contribution guide\n')},
                        {'README.md': None},
                        {'README.md': ('100644', b'# Updated readme\n'),
                         'CONTRIBUTING.md': ('100644', b'# Contribution guide\n')}):
            with self.subTest(changes=changes):
                self.assert_scope('docs', self.changed(changes))

    def test_runtime_docs_packages_skills_ci_and_dependencies_are_full(self):
        for name in ('docs/runtime.md', 'docs/ci-cache-iam.md', 'docs/nested/help.md',
                     'packages/coding-agent/README.md', 'packages/example/CHANGELOG.md',
                     '.omp/skills/example/SKILL.md', 'skills/example.md', 'CHANGELOG.md',
                     'README.md.bak', '.github/workflows/cf-verify.yml', 'bun.lock', 'Cargo.lock'):
            with self.subTest(name=name):
                self.assert_scope('full', self.changed({name: ('100644', b'changed\n')}))

    def test_root_document_cannot_hide_another_changed_path(self):
        self.assert_scope('full', self.changed({
            'README.md': ('100644', b'# Updated readme\n'),
            'src/runtime.ts': ('100644', b'export const value = 2;\n'),
        }))

    def test_renames_never_hide_a_code_deletion_or_new_runtime_path(self):
        self.git('config', 'diff.renames', 'true')
        self.assert_scope('full', self.changed({
            'src/runtime.ts': None,
            'CONTRIBUTING.md': self.files['src/runtime.ts'],
        }))
        self.assert_scope('full', self.changed({
            'README.md': None,
            'packages/example/README.md': self.files['README.md'],
        }))

    def test_nonregular_and_executable_root_documents_are_full(self):
        for changes in ({'README.md': ('120000', b'src/runtime.ts')},
                        {'CONTRIBUTING.md': ('120000', b'README.md')},
                        {'README.md': ('160000', self.base)},
                        {'README.md': ('100755', b'# Readme\n')},
                        {'CONTRIBUTING.md': ('100755', b'# Guide\n')}):
            with self.subTest(changes=changes):
                self.assert_scope('full', self.changed(changes))
        executable_files = {**self.files, 'README.md': ('100755', b'# Readme\n')}
        executable_base = self.commit(executable_files, (self.base,))
        source = self.commit({**executable_files, 'README.md': ('100755', b'# Updated readme\n')},
                             (executable_base,))
        self.assert_scope('full', source, base=executable_base)

    def test_empty_diff_is_full(self):
        self.assert_scope('full', self.base)
        self.assert_scope('full', self.commit(self.files, (self.base,)))

    def test_real_whitespace_and_conflict_errors_fail_planning(self):
        self.git('config', '--', 'core.whitespace', '-blank-at-eol,-blank-at-eof,-space-before-tab')
        for content in (b'# Readme  \n', b'# Readme\n\n', b'<<<<<<< HEAD\nconflict\n=======\nother\n>>>>>>> branch\n'):
            with self.subTest(content=content):
                result = self.plan(self.changed({'README.md': ('100644', content)}))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('cannot classify PR scope', result.stderr)
                self.assertEqual(result.stdout, '')

    def test_actual_head_and_exact_commit_arguments_are_mandatory(self):
        source = self.changed({'README.md': ('100644', b'# Updated readme\n')})
        cases = ((source, self.base, self.base),
                 (source[:12], self.base, source),
                 (source, self.base[:12], source),
                 (source.upper(), self.base, source),
                 (source, '0' * 40, source),
                 (source, self.object('blob', b'not a commit'), source))
        for claimed_source, base, checkout in cases:
            with self.subTest(source=claimed_source, base=base, checkout=checkout):
                result = self.plan(claimed_source, base=base, checkout=checkout)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')

    def test_pr_diff_uses_merge_base_not_unrelated_base_branch_changes(self):
        source = self.changed({'README.md': ('100644', b'# Updated readme\n')})
        current_base = self.changed({'src/runtime.ts': ('100644', b'export const value = 2;\n')})
        self.assert_scope('docs', source, base=current_base)

    def test_unrelated_or_ambiguous_history_cannot_authorize_docs(self):
        unrelated = self.commit({'README.md': ('100644', b'# Other history\n')})
        result = self.plan(unrelated)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        left = self.changed({'README.md': ('100644', b'# Left\n')})
        right = self.changed({'README.md': ('100644', b'# Right\n')})
        base_merge = self.commit(self.files, (left, right))
        source_merge = self.commit(self.files, (right, left))
        result = self.plan(source_merge, base=base_merge)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unambiguous merge base', result.stderr)
        self.assertEqual(result.stdout, '')


if __name__ == '__main__':
    unittest.main()
