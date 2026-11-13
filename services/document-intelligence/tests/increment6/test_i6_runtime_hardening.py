from __future__ import annotations

import hashlib
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from document_intelligence.contracts import PROTOCOL_VERSION, validate_provider_output
from document_intelligence.errors import WorkerError
from document_intelligence.limits import Limits
from document_intelligence.operations import FileOutcomeStore, OperationRegistry
from document_intelligence.runtime.asset_provenance import (
    AssetProvenance,
    AssetProvenancePolicy,
    verify_asset_provenance,
)
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.concurrency_authority import (
    ConcurrencyAuthorityError,
    InMemoryConcurrencyAuthority,
    InMemoryConcurrencyBackend,
)
from document_intelligence.runtime.deadline import Deadline
from document_intelligence.runtime.migration_policy import MigrationPhase, MigrationPlan, MigrationStep
from document_intelligence.runtime.performance_protocol import PerformanceProtocol, qualify_performance
from document_intelligence.runtime.subprocess_runner import run_bounded_subprocess
from document_intelligence.runtime.temporary_files import TemporaryFileManager
from document_intelligence.runtime.version_skew import default_version_skew_matrix


def _parsed() -> dict[str, object]:
    identity = {"providerRef": "ghatana.docling", "providerVersion": "0.1.0", "modelRef": "local", "modelVersion": "pinned"}
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "operationId": "op-1",
        "providerRef": "ghatana.docling",
        "pages": [{
            "pageNumber": 1,
            "blocks": [{
                "blockId": "b1",
                "kind": "TEXT",
                "boundingRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
                "lines": [{"lineId": "l1", "text": "safe", "boundingRegion": {"x": 0, "y": 0, "width": 1, "height": 1}}],
            }],
            "tables": [],
        }],
        "providerProvenance": identity,
        "quality": {},
    }


def test_i6_84_output_expansion_and_serialization_bounds_fail_closed():
    value = _parsed()
    with pytest.raises(WorkerError, match="LIMIT_EXCEEDED"):
        validate_provider_output(value, replace(Limits(), max_regions=1))
    with pytest.raises(WorkerError, match="LIMIT_EXCEEDED"):
        validate_provider_output(value, replace(Limits(), max_serialized_response_bytes=64))


def test_i6_85_operation_files_are_private_and_cleanup_is_ownership_scoped(tmp_path: Path):
    root = tmp_path / "worker-tmp"
    foreign = root / "foreign" / "keep.txt"
    foreign.parent.mkdir(parents=True)
    foreign.write_text("do not remove")
    manager = TemporaryFileManager(root, max_bytes=20, max_files=1)
    run = manager.create_run()
    path = run.write(b"payload")
    assert path.parent != root
    assert oct(path.parent.stat().st_mode & 0o777) == "0o700"
    with pytest.raises(ValueError):
        run.write(b"second")
    run.cleanup_all()
    assert foreign.exists()
    assert not path.exists()


def test_i6_85_subprocess_starts_a_new_process_group(monkeypatch):
    observed: dict[str, object] = {}

    class FakeProcess:
        pid = 1234
        returncode = 0

        def __init__(self, *args, **kwargs):
            observed.update(kwargs)

        def communicate(self, input=None, timeout=None):
            return b"ok", b""

        def poll(self):
            return 0

    monkeypatch.setattr(subprocess, "Popen", FakeProcess)
    result = run_bounded_subprocess(["provider"], deadline=Deadline(1_000), token=CancellationToken())
    assert result.stdout == b"ok"
    assert observed["start_new_session"] is True


