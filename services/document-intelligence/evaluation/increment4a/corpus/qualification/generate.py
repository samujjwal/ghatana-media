#!/usr/bin/env python3
"""Render the independent HI/MR OCR qualification fixtures from local assets."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


HERE = Path(__file__).resolve().parent
FONT = Path("/usr/share/fonts/truetype/noto/NotoSerifDevanagari-Regular.ttf")
FIXTURES = {
    "hi": "चालान संख्या HI-1001 कुल 1250",
    "mr": "चालान क्रमांक MR-1001 एकूण 1250",
}


def main() -> int:
    if not FONT.is_file():
        raise SystemExit(f"local Devanagari font is required: {FONT}")
    font = ImageFont.truetype(str(FONT), 64)
    for language, text in FIXTURES.items():
        output = HERE / "ocr" / language / "fixture.png"
        image = Image.new("RGB", (1600, 400), "white")
        ImageDraw.Draw(image).text((128, 96), text, fill="black", font=font)
        image.save(output, format="PNG", optimize=False)
        print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
