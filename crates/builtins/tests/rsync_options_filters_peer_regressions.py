import argparse
import os
from pathlib import Path
import shlex
import signal
import subprocess
import tempfile


def invoke(executable, args, cwd, env):
    process = subprocess.Popen(
        [str(executable), *args], cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    )
    try:
        out, err = process.communicate(timeout=15)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise
    return process.returncode, out, err


def require(condition, evidence):
    if not condition:
        raise AssertionError(evidence)


def inventory(root):
    require(root.is_dir(), ('missing inventory root', root))
    result = {}
    raw_root = os.fsencode(root)
    for current, dirs, files in os.walk(raw_root):
        for name in dirs:
            result[os.path.relpath(os.path.join(current, name), raw_root)] = None
        for name in files:
            path = os.path.join(current, name)
            with open(path, 'rb') as source:
                result[os.path.relpath(path, raw_root)] = source.read()
    return result


def listed(output, name):
    return any(
        line.rsplit(None, 1)[-1].rstrip(b'/') == name
        for line in output.splitlines() if line.strip()
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--scratch', type=Path, required=True)
    parser.add_argument('--case', choices=(
        'all', 'listing', 'qsort', 'cvs', 'maxdelete', 'serverfilter', 'iconv', 'deletions',
    ), default='all')
    args = parser.parse_args()
    require(os.name == 'posix', 'offline shell and raw-byte fixtures require POSIX')
    native = args.native.resolve(strict=True)
    reference = args.reference.resolve(strict=True)
    require(not os.path.samefile(native, reference), 'native and independent reference must differ')
    selected = lambda case: args.case in ('all', case)
    with tempfile.TemporaryDirectory(prefix='rsync-options-filters-', dir=args.scratch) as temporary:
        root = Path(temporary).resolve()
        home = root / 'home'
        home.mkdir()
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith('RSYNC_')
            and key not in ('LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'CVSIGNORE', 'CDPATH', 'ENV', 'BASH_ENV')
        }
        env.update(HOME=str(home), LANG='C.UTF-8', LC_ALL='C.UTF-8')
        version = invoke(reference, ['--version'], root, env)
        require(version[0] == 0 and version[1].startswith(b'rsync  version 3.5.1 '),
                ('reference must be independently pinned rsync 3.5.1', version))
        trace = root / 'rsh-entered'
        rsh = root / 'offline-rsh'
        rsh.write_text(
            '#!/bin/sh\n[ "$1" = fixture ] || exit 97\nshift\n'
            + 'printf entered\\n >> ' + shlex.quote(str(trace)) + '\n'
            + 'exec /bin/sh -c "$*"\n'
        )
        rsh.chmod(0o700)

        def remote_args(peer):
            return ['-e', shlex.quote(str(rsh)), '--rsync-path=' + shlex.quote(str(peer))]

        if selected('listing') or selected('qsort') or selected('cvs'):
            for number, peer in enumerate((native, reference)):
                base = root / ('peer-' + str(number))
                base.mkdir()
                sender, receiver = base / 'sender', base / 'receiver'
                sender.mkdir()
                receiver.mkdir()
                for name in ('a', 'b'):
                    (sender / name).write_bytes(('sender-' + name).encode())
                    (receiver / name).write_bytes(('unchanged-receiver-sentinel-' + name).encode())
                before = inventory(receiver)
                common = remote_args(peer)
                if selected('listing'):
                    operands = ['fixture:' + str(sender / 'a'), ':' + str(sender / 'b')]
                    for flags, sources, names in (
                        ([], operands, (b'a', b'b')),
                        (['--list-only'], operands, (b'a', b'b')),
                        ([], operands[:1], (b'a',)),
                    ):
                        outcome = invoke(native, common + flags + sources, receiver, env)
                        code, out, err = outcome
                        require(code == 0 and all(listed(out, name) for name in names), outcome)
                        require(inventory(receiver) == before, ('listing mutated receiver', outcome))
                    for name in ('adir', 'bdir'):
                        (sender / name).mkdir()
                        (sender / name / 'child').write_bytes(b'synthetic nested')
                    operands = ['fixture:' + str(sender / 'adir'), ':' + str(sender / 'bdir')]
                    for flags in ([], ['--no-dirs']):
                        outcome = invoke(native, common + flags + operands, receiver, env)
                        code, out, err = outcome
                        require(inventory(receiver) == before, ('directory listing mutated receiver', outcome))
                        if not flags:
                            require(code == 0 and listed(out, b'adir') and listed(out, b'bdir'), outcome)
                        else:
                            expected = invoke(reference, common + flags + operands, receiver, env)
                            require(code == expected[0] and b'child' not in out,
                                    ('--no-dirs', outcome, expected))
                            require(inventory(receiver) == before, ('reference control mutated receiver', expected))
                    target = base / 'explicit-destination'
                    outcome = invoke(native, common + ['-r', 'fixture:' + str(sender) + '/', str(target)], receiver, env)
                    require(outcome[0] == 0 and inventory(target) == inventory(sender),
                            ('explicit destination control', outcome))
                if selected('qsort'):
                    for mode in ('ordinary', 'qsort'):
                        for direction in ('push', 'pull'):
                            target = base / (mode + '-' + direction)
                            operands = ([str(sender) + '/', 'fixture:' + str(target)] if direction == 'push'
                                        else ['fixture:' + str(sender) + '/', str(target)])
                            flags = ['--qsort'] if mode == 'qsort' else []
                            outcome = invoke(native, common + ['-r', *flags, *operands], base, env)
                            require(outcome[0] == 0, (mode, direction, peer, outcome))
                            require(inventory(target) == inventory(sender), (mode, direction, 'file mismatch'))
                if selected('cvs'):
                    cvs = base / 'cvs'
                    cvs.mkdir()
                    (cvs / 'a.o').write_bytes(b'legitimate object payload')
                    (cvs / 'b.c').write_bytes(b'ordinary source payload')
                    target = base / 'cvs-received'
                    outcome = invoke(native, common + ['-r', '--filter=-rC', 'fixture:' + str(cvs) + '/', str(target)], base, env)
                    require(outcome[0] == 0 and inventory(target) == inventory(cvs),
                            ('receiver CVS rejected sender names', outcome))

        source = root / 'empty-source'
        source.mkdir()
        if selected('maxdelete'):
            for index, limit in enumerate(('-2147483648', '-1', '0', '1', None)):
                target = root / ('delete-cap-' + str(index))
                target.mkdir()
                (target / 'extra').write_bytes(b'protected by explicit cap')
                option = [] if limit is None else ['--max-delete=' + limit]
                outcome = invoke(native, remote_args(native) + ['-r', '--delete-before', *option,
                                 str(source) + '/', 'fixture:' + str(target)], root, env)
                if limit in ('1', None):
                    require(outcome[0] == 0 and inventory(target) == {}, ('allowed deletion', limit, outcome))
                else:
                    require(inventory(target) == {b'extra': b'protected by explicit cap'} and outcome[0] == 25,
                            ('explicit deletion cap', limit, outcome))

        if selected('serverfilter'):
            cases = (
                ('receiver-protect', ['-M--filter=P keep'], True),
                ('client-protect', ['--filter=P keep'], True),
                ('client-before-delete-excluded', ['--filter=- keep', '--delete-excluded'], False),
                ('client-after-delete-excluded', ['--delete-excluded', '--filter=- keep'], False),
                ('server-before-delete-excluded', ['-M--filter=- keep', '-M--delete-excluded'], False),
                ('server-after-delete-excluded', ['-M--delete-excluded', '-M--filter=- keep'], False),
                ('explicit-protect-after-delete-excluded', ['--delete-excluded', '-M--filter=P keep'], True),
                ('sender-only', ['-M--filter=H keep'], False),
            )
            for remote in (False, True):
                for name, flags, keep in cases:
                    target = root / ('server-filter-' + str(remote) + '-' + name)
                    target.mkdir()
                    (target / 'keep').write_bytes(b'server-only protection')
                    (target / 'junk').write_bytes(b'delete control')
                    dest = 'fixture:' + str(target) if remote else str(target)
                    connection = remote_args(native) if remote else []
                    outcome = invoke(native, connection + ['-r', '--delete-before', *flags,
                                     str(source) + '/', dest], root, env)
                    expected = {b'keep': b'server-only protection'} if keep else {}
                    require(outcome[0] == 0 and inventory(target) == expected,
                            ('server filter application/order', remote, name, outcome, inventory(target)))
            for name, flags, keep in (
                ('pull-client-before-delete-excluded', ['--filter=- keep', '--delete-excluded'], False),
                ('pull-client-after-delete-excluded', ['--delete-excluded', '--filter=- keep'], False),
                ('pull-explicit-protect', ['--delete-excluded', '--filter=P keep'], True),
                ('pull-explicit-receiver-exclude', ['--delete-excluded', '--filter=-r keep'], True),
            ):
                target = root / name
                target.mkdir()
                (target / 'keep').write_bytes(b'client receiver protection')
                (target / 'junk').write_bytes(b'delete control')
                outcome = invoke(native, remote_args(native) + ['-r', '--delete-before', *flags,
                                 'fixture:' + str(source) + '/', str(target)], root, env)
                expected = {b'keep': b'client receiver protection'} if keep else {}
                require(outcome[0] == 0 and inventory(target) == expected,
                        ('client receiver global filter behavior', name, outcome, inventory(target)))

        if selected('iconv'):
            control = root / 'iconv-control'
            outcome = invoke(native, remote_args(native) + ['-r', '--iconv=UTF-8,UTF-8',
                             str(source) + '/', 'fixture:' + str(control)], root, env)
            require(outcome[0] == 0 and inventory(control) == {}, ('iconv capability control', outcome))
            for mode, flags in (('ordinary', []), ('secluded', ['-s']), ('environment', [])):
                for index, suffix in enumerate(('', ' space', ';suffix', "'quote", '"quote')):
                    marker = root / ('executed-' + mode + '-' + str(index))
                    payload = '$(printf executed > ' + shlex.quote(str(marker)) + ')' + suffix
                    injected_env = dict(env)
                    if mode == 'environment':
                        injected_env['RSYNC_PROTECT_ARGS'] = '1'
                    trace.unlink(missing_ok=True)
                    outcome = invoke(native, remote_args(native) + ['-r', *flags, '--iconv=UTF-8,' + payload,
                                     str(source) + '/', 'fixture:' + str(root / ('invalid-' + mode + '-' + str(index)))],
                                     root, injected_env)
                    require(trace.is_file(), ('did not reach offline remote shell', mode, suffix, outcome))
                    require(outcome[0] != 0, ('invalid charset accepted', mode, suffix, outcome))
                    require(not marker.exists(), ('remote charset executed shell syntax', mode, suffix, outcome))

        if selected('deletions'):
            deleted = root / 'latin1-deleted'
            deleted.mkdir()
            raw = os.fsencode(deleted)
            with open(os.path.join(raw, b'caf\xe9'), 'wb') as output:
                output.write(b'dry-run must retain this')
            os.mkdir(os.path.join(raw, b'dir\xe9'))
            before = inventory(deleted)
            outcome = invoke(native, remote_args(native) + ['-rni', '--delete', '--iconv=UTF-8,ISO-8859-1',
                             str(source) + '/', 'fixture:' + str(deleted)], root, env)
            code, out, err = outcome
            require(code == 0 and 'café'.encode() in out and 'diré/'.encode() in out,
                    ('deletion wire encoding', outcome))
            require(inventory(deleted) == before, ('dry-run deletion changed raw-byte fixture', outcome))


if __name__ == '__main__':
    main()
