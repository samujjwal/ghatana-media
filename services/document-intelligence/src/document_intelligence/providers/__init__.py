"""Concrete local provider implementations."""

from .docling_parser import DoclingParser
from .paddle_ocr_parser import PaddleOcrParser
from .gliner_extractor import GlinerExtractor
from .minilm_embedder import MiniLmEmbedder
from .docling_office_parser import DoclingOfficeParser, DoclingPptxParser, DoclingXlsxParser
from .native_office_parser import DocxParser, NativeOfficeParser, PptxParser, XlsxParser
from .office_rendered_parser import OfficeRenderedParser
from .tesseract_ocr_parser import TesseractOcrParser
from .strategies import HybridPdfParser, ResilientParser

__all__ = [
    "DoclingParser",
    "PaddleOcrParser",
    "GlinerExtractor",
    "MiniLmEmbedder",
    "DoclingOfficeParser",
    "DoclingPptxParser",
    "DoclingXlsxParser",
    "OfficeRenderedParser",
    "NativeOfficeParser",
    "DocxParser",
    "PptxParser",
    "XlsxParser",
    "TesseractOcrParser",
    "HybridPdfParser",
    "ResilientParser",
]
