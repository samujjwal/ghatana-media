from __future__ import annotations

import io
import zipfile

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.runtime.ooxml_preflight import DOCX, PPTX, XLSX, OoxmlLimits, validate_ooxml

LIMITS = OoxmlLimits(20, 1_000_000, 500_000, 1_000)
PARTS = {
    DOCX: ("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"),
    PPTX: ("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"),
    XLSX: ("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
}


def package(media_type: str, *, content_type: str | None = None, main_part: str | None = None, extras: dict[str, bytes] | None = None) -> bytes:
    expected_part, expected_type = PARTS[media_type]
    part = main_part or expected_part
    declared = content_type or expected_type
    types = f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/{part}" ContentType="{declared}"/></Types>'
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", types)
        archive.writestr(part, "<root/>")
        for name, value in (extras or {}).items():
            archive.writestr(name, value)
    return output.getvalue()


@pytest.mark.parametrize("media_type", [DOCX, PPTX, XLSX])
def test_valid_ooxml_package(media_type):
    inspection = validate_ooxml(package(media_type), media_type, LIMITS)
    assert inspection.main_part == PARTS[media_type][0]
    assert inspection.archive_members == 2


def test_wrong_container_and_corrupt_archive_fail():
    with pytest.raises(WorkerError) as wrong:
        validate_ooxml(package(DOCX), PPTX, LIMITS)
    assert wrong.value.code == "INVALID_REQUEST"
    with pytest.raises(WorkerError) as corrupt:
        validate_ooxml(b"not-a-zip", DOCX, LIMITS)
    assert corrupt.value.code == "INVALID_REQUEST"


def test_missing_content_types_fails():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("word/document.xml", "<root/>")
    with pytest.raises(WorkerError) as rejected:
        validate_ooxml(output.getvalue(), DOCX, LIMITS)
    assert rejected.value.code == "INVALID_REQUEST"


def test_malformed_relationship_fails():
    data = package(DOCX, extras={"word/_rels/document.xml.rels": b"<broken"})
    with pytest.raises(WorkerError) as rejected:
        validate_ooxml(data, DOCX, LIMITS)
    assert rejected.value.code == "INVALID_REQUEST"
