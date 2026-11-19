#!/usr/bin/env python3
"""Require every named CI dependency to finish successfully before merge."""

import json
import os
import sys


def require_success(needs, required):
    if not required or len(required) != len(set(required)):
        raise ValueError('required job identifiers must be nonempty and unique')
    if not isinstance(needs, dict) or set(needs) != set(required):
        raise ValueError('CI dependency inventory does not match the required jobs')
    failed = []
    for name in required:
        dependency = needs[name]
        result = dependency.get('result') if isinstance(dependency, dict) else None
        if result != 'success':
            failed.append(f'{name}={result!r}')
    if failed:
        raise ValueError('Required CI did not succeed: ' + ', '.join(failed))


def main():
    required = sys.argv[1:]
    require_success(json.loads(os.environ['NEEDS']), required)
    print('Required CI passed: ' + ', '.join(required))


if __name__ == '__main__':
    try:
        main()
    except (KeyError, TypeError, ValueError) as error:
        raise SystemExit(str(error)) from None
