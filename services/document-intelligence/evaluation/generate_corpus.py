from __future__ import annotations

import base64
import io
import json
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "corpus"

# Deterministic, real English and Nepali text. No randomness, no customer data.
PDFS: dict[str, tuple[str, str]] = {
    # fixture_id -> (language, text)
    "pdf-en-simple": ("en", "Synthetic English invoice number INV-1001"),
    "pdf-en-dense": (
        "en",
        "Synthetic English dense paragraph for layout evaluation. " * 6,
    ),
    "pdf-en-table": (
        "en",
        "Item Quantity Price\nWidget 2 10.00\nGadget 1 20.00",
    ),
    "pdf-en-sparse": ("en", "Synthetic sparse heading"),
    "pdf-en-no-text": ("en", ""),
    "pdf-ne-simple": ("ne", "नेपाली परीक्षण कागजात नम्बर १००१"),
    "pdf-ne-dense": (
        "ne",
        "नेपाली संरचना परीक्षण पाठ। " * 6,
    ),
    "pdf-ne-table": (
        "ne",
        "वस्तु संख्या मूल्य\nकलम २ १०.००\nकापी १ २०.००",
    ),
    "pdf-ne-multiline": (
        "ne",
        "पहिलो नेपाली पङ्क्ति\nदोस्रो नेपाली पङ्क्ति\nतेस्रो नेपाली पङ्क्ति",
    ),
}

IMAGES: dict[str, tuple[str, str, bool, bool, bool]] = {
    # fixture_id -> (format, text, noisy, rotated, no_text)
    "image-en-clean": ("png", "Synthetic English invoice INV-1001", False, False, False),
    "image-en-noisy": ("png", "Synthetic English noisy text", True, False, False),
    "image-en-rotated": ("jpeg", "Synthetic English rotated text", False, True, False),
    "image-en-sparse": ("png", "Sparse", False, False, False),
    "image-en-dense": ("jpeg", "Dense English structure with multiple lines", False, False, False),
    "image-en-no-text": ("png", "", False, False, True),
    "image-ne-clean": ("png", "नेपाली कागजात १००१", False, False, False),
    "image-ne-noisy": ("png", "नेपाली हल्ला पाठ", True, False, False),
    "image-ne-rotated": ("jpeg", "नेपाली घुमाइएको पाठ", False, True, False),
    "image-ne-sparse": ("png", "शीर्षक", False, False, False),
    "image-ne-dense": ("jpeg", "नेपाली संरचना परीक्षण पाठ", False, False, False),
    "image-ne-no-text": ("png", "", False, False, True),
}

EN_FONT = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
NE_FONT = "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf"


# Minimal deterministic 1x1 JPEG placeholder used when Pillow is unavailable.
_JPEG_1X1 = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AYf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z"
)


def _pdf(text: str, language: str, table_rows: list[list[str]] | None = None) -> tuple[bytes, list[dict[str, float]], str]:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    font_path = NE_FONT if language == "ne" else EN_FONT
    font_name = "NotoSansDevanagari" if language == "ne" else "NotoSans"
    pdfmetrics.registerFont(TTFont(font_name, font_path))

    buffer = io.BytesIO()
    page_width_pt = 612.0
    page_height_pt = 792.0
    margin = 72.0
    document = canvas.Canvas(buffer, pagesize=(page_width_pt, page_height_pt), pageCompression=0, invariant=True)
    font_size = 12.0
    line_height = 18.0
    document.setFont(font_name, font_size)

    max_width = page_width_pt - 2 * margin
    line_regions: list[tuple[float, float, float, float]] = []  # top-left x, top-left y, width, height
    if table_rows:
        row_height = 36.0
        column_width = max_width / len(table_rows[0])
        table_top = page_height_pt - margin
        table_bottom = table_top - row_height * len(table_rows)
        for row_index, row in enumerate(table_rows):
            top = table_top - row_index * row_height
            bottom = top - row_height
            for column_index, value in enumerate(row):
                left = margin + column_index * column_width
                document.rect(left, bottom, column_width, row_height, stroke=1, fill=0)
                document.drawString(left + 6, bottom + 11, value)
        line_regions.append((margin / page_width_pt, (page_height_pt - table_top) / page_height_pt, max_width / page_width_pt, (table_top - table_bottom) / page_height_pt))
        lines = [" ".join(row) for row in table_rows]
    else:
        words = text.split()
        if words:
            lines = []
            while words:
                line_words = [words[0]]
                idx = 1
                while idx < len(words) and document.stringWidth(" ".join(line_words + [words[idx]]), font_name, font_size) <= max_width:
                    line_words.append(words[idx])
                    idx += 1
                lines.append(" ".join(line_words))
                words = words[idx:]
        else:
            # A blank page causes some pipelines to reject the document; draw a harmless whitespace.
            lines = [" "]

        x = margin
        baseline_y = page_height_pt - margin - font_size
        for line in lines:
            document.drawString(x, baseline_y, line)
            width = document.stringWidth(line, font_name, font_size)
            # Docling's exported coordinates for these PDFs are normalized top-left.
            top_from_page_top = page_height_pt - baseline_y - font_size
            bottom_from_page_top = page_height_pt - baseline_y
            line_regions.append(
                (
                    x / page_width_pt,
                    top_from_page_top / page_height_pt,
                    width / page_width_pt,
                    max((bottom_from_page_top - top_from_page_top) / page_height_pt, 0.001),
                )
            )
            baseline_y -= line_height

    document.save()
    if not line_regions:
        return buffer.getvalue(), [], ""
    min_x = min(r[0] for r in line_regions)
    max_x = max(r[0] + r[2] for r in line_regions)
    min_y = min(r[1] for r in line_regions)
    max_y = max(r[1] + r[3] for r in line_regions)
    outer_box = {
        "x": min_x,
        "y": min_y,
        "width": max_x - min_x,
        "height": max_y - min_y,
    }
    return buffer.getvalue(), [outer_box], "\n".join(lines)


