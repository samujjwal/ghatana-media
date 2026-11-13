"""Repeatable performance qualification protocol (I6-90)."""

from __future__ import annotations

import statistics
import time
from dataclasses import dataclass
from collections.abc import Mapping
from typing import Callable, Iterable


@dataclass(frozen=True)
class PerformanceProtocol:
    warmup_iterations: int = 3
    measurement_iterations: int = 10
    repetitions: int = 3
    minimum_samples: int = 10
    max_run_variation: float = 0.20
    require_isolated_hardware: bool = True

    def validate(self) -> None:
        if any(value < 1 for value in (self.warmup_iterations, self.measurement_iterations, self.repetitions, self.minimum_samples)):
            raise ValueError("performance iteration counts must be positive")
        if not 0 <= self.max_run_variation < 1:
            raise ValueError("max_run_variation must be in [0, 1)")
        if self.repetitions * self.measurement_iterations < self.minimum_samples:
            raise ValueError("protocol cannot produce its minimum sample count")

    def measure(
        self,
        operation: Callable[[], object],
        *,
        isolated_hardware: bool,
        environment: Mapping[str, object] | None = None,
    ) -> "PerformanceResult":
        self.validate()
        for _ in range(self.warmup_iterations):
            operation()
        runs: list[list[float]] = []
        for _ in range(self.repetitions):
            samples: list[float] = []
            for _ in range(self.measurement_iterations):
                started = time.perf_counter()
                operation()
                samples.append((time.perf_counter() - started) * 1000)
            runs.append(samples)
        return qualify_performance(self, runs, isolated_hardware=isolated_hardware, environment=environment)


@dataclass(frozen=True)
class PerformanceResult:
    status: str
    sample_count: int
    p50_ms: float
    p95_ms: float
    p99_ms: float
    run_medians_ms: tuple[float, ...]
    variation: float
    contamination_reasons: tuple[str, ...] = ()

    @property
    def contaminated(self) -> bool:
        return bool(self.contamination_reasons)


def _percentile(values: Iterable[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return float("nan")
    index = min(len(ordered) - 1, int((len(ordered) - 1) * fraction))
    return ordered[index]


def measurement_contamination(environment: Mapping[str, object] | None) -> tuple[str, ...]:
    """Return deterministic reasons a performance sample is not qualified.

    The caller supplies observations from the campaign envelope rather than
    this module probing the host.  That keeps qualification reproducible while
    making competing work, thermal/resource pressure, and model reloads
    explicit instead of silently folding them into a threshold failure.
    """

    values = environment or {}
    reasons: list[str] = []

    def positive(name: str) -> bool:
        value = values.get(name, 0)
        return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0

    def enabled(name: str) -> bool:
        return values.get(name) is True

    if positive("competingWorkerProcesses"):
        reasons.append("COMPETING_WORKERS")
    cpu = values.get("cpuUtilizationOutsideCampaign", 0)
    if isinstance(cpu, (int, float)) and not isinstance(cpu, bool) and cpu > 0.85:
        reasons.append("CPU_SATURATION")
    if enabled("memoryPressure"):
        reasons.append("MEMORY_PRESSURE")
    if enabled("thermalThrottling"):
        reasons.append("THERMAL_THROTTLING")
    if enabled("gpuContention"):
        reasons.append("GPU_CONTENTION")
    if enabled("diskPressure"):
        reasons.append("DISK_PRESSURE")
    if positive("unexpectedModelReloads"):
        reasons.append("UNEXPECTED_MODEL_RELOAD")
    return tuple(reasons)


def qualify_performance(
    protocol: PerformanceProtocol,
    runs: list[list[float]],
    *,
    isolated_hardware: bool,
    environment: Mapping[str, object] | None = None,
) -> PerformanceResult:
    protocol.validate()
    samples = [value for run in runs for value in run]
    medians = tuple(statistics.median(run) for run in runs if run)
    variation = (max(medians) - min(medians)) / min(medians) if medians and min(medians) > 0 else float("inf")
    contamination_reasons = measurement_contamination(environment)
    status = "PASS"
    if protocol.require_isolated_hardware and not isolated_hardware:
        status = "NOT_QUALIFIED_ENVIRONMENT"
        contamination_reasons = (*contamination_reasons, "HARDWARE_NOT_ISOLATED")
    elif contamination_reasons:
        status = "NOT_QUALIFIED_ENVIRONMENT"
    elif len(samples) < protocol.minimum_samples or variation > protocol.max_run_variation:
        status = "NOT_QUALIFIED_ENVIRONMENT"
    return PerformanceResult(
        status=status,
        sample_count=len(samples),
        p50_ms=_percentile(samples, 0.50),
        p95_ms=_percentile(samples, 0.95),
        p99_ms=_percentile(samples, 0.99),
        run_medians_ms=medians,
        variation=variation,
        contamination_reasons=tuple(dict.fromkeys(contamination_reasons)),
    )


__all__ = ["PerformanceProtocol", "PerformanceResult", "measurement_contamination", "qualify_performance"]
