from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from document_intelligence.strategies.hybrid_pdf import (  # noqa: E402
    HybridPdfStrategy,
    load_routing_policy,
    merge_parsed_documents,
)
from document_intelligence.runtime.cancellation import CancellationToken  # noqa: E402
from document_intelligence.runtime.deadline import Deadline  # noqa: E402
from document_intelligence.runtime.pdf_rendering import PdfPageInfo  # noqa: E402


ROUTING = ROOT / "routing/hybrid-pdf.v1.yaml"
CALIBRATION = ROOT / "evaluation/increment4a/corpus/calibration/hybrid-pdf/manifest.yaml"
QUALIFICATION = ROOT / "evaluation/increment4a/corpus/qualification/hybrid-pdf/manifest.yaml"


def _line(text: str, *, x: float = 0.1, y: float = 0.1) -> dict:
    return {"lineId": "source", "text": text, "boundingRegion": {"x": x, "y": y, "width": 0.2, "height": 0.1}}


def _document(*lines: dict, page: int = 1) -> dict:
    return {"pages": [{"pageNumber": page, "blocks": [{"blockId": "source", "kind": "TEXT", "boundingRegion": {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.2}, "lines": list(lines)}], "tables": []}], "quality": {}}


def _info(index: int, characters: int, regions: tuple[dict, ...] = ()) -> PdfPageInfo:
    return PdfPageInfo(index, index + 1, 612.0, 792.0, characters, regions)


def _classes(result: dict) -> list[dict]:
    prefix = "pageClassifications:"
    warnings = result["quality"].get("warnings", [])
    payload = next(item[len(prefix):] for item in warnings if item.startswith(prefix))
    return json.loads(payload)


class FakeRenderer:
    def __init__(self, infos: list[PdfPageInfo]) -> None:
        self._infos = infos
        self.rendered: list[tuple] = []

    def page_count(self) -> int:
        return len(self._infos)

    def page_info(self, index: int) -> PdfPageInfo:
        return self._infos[index]

    def render_page_png(self, index: int) -> bytes:
        self.rendered.append(("page", index))
        return b"png"

    def render_region_png(self, index: int, region: dict) -> bytes:
        self.rendered.append(("region", index, region))
        return b"png"

    def close(self) -> None:
        pass


class FakeExecutor:
    def __init__(self, responses: dict[str, dict]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, str | None]] = []

    async def parse(self, provider: str, data: bytes, **kwargs: object) -> dict:
        self.calls.append((provider, kwargs.get("media_type")))
        return self.responses[provider]


def _custom_routing(tmp_path: Path, mutate=None) -> Path:
    routing = yaml.safe_load(ROUTING.read_text(encoding="utf-8"))
    if mutate is not None:
        mutate(routing)
    custom = tmp_path / "hybrid-pdf.v1.yaml"
    custom.write_text(yaml.safe_dump(routing), encoding="utf-8")
    return custom


def test_hybrid_manifests_are_reviewed_and_lane_separated() -> None:
    calibration = yaml.safe_load(CALIBRATION.read_text(encoding="utf-8"))
    qualification = yaml.safe_load(QUALIFICATION.read_text(encoding="utf-8"))
    calibration_ids = {item["fixtureId"] for item in calibration["fixtures"]}
    qualification_ids = {item["fixtureId"] for item in qualification["fixtures"]}

    assert calibration["reviewed"] is True
    assert qualification["reviewed"] is True
    assert calibration["lane"] == "calibration"
    assert qualification["lane"] == "qualification"
    assert calibration_ids.isdisjoint(qualification_ids)
    assert calibration_ids | qualification_ids == {f"HYBRID-{index:03d}" for index in range(1, 13)}
    assert all(item["reviewed"] is True for item in calibration["fixtures"] + qualification["fixtures"])
    assert all(item["reference"]["generatedProviderGroundTruth"] is False for item in calibration["fixtures"] + qualification["fixtures"])


def test_strategy_reads_policy_from_routing_authority(tmp_path: Path) -> None:
    def mutate(routing):
        routing["classification"]["minimumTextCharacters"] = 3
        routing["deduplication"]["textSimilarity"] = 0.9
    custom = _custom_routing(tmp_path, mutate)

    policy = load_routing_policy(custom)
    strategy = HybridPdfStrategy.from_routing_authority(custom, renderer_factory=lambda data: FakeRenderer([_info(0, 40)]))
    primary = _document(_line("native text line"))
    executor = FakeExecutor({policy.primary: primary, policy.ocr_route: _document(_line("ocr"))})

    result = asyncio.run(
        strategy.parse(
            b"pdf",
            media_type="application/pdf",
            language="en",
            limits={},
            deadline=Deadline(1000, margin_ms=0),
            token=CancellationToken(),
            executor=executor,
            call_stack=(strategy.provider_ref,),
        )
    )

    assert strategy.routing.minimum_text_characters == 3
    assert strategy.routing.text_similarity == 0.9
    assert executor.calls == [(policy.primary, "application/pdf")]
    assert result["providerProvenance"]["providerRef"] == strategy.provider_ref
    assert _classes(result)[0]["classification"] == "NATIVE"


