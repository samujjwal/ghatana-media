import pytest

from document_intelligence.runtime import core_dumps


def test_core_dump_policy_is_explicit_and_fail_closed():
    policy = core_dumps.apply_core_dump_policy(strict=False)
    record = policy.to_record()
    assert record["schemaVersion"] == "document-intelligence.core-dump-policy.v1"
    assert record["coreLimit"] == [0, 0]
    assert record["faultHandlerDisabled"] is True


def test_strict_core_dump_policy_rejects_unavailable_rlimit(monkeypatch):
    monkeypatch.setattr(core_dumps, "resource", None)
    monkeypatch.setattr(core_dumps, "_disable_linux_dumpable", lambda: True)
    with pytest.raises(RuntimeError, match="CORE_DUMP_POLICY_UNAVAILABLE"):
        core_dumps.apply_core_dump_policy(strict=True)
