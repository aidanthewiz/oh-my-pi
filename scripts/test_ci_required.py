import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPT = Path(__file__).with_name('ci-required.py')
SPEC = importlib.util.spec_from_file_location('ci_required', SCRIPT)
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)

BASE_SHA = '1' * 40
SOURCE_SHA = '2' * 40
FULL_JOBS = (
    'prepare', 'darwin_arm64', 'darwin_x64', 'linux_x64', 'linux_arm64',
    'linux_musl_x64', 'linux_musl_arm64', 'win32_x64', 'win32_arm64', 'browser_relay',
)


def dependencies(scope):
    return {
        'plan': {'result': 'success', 'outputs': {
            'scope': scope, 'base_sha': BASE_SHA, 'source_sha': SOURCE_SHA,
        }},
        **{name: {'result': 'skipped' if scope == 'docs' else 'success'} for name in FULL_JOBS},
    }


class RequiredCITests(unittest.TestCase):
    def test_complete_code_and_documentation_plans_pass(self):
        for scope in ('full', 'docs'):
            with self.subTest(scope=scope):
                GATE.require_success(dependencies(scope), BASE_SHA, SOURCE_SHA)

    def test_every_code_lane_must_succeed(self):
        for name in FULL_JOBS:
            for result in ('failure', 'cancelled', 'skipped', None, 'pending'):
                with self.subTest(name=name, result=result), self.assertRaisesRegex(ValueError, name):
                    needs = dependencies('full')
                    needs[name]['result'] = result
                    GATE.require_success(needs, BASE_SHA, SOURCE_SHA)

    def test_documentation_rejects_every_unexpected_executed_or_failed_lane(self):
        for name in FULL_JOBS:
            for result in ('success', 'failure', 'cancelled', None, 'pending'):
                with self.subTest(name=name, result=result), self.assertRaisesRegex(ValueError, name):
                    needs = dependencies('docs')
                    needs[name]['result'] = result
                    GATE.require_success(needs, BASE_SHA, SOURCE_SHA)

    def test_missing_and_unexpected_dependencies_block_both_scopes(self):
        for scope in ('docs', 'full'):
            for name in ('plan', *FULL_JOBS):
                with self.subTest(scope=scope, missing=name), self.assertRaisesRegex(ValueError, 'inventory'):
                    needs = dependencies(scope)
                    del needs[name]
                    GATE.require_success(needs, BASE_SHA, SOURCE_SHA)
            with self.subTest(scope=scope, extra=True), self.assertRaisesRegex(ValueError, 'inventory'):
                GATE.require_success({**dependencies(scope), 'extra': {'result': 'success'}}, BASE_SHA, SOURCE_SHA)

    def test_only_successful_planning_can_authorize_either_scope(self):
        for scope in ('full', 'docs'):
            for result in ('failure', 'cancelled', 'skipped', None, 'pending'):
                with self.subTest(scope=scope, result=result), self.assertRaisesRegex(ValueError, 'planning'):
                    needs = dependencies(scope)
                    needs['plan']['result'] = result
                    GATE.require_success(needs, BASE_SHA, SOURCE_SHA)

    def test_unknown_or_missing_scope_cannot_authorize_skips(self):
        for scope in ('', None, 'documentation', 'FULL', False, [], {}):
            with self.subTest(scope=scope), self.assertRaisesRegex(ValueError, 'scope'):
                GATE.require_success(dependencies(scope), BASE_SHA, SOURCE_SHA)
        needs = dependencies('docs')
        del needs['plan']['outputs']['scope']
        with self.assertRaisesRegex(ValueError, 'scope'):
            GATE.require_success(needs, BASE_SHA, SOURCE_SHA)

    def test_plan_must_match_both_exact_event_commits(self):
        for scope in ('full', 'docs'):
            for name in ('base_sha', 'source_sha'):
                for value in (None, '', '3' * 40, SOURCE_SHA[:12]):
                    with self.subTest(scope=scope, name=name, value=value), self.assertRaisesRegex(ValueError, 'identity'):
                        needs = dependencies(scope)
                        needs['plan']['outputs'][name] = value
                        GATE.require_success(needs, BASE_SHA, SOURCE_SHA)
            for outputs in (None, [], 'docs'):
                with self.subTest(scope=scope, outputs=outputs), self.assertRaisesRegex(ValueError, 'identity'):
                    needs = dependencies(scope)
                    needs['plan']['outputs'] = outputs
                    GATE.require_success(needs, BASE_SHA, SOURCE_SHA)

    def test_malformed_commit_arguments_and_dependency_objects_block(self):
        for value in (None, '', 'HEAD', 'A' * 40, SOURCE_SHA[:12]):
            for base, source in ((value, SOURCE_SHA), (BASE_SHA, value)):
                with self.subTest(base=base, source=source), self.assertRaisesRegex(ValueError, 'commit IDs'):
                    GATE.require_success(dependencies('docs'), base, source)
        for needs in (None, [], 'success'):
            with self.subTest(needs=needs), self.assertRaisesRegex(ValueError, 'inventory'):
                GATE.require_success(needs, BASE_SHA, SOURCE_SHA)
        for name in ('plan', *FULL_JOBS):
            with self.subTest(name=name), self.assertRaises(ValueError):
                needs = dependencies('docs')
                needs[name] = 'skipped'
                GATE.require_success(needs, BASE_SHA, SOURCE_SHA)

    def test_cli_accepts_complete_plans_and_rejects_invalid_evidence(self):
        for scope in ('full', 'docs'):
            result = subprocess.run([sys.executable, str(SCRIPT), BASE_SHA, SOURCE_SHA],
                                    env={**os.environ, 'NEEDS': json.dumps(dependencies(scope))},
                                    capture_output=True, text=True, check=False)
            with self.subTest(scope=scope):
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'Required CI passed: {scope}', result.stdout)
        for payload in ('{', 'null', json.dumps({'plan': {'result': 'success'}})):
            result = subprocess.run([sys.executable, str(SCRIPT), BASE_SHA, SOURCE_SHA],
                                    env={**os.environ, 'NEEDS': payload},
                                    capture_output=True, text=True, check=False)
            with self.subTest(payload=payload):
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Required CI passed', result.stdout)

    def test_cli_rejects_missing_evidence_and_the_obsolete_job_list_contract(self):
        env = {key: value for key, value in os.environ.items() if key != 'NEEDS'}
        for arguments in ((BASE_SHA, SOURCE_SHA), ('prepare', *FULL_JOBS[1:])):
            result = subprocess.run([sys.executable, str(SCRIPT), *arguments], env=env,
                                    capture_output=True, text=True, check=False)
            with self.subTest(arguments=arguments):
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('Required CI passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
