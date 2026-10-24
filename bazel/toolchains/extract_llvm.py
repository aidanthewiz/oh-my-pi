#!/usr/bin/env python3
"""Extract selected LLVM tools, their link targets, headers and shared libraries.

Usage: extract_llvm.py <archive.tar.xz> <archive-prefix> <bin-name>...
The SHA-256-verified archive comes from repository_ctx.download. Two streaming
passes read metadata, then copy only selected payloads; no full tree is staged.
"""

import os
import posixpath
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path


def _relative(name, prefix):
    name = name.removeprefix("./").rstrip("/")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts) or "\\" in name:
        raise ValueError("unsafe archive path: " + name)
    if parts[0] != prefix:
        raise ValueError("unexpected archive prefix: " + name)
    return "/".join(parts[1:])


def _target(name, member, prefix):
    link = member.linkname
    if not link or link.startswith("/") or "\\" in link:
        raise ValueError("unsafe link: " + member.name)
    if member.issym():
        target = posixpath.normpath(posixpath.join(posixpath.dirname(name), link))
        if target == ".." or target.startswith("../"):
            raise ValueError("escaping link: " + member.name)
        return target
    return _relative(link, prefix)


def _header(name):
    parts = name.split("/")
    return len(parts) >= 4 and parts[:2] == ["lib", "clang"] and parts[3] == "include"


def _shared_library(name):
    parts = name.split("/")
    return parts[0] in ("bin", "lib", "lib64") and (
        parts[-1].endswith((".so", ".dylib")) or ".so." in parts[-1]
    )


def _selection(members, bins, prefix):
    selected = {"bin/" + name for name in bins}
    selected.update(name for name in members if _header(name) or _shared_library(name))
    if not any(_header(name) for name in members):
        raise ValueError("archive has no Clang builtin headers")
    pending = list(selected)
    while pending:
        name = pending.pop()
        member = members.get(name)
        if member is None:
            raise ValueError("missing required archive member: " + name)
        additions = []
        if member.issym() or member.islnk():
            additions.append(_target(name, member, prefix))
        elif member.isdir():
            additions.extend(child for child in members if child.startswith(name + "/"))
        parent = posixpath.dirname(name)
        while parent:
            ancestor = members.get(parent)
            if ancestor is not None and not ancestor.isdir():
                raise ValueError("non-directory archive ancestor: " + parent)
            parent = posixpath.dirname(parent)
        for target in additions:
            if target not in selected:
                selected.add(target)
                pending.append(target)
    for name in selected:
        seen = set()
        target = name
        while members[target].issym() or members[target].islnk():
            if target in seen:
                raise ValueError("cyclic archive link: " + name)
            seen.add(target)
            target = _target(target, members[target], prefix)
    return selected


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    archive, prefix, *bins = argv
    if "/" in prefix or prefix in ("", ".", ".."):
        raise ValueError("invalid archive prefix")
    if any("/" in name or "\\" in name or name in ("", ".", "..") for name in bins):
        raise ValueError("invalid tool name")
    members = {}
    with tarfile.open(archive, "r|xz") as source:
        for member in source:
            name = _relative(member.name, prefix)
            if not name:
                if not member.isdir():
                    raise ValueError("archive root is not a directory")
                continue
            if name in members:
                raise ValueError("duplicate archive member: " + name)
            if not (
                member.isfile() or member.isdir() or member.issym() or member.islnk()
            ):
                raise ValueError("unsupported archive member: " + name)
            members[name] = member
    selected = _selection(members, bins, prefix)
    selected_bytes = sum(
        members[name].size for name in selected if members[name].isfile()
    )
    archive_bytes = sum(member.size for member in members.values() if member.isfile())
    print(
        f"LLVM extraction: {selected_bytes} selected bytes of {archive_bytes} archive payload bytes",
        flush=True,
    )
    with tempfile.TemporaryDirectory(prefix=".llvm-extract-", dir=".") as temporary:
        root = Path(temporary)
        with tarfile.open(archive, "r|xz") as source:
            for member in source:
                name = _relative(member.name, prefix)
                if name not in selected or not member.isfile():
                    continue
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as data, path.open("xb") as output:
                    shutil.copyfileobj(data, output, length=1 << 20)
                path.chmod(member.mode & 0o777)
        for name in selected:
            if members[name].isdir():
                (root / name).mkdir(parents=True, exist_ok=True)
        # Hardlinks can precede their targets in the archive. Create them only
        # after regular payloads, resolving chains to the final regular file.
        for name in sorted(selected):
            member = members[name]
            if not member.islnk():
                continue
            target = _target(name, member, prefix)
            while members[target].issym() or members[target].islnk():
                target = _target(target, members[target], prefix)
            if not members[target].isfile():
                raise ValueError("hardlink target is not a file: " + name)
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            os.link(root / target, path)
        # No archive symlink exists while files or directories are written.
        for name in sorted(selected):
            member = members[name]
            if member.issym():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(member.linkname)
        for name in bins:
            tool = root / "bin" / name
            if not tool.is_file() or not os.access(tool, os.X_OK):
                raise ValueError("required tool is not executable: " + name)
        for child in root.iterdir():
            child.rename(Path.cwd() / child.name)


if __name__ == "__main__":
    main(sys.argv[1:])
