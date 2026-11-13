"""Language-resolution authority implementation (I6-58).

Resolution order (``routing/language-resolution.v1.yaml``):

    validatedRequestHint -> profileDefault -> detection -> fallback/error

The request hint is validated upstream by ``RequestMetadata.parse`` (frozen
Increment-4A surface): unknown hints are rejected with UNSUPPORTED_LANGUAGE
before resolution runs.  Resolution therefore only decides what to propagate
when the hint is *absent* — today that propagates ``None`` and providers
reject it; resolution must never weaken that rejection, so a policy that
yields no language returns ``source=NONE`` and the caller keeps the
existing provider-side rejection.

Devanagari ambiguity: ``ne``/``hi``/``mr`` share script identity, so a
script-level detection may never select among them — a validated hint or an
explicit policy default is required.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

WORKER_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_AUTHORITY = WORKER_ROOT / "routing" / "language-resolution.v1.yaml"

# Languages sharing Devanagari script identity: script-level detection can
# never distinguish them (hint or explicit policy required).
DEVANAGARI_AMBIGUITY = frozenset({"ne", "hi", "mr"})

_SOURCES = frozenset({"HINT", "PROFILE", "DETECTION", "DEFAULT", "NONE"})


@dataclass(frozen=True, slots=True)
class LanguageResolution:
    """Resolution outcome: the selected language (or None) plus its reason."""

    language: str | None
    reason_code: str
    source: str  # HINT | PROFILE | DETECTION | DEFAULT | NONE


def normalize_language_input(value: str) -> str:
    """NFC-normalize a language/hint input string (input level only)."""
    return unicodedata.normalize("NFC", value)


def resolve_language(
    hint: str | None,
    *,
    media_type: str,
    candidate_languages: tuple[str, ...],
    default_language: str | None = None,
    detection_enabled: bool = False,
) -> LanguageResolution:
    """Resolve the working language for a request.

    ``media_type`` is carried for future media-aware detection policy; the
    current authority admits no detector output.  ``candidate_languages`` is
    the admitted request-language set (settings.request_languages).
    """

    candidates = tuple(candidate_languages)
    if hint is not None:
        normalized = normalize_language_input(hint)
        if normalized in candidates:
            return LanguageResolution(normalized, "REQUEST_HINT", "HINT")
        # Defensive only: upstream validation rejects non-candidate hints
        # before resolution.  Never fabricate a substitute.
        return LanguageResolution(None, "HINT_NOT_CANDIDATE", "NONE")
    if default_language is not None:
        normalized = normalize_language_input(default_language)
        if normalized in candidates:
            return LanguageResolution(normalized, "PROFILE_DEFAULT", "PROFILE")
        return LanguageResolution(None, "DEFAULT_NOT_CANDIDATE", "NONE")
    if detection_enabled:
        # Detection is policy-gated and never selects among the shared
        # Devanagari family on script identity.  No admitted detector output
        # exists in this runtime, so the stage resolves nothing.
        return LanguageResolution(None, "DETECTION_UNRESOLVED", "NONE")
    return LanguageResolution(None, "NO_LANGUAGE", "NONE")


def load_resolution_authority(path: Path | str | None = None) -> dict[str, Any]:
    """Load and validate the language-resolution authority file."""

    authority = Path(path) if path is not None else DEFAULT_AUTHORITY
    document = yaml.safe_load(authority.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("schemaVersion") != "document-intelligence.language-resolution.v1":
        raise ValueError("language resolution authority schemaVersion mismatch")
    order = document.get("resolutionOrder")
    expected = ["validatedRequestHint", "profileDefault", "detection", "fallbackOrError"]
    if order != expected:
        raise ValueError("language resolution order must be " + " -> ".join(expected))
    ambiguity = ((document.get("detection") or {}).get("devanagariAmbiguity") or {})
    if frozenset(ambiguity.get("languages") or ()) != DEVANAGARI_AMBIGUITY:
        raise ValueError("devanagariAmbiguity.languages must be exactly ne/hi/mr")
    if ambiguity.get("rule") != "SCRIPT_IDENTITY_NEVER_SELECTS":
        raise ValueError("devanagariAmbiguity.rule must be SCRIPT_IDENTITY_NEVER_SELECTS")
    if document.get("unicodeNormalization") != "NFC":
        raise ValueError("unicodeNormalization must be NFC")
    languages = document.get("languages")
    if not isinstance(languages, dict) or not {"en", "ne", "hi", "mr"}.issubset(languages):
        raise ValueError("language resolution authority must declare en/ne/hi/mr")
    return document
