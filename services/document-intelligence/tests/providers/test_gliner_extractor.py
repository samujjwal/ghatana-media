from document_intelligence.mapping.candidates import map_entity
from document_intelligence.mapping.evidence import project_lines
from document_intelligence.mapping.gliner_labels import build_label_policy
from document_intelligence.providers.gliner_extractor import GlinerExtractor
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline


def test_gliner_label_policy_is_stable_and_case_insensitive():
    policy = build_label_policy([{'fieldId': 'name', 'aliases': ['Name', 'Full name']}, {'fieldId': 'id', 'aliases': ['ID']}])
    assert policy.labels == ('name', 'Full name', 'id')
    assert policy.label_to_field['name'] == 'name'


def test_gliner_label_policy_prioritizes_language_local_aliases():
    policy = build_label_policy([{'fieldId': 'document_number', 'aliases': ['document number', 'invoice number', 'चालान संख्या']}], language='hi')
    assert policy.labels == ('चालान संख्या', 'document_number', 'document number', 'invoice number')
    assert policy.label_to_field['चालान संख्या'] == 'document_number'


def test_projection_retains_exact_offsets():
    text, intervals = project_lines([{'pageNumber': 1, 'blocks': [{'blockId': 'p1-b1', 'lines': [{'lineId': 'p1-b1-l1', 'text': 'नेपाली', 'boundingRegion': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}]}], 'tables': []}])
    assert text == 'नेपाली' and intervals[0].projection_start == 0 and intervals[0].projection_end == len(text)


