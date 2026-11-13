from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from document_intelligence.increment6.observability import (  # noqa: E402
    BoundedMetricRecorder,
    TraceCorrelation,
    redact_diagnostics,
)


def test_metrics_have_bounded_labels_and_series():
    recorder = BoundedMetricRecorder(max_series=1)
    assert recorder.observe('documents_total', 1, labels={'status': 'ok'})
    assert recorder.observe('documents_total', 2, labels={'status': 'ok'})
    assert not recorder.observe('documents_total', 1, labels={'status': 'failed'})
    with pytest.raises(ValueError):
        recorder.observe('documents_total', 1, labels={'operationId': 'unbounded'})


def test_trace_correlation_and_diagnostics_are_content_free():
    assert TraceCorrelation('req', 'op', 'attempt', 'campaign').as_fields() == {
        'requestId': 'req',
        'operationId': 'op',
        'providerAttemptId': 'attempt',
        'campaignId': 'campaign',
    }
    assert redact_diagnostics({'status': 'failed', 'text': 'secret', 'nested': {'filename': 'x'}}) == {
        'status': 'failed',
        'nested': {},
    }

