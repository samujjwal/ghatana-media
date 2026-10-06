# Media design

## Purpose, consumers, and change policy

This guide explains existing runtime decisions and the prescribed product
definition target for Media implementers, SDK/UI consumers, and reviewers.
[ARCHITECTURE](ARCHITECTURE.md) owns the runtime topology description; detailed
proposed meaning stays in [.product-experience](../.product-experience/).
It introduces no wire contract, acceptance, or product-ownership decision.

Change product meaning in its owning phase first; update projections and tests
from that source. Preserve existing compatibility until consumer parity and the
cutover/acceptance record authorize change. The four-phase hardening plan in
[REQUIREMENTS](REQUIREMENTS.md) is the governing minimum.

## Runtime decisions and rationale

| Decision | Constraint / reason |
| --- | --- |
| Exact source/upload identity and checksum finalization | Sequential bounded chunks and full digest verification prevent incomplete/corrupt bytes from becoming an accepted artifact |
| Tenant/principal-scoped idempotency | Repeated requests must reuse compatible durable identity or conflict; they must not create duplicate remote work |
| Job leases, fencing, optimistic versions, and bounded concurrency | One valid worker owns a job; stale owners and unbounded work are rejected |
| Explicit cancellation and unknown outcomes | A request to stop is distinct from provider-confirmed cancellation; restart uncertainty requires reconciliation before replay |
| Stream token hashes, reconnect leases, ordered acknowledgements, bounded buffers | Identity, sequence, and backpressure remain explicit across reconnect/degradation |
| Consent/privacy checks and semantic redaction | Purpose, rights, residency, biometric permission, retention, and erasure constrain execution; unavailable required redaction fails closed |
| Synchronous store/provider boundary with async service composition | Technology-specific I/O stays behind runtime interfaces rather than leaking into public domain meaning |
| Diagnostic local composition | File/in-memory stores and bounded synchronous publication permit local checks; durable restart/publication require separate adapters and proof |

## Public/internal split, validation, and errors

HTTP wire observations are in [OpenAPI](../contracts/openapi/media.yaml) and the
[route manifest](../config/route-manifest.json); protobufs and package exports
are inventoried in [docs/README.md](README.md). Runtime types/SPIs live in
`runtime-contracts/`; launcher and provider internals enforce configuration,
authorization, input/body bounds, state guards, leases, and consent. Failed
validation, dependency outage, unsupported cancellation, partial work, and
unconfirmed external outcomes require explicit errors/recovery. Local UI/types
must not independently rename canonical states; PDP1-003 owns reconciliation.

## Extension and customization model

Store, processing/streaming provider, consent, redaction, privacy-maintenance,
and lifecycle-publication implementations are selected through existing runtime
SPIs/ServiceLoader registrations and configuration. New adapters must preserve
the existing contract, tenant isolation, readiness, privacy, and finality behavior
and supply the corresponding focused tests. Configuration does not grant
capability qualification or bypass owner admission. See [OPERATIONS](OPERATIONS.md)
for keys/defaults, startup, shutdown, and diagnostics.

Shared owns generic tokens/components/themes/accessibility/i18n. Media may own
semantic aliases and media-specific composition; responsive/layout or locale
variants cannot change product effects, authority, or finality. Media UI metadata
declares Shared `0.1.2` dependencies, while the local Explorer package declares
the simulation package. PDP-2 now contains primitive, pattern, layout, template,
and screen-composition registries; published version bindings, component/token
provenance, and rendered conformance remain unverified. Registry presence alone
does not establish Explorer conformance.

## Definition layers and generated ownership

PDP-0 owns product truth; PDP-1 owns canonical objects, operations, states,
events, evidence, provenance, authority, and history; PDP-2 owns design and
interface language; PDP-3 owns complete surface experiences. Explorer projects
those layers and uses synthetic fixtures. The directory tree now follows this
four-phase model; the records remain proposals except for the accepted P0-001
boundary slice.

`pnpm generate:product-definition-manifest` generates
`.product-experience/source-manifest.yaml` and
`apps/media-experience-explorer/specification-artifacts.json` from the authored
Product Definition tree. Rerun it after changing those sources; do not edit
either generated file manually. The generator preserves IDs for unchanged paths
and derives IDs from repository paths for newly indexed paths, so these artifact
IDs are not semantic stable IDs. Its content hashes are provenance only, its
dependency lists are not populated, and it does not generate owner-approved
semantic fingerprints or currentness. Those remain Tools-owned contracts and
observations.

The legacy feature-completeness report is retired. The local authority checker
provides structural denominator and reference observations only; it is not a
semantic completeness assessment or an acceptance report.

Route-manifest regeneration is owned by the launcher; Tools owns generic
schema/validator/fingerprint/currentness contracts. Never hand-author generated
receipts/currentness or infer readiness from a package description. CLEAN-2 /
GAP-06 records the selected source-specific OpenAPI, route-manifest, protobuf,
and provider-manifest authorities. No aggregate `service-contract.yaml` is an
active design authority.

## Non-goals and alternatives requiring decisions

Media does not implement platform identity, generic model routing, generic OCR,
Event Plane delivery mechanics, or another product's domain truth. MDI-001
establishes Document Intelligence ownership, and
`.product-experience/pdp-0-product-truth/ocr-ownership.yaml` records the local
classification of prepared OCR code. Public-client binding and runtime adapter
reconciliation remain open under PDP0-003/IMP-01. The competing SDK route
families and `av.*` tool identity policy require owner decisions before changes.
Duplicating Shared values, treating Explorer as a PDP phase, or using path-derived
IDs as semantic identity cannot satisfy the prescribed target.

## Verification

Use [TESTING](TESTING.md) for command prerequisites, state/failure/compatibility
cases, and design/accessibility coverage. [EVIDENCE](EVIDENCE.md) describes the
local/native proof boundary and required repeatability. Production qualification,
pixel references, and independent reviews remain required evidence.
