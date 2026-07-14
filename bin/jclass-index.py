#!/usr/bin/env python3
"""Incremental class index builder for Maven JARs."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Iterable


def discover_jars(repository: Path) -> dict[str, list[int]]:
    jars: dict[str, list[int]] = {}
    for root, _, files in os.walk(repository):
        for name in files:
            if not name.endswith(".jar"):
                continue
            if name.endswith("-sources.jar") or name.endswith("-javadoc.jar"):
                continue
            path = Path(root, name)
            try:
                stat = path.stat()
            except OSError as error:
                print(f"Warning: cannot stat {path}: {error}", file=sys.stderr)
                continue
            jars[str(path)] = [stat.st_mtime_ns, stat.st_size]
    return jars


def load_manifest(path: Path) -> tuple[dict[str, list[int]], int | None]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return {}, None
    if not isinstance(data, dict) or not isinstance(data.get("jars"), dict):
        return {}, None
    count = data.get("class_count")
    return data["jars"], count if isinstance(count, int) else None


def scan_jar(path: str) -> tuple[str, list[str], str | None]:
    try:
        with zipfile.ZipFile(path) as jar:
            classes = [
                name
                for name in jar.namelist()
                if name.endswith(".class") and "$" not in name
            ]
        return path, classes, None
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        return path, [], str(error)


def copy_unchanged_rows(source: Path, target, changed_or_deleted: set[str]) -> int:
    kept = 0
    try:
        with source.open("r", encoding="utf-8", errors="surrogateescape") as old_index:
            for line in old_index:
                try:
                    _, jar_path = line.rstrip("\n").rsplit("\t", 1)
                except ValueError:
                    continue
                if jar_path not in changed_or_deleted:
                    target.write(line)
                    kept += 1
    except FileNotFoundError:
        pass
    return kept


def write_scanned_rows(paths: Iterable[str], target, workers: int) -> tuple[int, int]:
    added = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=workers) as executor:
        for jar_path, classes, error in executor.map(scan_jar, paths):
            if error is not None:
                failed += 1
                print(f"Warning: cannot index {jar_path}: {error}", file=sys.stderr)
                continue
            for class_path in classes:
                target.write(f"{class_path}\t{jar_path}\n")
            added += len(classes)
    return added, failed


def atomic_json_write(path: Path, jars: dict[str, list[int]], class_count: int) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(
                {"version": 1, "class_count": class_count, "jars": jars},
                output,
                separators=(",", ":"),
                sort_keys=True,
            )
            output.write("\n")
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def build_index(repository: Path, cache_dir: Path, rebuild: bool, workers: int) -> int:
    index_path = cache_dir / "index.tsv"
    manifest_path = cache_dir / "manifest.json"
    cache_dir.mkdir(parents=True, exist_ok=True)

    current = discover_jars(repository)
    previous, previous_count = ({}, None) if rebuild else load_manifest(manifest_path)
    can_increment = not rebuild and index_path.is_file() and manifest_path.is_file() and bool(previous)

    if can_increment:
        changed = {path for path, fingerprint in current.items() if previous.get(path) != fingerprint}
        deleted = set(previous) - set(current)
    else:
        changed = set(current)
        deleted = set(previous)

    print(f"  JARs: {len(current)}", file=sys.stderr)
    print(f"  Workers: {workers}", file=sys.stderr)
    if can_increment:
        print(f"  Changes: {len(changed)} updated/new, {len(deleted)} deleted", file=sys.stderr)

    if can_increment and not changed and not deleted:
        count = previous_count
        if count is None:
            count = sum(1 for _ in index_path.open("rb"))
        print(f"Up to date: {count} classes → {index_path}", file=sys.stderr)
        print(count)
        return 0

    fd, temp_name = tempfile.mkstemp(prefix="index.tsv.", suffix=".tmp", dir=cache_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape") as output:
            kept = copy_unchanged_rows(index_path, output, changed | deleted) if can_increment else 0
            added, failed = write_scanned_rows(sorted(changed), output, workers)
        os.replace(temp_name, index_path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise

    count = kept + added
    atomic_json_write(manifest_path, current, count)
    mode = "Updated" if can_increment else "Built"
    print(
        f"{mode}: {count} classes ({kept} kept, {added} indexed, {failed} JARs failed) → {index_path}",
        file=sys.stderr,
    )
    print(count)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 8)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    if not args.repository.is_dir():
        print(f"Maven repository not found: {args.repository}", file=sys.stderr)
        return 1
    return build_index(args.repository, args.cache_dir, args.rebuild, max(1, args.workers))


if __name__ == "__main__":
    raise SystemExit(main())
