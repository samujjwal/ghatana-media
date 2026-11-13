#!/usr/bin/env python3
"""PROF-04 — default-catalog stability check.

profiles/default.yaml is a documentary manifest of the implicit default
runtime (the configuration reached when DOCUMENT_INTELLIGENCE_PROFILE_PATH is
unset). This script asserts the manifest still matches the code-level defaults
in src/document_intelligence/config.py and limits.py:

* enabledProviders / mediaTypes / languages equal the implicit runtime
  defaults, and every enumerated provider is inside the known Increment-3
  catalog;
* the documented limits block equals the Limits() dataclass defaults.

Candidate code must never change the no-profile admission surface; any drift
fails this check with a nonzero exit.
"""

from __future__ import annotations

import sys
from dataclasses import fields as dataclass_fields
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from document_intelligence.config import WorkerSettings  # noqa: E402
from document_intelligence.limits import Limits  # noqa: E402

PROFILE_PATH = ROOT / "profiles" / "default.yaml"

# The complete Increment-3 provider catalog: the only provider refs the
# default runtime may ever enumerate.
KNOWN_INCREMENT3_PROVIDERS = frozenset(
    {
        "ghatana.docling",
        "ghatana.paddleocr",
        "ghatana.gliner",
        "ghatana.minilm",
    }
)


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def main() -> int:
    errors: list[str] = []
    manifest = yaml.safe_load(PROFILE_PATH.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        print(f"{PROFILE_PATH}: manifest is not a mapping", file=sys.stderr)
        return 1

    if manifest.get("schemaVersion") != "document-intelligence.profile.v1":
        errors.append("schemaVersion must be document-intelligence.profile.v1")
    if manifest.get("profileId") != "default":
        errors.append("profileId must be 'default'")
    if manifest.get("runtimeLoadable") is not False:
        errors.append("runtimeLoadable must be false (documentary manifest)")

    defaults = WorkerSettings()

    documented_providers = list(manifest.get("enabledProviders") or [])
    if documented_providers != list(defaults.enabled_providers):
        errors.append(
            f"enabledProviders drift: manifest={documented_providers} runtime={list(defaults.enabled_providers)}"
        )
    unknown = set(documented_providers) - KNOWN_INCREMENT3_PROVIDERS
    if unknown:
        errors.append(f"enabledProviders outside the known Increment-3 catalog: {sorted(unknown)}")

    documented_media = list(manifest.get("mediaTypes") or [])
    if documented_media != list(defaults.allowed_media_types):
        errors.append(
            f"mediaTypes drift: manifest={documented_media} runtime={list(defaults.allowed_media_types)}"
        )

    documented_languages = list(manifest.get("languages") or [])
    if documented_languages != list(defaults.enabled_languages):
        errors.append(
            f"languages drift: manifest={documented_languages} runtime={list(defaults.enabled_languages)}"
        )

    documented_limits = manifest.get("limits") or {}
    runtime_limits = {_camel(field.name): getattr(Limits(), field.name) for field in dataclass_fields(Limits)}
    if documented_limits != runtime_limits:
        errors.append(
            f"limits drift: manifest={documented_limits} runtime={runtime_limits}"
        )

    if errors:
        for error in errors:
            print(f"DRIFT: {error}", file=sys.stderr)
        return 1
    print("default catalog is stable: manifest matches implicit runtime defaults")
    return 0


if __name__ == "__main__":
    sys.exit(main())
