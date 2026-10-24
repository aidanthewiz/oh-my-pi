import io
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

EXTRACTOR = Path(__file__).with_name("extract_llvm.py")
PREFIX = "LLVM-test"
TOOL = b"#!/bin/sh\nexit 0\n"
HEADER = b"#define LLVM_FIXTURE 42\n"


def member(name, body=b"", mode=0o644, kind=tarfile.REGTYPE, link=""):
    info = tarfile.TarInfo(PREFIX + "/" + name)
    info.type = kind
    info.linkname = link
    info.mode = mode
    info.size = len(body) if kind == tarfile.REGTYPE else 0
    return info, body


class ExtractLlvmTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="llvm-extract-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def extract(self, entries):
        archive = self.root / "llvm.tar.xz"
        with tarfile.open(archive, "w:xz") as output:
            for info, body in entries:
                output.addfile(info, io.BytesIO(body) if info.isfile() else None)
        destination = self.root / "output"
        destination.mkdir()
        result = subprocess.run(
            [sys.executable, str(EXTRACTOR), str(archive), PREFIX, "clang-cl"],
            check=False,
            cwd=destination,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result, destination

    def base_entries(self):
        return [
            member("bin/clang-cl", kind=tarfile.SYMTYPE, link="clang"),
            member("bin/clang", kind=tarfile.LNKTYPE, link=PREFIX + "/bin/clang-20"),
            member("bin/clang-20", TOOL, 0o755),
            member("lib/clang/20/include/stddef.h", HEADER),
        ]

    def test_preserves_forward_link_closure_and_omits_unselected_payloads(self):
        entries = self.base_entries() + [
            member("lib/libLLVM.so", kind=tarfile.SYMTYPE, link="libLLVM.so.20"),
            member("lib/libLLVM.so.20", b"shared runtime"),
            member("lib/libUnused.a", b"static library not consumed"),
            member("bin/unselected", b"not a selected tool", 0o755),
        ]
        result, output = self.extract(entries)
        self.assertEqual(result.returncode, 0, result.stderr)
        files = {
            path.relative_to(output).as_posix()
            for path in output.rglob("*")
            if path.is_file() or path.is_symlink()
        }
        self.assertEqual(
            files,
            {
                "bin/clang-cl",
                "bin/clang",
                "bin/clang-20",
                "lib/clang/20/include/stddef.h",
                "lib/libLLVM.so",
                "lib/libLLVM.so.20",
            },
        )
        self.assertEqual((output / "bin/clang-cl").read_bytes(), TOOL)
        self.assertEqual(
            (output / "bin/clang").stat().st_ino,
            (output / "bin/clang-20").stat().st_ino,
        )
        self.assertEqual((output / "bin/clang-20").stat().st_mode & 0o777, 0o755)
        self.assertEqual((output / "lib/libLLVM.so").read_bytes(), b"shared runtime")

    def test_preserves_linked_builtin_header_directory(self):
        entries = [
            entry
            for entry in self.base_entries()
            if not entry[0].name.endswith("/include/stddef.h")
        ]
        entries += [
            member(
                "lib/clang/20/include", kind=tarfile.SYMTYPE, link="../../../headers"
            ),
            member("headers", kind=tarfile.DIRTYPE),
            member("headers/stddef.h", HEADER),
        ]
        result, output = self.extract(entries)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((output / "lib/clang/20/include").is_symlink())
        self.assertEqual(
            (output / "lib/clang/20/include/stddef.h").read_bytes(), HEADER
        )

    def test_rejects_unsafe_paths_and_link_targets_without_partial_output(self):
        variants = {
            "traversal": member("../escape", b"outside"),
            "wrong-prefix": (tarfile.TarInfo("other/file"), b""),
            "absolute": (tarfile.TarInfo("/escape"), b""),
            "special-file": member("fifo", kind=tarfile.FIFOTYPE),
        }
        for name, extra in variants.items():
            with (
                self.subTest(name=name),
                tempfile.TemporaryDirectory(dir=self.root) as directory,
            ):
                prior = self.root
                self.root = Path(directory)
                try:
                    result, output = self.extract(self.base_entries() + [extra])
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(list(output.iterdir()), [])
                    self.assertFalse((self.root / "escape").exists())
                finally:
                    self.root = prior
        for target in ["../../escape", "/escape", "missing", "clang-cl"]:
            with (
                self.subTest(target=target),
                tempfile.TemporaryDirectory(dir=self.root) as directory,
            ):
                prior = self.root
                self.root = Path(directory)
                try:
                    entries = self.base_entries()
                    entries[0] = member(
                        "bin/clang-cl", kind=tarfile.SYMTYPE, link=target
                    )
                    result, output = self.extract(entries)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(list(output.iterdir()), [])
                finally:
                    self.root = prior


if __name__ == "__main__":
    unittest.main()
