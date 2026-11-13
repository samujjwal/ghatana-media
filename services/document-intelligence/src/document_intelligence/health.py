from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class HealthState:
    ready: bool = False
    shutting_down: bool = False
    reason: str | None = None
    reason_code: str | None = None
    details: dict[str, Any] | None = None
    authority_evidence: dict[str, Any] | None = None

    def _evidence(self) -> dict[str, Any]:
        return dict(self.authority_evidence or {})

    def healthz(self) -> dict[str, Any]:
        return {"status": "ok", **self._evidence()}

    def readyz(self) -> dict[str, Any]:
        result: dict[str, Any] = {"status": "ready" if self.ready and not self.shutting_down else "not_ready"}
        result.update(self._evidence())
        if self.reason:
            result["reason"] = self.reason
        if self.reason_code:
            result["reasonCode"] = self.reason_code
        if self.details:
            result["details"] = self.details
        return result