def _png(width: int = 320, height: int = 120) -> bytes:
    color = (245, 245, 245)
    raw = b"".join(b"\x00" + bytes(color) * width for _ in range(height))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def _render_image(
    path: Path, text: str, format_name: str, *, noisy: bool = False, rotated: bool = False, no_text: bool = False
) -> tuple[list[dict[str, float]], str]:
    regions: list[tuple[float, float, float, float]] = []
    rendered_text = ""
    try:
        from PIL import Image, ImageDraw, ImageFont

        width_px = 900
        height_px = 320
        image = Image.new("RGB", (width_px, height_px), "white")
        draw = ImageDraw.Draw(image)
        is_nepali = any(ord(ch) > 0x0900 and ord(ch) < 0x097F for ch in text)
        font_path = NE_FONT if is_nepali else EN_FONT
        font_size = 48
        font = ImageFont.truetype(font_path, font_size)
        line_height = 64
        x = 40
        y = 40
        if not no_text and text:
            lines = [text] if "dense" not in path.stem else text.split()
            rendered_lines: list[str] = []
            for raw_line in lines:
                line_text = raw_line.strip()
                if not line_text:
                    continue
                draw.text((x, y), line_text, fill="black", font=font)
                left, top, right, bottom = draw.textbbox((x, y), line_text, font=font)
                regions.append((left, top, right, bottom))
                rendered_lines.append(line_text)
                y += line_height
            rendered_text = "\n".join(rendered_lines)
        if noisy:
            for index in range(0, width_px, 13):
                draw.point((index, (index * 17) % height_px), fill=(160, 160, 160))
        if rotated:
            image = image.rotate(4, expand=True, fillcolor="white")
        image.save(path, format="JPEG" if format_name == "jpeg" else "PNG", quality=92)
    except ImportError:
        path.write_bytes(_JPEG_1X1 if format_name == "jpeg" else _png())
    if not regions:
        return [], ""
    min_x = min(r[0] for r in regions)
    max_x = max(r[2] for r in regions)
    min_y = min(r[1] for r in regions)
    max_y = max(r[3] for r in regions)
    return [
        {
            "x": min_x / width_px,
            "y": min_y / height_px,
            "width": (max_x - min_x) / width_px,
            "height": (max_y - min_y) / height_px,
        }
    ], rendered_text


def _table_shapes(fixture_id: str) -> list[dict[str, int]] | None:
    if fixture_id in {"pdf-en-table", "pdf-ne-table"}:
        # Header + two data rows, three columns.
        return [{"rows": 3, "columns": 3}]
    return None


def _table_rows(fixture_id: str) -> list[list[str]] | None:
    return {
        "pdf-en-table": [["Item", "Quantity", "Price"], ["Widget", "2", "10.00"], ["Gadget", "1", "20.00"]],
        "pdf-ne-table": [["वस्तु", "संख्या", "मूल्य"], ["कलम", "२", "१०.००"], ["कापी", "१", "२०.००"]],
    }.get(fixture_id)


