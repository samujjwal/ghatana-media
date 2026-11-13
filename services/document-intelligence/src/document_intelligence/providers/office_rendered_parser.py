"""DOCX remediation: deterministic PDF render followed by the qualified PDF parser.

Word documents carry no fixed pagination, and the pinned Docling DOCX backend
returns no page provenance, so a DOCX cannot satisfy the frozen coordinate
contract directly.  This strategy renders the document to a real PDF in a
bounded, sandboxed step and then delegates to the qualified ``ghatana.docling``
PDF parser through the worker executor.  The emitted geometry is the real
layout of the rendered artifact, and the provenance names the render step —
no synthetic line/page boxes are manufactured.

Renderer selection is explicit and reviewable:

- ``soffice``: a provisioned LibreOffice binary, run argument-vector only in an
  isolated private directory bounded by the request deadline.
- ``reportlab``: the pure-Python deterministic renderer.  It lays out the real
  OOXML content (paragraphs and tables in document order) and produces a real
  PDF text layer; it is always available inside the provisioned runtime.

When neither renderer is provisioned the strategy fails closed with
``PROVIDER_UNAVAILABLE``; DOCX qualification then stays NOT_RUN rather than
returning invented geometry.
"""
from __future__ import annotations

import io
import os
import secrets
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable, Mapping
from xml.etree import ElementTree
from zipfile import ZipFile

from ..errors import WorkerError
from ..runtime.cancellation import CancellationToken
from ..runtime.deadline import Deadline
from ..runtime.ooxml_preflight import DOCX, OoxmlLimits, validate_ooxml
from ..runtime.subprocess_runner import run_bounded_subprocess
from .native_office_parser import _children, _descendant, _integer, _attr, _local, _parse_xml, _table_cells, _text


def _docx_flow(data: bytes) -> list[dict[str, Any]]:
    """Return the real OOXML content in document order (no invented geometry)."""
    with ZipFile(io.BytesIO(data)) as archive:
        root = _parse_xml(archive.read("word/document.xml"))
    body = _descendant(root, "body")
    if body is None:
        raise WorkerError("PROVIDER_FAILED")
    items: list[dict[str, Any]] = []
    for child in list(body):
        name = _local(child.tag)
        if name == "sectPr":
            continue
        if name == "p":
            text = _text(child).strip()
            if text:
                items.append({"kind": "paragraph", "text": text})
            if any(_local(node.tag) == "br" and _attr(node, "type") == "page" for node in child.iter()):
                items.append({"kind": "pagebreak"})
        elif name == "tbl":
            rows = _children(child, "tr")
            if not rows:
                continue
            grid = _first_grid(child)
            cells, column_count = _table_cells(rows, grid)
            matrix: list[list[str]] = [["" for _ in range(max(column_count, 1))] for _ in rows]
            for cell in cells:
                matrix[cell["rowIndex"]][cell["columnIndex"]] = cell["text"]
            items.append({"kind": "table", "rows": matrix})
    return items


def _first_grid(table: ElementTree.Element) -> list[float]:
    grid = _descendant(table, "tblGrid")
    if grid is None:
        return []
    return [float(max(1, _integer(_attr(column, "w"), 1440))) for column in _children(grid, "gridCol")]


class _SofficeRenderer:
    """Provisioned LibreOffice renderer, executed argument-vector only."""

    name = "soffice"

    def __init__(self, executable: str | None = None) -> None:
        self._executable = executable

    def available(self) -> bool:
        return self._resolve() is not None

    def _resolve(self) -> str | None:
        if self._executable:
            return self._executable
        return shutil.which("soffice") or shutil.which("libreoffice")

    def render(self, data: bytes, *, deadline: Deadline, token: CancellationToken, limits: Mapping[str, int]) -> bytes:
        executable = self._resolve()
        if executable is None:
            raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True)
        workdir = Path(tempfile.mkdtemp(prefix="docx-render-", dir=None))
        os.chmod(workdir, 0o700)
        try:
            source = workdir / f"input-{secrets.token_hex(8)}.docx"
            source.write_bytes(data)
            result = run_bounded_subprocess(
                [executable, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(workdir), str(source)],
                deadline=deadline, token=token, cwd=workdir,
                max_output_bytes=min(int(limits.get("maxTextCharacters", 2_000_000)) * 4, 16 * 1024 * 1024),
                env={"HOME": str(workdir), "SAL_USE_VCLPLUGIN": "svp"},
            )
            if result.returncode != 0:
                raise WorkerError("PROVIDER_FAILED", retryable=True)
            produced = sorted(path for path in workdir.glob("*.pdf") if path.is_file())
            if len(produced) != 1:
                raise WorkerError("PROVIDER_FAILED", retryable=True)
            pdf = produced[0].read_bytes()
            if len(pdf) > int(limits.get("maxUploadBytes", 50 * 1024 * 1024)):
                raise WorkerError("LIMIT_EXCEEDED")
            return pdf
        finally:
            shutil.rmtree(workdir, ignore_errors=True)


