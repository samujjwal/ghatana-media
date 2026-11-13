#!/usr/bin/env python3
"""Crash-safe publication manifests for canonical evaluation run directories.

Every authoritative run directory carries a ``run-manifest.json`` written
after all artifacts are complete:

- ``status: COMPLETE`` is emitted only once every required artifact and its
  digest are recorded;
- ``--check`` re-reads the directory and verifies every file is listed, every
  digest matches, and every required artifact is present;
- a directory without a COMPLETE manifest is unpublished and must not feed
  authority — a mid-write crash therefore leaves debris, not a partial run
  that looks authoritative.

Manifest writes go through a temporary file + atomic rename.  Once a
manifest says COMPLETE the directory is immutable; a subsequent attempt must
use a new run id.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_NAME = "run-manifest.json"
RUNNING_MARKER = "RUNNING"
MANIFEST_SCHEMA = "document-intelligence.run-publication.v1"

RUNS = {
    "increment3.authority": {
        "dir": ROOT / "evaluation/results/20260919T022904Z-cf9e659f",
        "required": ["summary.json", "capabilities.json", "lineage.json"],
    },
    "increment3.canonical": {
        "dir": ROOT / "evaluation/results/20260922T001622Z-26884d8e",
        "required": ["summary.json", "capabilities.json"],
    },
    "increment4a.canonical": {
        "dir": ROOT / "evaluation/increment4a/results/20260922T071420Z",
        "required": [
            "summary.json",
            "capabilities.json",
            "lineage.json",
            "observations.json",
            "raw-observations.json",
            "raw-observation-artifacts.json",
        ],
    },
}

PUBLICATION_CONTRACT = (
    "status COMPLETE is written only after every required artifact digest is "
    "recorded; a run directory without a COMPLETE manifest is unpublished and "
    "may not feed authority."
)


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _iter_files(run_dir: Path) -> list[Path]:
    return sorted(
        item
        for item in run_dir.rglob("*")
        if item.is_file() and item.name not in {MANIFEST_NAME, RUNNING_MARKER}
    )


def begin_run(run_dir: Path, run_id: str) -> Path:
    """Write the RUNNING marker before any artifact lands (P0-07).

    A directory holding RUNNING but no COMPLETE manifest is an unfinished run:
    verifiers reject it and no consumer may treat it as evidence.
    """
    if (run_dir / MANIFEST_NAME).is_file():
        raise ValueError(f"run already published: {run_dir}")
    run_dir.mkdir(parents=True, exist_ok=True)
    marker = run_dir / RUNNING_MARKER
    if not marker.exists():
        tmp = marker.with_name(marker.name + ".tmp")
        tmp.write_text(
            json.dumps(
                {
                    "schemaVersion": MANIFEST_SCHEMA,
                    "runId": run_id,
                    "status": "RUNNING",
                    "pid": os.getpid(),
                    "startedAt": datetime.now(timezone.utc)
                    .isoformat(timespec="seconds")
                    .replace("+00:00", "Z"),
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        tmp.replace(marker)
    return marker


def build_manifest(name: str, spec: dict) -> dict:
    run_dir: Path = spec["dir"]
    artifacts = {
        str(item.relative_to(run_dir)): f"sha256:{_sha256_file(item)}"
        for item in _iter_files(run_dir)
    }
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA,
        "run": name,
        "runDir": str(run_dir.relative_to(ROOT)),
        "status": "COMPLETE",
        "sealedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "requiredArtifacts": list(spec["required"]),
        "artifacts": artifacts,
        "fileCount": len(artifacts),
        "publicationContract": PUBLICATION_CONTRACT,
    }
    manifest["manifestFingerprint"] = "sha256:" + hashlib.sha256(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return manifest


def check_run(name: str, spec: dict) -> dict:
    run_dir: Path = spec["dir"]
    manifest_path = run_dir / MANIFEST_NAME
    errors: list[str] = []
    if not run_dir.is_dir():
        return {"run": name, "status": "FAIL", "errors": [f"run dir missing: {run_dir}"]}
    if (run_dir / RUNNING_MARKER).is_file():
        errors.append("RUNNING marker present — run is unfinished and is not evidence")
    if not manifest_path.is_file():
        errors.append("run manifest missing — directory is unpublished")
        return {"run": name, "status": "FAIL", "errors": errors}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"run": name, "status": "FAIL", "errors": [f"manifest invalid json: {exc}"]}
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA:
        errors.append("manifest schemaVersion mismatch")
    if manifest.get("status") != "COMPLETE":
        errors.append(f"manifest status is {manifest.get('status')!r}, not COMPLETE")
    artifacts = manifest.get("artifacts") or {}
    for required in spec["required"]:
        if not (run_dir / required).is_file():
            errors.append(f"required artifact missing: {required}")
        elif required not in artifacts:
            errors.append(f"required artifact not digested: {required}")
    recorded = set(artifacts)
    on_disk = {str(item.relative_to(run_dir)) for item in _iter_files(run_dir)}
    for unexpected in sorted(on_disk - recorded):
        errors.append(f"file present but not digested: {unexpected}")
    for missing in sorted(recorded - on_disk):
        errors.append(f"digested artifact missing on disk: {missing}")
    for relative, digest in artifacts.items():
        target = run_dir / relative
        if target.is_file() and f"sha256:{_sha256_file(target)}" != digest:
            errors.append(f"digest drift: {relative}")
    return {
        "run": name,
        "runDir": str(run_dir.relative_to(ROOT)),
        "status": "FAIL" if errors else "PASS",
        "errors": errors,
        "manifestSha256": f"sha256:{_sha256_file(manifest_path)}" if manifest_path.is_file() else None,
    }


def check() -> dict:
    runs = {name: check_run(name, spec) for name, spec in RUNS.items()}
    failing = [name for name, result in runs.items() if result["status"] != "PASS"]
    return {
        "runPublication": "FAIL" if failing else "PASS",
        "failingRuns": failing,
        "runs": runs,
    }


def build() -> dict:
    written: dict[str, str] = {}
    for name, spec in RUNS.items():
        run_dir: Path = spec["dir"]
        if not run_dir.is_dir():
            return {"runPublication": "FAIL", "errors": [f"run dir missing: {run_dir}"]}
        missing = [item for item in spec["required"] if not (run_dir / item).is_file()]
        if missing:
            return {"runPublication": "FAIL", "errors": [f"{name}: required artifacts missing: {missing}"]}
        manifest = build_manifest(name, spec)
        manifest_path = run_dir / MANIFEST_NAME
        text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        if manifest_path.exists():
            # P0-07: a completed run is never overwritten. Identical rebuild is
            # a no-op; divergent rebuild is a hard failure requiring a new run id.
            try:
                existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                existing = None
            if existing is not None and existing.get("status") == "COMPLETE":
                comparable = dict(existing)
                comparable.pop("sealedAt", None)
                comparable.pop("manifestFingerprint", None)
                proposed = dict(manifest)
                proposed.pop("sealedAt", None)
                proposed.pop("manifestFingerprint", None)
                if comparable == proposed:
                    written[name] = str(manifest_path)
                    continue
                return {
                    "runPublication": "FAIL",
                    "errors": [f"{name}: completed run manifest would be overwritten — use a new run id"],
                }
        tmp = manifest_path.with_name(manifest_path.name + f".{os.getpid()}.tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(manifest_path)
        marker = run_dir / RUNNING_MARKER
        if marker.exists():
            marker.unlink()
        written[name] = str(manifest_path)
    return {"runPublication": "DECLARED", "manifests": written}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="read-only verification; writes nothing")
    args = parser.parse_args()
    if args.check:
        result = check()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["runPublication"] == "PASS" else 2
    result = build()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["runPublication"] == "DECLARED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
