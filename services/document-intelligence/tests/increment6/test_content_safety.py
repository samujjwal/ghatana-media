from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from document_intelligence.errors import WorkerError  # noqa: E402
from document_intelligence.increment6.content_safety import (  # noqa: E402
    BoundedSpool,
    PDF,
    PPTX,
    require_complete_pages,
    sniff_content,
    spool_chunks,
    validate_content,
)


def _pptx_bytes(*, active: bool = False) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            "<Types><Override ContentType="
            "'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'/>"
            + ("<Override ContentType='application/vnd.ms-office.vbaProject'/>" if active else "")
            + "</Types>",
        )
    return output.getvalue()


def test_content_sniff_rejects_declared_type_mismatch_and_pdf_active_content():
    assert sniff_content(b"%PDF-1.7\n").detected_media_type == PDF
    with pytest.raises(WorkerError) as mismatch:
        validate_content(b"%PDF-1.7\n", "image/png")
    assert mismatch.value.code == "UNSUPPORTED_MEDIA_TYPE"
    with pytest.raises(WorkerError) as active:
        validate_content(b"%PDF-1.7\n/JavaScript", PDF)
    assert active.value.code == "INVALID_REQUEST"


def test_ooxml_active_content_is_rejected_before_provider_execution():
    assert sniff_content(_pptx_bytes()).detected_media_type == PPTX
    with pytest.raises(WorkerError) as error:
        validate_content(_pptx_bytes(active=True), PPTX)
    assert error.value.code == "INVALID_REQUEST"


def test_bounded_spool_and_partial_page_policy_are_explicit():
    with pytest.raises(WorkerError) as error:
        spool_chunks([b"abc", b"def"], 5)
    assert error.value.code == "LIMIT_EXCEEDED"
    with BoundedSpool(10, memory_bytes=1) as spool:
        spool.write(b"abc")
        spool.rewind()
        assert spool.read() == b"abc"
    with pytest.raises(WorkerError):
        require_complete_pages(3, [1, 3])
    assert require_complete_pages(3, [1, 3], allow_partial=True)["status"] == "PARTIAL"
