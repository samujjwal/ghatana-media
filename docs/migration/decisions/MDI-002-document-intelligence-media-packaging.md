# MDI-002 — Document Intelligence packaging/ownership re-homing into Media (bounded supersession of MDI-001)

**Status:** PROPOSED  
**Recorded:** 2026-11-12  
**Authority:** the owner's authorization of the Kernel-first direction in
`PHR_KERNEL_FIRST_CROSS_REPOSITORY_EXECUTION_PLAN_2026-11-12.md` ("Important decision change: DI placement", §1, §5 MED-01..04/09/10).
**Review state:** **no independent architectural review has been performed or claimed.** This record is a proposal that makes
the revised plan concrete; it is not an accepted decision until an architectural reviewer accepts it. If review rejects it,
Document Intelligence stays in `ghatana/services/document-intelligence` and the identical Kernel public facade is still required
(see "If rejected").
**Supersedes (packaging/ownership portion only):** [`MDI-001`](./MDI-001-document-intelligence-ownership.md), which is preserved
byte-for-byte and remains the record of the 2026-10-04 decision and its 2026-10-30 single-OCR-authority reaffirmation.

## What is superseded, and only that

MDI-001 said the generic worker "will not move into `ghatana-media`" and that Media's build/package must omit it.
MDI-002 proposes replacing **only that packaging/location sentence**: the existing, single Document Intelligence (DI) worker and
its Java/TypeScript clients are re-homed, behavior-preserving and without redesign, as an **independently packageable,
product-neutral service module** at `services/document-intelligence/` in `ghatana-media`, versioned, built, published and
deployed separately from Media audio/video deployments.

## What is NOT changed (carried forward from MDI-001 unchanged)

1. **One DI public gateway.** `document-intelligence.v1` is the only Ghatana OCR/parse gateway. PaddleOCR, Tesseract,
   Docling and future engines remain internal provider adapters chosen and qualified by DI. This is a re-homing, not
   permission for a second OCR gateway, model, contract version or worker. No v2, no new status GET (v1 documents only
   `GET /v1/providers`, `POST /v1/parse`, generation-bound `DELETE /v1/operations/{id}`; lost acknowledgement or restart is
   reported as `UNKNOWN`).
2. **Media is a DI consumer for scene text.** Frame/time/ROI/source-digest/rights/overlay semantics stay Media-owned and live
   outside the generic DI parse contract. Media's `scene-text-adapter` calls only the DI public client; no Media OCR engine.
3. **Shared owns** `@ghatana/documents` and `@ghatana/document-extraction`; the DI client keeps its Shared peer and does not
   copy those schemas. **Kernel remains the sole product-facing resolver**; products (for example PHR) never depend on a Media
   or Ghatana service URL, only on the Kernel public facade.
4. **Provider identities, profiles, capability admissions, model manifests, evaluation assets, shared-contract lock,
   cancellation semantics, offline behavior, provenance and non-activation state are preserved.** Nothing here admits a
   provider, model, document format or rights position. Restructuring DI internals remains a later, separately scoped change.
5. **Core Media independence.** Media upload/jobs/STT/TTS/video do not depend on DI. A DI outage makes only DI-dependent OCR
   operations unavailable.

## Deployment-writer and cutover rules (normative for this proposal)

| Rule | Statement |
| --- | --- |
| One DI gateway | Exactly one wire contract and one public client per language, generated from the same `document-intelligence.v1` schemas. |
| One deployment writer | At any moment exactly one DI deployment is the **active writer** (worker process, runtime/model state, outbox/queue if any, public endpoint). |
| Current writer | **The existing Ghatana deployment remains the active writer until cutover is proven.** The Media copy under `services/document-intelligence/` is **NOT the active deployment writer** (`MIGRATION-MANIFEST.json` `deploymentWriter.media = INACTIVE_PENDING_CUTOVER`). |
| No dual start | Never start both locations as production writers or against the same state/endpoint. Media development runs use isolated stores. |
| Cutover proof | Source parity (manifest digests), data parity, consumer rebinding inventory, and authoritative endpoint switch are each proven and recorded before the Ghatana deployment is demoted. See `docs/operations/DOCUMENT-INTELLIGENCE-RELEASE-RUNBOOK.md`. |
| Retirement | Ghatana DI sources/binaries are retired only after source, data, consumer **and** endpoint cutover are all proven, with rollback path and approval. |

## Artifacts updated by this record (all additive)

- `BOUNDARY.md` — new "MDI-002 (PROPOSED)" section; earlier text is retained as the currently accepted position until MDI-002 is accepted.
- `.product-experience/pdp-0-product-truth/ocr-ownership.yaml` — additive `packagingSupersession` block and decision `PDP0-003-D5` (state `proposed`); `PDP0-003-D4` untouched.
- `docs/migration/document-intelligence-source-destination-crosswalk.md` — source→destination crosswalk.
- `services/document-intelligence/MIGRATION-MANIFEST.json` — per-file source/destination SHA-256 (source `ghatana` `origin/main` commit `7d81f267bc7fe1149557d827e029a0dfd09bc6ab`).

## Status ledger

| Item | State |
| --- | --- |
| MDI-001 | accepted; text preserved byte-for-byte; packaging clause proposed-superseded |
| MDI-002 | PROPOSED; no external architectural review claimed |
| DI source copy in Media | present, parity-manifested, **not active writer** |
| Ghatana DI deployment | remains active writer |
| Installed/published clients | Java local-Maven publication task defined; no remote publication or signing performed |
| Provider/model/rights admission | unchanged: NOT_ADMITTED where previously so |
| Endpoint/data/consumer cutover | not executed |

## If rejected

If architectural review retains DI in `ghatana/services/document-intelligence`, the identical Kernel public facade and the
source-free clients are still required and consumed from that location; the Media copy is then removed in a follow-up
(its manifest identifies every added path), and MDI-001 stands unchanged. No product-visible contract changes either way.