@pytest.mark.asyncio
async def test_scanned_page_routes_rendered_png_to_ocr_and_deduplicates(tmp_path: Path) -> None:
    custom = _custom_routing(tmp_path)
    region = {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}
    renderer = FakeRenderer([_info(0, 0, (region,))])
    strategy = HybridPdfStrategy(custom, renderer_factory=lambda data: renderer)
    # A scanned page may still carry a sparse text layer; native text wins.
    primary = _document(_line("abc"))
    secondary = _document(_line("abc"), _line("ocr-only", x=0.4))
    executor = FakeExecutor({strategy.routing.primary: primary, strategy.routing.ocr_route: secondary})

    result = await strategy.parse(
        b"pdf",
        media_type="application/pdf",
        language="en",
        limits={},
        deadline=Deadline(1000, margin_ms=0),
        token=CancellationToken(),
        executor=executor,
        call_stack=(strategy.provider_ref,),
    )

    assert executor.calls == [(strategy.routing.primary, "application/pdf"), (strategy.routing.ocr_route, "image/png")]
    assert renderer.rendered == [("page", 0)]
    texts = [line["text"] for block in result["pages"][0]["blocks"] for line in block["lines"]]
    assert texts == ["abc", "ocr-only"]
    assert _classes(result)[0]["classification"] == "SCANNED"


@pytest.mark.asyncio
async def test_mixed_page_renders_only_image_regions_and_remaps_coordinates(tmp_path: Path) -> None:
    custom = _custom_routing(tmp_path)
    region = {"x": 0.5, "y": 0.5, "width": 0.5, "height": 0.5}
    renderer = FakeRenderer([_info(0, 80, (region,))])
    strategy = HybridPdfStrategy(custom, renderer_factory=lambda data: renderer)
    primary = _document(_line("native line", x=0.1, y=0.1))
    secondary = _document(_line("image line", x=0.2, y=0.2))
    executor = FakeExecutor({strategy.routing.primary: primary, strategy.routing.ocr_route: secondary})

    result = await strategy.parse(
        b"pdf",
        media_type="application/pdf",
        language="en",
        limits={},
        deadline=Deadline(1000, margin_ms=0),
        token=CancellationToken(),
        executor=executor,
        call_stack=(strategy.provider_ref,),
    )

    assert executor.calls == [(strategy.routing.primary, "application/pdf"), (strategy.routing.ocr_route, "image/png")]
    assert renderer.rendered == [("region", 0, region)]
    ocr_line = result["pages"][0]["blocks"][1]["lines"][0]
    assert ocr_line["boundingRegion"] == {"x": 0.6, "y": 0.6, "width": 0.1, "height": 0.05}
    assert _classes(result)[0]["classification"] == "MIXED"


@pytest.mark.asyncio
async def test_blank_page_does_not_invoke_ocr(tmp_path: Path) -> None:
    custom = _custom_routing(tmp_path)
    strategy = HybridPdfStrategy(custom, renderer_factory=lambda data: FakeRenderer([_info(0, 0)]))
    executor = FakeExecutor({strategy.routing.primary: _document()})

    result = await strategy.parse(
        b"pdf",
        media_type="application/pdf",
        language="en",
        limits={},
        deadline=Deadline(1000, margin_ms=0),
        token=CancellationToken(),
        executor=executor,
        call_stack=(strategy.provider_ref,),
    )

    assert executor.calls == [(strategy.routing.primary, "application/pdf")]
    assert _classes(result)[0]["classification"] == "BLANK"


def test_merge_is_page_ordered_and_does_not_mutate_provider_results() -> None:
    primary = {"pages": [{"pageNumber": 2, "blocks": [{"lines": [_line("two")]}], "tables": []}]}
    secondary = {"pages": [{"pageNumber": 1, "blocks": [{"lines": [_line("one")]}], "tables": []}]}
    result = merge_parsed_documents(primary, secondary, {"providerRef": "ghatana.hybrid-pdf"})

    assert [page["pageNumber"] for page in result["pages"]] == [1, 2]
    assert primary["pages"][0]["blocks"][0]["lines"][0]["lineId"] == "source"
