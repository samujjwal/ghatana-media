from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256 = "2c8abd115056526510def605099a1aead08ab28071d4928e4619875534a455ab"
# The public frozen catalog identity is the SHA-256 of the pinned authority
# artifact. Keep the normalized runtime-record digest separate from it.
FROZEN_INCREMENT3_PROVIDER_CATALOG_FINGERPRINT = FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256
FROZEN_INCREMENT3_PROVIDER_CATALOG_SEMANTIC_FINGERPRINT = "6367391fe662f672dba52eb6b0d566a0c61e7e71f9b6a73aba5789d158ddd952"

_BOOLEAN_FIELDS = (
    "supportsTables",
    "supportsCoordinates",
    "supportsLanguages",
    "supportsConfidenceScores",
    "supportsMultipleCardinality",
)
_FIELDS = (
    "providerRef",
    "providerVersion",
    "modelRef",
    "modelVersion",
    "languages",
    "mediaTypes",
    "valueTypes",
    "capabilityIds",
    "features",
    "maxDimensions",
    "supportsTables",
    "supportsCoordinates",
    "supportsLanguages",
    "supportsConfidenceScores",
    "supportsMultipleCardinality",
    "promotionStatus",
)


def _strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({item for item in value if isinstance(item, str) and item})


def _declared_languages(value: Any) -> list[str]:
    if not isinstance(value, str) or value == "und":
        return []
    if len(value) in (2, 3) and value.isalpha() and value.islower():
        return [value]
    if value.startswith("multilingual-"):
        return [item for item in value.removeprefix("multilingual-").split("-") if len(item) in (2, 3) and item.isalpha()]
    return []


def _languages(model: dict[str, Any], capabilities: dict[str, Any]) -> list[str]:
    accepted = _strings(capabilities.get("languages", capabilities.get("supportedLanguages")))
    declared = _declared_languages(model.get("language"))
    if declared:
        return sorted(set(declared) & set(accepted)) if accepted else declared
    return accepted


def _record(
    model: dict[str, Any],
    capabilities: dict[str, Any],
    languages: list[str],
    promotion_status: Any = "ACCEPTED",
) -> dict[str, Any]:
    provider_ref = model.get("providerRef")
    provider_version = model.get("providerVersion")
    model_ref = model.get("modelRef")
    model_version = model.get("modelVersion", model.get("modelRevision"))
    if not all(isinstance(value, str) and value for value in (provider_ref, provider_version, model_ref, model_version)):
        raise ValueError("provider authority contains an incomplete model identity")
    dimensions = capabilities.get("maxDimensions", model.get("expectedDimensions"))
    return {
        "providerRef": provider_ref,
        "providerVersion": provider_version,
        "modelRef": model_ref,
        "modelVersion": model_version,
        "languages": sorted(set(languages)),
        "mediaTypes": _strings(capabilities.get("mediaTypes")),
        "valueTypes": _strings(capabilities.get("supportedValueTypes", capabilities.get("valueTypes"))),
        "capabilityIds": _strings(capabilities.get("capabilityIds")),
        "features": _strings(capabilities.get("features")),
        "maxDimensions": dimensions if isinstance(dimensions, int) and dimensions > 0 else None,
        "supportsTables": capabilities.get("supportsTables") if isinstance(capabilities.get("supportsTables"), bool) else None,
        "supportsCoordinates": capabilities.get("supportsCoordinates") if isinstance(capabilities.get("supportsCoordinates"), bool) else None,
        "supportsLanguages": capabilities.get("supportsLanguages") if isinstance(capabilities.get("supportsLanguages"), bool) else None,
        "supportsConfidenceScores": capabilities.get("supportsConfidenceScores") if isinstance(capabilities.get("supportsConfidenceScores"), bool) else None,
        "supportsMultipleCardinality": capabilities.get("supportsMultipleCardinality") if isinstance(capabilities.get("supportsMultipleCardinality"), bool) else None,
        "promotionStatus": promotion_status if promotion_status in {"ACCEPTED", "UNPROMOTED"} else "UNPROMOTED",
    }


def _record_key(record: dict[str, Any]) -> tuple[str, str, str, str, str]:
    languages = record.get("languages", [])
    language = languages[0] if languages else ""
    return (
        str(record.get("providerRef", "")),
        language,
        str(record.get("providerVersion", "")),
        str(record.get("modelRef", "")),
        str(record.get("modelVersion", "")),
    )


