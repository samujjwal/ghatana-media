"""Hostile-input preflight coverage for Increment 6 (I6-49/50/53/54/55).

Every payload here is constructed in-memory; no provider model, network,
or native OCR binary is required.
"""
from __future__ import annotations

import io
import zipfile

import pytest
from PIL import Image

from document_intelligence.errors import WorkerError
from document_intelligence.providers.docling_parser import DoclingParser
from document_intelligence.providers.paddle_ocr_parser import PaddleOcrParser
from document_intelligence.providers.tesseract_ocr_parser import TesseractOcrParser
from document_intelligence.runtime.cancellation import CancellationToken
from document_intelligence.runtime.deadline import Deadline
from document_intelligence.runtime.ooxml_preflight import DOCX, PPTX, XLSX, OoxmlLimits, validate_ooxml
from document_intelligence.runtime.pdf_preflight import PdfLimits, validate_pdf
from document_intelligence.runtime.pdf_rendering import PdfRenderer
from document_intelligence.runtime.subprocess_runner import CompletedSubprocess

LIMITS = OoxmlLimits(50, 10_000_000, 5_000_000, 1_000)
PARTS = {
    DOCX: ("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"),
    PPTX: ("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"),
    XLSX: ("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"),
}
TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


@pytest.fixture(autouse=True)
def _restore_max_image_pixels():
    """Parses assign ``Image.MAX_IMAGE_PIXELS`` per request; isolate the
    global so a low configured bound cannot leak into sibling tests."""
    original = Image.MAX_IMAGE_PIXELS
    yield
    Image.MAX_IMAGE_PIXELS = original


def package(media_type: str, *, content_type: str | None = None, extras: dict[str, bytes] | None = None, defaults: dict[str, str] | None = None) -> bytes:
    part, expected_type = PARTS[media_type]
    default_entries = "".join(f'<Default Extension="{ext}" ContentType="{ctype}"/>' for ext, ctype in (defaults or {}).items())
    types = f'<Types xmlns="{TYPES_NS}">{default_entries}<Override PartName="/{part}" ContentType="{content_type or expected_type}"/></Types>'
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", types)
        archive.writestr(part, "<root/>")
        for name, value in (extras or {}).items():
            archive.writestr(name, value)
    return output.getvalue()


def rels(*relationships: str) -> bytes:
    body = "".join(relationships)
    return f'<Relationships xmlns="{RELS_NS}">{body}</Relationships>'.encode()


def expect(code: str, data: bytes, media_type: str = DOCX) -> None:
    with pytest.raises(WorkerError) as rejected:
        validate_ooxml(data, media_type, LIMITS)
    assert rejected.value.code == code


# ---------------------------------------------------------------- I6-49

@pytest.mark.parametrize("member", ["word/nested.docx", "word/payload.zip", "word/lib/app.war", "word/lib/app.ear", "word/hidden.pptm", "xl/inner.xlsx", "xl/deep.docm", "xl/deep.xlsm", "ppt/run.jar"])
def test_nested_archive_member_suffixes_rejected(member):
    media_type = XLSX if member.startswith("xl/") else PPTX if member.startswith("ppt/") else DOCX
    expect("INVALID_REQUEST", package(media_type, extras={member: b"PK\x03\x04"}), media_type)


