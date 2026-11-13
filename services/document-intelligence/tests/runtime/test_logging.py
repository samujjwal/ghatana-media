from document_intelligence.observability import safe_event


def test_safe_logging_excludes_sensitive_fields():
    event = safe_event(operationId='op', providerRef='provider', text='secret', filename='secret.pdf', status='failure')
    assert event == {'operationId': 'op', 'providerRef': 'provider', 'status': 'failure'}


def test_safe_logging_sanitizes_diagnostics_and_bounds_values():
    event = safe_event(
        diagnostic='token=secret /srv/private/document.pdf\x00',
        operationId='op',
    )
    assert event['diagnostic'] == 'token=[REDACTED] [PATH]'
