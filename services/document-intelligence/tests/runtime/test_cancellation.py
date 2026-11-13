import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.runtime.cancellation import CancellationToken


def test_cancellation_prevents_late_publication():
    token = CancellationToken(); token.cancel()
    with pytest.raises(WorkerError) as error:
        token.raise_if_cancelled()
    assert error.value.code == 'CANCELLED'
