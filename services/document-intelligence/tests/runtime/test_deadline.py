from document_intelligence.errors import WorkerError
from document_intelligence.runtime.deadline import Deadline


def test_deadline_has_remaining_budget():
    deadline = Deadline(1000)
    assert 0 < deadline.remaining_ms() <= 1000


def test_expired_deadline_fails_with_timeout():
    with __import__('pytest').raises(WorkerError) as error:
        Deadline(0).require_remaining()
    assert error.value.code == 'TIMEOUT'
