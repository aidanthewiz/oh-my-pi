import importlib.util
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('ci_cache_release.py').resolve()
WORKFLOW = SCRIPT.parent.parent / '.github/workflows/cf-release.yml'
SPEC = importlib.util.spec_from_file_location('ci_cache_release', SCRIPT)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class PathPolicyTests(unittest.TestCase):
    def test_only_direct_cache_names_are_cache_paths(self):
        allowed = [
            b'.github/workflows/cf-verify.yml',
            b'.github/workflows/relay.yml', b'.github/workflows/cf-cache-read.yml',
            b'.github/workflows/cf-cache-A0_b-c.yml', b'scripts/ci_cache.py',
            b'scripts/test_ci_cache.py', b'scripts/ci_cache_release.py',
            b'scripts/test_ci_cache_A0-b.py',
        ]
        for path in allowed:
            with self.subTest(path=path):
                self.assertTrue(release.is_cache_path(path))
        denied = [
            b'packages/coding-agent/package.json', b'crates/runtime.rs',
            b'scripts/ci-release-build-binaries.ts', b'Cargo.lock',
            b'README.md', b'CONTRIBUTING.md', b'docs/ci-cache-iam.md', b'docs/ci-cache-iam.md.bak',
            b'.github/workflows/cf-release.yml',
            b'.github/workflows/cf-cache-.yml', b'.github/workflows/cf-cache-read.yaml',
            b'.github/workflows/cf-cache-nested/read.yml',
            b'.github/workflows/cf-cache-read.extra.yml',
            b'.github/workflows/cf-cache-\xff.yml',
            b'scripts/ci_cache_.py', b'scripts/ci_cache/nested.py',
            b'scripts/ci_cache_extra/nested.py', b'scripts/ci_cache_extra.py/child',
            b'scripts/ci_cache_extra.py\ncrates/runtime.rs', b'scripts/ci_cache_\xff.py',
            b'scripts/CI_cache.py', b'./scripts/ci_cache.py', b'',
        ]
        for path in denied:
            with self.subTest(path=path):
                self.assertFalse(release.is_cache_path(path))

def artifact_workflow():
    gate = "needs.prepare.outputs.should_release == 'true'"
    return {'on': {'push': {'branches': ['coreforge']}}, 'permissions': {'contents': 'read'},
            'jobs': {
                'prepare': {'steps': [{'id': 'release', 'run': 'admit\n\nallocate\n'}]},
                'build': {'needs': 'prepare', 'if': gate,
                          'strategy': {'matrix': {'target': ['linux-x64', 'darwin-arm64']}},
                          'steps': [
                              {'id': 'bazel-cache', 'name': 'Restore Bazel native build cache',
                               'uses': 'actions/cache/restore@fixture'},
                              {'name': 'Build native addon', 'run': 'bun scripts/bazel-natives.ts host'},
                              {'name': 'Sign binary', 'run': 'codesign --sign fixture binary'},
                              {'name': 'Save Bazel native build cache', 'uses': 'actions/cache/save@fixture'},
                          ]},
                'release': {'if': gate, 'steps': [{'run': 'publish artifact'}]},
                'verify_release': {'if': gate, 'steps': [{'run': 'verify artifact'}]},
            }}



