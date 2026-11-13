"""Explicit provider-fallback contract enforcement (I6-16, I6-17).

Every fallback must satisfy ``routing/fallback-contract.v1.yaml``: a declared
(from,to) chain, a declared trigger, and a recorded reasonCode +
providerProvenance. Undeclared fallbacks are rejected, never tolerated.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from ..errors import WorkerError

WORKER_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONTRACT = WORKER_ROOT / "routing/fallback-contract.v1.yaml"


class FallbackContractError(ValueError):
    """Raised when a fallback violates the checked-in contract.

    Internal invariant, not a wire error: the wire error-code enum is frozen
    by Increment 3, and an undeclared fallback must never reach the wire.
    Carries the machine code FALLBACK_NOT_IN_CONTRACT for evidence records.
    """

    code = "FALLBACK_NOT_IN_CONTRACT"


class ContractRejection(WorkerError):
    """Terminal WorkerError for a runtime fallback-contract rejection (I6-57).

    ``WorkerError.__post_init__`` would rewrite ``FALLBACK_NOT_IN_CONTRACT``
    to ``PROVIDER_FAILED`` because the Increment-4A wire code enum is frozen;
    this subclass preserves the scheduler-error pattern so the contract
    rejection surfaces as a terminal, non-silent failure.
    """

    def __post_init__(self) -> None:
        Exception.__init__(self, self.code)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


@dataclass(frozen=True)
class FallbackDecision:
    allowed: bool
    chain_id: str | None
    required_record: list[str]
    contract_fingerprint: str


class FallbackContract:
    def __init__(self, contract_path: Path = DEFAULT_CONTRACT) -> None:
        self._path = contract_path
        self._policy = yaml.safe_load(contract_path.read_text(encoding="utf-8"))
        if self._policy.get("schemaVersion") != "document-intelligence.fallback-contract.v1":
            raise ValueError("fallback contract schemaVersion mismatch")
        self._fingerprint = "sha256:" + hashlib.sha256(contract_path.read_bytes()).hexdigest()
        self._chains = {
            (c["from"], c["to"]): c for c in self._policy.get("chains", [])
        }
        self._prohibited = {p["id"]: p.get("reason", "") for p in self._policy.get("prohibited", [])}

    @property
    def fingerprint(self) -> str:
        return self._fingerprint

    def admit(self, from_provider: str, to_provider: str, trigger: str, media_type: str) -> FallbackDecision:
        chain = self._chains.get((from_provider, to_provider))
        if chain is None:
            raise FallbackContractError(
                f"undeclared fallback {from_provider} -> {to_provider} rejected by contract"
            )
        if media_type not in chain.get("mediaTypes", []):
            raise FallbackContractError(
                f"fallback chain {chain['id']} does not admit media type {media_type}"
            )
        if trigger not in chain.get("triggers", []):
            raise FallbackContractError(
                f"trigger {trigger} not declared for fallback chain {chain['id']}"
            )
        return FallbackDecision(
            allowed=True,
            chain_id=chain["id"],
            required_record=list(chain.get("record", [])),
            contract_fingerprint=self._fingerprint,
        )

    def receipt(self, decision: FallbackDecision, *, reason_code: str, provenance: dict) -> dict:
        """Fallback observation record — the fields the contract requires."""
        record = {
            "schemaVersion": "document-intelligence.fallback-receipt.v1",
            "chainId": decision.chain_id,
            "contractFingerprint": decision.contract_fingerprint,
            "reasonCode": reason_code,
            "providerProvenance": provenance,
        }
        record["receiptFingerprint"] = "sha256:" + hashlib.sha256(_canonical(record)).hexdigest()
        return record