class _ReportlabRenderer:
    """Deterministic in-process renderer producing a real PDF text layer."""

    name = "reportlab"

    def available(self) -> bool:
        try:
            import reportlab  # noqa: F401
        except ImportError:
            return False
        # The pinned renderer fonts are part of the qualified Increment-4A
        # runtime: the reportlab path is only available when both provisioned
        # fonts resolve, so readiness fails closed instead of silently
        # rendering with whatever a host happens to install.
        return all(self._resolve_font(filename) is not None for filename in (self._LATIN_FONT, self._DEVANAGARI_FONT))

    _DEVANAGARI_FONT = "NotoSansDevanagari-Regular.ttf"
    _LATIN_FONT = "DejaVuSans.ttf"

    @staticmethod
    def _font_dirs() -> list[Path]:
        """The qualified renderer resolves only its provisioned font artifact."""
        cache = Path(os.getenv("DOCUMENT_INTELLIGENCE_MODEL_CACHE", Path(__file__).resolve().parents[3] / ".models"))
        return [cache / "office-renderer" / "fonts"]

    def _resolve_font(self, filename: str) -> Path | None:
        for directory in self._font_dirs():
            candidate = directory / filename
            if candidate.is_file():
                return candidate
        return None

    def _fonts(self) -> tuple[str, str]:
        """(devanagari, latin) registered font names.

        NotoSansDevanagari carries no Latin glyphs and DejaVu carries no
        Devanagari glyphs, so a single font cannot truthfully render a mixed
        document — text must be emitted in per-script runs.
        """
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        names = {"devanagari": self._resolve_font(self._DEVANAGARI_FONT), "latin": self._resolve_font(self._LATIN_FONT)}
        registered: dict[str, str] = {}
        missing = [filename for key, filename in (("devanagari", self._DEVANAGARI_FONT), ("latin", self._LATIN_FONT)) if names[key] is None]
        if missing:
            raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True)
        for key, path in names.items():
            assert path is not None
            name = f"office-render-{path.stem}"
            if name not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont(name, str(path)))
            registered[key] = name
        return registered["devanagari"], registered["latin"]

    @staticmethod
    def _devanagari(char: str) -> bool:
        return "\u0900" <= char <= "\u097f"

    def render(self, data: bytes, *, deadline: Deadline, token: CancellationToken, limits: Mapping[str, int]) -> bytes:
        try:
            from reportlab.lib.pagesizes import A4
            from reportlab.lib.styles import ParagraphStyle
            from reportlab.lib.units import inch
            from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Table, TableStyle
        except ImportError as exc:
            raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True) from exc
        flow = _docx_flow(data)
        devanagari, latin = self._fonts()
        style = ParagraphStyle("office-render", fontName=latin, fontSize=11, leading=14)
        # The rendered PDF must convey the source table's real grid so the
        # downstream parser can reconstruct cells — a borderless table would
        # degrade to unstructured text and hide the merge structure.
        grid = TableStyle([("GRID", (0, 0), (-1, -1), 0.5, "black")])

        def runs(text: str) -> str:
            from xml.sax.saxutils import escape
            parts: list[str] = []
            current: list[str] = []
            current_script: bool | None = None
            for char in text:
                script = self._devanagari(char)
                if current_script is not None and script != current_script:
                    parts.append((current_script, "".join(current)))
                    current = []
                current_script = script
                current.append(char)
            if current:
                parts.append((current_script or False, "".join(current)))
            return "".join(
                f'<font name="{devanagari}">{escape(chunk)}</font>' if is_devanagari else f'<font name="{latin}">{escape(chunk)}</font>'
                for is_devanagari, chunk in parts
            )

        story: list[Any] = []
        for item in flow:
            token.raise_if_cancelled()
            deadline.require_remaining()
            if item["kind"] == "pagebreak":
                story.append(PageBreak())
            elif item["kind"] == "paragraph":
                story.append(Paragraph(runs(item["text"]), style))
            elif item["kind"] == "table":
                story.append(Table([[Paragraph(runs(cell), style) for cell in row] for row in item["rows"]], style=grid))
        buffer = io.BytesIO()
        document = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=inch, rightMargin=inch, topMargin=inch, bottomMargin=inch)
        document.build(story or [Paragraph(" ", style)])
        pdf = buffer.getvalue()
        if len(pdf) > int(limits.get("maxUploadBytes", 50 * 1024 * 1024)):
            raise WorkerError("LIMIT_EXCEEDED")
        return pdf


