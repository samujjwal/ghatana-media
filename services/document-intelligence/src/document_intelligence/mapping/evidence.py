from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ProjectionInterval:
    projection_start: int
    projection_end: int
    page_number: int
    block_id: str
    line_id: str
    text: str
    bounding_region: dict[str, float]


def project_lines(pages: list[dict]) -> tuple[str, list[ProjectionInterval]]:
    chunks: list[str] = []
    intervals: list[ProjectionInterval] = []
    offset = 0
    for page in pages:
        for block in page.get("blocks", []):
            for line in block.get("lines", []):
                if chunks:
                    chunks.append("\n")
                    offset += 1
                text = line["text"]
                start = offset
                chunks.append(text)
                offset += len(text)
                intervals.append(ProjectionInterval(start, offset, page["pageNumber"], block["blockId"], line["lineId"], text, line["boundingRegion"]))
    return "".join(chunks), intervals


def utf16_offset(text: str, code_point_offset: int) -> int:
    return len(text[:code_point_offset].encode("utf-16-le")) // 2


def evidence_for_span(start: int, end: int, intervals: list[ProjectionInterval]) -> list[dict]:
    evidence: list[dict] = []
    for item in intervals:
        overlap_start = max(start, item.projection_start)
        overlap_end = min(end, item.projection_end)
        if overlap_start >= overlap_end:
            continue
        local_start = overlap_start - item.projection_start
        local_end = overlap_end - item.projection_start
        evidence.append({"pageNumber": item.page_number, "blockId": item.block_id, "lineId": item.line_id, "boundingRegion": item.bounding_region, "textSpan": {"start": utf16_offset(item.text, local_start), "end": utf16_offset(item.text, local_end)}})
    return evidence
