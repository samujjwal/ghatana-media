"""Increment-6 deployment + release tooling tests (I6-28/29/43/44/47).

All scripts are exercised via subprocess against synthetic --root trees so
the sealed worker evidence is never touched.
"""
from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

WORKER = Path(__file__).resolve().parents[2]
BUILD_BUNDLE = WORKER / "deployment/build_offline_bundle.py"
BUILD_PACKAGE = WORKER / "deployment/build_package.py"
SBOM = WORKER / "deployment/sbom.py"
CHECK_VULN = WORKER / "scripts/check_vulnerabilities.py"
BUILD_READINESS = WORKER / "scripts/build_release_readiness.py"
VULN_POLICY = WORKER / "deployment/vulnerability-policy.v1.yaml"


def run(script: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True,
        text=True,
    )


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _asset_tree_digest(root: Path) -> str:
    hasher = hashlib.sha256()
    for item in sorted(
        p
        for p in root.rglob("*")
        if p.is_file() and p.name not in {"PROVISIONING_REQUIRED", ".artifact.sha256"}
    ):
        hasher.update(str(item.relative_to(root)).encode("utf-8"))
        hasher.update(item.read_bytes())
    return hasher.hexdigest()


def _write(path: Path, content: str | bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")
    return path


# --------------------------------------------------------------------------
# offline bundle (I6-28)
# --------------------------------------------------------------------------

def _make_bundle_root(tmp_path: Path) -> dict:
    """Synthetic root: one model cache dir + manifest + uv.lock + sources."""
    cache = tmp_path / ".models/test-model"
    _write(cache / "weights.bin", b"fake-weights-0001")
    _write(cache / "config.json", json.dumps({"arch": "test"}))
    model_sha = _asset_tree_digest(cache)

    weights_sha = _sha256(cache / "weights.bin")
    _write(
        tmp_path / "models/model-manifest.yaml",
        yaml.safe_dump(
            {
                "manifestVersion": "document-intelligence.models.v1",
                "models": [
                    {
                        "providerRef": "test.provider",
                        "modelRef": "test-model",
                        "modelRevision": "rev-1",
                        "artifactSha256": model_sha,
                    }
                ],
                "artifacts": [
                    {
                        "artifactId": "test.weights.file",
                        "artifactSha256": weights_sha,
                    }
                ],
            }
        ),
    )
    uv_lock = _write(tmp_path / "uv.lock", b"version = 1\n")
    _write(tmp_path / "src/app/main.py", "print('x')\n")
    _write(tmp_path / "policies/policy.yaml", "schemaVersion: test.policy.v1\n")

    descriptor = {
        "schemaVersion": "document-intelligence.offline-bundle.v1",
        "bundleId": "test-bundle",
        "increment": "increment6",
        "modelAssets": [
            {
                "ref": "test.provider/test-model@rev-1",
                "sha256": model_sha,
                "source": "models/model-manifest.yaml",
                "cachePath": ".models/test-model",
            }
        ],
        "nativeAssets": [
            {
                "ref": "test.weights.file",
                "sha256": weights_sha,
                "source": "models/model-manifest.yaml",
                "path": ".models/test-model/weights.bin",
                "kind": "file",
            }
        ],
        "pythonRuntime": {
            "version": platform.python_version(),
            "uvLockSha256": _sha256(uv_lock),
        },
        "applicationSources": ["src/"],
        "policyRefs": ["policies/policy.yaml"],
    }
    descriptor_path = _write(
        tmp_path / "deployment/offline-bundle.v1.yaml", yaml.safe_dump(descriptor)
    )
    return {"descriptor": descriptor_path, "cache": cache, "model_sha": model_sha}


def test_bundle_build_happy_path(tmp_path: Path) -> None:
    ctx = _make_bundle_root(tmp_path)
    out = tmp_path / "deployment/sbom/offline-bundle-manifest.v1.json"
    result = run(
        BUILD_BUNDLE,
        "--root", str(tmp_path),
        "--descriptor", str(ctx["descriptor"]),
        "--output", str(out),
    )
    assert result.returncode == 0, result.stderr + result.stdout
    manifest = json.loads(out.read_text())
    assert manifest["schemaVersion"] == "document-intelligence.offline-bundle-manifest.v1"
    assert manifest["manifestFingerprint"].startswith("sha256:")
    assert manifest["modelAssets"][0]["status"] == "VERIFIED"
    assert manifest["modelAssets"][0]["verifiedDigest"] == ctx["model_sha"]
    assert manifest["pythonRuntime"]["status"] == "VERIFIED"
    assert "src/" in manifest["applicationSources"]

    check = run(
        BUILD_BUNDLE,
        "--root", str(tmp_path),
        "--descriptor", str(ctx["descriptor"]),
        "--output", str(out),
        "--check",
    )
    assert check.returncode == 0, check.stdout
    assert json.loads(check.stdout)["offlineBundle"] == "PASS"


def test_bundle_build_fails_on_corrupt_asset(tmp_path: Path) -> None:
    ctx = _make_bundle_root(tmp_path)
    (ctx["cache"] / "weights.bin").write_bytes(b"tampered-weights")
    result = run(
        BUILD_BUNDLE,
        "--root", str(tmp_path),
        "--descriptor", str(ctx["descriptor"]),
        "--output", str(tmp_path / "out.json"),
    )
    assert result.returncode == 2
    report = json.loads(result.stdout)
    assert report["offlineBundle"] == "FAIL"
    assert "corrupt" in report["errors"][0]


def test_bundle_build_fails_on_unresolved_ref(tmp_path: Path) -> None:
    ctx = _make_bundle_root(tmp_path)
    descriptor = yaml.safe_load(ctx["descriptor"].read_text())
    descriptor["modelAssets"][0]["ref"] = "test.provider/ghost@rev-9"
    ctx["descriptor"].write_text(yaml.safe_dump(descriptor))
    result = run(
        BUILD_BUNDLE,
        "--root", str(tmp_path),
        "--descriptor", str(ctx["descriptor"]),
        "--output", str(tmp_path / "out.json"),
    )
    assert result.returncode == 2
    assert "unresolved" in json.loads(result.stdout)["errors"][0]


# --------------------------------------------------------------------------
# reproducible package (I6-29)
# --------------------------------------------------------------------------

def test_package_receipt_deterministic(tmp_path: Path) -> None:
    _write(tmp_path / "a.bin", b"alpha")
    _write(tmp_path / "dir/b.bin", b"beta")
    _write(tmp_path / "uv.lock", b"version = 1\n")
    out1, out2 = tmp_path / "r1.json", tmp_path / "r2.json"
    args = [
        "--root", str(tmp_path),
        "--entry", "a.bin=1.0.0",
        "--entry", "dir/b.bin",
        "--output",
    ]
    r1 = run(BUILD_PACKAGE, *args, str(out1), "--built-at", "2026-01-01T00:00:00Z")
    r2 = run(BUILD_PACKAGE, *args, str(out2), "--built-at", "2026-06-30T12:00:00Z")
    assert r1.returncode == 0 and r2.returncode == 0
    receipt1 = json.loads(out1.read_text())
    receipt2 = json.loads(out2.read_text())
    assert receipt1["packageFingerprint"] == receipt2["packageFingerprint"]
    assert receipt1["builtAt"] != receipt2["builtAt"]  # builtAt is not fingerprint input
    # Entry order in the CLI must not matter either.
    r3 = run(
        BUILD_PACKAGE,
        "--root", str(tmp_path),
        "--entry", "dir/b.bin",
        "--entry", "a.bin=1.0.0",
        "--built-at", "2026-01-01T00:00:00Z",
        "--output", str(tmp_path / "r3.json"),
    )
    assert r3.returncode == 0
    assert json.loads((tmp_path / "r3.json").read_text())["packageFingerprint"] == receipt1[
        "packageFingerprint"
    ]


# --------------------------------------------------------------------------
# SBOM (I6-43)
# --------------------------------------------------------------------------

def _make_sbom_root(tmp_path: Path) -> None:
    _write(
        tmp_path / "uv.lock",
        'version = 1\n\n[[package]]\nname = "alpha"\nversion = "1.0.0"\n\n'
        '[[package]]\nname = "beta"\nversion = "2.3.4"\n',
    )
    _write(
        tmp_path / "models/model-manifest.yaml",
        yaml.safe_dump(
            {
                "models": [
                    {
                        "providerRef": "test.provider",
                        "modelRef": "test-model",
                        "modelRevision": "rev-1",
                        "artifactSha256": "a" * 64,
                    }
                ]
            }
        ),
    )
    _write(tmp_path / "pyproject.toml", '[project]\nname = "x"\nversion = "9.9.9"\n')


def test_sbom_generate_and_check(tmp_path: Path) -> None:
    _make_sbom_root(tmp_path)
    out = tmp_path / "deployment/sbom/sbom.v1.json"
    gen = run(SBOM, "--root", str(tmp_path), "--output", str(out))
    assert gen.returncode == 0, gen.stdout + gen.stderr
    sbom = json.loads(out.read_text())
    assert sbom["bomFormat"] == "CycloneDX"
    names = {(c["name"], c["type"]) for c in sbom["components"]}
    assert ("alpha", "library") in names
    assert ("beta", "library") in names
    assert ("test-model", "machine-learning-model") in names

    check = run(SBOM, "--root", str(tmp_path), "--output", str(out), "--check")
    assert check.returncode == 0, check.stdout
    assert json.loads(check.stdout)["sbom"] == "PASS"

    # Drift detection: tamper with the stored component set.
    sbom["components"].append({"type": "library", "name": "ghost", "version": "0"})
    out.write_text(json.dumps(sbom, indent=2, sort_keys=True) + "\n")
    drift = run(SBOM, "--root", str(tmp_path), "--output", str(out), "--check")
    assert drift.returncode == 2
    assert json.loads(drift.stdout)["sbom"] == "FAIL"


# --------------------------------------------------------------------------
# vulnerability policy (I6-44)
# --------------------------------------------------------------------------

def _scan(tmp_path: Path, findings: list[dict]) -> Path:
    return _write(tmp_path / "scan.json", json.dumps({"findings": findings}))


def test_vulnerability_critical_blocks(tmp_path: Path) -> None:
    scan = _scan(
        tmp_path,
        [{"id": "CVE-1", "severity": "CRITICAL", "package": "alpha",
          "mitigation": "even mitigation cannot unblock CRITICAL"}],
    )
    result = run(CHECK_VULN, "--scan", str(scan), "--policy", str(VULN_POLICY))
    assert result.returncode == 2
    report = json.loads(result.stdout)
    assert report["status"] == "FAIL"
    assert report["blockedFindings"] == ["CVE-1"]


def test_vulnerability_mitigated_high_passes(tmp_path: Path) -> None:
    scan = _scan(
        tmp_path,
        [
            {"id": "CVE-2", "severity": "HIGH", "package": "beta",
             "mitigation": "bounded sandbox; no untrusted input path"},
            {"id": "CVE-3", "severity": "MEDIUM", "package": "gamma"},
            {"id": "CVE-4", "severity": "LOW", "package": "delta"},
        ],
    )
    result = run(CHECK_VULN, "--scan", str(scan), "--policy", str(VULN_POLICY))
    assert result.returncode == 0, result.stdout
    report = json.loads(result.stdout)
    assert report["status"] == "PASS"
    dispositions = {f["id"]: f["disposition"] for f in report["findings"]}
    assert dispositions["CVE-2"] == "MITIGATED"
    assert dispositions["CVE-3"] == "TRACKED"
    assert dispositions["CVE-4"] == "ALLOWED"
    assert "CVE-3" in report["trackedFindings"]


def test_vulnerability_unmitigated_high_blocks(tmp_path: Path) -> None:
    scan = _scan(tmp_path, [{"id": "CVE-5", "severity": "HIGH", "package": "beta"}])
    result = run(CHECK_VULN, "--scan", str(scan), "--policy", str(VULN_POLICY))
    assert result.returncode == 2
    assert json.loads(result.stdout)["blockedFindings"] == ["CVE-5"]


# --------------------------------------------------------------------------
# release readiness (I6-47)
# --------------------------------------------------------------------------

def _make_readiness_root(tmp_path: Path) -> Path:
    _write(
        tmp_path / "deployment/deployment-gates.v1.yaml",
        yaml.safe_dump(
            {
                "schemaVersion": "document-intelligence.deployment-gates.v1",
                "increment": "increment6",
                "gates": [
                    {"id": "gateA", "required": True, "evidenceKind": "test"},
                    {"id": "gateB", "required": True, "evidenceKind": "test"},
                ],
            }
        ),
    )
    _write(
        tmp_path / "capabilities/document-intelligence-capabilities.yaml",
        yaml.safe_dump(
            {
                "schemaVersion": "document-intelligence.capabilities.v1",
                "profiles": {"default": {"description": "test"}},
                "capabilities": {
                    "cap.allowed": {
                        "ownerIncrement": "increment6",
                        "developmentState": "QUALIFIED",
                        "consumerAdmission": "ALLOWED",
                        "profiles": ["default"],
                        "futureOwner": "NONE",
                    },
                    "cap.denied": {
                        "ownerIncrement": "increment6",
                        "developmentState": "NOT_QUALIFIED",
                        "consumerAdmission": "DENIED",
                        "profiles": [],
                        "futureOwner": "DEFERRED_TO_INCREMENT_6",
                    },
                },
            }
        ),
    )
    _write(
        tmp_path / "capabilities/increment4a.accepted.json",
        json.dumps({"accepted": [{"capabilityId": "cap.allowed"}]}),
    )
    _write(
        tmp_path / "capabilities/increment4a.runtime-authority.json",
        json.dumps({"excluded": [{"capabilityId": "cap.denied"}]}),
    )
    _write(tmp_path / "deployment/sbom/sbom.v1.json", json.dumps({"stub": "sbom"}))
    _write(
        tmp_path / "deployment/sbom/offline-bundle-manifest.v1.json",
        json.dumps({"stub": "bundle"}),
    )
    _write(
        tmp_path / "deployment/operational-envelope.v1.yaml",
        "schemaVersion: document-intelligence.operational-envelope.v1\n",
    )
    return tmp_path / "release/readiness/receipts"


def _receipt(receipts: Path, gate: str, status: str = "PASS") -> None:
    _write(
        receipts / f"{gate}.json",
        json.dumps(
            {
                "schemaVersion": "document-intelligence.gate-receipt.v1",
                "gateId": gate,
                "status": status,
                "evidenceKind": "test",
            }
        ),
    )


def test_release_readiness_fails_with_missing_gate_receipt(tmp_path: Path) -> None:
    receipts = _make_readiness_root(tmp_path)
    _receipt(receipts, "gateA")
    result = run(BUILD_READINESS, "--root", str(tmp_path))
    assert result.returncode == 2
    report = json.loads(result.stdout)
    assert report["status"] == "NOT_READY"
    manifest = json.loads(
        (tmp_path / "release/readiness/readiness-manifest.v1.json").read_text()
    )
    gate_b = next(g for g in manifest["gates"] if g["gateId"] == "gateB")
    assert gate_b["status"] == "NOT_RUN"
    assert gate_b["receiptFingerprint"] is None


def test_release_readiness_passes_with_complete_receipts(tmp_path: Path) -> None:
    receipts = _make_readiness_root(tmp_path)
    _receipt(receipts, "gateA")
    _receipt(receipts, "gateB")
    result = run(BUILD_READINESS, "--root", str(tmp_path))
    assert result.returncode == 0, result.stdout + result.stderr
    manifest_path = tmp_path / "release/readiness/readiness-manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["schemaVersion"] == "document-intelligence.release-readiness.v1"
    assert manifest["status"] == "READY"
    assert manifest["manifestFingerprint"].startswith("sha256:")
    assert manifest["capabilityAdmission"]["qualifiedIds"] == ["cap.allowed"]
    assert manifest["capabilityAdmission"]["deniedIds"] == ["cap.denied"]
    assert manifest["capabilityAdmission"]["registryCheck"] == "PASS"
    for gate in manifest["gates"]:
        assert gate["status"] == "PASS"
        assert gate["receiptFingerprint"].startswith("sha256:")


def test_release_readiness_check_is_read_only(tmp_path: Path) -> None:
    receipts = _make_readiness_root(tmp_path)
    _receipt(receipts, "gateA")
    _receipt(receipts, "gateB")
    build = run(BUILD_READINESS, "--root", str(tmp_path))
    assert build.returncode == 0
    manifest_path = tmp_path / "release/readiness/readiness-manifest.v1.json"
    before = {p: _sha256(p) for p in sorted(tmp_path.rglob("*")) if p.is_file()}

    check = run(BUILD_READINESS, "--root", str(tmp_path), "--check")
    assert check.returncode == 0, check.stdout
    assert json.loads(check.stdout)["releaseReadiness"] == "PASS"
    after = {p: _sha256(p) for p in sorted(tmp_path.rglob("*")) if p.is_file()}
    assert before == after, "--check must write nothing"

    # Drifted receipt must be rejected.
    _receipt(receipts, "gateA", status="FAIL")
    drift = run(BUILD_READINESS, "--root", str(tmp_path), "--check")
    assert drift.returncode == 2
    assert json.loads(drift.stdout)["releaseReadiness"] == "FAIL"