def _default_renderer() -> Any:
    preference = os.getenv("DOCUMENT_INTELLIGENCE_OFFICE_RENDERER", "reportlab").lower()
    if preference == "reportlab":
        renderer = _ReportlabRenderer()
    elif preference == "soffice":
        if os.getenv("DOCUMENT_INTELLIGENCE_EXPERIMENTAL_OFFICE_RENDERER", "").lower() not in {"1", "true"}:
            raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True)
        renderer = _SofficeRenderer(os.getenv("DOCUMENT_INTELLIGENCE_SOFFICE") or None)
    else:
        # "auto" is deliberately not accepted: the qualified provider must
        # never select a renderer based on whichever binary is on the host.
        raise WorkerError("INVALID_REQUEST")
    return renderer if renderer.available() else None


class OfficeRenderedParser:
    """Render DOCX to PDF, then delegate to the qualified PDF parser."""

    provider_ref = "ghatana.docling-docx"
    is_strategy = True

    def __init__(self, renderer: Any = None) -> None:
        self._renderer = renderer if renderer is not None else _default_renderer()

    def identity(self) -> dict[str, str]:
        experimental_soffice = self._renderer is not None and self._renderer.name == "soffice"
        return {
            "providerRef": f"{self.provider_ref}.experimental-soffice" if experimental_soffice else self.provider_ref,
            "providerVersion": "0.1.0",
            "modelRef": "docling-rendered-docx-pipeline",
            "modelVersion": "experimental-host-soffice" if experimental_soffice else "pinned-docling-runtime",
        }

    def artifact_models(self) -> tuple[tuple[str, str], ...]:
        return ()

    def artifact_cache_keys(self) -> tuple[str, ...]:
        """The pinned renderer assets (reportlab fonts) are readiness material."""
        return ("office-renderer",)

    def runtime_dependencies(self) -> tuple[str, ...]:
        """The rendered DOCX is delegated to the qualified Docling PDF parser."""
        return ("ghatana.docling",)

    def capabilities(self) -> dict[str, Any]:
        return {"mediaTypes": [DOCX], "supportsTables": True, "supportsCoordinates": True, "supportsLanguages": True, "supportedLanguages": ["en", "ne", "hi", "mr"]}

    def warm(self) -> "OfficeRenderedParser":
        if self._renderer is None or not self._renderer.available():
            raise RuntimeError("no provisioned DOCX renderer is available")
        return self

    async def parse(
        self,
        data: bytes,
        *,
        media_type: str,
        language: str | None,
        limits: Mapping[str, int],
        deadline: Deadline,
        token: CancellationToken,
        executor: Any,
        call_stack: tuple[str, ...],
    ) -> dict[str, Any]:
        if media_type != DOCX:
            raise WorkerError("UNSUPPORTED_MEDIA_TYPE", provider_ref=self.provider_ref)
        validate_ooxml(data, media_type, OoxmlLimits(limits.get("maxOfficeArchiveMembers", 10_000), limits.get("maxOfficeUncompressedBytes", 256 * 1024 * 1024), limits.get("maxOfficeMemberBytes", 64 * 1024 * 1024), limits.get("maxOfficeCompressionRatio", 100)))
        if self._renderer is None or not self._renderer.available():
            raise WorkerError("PROVIDER_UNAVAILABLE", retryable=True, provider_ref=self.provider_ref)
        token.raise_if_cancelled()
        deadline.require_remaining()
        pdf = self._renderer.render(data, deadline=deadline, token=token, limits=limits)
        token.raise_if_cancelled()
        result = await executor.parse(
            "ghatana.docling",
            pdf,
            media_type="application/pdf",
            language=language,
            limits=limits,
            deadline=deadline,
            token=token,
            call_stack=call_stack,
        )
        quality = dict(result.get("quality", {}))
        warnings = list(quality.get("warnings", []))
        warnings.append(f"officeRenderer:{self._renderer.name}")
        quality["warnings"] = warnings
        return {**result, "providerProvenance": self.identity(), "quality": quality}


__all__ = ["OfficeRenderedParser"]