def test_astral_unicode_evidence_uses_javascript_utf16_offsets():
    line = 'prefix 😀 नेपाली Alice suffix'
    text, intervals = project_lines([{'pageNumber': 1, 'blocks': [{'blockId': 'p1-b1', 'lines': [{'lineId': 'p1-b1-l1', 'text': line, 'boundingRegion': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}]}], 'tables': []}])
    start = text.index('Alice')
    mapped = map_entity('name', 'TEXT', start, start + len('Alice'), 0.9, text, intervals, {'providerRef': 'ghatana.gliner', 'providerVersion': '0.1.0', 'modelRef': 'model', 'modelVersion': '1'})
    assert mapped is not None
    span = mapped['evidence'][0]['textSpan']
    assert span == {'start': len(line[:start].encode('utf-16-le')) // 2, 'end': len(line[:start + len('Alice')].encode('utf-16-le')) // 2}
    encoded = line.encode('utf-16-le')
    assert encoded[span['start'] * 2:span['end'] * 2].decode('utf-16-le') == 'Alice'


def test_single_cardinality_selects_highest_confidence_entity():
    class Model:
        def predict_entities(self, text, labels, threshold):
            return [{'label': 'document_number', 'start': 0, 'end': 9, 'score': 0.1}, {'label': 'document_number', 'start': 10, 'end': 18, 'score': 0.9}]

    parsed = {'pages': [{'pageNumber': 1, 'blocks': [{'blockId': 'p1-b1', 'lines': [{'lineId': 'p1-b1-l1', 'text': 'Synthetic INV-1001', 'boundingRegion': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}]}]}]}
    result = GlinerExtractor(model_factory=Model).extract(parsed, [{'fieldId': 'document_number', 'aliases': [], 'valueType': 'IDENTIFIER', 'cardinality': 'SINGLE'}], deadline=Deadline(1000), token=CancellationToken())
    assert result['candidates'][0]['value']['value'] == 'INV-1001'


def test_single_cardinality_equal_scores_pick_earliest_position_regardless_of_return_order():
    """Equal confidences must not inherit model return order."""
    line = 'AAA-111 text BBB-222'

    class Model:
        reversed_order = False

        def predict_entities(self, text, labels, threshold):
            entities = [
                {'label': 'document_number', 'start': line.index('AAA-111'), 'end': line.index('AAA-111') + 7, 'score': 0.42},
                {'label': 'document_number', 'start': line.index('BBB-222'), 'end': line.index('BBB-222') + 7, 'score': 0.42},
            ]
            return list(reversed(entities)) if self.reversed_order else entities

    parsed = {'pages': [{'pageNumber': 1, 'blocks': [{'blockId': 'p1-b1', 'lines': [{'lineId': 'p1-b1-l1', 'text': line, 'boundingRegion': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}]}]}]}
    fields = [{'fieldId': 'document_number', 'aliases': [], 'valueType': 'IDENTIFIER', 'cardinality': 'SINGLE'}]
    model = Model()
    first = GlinerExtractor(model_factory=lambda: model).extract(parsed, fields, deadline=Deadline(1000), token=CancellationToken())
    model.reversed_order = True
    second = GlinerExtractor(model_factory=lambda: model).extract(parsed, fields, deadline=Deadline(1000), token=CancellationToken())
    assert len(first['candidates']) == 1 and len(second['candidates']) == 1
    assert first['candidates'][0]['value']['value'] == 'AAA-111'
    assert second['candidates'][0]['value']['value'] == 'AAA-111'


def test_no_entity_model_output_produces_no_candidates():
    class Model:
        def predict_entities(self, text, labels, threshold):
            return []

    parsed = {'pages': [{'pageNumber': 1, 'blocks': [{'blockId': 'p1-b1', 'lines': [{'lineId': 'p1-b1-l1', 'text': 'nothing to extract', 'boundingRegion': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}]}]}]}
    result = GlinerExtractor(model_factory=Model).extract(parsed, [{'fieldId': 'document_number', 'aliases': [], 'valueType': 'IDENTIFIER', 'cardinality': 'SINGLE'}], deadline=Deadline(1000), token=CancellationToken())
    assert result['candidates'] == []


def test_low_score_entities_are_emitted_with_honest_confidence():
    class Model:
        def predict_entities(self, text, labels, threshold):
            return [{'label': 'document_number', 'start': 0, 'end': 7, 'score': 0.04}]

    parsed = {'pages': [{'pageNumber': 1, 'blocks': [{'blockId': 'p1-b1', 'lines': [{'lineId': 'p1-b1-l1', 'text': 'AAA-111', 'boundingRegion': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}]}]}]}
    result = GlinerExtractor(model_factory=Model).extract(parsed, [{'fieldId': 'document_number', 'aliases': [], 'valueType': 'IDENTIFIER', 'cardinality': 'SINGLE'}], deadline=Deadline(1000), token=CancellationToken())
    assert len(result['candidates']) == 1
    assert result['candidates'][0]['confidence'] == 0.04


def test_astral_unicode_before_entity_uses_utf16_evidence_offsets():
    """Astral characters before an entity must not shift JavaScript-visible spans."""
    line = 'prefix 😀 invoice INV-1001'

    class Model:
        def predict_entities(self, text, labels, threshold):
            start = text.index('INV-1001')
            return [{'label': 'document_number', 'start': start, 'end': start + len('INV-1001'), 'score': 0.9}]

    parsed = {'pages': [{'pageNumber': 1, 'blocks': [{'blockId': 'p1-b1', 'lines': [{'lineId': 'p1-b1-l1', 'text': line, 'boundingRegion': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}]}]}]}
    result = GlinerExtractor(model_factory=Model).extract(parsed, [{'fieldId': 'document_number', 'aliases': [], 'valueType': 'IDENTIFIER', 'cardinality': 'SINGLE'}], deadline=Deadline(1000), token=CancellationToken())
    span = result['candidates'][0]['evidence'][0]['textSpan']
    encoded = line.encode('utf-16-le')
    assert encoded[span['start'] * 2:span['end'] * 2].decode('utf-16-le') == 'INV-1001'
    assert span['start'] == len(line[:line.index('INV-1001')].encode('utf-16-le')) // 2


def test_astral_unicode_inside_entity_uses_utf16_evidence_offsets():
    line = 'invoice 😀INV-9😀 tail'

    class Model:
        def predict_entities(self, text, labels, threshold):
            start = text.index('😀INV-9😀')
            value = '😀INV-9😀'
            return [{'label': 'document_number', 'start': start, 'end': start + len(value), 'score': 0.9}]

    parsed = {'pages': [{'pageNumber': 1, 'blocks': [{'blockId': 'p1-b1', 'lines': [{'lineId': 'p1-b1-l1', 'text': line, 'boundingRegion': {'x': 0, 'y': 0, 'width': 1, 'height': 1}}]}]}]}
    result = GlinerExtractor(model_factory=Model).extract(parsed, [{'fieldId': 'document_number', 'aliases': [], 'valueType': 'IDENTIFIER', 'cardinality': 'SINGLE'}], deadline=Deadline(1000), token=CancellationToken())
    span = result['candidates'][0]['evidence'][0]['textSpan']
    encoded = line.encode('utf-16-le')
    assert encoded[span['start'] * 2:span['end'] * 2].decode('utf-16-le') == '😀INV-9😀'

def test_default_model_uses_only_pinned_local_loader_options(monkeypatch, tmp_path):
    from gliner import GLiNER
    from document_intelligence.providers import gliner_extractor

    cache_root = tmp_path / "models"
    artifact_path = cache_root / "ghatana.gliner__urchade_gliner_multi-v2.1__443d26d"
    observed = {}

    def fake_from_pretrained(model_id, **kwargs):
        observed["model_id"] = model_id
        observed["kwargs"] = kwargs
        return object()

    monkeypatch.setenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", str(cache_root))
    monkeypatch.setattr(gliner_extractor, "validate_model_artifact", lambda path: observed.update(artifact_path=path))
    monkeypatch.setattr(GLiNER, "from_pretrained", staticmethod(fake_from_pretrained))

    model = gliner_extractor._default_model()

    assert model is not None
    assert observed["artifact_path"] == artifact_path
    assert observed["model_id"] == str(artifact_path)
    assert observed["kwargs"] == {
        "cache_dir": artifact_path / "hf-cache",
        "local_files_only": True,
    }

