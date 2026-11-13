#!/usr/bin/env python3
"""Reusable read-only verification wrapper (P0-17).

Usage:

    scripts/read_only_verify.py --scope <scope.json> -- <command> [args...]

The wrapper:

1. snapshots every file inside the scope's ``semanticMaterial`` and
   ``executionEnvironment`` includes (content digests + file set),
2. runs the command with a private $TMPDIR for build artifacts,
3. re-snapshots and fails if any in-scope file was created, modified, or
   deleted — attempted source mutation is reported as failure,
   ``SOURCE_MUTATED``.

Evidence/status paths are out of scope for the mutation check by design:
they are the evidence the verification produces.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _scope_paths(scope: dict, root: Path) -> list[Path]:
    paths: list[Path] = []
    for section in ("semanticMaterial", "executionEnvironment"):
        for include in (scope.get("scopes", {}).get(section, {}) or {}).get("includes", []):
            target = root / include
            if target.is_dir():
                paths.extend(
                    p for p in target.rglob("*")
                    if p.is_file() and "__pycache__" not in p.parts and ".pytest_cache" not in p.parts
                )
            elif target.is_file():
                paths.append(target)
    excludes = [
        root / e
        for section in ("semanticMaterial", "executionEnvironment")
        for e in (scope.get("scopes", {}).get(section, {}) or {}).get("excludes", [])
    ]
    def excluded(path: Path) -> bool:
        return any(
            path == ex or (ex.is_dir() and ex in path.parents) for ex in excludes
        )
    return sorted({p for p in paths if not excluded(p)})


def _snapshot(root: Path, scope: dict) -> dict:
    files = _scope_paths(scope, root)
    digests = {}
    for path in files:
        digests[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "fileCount": len(files),
        "digests": digests,
        "setDigest": hashlib.sha256(
            json.dumps(digests, sort_keys=True).encode()
        ).hexdigest(),
    }


def run_read_only(scope_path: Path, command: list[str], root: Path = ROOT) -> dict:
    scope = json.loads(scope_path.read_text(encoding="utf-8"))
    before = _snapshot(root, scope)
    with tempfile.TemporaryDirectory(prefix="ro-verify-") as tmp:
        env = dict(os.environ, TMPDIR=tmp)
        proc = subprocess.run(command, cwd=root, env=env)
        after = _snapshot(root, scope)
    created = sorted(set(after["digests"]) - set(before["digests"]))
    deleted = sorted(set(before["digests"]) - set(after["digests"]))
    modified = sorted(
        k for k in before["digests"].keys() & after["digests"].keys()
        if before["digests"][k] != after["digests"][k]
    )
    mutated = bool(created or deleted or modified)
    return {
        "schemaVersion": "document-intelligence.read-only-verify.v1",
        "command": command,
        "exitCode": proc.returncode,
        "sourceMutationCount": len(created) + len(deleted) + len(modified),
        "mutations": {"created": created, "deleted": deleted, "modified": modified},
        "status": "FAIL" if mutated or proc.returncode != 0 else "PASS",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER, help="after --")
    args = parser.parse_args(argv)
    command = [c for c in args.command if c != "--"]
    if not command:
        parser.error("no command given after --")
    result = run_read_only(args.scope, command)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
