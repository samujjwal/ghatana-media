from document_intelligence.mapping.embeddings import canonical_projection


def test_minilm_projection_is_canonical_for_equivalent_input_order():
    first = {'version': 'document-structure-embedding.v1', 'pageCount': 1, 'blockKindCounts': {'TEXT': 1, 'TABLE': 0}, 'tableShapes': [], 'normalizedBlockGeometry': [{'pageNumber': 1, 'x': 0, 'y': 0, 'width': 1, 'height': 1}], 'semanticTextBasis': 'hello', 'structuralFingerprint': 'fp'}
    second = {**first, 'blockKindCounts': {'TABLE': 0, 'TEXT': 1}}
    assert canonical_projection(first) == canonical_projection(second)
