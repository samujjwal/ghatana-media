import importlib.util
import os
import asyncio
from pathlib import Path

import pytest

from document_intelligence.config import WorkerSettings
from document_intelligence.contracts import response, validate_provider_output
from document_intelligence.lifecycle import WorkerRuntime
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline


@pytest.mark.parametrize('module', ['docling', 'paddleocr', 'gliner', 'sentence_transformers'])
def test_real_provider_requires_explicit_local_provisioning(module):
    if os.getenv('DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS') != '1':
        pytest.skip('real provider promotion runs require explicit opt-in')
    if importlib.util.find_spec(module) is None:
        pytest.skip(f'{module} is not provisioned in this environment')
    assert importlib.util.find_spec(module) is not None


@pytest.mark.integration
def test_real_provider_round_trip_against_safe_corpus():
    if os.getenv('DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS') != '1':
        pytest.skip('real provider promotion runs require explicit opt-in')
    required = ['docling', 'paddleocr', 'gliner', 'sentence_transformers']
    if any(importlib.util.find_spec(module) is None for module in required):
        pytest.skip('declared provider packages are not provisioned')
    root = Path(__file__).resolve().parents[2]
    corpus = root / 'evaluation' / 'corpus'
    settings = WorkerSettings.from_env()
    runtime = WorkerRuntime.create(settings)
    asyncio.run(runtime.start())
    assert runtime.health.ready, runtime.health.reason
    token = CancellationToken()
    deadline = Deadline(120_000)
    docling = runtime.providers['ghatana.docling']
    parsed = docling.parse((corpus / 'pdf-en-simple.pdf').read_bytes(), media_type='application/pdf', limits={'maxPages': settings.limits.max_pages}, deadline=deadline, token=token)
    assert parsed['providerProvenance']['providerRef'] == 'ghatana.docling'
    paddle = runtime.providers['ghatana.paddleocr']
    image = next(corpus.glob('image-en-clean.*'))
    ocr = paddle.parse(image.read_bytes(), media_type='image/png', language='en', deadline=Deadline(120_000), token=CancellationToken())
    assert ocr['providerProvenance']['modelRef'] == 'PP-OCRv5-en'
    nepali_image = next(corpus.glob('image-ne-clean.*'))
    nepali_ocr = paddle.parse(nepali_image.read_bytes(), media_type='image/png', language='ne', deadline=Deadline(120_000), token=CancellationToken())
    assert nepali_ocr['providerProvenance']['modelRef'] == 'PP-OCRv5-devanagari-shared'
    extracted = runtime.providers['ghatana.gliner'].extract(parsed, [{'fieldId': 'document_number', 'aliases': ['invoice number'], 'valueType': 'IDENTIFIER', 'cardinality': 'SINGLE'}], deadline=Deadline(120_000), token=CancellationToken(), language='en')
    assert extracted['provider']['providerRef'] == 'ghatana.gliner'
    projection = {'version': 'document-structure-embedding.v1', 'pageCount': 1, 'blockKindCounts': {'TEXT': 1}, 'tableShapes': [], 'normalizedBlockGeometry': [{'pageNumber': 1, 'x': 0.1, 'y': 0.1, 'width': 0.5, 'height': 0.1}], 'semanticTextBasis': 'Synthetic English invoice number INV-1001', 'structuralFingerprint': 'integration-fixture'}
    embedding = runtime.providers['ghatana.minilm'].embed(projection, deadline=Deadline(120_000), token=CancellationToken())
    assert embedding['dimensions'] == 384 and len(embedding['values']) == 384
    for operation_id, provider_ref, output in [('docling-real', 'ghatana.docling', parsed), ('paddle-en-real', 'ghatana.paddleocr', ocr), ('paddle-ne-real', 'ghatana.paddleocr', nepali_ocr), ('gliner-real', 'ghatana.gliner', extracted), ('minilm-real', 'ghatana.minilm', embedding)]:
        validate_provider_output(response(operation_id, provider_ref, output), settings.limits)
    asyncio.run(runtime.shutdown())
