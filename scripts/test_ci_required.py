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


class RequiredCITests(unittest.TestCase):
    def test_complete_success(self):
        GATE.require_success({'build': {'result': 'success'}, 'tests': {'result': 'success'}}, ['build', 'tests'])

    def test_failure_cancellation_skip_and_unknown_block(self):
        for result in ('failure', 'cancelled', 'skipped', None, 'pending'):
            with self.subTest(result=result), self.assertRaisesRegex(ValueError, 'did not succeed'):
                GATE.require_success({'build': {'result': 'success'}, 'tests': {'result': result}}, ['build', 'tests'])

    def test_missing_or_unexpected_dependency_blocks(self):
        for needs in ({'build': {'result': 'success'}},
                      {'build': {'result': 'success'}, 'tests': {'result': 'success'}, 'extra': {'result': 'success'}}):
            with self.subTest(needs=needs), self.assertRaisesRegex(ValueError, 'inventory'):
                GATE.require_success(needs, ['build', 'tests'])

    def test_empty_or_duplicate_required_set_cannot_pass(self):
        for names in ([], ['build', 'build']):
            with self.subTest(names=names), self.assertRaisesRegex(ValueError, 'nonempty and unique'):
                GATE.require_success({}, names)

    def test_nonobject_results_cannot_pass(self):
        with self.assertRaisesRegex(ValueError, 'did not succeed'):
            GATE.require_success({'build': 'success'}, ['build'])

    def test_actual_command_returns_nonzero_for_skipped_job(self):
        result = subprocess.run([sys.executable, str(SCRIPT), 'build'],
                                env={**os.environ, 'NEEDS': json.dumps({'build': {'result': 'skipped'}})},
                                capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('build=', result.stderr)


if __name__ == '__main__':
    unittest.main()
