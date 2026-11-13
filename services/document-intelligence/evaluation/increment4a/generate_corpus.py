#!/usr/bin/env python3
"""Deterministically generate the Increment-4A qualification corpus.

Every fixture is generated locally so the canonical campaign never depends on
unavailable external assets:

- ``corpus/qualification/hybrid-pdf/`` — native/scanned/mixed PDFs covering
  NATIVE, SCANNED, MIXED, and BLANK page classifications, deduplication, noisy
  and rotated scans, and the scanned-table disposition case.
- ``corpus/qualification/ocr/<language>/`` — rendered PNG text fixtures for
  en/ne/hi/mr (clean, dense, noisy, rotated, mixed-script, numbers).
- ``corpus/qualification/{docx,pptx,xlsx}/`` — real OOXML fixtures per language
  plus one complex structural case each.

Determinism is explicit: reportlab runs with ``invariant=1``, Pillow output is
PNG, all noise uses fixed seeds, and OOXML archives are rewritten with fixed
member timestamps so corpus fingerprints are reproducible byte-for-byte.

Run::

    uv run --extra evaluation evaluation/increment4a/generate_corpus.py
"""
from __future__ import annotations

import io
import json
import re
import tempfile
import unicodedata
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

HERE = Path(__file__).resolve().parent
CORPUS = HERE / "corpus" / "qualification"
PAGE_W, PAGE_H = A4  # 612 x 792 pt
_IMG_W, _IMG_H = 1224, 1584  # 2x page scale for raster fixtures

LATIN_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEVANAGARI_FONT = "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf"

FIXED_ZIP_DATE = (2024, 1, 1, 0, 0, 0)


def _font(language: str, size: int) -> ImageFont.FreeTypeFont:
    path = LATIN_FONT if language == "en" else DEVANAGARI_FONT
    return ImageFont.truetype(path, size)


