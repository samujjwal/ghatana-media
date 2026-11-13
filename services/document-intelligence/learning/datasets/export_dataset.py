"""Governed dataset export (I5-39).

Copies a completed dataset revision verbatim — preserving datasetFingerprint —
into an export root and writes an ``export-manifest.json`` binding the
fingerprint, tenantScope, authorization reference, redaction policy, and full
provenance lineage:

    <source>/<datasetId>/r<revision>/manifest.json (+ train/eval + .complete)
    -> <export-root>/<datasetId>/r<revision>/{manifest.json,train.jsonl,eval.jsonl,.complete,export-manifest.json}

Scope rules (fail closed):

- SYNTHETIC_PUBLIC exports freely and still records provenance.
- TENANT_LOCAL requires an explicit --authorization-ref.
- MULTI_TENANT_EXPLICITLY_AUTHORIZED requires the source manifest's own
  scopeAuthorizationRef AND an explicit --authorization-ref.

v1 manifests (pre-scope) are treated as TENANT_LOCAL.

Import (``import_dataset``) verifies an export before it lands under a local
dataset root: every recorded file digest must match, the dataset manifest must
validate against its own declared schema version and recompute its
datasetFingerprint, and the export's tenant scope must agree with the
manifest's. Any fingerprint/schema/scope conflict is rejected — nothing is
imported, existing revisions are never overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from learning.tenant_scope import (  # noqa: E402
    MULTI_TENANT,
    SYNTHETIC_PUBLIC,
    TENANT_LOCAL,
    TenantScopeError,
)
from learning.util import atomic_write_json, digest, load_json  # noqa: E402

EXPORT_SCHEMA_VERSION = "document-intelligence.dataset-export.v1"
EXPORTER_VERSION = "learning.dataset-exporter.v1"
DEFAULT_REDACTION_POLICY = "org.learning-redaction.minimized-at-projection.v1"
# Files copied verbatim into the export; anything else in the revision dir is
# deliberately not exported (artifacts travel only with their fingerprints).
DATASET_FILES = ("manifest.json", "train.jsonl", "eval.jsonl", ".complete")


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def export_dataset(
    revision_dir: Path,
    export_root: Path,
    *,
    authorization_ref: str | None = None,
    redaction_policy: str = DEFAULT_REDACTION_POLICY,
    exported_at: str,
) -> dict:
    revision_dir = Path(revision_dir)
    manifest_path = revision_dir / "manifest.json"
    if not (revision_dir / ".complete").exists():
        raise ValueError(f"refusing to export an incomplete dataset revision: {revision_dir}")
    if not manifest_path.exists():
        raise ValueError(f"dataset revision has no manifest: {revision_dir}")
    manifest = load_json(manifest_path)
    scope = manifest.get("tenantScope", TENANT_LOCAL)
    if scope != SYNTHETIC_PUBLIC:
        if not authorization_ref:
            raise TenantScopeError(
                f"export of a {scope} dataset requires an explicit authorization ref"
            )
        if scope == MULTI_TENANT and not manifest.get("scopeAuthorizationRef"):
            raise TenantScopeError(
                "MULTI_TENANT_EXPLICITLY_AUTHORIZED dataset lacks scopeAuthorizationRef"
            )

    dataset_id = manifest["datasetId"]
    revision = manifest["datasetRevision"]
    target = Path(export_root) / dataset_id / f"r{revision}"
    if (target / "export-manifest.json").exists():
        raise ValueError(f"export already exists: {target}")
    target.mkdir(parents=True, exist_ok=False)

    files: dict[str, str] = {}
    for name in DATASET_FILES:
        source = revision_dir / name
        if not source.exists():
            raise ValueError(f"dataset revision missing {name}: {revision_dir}")
        destination = target / name
        shutil.copyfile(source, destination)
        files[name] = f"sha256:{_sha256_file(destination)}"

    export_manifest = {
        "schemaVersion": EXPORT_SCHEMA_VERSION,
        "exporter": {"version": EXPORTER_VERSION},
        "datasetId": dataset_id,
        "datasetRevision": revision,
        "datasetFingerprint": manifest["datasetFingerprint"],
        "tenantScope": scope,
        **({"tenantRef": manifest["tenantRef"]} if manifest.get("tenantRef") else {}),
        **(
            {"scopeAuthorizationRef": manifest["scopeAuthorizationRef"]}
            if manifest.get("scopeAuthorizationRef")
            else {}
        ),
        "redactionPolicy": redaction_policy,
        "exportedAt": exported_at,
        **({"exportAuthorizationRef": authorization_ref} if authorization_ref else {}),
        "provenance": {
            "sourceRevisionDir": str(revision_dir),
            "manifestFingerprint": digest(manifest),
            "files": files,
        },
    }
    export_manifest["exportFingerprint"] = digest(export_manifest)
    atomic_write_json(target / "export-manifest.json", export_manifest)
    return export_manifest


_DATASET_SCHEMA_BY_VERSION = {
    "document-intelligence.dataset-manifest.v1": "dataset-manifest.v1.schema.json",
    "document-intelligence.dataset-manifest.v2": "dataset-manifest.v2.schema.json",
}


def verify_export(export_dir: Path) -> dict:
    """Validate an export directory; returns the export manifest on success."""
    from learning.util import validate

    export_dir = Path(export_dir)
    export_manifest_path = export_dir / "export-manifest.json"
    if not export_manifest_path.exists():
        raise ValueError(f"not an export directory (no export-manifest.json): {export_dir}")
    export_manifest = load_json(export_manifest_path)
    body = {k: v for k, v in export_manifest.items() if k != "exportFingerprint"}
    if digest(body) != export_manifest.get("exportFingerprint"):
        raise ValueError("export manifest fingerprint mismatch — tampered export")

    recorded = export_manifest.get("provenance", {}).get("files", {})
    for name in DATASET_FILES:
        path = export_dir / name
        if not path.exists():
            raise ValueError(f"export missing file {name}")
        if recorded.get(name) != f"sha256:{_sha256_file(path)}":
            raise ValueError(f"export file digest mismatch: {name}")

    manifest = load_json(export_dir / "manifest.json")
    schema = _DATASET_SCHEMA_BY_VERSION.get(manifest.get("schemaVersion"))
    if schema is None:
        raise ValueError(
            f"unknown dataset manifest schemaVersion {manifest.get('schemaVersion')!r}"
        )
    validate(manifest, schema)
    body = {k: v for k, v in manifest.items() if k != "datasetFingerprint"}
    if digest(body) != manifest.get("datasetFingerprint"):
        raise ValueError("dataset manifest fingerprint mismatch — tampered export")
    if manifest["datasetFingerprint"] != export_manifest.get("datasetFingerprint"):
        raise ValueError("export fingerprint does not match the dataset manifest")
    scope = manifest.get("tenantScope", TENANT_LOCAL)
    if scope != export_manifest.get("tenantScope", TENANT_LOCAL):
        raise TenantScopeError(
            f"scope conflict: export declares {export_manifest.get('tenantScope')!r} "
            f"but the dataset manifest declares {scope!r}"
        )
    return export_manifest


def import_dataset(export_dir: Path, out_root: Path) -> dict:
    """Import a verified export into a local dataset root (append-only).

    Writes ``<out_root>/<datasetId>/r<revision>/`` verbatim. Refuses when the
    revision already exists — imports never overwrite completed revisions.
    """
    export_manifest = verify_export(export_dir)
    export_dir = Path(export_dir)
    dataset_id = export_manifest["datasetId"]
    revision = export_manifest["datasetRevision"]
    target = Path(out_root) / dataset_id / f"r{revision}"
    if target.exists():
        raise ValueError(f"dataset revision already exists: {target}")
    target.mkdir(parents=True)
    for name in DATASET_FILES:
        shutil.copyfile(export_dir / name, target / name)
    return load_json(target / "manifest.json")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision-dir", type=Path,
                        help="completed <out>/<datasetId>/r<revision> directory")
    parser.add_argument("--export-root", type=Path)
    parser.add_argument("--authorization-ref", default=None)
    parser.add_argument("--redaction-policy", default=DEFAULT_REDACTION_POLICY)
    parser.add_argument("--exported-at")
    parser.add_argument(
        "--import-dir",
        type=Path,
        help="verify + import an export directory instead of exporting",
    )
    parser.add_argument("--out", type=Path, help="dataset root for --import-dir")
    args = parser.parse_args(argv)
    if args.import_dir is not None:
        if args.out is None:
            parser.error("--import-dir requires --out")
        manifest = import_dataset(args.import_dir, args.out)
        print(json.dumps({"datasetFingerprint": manifest["datasetFingerprint"], "imported": True}, indent=2))
        return 0
    if args.revision_dir is None or args.export_root is None:
        parser.error("export requires --revision-dir and --export-root")
    if args.exported_at is None:
        parser.error("export requires --exported-at")
    manifest = export_dataset(
        args.revision_dir,
        args.export_root,
        authorization_ref=args.authorization_ref,
        redaction_policy=args.redaction_policy,
        exported_at=args.exported_at,
    )
    print(json.dumps({"exportFingerprint": manifest["exportFingerprint"], "datasetFingerprint": manifest["datasetFingerprint"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
