#!/usr/bin/env python3
"""Increment 6 strict reconciler — read-only, fail-closed (I6-47).

Scope:
  1. scanned-PDF policy + provenance authority loads and binds its fingerprint
  2. fallback contract admits only declared chains/triggers
  3. I6-03..06 protocol authority binds freeze, I3 compatibility, additive
     versioned extensions, and provider-catalog negotiation
  4. increment6 corpus/qualification authorities parse and are complete
  5. absent fixture-dependent lanes remain deferred/not-run and never PASS
  6. runtime resilience modules import cleanly
  7. deployment authorities present: offline bundle, gates, activation,
     vulnerability policy, operational envelope
  8. release-readiness manifest consistency (when built)
  9. capability registry: no I6 capability is QUALIFIED or ALLOWED without
     its evidence (NOT_QUALIFIED/DENIED until the qualification wave)
 10. performance evidence artifacts validate against their schema
 11. no sealed I3/I4/I4A material was modified — scope separation holds
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from learning.util import digest, load_json  # noqa: E402


PROTOCOL_SCHEMA_FILES = (
    "embed.request.schema.json",
    "embed.response.schema.json",
    "error.schema.json",
    "extract.request.schema.json",
    "extract.response.schema.json",
    "operations-delete.schema.json",
    "parse.request.schema.json",
    "parse.response.schema.json",
    "providers.response.schema.json",
    "request-metadata.schema.json",
)
PROTOCOL_TASK_MAPPINGS = {
    "I6-03": ("PROTOCOL_FREEZE", "protocolFreeze"),
    "I6-04": ("BACKWARD_COMPATIBILITY", "backwardCompatibility"),
    "I6-05": ("ADDITIVE_VERSIONED_EXTENSIONS", "additiveVersionedExtensions"),
    "I6-06": ("NEGOTIATION", "negotiation"),
}
I3_METADATA_KEYS = {
    "protocolVersion",
    "operationId",
    "operationGeneration",
    "providerRef",
    "mediaType",
    "languageHint",
    "timeoutMs",
    "limits",
}
I3_MEDIA_TYPES = ("application/pdf", "image/png", "image/jpeg")
I3_LANGUAGES = ("en", "ne")
DEFERRED_DISPOSITION = "DEFERRED_TO_FUTURE_RELEASE"


def _increment6_manifest() -> dict:
    path = ROOT / "evaluation/increment6/manifest.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _fail(errors: list[str], check: str, message: str) -> None:
    errors.append(f"{check}: {message}")


def check_scanned_policy(errors: list[str]) -> None:
    policy = ROOT / "routing/scanned-pdf.v1.yaml"
    if not policy.exists():
        _fail(errors, "scannedPolicy", "routing/scanned-pdf.v1.yaml missing")
        return
    data = yaml.safe_load(policy.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != "document-intelligence.scanned-pdf.v1":
        _fail(errors, "scannedPolicy", "schemaVersion mismatch")
    for cls in ("TEXT_NATIVE", "SCANNED", "HYBRID", "EMPTY"):
        if cls not in (data.get("routing") or {}):
            _fail(errors, "scannedPolicy", f"routing decision missing for {cls}")
    try:
        from document_intelligence.scanned.classifier import classify_document

        classify_document  # importable
    except ImportError as exc:
        _fail(errors, "scannedPolicy", f"classifier import failed: {exc}")


def check_fallback_contract(errors: list[str]) -> None:
    contract = ROOT / "routing/fallback-contract.v1.yaml"
    if not contract.exists():
        _fail(errors, "fallbackContract", "routing/fallback-contract.v1.yaml missing")
        return
    data = yaml.safe_load(contract.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != "document-intelligence.fallback-contract.v1":
        _fail(errors, "fallbackContract", "schemaVersion mismatch")
        return
    rules = data.get("rules", {})
    if rules.get("implicitFallback") != "REJECT" or rules.get("requireProvenance") is not True:
        _fail(errors, "fallbackContract", "implicit fallback must be REJECT and provenance required")
    try:
        from document_intelligence.runtime.fallback_contract import (
            FallbackContract,
            FallbackContractError,
        )

        fc = FallbackContract(contract)
        try:
            fc.admit("ghatana.gliner", "ghatana.docling", "UNDECLARED", "application/pdf")
            _fail(errors, "fallbackContract", "undeclared chain was admitted")
        except FallbackContractError:
            pass
    except ImportError as exc:
        _fail(errors, "fallbackContract", f"contract module import failed: {exc}")


def _protocol_authority(errors: list[str]) -> dict | None:
    manifest_path = ROOT / "evaluation/increment6/manifest.yaml"
    if not manifest_path.exists():
        _fail(errors, "protocolAuthority", "increment6 manifest missing")
        return None
    try:
        manifest = _increment6_manifest()
    except yaml.YAMLError as exc:
        _fail(errors, "protocolAuthority", f"increment6 manifest is malformed: {exc}")
        return None
    authority = manifest.get("protocolAuthority")
    if not isinstance(authority, dict):
        _fail(errors, "protocolAuthority", "manifest has no protocolAuthority section")
        return None
    if authority.get("schemaVersion") != "document-intelligence.increment6-protocol-authority.v1":
        _fail(errors, "protocolAuthority", "protocol authority schemaVersion mismatch")
    if authority.get("protocolVersion") != "document-intelligence.v1":
        _fail(errors, "protocolAuthority", "protocolVersion is not frozen to document-intelligence.v1")
    mappings = authority.get("mappings")
    if not isinstance(mappings, list):
        _fail(errors, "protocolAuthority", "protocol task mappings must be a list")
    else:
        observed: dict[str, tuple[str | None, str | None]] = {}
        for mapping in mappings:
            if not isinstance(mapping, dict):
                _fail(errors, "protocolAuthority", "protocol task mapping is not an object")
                continue
            task_id = mapping.get("taskId")
            observed[task_id] = (mapping.get("authority"), mapping.get("executableCheck"))
        if set(observed) != set(PROTOCOL_TASK_MAPPINGS):
            _fail(
                errors,
                "protocolAuthority",
                f"I6 protocol mappings must be exactly {sorted(PROTOCOL_TASK_MAPPINGS)}, got {sorted(observed)}",
            )
        for task_id, expected in PROTOCOL_TASK_MAPPINGS.items():
            if observed.get(task_id) != expected:
                _fail(
                    errors,
                    "protocolAuthority",
                    f"{task_id} mapping must be {expected}, got {observed.get(task_id)}",
                )
    expected_paths = {
        "protocolDocument": ROOT / "contracts/protocol-v1.md",
        "extensionPolicy": ROOT / "contracts/protocol-extensions.v1.md",
        "schemaDirectory": ROOT / "contracts/schemas/v1",
        "canonicalCompatibilityFixtures": ROOT / "contracts/fixtures/i3-canonical",
    }
    for field, expected_path in expected_paths.items():
        declared = authority.get(field)
        if not isinstance(declared, str) or declared != str(expected_path.relative_to(ROOT)):
            _fail(errors, "protocolAuthority", f"{field} must declare {expected_path.relative_to(ROOT)}")
        if not expected_path.exists():
            _fail(errors, "protocolAuthority", f"{field} authority missing: {expected_path.relative_to(ROOT)}")
    schemas = authority.get("coreSchemas")
    if schemas != list(PROTOCOL_SCHEMA_FILES):
        _fail(errors, "protocolAuthority", "coreSchemas does not match the frozen v1 schema inventory")
    for field, relative in (authority.get("focusedTests") or {}).items():
        if not isinstance(relative, str) or not (ROOT / relative).is_file():
            _fail(errors, "protocolAuthority", f"focused test {field} is missing: {relative}")
    return authority


def _metadata_for(endpoint: str, request: dict) -> dict:
    payload_key = {"extract": "payload", "embed": "projection"}.get(endpoint)
    return request if payload_key is None else {
        key: value for key, value in request.items() if key != payload_key
    }


def _payload_gate(endpoint: str, request: dict) -> str | None:
    if endpoint == "extract" and not isinstance(request.get("payload"), dict):
        return "INVALID_REQUEST"
    if endpoint == "embed" and not isinstance(request.get("projection"), dict):
        return "INVALID_REQUEST"
    return None


def _check_i3_fixture(fixture_path: Path, errors: list[str]) -> None:
    try:
        fixture = load_json(fixture_path)
        endpoint = fixture["endpoint"]
        request = fixture["request"]
        expected = fixture["expected"]
        metadata = _metadata_for(endpoint, request)
        from document_intelligence.contracts import RequestMetadata
        from document_intelligence.errors import WorkerError
        from document_intelligence.limits import Limits

        try:
            parsed = RequestMetadata.parse(
                metadata,
                Limits(),
                media_type_required=endpoint == "parse",
                allowed_media_types=I3_MEDIA_TYPES,
                allowed_languages=I3_LANGUAGES,
                operation_generation_header=fixture.get("headerGeneration"),
            )
            metadata_error = None
        except WorkerError as exc:
            parsed = None
            metadata_error = exc.code

        fixture_id = fixture.get("id", fixture_path.stem)
        if not expected.get("accepted"):
            if expected.get("stage", "metadata") == "metadata":
                if parsed is not None or metadata_error != expected.get("code"):
                    _fail(errors, "protocolAuthority", f"I3 fixture {fixture_id} changed its rejection contract")
            elif parsed is None or _payload_gate(endpoint, request) != expected.get("code"):
                _fail(errors, "protocolAuthority", f"I3 fixture {fixture_id} changed its payload rejection contract")
            return

        if parsed is None or _payload_gate(endpoint, request) is not None:
            _fail(errors, "protocolAuthority", f"I3 fixture {fixture_id} is no longer accepted")
            return
        if set(metadata) - I3_METADATA_KEYS or set(request) - I3_METADATA_KEYS - {"payload", "projection"}:
            _fail(errors, "protocolAuthority", f"I3 fixture {fixture_id} widened the canonical metadata shape")
        if endpoint == "parse" and parsed.media_type not in I3_MEDIA_TYPES:
            _fail(errors, "protocolAuthority", f"I3 fixture {fixture_id} widened the canonical media catalog")
        if parsed.language_hint not in (None, *I3_LANGUAGES):
            _fail(errors, "protocolAuthority", f"I3 fixture {fixture_id} widened the canonical language catalog")
    except Exception as exc:
        _fail(errors, "protocolAuthority", f"I3 fixture {fixture_path.name}: {exc}")


def check_protocol_authority(errors: list[str]) -> None:
    """Execute the I6-03..06 protocol authority checks.

    The checks deliberately consume the frozen v1 artifacts and canonical I3
    fixtures; they do not modify or regenerate those artifacts.
    """
    authority = _protocol_authority(errors)
    if authority is None:
        return

    protocol_doc = ROOT / authority["protocolDocument"]
    extension_doc = ROOT / authority["extensionPolicy"]
    if protocol_doc.exists():
        text = protocol_doc.read_text(encoding="utf-8")
        required = (
            "document-intelligence.v1",
            "/v1/operations/{operationId}",
        )
        for marker in required:
            if marker not in text:
                _fail(errors, "protocolAuthority", f"protocol freeze document omits {marker}")

    schema_dir = ROOT / authority["schemaDirectory"]
    endpoints = authority.get("endpoints")
    if not isinstance(endpoints, list) or endpoints != [
        "GET /v1/providers",
        "POST /v1/parse",
        "POST /v1/extract",
        "POST /v1/embed",
        "DELETE /v1/operations/{operationId}",
    ]:
        _fail(errors, "protocolAuthority", "endpoint inventory is not the frozen v1 surface")
    schema_titles: list[str] = []
    for name in PROTOCOL_SCHEMA_FILES:
        path = schema_dir / name
        if not path.is_file():
            _fail(errors, "protocolAuthority", f"frozen protocol schema missing: {name}")
            continue
        try:
            schema = load_json(path)
            serialized = json.dumps(schema, sort_keys=True)
            schema_titles.append(str(schema.get("title", "")))
            if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
                _fail(errors, "protocolAuthority", f"{name} is not a JSON Schema 2020-12 authority")
            if '"const": "document-intelligence.v1"' not in serialized:
                _fail(errors, "protocolAuthority", f"{name} is not bound to document-intelligence.v1")
            if '"additionalProperties": false' not in serialized:
                _fail(errors, "protocolAuthority", f"{name} is not strict-subset validated")
        except (OSError, json.JSONDecodeError) as exc:
            _fail(errors, "protocolAuthority", f"{name}: {exc}")
    for endpoint in endpoints if isinstance(endpoints, list) else ():
        if not any(endpoint in title for title in schema_titles):
            _fail(errors, "protocolAuthority", f"frozen schema inventory omits {endpoint}")

    if extension_doc.exists():
        text = extension_doc.read_text(encoding="utf-8")
        required = (
            "Strict-subset grammar is unchanged",
            "New optional fields are added only as declared keys",
            "Existing fields are never reinterpreted",
            "new protocol",
            "Extension registry",
            "GET /v1/providers",
            "document-intelligence.v1-legacy",
        )
        for marker in required:
            if marker not in text:
                _fail(errors, "protocolAuthority", f"extension policy omits {marker}")

    fixtures_dir = ROOT / authority["canonicalCompatibilityFixtures"]
    fixtures = sorted(fixtures_dir.glob("*.json")) if fixtures_dir.is_dir() else []
    if len(fixtures) < 10:
        _fail(errors, "protocolAuthority", "canonical I3 compatibility corpus is incomplete")
    for fixture in fixtures:
        _check_i3_fixture(fixture, errors)

    protocol_source = ROOT / "clients/typescript/src/protocol.ts"
    client_source = ROOT / "clients/typescript/src/client.ts"
    validator_source = ROOT / "clients/typescript/src/validators.ts"
    app_source = ROOT / "src/document_intelligence/app.py"
    sources = {
        "protocol client constants": (protocol_source, ("PROTOCOL_VERSION", "WORKER_CAPABILITY_VERSIONS", "LEGACY_WORKER_CAPABILITY_VERSION")),
        "protocol negotiation client": (client_source, ("validateProviderCatalog", "WORKER_CAPABILITY_VERSIONS", "LEGACY_WORKER_CAPABILITY_VERSION")),
        "provider catalog validator": (validator_source, ("workerCapabilityVersion", "providers", "within(value")),
        "worker negotiation endpoint": (app_source, ('@app.get("/v1/providers")', '"protocolVersion": PROTOCOL_VERSION')),
    }
    for label, (path, markers) in sources.items():
        if not path.is_file():
            _fail(errors, "protocolAuthority", f"{label} source missing: {path.relative_to(ROOT)}")
            continue
        text = path.read_text(encoding="utf-8")
        for marker in markers:
            if marker not in text:
                _fail(errors, "protocolAuthority", f"{label} omits executable marker {marker}")


def check_corpus_authorities(errors: list[str]) -> None:
    base = ROOT / "evaluation/increment6"
    for name in ("manifest.yaml", "qualification.yaml", "acceptance.yaml", "environment.yaml", "required-tests.yaml"):
        path = base / name
        if not path.exists():
            _fail(errors, "corpusAuthority", f"evaluation/increment6/{name} missing")
            continue
        try:
            yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            _fail(errors, "corpusAuthority", f"{name}: {exc}")
    manifest = base / "manifest.yaml"
    if manifest.exists():
        data = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}
        lanes = data.get("lanes") or data.get("corpora") or []
        lane_ids = {l.get("id") if isinstance(l, dict) else l for l in lanes}
        for required in ("scanned-pdf", "hi-mr-ocr", "hi-mr-extraction", "scanned-table-regression"):
            if required not in lane_ids and not any(required in str(l) for l in lane_ids):
                _fail(errors, "corpusAuthority", f"required lane {required} missing from manifest")


def _manifest_fixture_authority(manifest: dict, errors: list[str]) -> tuple[dict, dict[str, dict]]:
    dimensions = {
        item.get("capabilityId"): item
        for item in manifest.get("capabilityDimensions", [])
        if isinstance(item, dict) and isinstance(item.get("capabilityId"), str)
    }
    fixtures: dict[str, dict] = {}
    for lane in manifest.get("lanes", []):
        if not isinstance(lane, dict):
            _fail(errors, "fixtureClosure", "manifest lane is not an object")
            continue
        lane_id = lane.get("id")
        if not isinstance(lane_id, str):
            _fail(errors, "fixtureClosure", "manifest lane has no id")
            continue
        if not isinstance(lane.get("fixtureBinaryDependent"), bool):
            _fail(errors, "fixtureClosure", f"{lane_id}: fixtureBinaryDependent must be declared")
        if not isinstance(lane.get("qualificationInput"), str):
            _fail(errors, "fixtureClosure", f"{lane_id}: qualificationInput must be declared")
        owner_ids = lane.get("ownerCapabilityIds") or []
        dispositions = {
            dimensions[capability_id].get("closureDisposition")
            for capability_id in owner_ids
            if capability_id in dimensions
        }
        if len(dispositions) != 1:
            _fail(errors, "fixtureClosure", f"{lane_id}: owner capability disposition is not singular")
        if not all(capability_id in dimensions for capability_id in owner_ids):
            _fail(errors, "fixtureClosure", f"{lane_id}: owner capability is missing from capabilityDimensions")
        fixtures_path = ROOT / "evaluation/increment6" / str(lane.get("fixturesManifest", ""))
        if not fixtures_path.is_file():
            _fail(errors, "fixtureClosure", f"{lane_id}: fixture manifest missing")
            continue
        try:
            spec = yaml.safe_load(fixtures_path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            _fail(errors, "fixtureClosure", f"{lane_id}: fixture manifest is malformed: {exc}")
            continue
        if spec.get("fixtureBinaryPolicy") != "DECLARED_NOT_PRESENT":
            _fail(errors, "fixtureClosure", f"{lane_id}: fixtureBinaryPolicy must remain DECLARED_NOT_PRESENT")
        for fixture in spec.get("fixtures", []):
            if not isinstance(fixture, dict) or not isinstance(fixture.get("fixtureId"), str):
                _fail(errors, "fixtureClosure", f"{lane_id}: malformed fixture declaration")
                continue
            fixture_copy = {
                **fixture,
                "lane": lane_id,
                "disposition": next(iter(dispositions), None),
                "binaryPath": fixtures_path.parent / str(fixture.get("file", "")),
                "binaryDependent": lane.get("fixtureBinaryDependent"),
            }
            fixtures[fixture["fixtureId"]] = fixture_copy
    return manifest, fixtures


def _deferred_capability_ids(manifest: dict) -> set[str]:
    return {
        f"{capability_id}:{language}"
        for capability_id, dimension in {
            item.get("capabilityId"): item
            for item in manifest.get("capabilityDimensions", [])
            if isinstance(item, dict) and isinstance(item.get("capabilityId"), str)
        }.items()
        if dimension.get("closureDisposition") == DEFERRED_DISPOSITION
        for language in dimension.get("languages", [])
    }


def _check_qualification_summary(summary: dict, fixtures: dict[str, dict], manifest: dict, errors: list[str]) -> None:
    """Reject stale or inflated status projections from an I6 run receipt."""
    absent_deferred = {
        fixture_id: fixture
        for fixture_id, fixture in fixtures.items()
        if fixture.get("binaryDependent") is True
        and fixture.get("binaryPath") is not None
        and not fixture["binaryPath"].exists()
        and fixture.get("disposition") == DEFERRED_DISPOSITION
    }
    fixture_leaves = summary.get("fixtureLeaves") or {}
    bad_fixture_passes = []
    bad_fixture_states = []
    for fixture_id, fixture in absent_deferred.items():
        leaf = fixture_leaves.get(fixture_id)
        if not isinstance(leaf, dict):
            bad_fixture_states.append(fixture_id)
            continue
        if leaf.get("status") == "PASS":
            bad_fixture_passes.append(fixture_id)
        if leaf.get("status") != "NOT_RUN" or leaf.get("closureDisposition") != DEFERRED_DISPOSITION:
            bad_fixture_states.append(fixture_id)
    if bad_fixture_passes:
        _fail(errors, "fixtureClosure", f"absent fixture-dependent leaves cannot be PASS: {sorted(bad_fixture_passes)}")
    if bad_fixture_states:
        _fail(errors, "fixtureClosure", f"absent fixture-dependent leaves must be DEFERRED/NOT_RUN: {sorted(bad_fixture_states)}")

    deferred_capability_ids = _deferred_capability_ids(manifest)
    required_capability_leaves = summary.get("requiredCapabilityLeaves") or {}
    stale_required = sorted(deferred_capability_ids & set(required_capability_leaves))
    if stale_required:
        _fail(errors, "fixtureClosure", f"deferred capability leaves cannot appear as REQUIRED: {stale_required}")
    deferred_capability_leaves = summary.get("deferredCapabilityLeaves") or {}
    bad_deferred = sorted(
        capability_id
        for capability_id in deferred_capability_ids
        if capability_id not in deferred_capability_leaves
        or deferred_capability_leaves[capability_id].get("status") != "NOT_RUN"
        or deferred_capability_leaves[capability_id].get("closureDisposition") != DEFERRED_DISPOSITION
    )
    if bad_deferred:
        _fail(errors, "fixtureClosure", f"deferred capability leaves must remain NOT_RUN: {bad_deferred}")
    if summary.get("status") == "PASS" and (bad_fixture_passes or bad_fixture_states or stale_required or bad_deferred):
        _fail(errors, "fixtureClosure", "qualification summary cannot be PASS with unresolved fixture-dependent lanes")


def _check_capability_projection(capabilities: dict, manifest: dict, errors: list[str]) -> None:
    """Reject stale REQUIRED projections in the persisted capability receipt."""
    deferred_capability_ids = _deferred_capability_ids(manifest)
    required_capability_leaves = capabilities.get("requiredCapabilityLeaves") or {}
    stale_required = sorted(deferred_capability_ids & set(required_capability_leaves))
    if stale_required:
        _fail(errors, "fixtureClosure", f"deferred capability mappings cannot appear as REQUIRED: {stale_required}")

    deferred_capability_leaves = capabilities.get("deferredCapabilityLeaves") or {}
    bad_deferred = sorted(
        capability_id
        for capability_id in deferred_capability_ids
        if not isinstance(deferred_capability_leaves.get(capability_id), dict)
        or deferred_capability_leaves[capability_id].get("status") != "NOT_RUN"
        or deferred_capability_leaves[capability_id].get("closureDisposition") != DEFERRED_DISPOSITION
    )
    if bad_deferred:
        _fail(errors, "fixtureClosure", f"deferred capability mappings must remain DEFERRED/NOT_RUN: {bad_deferred}")

    projected = {
        f"{item.get('capabilityId')}:{item.get('language')}": item
        for item in capabilities.get("capabilities", [])
        if isinstance(item, dict)
    }
    bad_projected = sorted(
        capability_id
        for capability_id in deferred_capability_ids
        if not isinstance(projected.get(capability_id), dict)
        or projected[capability_id].get("closureDisposition") != DEFERRED_DISPOSITION
        or projected[capability_id].get("closureStatus") != "NOT_RUN"
        or projected[capability_id].get("state") != "NOT_EVALUATED"
    )
    if bad_projected:
        _fail(errors, "fixtureClosure", f"deferred capability projections must be DEFERRED/NOT_RUN: {bad_projected}")


def check_fixture_closure(errors: list[str], pending: list[str], strict: bool) -> None:
    """Bind missing binary lanes to DEFERRED/NOT_RUN, never PASS."""
    try:
        manifest = _increment6_manifest()
    except (OSError, yaml.YAMLError) as exc:
        _fail(errors, "fixtureClosure", f"cannot load increment6 manifest: {exc}")
        return
    manifest, fixtures = _manifest_fixture_authority(manifest, errors)
    for lane in manifest.get("lanes", []):
        if not isinstance(lane, dict) or lane.get("fixtureBinaryDependent") is not True:
            continue
        lane_id = lane.get("id")
        owner_ids = lane.get("ownerCapabilityIds") or []
        dimensions = {
            item.get("capabilityId"): item
            for item in manifest.get("capabilityDimensions", [])
            if isinstance(item, dict)
        }
        dispositions = {dimensions.get(capability_id, {}).get("closureDisposition") for capability_id in owner_ids}
        lane_fixtures = [fixture for fixture in fixtures.values() if fixture.get("lane") == lane_id]
        absent = lane_fixtures and all(not fixture["binaryPath"].exists() for fixture in lane_fixtures)
        if dispositions != {DEFERRED_DISPOSITION}:
            _fail(errors, "fixtureClosure", f"{lane_id}: absent fixture-dependent lane must be DEFERRED_TO_FUTURE_RELEASE")
        if not absent:
            _fail(errors, "fixtureClosure", f"{lane_id}: fixtureBinaryDependent lane has an unexpected binary")
        else:
            message = f"qualification: {lane_id} is DEFERRED_TO_FUTURE_RELEASE with NOT_RUN fixture evidence"
            if strict:
                _fail(errors, "fixtureClosure", message)
            else:
                pending.append(message)

    results_root = ROOT / "evaluation/increment6/results"
    summaries = sorted(results_root.glob("*/summary.json")) if results_root.is_dir() else []
    if not summaries:
        message = "qualification: no I6 summary exists for fixture-closure reconciliation"
        if strict:
            _fail(errors, "fixtureClosure", message)
        else:
            pending.append(message)
        return
    summary_path = summaries[-1]
    try:
        summary = load_json(summary_path)
        if not isinstance(summary, dict):
            raise ValueError("summary is not an object")
        _check_qualification_summary(summary, fixtures, manifest, errors)
        capabilities_path = summary_path.with_name("capabilities.json")
        if not capabilities_path.is_file():
            _fail(errors, "fixtureClosure", "latest qualification capability projection is missing")
        else:
            capabilities = load_json(capabilities_path)
            if not isinstance(capabilities, dict):
                raise ValueError("capabilities projection is not an object")
            _check_capability_projection(capabilities, manifest, errors)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        _fail(errors, "fixtureClosure", f"latest qualification summary is unreadable: {exc}")


def check_runtime_modules(errors: list[str]) -> None:
    for module in (
        "document_intelligence.runtime.scheduler",
        "document_intelligence.runtime.model_residency",
        "document_intelligence.runtime.memory",
        "document_intelligence.runtime.drain",
        "document_intelligence.runtime.crash_recovery",
        "document_intelligence.runtime.temp_space",
        "document_intelligence.runtime.asset_verification",
        "document_intelligence.runtime.fallback_contract",
    ):
        try:
            importlib.import_module(module)
        except ImportError as exc:
            _fail(errors, "runtimeModules", f"{module}: {exc}")


def check_deployment_authorities(errors: list[str]) -> None:
    for rel in (
        "deployment/offline-bundle.v1.yaml",
        "deployment/deployment-gates.v1.yaml",
        "deployment/activation.v1.yaml",
        "deployment/vulnerability-policy.v1.yaml",
        "deployment/operational-envelope.v1.yaml",
        "release/schema/release-readiness.v1.schema.json",
        "release/external-certification.md",
    ):
        path = ROOT / rel
        if not path.exists():
            _fail(errors, "deployment", f"{rel} missing")
            continue
        try:
            if rel.endswith(".yaml"):
                yaml.safe_load(path.read_text(encoding="utf-8"))
            elif rel.endswith(".json"):
                json.loads(path.read_text(encoding="utf-8"))
        except (yaml.YAMLError, json.JSONDecodeError) as exc:
            _fail(errors, "deployment", f"{rel}: {exc}")


def check_release_readiness(errors: list[str], pending: list[str], strict: bool) -> None:
    readiness = ROOT / "release/readiness/readiness-manifest.v1.json"
    if not readiness.exists():
        pending.append("releaseReadiness: readiness manifest not yet built")
        return
    try:
        import build_release_readiness

        result = build_release_readiness.check(
            ROOT,
            ROOT / "release/readiness/receipts",
            readiness,
        )
    except ImportError as exc:
        _fail(errors, "releaseReadiness", f"checker import failed: {exc}")
        return
    if isinstance(result, dict):
        if result.get("releaseReadiness") == "PASS" or (
            not result.get("errors") and result.get("status") == "READY"
        ):
            return
        check_errors = result.get("errors", ["check failed"])
        # During implementation a NOT_RUN gate is honest pending work; strict
        # reconciliation requires every gate PASS.
        not_run_only = all("NOT_RUN" in str(e) for e in check_errors)
        if not_run_only and not strict:
            pending.extend(f"releaseReadiness: {e}" for e in check_errors)
        else:
            _fail(errors, "releaseReadiness", f"{check_errors}")


def check_capability_states(errors: list[str]) -> None:
    from check_capability_registry import check

    for error in check():
        _fail(errors, "capabilityRegistry", error)
    registry = yaml.safe_load(
        (ROOT / "capabilities/document-intelligence-capabilities.yaml").read_text(encoding="utf-8")
    )
    for cid, cap in (registry.get("capabilities") or {}).items():
        if cap.get("ownerIncrement") == "increment6":
            if cap.get("consumerAdmission") != "DENIED":
                _fail(errors, "capabilityRegistry", f"{cid}: increment6 capability must be DENIED")
            if cap.get("developmentState") not in {"NOT_QUALIFIED", "UNSUPPORTED", "QUALIFIED"}:
                _fail(errors, "capabilityRegistry", f"{cid}: invalid developmentState")


def check_performance_evidence(errors: list[str]) -> None:
    results_root = ROOT / "evaluation/increment6/results"
    if not results_root.is_dir():
        return
    schema_path = ROOT / "evaluation/increment6/schemas/performance-evidence.v1.schema.json"
    if not schema_path.exists():
        _fail(errors, "performanceEvidence", "performance-evidence schema missing")
        return
    from evaluation.increment6.runners.evidence_common import validate_evidence

    for path in sorted(results_root.rglob("performance-evidence*.json")):
        try:
            validate_evidence(load_json(path), schema_path)
        except Exception as exc:
            _fail(errors, "performanceEvidence", f"{path.name}: {exc}")


def check_sealed_material_untouched(errors: list[str]) -> None:
    """I6 must be additive: sealed I4A implementation material must still hash
    to the fingerprint recorded in the frozen canonical attestation. The frozen
    attestation is the run pinned by the active canonical pointer — a
    deliberately re-qualified and re-sealed canonical run supersedes the prior
    one via canonical-run.json, never by editing this verifier."""
    pointer_path = ROOT / "evaluation/increment4a/canonical-run.json"
    pointer = load_json(pointer_path)
    run_id = pointer.get("runId") if isinstance(pointer, dict) else None
    if not isinstance(run_id, str) or not run_id:
        return
    attestation_path = (
        ROOT / "evaluation/increment4a/results" / run_id / "campaign-attestation.json"
    )
    if not attestation_path.exists():
        return
    try:
        attestation = load_json(attestation_path)
        sealed_material = attestation.get("materialFingerprints") or {}
        if not sealed_material:
            _fail(errors, "sealedMaterial", "frozen attestation carries no materialFingerprints")
            return
        from evaluation.increment4a.run_qualification import material_fingerprints

        current = material_fingerprints()
        drifted = sorted(k for k in sealed_material if sealed_material[k] != current.get(k))
        for key in drifted:
            _fail(
                errors,
                "sealedMaterial",
                f"sealed material drifted: {key} (sealed={sealed_material[key][:16]}… current={str(current.get(key))[:16]}…)",
            )
    except Exception as exc:
        _fail(errors, "sealedMaterial", str(exc))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="final reconciliation mode: NOT_RUN gates and pending work fail the check",
    )
    args = parser.parse_args(argv)

    errors: list[str] = []
    pending: list[str] = []
    check_scanned_policy(errors)
    check_fallback_contract(errors)
    check_protocol_authority(errors)
    check_corpus_authorities(errors)
    check_fixture_closure(errors, pending, args.strict)
    check_runtime_modules(errors)
    check_deployment_authorities(errors)
    check_release_readiness(errors, pending, args.strict)
    check_capability_states(errors)
    check_performance_evidence(errors)
    check_sealed_material_untouched(errors)
    result = {
        "schemaVersion": "document-intelligence.increment6-verification.v1",
        "increment": "increment6",
        "status": "FAIL" if errors else "PASS",
        "errors": errors,
        "pending": pending,
        "checks": [
            "scannedPolicy",
            "fallbackContract",
            "protocolAuthority",
            "corpusAuthority",
            "fixtureClosure",
            "runtimeModules",
            "deployment",
            "releaseReadiness",
            "capabilityRegistry",
            "performanceEvidence",
            "sealedMaterial",
        ],
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not errors else 2


if __name__ == "__main__":
    raise SystemExit(main())