def test_i6_86_shared_authority_enforces_cluster_limits_and_fences_takeover():
    clock = [0.0]
    backend = InMemoryConcurrencyBackend()
    first = InMemoryConcurrencyAuthority(replica_id="r1", cluster_limit=1, per_replica_limit=1, lease_seconds=5, backend=backend, now=lambda: clock[0])
    second = InMemoryConcurrencyAuthority(replica_id="r2", cluster_limit=1, per_replica_limit=1, lease_seconds=5, backend=backend, now=lambda: clock[0])
    lease = first.admit("op-1", "tenant-a")
    assert lease is not None
    assert second.admit("op-2", "tenant-a") is None
    clock[0] = 6
    assert second.reap_expired() == 1
    takeover = second.admit("op-2", "tenant-a")
    assert takeover is not None and takeover.fencing_token > lease.fencing_token
    with pytest.raises(ConcurrencyAuthorityError, match="STALE_FENCE"):
        first.assert_current(lease)


def test_i6_87_matrix_requires_explicit_mixed_version_admission():
    matrix = default_version_skew_matrix()
    matrix.require_supported("document-intelligence.v1", "document-intelligence.v1")
    assert matrix.disposition("document-intelligence.v0", "document-intelligence.v1") == "UNSUPPORTED"


def test_i6_88_migration_requires_expand_before_contract():
    plan = MigrationPlan("document-outcome-v2", (
        MigrationStep("add-outcome", MigrationPhase.EXPAND, True, True),
        MigrationStep("dual-write", MigrationPhase.DUAL_READ_WRITE, True, True),
        MigrationStep("contract-old-column", MigrationPhase.CONTRACT, True, True),
    ))
    plan.validate()
    with pytest.raises(ValueError):
        MigrationPlan("unsafe", (MigrationStep("drop-first", MigrationPhase.CONTRACT, False, False),)).validate()


def test_i6_89_asset_provenance_requires_allowlisted_origin_and_exact_digest(tmp_path: Path):
    payload = b"native-runtime"
    asset = tmp_path / "runtime.bin"
    asset.write_bytes(payload)
    provenance = AssetProvenance("local-package-cache", "offline-bundle", hashlib.sha256(payload).hexdigest(), len(payload), "runtime-license")
    assert verify_asset_provenance(asset, provenance) == provenance.digest
    remote = replace(provenance, origin="remote-hub")
    with pytest.raises(ValueError):
        verify_asset_provenance(asset, remote)


def test_i6_90_performance_protocol_rejects_noisy_or_nonisolated_measurements():
    protocol = PerformanceProtocol(warmup_iterations=1, measurement_iterations=2, repetitions=2, minimum_samples=4)
    result = qualify_performance(protocol, [[1.0, 1.1], [1.0, 1.1]], isolated_hardware=True)
    assert result.status == "PASS"
    assert qualify_performance(protocol, [[1.0, 1.0], [2.0, 2.0]], isolated_hardware=True).status == "NOT_QUALIFIED_ENVIRONMENT"
    assert qualify_performance(protocol, [[1.0, 1.0], [1.0, 1.0]], isolated_hardware=False).status == "NOT_QUALIFIED_ENVIRONMENT"


@pytest.mark.asyncio
async def test_i6_91_durable_outcome_replays_and_cancellation_cannot_resurrect(tmp_path: Path):
    store = FileOutcomeStore(tmp_path / "outcomes")
    registry = OperationRegistry(outcome_store=store)
    operation = await registry.begin("op-1", "provider", 1_000, "a" * 32)
    response = {"protocolVersion": PROTOCOL_VERSION, "operationId": "op-1", "status": "ok"}
    assert await registry.publish_success(operation, response)
    restarted = OperationRegistry(outcome_store=store)
    replay = await restarted.get_outcome("op-1", "a" * 32)
    assert replay is not None and replay.response == response

    cancelled = await registry.begin("op-2", "provider", 1_000, "b" * 32)
    assert await registry.cancel("op-2", "b" * 32)
    assert await registry.publish_success(cancelled, response) is False
    await registry.publish_failure(cancelled, {"code": "CANCELLED"}, 400)
    cancelled_outcome = await registry.get_outcome("op-2", "b" * 32)
    assert cancelled_outcome is not None and cancelled_outcome.status == "CANCELLED"
