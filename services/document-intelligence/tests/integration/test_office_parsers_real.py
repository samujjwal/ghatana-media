"""Real Office provider qualification: Docling PPTX/XLSX and rendered DOCX.

These tests run the actual pinned Docling runtime (and the real bounded DOCX
renderer feeding it) against the generated qualification corpus.  Geometry is
asserted as real provider provenance — PPTX slide boxes and XLSX grid boxes
come from Docling output; DOCX coordinates come from the rendered PDF, never
from synthesized line/page guesses.
"""
from __future__ import annotations

import asyncio
import importlib.util
import os
from pathlib import Path

import pytest

from document_intelligence.contracts import response, validate_provider_output
from document_intelligence.limits import Limits
from document_intelligence.providers.docling_office_parser import DoclingPptxParser, DoclingXlsxParser
from document_intelligence.providers.docling_parser import DoclingParser
from document_intelligence.providers.office_rendered_parser import OfficeRenderedParser
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "evaluation" / "increment4a" / "corpus" / "qualification"

DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _gated() -> None:
    if os.getenv("DOCUMENT_INTELLIGENCE_RUN_REAL_PROVIDERS") != "1":
        pytest.skip("real provider qualification requires explicit opt-in")
    if importlib.util.find_spec("docling") is None:
        pytest.skip("pinned Docling runtime is not provisioned")


def _regions(document: dict) -> list[dict]:
    regions = [line["boundingRegion"] for page in document["pages"] for block in page["blocks"] for line in block["lines"]]
    regions += [cell["boundingRegion"] for page in document["pages"] for table in page["tables"] for cell in table["cells"]]
    return regions


def _assert_real_geometry(document: dict) -> None:
    regions = _regions(document)
    assert regions, "real provider output must carry geometry"
    assert all(0 <= region["x"] <= 1 and 0 <= region["y"] <= 1 for region in regions)
    assert all(region["width"] > 0 and region["height"] > 0 for region in regions)
    assert any(region != {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0} for region in regions)


@pytest.mark.integration
@pytest.mark.parametrize("language", ["en", "ne", "hi", "mr"])
def test_docling_pptx_real(language: str) -> None:
    _gated()
    parsed = DoclingPptxParser().parse((CORPUS / "pptx" / language / f"{language}-simple.pptx").read_bytes(), media_type=PPTX, limits={}, deadline=Deadline(120_000), token=CancellationToken(), language=language)
    validate_provider_output(response(f"pptx-{language}", "ghatana.docling-pptx", parsed), Limits())
    assert parsed["providerProvenance"]["providerRef"] == "ghatana.docling-pptx"
    assert parsed["providerProvenance"]["modelRef"] == "docling-standard-pptx-pipeline"
    text = " ".join(line["text"] for page in parsed["pages"] for block in page["blocks"] for line in block["lines"])
    assert text.strip(), "Docling PPTX must emit real text"
    _assert_real_geometry(parsed)


@pytest.mark.integration
def test_docling_pptx_excludes_speaker_notes_real() -> None:
    _gated()
    parsed = DoclingPptxParser().parse((CORPUS / "pptx" / "ne-table-with-notes.pptx").read_bytes(), media_type=PPTX, limits={}, deadline=Deadline(120_000), token=CancellationToken(), language="ne")
    validate_provider_output(response("pptx-ne-notes", "ghatana.docling-pptx", parsed), Limits())
    text = " ".join(line["text"] for page in parsed["pages"] for block in page["blocks"] for line in block["lines"])
    table_text = " ".join(cell["text"] for page in parsed["pages"] for table in page["tables"] for cell in table["cells"])
    assert "बीजक नम्बर १००१" in text
    assert "DO NOT EMIT THIS SPEAKER NOTE" not in text
    assert "DO NOT EMIT THIS SPEAKER NOTE" not in table_text
    assert "कुञ्जी" in table_text and "१२५०" in table_text
    _assert_real_geometry(parsed)


@pytest.mark.integration
@pytest.mark.parametrize("language", ["en", "ne", "hi", "mr"])
def test_docling_xlsx_real(language: str) -> None:
    _gated()
    parsed = DoclingXlsxParser().parse((CORPUS / "xlsx" / language / f"{language}-simple.xlsx").read_bytes(), media_type=XLSX, limits={}, deadline=Deadline(120_000), token=CancellationToken(), language=language)
    validate_provider_output(response(f"xlsx-{language}", "ghatana.docling-xlsx", parsed), Limits())
    assert parsed["providerProvenance"]["providerRef"] == "ghatana.docling-xlsx"
    table = parsed["pages"][0]["tables"][0]
    assert table["rowCount"] >= 1 and table["columnCount"] >= 1
    assert table["cells"], "XLSX grid geometry is a coordinate transform of real declared structure"
    _assert_real_geometry(parsed)


class _DoclingExecutor:
    """Minimal executor delegating to the real DoclingParser for the rendered DOCX path."""

    def __init__(self) -> None:
        self.docling = DoclingParser()
        self.calls: list[tuple[str, str | None]] = []

    async def parse(self, provider: str, data: bytes, **kwargs) -> dict:
        self.calls.append((provider, kwargs.get("media_type")))
        assert provider == "ghatana.docling"
        return self.docling.parse(data, media_type=kwargs.get("media_type"), language=kwargs.get("language"), limits=kwargs.get("limits", {}), deadline=kwargs["deadline"], token=kwargs["token"])


@pytest.mark.integration
@pytest.mark.parametrize("language", ["en", "ne", "hi", "mr"])
def test_rendered_docx_real(language: str) -> None:
    """DOCX -> deterministic bounded render -> real PDF -> qualified Docling parse."""
    _gated()
    parser = OfficeRenderedParser()
    executor = _DoclingExecutor()
    parsed = asyncio.run(
        parser.parse(
            (CORPUS / "docx" / language / f"{language}-simple.docx").read_bytes(),
            media_type=DOCX,
            language=language,
            limits={},
            deadline=Deadline(120_000),
            token=CancellationToken(),
            executor=executor,
            call_stack=(parser.provider_ref,),
        )
    )
    assert executor.calls == [("ghatana.docling", "application/pdf")]
    validate_provider_output(response(f"docx-{language}", "ghatana.docling-docx", parsed), Limits())
    assert parsed["providerProvenance"]["providerRef"] == "ghatana.docling-docx"
    assert parsed["providerProvenance"]["modelRef"] == "docling-rendered-docx-pipeline"
    assert any(item.startswith("officeRenderer:") for item in parsed["quality"].get("warnings", []))
    text = " ".join(line["text"] for page in parsed["pages"] for block in page["blocks"] for line in block["lines"])
    assert text.strip(), "rendered DOCX must emit real text"
    _assert_real_geometry(parsed)


@pytest.mark.integration
def test_rendered_docx_merged_table_fixture_real() -> None:
    _gated()
    parser = OfficeRenderedParser()
    parsed = asyncio.run(
        parser.parse(
            (CORPUS / "docx" / "mr-merged-table.docx").read_bytes(),
            media_type=DOCX,
            language="mr",
            limits={},
            deadline=Deadline(120_000),
            token=CancellationToken(),
            executor=_DoclingExecutor(),
            call_stack=(parser.provider_ref,),
        )
    )
    text = " ".join(line["text"] for page in parsed["pages"] for block in page["blocks"] for line in block["lines"])
    assert "१००१" in text
