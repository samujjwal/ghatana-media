#!/usr/bin/env python3
"""Compose the cumulative Increment-4A runtime provider authority.

The Increment-4A profile must extend the frozen Increment-3 provider baseline,
never replace it.  This script merges the frozen Increment-3 admitted catalog
with the accepted Increment-4A capability delta and emits the provider
authority the ``increment4a`` worker profile loads at startup.

Capabilities that measured below their frozen thresholds and were deferred to
a future release — or are unsupported by design — are preserved under
``excluded`` and are never admitted.  The artifact carries only
content-derived provenance so the pinned profile SHA-256 stays stable across
canonical run regeneration.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
LANE = ROOT / "evaluation/increment4a"
INCREMENT3_AUTHORITY = ROOT / "evaluation/results/20260919T022904Z-cf9e659f/capabilities.json"
DEFAULT_PROFILE = ROOT / "profiles/increment4a.yaml"
DEFAULT_OUTPUT = ROOT / "capabilities/increment4a.runtime-authority.json"

# The frozen Increment-3 lanes predate the provider-neutral capability-id
# scheme.  These identifiers name the already-frozen baseline surfaces so the
# composed authority keeps them admissible under exact capability admission.
BASELINE_CAPABILITY_PROJECTION = {
    "ghatana.docling": {
        "capabilityIds": ["parser.pdf.text.en", "parser.pdf.text.ne"],
        "features": ["text"],
        "languages": ["en", "ne"],
    },
    "ghatana.gliner": {
        "capabilityIds": ["extraction.schema-guided.en", "extraction.schema-guided.ne"],
        "features": ["extraction"],
        "languages": ["en", "ne"],
        "mediaTypes": ["application/vnd.ghatana.parsed-document+json"],
    },
    "ghatana.minilm": {
        "capabilityIds": ["embedding.document-structure"],
        "features": ["embedding"],
        "languages": [],
    },
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _providers() -> dict:
    sys.path.insert(0, str(ROOT / "src"))
    from document_intelligence.providers import (
        DoclingParser, DoclingPptxParser, DoclingXlsxParser, GlinerExtractor,
        HybridPdfParser, MiniLmEmbedder, OfficeRenderedParser, PaddleOcrParser,
        ResilientParser, TesseractOcrParser,
    )
    from document_intelligence.strategies.resilient_parser import load_parser_routing

    routes, max_attempts, minimum_budget = load_parser_routing(ROOT / "routing/parser-routing.v1.yaml")
    return {
        "ghatana.docling": DoclingParser(),
        "ghatana.paddleocr": PaddleOcrParser(admitted_languages=("en", "ne", "hi", "mr")),
        "ghatana.gliner": GlinerExtractor(),
        "ghatana.minilm": MiniLmEmbedder(),
        "ghatana.docling-docx": OfficeRenderedParser(),
        "ghatana.docling-pptx": DoclingPptxParser(),
        "ghatana.docling-xlsx": DoclingXlsxParser(),
        "ghatana.tesseractocr": TesseractOcrParser(),
        "ghatana.hybrid-pdf": HybridPdfParser(),
        "ghatana.resilient-parser": ResilientParser(routes, max_attempts=max_attempts, minimum_remaining_budget_ms=minimum_budget),
    }


def _canonical_capabilities() -> tuple[str, dict]:
    candidate = _load_verified_canonical_candidate()
    return candidate["runId"], candidate["capabilities"]


def _load_verified_canonical_candidate() -> dict:
    """Use the capability promoter's strict canonical-evidence gate.

    The runtime authority is a downstream promotion artifact, so it must not
    accept a caller-supplied capabilities file or a bare canonical pointer as
    its evidence source.
    """
    promoter_path = ROOT / "scripts/promote_increment4a_capabilities.py"
    spec = importlib.util.spec_from_file_location("increment4a_runtime_authority_promoter", promoter_path)
    if spec is None or spec.loader is None:
        raise ValueError("Increment-4A capability promoter is unavailable")
    promoter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(promoter)
    promoter.ROOT = ROOT
    promoter.LANE = LANE
    return promoter.load_verified_canonical_candidate()


def _compose_capabilities(provider_ref: str, baseline: dict, provider: object, items: list[dict]) -> dict:
    provider_caps = provider.capabilities() if hasattr(provider, "capabilities") else {}
    capabilities: dict = dict(provider_caps)
    capabilities.update({key: value for key, value in baseline.items()})
    projection = BASELINE_CAPABILITY_PROJECTION.get(provider_ref, {})
    languages = sorted(
        set(projection.get("languages", []))
        | set(baseline.get("supportedLanguages", baseline.get("languages", [])))
        | {item["language"] for item in items if isinstance(item.get("language"), str) and item["language"]}
    )
    if languages:
        capabilities["supportedLanguages"] = languages
    # The admitted media surface is the qualified evidence, not the provider's
    # theoretical routing surface — e.g. resilient-parser is only promoted for
    # the image fallback lane even though it can route every profile type.
    media_types = sorted(
        set(projection.get("mediaTypes", []))
        | set(baseline.get("mediaTypes", []))
        | {media_type for item in items for media_type in item.get("mediaTypes", []) if isinstance(media_type, str)}
    )
    if media_types:
        capabilities["mediaTypes"] = media_types
    capability_ids = sorted(set(projection.get("capabilityIds", [])) | {item["capabilityId"] for item in items})
    if capability_ids:
        capabilities["capabilityIds"] = capability_ids
    features = sorted(set(projection.get("features", [])) | {item["feature"] for item in items if isinstance(item.get("feature"), str) and item["feature"]})
    if features:
        capabilities["features"] = features
    return capabilities


def _declared_models(providers: dict, increment3_models: list[dict], accepted: list[dict]) -> list[dict]:
    declared = [dict(model) for model in increment3_models]
    covered = {(model.get("providerRef"), model.get("language")) for model in declared}
    accepted_languages = {
        item["providerRef"]: set() for item in accepted
    }
    for item in accepted:
        if isinstance(item.get("language"), str) and item["language"]:
            accepted_languages.setdefault(item["providerRef"], set()).add(item["language"])
    for provider_ref, provider in providers.items():
        if not any(item.get("providerRef") == provider_ref for item in accepted):
            continue
        identities = provider.language_model_identities() if hasattr(provider, "language_model_identities") else ()
        wanted = accepted_languages.get(provider_ref, set())
        if identities:
            for identity in identities:
                language = identity.get("language")
                if language not in wanted or (provider_ref, language) in covered:
                    continue
                template = next(
                    (model for model in declared if model.get("providerRef") == provider_ref and model.get("modelRef") == identity.get("modelRef") and model.get("modelRevision", model.get("modelVersion")) == identity.get("modelVersion")),
                    None,
                )
                entry = dict(template) if template is not None else {
                    "artifact": "declared-by-lock",
                    "downloadSource": "local-package-cache",
                    "licenseRef": "paddleocr-license",
                    "providerRef": provider_ref,
                    "providerVersion": "0.1.0",
                    "runtime": "paddlepaddle",
                }
                entry.update({
                    "language": language,
                    "modelRef": identity["modelRef"],
                    "modelRevision": identity["modelVersion"],
                })
                declared.append(entry)
                covered.add((provider_ref, language))
            continue
        if any(model.get("providerRef") == provider_ref for model in declared):
            continue
        identity = provider.identity()
        declared.append({
            "artifact": "declared-by-lock",
            "downloadSource": "worker-runtime",
            "language": "und",
            "licenseRef": "apache-2.0",
            "modelRef": identity["modelRef"],
            "modelRevision": identity["modelVersion"],
            "providerRef": provider_ref,
            "providerVersion": identity["providerVersion"],
            "runtime": "python",
        })
        covered.add((provider_ref, "und"))
    return declared


def build(
    capabilities_source: dict,
    increment3: dict,
    providers: dict,
) -> dict:
    accepted_items = capabilities_source.get("accepted")
    if not isinstance(accepted_items, list):
        raise ValueError("Increment-4A capability source does not contain accepted[]")
    baseline_by_provider = {
        item["providerRef"]: item["capabilities"]
        for item in increment3.get("accepted", [])
        if isinstance(item, dict) and isinstance(item.get("capabilities"), dict)
    }
    accepted: list[dict] = []
    for provider_ref in sorted({item["providerRef"] for item in accepted_items} | set(baseline_by_provider)):
        provider = providers.get(provider_ref)
        if provider is None:
            raise ValueError(f"accepted capability references an unknown provider: {provider_ref}")
        items = [item for item in accepted_items if item.get("providerRef") == provider_ref]
        accepted.append({
            "providerRef": provider_ref,
            "capabilities": _compose_capabilities(provider_ref, baseline_by_provider.get(provider_ref, {}), provider, items),
        })
    excluded = [
        {
            "capabilityId": item["capabilityId"],
            "state": item["state"],
            "closureDisposition": item["closureDisposition"],
        }
        for item in capabilities_source.get("capabilities", [])
        if isinstance(item, dict) and item.get("state") != "QUALIFIED"
    ]
    declared = _declared_models(providers, increment3["declared"]["models"], accepted_items)
    return {
        "schemaVersion": "increment4a.runtime-authority.v1",
        "baselineAuthoritySha256": sha256(INCREMENT3_AUTHORITY),
        "increment4aAcceptedFingerprint": digest(accepted_items),
        "sources": {
            "increment3Authority": str(INCREMENT3_AUTHORITY.relative_to(ROOT)),
            "increment4aCapabilities": "canonical-run capabilities.json",
        },
        "excluded": sorted(excluded, key=lambda item: item["capabilityId"]),
        "accepted": accepted,
        "declared": {
            "manifestVersion": increment3["declared"].get("manifestVersion", "document-intelligence.models.v1"),
            "offlineByDefault": increment3["declared"].get("offlineByDefault", True),
            "models": declared,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capabilities", type=Path, default=None, help="capabilities.json to compose from; defaults to the canonical run")
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    if not args.profile.is_file():
        raise ValueError("increment4a profile is missing")
    profile = yaml.safe_load(args.profile.read_text(encoding="utf-8"))
    candidate = _load_verified_canonical_candidate()
    canonical_capabilities_path = LANE / "results" / candidate["runId"] / "capabilities.json"
    if args.capabilities is not None:
        try:
            supplied_bytes = args.capabilities.read_bytes()
            canonical_bytes = canonical_capabilities_path.read_bytes()
        except OSError as error:
            raise ValueError("the requested capabilities input is unavailable") from error
        if supplied_bytes != canonical_bytes:
            raise ValueError("runtime authority can only be built from the strictly verified canonical capabilities")
    capabilities_source = candidate["capabilities"]
    increment3 = json.loads(INCREMENT3_AUTHORITY.read_text(encoding="utf-8"))
    artifact = build(
        capabilities_source,
        increment3,
        _providers(),
    )
    admitted = {item["providerRef"] for item in artifact["accepted"]}
    enabled = set(profile.get("enabledProviders", []))
    unadmitted = enabled - admitted
    if unadmitted - {"ghatana.tesseractocr", "ghatana.ooxml-docx", "ghatana.ooxml-pptx", "ghatana.ooxml-xlsx"}:
        raise ValueError(f"enabled providers without any admitted capability: {sorted(unadmitted)}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "sha256": sha256(args.output), "acceptedProviders": len(artifact["accepted"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
