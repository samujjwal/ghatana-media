from document_intelligence.runtime.provider_authority import (
    FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256,
    authority_records_from_artifact,
    compare_provider_authority,
    fingerprint_records,
    normalize_observed_catalog,
    read_authority,
)
from pathlib import Path


def _authority():
    return {
        'declared': {
            'models': [
                {'providerRef': 'ghatana.paddleocr', 'providerVersion': '0.1.0', 'modelRef': 'PP-OCRv5-en', 'modelRevision': 'PP-OCRv5-local-en', 'language': 'en'},
                {'providerRef': 'ghatana.paddleocr', 'providerVersion': '0.1.0', 'modelRef': 'PP-OCRv5-devanagari-shared', 'modelRevision': 'PP-OCRv5-local-devanagari-shared', 'language': 'ne'},
            ],
        },
        'accepted': [
            {
                'providerRef': 'ghatana.paddleocr',
                'capabilities': {
                    'mediaTypes': ['image/png', 'image/jpeg'],
                    'supportedLanguages': ['en', 'ne'],
                    'supportsCoordinates': True,
                    'supportsLanguages': True,
                    'supportsTables': False,
                },
            },
        ],
    }


def _catalog():
    return {
        'protocolVersion': 'document-intelligence.v1',
        'providers': [{
            'providerRef': 'ghatana.paddleocr',
            'providerVersion': '0.1.0',
            'modelRef': 'PP-OCRv5-en',
            'modelVersion': 'PP-OCRv5-local-en',
            'promotionStatus': 'ACCEPTED',
            'mediaTypes': ['image/jpeg', 'image/png'],
            'languages': ['en', 'ne'],
            'supportsCoordinates': True,
            'supportsLanguages': True,
            'supportsTables': False,
            'loaded': True,
            'ready': True,
            'languageModelIdentities': [
                {'language': 'en', 'modelRef': 'PP-OCRv5-en', 'modelVersion': 'PP-OCRv5-local-en'},
                {'language': 'ne', 'modelRef': 'PP-OCRv5-devanagari-shared', 'modelVersion': 'PP-OCRv5-local-devanagari-shared'},
            ],
        }],
    }


def test_frozen_authority_matches_language_specific_runtime_publication():
    expected = authority_records_from_artifact(_authority())
    observed = normalize_observed_catalog(_catalog())
    diff = compare_provider_authority(expected, observed)
    assert diff['missing'] == []
    assert diff['unexpected'] == []
    assert diff['mismatched'] == []
    assert diff['expectedFingerprint'] == diff['observedFingerprint']
    assert {tuple(row['languages']) + (row['modelRef'], row['modelVersion']) for row in expected} == {
        ('en', 'PP-OCRv5-en', 'PP-OCRv5-local-en'),
        ('ne', 'PP-OCRv5-devanagari-shared', 'PP-OCRv5-local-devanagari-shared'),
    }


def test_model_identity_drift_is_reported_as_language_mismatch():
    expected = authority_records_from_artifact(_authority())
    observed_catalog = _catalog()
    observed_catalog['providers'][0]['languageModelIdentities'][1]['modelRef'] = 'PP-OCRv5-ne'
    observed = normalize_observed_catalog(observed_catalog)
    diff = compare_provider_authority(expected, observed)
    assert diff['mismatched'][0]['providerRef'] == 'ghatana.paddleocr'
    assert diff['mismatched'][0]['languages'] == ['ne']
    assert 'modelRef' in diff['mismatched'][0]['fields']
    assert fingerprint_records(expected) != fingerprint_records(observed)


def test_unpromoted_live_catalog_entry_is_not_treated_as_admitted():
    expected = authority_records_from_artifact(_authority())
    catalog = _catalog()
    catalog['providers'][0]['promotionStatus'] = 'UNPROMOTED'
    diff = compare_provider_authority(expected, normalize_observed_catalog(catalog))
    assert diff['mismatched'][0]['fields']['promotionStatus'] == {
        'expected': 'ACCEPTED',
        'observed': 'UNPROMOTED',
    }


def test_frozen_increment3_authority_retains_docling_and_exact_paddle_languages():
    worker_root = Path(__file__).resolve().parents[2]
    records, source_fingerprint = read_authority(
        worker_root / 'evaluation/results/20260919T022904Z-cf9e659f/capabilities.json',
        FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256,
    )
    by_provider_language = {
        (record['providerRef'], tuple(record['languages'])): (record['modelRef'], record['modelVersion'])
        for record in records
    }
    assert source_fingerprint == FROZEN_INCREMENT3_PROVIDER_AUTHORITY_SHA256
    assert by_provider_language[('ghatana.docling', ('en',))] == (
        'docling-standard-pdf-pipeline',
        'pinned-docling-runtime',
    )
    assert by_provider_language[('ghatana.docling', ('ne',))] == (
        'docling-standard-pdf-pipeline',
        'pinned-docling-runtime',
    )
    assert by_provider_language[('ghatana.paddleocr', ('en',))] == (
        'PP-OCRv5-en',
        'PP-OCRv5-local-en',
    )
    assert by_provider_language[('ghatana.paddleocr', ('ne',))] == (
        'PP-OCRv5-devanagari-shared',
        'PP-OCRv5-local-devanagari-shared',
    )
