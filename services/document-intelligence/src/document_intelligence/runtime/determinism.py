"""Determinism and stability envelopes for provider execution (OCR-RUN-21/22).

Provider output can be semantically stable without being byte-identical.  The
worker therefore records the execution controls that it can enforce and gives
evaluators a small tolerance-aware comparison for stable numeric metrics.
"""

from __future__ import annotations

import json
import locale
import os
import random
import time
from dataclasses import dataclass
from math import isfinite
from typing import Any, Mapping


DETERMINISM_ENVELOPE_SCHEMA = "document-intelligence.determinism-envelope.v1"
STABILITY_POLICY_SCHEMA = "document-intelligence.stability-policy.v1"


def _bounded_float(value: str | None, default: float, name: str) -> float:
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not isfinite(parsed) or parsed < 0 or parsed > 1:
        raise ValueError(f"{name} must be in [0, 1]")
    return parsed


def _bounded_int(value: str | None, default: int, name: str, *, maximum: int = 64) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if parsed < 1 or parsed > maximum:
        raise ValueError(f"{name} must be in [1, {maximum}]")
    return parsed


def _csv(value: str | None, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    return tuple(sorted({item.strip() for item in value.split(",") if item.strip()}))


@dataclass(frozen=True)
class StabilityPolicy:
    """Acceptance policy for metrics that may vary within a known envelope."""

    absolute_tolerance: float = 1e-6
    relative_tolerance: float = 1e-4
    stable_metrics: tuple[str, ...] = (
        "cer",
        "wer",
        "precision",
        "recall",
        "f1",
        "p50Ms",
        "p95Ms",
        "p99Ms",
    )

    def __post_init__(self) -> None:
        if not 0 <= self.absolute_tolerance <= 1 or not 0 <= self.relative_tolerance <= 1:
            raise ValueError("stability tolerances must be in [0, 1]")
        if not self.stable_metrics or len(set(self.stable_metrics)) != len(self.stable_metrics):
            raise ValueError("stable metrics must be unique and non-empty")

    def to_record(self) -> dict[str, Any]:
        return {
            "schemaVersion": STABILITY_POLICY_SCHEMA,
            "absoluteTolerance": self.absolute_tolerance,
            "relativeTolerance": self.relative_tolerance,
            "stableMetrics": list(self.stable_metrics),
        }

    def compare(self, reference: Mapping[str, float], candidate: Mapping[str, float]) -> "StabilityAssessment":
        differences: dict[str, float] = {}
        compared: list[str] = []
        for metric in self.stable_metrics:
            if metric not in reference or metric not in candidate:
                continue
            expected = reference[metric]
            observed = candidate[metric]
            if not isinstance(expected, (int, float)) or not isinstance(observed, (int, float)):
                raise ValueError(f"stability metric {metric} must be numeric")
            if not isfinite(float(expected)) or not isfinite(float(observed)):
                raise ValueError(f"stability metric {metric} must be finite")
            compared.append(metric)
            delta = abs(float(observed) - float(expected))
            tolerance = max(self.absolute_tolerance, self.relative_tolerance * max(abs(float(expected)), abs(float(observed))))
            if delta > tolerance:
                differences[metric] = delta
        return StabilityAssessment(
            status="STABLE" if not differences else "UNSTABLE",
            compared_metrics=tuple(compared),
            differences=differences,
        )


@dataclass(frozen=True)
class StabilityAssessment:
    status: str
    compared_metrics: tuple[str, ...]
    differences: Mapping[str, float]

    def to_record(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "comparedMetrics": list(self.compared_metrics),
            "differences": dict(sorted(self.differences.items())),
        }


@dataclass(frozen=True)
class DeterminismEnvelope:
    """Controls and records process-level determinism inputs.

    ``uncontrolledFields`` makes remaining nondeterminism explicit instead of
    treating every provider result as byte-deterministic.
    """

    random_seed: int | None = 0
    locale_name: str = "C.UTF-8"
    timezone: str = "UTC"
    unicode_normalization: str = "NFC"
    thread_count: int = 1
    provider_flags: tuple[str, ...] = ("deterministic",)
    floating_point_tolerance: float = 1e-6
    batching: str = "stable"
    backend: str = "CPU"
    uncontrolled_fields: tuple[str, ...] = ("providerFloatingPointOrdering", "hardwareInstructionSelection")
    stability_policy: StabilityPolicy = StabilityPolicy()

    def __post_init__(self) -> None:
        if self.random_seed is not None and not -(2**63) <= self.random_seed < 2**63:
            raise ValueError("random_seed is outside the supported range")
        if not self.locale_name or not self.timezone or self.unicode_normalization not in {"NFC", "NFKC"}:
            raise ValueError("invalid determinism locale/timezone/normalization")
        if self.thread_count < 1 or self.thread_count > 64:
            raise ValueError("thread_count must be in [1, 64]")
        if not 0 <= self.floating_point_tolerance <= 1:
            raise ValueError("floating_point_tolerance must be in [0, 1]")
        if self.batching not in {"stable", "provider-defined", "uncontrolled"}:
            raise ValueError("invalid batching policy")
        if not self.backend or not self.uncontrolled_fields:
            raise ValueError("determinism envelope must declare backend and uncontrolled fields")

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> "DeterminismEnvelope":
        values = os.environ if environment is None else environment
        seed_raw = values.get("DOCUMENT_INTELLIGENCE_DETERMINISM_SEED", "0").strip()
        seed = None if seed_raw.lower() in {"", "none", "unset"} else int(seed_raw)
        return cls(
            random_seed=seed,
            locale_name=values.get("DOCUMENT_INTELLIGENCE_LOCALE", "C.UTF-8"),
            timezone=values.get("DOCUMENT_INTELLIGENCE_TIMEZONE", "UTC"),
            unicode_normalization=values.get("DOCUMENT_INTELLIGENCE_UNICODE_NORMALIZATION", "NFC").upper(),
            thread_count=_bounded_int(values.get("DOCUMENT_INTELLIGENCE_THREAD_COUNT"), 1, "DOCUMENT_INTELLIGENCE_THREAD_COUNT"),
            provider_flags=_csv(values.get("DOCUMENT_INTELLIGENCE_PROVIDER_DETERMINISTIC_FLAGS"), ("deterministic",)),
            floating_point_tolerance=_bounded_float(
                values.get("DOCUMENT_INTELLIGENCE_FLOAT_TOLERANCE"), 1e-6, "DOCUMENT_INTELLIGENCE_FLOAT_TOLERANCE"
            ),
            batching=values.get("DOCUMENT_INTELLIGENCE_BATCHING", "stable"),
            backend=values.get("DOCUMENT_INTELLIGENCE_BACKEND", "CPU"),
            uncontrolled_fields=_csv(
                values.get("DOCUMENT_INTELLIGENCE_UNCONTROLLED_FIELDS"),
                ("providerFloatingPointOrdering", "hardwareInstructionSelection"),
            ),
            stability_policy=StabilityPolicy(
                absolute_tolerance=_bounded_float(
                    values.get("DOCUMENT_INTELLIGENCE_STABILITY_ABSOLUTE_TOLERANCE"), 1e-6,
                    "DOCUMENT_INTELLIGENCE_STABILITY_ABSOLUTE_TOLERANCE",
                ),
                relative_tolerance=_bounded_float(
                    values.get("DOCUMENT_INTELLIGENCE_STABILITY_RELATIVE_TOLERANCE"), 1e-4,
                    "DOCUMENT_INTELLIGENCE_STABILITY_RELATIVE_TOLERANCE",
                ),
            ),
        )

    def to_record(self) -> dict[str, Any]:
        return {
            "schemaVersion": DETERMINISM_ENVELOPE_SCHEMA,
            "randomSeed": self.random_seed,
            "locale": self.locale_name,
            "timezone": self.timezone,
            "unicodeNormalization": self.unicode_normalization,
            "threadCount": self.thread_count,
            "providerDeterministicFlags": list(self.provider_flags),
            "floatingPointTolerance": self.floating_point_tolerance,
            "batching": self.batching,
            "backend": self.backend,
            "controlledFields": [
                "randomSeed",
                "locale",
                "timezone",
                "unicodeNormalization",
                "threadCount",
                "providerDeterministicFlags",
                "floatingPointTolerance",
                "batching",
                "backend",
            ],
            "uncontrolledFields": list(self.uncontrolled_fields),
            "stabilityPolicy": self.stability_policy.to_record(),
        }

    def fingerprint(self) -> str:
        import hashlib

        return hashlib.sha256(json.dumps(self.to_record(), sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def apply_process_determinism(envelope: DeterminismEnvelope) -> None:
    """Apply controls before provider/model initialization.

    The environment variables are inherited by native children.  Locale and
    timezone are process-global, so this function is intended to run once at
    worker startup, before requests are accepted.
    """

    if envelope.random_seed is not None:
        random.seed(envelope.random_seed)
    os.environ["LC_ALL"] = envelope.locale_name
    os.environ["LANG"] = envelope.locale_name
    os.environ["TZ"] = envelope.timezone
    os.environ["DOCUMENT_INTELLIGENCE_UNICODE_NORMALIZATION"] = envelope.unicode_normalization
    os.environ["DOCUMENT_INTELLIGENCE_PROVIDER_DETERMINISTIC_FLAGS"] = ",".join(envelope.provider_flags)
    os.environ["OMP_NUM_THREADS"] = str(envelope.thread_count)
    os.environ["OPENBLAS_NUM_THREADS"] = str(envelope.thread_count)
    os.environ["MKL_NUM_THREADS"] = str(envelope.thread_count)
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    try:
        locale.setlocale(locale.LC_ALL, envelope.locale_name)
    except locale.Error as exc:
        raise RuntimeError("DETERMINISM_LOCALE_UNAVAILABLE") from exc
    if hasattr(time, "tzset"):
        time.tzset()