def _render_text_image(language: str, lines: list[str], *, size: int = 36, noise_seed: int | None = None, rotation: float = 0.0, region: tuple[int, int, int, int] | None = None) -> bytes:
    """Render a deterministic PNG containing the given text lines."""
    if region is not None:
        image = Image.new("RGB", (region[2] - region[0], region[3] - region[1]), "white")
    else:
        image = Image.new("RGB", (_IMG_W, _IMG_H), "white")
    draw = ImageDraw.Draw(image)
    font = _font(language, size)
    y = 80
    for line in lines:
        draw.text((60, y), line, fill="black", font=font)
        y += size + 28
    if rotation:
        image = image.rotate(rotation, resample=Image.BICUBIC, expand=False, fillcolor="white")
    if noise_seed is not None:
        import random
        rng = random.Random(noise_seed)
        pixels = image.load()
        for _ in range(image.width * image.height // 60):
            x, y = rng.randrange(image.width), rng.randrange(image.height)
            value = rng.randrange(0, 255)
            pixels[x, y] = (value, value, value)
        image = image.filter(ImageFilter.GaussianBlur(0.4))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _render_table_image(language: str, rows: list[list[str]], *, size: int = 40) -> bytes:
    """Render a deterministic scanned table (grid lines plus cell text)."""
    image = Image.new("RGB", (_IMG_W, _IMG_H), "white")
    draw = ImageDraw.Draw(image)
    font = _font(language, size)
    left, top, right = 80, 200, _IMG_W - 80
    columns = max(len(row) for row in rows)
    cell_w = (right - left) / columns
    cell_h = 110
    for row_index, row in enumerate(rows):
        y = top + row_index * cell_h
        for col_index in range(columns):
            x = left + col_index * cell_w
            draw.rectangle([x, y, x + cell_w, y + cell_h], outline="black", width=2)
            if col_index < len(row):
                draw.text((x + 18, y + 30), row[col_index], fill="black", font=font)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _new_canvas(path: Path) -> canvas.Canvas:
    return canvas.Canvas(str(path), pagesize=A4, invariant=1)


def _draw_paragraph(pdf: canvas.Canvas, lines: list[str], *, size: int = 16, top: float = 700) -> None:
    pdf.setFont("Helvetica", size)
    y = top
    for line in lines:
        pdf.drawString(72, y, line)
        y -= size + 8


def _paragraph_regions(lines: list[str], *, size: int = 16, top: float = 700, x: float = 72) -> list[dict[str, float]]:
    """Expected bounding region for a drawn paragraph at *block* granularity.

    Providers merge contiguous drawn lines into a single block region, so the
    ground truth records the union of the paragraph — comparing at this
    granularity measures provider geometry fidelity, not line-splitting style.
    """
    from reportlab.pdfbase.pdfmetrics import stringWidth
    if not lines:
        return []
    width = max(stringWidth(line, "Helvetica", size) for line in lines)
    last_baseline = top - (len(lines) - 1) * (size + 8)
    return [{"x": x / PAGE_W, "y": 1 - (top + 0.72 * size) / PAGE_H, "width": width / PAGE_W, "height": (top + 0.72 * size - (last_baseline - 0.28 * size)) / PAGE_H}]


def _draw_image_full_page(pdf: canvas.Canvas, png: bytes) -> None:
    pdf.drawImage(ImageReader(io.BytesIO(png)), 0, 0, width=PAGE_W, height=PAGE_H)


def _draw_native_table(pdf: canvas.Canvas, rows: list[list[str]], *, top: float = 560) -> None:
    """Draw a real vector table (path objects, not a raster image)."""
    left, right = 72, PAGE_W - 72
    columns = max(len(row) for row in rows)
    cell_w = (right - left) / columns
    cell_h = 30
    pdf.setFont("Helvetica", 11)
    for row_index, row in enumerate(rows):
        y = top - row_index * cell_h
        for col_index in range(columns):
            x = left + col_index * cell_w
            pdf.rect(x, y - cell_h, cell_w, cell_h, stroke=1, fill=0)
            if col_index < len(row):
                pdf.drawString(x + 6, y - 20, row[col_index])


_HYBRID_TEXT = {
    "en-native": "This native page contains a clean paragraph of English text used for hybrid qualification.",
    "en-scan": "This scanned page contains rasterized English text for OCR qualification.",
    "ne-scan": "यो स्क्यान गरिएको पृष्ठमा नेपाली पाठ छ र OCR द्वारा पढिन्छ।",
    "hi-scan": "इस स्कैन किए गए पृष्ठ में हिंदी पाठ है जिसे OCR पढ़ेगा।",
    "mr-scan": "या स्कॅन केलेल्या पानावर मराठी मजकूर आहे जो OCR वाचेल.",
    "en-p1": "This is the native first page of a mixed document.",
    "en-p2": "This is the scanned second page of a mixed document.",
    "en-mixed-native": "Native text appears above the embedded scan.",
    "en-mixed-image": "Embedded scan text for region OCR.",
    "en-dup": "Repeated heading text for deduplication check.",
    "en-unique": "Unique OCR content below the duplicate region.",
}


def _wrap(text: str, width: int = 72) -> list[str]:
    words, lines, current = text.split(), [], ""
    for word in words:
        if len(current) + len(word) + 1 > width:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(current)
    return lines


def _generate_hybrid_pdf(out: Path) -> dict[str, dict]:
    """Generate HYBRID-001..012 and return ground truth keyed by fixture id."""
    out.mkdir(parents=True, exist_ok=True)
    truth: dict[str, dict] = {}

    def emit(fixture: str, build, record: dict) -> None:
        path = out / f"{fixture}.pdf"
        pdf = _new_canvas(path)
        build(pdf)
        pdf.save()
        truth[fixture] = {"file": path.name, **record}

    emit("HYBRID-001", lambda pdf: _draw_paragraph(pdf, _wrap(_HYBRID_TEXT["en-native"])), {
        "language": "en", "mode": "native", "pages": [{"classification": "NATIVE"}], "expectedText": _HYBRID_TEXT["en-native"],
        "expectedRegions": _paragraph_regions(_wrap(_HYBRID_TEXT["en-native"])),
    })
    for fixture, key, lang in (("HYBRID-002", "en-scan", "en"), ("HYBRID-003", "ne-scan", "ne"), ("HYBRID-004", "hi-scan", "hi"), ("HYBRID-005", "mr-scan", "mr")):
        png = _render_text_image(lang, _wrap(_HYBRID_TEXT[key], 34))
        emit(fixture, lambda pdf, p=png: _draw_image_full_page(pdf, p), {
            "language": lang, "mode": "scanned", "pages": [{"classification": "SCANNED"}], "expectedText": _HYBRID_TEXT[key],
        })

    png_p2 = _render_text_image("en", _wrap(_HYBRID_TEXT["en-p2"], 34))

    def build_006(pdf):
        _draw_paragraph(pdf, _wrap(_HYBRID_TEXT["en-p1"]))
        pdf.showPage()
        _draw_image_full_page(pdf, png_p2)

    emit("HYBRID-006", build_006, {
        "language": "en", "mode": "mixed", "pages": [{"classification": "NATIVE"}, {"classification": "SCANNED"}],
        "expectedText": f"{_HYBRID_TEXT['en-p1']} {_HYBRID_TEXT['en-p2']}",
        "expectedRegions": _paragraph_regions(_wrap(_HYBRID_TEXT["en-p1"])),
    })

    region_png = _render_text_image("en", _wrap(_HYBRID_TEXT["en-mixed-image"], 30), region=(0, 0, 900, 300))

    def build_007(pdf):
        _draw_paragraph(pdf, _wrap(_HYBRID_TEXT["en-mixed-native"]), top=720)
        pdf.drawImage(ImageReader(io.BytesIO(region_png)), 72, 300, width=450, height=150)

    emit("HYBRID-007", build_007, {
        "language": "en", "mode": "mixed", "pages": [{"classification": "MIXED", "ocrRegions": 1}],
        "expectedText": f"{_HYBRID_TEXT['en-mixed-native']} {_HYBRID_TEXT['en-mixed-image']}",
        "expectedRegions": _paragraph_regions(_wrap(_HYBRID_TEXT["en-mixed-native"]), top=720),
    })

    table_rows = [["Item", "Amount"], ["Invoice 1001", "1250"], ["Invoice 1002", "980"]]

    def build_008(pdf):
        _draw_paragraph(pdf, _wrap(_HYBRID_TEXT["en-native"]), top=720)
        _draw_native_table(pdf, table_rows, top=560)

    emit("HYBRID-008", build_008, {
        "language": "en", "mode": "native", "pages": [{"classification": "NATIVE"}],
        "expectedText": _HYBRID_TEXT["en-native"], "structuredTableDisposition": "tables", "table": table_rows, "expectedCells": 6,
        "expectedRegions": _paragraph_regions(_wrap(_HYBRID_TEXT["en-native"]), top=720),
    })

    table_png = _render_table_image("en", table_rows)
    emit("HYBRID-009", lambda pdf: _draw_image_full_page(pdf, table_png), {
        "language": "en", "mode": "scanned", "pages": [{"classification": "SCANNED"}],
        "expectedText": " ".join(" ".join(row) for row in table_rows), "structuredTableDisposition": "scanned",
    })

    noisy = _render_text_image("en", _wrap(_HYBRID_TEXT["en-scan"], 34), noise_seed=42, rotation=3.0)
    emit("HYBRID-010", lambda pdf: _draw_image_full_page(pdf, noisy), {
        "language": "en", "mode": "scanned", "pages": [{"classification": "SCANNED"}], "expectedText": _HYBRID_TEXT["en-scan"], "degradation": "gaussian-noise+3deg-rotation",
    })

    def build_011(pdf):
        pdf.showPage()
        _draw_paragraph(pdf, _wrap(_HYBRID_TEXT["en-p1"]))
        pdf.showPage()
        _draw_image_full_page(pdf, png_p2)

    emit("HYBRID-011", build_011, {
        "language": "en", "mode": "mixed", "pages": [{"classification": "BLANK"}, {"classification": "NATIVE"}, {"classification": "SCANNED"}],
        "expectedText": f"{_HYBRID_TEXT['en-p1']} {_HYBRID_TEXT['en-p2']}",
        "expectedRegions": _paragraph_regions(_wrap(_HYBRID_TEXT["en-p1"])),
    })

    dup_png = _render_text_image("en", [_HYBRID_TEXT["en-dup"], _HYBRID_TEXT["en-unique"]], region=(0, 0, 900, 400))

    def build_012(pdf):
        _draw_paragraph(pdf, _wrap(_HYBRID_TEXT["en-dup"]), top=720)
        # The embedded scan duplicates the native heading at the *same* page
        # position — its first rendered line maps onto the native line's
        # bounding region so the deduplication policy can genuinely exercise
        # bbox-overlap + text-similarity suppression.  The unique OCR line
        # below it lands outside the native region and must be kept.
        pdf.drawImage(ImageReader(io.BytesIO(dup_png)), 45, 575, width=440, height=195)

    emit("HYBRID-012", build_012, {
        "language": "en", "mode": "mixed", "pages": [{"classification": "MIXED", "ocrRegions": 1}],
        "expectedText": f"{_HYBRID_TEXT['en-dup']} {_HYBRID_TEXT['en-dup']} {_HYBRID_TEXT['en-unique']}",
        "deduplicatedText": _HYBRID_TEXT["en-dup"],
    })
    return truth


_OCR_TEXT = {
    "en": {
        "clean": ["The ministry issued a new policy in 2024.", "All regional offices received the notice."],
        "dense": ["This dense paragraph contains several short lines.", "Each line is rendered at a smaller size.", "Dense text exercises OCR line separation.", "The final line completes the dense fixture."],
        "mixed": ["Invoice INV-2024-0042 totals 1250.50 rupees.", "Report date: 2024-01-15, reference DOC-77."],
        "numbers": ["ID 9841001234 date 15-01-2024 amount 999.75.", "Batch 42 of 100, score 98.5 percent."],
    },
    "ne": {
        "clean": ["नेपाल सरकारको मन्त्रिपरिषद् कार्यालयले नयाँ नीति जारी गर्‍यो।", "सबै क्षेत्रीय कार्यालयहरूलाई सूचना पठाइयो।"],
        "dense": ["यो घना अनुच्छेदमा धेरै छोटा लाइनहरू छन्।", "प्रत्येक लाइन सानो आकारमा छापिएको छ।", "घना पाठले OCR लाइन छुट्ट्याउन जाँच्छ।", "अन्तिम लाइनले घना नमूना पूरा गर्छ।"],
        "mixed": ["चलानी INV-2024-0042 जम्मा १२५०.५० रुपैयाँ।", "रिपोर्ट मिति: 2024-01-15, सन्दर्भ DOC-77."],
        "numbers": ["परिचय ९८४१००१२३४ मिति १५-०१-२०२४ रकम ९९९.७५।", "ब्याच ४२ कुल १००, अंक ९८.५ प्रतिशत।"],
    },
    "hi": {
        "clean": ["भारत सरकार ने २०२४ में नई शिक्षा नीति लागू की।", "सभी क्षेत्रीय कार्यालयों को सूचना भेजी गई।"],
        "dense": ["इस घने अनुच्छेद में कई छोटी पंक्तियाँ हैं।", "प्रत्येक पंक्ति छोटे आकार में छपी है।", "घना पाठ OCR पंक्ति पृथक्करण की जाँच करता है।", "अंतिम पंक्ति घना नमूना पूरा करती है।"],
        "mixed": ["चालान INV-2024-0042 कुल १२५०.५० रुपये।", "रिपोर्ट तिथि: 2024-01-15, संदर्भ DOC-77."],
        "numbers": ["पहचान ९८४१००१२३४ तिथि १५-०१-२०२४ राशि ९९९.७५।", "बैच ४२ कुल १००, अंक ९८.५ प्रतिशत।"],
    },
    "mr": {
        "clean": ["महाराष्ट्र शासनाने २०२४ मध्ये नवीन धोरण जाहीर केले.", "सर्व प्रादेशिक कार्यालयांना सूचना पाठवली."],
        "dense": ["या दाट परिच्छेदात अनेक छोट्या ओळी आहेत.", "प्रत्येक ओळ लहान आकारात छापली आहे.", "दाट मजकूर OCR ओळ वेगळेपण तपासतो.", "शेवटची ओळ दाट नमूना पूर्ण करते."],
        "mixed": ["पावती INV-2024-0042 एकूण १२५०.५० रुपये.", "अहवाल दिनांक: 2024-01-15, संदर्भ DOC-77."],
        "numbers": ["ओळख ९८४१००१२३४ दिनांक १५-०१-२०२४ रकम ९९९.७५.", "बॅच ४२ एकूण १००, गुण ९८.५ टक्के."],
    },
}


def _generate_ocr(out: Path) -> dict[str, dict[str, dict]]:
    """Per-language OCR fixtures: clean/dense/noisy/rotated/mixed/numbers."""
    truth: dict[str, dict[str, dict]] = {}
    for language, variants in _OCR_TEXT.items():
        directory = out / language
        directory.mkdir(parents=True, exist_ok=True)
        entries: dict[str, dict] = {}
        for variant in ("clean", "dense", "noisy", "rotated", "mixed", "numbers"):
            base = "dense" if variant in {"noisy", "rotated"} else variant
            lines = variants[base]
            size = 30 if variant == "dense" else 38
            png = _render_text_image(language, lines, size=size, noise_seed=7 if variant == "noisy" else None, rotation=3.0 if variant == "rotated" else 0.0)
            name = f"{language}-{variant}.png"
            (directory / name).write_bytes(png)
            entries[f"OCR-{language.upper()}-{variant.upper()}"] = {"file": name, "language": language, "variant": variant, "expectedText": " ".join(lines)}
        (directory / "ground_truth.json").write_text(json.dumps(entries, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        truth[language] = entries
    return truth


_OFFICE_TEXT = {
    "en": "The regional office published the annual compliance report.",
    "ne": "क्षेत्रीय कार्यालयले वार्षिक अनुपालन प्रतिवेदन प्रकाशित गर्‍यो।",
    "hi": "क्षेत्रीय कार्यालय ने वार्षिक अनुपालन रिपोर्ट प्रकाशित की।",
    "mr": "प्रादेशिक कार्यालयाने वार्षिक अनुपालन अहवाल प्रकाशित केला.",
}


def _normalize_zip(path: Path) -> None:
    """Rewrite an OOXML package with fixed timestamps and sorted members."""
    with tempfile.NamedTemporaryFile(delete=False, suffix=path.suffix, dir=path.parent) as tmp:
        tmp_path = Path(tmp.name)
    try:
        with zipfile.ZipFile(path) as source, zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as target:
            for name in sorted(source.namelist()):
                data = source.read(name)
                if name == "docProps/core.xml":
                    data = re.sub(rb"(<dcterms:(?:created|modified)[^>]*>)[^<]*(</)", rb"\g<1>2024-01-01T00:00:00Z\g<2>", data)
                info = zipfile.ZipInfo(name, FIXED_ZIP_DATE)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o600 << 16
                target.writestr(info, data)
        tmp_path.replace(path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _generate_office(out: Path) -> dict[str, dict[str, dict]]:
    truth: dict[str, dict[str, dict]] = {}
    for language, text in _OFFICE_TEXT.items():
        directory = out / "docx" / language
        directory.mkdir(parents=True, exist_ok=True)
        from docx import Document
        document = Document()
        document.add_paragraph(text)
        document.add_paragraph("Second paragraph for structural coverage.")
        table = document.add_table(rows=2, cols=2)
        table.cell(0, 0).text = "Key"
        table.cell(0, 1).text = "Value"
        table.cell(1, 0).text = "Amount"
        table.cell(1, 1).text = "1250"
        path = directory / f"{language}-simple.docx"
        document.save(path)
        _normalize_zip(path)
        truth.setdefault("docx", {})[f"DOCX-{language.upper()}-001"] = {"file": str(path.relative_to(CORPUS)), "language": language, "expectedText": f"{text} Second paragraph for structural coverage. Key Value Amount 1250"}

        directory = out / "pptx" / language
        directory.mkdir(parents=True, exist_ok=True)
        from pptx import Presentation
        from pptx.util import Inches
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[5])
        box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1.5))
        box.text_frame.text = text
        path = directory / f"{language}-simple.pptx"
        presentation.save(path)
        _normalize_zip(path)
        truth.setdefault("pptx", {})[f"PPTX-{language.upper()}-001"] = {"file": str(path.relative_to(CORPUS)), "language": language, "expectedText": text}

        directory = out / "xlsx" / language
        directory.mkdir(parents=True, exist_ok=True)
        from openpyxl import Workbook
        workbook = Workbook()
        sheet = workbook.active
        sheet["A1"], sheet["B1"] = "Key", "Value"
        sheet["A2"], sheet["B2"] = text, "1250"
        path = directory / f"{language}-simple.xlsx"
        workbook.save(path)
        _normalize_zip(path)
        truth.setdefault("xlsx", {})[f"XLSX-{language.upper()}-001"] = {"file": str(path.relative_to(CORPUS)), "language": language, "expectedText": f"Key Value {text} 1250", "expectedCells": 4}

    # Named structural fixtures — built with real OOXML libraries so the
    # packages are spec-valid (the manifest exercises them through Docling).
    from docx import Document
    merged = Document()
    merged.add_paragraph("बीजक क्रमांक १००१ एकूण १२५०")
    table = merged.add_table(rows=3, cols=3)
    table.cell(0, 0).merge(table.cell(0, 2)).text = "मर्ज शीर्षक"
    table.cell(1, 0).merge(table.cell(2, 0)).text = "पङ्क्ति-विस्तार"
    for col in range(1, 3):
        table.cell(1, col).text = f"घर 1-{col}"
        table.cell(2, col).text = f"घर 2-{col}"
    path = out / "docx" / "mr-merged-table.docx"
    merged.save(path)
    _normalize_zip(path)
    truth.setdefault("docx", {})["DOCX-MR-002"] = {"file": str(path.relative_to(CORPUS)), "language": "mr", "expectedText": "बीजक क्रमांक १००१ एकूण १२५० मर्ज शीर्षक पङ्क्ति-विस्तार घर 1-1 घर 1-2 घर 2-1 घर 2-2", "expectedCells": 6}

    from pptx import Presentation
    from pptx.util import Inches
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    box = slide.shapes.add_textbox(Inches(1), Inches(0.5), Inches(6), Inches(1))
    box.text_frame.text = "बीजक नम्बर १००१ कुल १२५०"
    shape = slide.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(4), Inches(1))
    shape.table.cell(0, 0).text = "कुञ्जी"
    shape.table.cell(0, 1).text = "मान"
    shape.table.cell(1, 0).text = "रकम"
    shape.table.cell(1, 1).text = "१२५०"
    slide.notes_slide.notes_text_frame.text = "DO NOT EMIT THIS SPEAKER NOTE"
    path = out / "pptx" / "ne-table-with-notes.pptx"
    presentation.save(path)
    _normalize_zip(path)
    # Speaker notes are not visible slide content and remain explicit negative ground truth.
    truth.setdefault("pptx", {})["PPTX-NE-002"] = {"file": str(path.relative_to(CORPUS)), "language": "ne", "expectedText": "बीजक नम्बर १००१ कुल १२५०", "excludedText": "DO NOT EMIT THIS SPEAKER NOTE"}

    from openpyxl import Workbook
    workbook = Workbook()
    sheet = workbook.active
    sheet["B2"] = "चालान संख्या १००१"
    sheet.merge_cells("B2:C2")
    sheet["D2"] = "कुल"
    sheet["D5"] = "१२५०"
    path = out / "xlsx" / "hi-sparse-merged.xlsx"
    workbook.save(path)
    _normalize_zip(path)
    truth.setdefault("xlsx", {})["XLSX-HI-002"] = {"file": str(path.relative_to(CORPUS)), "language": "hi", "expectedText": "चालान संख्या १००१ कुल १२५०", "expectedCells": 3}
    return truth


def main() -> int:
    hybrid = _generate_hybrid_pdf(CORPUS / "hybrid-pdf")
    (CORPUS / "hybrid-pdf" / "ground_truth.json").write_text(json.dumps(hybrid, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    _generate_ocr(CORPUS / "ocr")
    office = _generate_office(CORPUS)
    (CORPUS / "office-ground-truth.json").write_text(json.dumps(office, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"hybridPdf": sorted(hybrid), "status": "generated"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