def expand_language_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Canonicalize one shared model declaration into per-language material."""
    expanded: list[dict[str, Any]] = []
    for record in records:
        languages = _strings(record.get("languages"))
        for language in languages or [""]:
            item = {field: record.get(field) for field in _FIELDS}
            item["languages"] = [language] if language else []
            expanded.append(item)
    return sorted(expanded, key=_record_key)


def authority_records_from_artifact(artifact: Any) -> list[dict[str, Any]]:
    """Project the frozen Increment-3 evaluation catalog onto semantic runtime fields."""
    if not isinstance(artifact, dict):
        raise ValueError("provider authority is malformed")
    accepted = artifact.get("accepted")
    declared = artifact.get("declared")
    if not isinstance(accepted, list) or not isinstance(declared, dict) or not isinstance(declared.get("models"), list):
        raise ValueError("provider authority does not contain the frozen Increment-3 catalog")

    capabilities_by_provider: dict[str, dict[str, Any]] = {}
    for item in accepted:
        if not isinstance(item, dict) or not isinstance(item.get("providerRef"), str) or not isinstance(item.get("capabilities"), dict):
            raise ValueError("provider authority contains an invalid admitted capability")
        capabilities_by_provider[item["providerRef"]] = item["capabilities"]

    records: list[dict[str, Any]] = []
    for model in declared["models"]:
        if not isinstance(model, dict):
            raise ValueError("provider authority contains an invalid model declaration")
        capabilities = capabilities_by_provider.get(model.get("providerRef"))
        if capabilities is None:
            continue
        records.append(_record(model, capabilities, _languages(model, capabilities)))
    if not records:
        raise ValueError("provider authority contains no admitted models")
    return expand_language_records(records)


def normalize_observed_catalog(value: Any) -> list[dict[str, Any]]:
    """Normalize live /v1/providers data, including language-specific model bindings."""
    providers = value.get("providers") if isinstance(value, dict) else value
    if not isinstance(providers, list):
        raise ValueError("live provider catalog is malformed")
    records: list[dict[str, Any]] = []
    for provider in providers:
        if not isinstance(provider, dict):
            raise ValueError("live provider catalog contains an invalid entry")
        identity = {
            "providerRef": provider.get("providerRef"),
            "providerVersion": provider.get("providerVersion"),
            "modelRef": provider.get("modelRef"),
            "modelVersion": provider.get("modelVersion"),
        }
        capabilities = {
            "languages": provider.get("languages", provider.get("supportedLanguages", [])),
            "mediaTypes": provider.get("mediaTypes", []),
            "supportedValueTypes": provider.get("supportedValueTypes", []),
            "capabilityIds": provider.get("capabilityIds", []),
            "features": provider.get("features", []),
            "maxDimensions": provider.get("maxDimensions"),
            **{field: provider.get(field) for field in _BOOLEAN_FIELDS},
        }
        language_identities = provider.get("languageModelIdentities")
        if isinstance(language_identities, list) and language_identities:
            admitted_languages = set(_strings(capabilities["languages"]))
            for language_identity in language_identities:
                if not isinstance(language_identity, dict):
                    continue
                language = language_identity.get("language")
                if not isinstance(language, str) or (admitted_languages and language not in admitted_languages):
                    continue
                model = {**identity, **language_identity}
                records.append(_record(model, capabilities, [language], provider.get("promotionStatus")))
        else:
            records.append(_record(identity, capabilities, _strings(capabilities["languages"]), provider.get("promotionStatus")))
    return expand_language_records(records)


def fingerprint_records(records: list[dict[str, Any]]) -> str:
    canonical = json.dumps(sorted(records, key=_record_key), ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def compare_provider_authority(expected: list[dict[str, Any]], observed: list[dict[str, Any]]) -> dict[str, Any]:
    """Return a deterministic exact semantic diff suitable for readiness and evidence."""
    expected_by_key = {(record["providerRef"], tuple(record.get("languages", []))): record for record in expected}
    observed_by_key = {(record["providerRef"], tuple(record.get("languages", []))): record for record in observed}
    missing: list[dict[str, Any]] = []
    unexpected: list[dict[str, Any]] = []
    mismatched: list[dict[str, Any]] = []
    for key in sorted(expected_by_key.keys() - observed_by_key.keys()):
        record = expected_by_key[key]
        missing.append({field: record[field] for field in ("providerRef", "modelRef", "modelVersion", "languages")})
    for key in sorted(observed_by_key.keys() - expected_by_key.keys()):
        record = observed_by_key[key]
        unexpected.append({field: record[field] for field in ("providerRef", "modelRef", "modelVersion", "languages")})
    for key in sorted(expected_by_key.keys() & observed_by_key.keys()):
        expected_record = expected_by_key[key]
        observed_record = observed_by_key[key]
        differences = {
            field: {"expected": expected_record.get(field), "observed": observed_record.get(field)}
            for field in _FIELDS
            if field not in {"providerRef", "languages"} and expected_record.get(field) != observed_record.get(field)
        }
        if differences:
            mismatched.append({
                "providerRef": expected_record["providerRef"],
                "languages": expected_record.get("languages", []),
                "fields": differences,
            })
    return {
        "expected": expected,
        "observed": observed,
        "missing": missing,
        "unexpected": unexpected,
        "mismatched": mismatched,
        "expectedFingerprint": fingerprint_records(expected),
        "observedFingerprint": fingerprint_records(observed),
    }


def read_authority(path: Path, expected_sha256: str | None = None) -> tuple[list[dict[str, Any]], str]:
    raw_bytes = path.read_bytes()
    try:
        artifact = json.loads(raw_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("provider authority is malformed") from exc
    source_fingerprint = hashlib.sha256(raw_bytes).hexdigest()
    if expected_sha256 is not None and source_fingerprint != expected_sha256:
        raise ValueError("provider authority fingerprint does not match frozen authority")
    return authority_records_from_artifact(artifact), source_fingerprint


def public_authority_diagnostics(diff: dict[str, Any]) -> dict[str, Any]:
    """Keep readiness details useful while omitting paths and capability internals."""
    def identity(record: dict[str, Any]) -> dict[str, Any]:
        languages = record.get("languages", [])
        return {
            "providerRef": record.get("providerRef"),
            "modelRef": record.get("modelRef"),
            "language": languages[0] if languages else None,
        }

    return {
        "expectedFingerprint": diff["expectedFingerprint"],
        "observedFingerprint": diff["observedFingerprint"],
        "missing": [identity(record) for record in diff["missing"]],
        "unexpected": [identity(record) for record in diff["unexpected"]],
        "mismatched": [
            {
                "providerRef": item["providerRef"],
                "language": item["languages"][0] if item.get("languages") else None,
                "expectedModelRef": item["fields"].get("modelRef", {}).get("expected"),
                "observedModelRef": item["fields"].get("modelRef", {}).get("observed"),
                "fields": sorted(item["fields"]),
            }
            for item in diff["mismatched"]
        ],
    }
