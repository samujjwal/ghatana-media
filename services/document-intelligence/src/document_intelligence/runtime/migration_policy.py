"""Zero-downtime expand/contract migration policy (I6-88)."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterable


class MigrationPhase(str, Enum):
    EXPAND = "EXPAND"
    DUAL_READ_WRITE = "DUAL_READ_WRITE"
    BACKFILL = "BACKFILL"
    CONTRACT = "CONTRACT"


@dataclass(frozen=True)
class MigrationStep:
    name: str
    phase: MigrationPhase
    compatible_with_previous: bool
    reversible: bool


@dataclass(frozen=True)
class MigrationPlan:
    migration_id: str
    steps: tuple[MigrationStep, ...]

    def validate(self) -> None:
        if not self.migration_id or not self.steps:
            raise ValueError("migration plan must have an id and steps")
        phases = [step.phase for step in self.steps]
        if phases[0] is not MigrationPhase.EXPAND:
            raise ValueError("migration must begin with EXPAND")
        if MigrationPhase.CONTRACT in phases:
            contract_index = phases.index(MigrationPhase.CONTRACT)
            if contract_index == 0 or not all(step.compatible_with_previous for step in self.steps[:contract_index]):
                raise ValueError("CONTRACT requires an expand/dual-write compatibility window")
            if not self.steps[contract_index].reversible:
                raise ValueError("contract step must retain a rollback authority")

    def supports_rolling_versions(self) -> bool:
        self.validate()
        return all(step.compatible_with_previous for step in self.steps if step.phase is not MigrationPhase.CONTRACT)


def validate_expand_contract_steps(steps: Iterable[MigrationStep]) -> tuple[MigrationStep, ...]:
    plan = MigrationPlan("anonymous", tuple(steps))
    plan.validate()
    return plan.steps
