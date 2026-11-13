#!/usr/bin/env python3
"""Provider/runtime source-stability marker for the freeze program.

Declares ``PROVIDER_RUNTIME_CODE_STABLE`` once, then verifies that none of the
protected provider/runtime authorities drift afterwards.  Once this marker
exists, any change to the protected source sets — the whole
``src/document_intelligence`` tree (providers, mapping, strategies, runtime,
lifecycle, config, contracts, operations, profile, health, observability,
errors, limits, package root), the TypeScript client, routing and profile
configuration, model manifests/assets, accepted-capability authority, or
runtime dependencies — invalidates the marker and routes back through the
affected Increment-3/4A leaves instead of silently surviving a freeze.

Default mode (re)writes ``docs/evidence/provider-runtime-stability.json``.
``--check`` is read-only: it recomputes every bound fingerprint and reports
PASS only while the marker still matches the live tree.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_DIR = ROOT / "docs/evidence"
MARKER_PATH = EVIDENCE_DIR / "provider-runtime-stability.json"
MARKER_SCHEMA = "document-intelligence.provider-runtime-stability.v1"

sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "evaluation" / "increment4a"))

import build_material_snapshot as snapshot  # noqa: E402
from implementation_material import implementation_fingerprints  # noqa: E402

INCREMENT3_PROVIDER_AUTHORITY = ROOT / "evaluation/results/20260919T022904Z-cf9e659f/capabilities.json"
INCREMENT4A_RUNTIME_AUTHORITY = ROOT / "capabilities/increment4a.runtime-authority.json"
INCREMENT4A_ACCEPTED = ROOT / "capabilities/increment4a.accepted.json"
INCREMENT3_MODEL_MANIFEST = ROOT / "models/model-manifest.yaml"
INCREMENT4A_MODEL_MANIFEST = ROOT / "models/increment4a/model-manifest.yaml"
INCREMENT4A_MODEL_REPORT = ROOT / "models/increment4a/model-verification.json"

PROTECTED_SOURCE_PATHS = [
    "src/document_intelligence/",
    "clients/typescript/",
    "routing/",
    "profiles/",
    "models/",
    "capabilities/increment4a.accepted.json",
    "capabilities/increment4a.runtime-authority.json",
    "uv.lock",
    "pyproject.toml",
]

INVALIDATION_CONTRACT = (
    "After providerRuntimeState=STABLE, any change under protectedSourcePaths "
    "changes a bound fingerprint, marks this receipt STALE under --check, and "
    "routes back through the affected Increment-3/4A leaves; it never "
    "auto-repairs frozen evidence."
)


def _sha_or_missing(path: Path) -> str | None:
    return snapshot.sha256_file(path) if path.is_file() else None


def compute_fingerprints() -> dict[str, object]:
    impl = implementation_fingerprints(ROOT)
    i4a_report_sha = _sha_or_missing(INCREMENT4A_MODEL_REPORT)
    return {
        "canonicalProviderFingerprint": _sha_or_missing(INCREMENT3_PROVIDER_AUTHORITY),
        "increment4aProviderFingerprint": _sha_or_missing(INCREMENT4A_RUNTIME_AUTHORITY),
        "providerSemanticsFingerprint": impl["providerSemanticsFingerprint"],
        "workerLifecycleFingerprint": snapshot.tree_fingerprint(
            ROOT / "src/document_intelligence", ["runtime", "lifecycle.py", "app.py", "health.py"]
        ),
        "workerClientFingerprint": snapshot.tree_fingerprint(
            ROOT / "clients/typescript",
            ["src", "tests", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"],
        ),
        "packageRootFingerprint": _sha_or_missing(ROOT / "src/document_intelligence/__init__.py"),
        "routingProfilesFingerprint": snapshot.digest_json(
            {
                str(path.relative_to(ROOT)): _sha_or_missing(path)
                for path in sorted((ROOT / "routing").glob("*.yaml"))
                + sorted((ROOT / "profiles").glob("*.yaml"))
            }
        ),
        "runtimeDependencyFingerprint": _sha_or_missing(ROOT / "uv.lock"),
        "modelAssetFingerprint": snapshot.digest_json(
            {
                "increment3ModelManifestSha256": _sha_or_missing(INCREMENT3_MODEL_MANIFEST),
                "increment4aModelManifestSha256": _sha_or_missing(INCREMENT4A_MODEL_MANIFEST),
                "increment4aModelVerificationSha256": i4a_report_sha,
            }
        ),
    }


def build_marker() -> dict[str, object]:
    fingerprints = compute_fingerprints()
    return {
        "schemaVersion": MARKER_SCHEMA,
        "providerRuntimeState": "STABLE",
        "declaredAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "allowProviderSourceChangesAfterThisPoint": False,
        **fingerprints,
        "boundArtifacts": {
            "canonicalProviderAuthority": {
                "path": str(INCREMENT3_PROVIDER_AUTHORITY.relative_to(ROOT)),
                "sha256": fingerprints["canonicalProviderFingerprint"],
            },
            "increment4aRuntimeAuthority": {
                "path": str(INCREMENT4A_RUNTIME_AUTHORITY.relative_to(ROOT)),
                "sha256": fingerprints["increment4aProviderFingerprint"],
            },
            "increment4aAcceptedCapabilities": {
                "path": str(INCREMENT4A_ACCEPTED.relative_to(ROOT)),
                "sha256": _sha_or_missing(INCREMENT4A_ACCEPTED),
            },
            "increment3ModelManifest": {
                "path": str(INCREMENT3_MODEL_MANIFEST.relative_to(ROOT)),
                "sha256": _sha_or_missing(INCREMENT3_MODEL_MANIFEST),
            },
            "increment4aModelManifest": {
                "path": str(INCREMENT4A_MODEL_MANIFEST.relative_to(ROOT)),
                "sha256": _sha_or_missing(INCREMENT4A_MODEL_MANIFEST),
            },
            "uvLock": {"path": "uv.lock", "sha256": fingerprints["runtimeDependencyFingerprint"]},
        },
        "protectedSourcePaths": PROTECTED_SOURCE_PATHS,
        "invalidationContract": INVALIDATION_CONTRACT,
        "routeBackLeaves": [
            "increment3.strictGate",
            "increment4a.campaign.<canonical>",
            "increment4a.testReceipt.*",
            "increment4.liveWorkerIdentity",
            "increment4.livePostgres",
        ],
    }


def _fingerprint_keys(marker: dict[str, object]) -> list[str]:
    return [key for key in marker if key.endswith("Fingerprint")]


def check() -> dict[str, object]:
    if not MARKER_PATH.is_file():
        return {"providerRuntimeStability": "FAIL", "reason": "MARKER_NOT_DECLARED", "marker": str(MARKER_PATH)}
    try:
        marker = json.loads(MARKER_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"providerRuntimeStability": "FAIL", "reason": f"MARKER_INVALID_JSON:{exc}"}
    if marker.get("schemaVersion") != MARKER_SCHEMA:
        return {"providerRuntimeStability": "FAIL", "reason": "MARKER_SCHEMA_MISMATCH"}
    if marker.get("providerRuntimeState") != "STABLE" or marker.get("allowProviderSourceChangesAfterThisPoint") is not False:
        return {"providerRuntimeStability": "FAIL", "reason": "MARKER_NOT_A_STABILITY_DECLARATION"}
    current = compute_fingerprints()
    mismatched = [key for key in _fingerprint_keys(marker) if marker.get(key) != current.get(key)]
    return {
        "providerRuntimeStability": "FAIL" if mismatched else "PASS",
        "marker": str(MARKER_PATH),
        "declaredAt": marker.get("declaredAt"),
        "mismatchedFingerprints": mismatched,
        "disposition": "STALE_ROUTE_BACK_TO_AFFECTED_LEAVES" if mismatched else "STABLE",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="read-only verification; writes nothing")
    args = parser.parse_args()
    if args.check:
        result = check()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["providerRuntimeStability"] == "PASS" else 2
    marker = build_marker()
    MARKER_PATH.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(marker, indent=2, sort_keys=True) + "\n"
    unchanged = MARKER_PATH.exists() and MARKER_PATH.read_text(encoding="utf-8") == text
    if not unchanged:
        tmp = MARKER_PATH.with_name(MARKER_PATH.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(MARKER_PATH)
    print(json.dumps({"providerRuntimeStability": "DECLARED", "marker": str(MARKER_PATH), "written": not unchanged}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
