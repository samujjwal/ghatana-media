import math

import pytest

from document_intelligence.errors import WorkerError, sanitized_error
from document_intelligence.mapping.parsed_document import normalized_box


def test_invalid_geometry_and_unknown_exception_are_sanitized():
    with pytest.raises(WorkerError):
        normalized_box(0, 0, 2, 1)
    envelope = sanitized_error(RuntimeError('document SECRET value'), 'op', 'provider')
    assert 'SECRET' not in str(envelope) and envelope['code'] == 'PROVIDER_FAILED'


def test_nan_is_not_valid_geometry():
    with pytest.raises(WorkerError):
        normalized_box(math.nan, 0, 1, 1)
