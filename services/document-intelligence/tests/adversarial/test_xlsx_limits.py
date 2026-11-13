from __future__ import annotations

from pathlib import Path

import pytest

from document_intelligence.errors import WorkerError
from document_intelligence.providers.docling_office_parser import DoclingXlsxParser
from document_intelligence.providers.native_office_parser import XlsxParser
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline


FIXTURE = Path(__file__).resolve().parents[2] / "evaluation/increment4a/corpus/qualification/xlsx/hi-sparse-merged.xlsx"
MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def test_ooxml_xlsx_honors_archive_member_limit_before_parsing() -> None:
    with pytest.raises(WorkerError, match="LIMIT_EXCEEDED"):
        XlsxParser().parse(FIXTURE.read_bytes(), media_type=MEDIA_TYPE, limits={"maxOfficeArchiveMembers": 1}, deadline=Deadline(10_000), token=CancellationToken())


def test_ooxml_xlsx_honors_member_size_limit_before_parsing() -> None:
    with pytest.raises(WorkerError, match="LIMIT_EXCEEDED"):
        XlsxParser().parse(FIXTURE.read_bytes(), media_type=MEDIA_TYPE, limits={"maxOfficeMemberBytes": 1}, deadline=Deadline(10_000), token=CancellationToken())


def test_docling_xlsx_honors_archive_member_limit_before_parsing() -> None:
    with pytest.raises(WorkerError, match="LIMIT_EXCEEDED"):
        DoclingXlsxParser().parse(FIXTURE.read_bytes(), media_type=MEDIA_TYPE, limits={"maxOfficeArchiveMembers": 1}, deadline=Deadline(10_000), token=CancellationToken())


def test_docling_xlsx_honors_member_size_limit_before_parsing() -> None:
    with pytest.raises(WorkerError, match="LIMIT_EXCEEDED"):
        DoclingXlsxParser().parse(FIXTURE.read_bytes(), media_type=MEDIA_TYPE, limits={"maxOfficeMemberBytes": 1}, deadline=Deadline(10_000), token=CancellationToken())