class GitFixture:
    """Own synthetic Git object bytes and local refs, without creating source commits."""

    def __init__(self, root):
        self.root = root
        self.repo = root / 'repo'
        self.origin = root / 'origin.git'
        self.bin = root / 'bin'
        self.bin.mkdir()
        self.repo.mkdir()
        home = root / 'home'
        home.mkdir()
        for name, target in [('python3', sys.executable), ('git', shutil.which('git')),
                             ('bun', shutil.which('bun'))]:
            if target is not None:
                (self.bin / name).symlink_to(target)
        self.env = {
            'PATH': str(self.bin) + os.pathsep + os.defpath,
            'HOME': str(home), 'TMPDIR': str(root),
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0',
            'LC_ALL': 'C',
        }
        self.git('init', '--object-format=sha1', '--initial-branch=fixture')
        self.git('init', '--bare', '--object-format=sha1', '--initial-branch=fixture', str(self.origin))
        self.git('remote', 'add', 'origin', str(self.origin))
        self.files = {
            'packages/coding-agent/package.json': b'{"version":"1.2.3"}\n',
            'README.md': b'repository overview\n',
            'CONTRIBUTING.md': b'contributor workflow\n',
            'docs/ci-cache-iam.md': b'embedded cache policy\n',
            'crates/runtime.rs': b'fn artifact_input() {}\n',
            '.github/workflows/cf-release.yml': json.dumps(artifact_workflow()).encode(),
        }
        self.base = self.commit(self.files)
        self.tag('v1.2.3.1', self.base)
        package = self.repo / 'packages/coding-agent/package.json'
        package.parent.mkdir(parents=True)
        package.write_bytes(self.files['packages/coding-agent/package.json'])
        scripts = self.repo / 'scripts'
        scripts.mkdir()
        for name in [SCRIPT.name, 'ci-released-native.ts', 'ci_release_admission.py', 'ci_pr_scope.py']:
            (scripts / name).symlink_to(SCRIPT.with_name(name))

    def run(self, args, *, data=None, cwd=None, env=None):
        return subprocess.run(args, input=data, cwd=cwd or self.repo,
                              env=env or self.env, capture_output=True)

    def git(self, *args, data=None):
        result = self.run(['git', *args], data=data)
        if result.returncode:
            raise AssertionError(result.stderr.decode(errors='replace'))
        return result.stdout.decode().strip()

    def object(self, kind, data):
        return self.git('hash-object', '-t', kind, '-w', '--stdin', data=data)

    def tree(self, files):
        entries = {}
        for path, contents in files.items():
            node = entries
            parts = path.split('/')
            for part in parts[:-1]:
                node = node.setdefault(part, {})
            node[parts[-1]] = contents

        def write_tree(node):
            records = []
            for name, contents in node.items():
                if isinstance(contents, dict):
                    mode, kind, oid = '040000', 'tree', write_tree(contents)
                else:
                    mode, contents = contents if isinstance(contents, tuple) else ('100644', contents)
                    kind, oid = 'blob', self.object('blob', contents)
                records.append(f'{mode} {kind} {oid}\t{name}'.encode() + b'\0')
            return self.git('mktree', '-z', data=b''.join(records))

        return write_tree(entries)

    def commit(self, files, parents=()):
        headers = [f'tree {self.tree(files)}', *(f'parent {parent}' for parent in parents),
                   'author Fixture <fixture@invalid> 1700000000 +0000',
                   'committer Fixture <fixture@invalid> 1700000000 +0000']
        return self.object('commit', ('\n'.join(headers) + '\n\nfixture data\n').encode())

    def changed(self, changes):
        files = dict(self.files)
        for path, contents in changes.items():
            if contents is None:
                files.pop(path)
            else:
                files[path] = contents
        return self.commit(files, [self.base])

    def classify(self, source, *, cwd=None, env=None, published_ref='base'):
        args = [sys.executable, str(SCRIPT), source]
        if published_ref is not None:
            args += ['--published-ref', self.base if published_ref == 'base' else published_ref]
        return self.run(args, cwd=cwd, env=env)

    def publish_tip(self, source):
        self.git('push', '--quiet', 'origin', f'{source}:refs/fixtures/{source}')
        self.git('--git-dir', str(self.origin), 'update-ref', 'refs/heads/coreforge', source)

    def tag(self, name, source, *, annotated=False):
        target = source
        if annotated:
            target = self.object('tag', (
                f'object {source}\ntype commit\ntag {name}\n'
                'tagger Fixture <fixture@invalid> 1700000000 +0000\n\nfixture tag\n'
            ).encode())
        self.git('update-ref', f'refs/tags/{name}', target)
        self.git('push', '--quiet', 'origin', f'refs/tags/{name}')
        return target

    def prepare(self, shell, source, *, ref_type='branch', ref_name='coreforge', merged=1,
                published=('v1.2.3.1',), tip=None, records=None, metadata_failure=False,
                qualified_head=None, check_status='completed', check_conclusion='success',
                admission_failure=False):
        self.publish_tip(tip or source)
        gh = self.bin / 'gh'
        gh.write_text('''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys
args = sys.argv[1:]
with Path(os.environ['GH_CALLS']).open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
source = os.environ['EVENT_SHA']
head = os.environ['QUALIFIED_HEAD']
prefix = 'repos/fixture/repo'
if args == ['api', prefix + '/commits/' + source + '/pulls?per_page=100', '--paginate', '--slurp']:
    if os.environ['ADMISSION_FAILURE'] == 'true':
        sys.exit(98)
    pull = {'number': 17, 'merged_at': '2026-11-18T12:00:00Z', 'merge_commit_sha': source,
            'base': {'ref': 'coreforge', 'repo': {'full_name': 'fixture/repo'}},
            'head': {'sha': head, 'repo': {'full_name': 'fixture/repo'}}}
    print(json.dumps([[pull] * int(os.environ['MERGED_COUNT'])]))
    sys.exit(0)
if args == ['api', prefix + '/commits/' + head + '/check-runs?check_name=required%20CI&filter=latest&per_page=100',
            '--paginate', '--slurp']:
    print(json.dumps([{'check_runs': [{'id': 1, 'name': 'required CI', 'app': {'slug': 'github-actions'},
                                     'head_sha': head, 'status': os.environ['CHECK_STATUS'],
                                     'conclusion': json.loads(os.environ['CHECK_CONCLUSION'])}]}]))
    sys.exit(0)
if len(args) == 2 and args[0] == 'api' and args[1].startswith(prefix + '/git/commits/'):
    commit = args[1].rsplit('/', 1)[1]
    tree = subprocess.check_output(['git', 'rev-parse', commit + '^{tree}']).decode().strip()
    print(json.dumps({'sha': commit, 'tree': {'sha': tree}}))
    sys.exit(0)
if args == ['release', 'list', '--repo', 'fixture/repo', '--exclude-drafts', '--limit', '1000',
            '--json', 'tagName,isDraft']:
    if os.environ['METADATA_FAILURE'] == 'true':
        sys.exit(98)
    print(os.environ['RELEASE_RECORDS'])
    sys.exit(0)
if len(args) == 5 and args[:2] == ['release', 'view'] and args[3:] == ['--repo', 'fixture/repo']:
    sys.exit(0 if args[2] in json.loads(os.environ['PUBLISHED_TAGS']) else 1)
sys.exit(97)
''')
        gh.chmod(0o700)
        output = self.root / 'output'
        output.write_text('')
        calls = self.root / 'gh-calls'
        calls.write_text('')
        env = {**self.env, 'EVENT_SHA': source, 'EVENT_REF_TYPE': ref_type,
               'EVENT_REF_NAME': ref_name, 'GITHUB_REPOSITORY': 'fixture/repo',
               'GITHUB_OUTPUT': str(output), 'GH_TOKEN': 'synthetic-not-a-token',
               'GH_CALLS': str(calls), 'MERGED_COUNT': str(merged),
               'PUBLISHED_TAGS': json.dumps(published),
               'RELEASE_RECORDS': json.dumps(records if records is not None else
                                             [{'tagName': tag, 'isDraft': False} for tag in published]),
               'METADATA_FAILURE': 'true' if metadata_failure else 'false'}
        env.update({
            'QUALIFIED_HEAD': qualified_head or source, 'CHECK_STATUS': check_status,
            'CHECK_CONCLUSION': json.dumps(check_conclusion),
            'ADMISSION_FAILURE': 'true' if admission_failure else 'false',
        })
        result = self.run(['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], env=env)
        outputs = dict(line.split('=', 1) for line in output.read_text().splitlines())
        requests = [json.loads(line) for line in calls.read_text().splitlines()]
        return result, outputs, requests


@unittest.skipUnless(os.name == 'posix', 'release prepare uses a POSIX Bash runner')
class GitDecisionTests(unittest.TestCase):
    def setUp(self):
        for tool in ('git', 'bun'):
            if shutil.which(tool) is None:
                self.fail(f'{tool} is required for release decision qualification')
        self.temp = tempfile.TemporaryDirectory(prefix='ci-cache-release-')
        self.addCleanup(self.temp.cleanup)
        self.fixture = GitFixture(Path(self.temp.name))

    def assert_decision(self, source, expected):
        result = self.fixture.classify(source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, expected.encode() + b'\n')

    def test_cache_only_merge_compares_published_ancestor_not_second_parent(self):
        files = {**self.fixture.files, 'scripts/ci_cache_probe.py': b'cache tooling'}
        other = self.fixture.commit({**self.fixture.files, 'crates/runtime.rs': b'other runtime'})
        source = self.fixture.commit(files, [self.fixture.base, other])
        self.assert_decision(source, 'false')

    def test_regular_root_docs_and_cache_changes_do_not_republish_artifacts(self):
        for path in ('README.md', 'CONTRIBUTING.md'):
            for contents in (b'updated public guidance\n', None):
                with self.subTest(path=path, contents=contents):
                    source = self.fixture.changed({path: contents, 'scripts/ci_cache_probe.py': b'cache'})
                    self.assert_decision(source, 'false')
            files = dict(self.fixture.files)
            files.pop(path)
            base = self.fixture.commit(files, [self.fixture.base])
            source = self.fixture.commit({**files, path: b'new public guidance\n'}, [base])
            result = self.fixture.classify(source, published_ref=base)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'false\n')

    def test_embedded_docs_including_cache_policy_require_an_artifact_release(self):
        for path in ('docs/ci-cache-iam.md', 'docs/new-guide.md', 'docs/README.md'):
            with self.subTest(path=path):
                self.assert_decision(self.fixture.changed({path: b'changed embedded documentation'}), 'true')
        self.assert_decision(self.fixture.changed({'docs/ci-cache-iam.md': None}), 'true')

    def test_nonregular_paths_and_executable_root_docs_cannot_skip_release(self):
        for changes in [
            {'README.md': ('120000', b'crates/runtime.rs')},
            {'CONTRIBUTING.md': ('120000', b'crates/runtime.rs')},
            {'README.md': ('100755', b'executable document')},
            {'scripts/ci_cache_probe.py': ('120000', b'../crates/runtime.rs')},
            {'README.md': b'documentation', 'crates/runtime.rs': b'changed artifact'},
        ]:
            with self.subTest(changes=changes):
                self.assert_decision(self.fixture.changed(changes), 'true')
        for path in ('README.md', 'CONTRIBUTING.md'):
            files = {**self.fixture.files, path: ('100755', b'executable guidance')}
            base = self.fixture.commit(files, [self.fixture.base])
            source = self.fixture.commit({**files, path: ('100755', b'changed executable guidance')}, [base])
            result = self.fixture.classify(source, published_ref=base)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b'true\n')

    def test_nul_delimited_runtime_filename_cannot_masquerade_as_cache_path(self):
        source = self.fixture.changed({'scripts/ci_cache_probe.py\nunknown': b'artifact input'})
        self.assert_decision(source, 'true')

    def test_missing_malformed_root_and_noncommit_sources_fail_without_decision(self):
        blob = self.fixture.object('blob', b'not a commit')
        for source in ['f' * 40, 'HEAD', self.fixture.base[:12], '--helpful', 'g' * 40,
                       'a' * 39 + '\n', self.fixture.base, blob]:
            with self.subTest(source=source):
                result = self.fixture.classify(source)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b'')

    def test_missing_git_and_not_repository_fail_without_decision(self):
        source = self.fixture.changed({'scripts/ci_cache_probe.py': b'cache'})
        result = self.fixture.classify(source, env={**self.fixture.env, 'PATH': str(self.fixture.root / 'absent')})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')
        result = self.fixture.classify(source, cwd=self.fixture.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')

    def test_absent_anchor_cannot_suppress_even_cache_only_release(self):
        source = self.fixture.changed({'scripts/ci_cache_probe.py': b'cache'})
        result = self.fixture.classify(source, published_ref=None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b'true\n')

    def test_invalid_missing_and_nonancestor_published_refs_abort_without_decision(self):
        source = self.fixture.changed({'scripts/ci_cache_probe.py': b'cache'})
        unrelated = self.fixture.commit({'unrelated': b'not source ancestry'})
        for ref in ['HEAD', '--all', 'v1.2.3.0', 'v1.2.3.9', 'f' * 40, unrelated]:
            with self.subTest(ref=ref):
                result = self.fixture.classify(source, published_ref=ref)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b'')


    def test_malformed_workflow_or_cache_region_cannot_skip_release(self):
        invalid = artifact_workflow()
        invalid['jobs']['prepare']['steps'][0]['run'] = (
            'admit\n# coreforge-cache-publication:start\nallocate\n'
        )
        for contents in [b'jobs: [', json.dumps(invalid).encode()]:
            with self.subTest(contents=contents):
                source = self.fixture.changed({'.github/workflows/cf-release.yml': contents})
                result = self.fixture.classify(source)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b'')


