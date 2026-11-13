import pytest

from document_intelligence.providers.docling_parser import DoclingParser, map_docling_document
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline


def page():
    return {'pageNumber': 1, 'width': 100, 'height': 100, 'blocks': [{'bbox': [10, 20, 40, 30], 'lines': [{'text': 'Header', 'bbox': [10, 20, 40, 30]}]}], 'tables': []}


def test_docling_mapping_is_deterministic_and_normalized():
    first = map_docling_document({'pages': [page()]}); second = map_docling_document({'pages': [page()]})
    assert first == second and first['pages'][0]['blocks'][0]['blockId'] == 'p1-b1'
    assert first['pages'][0]['blocks'][0]['boundingRegion']['x'] == 0.1


def test_docling_export_maps_table_grid_cells():
    class Document:
        def export_to_dict(self):
            return {
                'pages': {'1': {'page_no': 1, 'size': {'width': 100, 'height': 100}}},
                'texts': [],
                'tables': [{
                    'prov': [{'page_no': 1, 'bbox': {'l': 10, 't': 80, 'r': 90, 'b': 20}}],
                    'data': {
                        'num_rows': 2,
                        'num_cols': 2,
                        'table_cells': [
                            {'start_row_offset_idx': 0, 'start_col_offset_idx': 0, 'row_span': 1, 'col_span': 1, 'text': 'Item', 'bbox': {'l': 10, 't': 80, 'r': 50, 'b': 50}},
                            {'start_row_offset_idx': 0, 'start_col_offset_idx': 1, 'row_span': 1, 'col_span': 1, 'text': 'Price', 'bbox': {'l': 50, 't': 80, 'r': 90, 'b': 50}},
                            {'start_row_offset_idx': 1, 'start_col_offset_idx': 0, 'row_span': 1, 'col_span': 1, 'text': 'Widget', 'bbox': {'l': 10, 't': 50, 'r': 50, 'b': 20}},
                            {'start_row_offset_idx': 1, 'start_col_offset_idx': 1, 'row_span': 1, 'col_span': 1, 'text': '10.00', 'bbox': {'l': 50, 't': 50, 'r': 90, 'b': 20}},
                        ],
                    },
                }],
            }

    table = map_docling_document(Document())['pages'][0]['tables'][0]
    assert table['rowCount'] == 2 and table['columnCount'] == 2
    assert [(cell['rowIndex'], cell['columnIndex'], cell['text']) for cell in table['cells']] == [
        (0, 0, 'Item'), (0, 1, 'Price'), (1, 0, 'Widget'), (1, 1, '10.00'),
    ]
    assert table['cells'][0]['boundingRegion'] == {'x': 0.1, 'y': 0.2, 'width': 0.4, 'height': 0.3}


def test_docling_validates_pdf_and_identity():
    parser = DoclingParser(lambda: type('Converter', (), {'convert': lambda _self, _value: type('Result', (), {'document': {'pages': [page()]}})()})())
    output = parser.parse(b'%PDF-1.7', media_type='application/pdf', limits={}, deadline=Deadline(1000), token=CancellationToken())
    assert output['providerProvenance']['providerRef'] == 'ghatana.docling'
    with pytest.raises(Exception):
        parser.parse(b'not-a-pdf', media_type='application/pdf', limits={}, deadline=Deadline(1000), token=CancellationToken())
