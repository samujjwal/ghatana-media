# Media product definition source index

This index routes readers to the authored product sources and the records that report their current development state. Product meaning is maintained in the phase-owned definitions; this file does not restate those definitions or create a second task or status source.

## Product and scope sources

- Product definition entry point: [`.product-experience/README.md`](../../.product-experience/README.md)
- Surface denominator: [`.product-experience/surface-registry.yaml`](../../.product-experience/surface-registry.yaml)
- Physical and composite topology: [registered Media topology](../../.product-experience/surfaces/media-physical-topology.v1.json)
- Cross-phase source ownership: [`.product-experience/source-manifest.yaml`](../../.product-experience/source-manifest.yaml)
- Cross-phase traces: [`.product-experience/traceability.yaml`](../../.product-experience/traceability.yaml)

## Build implementation planning (current)

- **Single canonical BUILD / Plan Implementation plan:** [Media Build Implementation Plan](MEDIA-BUILD-IMPLEMENTATION-PLAN.md) — 14 common/foundation work packages F00–F13, 30 PDP-3 end-to-end journey packages V01–V30, three Recorder/Studio/Player consumer packages L01–L03, and three integrated Build verification/handoff packages X01–X03. Reuse public Ghatana ecosystem contracts; canonical writer remains `ghatana/services/media` until an authorized transfer.
- **Exact indexed trace (projection, not second plan):** [Build Identity Trace](MEDIA-BUILD-IDENTITY-TRACE.v1.json) — 3,186 stable source identities with 54 surface and 61 channel-edge obligations. Derived planning ownership is not observed runtime proof or PDP closure.
- **Early business-outcome demo recording (subplan of canonical Build authority):** [§5A in canonical plan](MEDIA-BUILD-IMPLEMENTATION-PLAN.md#5a-early-pdp-source-derived-recording-of-the-first-complete-business-outcome) and [source-derived first demo recording profile](MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json). Begin data-driven recorder qualification in parallel; record the **first verified customer-valued PDP-0→PDP-3 terminal outcome** on a source-admitted real channel as soon as its product/recorder/data/privacy gates pass (initial target J01→J02→J20→J03: corrected reviewable caption version). Do not wait for all 30 verticals, full L01/Studio/Player, PDP closure or Delivery. Both the profile and film status remain PLANNED/NOT_CAPTURED, not executable proof.
- **Proposed ecosystem PDP-3 demo-scenario standard:** [§5B in canonical Build plan](MEDIA-BUILD-IMPLEMENTATION-PLAN.md#5b-pdp-3-demo-ready-scenario-standard--proposed-ecosystem-wide-adoption) separates mandatory, source-defined demo-ready scenarios in PDP-3 from actual films and real-effect evidence in Build. Media currently has 31 rich synthetic scenarios for 4 of 30 journeys; the other 26 have bounded step-definition oracles and require rich demo-plan backfill for the proposed stricter standard. Adoption does **not** retroactively reopen the four recorded `DEV_COMPLETE` phases or block first customer-outcome recording. Tools/Kernel/product-owner approval is still required before promoting this to a normative cross-repo gate.
- Earlier dated Build/discovery/implementation plans are reference/provenance only; do not treat their counts or task statuses as current implementation authority. No release or external acceptance is claimed.

## Phase definitions and development status

- PDP-0 Product Truth: [definition](../../.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md) · [development status](pdp-0-phase-dev-status.json)
- PDP-1 Canonical Domain & Data: [definition](../../.product-experience/pdp-1-domain-data/DOMAIN-MODEL.md) · [development status](pdp-1-phase-dev-status.json)
- PDP-2 Design Language & Interface System: [definition](../../.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md) · [development status](pdp-2-phase-dev-status.json)
- PDP-3 Complete Product Experience: [definition](../../.product-experience/pdp-3-product-experience/COMPLETE-PRODUCT-EXPERIENCE.md) · [development status](pdp-3-phase-dev-status.json)

Work proceeds PDP-0, PDP-1, PDP-2, then PDP-3. Select the earliest unfinished phase and use that phase's authored sources and source-pinned status record. A generated matrix is a projection of its sources. `DEV_COMPLETE` records definition development only; it does not establish implementation, acceptance, closure, qualification, or release.
