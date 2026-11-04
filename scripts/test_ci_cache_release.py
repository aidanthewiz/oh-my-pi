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
    def test_only_direct_cache_names_and_explicit_documentation_are_exempt(self):
        allowed = [
            b'CONTRIBUTING.md', b'docs/ci-cache-iam.md',
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
            b'README.md', b'docs/ci-cache-iam.md.bak',
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
        (scripts / SCRIPT.name).symlink_to(SCRIPT)
        (scripts / 'ci-released-native.ts').symlink_to(SCRIPT.with_name('ci-released-native.ts'))

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
                    mode, kind, oid = '100644', 'blob', self.object('blob', contents)
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

    def tag(self, name, source):
        self.git('update-ref', f'refs/tags/{name}', source)
        self.git('push', '--quiet', 'origin', f'refs/tags/{name}')

    def prepare(self, shell, source, *, ref_type='branch', ref_name='coreforge', merged=1,
                published=('v1.2.3.1',), tip=None, records=None, metadata_failure=False):
        self.publish_tip(tip or source)
        gh = self.bin / 'gh'
        gh.write_text('''#!/usr/bin/env python3
import json
import os
from pathlib import Path
import sys
args = sys.argv[1:]
with Path(os.environ['GH_CALLS']).open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
expected = ['api', 'repos/fixture/repo/commits/' + os.environ['EVENT_SHA'] + '/pulls',
            '--jq', '[.[] | select(.merged_at != null and .base.ref == "coreforge")] | length']
if args == expected:
    print(os.environ['MERGED_COUNT'])
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
            'CONTRIBUTING.md': b'cache adoption', 'docs/ci-cache-iam.md': b'cache policy',
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
        self.assertEqual([call[:2] for call in calls], [['api', calls[0][1]], ['release', 'list']])

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

    def test_branch_still_requires_merged_pr_and_current_tip_before_classifier(self):
        for merged, stale in [(0, False), (1, True)]:
            with self.subTest(merged=merged, stale=stale):
                source = self.fixture.base
                tip = self.fixture.changed({'crates/runtime.rs': b'new runtime'}) if stale else source
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
