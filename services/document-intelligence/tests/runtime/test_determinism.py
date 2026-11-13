import os

import pytest

from document_intelligence.runtime.determinism import (
    DETERMINISM_ENVELOPE_SCHEMA,
    DeterminismEnvelope,
    StabilityPolicy,
    apply_process_determinism,
)


def test_determinism_envelope_is_explicit_and_order_stable():
    envelope = DeterminismEnvelope.from_environment({
        "DOCUMENT_INTELLIGENCE_DETERMINISM_SEED": "7",
        "DOCUMENT_INTELLIGENCE_PROVIDER_DETERMINISTIC_FLAGS": "zeta,alpha,alpha",
        "DOCUMENT_INTELLIGENCE_THREAD_COUNT": "2",
    })
    record = envelope.to_record()
    assert record["schemaVersion"] == DETERMINISM_ENVELOPE_SCHEMA
    assert record["randomSeed"] == 7
    assert record["providerDeterministicFlags"] == ["alpha", "zeta"]
    assert "hardwareInstructionSelection" in record["uncontrolledFields"]
    assert envelope.fingerprint() == DeterminismEnvelope.from_environment({
        "DOCUMENT_INTELLIGENCE_DETERMINISM_SEED": "7",
        "DOCUMENT_INTELLIGENCE_PROVIDER_DETERMINISTIC_FLAGS": "alpha,zeta",
        "DOCUMENT_INTELLIGENCE_THREAD_COUNT": "2",
    }).fingerprint()


def test_process_controls_are_applied_before_native_children():
    envelope = DeterminismEnvelope(thread_count=3, locale_name="C.UTF-8", timezone="UTC")
    apply_process_determinism(envelope)
    assert os.getenv("OMP_NUM_THREADS") == "3"
    assert os.getenv("TOKENIZERS_PARALLELISM") == "false"
    assert os.getenv("TZ") == "UTC"


def test_stability_policy_accepts_tolerated_float_drift_and_rejects_real_drift():
    policy = StabilityPolicy(absolute_tolerance=0.01, relative_tolerance=0.001)
    stable = policy.compare({"cer": 0.2, "p95Ms": 100.0}, {"cer": 0.205, "p95Ms": 100.05})
    unstable = policy.compare({"cer": 0.2}, {"cer": 0.25})
    assert stable.status == "STABLE"
    assert unstable.status == "UNSTABLE"
    assert unstable.differences["cer"] == pytest.approx(0.05)
