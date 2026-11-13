from __future__ import annotations

from pathlib import Path

from document_intelligence.contracts import response, validate_provider_output
from document_intelligence.limits import Limits
from document_intelligence.providers.native_office_parser import XlsxParser
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline


FIXTURE = Path(__file__).resolve().parents[2] / "evaluation/increment4a/corpus/qualification/xlsx/hi-sparse-merged.xlsx"
MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def test_ooxml_xlsx_reader_preserves_sparse_cells_merges_and_geometry() -> None:
    """The dependency-free OOXML reader under its truthful `ghatana.ooxml-*` identity."""
    parsed = XlsxParser().parse(FIXTURE.read_bytes(), media_type=MEDIA_TYPE, limits={}, deadline=Deadline(10_000), token=CancellationToken(), language="hi")
    validate_provider_output(response("xlsx-real", "ghatana.ooxml-xlsx", parsed), Limits())

    table = parsed["pages"][0]["tables"][0]
    cells = {(cell["rowIndex"], cell["columnIndex"]): cell for cell in table["cells"]}
    assert cells[(1, 1)]["text"] == "चालान संख्या १००१"
    assert cells[(1, 1)]["columnSpan"] == 2
    assert cells[(1, 3)]["text"] == "कुल"
    assert cells[(4, 3)]["text"] == "१२५०"
    assert (1, 0) not in cells and (3, 0) not in cells, "sparse blank cells must not be fabricated"
    regions = [table["boundingRegion"]] + [cell["boundingRegion"] for cell in table["cells"]]
    assert all(region["width"] > 0 and region["height"] > 0 for region in regions)
    assert all(region != {"x": 0, "y": 0, "width": 1, "height": 1} for region in regions)
    assert parsed["providerProvenance"]["providerRef"] == "ghatana.ooxml-xlsx"