@unittest.skipUnless(os.name == 'posix', 'release prepare uses a POSIX Bash runner')
class PrepareWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for tool in ('git', 'bun', 'bash'):
            if shutil.which(tool) is None:
                raise RuntimeError(f'{tool} is required for actual release prepare qualification')
        with tempfile.TemporaryDirectory(prefix='ci-cache-workflow-') as home:
            result = subprocess.run([
                shutil.which('bun'), '-e',
                'const workflow = Bun.YAML.parse(await Bun.file(process.argv[1]).text()); '
                'console.log(JSON.stringify(workflow.jobs.prepare.steps.find(step => step.id === "release").run));',
                str(WORKFLOW),
            ], capture_output=True, text=True, cwd=home,
                env={'HOME': home, 'PATH': os.defpath, 'TMPDIR': home})
            if result.returncode:
                raise RuntimeError(result.stderr)
            cls.shell = json.loads(result.stdout)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ci-cache-prepare-')
        self.addCleanup(self.temp.cleanup)
        self.fixture = GitFixture(Path(self.temp.name))

    def assert_release(self, source, *, tag='v1.2.3.2', **kwargs):
        result, outputs, _ = self.fixture.prepare(self.shell, source, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {'release_tag': tag, 'should_release': 'true', 'release_sha': source})

    def test_cache_only_branch_exits_before_tag_allocation_or_release_lookup(self):
        source = self.fixture.changed({
            'CONTRIBUTING.md': b'cache adoption',
            '.github/workflows/cf-verify.yml': b'cache reader',
            '.github/workflows/relay.yml': b'cache consumer',
            '.github/workflows/cf-cache-read.yml': b'broker',
            'scripts/ci_cache.py': b'cache', 'scripts/test_ci_cache.py': b'qualification',
        })
        self.fixture.tag('v1.2.3.7', source)
        self.fixture.tag('v1.2.3.8', source)
        result, outputs, calls = self.fixture.prepare(self.shell, source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {'should_release': 'false'})
        self.assertEqual([call[:2] for call in calls if call[0] == 'release'], [['release', 'list']])
        self.assertFalse(any(call[0] == 'api' for call in calls))

    def test_non_artifact_changes_skip_pending_or_stale_qualification(self):
        source = self.fixture.changed({'README.md': b'public guidance'})
        result, outputs, calls = self.fixture.prepare(
            self.shell, source, qualified_head=self.fixture.base,
            check_status='in_progress', check_conclusion=None,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {'should_release': 'false'})
        self.assertFalse(any(call[0] == 'api' for call in calls))

    def test_artifact_changes_empty_diff_and_renames_keep_release_decision(self):
        changes = [
            {'crates/runtime.rs': b'new runtime'},
            {'scripts/ci_cache_probe.py': b'cache', 'packages/coding-agent/package.json': b'{"version":"1.2.3","changed":true}'},
            {'crates/runtime.rs': None},
            {'crates/runtime.rs': None, 'scripts/ci_cache_moved.py': self.fixture.files['crates/runtime.rs']},
            {'unknown-input': b'unreviewed artifact input'},
            {},
        ]
        for change in changes:
            with self.subTest(paths=list(change)):
                self.assert_release(self.fixture.changed(change))

    def test_manual_four_part_cache_only_tag_bypasses_classifier_and_merged_pr_lookup(self):
        source = self.fixture.changed({'scripts/ci_cache_probe.py': b'cache'})
        self.fixture.tag('v1.2.3.7', source)
        result, outputs, calls = self.fixture.prepare(
            self.shell, source, ref_type='tag', ref_name='v1.2.3.7', merged=0,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {'release_tag': 'v1.2.3.7', 'should_release': 'true', 'release_sha': source})
        self.assertEqual(calls, [])

    def test_manual_annotated_event_can_identify_the_tag_object_or_peeled_commit(self):
        source = self.fixture.changed({'scripts/ci_cache_probe.py': b'cache'})
        annotated = self.fixture.tag('v1.2.3.7', source, annotated=True)
        for event in (annotated, source):
            with self.subTest(event=event):
                result, outputs, calls = self.fixture.prepare(
                    self.shell, event, ref_type='tag', ref_name='v1.2.3.7', tip=source, merged=0,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(outputs, {
                    'release_tag': 'v1.2.3.7', 'should_release': 'true', 'release_sha': source,
                })
                self.assertEqual(calls, [])

    def test_manual_tag_cannot_substitute_a_new_target_for_the_triggering_event(self):
        event = self.fixture.changed({'scripts/ci_cache_probe.py': b'original event'})
        current = self.fixture.changed({'crates/runtime.rs': b'current tip'})
        self.fixture.tag('v1.2.3.7', current)
        for event_sha in (event, 'f' * 40):
            with self.subTest(event_sha=event_sha):
                result, outputs, calls = self.fixture.prepare(
                    self.shell, event_sha, ref_type='tag', ref_name='v1.2.3.7', tip=current,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(outputs, {})
                self.assertEqual(calls, [])

    def test_automatic_release_accepts_distinct_commits_with_identical_qualified_trees(self):
        files = {**self.fixture.files, 'crates/runtime.rs': b'qualified artifact'}
        head = self.fixture.commit(files, [self.fixture.base])
        source = self.fixture.commit(files, [self.fixture.base, head])
        self.assert_release(source, qualified_head=head)

    def test_automatic_release_rejects_missing_qualification_and_unqualified_merge_content(self):
        source = self.fixture.changed({'crates/runtime.rs': b'new artifact'})
        for kwargs in [
            {'check_status': 'in_progress', 'check_conclusion': None},
            {'check_conclusion': 'failure'},
            {'qualified_head': self.fixture.base},
            {'admission_failure': True},
        ]:
            with self.subTest(kwargs=kwargs):
                result, outputs, _ = self.fixture.prepare(self.shell, source, **kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(outputs, {})

    def test_artifact_release_still_requires_merged_pr_and_current_tip(self):
        for merged, stale in [(0, False), (1, True)]:
            with self.subTest(merged=merged, stale=stale):
                source = self.fixture.changed({'crates/runtime.rs': b'candidate runtime'})
                tip = self.fixture.changed({'crates/runtime.rs': b'newer runtime'}) if stale else source
                result, outputs, _ = self.fixture.prepare(
                    self.shell, source, merged=merged, tip=tip,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(outputs, {'should_release': 'false'})

    def test_root_commit_classifier_failure_aborts_prepare_without_any_release_outputs(self):
        result, outputs, _ = self.fixture.prepare(self.shell, self.fixture.base)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(outputs, {})

    def test_runtime_release_allocates_after_existing_roll_and_resumes_unpublished_tag(self):
        source = self.fixture.changed({'crates/runtime.rs': b'new runtime'})
        self.fixture.tag('v1.2.3.3', self.fixture.base)
        self.assert_release(source, tag='v1.2.3.4', published=['v1.2.3.3'])
        self.fixture.tag('v1.2.3.7', source)
        self.assert_release(source, tag='v1.2.3.7', published=['v1.2.3.3'])
        self.fixture.tag('v1.2.3.8', source)
        result, outputs, _ = self.fixture.prepare(self.shell, source, published=['v1.2.3.3'])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(outputs, {})

    def test_pending_runtime_before_cache_tip_is_not_stranded_by_unpublished_tag(self):
        runtime_files = {**self.fixture.files, 'crates/runtime.rs': b'pending runtime'}
        runtime = self.fixture.commit(runtime_files, [self.fixture.base])
        source = self.fixture.commit({**runtime_files, 'scripts/ci_cache_probe.py': b'cache'}, [runtime])
        self.fixture.tag('v1.2.3.7', runtime)
        self.assert_release(source, tag='v1.2.3.8')
        result, outputs, _ = self.fixture.prepare(
            self.shell, source, published=['v1.2.3.1', 'v1.2.3.7'],
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {'should_release': 'false'})

    def test_missing_published_anchor_and_draft_or_other_family_do_not_skip(self):
        source = self.fixture.changed({'scripts/ci_cache_probe.py': b'cache'})
        self.fixture.tag('v1.2.3.7', self.fixture.base)
        for records in [[], [{'tagName': 'v1.2.3.7', 'isDraft': True}],
                        [{'tagName': 'v9.8.7.3', 'isDraft': False}]]:
            with self.subTest(records=records):
                self.assert_release(source, tag='v1.2.3.8', published=(), records=records)

    def test_published_release_metadata_or_tag_resolution_failure_aborts_prepare(self):
        source = self.fixture.changed({'scripts/ci_cache_probe.py': b'cache'})
        for kwargs in [{'metadata_failure': True}, {'published': ['v1.2.3.99']}]:
            with self.subTest(kwargs=kwargs):
                result, outputs, _ = self.fixture.prepare(self.shell, source, **kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(outputs, {})

    def test_cache_workflow_adoption_preserves_all_artifact_semantics(self):
        old = artifact_workflow()
        new = copy.deepcopy(old)
        jobs = new['jobs']
        jobs['cache_restore'] = {'uses': 'owner/repo/.github/workflows/cf-cache-read.yml@fixture'}
        jobs['cache_publish'] = {'uses': 'owner/repo/.github/workflows/cf-cache-write.yml@fixture'}
        build = jobs['build']
        build['name'] = 'build (${{ matrix.target }})'
        build['needs'] = ['prepare', 'cache_restore']
        build['steps'] = [
            {'id': 'cache-identity', 'name': 'Identify compatible Bazel caches',
             'run': 'python3 scripts/ci_cache.py identity'},
            *build['steps'][1:3],
            {'name': 'Save successful GitHub hot cache', 'uses': 'actions/cache/save@fixture'},
        ]
        for name, suffix in [('build', ''), ('release', " && needs.build.result == 'success'"),
                             ('verify_release', " && needs.release.result == 'success'")]:
            jobs[name]['if'] = ("${{ !cancelled() && needs.prepare.result == 'success' && "
                                "needs.prepare.outputs.should_release == 'true'" + suffix + " }}")
        jobs['prepare']['steps'][0]['run'] = (
            'admit\n\n# coreforge-cache-publication:start\ncache decision\n'
            '# coreforge-cache-publication:end\n\nallocate\n'
        )
        source = self.fixture.changed({'.github/workflows/cf-release.yml': json.dumps(new).encode()})
        result, outputs, _ = self.fixture.prepare(self.shell, source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(outputs, {'should_release': 'false'})
        mutations = [
            lambda doc: doc['jobs']['build']['steps'][1].update(run='bun scripts/bazel-natives.ts changed'),
            lambda doc: doc['jobs']['build']['steps'][2].update(run='codesign --sign other binary'),
            lambda doc: doc['jobs']['build']['strategy']['matrix'].update(target=['linux-x64']),
            lambda doc: doc['jobs']['prepare']['steps'][0].update(run='different admission\n'),
            lambda doc: doc['jobs']['release'].update(**{'if': 'always()'}),
            lambda doc: doc.update(permissions={'contents': 'write'}),
            lambda doc: doc['jobs']['build']['steps'].append({'name': 'Other cache step', 'run': 'artifact change'}),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(new)
            mutate(changed)
            source = self.fixture.changed({'.github/workflows/cf-release.yml': json.dumps(changed).encode()})
            self.assert_release(source)

    def test_manual_tag_must_still_match_tip_and_package_roll(self):
        source = self.fixture.changed({'scripts/ci_cache_probe.py': b'cache'})
        self.fixture.tag('v1.2.3.7', source)
        self.fixture.tag('v9.8.7.1', source)
        self.fixture.tag('v1.2.3.0', source)
        self.fixture.tag('v1.2.3.7bad', source)
        cases = [('v1.2.3.7', self.fixture.base), ('v9.8.7.1', source),
                 ('v1.2.3.0', source), ('v1.2.3.7bad', source)]
        for tag, tip in cases:
            with self.subTest(tag=tag, tip=tip):
                result, outputs, _ = self.fixture.prepare(
                    self.shell, source, ref_type='tag', ref_name=tag, tip=tip,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(outputs, {})


if __name__ == '__main__':
    unittest.main()
