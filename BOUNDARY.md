# Ghatana Media repository boundary

**Product identity:** `media`  
**Destination:** `samujjwal/ghatana-media`  
**Current canonical source:** `samujjwal/ghatana:services/media`  
**Current migration state:** preparation; source remains canonical

Ghatana Media is a standalone product boundary for the Media bounded context.
The planned transfer includes the existing media runtime, packages and clients,
authored service contract sources, tests, fixtures, benchmarks, configuration,
deployment and monitoring material, subject to the file-by-file dispositions
in `migration/`. The generic document-intelligence worker is explicitly
excluded and will be rehomed to `ghatana/services/document-intelligence`.
See `docs/migration/decisions/MDI-001-document-intelligence-ownership.md` for
the supplemental ownership decision that narrows the master-plan transfer scope.

Until an admitted cutover manifest is executed, `ghatana/services/media` is the
only editable runtime and semantic authority. Any prepared content in this
repository is migration-only and must not be used to publish competing runtime
state, production endpoints, or readiness claims.

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
Intelligence ownership instruction. It does not accept the remaining Phase 0
requirements or Phase 1–3 artifacts. Source authority changes only through the
cross-repository cutover protocol and its recorded manifest.
