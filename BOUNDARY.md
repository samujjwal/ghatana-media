# Ghatana Media repository boundary

**Product identity:** `media`  
**Destination:** `samujjwal/ghatana-media`  
**Current Media implementation code owner:** `samujjwal/ghatana-media`  
**Historical executable source / possible still-running deployment:** `samujjwal/ghatana:services/media` (read-only for new Media source changes)  
**Current migration state:** destination source consolidation ongoing; operational/data cutover not executed

Ghatana Media is a standalone product boundary for the Media bounded context.
The planned transfer includes the existing media runtime, packages and clients,
authored service contract sources, tests, fixtures, benchmarks, configuration,
deployment and monitoring material, subject to the file-by-file dispositions
in `migration/`. Under accepted decision MDI-001, generic Document Intelligence
execution, OCR/parser providers, extraction semantics, evaluation, and
qualification are platform-owned and excluded from Media Product Truth. The
source rehome, public client publication, and Media consumer rebinding remain
separate execution gates; no runtime cutover is implied here.
See `docs/migration/decisions/MDI-001-document-intelligence-ownership.md` for
the supplemental ownership decision that narrows the master-plan transfer scope.

**Effective immediately, all new Media-specific backend implementation, migration source, runtime contracts, tests and provider wiring are authored in this `ghatana-media` repository.** The old subtree is read-only historical source evidence; no new Media coding belongs there. Independently, `ghatana-media/.product-experience/` remains the sole product meaning authority. Until a genuine operational source/data/consumer cutover is verified, any still-running original binary may remain the sole **active** database, worker, event/outbox and schema writer. The destination Media process uses isolated development/test resources and must not publish competing production state/endpoints or claim readiness. Code location change ≠ production data or deployment migration.

Ghatana Media owns media-specific artifact, upload, job, stream, speech, vision,
scene-text recognition, consent and lifecycle semantics after cutover. Platform
mechanics remain with their owners. The Media product may consume only admitted
public contracts, published artifacts, generated wire clients, or bounded
integration providers; the platform repositories must not import Media
implementation source or product packages.

Data Cloud retains its generic governed metadata, read-model and compatibility
surface. AI Inference retains generic model execution, provider/model
governance, quota and routing. Shared retains neutral workflow, messaging,
audit, observability, identity, design-system, governed-document and
document-extraction contracts. Ghatana owns the reusable
`services/document-intelligence` runtime and its OCR/parser providers, document
parsing/extraction, evaluation and qualification. Media consumes its public API
for media-specific text recognition; temporal frame, scene, track, timeline,
overlay and editing semantics remain Media-owned. Tools retains generic
product-development and experience-specification contracts. Domain consumers
retain their own business meaning and must use public Media or Document
Intelligence boundaries.

The boundary preserves the current supported wire identities and behavior while
the source moves. Repository relocation alone does not authorize runtime/data
handover, production deployment, provider activation, or a readiness promotion.

## Migration decision

This boundary slice is approved for migration preparation under the user's
explicit requests on 2026-10-04, including the supplemental Document
Intelligence ownership instruction. This narrowly approves migration preparation, **not** runtime source cutover,
deployment or commercial release. The four independent PDP **development**
definitions are now `DEV_COMPLETE` (zero PDP tasks); that development fact does
not replace separate external or formal acceptance. Source authority changes only through the
cross-repository cutover protocol and its recorded manifest.

## MDI-002 (PROPOSED) — Document Intelligence packaging re-homing, 2026-11-12

`docs/migration/decisions/MDI-002-document-intelligence-media-packaging.md` **proposes** a bounded, additive supersession of
only the *packaging/ownership location* clause of MDI-001 (MDI-001 is preserved byte-for-byte). Under the proposal the single
existing Document Intelligence worker and its clients are copied, without redesign, to `services/document-intelligence/` as an
independently packageable, product-neutral module. It remains **PROPOSED**: no independent architectural review is claimed, and
until it is accepted the MDI-001 position above stays the accepted record.

Unchanged under either outcome: one DI public gateway (`document-intelligence.v1`, no second OCR gateway/model/contract version,
no invented status GET); Media's scene/temporal adapter calls only the DI public client; Shared owns the document/extraction
contracts; Kernel is the sole product-facing resolver; DI outage never disables non-OCR Media.

**Deployment-writer state:** the existing Ghatana Document Intelligence deployment remains the **only active writer** until a
source, data, consumer and endpoint cutover is proven. The Media copy is **not** an active deployment writer and must never be
started against the same state/endpoint. Package, deploy, monitor and roll back DI independently using
`docs/operations/DOCUMENT-INTELLIGENCE-RELEASE-RUNBOOK.md`. The source→destination mapping is in
`docs/migration/document-intelligence-source-destination-crosswalk.md` and `services/document-intelligence/MIGRATION-MANIFEST.json`.
