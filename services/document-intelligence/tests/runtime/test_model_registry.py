from document_intelligence.runtime.model_registry import ModelEntry, ModelRegistry


def test_registry_is_only_model_instantiation_boundary():
    calls = []
    registry = ModelRegistry()
    registry.register('model', ModelEntry('provider', '0.1.0', 'model', 'revision', lambda: calls.append(1) or object(), {'declared': True},))
    assert calls == []
    registry.get('model').load()
    assert calls == [1]
    registry.get('model').load()
    assert calls == [1]
    assert registry.catalog()[0]['promotionStatus'] == 'UNPROMOTED'
    assert 'declared' not in registry.catalog()[0]
    registry.accept_capabilities([{'providerRef': 'provider', 'capabilities': {'measured': True}}])
    assert registry.catalog()[0]['promotionStatus'] == 'ACCEPTED'
    assert registry.catalog()[0]['measured'] is True


def test_runtime_asset_roots_publish_verified_digests_without_paths(tmp_path):
    import hashlib

    key = 'ghatana.paddleocr__PP-OCRv5-en__PP-OCRv5-local-en'
    artifact_root = tmp_path / key
    artifact_root.mkdir()
    relative = 'weights.bin'
    (artifact_root / relative).write_bytes(b'pinned model bytes')
    digest = hashlib.sha256(relative.encode('utf-8') + b'pinned model bytes').hexdigest()
    (artifact_root / '.artifact.sha256').write_text(digest)
    registry = ModelRegistry()
    registry.register('paddle', ModelEntry(
        'ghatana.paddleocr', '0.1.0', 'PP-OCRv5-en', 'PP-OCRv5-local-en', lambda: object(), {},
        artifact_root=tmp_path,
        artifact_keys=(key,),
        language_model_identities=({'language': 'en', 'modelRef': 'PP-OCRv5-en', 'modelVersion': 'PP-OCRv5-local-en'},),
    ))
    rows = registry.runtime_asset_roots('ghatana.paddleocr')
    assert rows == [{
        'language': 'en',
        'providerRef': 'ghatana.paddleocr',
        'providerVersion': '0.1.0',
        'modelRef': 'PP-OCRv5-en',
        'modelVersion': 'PP-OCRv5-local-en',
        'artifactSha256': digest,
        'assetRootSha256': digest,
        'ready': True,
    }]
    assert all('path' not in row for row in rows)


def test_increment4a_artifact_promotes_only_precise_accepted_records():
    registry = ModelRegistry()
    registry.register('paddle', ModelEntry('ghatana.paddleocr', '0.1.0', 'paddle', 'revision', lambda: object(), {}))
    registry.register('gliner', ModelEntry('ghatana.gliner', '0.1.0', 'gliner', 'revision', lambda: object(), {}))
    registry.accept_capability_artifact({
        'qualificationStatus': 'PASS',
        'promotable': True,
        'accepted': [
            {'capabilityId': 'ocr.paddle.hi', 'providerRef': 'ghatana.paddleocr', 'language': 'hi'},
        ],
        'capabilities': [
            {'capabilityId': 'ocr.paddle.hi', 'providerRef': 'ghatana.paddleocr', 'state': 'QUALIFIED'},
            {'capabilityId': 'extraction.gliner.hi', 'providerRef': 'ghatana.gliner', 'state': 'NOT_QUALIFIED'},
            {'capabilityId': 'language.hi', 'providerRef': 'ghatana.gliner', 'state': 'QUALIFIED'},
        ],
    })
    catalog = {item['providerRef']: item for item in registry.catalog()}
    assert catalog['ghatana.paddleocr']['promotionStatus'] == 'ACCEPTED'
    assert catalog['ghatana.paddleocr']['capabilityIds'] == ['ocr.paddle.hi']
    assert catalog['ghatana.gliner']['promotionStatus'] == 'UNPROMOTED'


def test_increment4a_qualified_projection_without_accepted_never_promotes():
    """The exact bypass: QUALIFIED leaves + empty/non-promotable accepted must stay UNPROMOTED."""
    registry = ModelRegistry()
    registry.register('paddle', ModelEntry('ghatana.paddleocr', '0.1.0', 'paddle', 'revision', lambda: object(), {}))
    qualified_projection = [{'capabilityId': 'ocr.paddle.hi', 'providerRef': 'ghatana.paddleocr', 'state': 'QUALIFIED'}]
    for artifact in (
        {'qualificationStatus': 'NOT_RUN', 'promotable': False, 'accepted': [], 'capabilities': qualified_projection},
        {'qualificationStatus': 'PASS', 'promotable': False, 'accepted': [], 'capabilities': qualified_projection},
        {'qualificationStatus': 'PASS', 'accepted': [], 'capabilities': qualified_projection},
        {'qualificationStatus': 'PASS', 'promotable': True, 'capabilities': qualified_projection},
    ):
        registry.accept_capability_artifact(artifact)
        assert registry.catalog()[0]['promotionStatus'] == 'UNPROMOTED', artifact


def test_admitted_catalog_omits_unpromoted_installations_and_binds_language_models():
    registry = ModelRegistry()
    registry.register('paddle', ModelEntry(
        'ghatana.paddleocr',
        '0.1.0',
        'PP-OCRv5-en',
        'PP-OCRv5-local-en',
        lambda: object(),
        {},
        language_model_identities=(
            {'language': 'en', 'modelRef': 'PP-OCRv5-en', 'modelVersion': 'PP-OCRv5-local-en'},
            {'language': 'ne', 'modelRef': 'PP-OCRv5-devanagari-shared', 'modelVersion': 'PP-OCRv5-local-devanagari-shared'},
            {'language': 'hi', 'modelRef': 'PP-OCRv5-devanagari-shared', 'modelVersion': 'PP-OCRv5-local-devanagari-shared'},
        ),
    ))
    registry.register('experimental', ModelEntry('ghatana.tesseractocr', '0.1.0', 'tesseract-5', 'local', lambda: object(), {}))
    registry.accept_authority_records([
        {'providerRef': 'ghatana.paddleocr', 'languages': ['en'], 'mediaTypes': ['image/png'], 'valueTypes': [], 'capabilityIds': [], 'features': []},
        {'providerRef': 'ghatana.paddleocr', 'languages': ['ne'], 'mediaTypes': ['image/png'], 'valueTypes': [], 'capabilityIds': [], 'features': []},
    ])

    catalog = registry.admitted_catalog(('ghatana.paddleocr', 'ghatana.tesseractocr'))
    assert len(catalog) == 1
    assert catalog[0]['promotionStatus'] == 'ACCEPTED'
    assert catalog[0]['supportedLanguages'] == ['en', 'ne']
    assert catalog[0]['languageModelIdentities'] == [
        {'language': 'en', 'modelRef': 'PP-OCRv5-en', 'modelVersion': 'PP-OCRv5-local-en'},
        {'language': 'ne', 'modelRef': 'PP-OCRv5-devanagari-shared', 'modelVersion': 'PP-OCRv5-local-devanagari-shared'},
    ]
