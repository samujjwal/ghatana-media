#!/usr/bin/env python3
"""Reproducible package builder + digest receipt (I6-29).

Given a list of package entries (file path + optional version) and a
caller-supplied ``--built-at`` timestamp, emits
``deployment/sbom/package-receipt.v1.json``:

- ``entries[]`` records each file's root-relative path, content sha256, byte
  count, and declared version;
- ``packageFingerprint`` is ``sha256:`` of the canonical JSON of the sorted
  ``(path, sha256)`` pairs — two runs over identical inputs produce an
  identical fingerprint regardless of ordering or ``builtAt``;
- ``pythonRuntime`` records the interpreter version and the uv.lock digest;
- ``builtAt`` is a deterministic input supplied by the caller, never read
  from the wall clock, so receipts are reproducible;
- ``contentAddressed`` and ``buildReproducibility`` state the two separate
  packaging guarantees; an immutable digest is not evidence of a
  byte-reproducible build;
- ``receiptFingerprint`` covers the document with that field omitted
  (omitted-field convention, same as run-publication manifests).

Optionally ``--tar-out`` writes a deterministic tar archive (entries sorted
by path, mtime=0, uid/gid=0, blank uname/gname) and records ``tarSha256``.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

RECEIPT_SCHEMA = "document-intelligence.package-receipt.v1"
RECEIPT_PRODUCER_VERSION = "document-intelligence.package-builder/1"
REPRODUCIBILITY_STATES = frozenset({"VERIFIED", "NOT_VERIFIED", "NOT_SUPPORTED"})


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _fingerprint(value) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _parse_entry(raw: str) -> tuple[str, str | None]:
    if "=" in raw:
        path, version = raw.rsplit("=", 1)
        return path, version or None
    return raw, None


def build_receipt(
    root: Path,
    entries: list[tuple[str, str | None]],
    built_at: str,
    *,
    build_reproducibility: str = "NOT_VERIFIED",
) -> dict:
    if build_reproducibility not in REPRODUCIBILITY_STATES:
        raise ValueError(f"invalid build reproducibility declaration: {build_reproducibility}")
    records = []
    for rel, version in entries:
        target = root / rel
        if not target.is_file():
            raise ValueError(f"package entry missing: {rel}")
        record = {
            "path": rel,
            "sha256": _sha256_file(target),
            "bytes": target.stat().st_size,
        }
        if version is not None:
            record["version"] = version
        records.append(record)
    records.sort(key=lambda r: r["path"])
    pairs = [[r["path"], r["sha256"]] for r in records]

    python_runtime = {"version": platform.python_version()}
    uv_lock = root / "uv.lock"
    if uv_lock.is_file():
        python_runtime["uvLockSha256"] = _sha256_file(uv_lock)

    receipt = {
        "schemaVersion": RECEIPT_SCHEMA,
        "producerVersion": RECEIPT_PRODUCER_VERSION,
        "packageFingerprint": _fingerprint(pairs),
        "entries": records,
        "pythonRuntime": python_runtime,
        "builtAt": built_at,
        # Content addressing is a property of this receipt: every package
        # entry and the optional tar are identified by immutable digests.
        # Byte reproducibility is deliberately declared independently.
        "contentAddressed": True,
        "buildReproducibility": build_reproducibility,
    }
    return receipt


def build_tar(root: Path, entries: list[dict], tar_path: Path) -> str:
    """Deterministic tar: sorted entries, zeroed metadata."""
    tar_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = tar_path.with_name(tar_path.name + f".{os.getpid()}.tmp")
    hasher = hashlib.sha256()
    with open(tmp, "wb") as raw:
        with tarfile.open(fileobj=raw, mode="w") as tar:
            for record in sorted(entries, key=lambda r: r["path"]):
                data = (root / record["path"]).read_bytes()
                info = tarfile.TarInfo(record["path"])
                info.size = len(data)
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(data))
    hasher.update(tmp.read_bytes())
    tmp.replace(tar_path)
    return "sha256:" + hasher.hexdigest()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument(
        "--entry", action="append", required=True,
        help="package entry as path or path=version (repeatable, relative to --root)",
    )
    parser.add_argument(
        "--built-at", required=True,
        help="deterministic ISO-8601 timestamp supplied by the caller",
    )
    parser.add_argument(
        "--build-reproducibility",
        choices=sorted(REPRODUCIBILITY_STATES),
        default="NOT_VERIFIED",
        help="explicit byte-reproducibility declaration for this package",
    )
    parser.add_argument(
        "--output", type=Path, default=None,
        help="receipt output (default: <root>/deployment/sbom/package-receipt.v1.json)",
    )
    parser.add_argument("--tar-out", type=Path, default=None, help="optional deterministic tar path")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    output = args.output or root / "deployment/sbom/package-receipt.v1.json"
    entries = [_parse_entry(raw) for raw in args.entry]

    try:
        receipt = build_receipt(
            root,
            entries,
            args.built_at,
            build_reproducibility=args.build_reproducibility,
        )
    except ValueError as exc:
        print(json.dumps({"package": "FAIL", "errors": [str(exc)]}, indent=2))
        return 2

    if args.tar_out:
        receipt["tarSha256"] = build_tar(root, receipt["entries"], args.tar_out)
        receipt["tarPath"] = str(args.tar_out)

    receipt["receiptFingerprint"] = _fingerprint(
        {k: v for k, v in receipt.items() if k != "receiptFingerprint"}
    )
    _atomic_write(output, json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(
        json.dumps(
            {
                "package": "DECLARED",
                "receipt": str(output),
                "packageFingerprint": receipt["packageFingerprint"],
                "entries": len(receipt["entries"]),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
