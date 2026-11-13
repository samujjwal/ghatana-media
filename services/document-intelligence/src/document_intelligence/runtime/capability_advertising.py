"""Exact capability-advertising projection and conformance checks."""

from __future__ import annotations

from collections.abc import Mapping


class CapabilityAdvertisingError(ValueError):
    def __init__(self, missing: set[str], unexpected: set[str]) -> None:
        self.missing = frozenset(missing)
        self.unexpected = frozenset(unexpected)
        super().__init__(
            "capability advertisement is not exact: "
            f"missing={sorted(self.missing)} unexpected={sorted(self.unexpected)}"
        )


def qualified_capability_ids(registry: Mapping[str, object], profile_id: str) -> frozenset[str]:
    """Project only currently qualified, profile-admitted capabilities."""

    capabilities = registry.get("capabilities")
    if not isinstance(capabilities, Mapping):
        raise ValueError("capability registry must contain a capabilities mapping")
    result: set[str] = set()
    for capability_id, raw in capabilities.items():
        if not isinstance(capability_id, str) or not isinstance(raw, Mapping):
            raise ValueError("capability registry contains an invalid record")
        profiles = raw.get("profiles", [])
        if (
            raw.get("developmentState") == "QUALIFIED"
            and raw.get("consumerAdmission") == "ALLOWED"
            and isinstance(profiles, list)
            and profile_id in profiles
        ):
            result.add(capability_id)
    return frozenset(result)


def require_exact_capability_advertisement(
    registry: Mapping[str, object],
    profile_id: str,
    advertised: set[str] | frozenset[str] | list[str] | tuple[str, ...],
) -> frozenset[str]:
    """Fail closed in both directions: no leakage and no missing capability."""

    expected = qualified_capability_ids(registry, profile_id)
    actual = frozenset(advertised)
    if len(actual) != len(advertised):
        raise CapabilityAdvertisingError(set(), {"DUPLICATE_CAPABILITY_ID"})
    missing = set(expected - actual)
    unexpected = set(actual - expected)
    if missing or unexpected:
        raise CapabilityAdvertisingError(missing, unexpected)
    return expected


__all__ = [
    "CapabilityAdvertisingError",
    "qualified_capability_ids",
    "require_exact_capability_advertisement",
]
