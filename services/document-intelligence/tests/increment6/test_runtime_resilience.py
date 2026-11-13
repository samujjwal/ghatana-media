"""Increment-6 runtime resilience tests (backlog I6-21..I6-27)."""

from __future__ import annotations

import hashlib
import os
import threading
import time
from pathlib import Path

import pytest
import yaml

from document_intelligence.errors import WorkerError
from document_intelligence.runtime.asset_verification import (
    AssetCorruptionError,
    require_assets,
    verify_assets,
)
from document_intelligence.runtime.crash_recovery import CrashRecoveryJournal
from document_intelligence.runtime.drain import DrainCoordinator
from document_intelligence.runtime.memory import MemoryPressureGuard
from document_intelligence.runtime.model_residency import ModelResidencyPlanner
from document_intelligence.runtime.scheduler import BoundedScheduler
from document_intelligence.runtime.temp_space import TempSpaceGuard


# ---------------------------------------------------------------- I6-21 ---


def test_scheduler_enforces_hard_queue_cap_with_backpressure():
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=2)
    scheduler.submit({"tenantId": "a"})
    scheduler.submit({"tenantId": "a"})
    with pytest.raises(WorkerError) as error:
        scheduler.submit({"tenantId": "a"})
    assert error.value.code == "BACKPRESSURE"
    assert error.value.retryable is True


def test_scheduler_dispatch_is_fifo_and_running_is_bounded():
    scheduler = BoundedScheduler(max_in_flight=2, max_queued=4)
    first = scheduler.submit({"tenantId": "a", "seq": 1})
    second = scheduler.submit({"tenantId": "b", "seq": 2})
    third = scheduler.submit({"tenantId": "c", "seq": 3})
    assert scheduler.dispatch() is first
    assert scheduler.dispatch() is second
    # in-flight cap reached; third stays queued
    assert scheduler.dispatch() is None
    assert scheduler.in_flight == 2 and scheduler.queue_depth == 1
    scheduler.complete(first)
    assert scheduler.dispatch() is third
    scheduler.complete(second)
    scheduler.complete(third)
    assert scheduler.in_flight == 0


def test_scheduler_per_tenant_fairness_quota():
    # total capacity 4, 50% share -> a single tenant may hold at most 2 slots
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=3, max_tenant_share=0.5)
    scheduler.submit({"tenantId": "greedy"})
    scheduler.submit({"tenantId": "greedy"})
    with pytest.raises(WorkerError) as error:
        scheduler.submit({"tenantId": "greedy"})
    assert error.value.code == "BACKPRESSURE"
    # other tenants are not starved by the greedy tenant's quota exhaustion
    scheduler.submit({"tenantId": "small"})


def test_scheduler_emits_queue_depth_via_callback():
    depths: list[int] = []
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=4, on_queue_depth=depths.append)
    ticket = scheduler.submit({"tenantId": "a"})
    scheduler.dispatch()
    scheduler.complete(ticket)
    assert depths == [1, 0, 0]


def test_scheduler_cancel_releases_queue_slot():
    scheduler = BoundedScheduler(max_in_flight=1, max_queued=1)
    ticket = scheduler.submit({"tenantId": "a"})
    scheduler.cancel(ticket)
    replacement = scheduler.submit({"tenantId": "a"})
    assert replacement.state == "QUEUED"


# ---------------------------------------------------------------- I6-22 ---


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_residency_plan_fits_budget_and_orders_cold_start():
    planner = ModelResidencyPlanner(budget_bytes=100)
    plan = planner.plan(
        [
            {"ref": "model-a", "bytes": 60},
            {"ref": "model-b", "bytes": 40},
            {"ref": "model-c", "bytes": 10},
        ]
    )
    assert plan.resident == ("model-a", "model-b")
    assert plan.excluded == ("model-c",)
    assert plan.reserved_bytes == 100
    assert plan.cold_start_order() == ["model-a", "model-b"]


