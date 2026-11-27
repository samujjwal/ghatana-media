from __future__ import annotations

import asyncio
import hashlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deployment"))

from build_package import build_receipt  # noqa: E402
from document_intelligence.errors import WorkerError  # noqa: E402
from document_intelligence.operations import FileOutcomeStore, OperationRegistry  # noqa: E402
from document_intelligence.runtime.capability_advertising import (  # noqa: E402
    CapabilityAdvertisingError,
    require_exact_capability_advertisement,
)
from document_intelligence.runtime.model_loading import validate_model_artifact  # noqa: E402
from document_intelligence.runtime.model_registry import ModelEntry, ModelRegistry  # noqa: E402
from document_intelligence.runtime.performance_protocol import (  # noqa: E402
    qualify_performance,
)
from document_intelligence.runtime.runtime_class import (  # noqa: E402
    FUNCTIONAL,
    NOT_QUALIFIED,
    PERFORMANCE,
    load_runtime_class_matrix,
)
from evaluation.increment6.runners.continuity import (  # noqa: E402
    ContinuityError,
    combine_segments,
)


def _artifact(root: Path, files: dict[str, bytes]) -> Path:
    root.mkdir(parents=True)
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    digest = hashlib.sha256()
    for target in sorted(path for path in root.rglob("*") if path.is_file()):
        if target.name == ".artifact.sha256":
            continue
        digest.update(str(target.relative_to(root)).encode())
        digest.update(target.read_bytes())
    (root / ".artifact.sha256").write_text(digest.hexdigest(), encoding="utf-8")
    return root


def test_model_loading_rejects_unsafe_candidate_and_accepts_safe_sibling(tmp_path: Path):
    with pytest.raises(ValueError, match="unsafe model serialization"):
        validate_model_artifact(_artifact(tmp_path / "unsafe", {"model.pkl": b"pickle"}))
    safe = _artifact(
        tmp_path / "safe",
        {"pytorch_model.bin": b"legacy", "model.safetensors": b"safe", "config.json": b"{}"},
    )
    assert {path.name for path in validate_model_artifact(safe)} == {
        "pytorch_model.bin",
        "model.safetensors",
        "config.json",
    }


def test_model_registry_checks_safe_loading_before_factory(tmp_path: Path):
    called = []
    key = "provider__model__revision"
    _artifact(tmp_path / key, {"model.pkl": b"unsafe"})
    registry = ModelRegistry()
    registry.register(
        "provider",
        ModelEntry(
            "provider",
            "1",
            "model",
            "revision",
            lambda: called.append(True),
            {},
            artifact_root=tmp_path,
            artifact_keys=(key,),
        ),
    )
    with pytest.raises(WorkerError) as error:
        registry.get("provider").load()
    assert error.value.code == "PROVIDER_UNAVAILABLE"
    assert called == []


def test_package_receipt_declares_content_addressing_separately(tmp_path: Path):
    entry = tmp_path / "worker.bin"
    entry.write_bytes(b"worker")
    receipt = build_receipt(tmp_path, [("worker.bin", "1.0.0")], "2026-01-01T00:00:00Z")
    assert receipt["contentAddressed"] is True
    assert receipt["buildReproducibility"] == "NOT_VERIFIED"
    verified = build_receipt(
        tmp_path,
        [("worker.bin", "1.0.0")],
        "2026-01-01T00:00:00Z",
        build_reproducibility="VERIFIED",
    )
    assert verified["buildReproducibility"] == "VERIFIED"


def test_runtime_class_matrix_requires_both_qualification_dimensions():
    matrix = load_runtime_class_matrix(ROOT / "evaluation/increment6/runtime-class-matrix.v1.yaml")
    item = matrix.get("ocr.paddle", "CPU_X86_64")
    assert item.functional_state == NOT_QUALIFIED
    assert item.performance_state == NOT_QUALIFIED
    assert not matrix.is_qualified("ocr.paddle", "CPU_X86_64")
    assert FUNCTIONAL != PERFORMANCE


def test_performance_contamination_is_not_a_threshold_failure():
    result = qualify_performance(
        __import__("document_intelligence.runtime.performance_protocol", fromlist=["PerformanceProtocol"]).PerformanceProtocol(
            warmup_iterations=1,
            measurement_iterations=2,
            repetitions=2,
            minimum_samples=4,
        ),
        [[1.0, 1.0], [1.0, 1.0]],
        isolated_hardware=True,
        environment={"competingWorkerProcesses": 1, "unexpectedModelReloads": 1},
    )
    assert result.status == "NOT_QUALIFIED_ENVIRONMENT"
    assert result.contamination_reasons == ("COMPETING_WORKERS", "UNEXPECTED_MODEL_RELOAD")


def _segment(run_id: str, start: str, end: str, *, material: str = "a" * 64) -> dict:
    return {
        "runId": run_id,
        "startedAt": start,
        "completedAt": end,
        "workerGeneration": "worker-1",
        "materialFingerprint": material,
        "interruptions": [],
        "measurementContinuity": True,
        "continuationPolicy": "SINGLE_INTERVAL",
    }


def test_operational_run_continuity_requires_explicit_checkpoint_authority():
    first = _segment("run-1", "2026-01-01T00:00:00+00:00", "2026-01-01T01:00:00+00:00")
    second = _segment("run-1", "2026-01-01T01:05:00+00:00", "2026-01-01T02:00:00+00:00")
    with pytest.raises(ContinuityError, match="checkpoint authorization"):
        combine_segments([first, second], checkpoint_authorized=False)
    combined = combine_segments([first, second], checkpoint_authorized=True)
    assert combined["continuationPolicy"] == "CHECKPOINT_AUTHORIZED"
    assert combined["interruptions"][0]["reason"] == "CHECKPOINT_CONTINUATION"


def test_capability_advertising_is_exact_in_both_directions():
    registry = {
        "capabilities": {
            "qualified": {"developmentState": "QUALIFIED", "consumerAdmission": "ALLOWED", "profiles": ["default"]},
            "denied": {"developmentState": "NOT_QUALIFIED", "consumerAdmission": "DENIED", "profiles": ["default"]},
        }
    }
    assert require_exact_capability_advertisement(registry, "default", ["qualified"]) == {"qualified"}
    with pytest.raises(CapabilityAdvertisingError) as missing:
        require_exact_capability_advertisement(registry, "default", [])
    assert missing.value.missing == {"qualified"}
    with pytest.raises(CapabilityAdvertisingError) as leaked:
        require_exact_capability_advertisement(registry, "default", ["qualified", "denied"])
    assert leaked.value.unexpected == {"denied"}


@pytest.mark.asyncio
async def test_shared_outcome_store_fences_duplicate_and_late_replica_results(tmp_path: Path):
    store = FileOutcomeStore(tmp_path / "outcomes", claim_ttl_seconds=0.01)
    first = OperationRegistry(outcome_store=store, owner_id="replica-a")
    second = OperationRegistry(outcome_store=store, owner_id="replica-b")
    generation = "a" * 32
    operation = await first.begin("same-operation", "provider", 1000, generation)
    with pytest.raises(WorkerError) as duplicate:
        await second.begin("same-operation", "provider", 1000, generation)
    assert duplicate.value.code == "DUPLICATE_OPERATION"

    await asyncio.sleep(0.02)
    takeover = await second.begin("same-operation", "provider", 1000, generation)
    response = {"operationId": "same-operation", "status": "ok"}
    assert await first.publish_success(operation, response) is False
    assert await second.publish_success(takeover, response) is True
    replay = await first.get_outcome("same-operation", generation)
    assert replay is not None and replay.response == response
