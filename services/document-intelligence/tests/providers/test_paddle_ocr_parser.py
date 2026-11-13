import io

import numpy as np
import pytest
from PIL import Image

from document_intelligence.errors import WorkerError
from document_intelligence.providers.paddle_ocr_parser import PaddleOcrParser, map_paddle_regions
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline


def test_paddle_maps_one_text_block_per_region_and_normalizes_geometry():
    result = map_paddle_regions([{'text': 'hello', 'bbox': [10, 20, 50, 40], 'score': 0.9}], 100, 100, 'en')
    block = result['pages'][0]['blocks'][0]
    assert block['kind'] == 'TEXT' and block['lines'][0]['text'] == 'hello' and block['lines'][0]['confidence'] == 0.9
    assert result['pages'][0]['tables'] == []


def test_paddle_maps_numpy_polygons_from_real_runtime_output():
    polygon = np.asarray([[10, 20], [50, 20], [50, 40], [10, 40]])
    result = map_paddle_regions([{'text': 'hello', 'polygon': polygon, 'score': 0.9}], 100, 100, 'en')
    assert result['pages'][0]['blocks'][0]['lines'][0]['text'] == 'hello'


def test_paddle_selects_exact_english_and_nepali_model_and_rejects_other_languages():
    selected = []

    class FakeModel:
        def predict(self, _image):
            return []

    def factory(language):
        selected.append(language)
        return FakeModel()

    image = Image.new('RGB', (8, 8), 'white')
    output = io.BytesIO()
    image.save(output, format='PNG')
    data = output.getvalue()
    parser = PaddleOcrParser(factory, admitted_languages=('en', 'ne'))

    for language, model_ref, model_version in (
        ('en', 'PP-OCRv5-en', 'PP-OCRv5-local-en'),
        ('ne', 'PP-OCRv5-devanagari-shared', 'PP-OCRv5-local-devanagari-shared'),
    ):
        result = parser.parse(
            data,
            media_type='image/png',
            language=language,
            deadline=Deadline(1_000, margin_ms=0),
            token=CancellationToken(),
        )
        assert result['providerProvenance']['modelRef'] == model_ref
        assert result['providerProvenance']['modelVersion'] == model_version

    assert selected == ['en', 'ne']
    assert parser.language_model_identities() == (
        {'language': 'en', 'modelRef': 'PP-OCRv5-en', 'modelVersion': 'PP-OCRv5-local-en'},
        {'language': 'ne', 'modelRef': 'PP-OCRv5-devanagari-shared', 'modelVersion': 'PP-OCRv5-local-devanagari-shared'},
    )
    with pytest.raises(WorkerError) as error:
        parser.parse(
            data,
            media_type='image/png',
            language='hi',
            deadline=Deadline(1_000, margin_ms=0),
            token=CancellationToken(),
        )
    assert error.value.code == 'UNSUPPORTED_LANGUAGE'
    assert selected == ['en', 'ne']
