from __future__ import annotations

from pathlib import Path

from document_intelligence.contracts import response, validate_provider_output
from document_intelligence.limits import Limits
from document_intelligence.providers.native_office_parser import DocxParser
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline


FIXTURE = Path(__file__).resolve().parents[2] / "evaluation/increment4a/corpus/qualification/docx/mr-merged-table.docx"
MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def test_ooxml_docx_reader_preserves_text_merges_and_layout() -> None:
    """The dependency-free OOXML reader under its truthful `ghatana.ooxml-*` identity."""
    parsed = DocxParser().parse(FIXTURE.read_bytes(), media_type=MEDIA_TYPE, limits={}, deadline=Deadline(10_000), token=CancellationToken(), language="mr")
    validate_provider_output(response("docx-real", "ghatana.ooxml-docx", parsed), Limits())

    page = parsed["pages"][0]
    text = " ".join(line["text"] for block in page["blocks"] for line in block["lines"])
    assert "बीजक क्रमांक १००१ एकूण १२५०" in text
    table = page["tables"][0]
    assert (table["rowCount"], table["columnCount"]) == (3, 3)
    assert any(cell.get("columnSpan") == 3 for cell in table["cells"])
    assert any(cell.get("rowSpan") == 2 for cell in table["cells"])
    regions = [line["boundingRegion"] for block in page["blocks"] for line in block["lines"]]
    regions += [cell["boundingRegion"] for cell in table["cells"]]
    assert regions and all(region["width"] > 0 and region["height"] > 0 for region in regions)
    assert all(region != {"x": 0, "y": 0, "width": 1, "height": 1} for region in regions)
    assert parsed["providerProvenance"]["providerRef"] == "ghatana.ooxml-docx"