def test_residency_verify_matches_on_disk_sha256(tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "a.bin").write_bytes(b"weights-a")
    (cache / "b.bin").write_bytes(b"weights-b")
    manifest = tmp_path / "manifest.yaml"
    manifest.write_text(
        yaml.safe_dump(
            {
                "models": [
                    {"ref": "a", "sha256": _sha256(b"weights-a"), "path": "a.bin"},
                    {"ref": "b", "sha256": _sha256(b"weights-b"), "path": "b.bin"},
                ]
            }
        )
    )
    verdict = ModelResidencyPlanner(0).verify_residency(manifest, cache)
    assert verdict.ok
    assert verdict.verified == ("a", "b")


def test_residency_verify_fails_closed_on_corrupt_and_missing(tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "ok.bin").write_bytes(b"good")
    (cache / "bad.bin").write_bytes(b"tampered")
    manifest = tmp_path / "manifest.yaml"
    manifest.write_text(
        yaml.safe_dump(
            {
                "models": [
                    {"ref": "ok", "sha256": _sha256(b"good"), "path": "ok.bin"},
                    {"ref": "bad", "sha256": _sha256(b"original"), "path": "bad.bin"},
                    {"ref": "gone", "sha256": _sha256(b"x"), "path": "gone.bin"},
                ]
            }
        )
    )
    verdict = ModelResidencyPlanner(0).verify_residency(manifest, cache)
    assert not verdict.ok
    assert verdict.verified == ("ok",)
    assert verdict.corrupt == ("bad",)
    assert verdict.missing == ("gone",)


# ---------------------------------------------------------------- I6-23 ---


def test_memory_guard_admits_within_budget():
    guard = MemoryPressureGuard(limit_bytes=1000, rss_reader=lambda: 500)
    assert guard.check() == "OK"
    assert guard.admit(400) is True
    assert guard.admit(600) is False


def test_memory_guard_warn_and_critical_thresholds():
    guard = MemoryPressureGuard(limit_bytes=1000, rss_reader=lambda: 800)
    assert guard.check() == "WARN"
    critical = MemoryPressureGuard(limit_bytes=1000, rss_reader=lambda: 950)
    assert critical.check() == "CRITICAL"
    assert critical.admit(1) is False
    with pytest.raises(WorkerError) as error:
        critical.require_admission(1)
    assert error.value.code == "MEMORY_PRESSURE"


def test_memory_guard_reads_real_rss():
    guard = MemoryPressureGuard(limit_bytes=1 << 62)
    assert guard.current_rss() > 0
    assert guard.check() == "OK"


# ---------------------------------------------------------------- I6-24 ---


def test_drain_lifecycle_rejects_admission_and_completes():
    coordinator = DrainCoordinator()
    assert coordinator.state == "ACCEPTING"
    coordinator.admit()
    coordinator.release()
    assert coordinator.begin_drain(timeout_ms=1000) is True
    assert coordinator.state == "DRAINED"
    with pytest.raises(WorkerError) as error:
        coordinator.admit()
    assert error.value.code == "DRAINING"


def test_drain_times_out_with_in_flight_then_succeeds_on_retry():
    coordinator = DrainCoordinator()
    coordinator.admit()
    assert coordinator.begin_drain(timeout_ms=50) is False
    assert coordinator.state == "DRAINING"
    with pytest.raises(WorkerError) as error:
        coordinator.admit()
    assert error.value.code == "DRAINING"
    coordinator.release()
    assert coordinator.begin_drain(timeout_ms=1000) is True
    assert coordinator.state == "DRAINED"


def test_drain_waits_for_concurrent_release():
    coordinator = DrainCoordinator()
    coordinator.admit()

    def release_later() -> None:
        time.sleep(0.05)
        coordinator.release()

    thread = threading.Thread(target=release_later)
    thread.start()
    try:
        assert coordinator.begin_drain(timeout_ms=5000) is True
        assert coordinator.state == "DRAINED"
        assert coordinator.in_flight == 0
    finally:
        thread.join()


# ---------------------------------------------------------------- I6-25 ---


def test_crash_journal_recovers_interrupted_executions(tmp_path: Path):
    journal = CrashRecoveryJournal(tmp_path / "journal")
    journal.record_started("exec-1")
    journal.record_started("exec-2")
    journal.record_completed("exec-1")
    assert journal.recover() == ["exec-2"]


