# Historical implementation records

This index groups dated implementation and qualification packets that remain in the repository for provenance. They are historical references, not the current feature selector, task register, product-definition authority, or proof of runtime readiness. For current work, use [Usable Surface Delivery](../development/USABLE-SURFACE-DELIVERY.md), the [remaining-work register](../development/remaining-work.json), and the [surface implementation plan](../development/SURFACE-IMPLEMENTATION-PLAN.md).

## Historical execution packets

| Record | Scope and status boundary |
| --- | --- |
| [Media BUILD Implementation Plan](MEDIA-BUILD-IMPLEMENTATION-PLAN.md) | Prior planning baseline for post-Discovery BUILD / Plan Implementation; not the current feature selector. |
| [Backend Modality Wave 2 plan](MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md), [R7 owner directive](MEDIA-WAVE2-OWNER-IMPLEMENTATION-DIRECTIVE-2026-10-27.md), and [R7 execution schedule](MEDIA-WAVE2-R7-EXECUTION-SCHEDULE.json) | Historical STT, TTS, Vision, Multimodal, and observability work. The plan retains its task acceptance/status ownership; the schedule does not promote tasks. |
| [PDP-0–3 gtool execution board v2](MEDIA-PDP0-3-GTOOL-EXECUTION-BOARD.v2.md), [gtool execution queue v2](MEDIA-GTOOL-EXECUTION-QUEUE.v2.json), and [owner-approved execution scope](MEDIA-PDP0-3-GTOOL-OWNER-APPROVED-EXECUTION.md) | Historical execution coordination, subordinate to source PDP and the canonical Build plan; not another task authority or acceptance proof. |
| [Build identity trace](MEDIA-BUILD-IDENTITY-TRACE.v1.json) | Read-only planning appendix; not a product-definition or runtime authority. |

## Preserved artifacts and retention boundary

The [historical artifact inventory](historical-artifact-inventory.v1.json) classifies tracked historical files. The [preservation manifest](../development/historical-content-preservation.json) pins 42 exact artifacts (428,652,561 bytes) and records the retention conditions. Its current disposition is `PRESERVE_IN_PLACE; EXTERNAL_ARCHIVE_REQUIRED_ONLY_BEFORE_DELETION`; `externalArchiveVerified` and `deletionApproved` remain false. Local temporary export checks do not establish an authenticated immutable off-main copy or independent readback.

Do not delete or move pinned artifacts until the manifest's independent preservation, hash/readback, reference migration, and privacy/retention conditions are evidenced. Git history and basename-based inbound-reference counts are not substitutes for those conditions. This index changes navigation only; it does not alter task, acceptance, or retention status.
