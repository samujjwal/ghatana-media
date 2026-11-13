from __future__ import annotations

from pathlib import Path

from document_intelligence.contracts import response, validate_provider_output
from document_intelligence.limits import Limits
from document_intelligence.providers.native_office_parser import PptxParser
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline


FIXTURE = Path(__file__).resolve().parents[2] / "evaluation/increment4a/corpus/qualification/pptx/ne-table-with-notes.pptx"
MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"


def test_ooxml_pptx_reader_uses_slide_geometry_and_excludes_notes() -> None:
    """The dependency-free OOXML reader under its truthful `ghatana.ooxml-*` identity."""
    parsed = PptxParser().parse(FIXTURE.read_bytes(), media_type=MEDIA_TYPE, limits={}, deadline=Deadline(10_000), token=CancellationToken(), language="ne")
    validate_provider_output(response("pptx-real", "ghatana.ooxml-pptx", parsed), Limits())

    page = parsed["pages"][0]
    text = " ".join(line["text"] for block in page["blocks"] for line in block["lines"])
    assert "बीजक नम्बर १००१ कुल १२५०" in text
    assert "DO NOT EMIT THIS SPEAKER NOTE" not in text
    table = page["tables"][0]
    assert (table["rowCount"], table["columnCount"]) == (2, 2)
    regions = [line["boundingRegion"] for block in page["blocks"] for line in block["lines"]]
    regions += [cell["boundingRegion"] for cell in table["cells"]]
    assert regions and all(0 <= region["x"] <= 1 and 0 <= region["y"] <= 1 for region in regions)
    assert all(region["width"] > 0 and region["height"] > 0 for region in regions)
    assert all(region != {"x": 0, "y": 0, "width": 1, "height": 1} for region in regions)
    assert parsed["providerProvenance"]["providerRef"] == "ghatana.ooxml-pptx"