def test_crash_journal_clean_history_recovers_nothing(tmp_path: Path):
    journal = CrashRecoveryJournal(tmp_path / "journal")
    journal.record_started("exec-1")
    journal.record_completed("exec-1")
    assert journal.recover() == []


def test_crash_journal_replay_is_bounded(tmp_path: Path):
    journal = CrashRecoveryJournal(tmp_path / "journal", max_replay=2)
    for index in range(5):
        journal.record_started(f"exec-{index}")
    assert len(journal.recover()) == 2
    assert len(journal.recover(max_replay=4)) == 4


def test_crash_journal_corrupt_record_fails_closed(tmp_path: Path):
    directory = tmp_path / "journal"
    journal = CrashRecoveryJournal(directory)
    journal.record_started("exec-ok")
    (directory / "exec-ok.journal").write_text("not-json{{{")
    assert journal.recover() == ["exec-ok"]


# ---------------------------------------------------------------- I6-26 ---


def test_temp_space_refuses_beyond_limit(tmp_path: Path):
    guard = TempSpaceGuard(tmp_path / "tmp", limit_bytes=10)
    guard.write(b"12345678")
    assert guard.tracked_bytes == 8
    with pytest.raises(WorkerError) as error:
        guard.write(b"xxx")
    assert error.value.code == "TEMP_SPACE_EXHAUSTED"
    assert guard.admit(2) is True


def test_temp_space_cleanup_stale_only_removes_tracked_old_files(tmp_path: Path):
    directory = tmp_path / "tmp"
    guard = TempSpaceGuard(directory, limit_bytes=1024)
    stale = guard.write(b"old-data")
    fresh = guard.write(b"new-data")
    foreign = directory / "foreign.bin"
    foreign.write_bytes(b"not ours")
    old_time = time.time() - 3600
    os.utime(stale, (old_time, old_time))
    assert guard.cleanup_stale(max_age_s=60) == 1
    assert not stale.exists()
    assert fresh.exists()
    assert foreign.exists()  # never touches files it does not track
    assert guard.tracked_bytes == len(b"new-data")


def test_temp_space_cleanup_releases_budget(tmp_path: Path):
    guard = TempSpaceGuard(tmp_path / "tmp", limit_bytes=10)
    path = guard.write(b"1234567890")
    assert guard.admit(1) is False
    guard.cleanup(path)
    assert guard.tracked_bytes == 0
    assert guard.admit(10) is True


# ---------------------------------------------------------------- I6-27 ---


def test_verify_assets_detects_corrupt_and_missing(tmp_path: Path):
    root = tmp_path / "assets"
    root.mkdir()
    (root / "good.bin").write_bytes(b"payload")
    (root / "bad.bin").write_bytes(b"tampered")
    manifest = {
        "good.bin": _sha256(b"payload"),
        "bad.bin": _sha256(b"original"),
        "absent.bin": _sha256(b"never written"),
    }
    verdict = verify_assets(manifest, root)
    assert verdict == {"verified": ["good.bin"], "corrupt": ["absent.bin", "bad.bin"]}


def test_require_assets_raises_with_corrupt_names(tmp_path: Path):
    root = tmp_path / "assets"
    root.mkdir()
    (root / "bad.bin").write_bytes(b"tampered")
    with pytest.raises(AssetCorruptionError) as error:
        require_assets({"bad.bin": _sha256(b"expected")}, root)
    assert isinstance(error.value, WorkerError)
    assert error.value.code == "ASSET_CORRUPT"
    assert error.value.corrupt == ("bad.bin",)


def test_verify_assets_clean_manifest(tmp_path: Path):
    root = tmp_path / "assets"
    root.mkdir()
    (root / "a.bin").write_bytes(b"a")
    (root / "b.bin").write_bytes(b"b")
    verified = require_assets({"a.bin": _sha256(b"a"), "b.bin": _sha256(b"b")}, root)
    assert verified == ["a.bin", "b.bin"]
