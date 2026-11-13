from __future__ import annotations

import io
import zipfile

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.runtime.ooxml_preflight import DOCX, XLSX, OoxmlLimits, validate_ooxml

PARTS = {
    DOCX: ("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"),
    XLSX: ("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
}


def package(media_type: str, *, content_type: str | None = None, extras: dict[str, bytes] | None = None) -> bytes:
    part, expected_type = PARTS[media_type]
    types = f'<Types><Override PartName="/{part}" ContentType="{content_type or expected_type}"/></Types>'
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", types)
        archive.writestr(part, "<root/>")
        for name, value in (extras or {}).items():
            archive.writestr(name, value)
    return output.getvalue()


def test_archive_member_and_cumulative_bounds():
    data = package(DOCX, extras={f"word/item-{index}.xml": b"x" for index in range(5)})
    with pytest.raises(WorkerError) as members:
        validate_ooxml(data, DOCX, OoxmlLimits(3, 1_000_000, 500_000))
    assert members.value.code == "LIMIT_EXCEEDED"
    with pytest.raises(WorkerError) as cumulative:
        validate_ooxml(data, DOCX, OoxmlLimits(20, 100, 500_000))
    assert cumulative.value.code == "LIMIT_EXCEEDED"


def test_compression_bomb_and_large_sparse_workbook_fail():
    compressed = package(XLSX, extras={"xl/worksheets/sheet1.xml": b"0" * 100_000})
    with pytest.raises(WorkerError) as bomb:
        validate_ooxml(compressed, XLSX, OoxmlLimits(20, 1_000_000, 500_000, 10))
    assert bomb.value.code == "LIMIT_EXCEEDED"
    with pytest.raises(WorkerError) as member:
        validate_ooxml(compressed, XLSX, OoxmlLimits(20, 1_000_000, 1_000, 1_000))
    assert member.value.code == "LIMIT_EXCEEDED"


@pytest.mark.parametrize("name", ["../escape.xml", "/absolute.xml", "word/../../escape.xml", "word\\escape.xml"])
def test_path_traversal_and_absolute_members_fail(name):
    with pytest.raises(WorkerError) as rejected:
        validate_ooxml(package(DOCX, extras={name: b"x"}), DOCX, OoxmlLimits(20, 1_000_000, 500_000))
    assert rejected.value.code == "INVALID_REQUEST"


def test_duplicate_dangerous_paths_fail():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("[Content_Types].xml", '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("word/document.xml", "<root/>")
        archive.writestr("WORD/DOCUMENT.XML", "<root/>")
    with pytest.raises(WorkerError) as rejected:
        validate_ooxml(output.getvalue(), DOCX, OoxmlLimits(20, 1_000_000, 500_000))
    assert rejected.value.code == "INVALID_REQUEST"


def test_macro_and_embedded_executable_packages_fail():
    macro = package(DOCX, content_type="application/vnd.ms-word.document.macroEnabled.main+xml")
    with pytest.raises(WorkerError) as rejected_macro:
        validate_ooxml(macro, DOCX, OoxmlLimits(20, 1_000_000, 500_000))
    assert rejected_macro.value.code == "INVALID_REQUEST"
    executable = package(DOCX, extras={"word/embeddings/payload.exe": b"MZ"})
    with pytest.raises(WorkerError) as rejected_executable:
        validate_ooxml(executable, DOCX, OoxmlLimits(20, 1_000_000, 500_000))
    assert rejected_executable.value.code == "INVALID_REQUEST"
