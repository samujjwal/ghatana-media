from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import verify_increment6 as verifier  # noqa: E402


MANIFEST_PATH = ROOT / "evaluation/increment6/manifest.yaml"
GRAPH_PATH = ROOT / "verification/document-intelligence-proof-graph.yaml"


def _manifest() -> dict:
    return yaml.safe_load(MANIFEST_PATH.read_text(encoding="utf-8"))


def test_protocol_authority_is_executable_and_complete() -> None:
    errors: list[str] = []
    verifier.check_protocol_authority(errors)
    assert errors == []

    authority = _manifest()["protocolAuthority"]
    assert {item["taskId"] for item in authority["mappings"]} == {
        "I6-03",
        "I6-04",
        "I6-05",
        "I6-06",
    }
    assert {item["executableCheck"] for item in authority["mappings"]} == {
        "protocolFreeze",
        "backwardCompatibility",
        "additiveVersionedExtensions",
        "negotiation",
    }


def test_protocol_leaf_is_connected_to_strict_gate() -> None:
    graph = yaml.safe_load(GRAPH_PATH.read_text(encoding="utf-8"))
    protocol = graph["leaves"]["increment6.protocolCompatibility"]
    strict = graph["leaves"]["increment6.strictGate"]
    assert protocol["dependsOn"] == ["increment3.strictGate"]
    assert protocol["invalidates"] == ["increment6.strictGate"]
    assert "increment6.protocolCompatibility" in strict["dependsOn"]


def test_absent_fixture_dependent_lanes_are_deferred() -> None:
    manifest = _manifest()
    dimensions = {item["capabilityId"]: item for item in manifest["capabilityDimensions"]}
    for lane in manifest["lanes"]:
        if not lane["fixtureBinaryDependent"]:
            continue
        assert lane["qualificationInput"] == "FIXTURE_BINARY"
        assert {
            dimensions[capability_id]["closureDisposition"]
            for capability_id in lane["ownerCapabilityIds"]
        } == {verifier.DEFERRED_DISPOSITION}
        fixtures = yaml.safe_load(
            (ROOT / "evaluation/increment6" / lane["fixturesManifest"]).read_text(encoding="utf-8")
        )
        assert fixtures["fixtureBinaryPolicy"] == "DECLARED_NOT_PRESENT"
        assert all(item["binaryState"] == "DECLARED_NOT_PRESENT" for item in fixtures["fixtures"])
        assert all(
            not ((ROOT / "evaluation/increment6" / lane["fixturesManifest"]).parent / item["file"]).exists()
            for item in fixtures["fixtures"]
        )


def test_summary_pass_cannot_promote_an_absent_fixture() -> None:
    manifest = _manifest()
    errors: list[str] = []
    _, fixtures = verifier._manifest_fixture_authority(manifest, errors)
    assert errors == []
    fixture_id, fixture = next(
        (fixture_id, fixture)
        for fixture_id, fixture in fixtures.items()
        if fixture["binaryDependent"]
    )
    summary = {
        "status": "PASS",
        "fixtureLeaves": {
            fixture_id: {
                "status": "PASS",
                "closureDisposition": verifier.DEFERRED_DISPOSITION,
            }
        },
        "requiredCapabilityLeaves": {},
        "deferredCapabilityLeaves": {},
    }
    verifier._check_qualification_summary(summary, {fixture_id: fixture}, manifest, errors)
    assert any("cannot be PASS" in error for error in errors)


def test_latest_result_projections_have_no_stale_required_deferred_leaves() -> None:
    results = sorted((ROOT / "evaluation/increment6/results").glob("*/summary.json"))
    assert results
    summary = verifier.load_json(results[-1])
    capabilities = verifier.load_json(results[-1].with_name("capabilities.json"))
    manifest = _manifest()
    errors: list[str] = []
    _, fixtures = verifier._manifest_fixture_authority(manifest, errors)
    verifier._check_qualification_summary(summary, fixtures, manifest, errors)
    verifier._check_capability_projection(capabilities, manifest, errors)
    assert errors == []
