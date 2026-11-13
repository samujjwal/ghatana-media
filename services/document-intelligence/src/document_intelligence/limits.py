from __future__ import annotations

from dataclasses import dataclass

from .errors import WorkerError


@dataclass(frozen=True)
class Limits:
    max_upload_bytes: int = 50 * 1024 * 1024
    max_operation_timeout_ms: int = 120_000
    max_metadata_bytes: int = 64 * 1024
    max_pages: int = 500
    max_blocks: int = 100_000
    max_lines: int = 200_000
    max_tables: int = 50_000
    max_table_rows: int = 200_000
    max_table_cells: int = 500_000
    max_regions: int = 1_000_000
    max_text_characters: int = 2_000_000
    max_candidates: int = 16_000
    max_evidence: int = 32
    max_evidence_spans: int = 256_000
    max_embedding_dimensions: int = 16_384
    max_serialized_response_bytes: int = 32 * 1024 * 1024
    max_queue: int = 32
    max_office_archive_members: int = 10_000
    max_office_uncompressed_bytes: int = 256 * 1024 * 1024
    max_office_member_bytes: int = 64 * 1024 * 1024
    max_office_compression_ratio: int = 100
    max_pdf_objects: int = 200_000
    max_pdf_streams: int = 100_000
    max_pdf_page_dimension_pt: int = 14_400
    max_image_dimension_px: int = 16_000
    max_image_frames: int = 4
    max_decoded_image_bytes: int = 512 * 1024 * 1024

    def validate(self) -> None:
        values = self.__dict__
        if any(not isinstance(value, int) or value <= 0 for value in values.values()):
            raise ValueError("all worker limits must be positive integers")


def require_limit(value: int, ceiling: int, code: str = "LIMIT_EXCEEDED") -> int:
    if not isinstance(value, int) or value < 0 or value > ceiling:
        raise WorkerError(code)
    return value