def _table_cells(fixture_id: str) -> list[dict[str, object]] | None:
    rows = _table_rows(fixture_id)
    if rows is None:
        return None
    table_x = 72.0 / 612.0
    table_y = 72.0 / 792.0
    cell_width = (612.0 - 144.0) / len(rows[0]) / 612.0
    cell_height = 36.0 / 792.0
    return [
        {
            "rowIndex": row_index,
            "columnIndex": column_index,
            "text": text,
            "boundingRegion": {"x": table_x + column_index * cell_width, "y": table_y + row_index * cell_height, "width": cell_width, "height": cell_height},
        }
        for row_index, row in enumerate(rows)
        for column_index, text in enumerate(row)
    ]


def _gliner_ground_truth() -> dict:
    def _span(text: str, value: str) -> tuple[int, int]:
        return text.index(value), text.index(value) + len(value)

    en_text = PDFS["pdf-en-simple"][1]
    ne_text = PDFS["pdf-ne-simple"][1]
    return {
        "pdf-en-simple": {
            "fields": [{"fieldId": "document_number", "valueType": "IDENTIFIER", "aliases": ["invoice number", "document number"]}],
            "entities": [
                {
                    "fieldId": "document_number",
                    "value": "INV-1001",
                    "page": 1,
                    "lineId": "p1-b1-l1",
                    "start": _span(en_text, "INV-1001")[0],
                    "end": _span(en_text, "INV-1001")[1],
                }
            ],
        },
        "pdf-ne-simple": {
            "fields": [{"fieldId": "document_number", "valueType": "IDENTIFIER", "aliases": ["document number"]}],
            "entities": [
                {
                    "fieldId": "document_number",
                    "value": "१००१",
                    "page": 1,
                    "lineId": "p1-b1-l1",
                    "start": _span(ne_text, "१००१")[0],
                    "end": _span(ne_text, "१००१")[1],
                }
            ],
        },
        # Negative/abstention fixtures: the requested field has no honest entity in
        # these documents. Correct behavior is emitting no admissible candidate.
        "pdf-en-sparse": {
            "fields": [{"fieldId": "document_number", "valueType": "IDENTIFIER", "aliases": ["invoice number", "document number"]}],
            "entities": [],
        },
        "pdf-ne-multiline": {
            "fields": [{"fieldId": "document_number", "valueType": "IDENTIFIER", "aliases": ["document number"]}],
            "entities": [],
        },
    }


def _minilm_templates() -> dict:
    return {
        "phrases": [
            "template-a",
            "template-a-variant",
            "unrelated",
        ],
        "same": [["template-a", "template-a-variant"]],
        "different": [["template-a", "unrelated"]],
        "retrieval": {
            "queries": ["template-a"],
            "expected": [["template-a-variant"]],
        },
    }


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)

    pdf_truth: dict[str, dict] = {}
    for fixture_id, (language, text) in PDFS.items():
        data, regions, rendered_text = _pdf(text, language, _table_rows(fixture_id))
        (ROOT / f"{fixture_id}.pdf").write_bytes(data)
        pdf_truth[fixture_id] = {
            "expectedText": text if not text.strip() else rendered_text,
            "expectedRegions": regions,
            "expectedTables": _table_shapes(fixture_id) or [],
            "expectedCells": _table_cells(fixture_id) or [],
        }
    (ROOT / "pdf-ground-truth.json").write_text(
        json.dumps(pdf_truth, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    image_truth: dict[str, dict] = {}
    for fixture_id, (format_name, text, noisy, rotated, no_text) in IMAGES.items():
        suffix = ".jpg" if format_name == "jpeg" else ".png"
        regions, rendered_text = _render_image(
            ROOT / f"{fixture_id}{suffix}",
            text,
            format_name,
            noisy=noisy,
            rotated=rotated,
            no_text=no_text,
        )
        image_truth[fixture_id] = {
            "expectedText": rendered_text or text,
            "expectedRegions": regions,
        }
    (ROOT / "image-ground-truth.json").write_text(
        json.dumps(image_truth, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    (ROOT / "boundary-corrupt-pdf.pdf").write_bytes(b"%PDF-1.4\ntruncated")
    (ROOT / "boundary-corrupt-image.png").write_bytes(b"not-an-image")
    (ROOT / "boundary-zero-byte.bin").write_bytes(b"")

    (ROOT / "gliner-ground-truth.json").write_text(
        json.dumps(_gliner_ground_truth(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (ROOT / "minilm-templates.json").write_text(
        json.dumps(_minilm_templates(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
