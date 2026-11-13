from document_intelligence.health import HealthState


def test_health_and_readiness_are_distinct():
    state = HealthState(ready=False, reason='model')
    assert state.healthz() == {'status': 'ok'}
    assert state.readyz()['status'] == 'not_ready'


def test_provider_authority_mismatch_is_a_safe_readiness_detail():
    state = HealthState(
        ready=False,
        reason='runtime provider catalog does not match admitted authority',
        reason_code='PROVIDER_AUTHORITY_MISMATCH',
        details={
            'expectedFingerprint': 'a' * 64,
            'observedFingerprint': 'b' * 64,
            'missing': [{'providerRef': 'ghatana.paddleocr', 'modelRef': 'PP-OCRv5-devanagari-shared', 'language': 'ne'}],
            'unexpected': [],
            'mismatched': [],
        },
    )
    assert state.healthz() == {'status': 'ok'}
    ready = state.readyz()
    assert ready['status'] == 'not_ready'
    assert ready['reasonCode'] == 'PROVIDER_AUTHORITY_MISMATCH'
    assert ready['details']['missing'][0]['language'] == 'ne'
    assert 'path' not in str(ready).lower()