def test_content_type_declaring_nested_package_rejected():
    data = package(
        DOCX,
        extras={"word/parts/part1.xml": b"<part/>"},
        defaults={"xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    )
    expect("INVALID_REQUEST", data)


def test_content_type_declaring_zip_rejected():
    data = package(DOCX, extras={"word/payload.dat": b"x"}, defaults={"dat": "application/zip"})
    expect("INVALID_REQUEST", data)


# ---------------------------------------------------------------- I6-50

def test_external_target_mode_relationship_rejected():
    external = rels('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://attacker.invalid/track.png" TargetMode="External"/>')
    expect("INVALID_REQUEST", package(DOCX, extras={"word/_rels/document.xml.rels": external}))


def test_external_workbook_link_relationship_rejected():
    external = rels('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="file:///server/share/wb.xlsx" TargetMode="External"/>')
    expect("INVALID_REQUEST", package(XLSX, extras={"xl/_rels/workbook.xml.rels": external}), XLSX)


def test_external_link_part_name_rejected():
    expect("INVALID_REQUEST", package(XLSX, extras={"xl/externalLinks/externalLink1.xml": b"<externalLink/>"}), XLSX)


def test_external_link_content_type_rejected():
    data = package(XLSX, extras={"xl/links/link1.xml": b"<x/>"}, defaults={"xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"})
    expect("INVALID_REQUEST", data, XLSX)


@pytest.mark.parametrize("marker", [b"<ddeLink", b"<ddeItems", b"<oleLink"])
def test_xlsx_dde_content_rejected(marker):
    hostile = package(XLSX, extras={"xl/worksheets/sheet1.xml": b"<worksheet>" + marker + b"/></worksheet>"})
    expect("INVALID_REQUEST", hostile, XLSX)


def test_relationship_target_escaping_package_root_rejected():
    escape = rels('<Relationship Id="rId1" Type="t" Target="../../escape.xml"/>')
    expect("INVALID_REQUEST", package(DOCX, extras={"word/_rels/document.xml.rels": escape}))


def test_internal_relationships_still_allowed():
    internal = rels('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>')
    data = package(DOCX, extras={"word/_rels/document.xml.rels": internal, "word/media/image1.png": b"\x89PNG"})
    inspection = validate_ooxml(data, DOCX, LIMITS)
    assert inspection.main_part == "word/document.xml"


# ---------------------------------------------------------------- I6-53

@pytest.mark.parametrize("member", ["word/embeddings/oleObject1.bin", "xl/embeddings/oleObject1.xlsx", "ppt/embeddings/thing.bin", "word/embeddings/plain.xml"])
def test_embedding_parts_rejected(member):
    media_type = XLSX if member.startswith("xl/") else PPTX if member.startswith("ppt/") else DOCX
    expect("INVALID_REQUEST", package(media_type, extras={member: b"x"}), media_type)


@pytest.mark.parametrize("content_type", [
    "application/vnd.openxmlformats-officedocument.oleObject",
    "application/vnd.ms-office.oleObject",
    "application/vnd.openxmlformats-officedocument.activeX",
    "application/vnd.ms-office.activeX+xml",
])
def test_ole_and_activex_content_types_rejected(content_type):
    data = package(DOCX, extras={"word/objects/obj1.dat": b"x"}, defaults={"dat": content_type})
    expect("INVALID_REQUEST", data)


def test_opaque_spec_parts_still_allowed():
    data = package(DOCX, extras={"word/fonts/font.odttf": b"x"}, defaults={"odttf": "application/vnd.openxmlformats-officedocument.obfuscatedFont"})
    inspection = validate_ooxml(data, DOCX, LIMITS)
    assert inspection.archive_members == 3


# ---------------------------------------------------------------- I6-54

def minimal_pdf(media_box=(0, 0, 612, 792)) -> bytes:
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[%d %d %d %d]>>" % media_box,
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % index + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n" % (len(objs) + 1)
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref)
    return bytes(out)


def test_pdf_magic_required():
    with pytest.raises(WorkerError) as rejected:
        validate_pdf(b"not-a-pdf")
    assert rejected.value.code == "INVALID_REQUEST"


@pytest.mark.parametrize("marker", [b"/EmbeddedFiles", b"/JavaScript", b"/JS", b"/Launch", b"/RichMedia", b"/AA"])
def test_pdf_hostile_name_vectors_rejected(marker):
    data = minimal_pdf() + b"\n4 0 obj<</X " + marker + b" 5 0 R>>endobj"
    with pytest.raises(WorkerError) as rejected:
        validate_pdf(data)
    assert rejected.value.code == "INVALID_REQUEST"


def test_pdf_lookalike_names_not_rejected():
    # /JSX and /JavaScriptFoo are not the hostile names; suffix matching must
    # not over-reject.
    data = minimal_pdf() + b"\n4 0 obj<</X /JSX 5 0 R>>endobj"
    inspection = validate_pdf(data)
    assert inspection.pages == 1


def test_pdf_object_count_bound():
    data = minimal_pdf() + b"\n4 0 obj<</X 1>>endobj\n5 0 obj<</Y 2>>endobj"
    with pytest.raises(WorkerError) as rejected:
        validate_pdf(data, PdfLimits(max_objects=4))
    assert rejected.value.code == "LIMIT_EXCEEDED"


def test_pdf_stream_count_bound():
    data = minimal_pdf() + b"\n4 0 obj<</Length 1>>stream\nx\nendstream\nendobj"
    with pytest.raises(WorkerError) as rejected:
        validate_pdf(data, PdfLimits(max_streams=0))
    assert rejected.value.code == "LIMIT_EXCEEDED"


def test_pdf_page_dimension_ceiling():
    with pytest.raises(WorkerError) as rejected:
        validate_pdf(minimal_pdf((0, 0, 20_000, 20_000)))
    assert rejected.value.code == "LIMIT_EXCEEDED"


def test_pdf_valid_document_inspected():
    inspection = validate_pdf(minimal_pdf())
    assert inspection.pages == 1 and inspection.objects == 3 and inspection.page_dimensions_checked


def test_pdf_bare_header_fragment_skips_pdfium_pass():
    inspection = validate_pdf(b"%PDF-1.7")
    assert inspection.objects == 0 and not inspection.page_dimensions_checked


def test_pdf_unopenable_structure_rejected():
    # Declares objects but pdfium cannot recover a document.
    data = b"%PDF-1.4\n" + b"1 0 obj" + b"\x00\xff\xfe" * 64 + b"endobj\n%%EOF"
    with pytest.raises(WorkerError) as rejected:
        validate_pdf(data)
    assert rejected.value.code == "INVALID_REQUEST"


def test_pdf_renderer_runs_preflight():
    with pytest.raises(WorkerError) as rejected:
        PdfRenderer(minimal_pdf() + b"\n4 0 obj<</X /JavaScript 5 0 R>>endobj")
    assert rejected.value.code == "INVALID_REQUEST"


def test_docling_parse_runs_preflight():
    parser = DoclingParser(lambda: type("C", (), {"convert": lambda *_: type("R", (), {"document": {"pages": []}})()})())
    with pytest.raises(WorkerError) as rejected:
        parser.parse(minimal_pdf() + b"\n4 0 obj<</X /EmbeddedFiles 5 0 R>>endobj", media_type="application/pdf", limits={}, deadline=Deadline(1000), token=CancellationToken())
    assert rejected.value.code == "INVALID_REQUEST"


# ---------------------------------------------------------------- I6-55

def png_bytes(size=(40, 20), frames: int = 1) -> bytes:
    image = Image.new("RGB", size, "white")
    output = io.BytesIO()
    if frames > 1:
        image.save(output, format="PNG", save_all=True, append_images=[Image.new("RGB", size, "black") for _ in range(frames - 1)])
    else:
        image.save(output, format="PNG")
    return output.getvalue()


def paddle() -> PaddleOcrParser:
    class FakeModel:
        def predict(self, _image):
            return []

    return PaddleOcrParser(lambda _language: FakeModel(), admitted_languages=("en",))


def tesseract() -> TesseractOcrParser:
    def runner(argv, **kwargs):
        return CompletedSubprocess(b"", b"", 0)

    return TesseractOcrParser(runner=runner, executable="tesseract")


@pytest.mark.parametrize("parser_name", ["paddle", "tesseract"])
def test_image_dimension_bound(parser_name):
    parser = paddle() if parser_name == "paddle" else tesseract()
    with pytest.raises(WorkerError) as rejected:
        parser.parse(png_bytes(), media_type="image/png", language="en", limits={"maxImageDimensionPx": 10}, deadline=Deadline(1000), token=CancellationToken())
    assert rejected.value.code == "LIMIT_EXCEEDED"


@pytest.mark.parametrize("parser_name", ["paddle", "tesseract"])
def test_image_frame_bound(parser_name):
    parser = paddle() if parser_name == "paddle" else tesseract()
    with pytest.raises(WorkerError) as rejected:
        parser.parse(png_bytes(frames=2), media_type="image/png", language="en", limits={"maxImageFrames": 1}, deadline=Deadline(1000), token=CancellationToken())
    assert rejected.value.code == "LIMIT_EXCEEDED"


@pytest.mark.parametrize("parser_name", ["paddle", "tesseract"])
def test_image_decoded_byte_bound(parser_name):
    parser = paddle() if parser_name == "paddle" else tesseract()
    with pytest.raises(WorkerError) as rejected:
        parser.parse(png_bytes(), media_type="image/png", language="en", limits={"maxDecodedImageBytes": 100}, deadline=Deadline(1000), token=CancellationToken())
    assert rejected.value.code == "LIMIT_EXCEEDED"


def test_image_within_bounds_parses():
    result = tesseract().parse(png_bytes(), media_type="image/png", language="en", limits={}, deadline=Deadline(1000), token=CancellationToken())
    assert result["providerProvenance"]["providerRef"] == "ghatana.tesseractocr"
