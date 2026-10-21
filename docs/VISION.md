# Media vision

Media makes governed audio, video, image, speech, spatial, and time-based
work understandable and reviewable from user intent through an approved
output. A person or integrating product should be able to preserve the exact
source, understand what was observed or changed, recover from uncertain work,
and see the authority, provenance, rights, quality, and finality boundaries of
the result.

## Consumers

- Media product, design, accessibility, quality, privacy, and runtime owners.
- Web, CLI, API, SDK, embedded, agent/tool, event, and system integration consumers after their contracts are
  owner-approved and published.
- Ghatana Tools and Shared as upstream contract owners, not as Media semantic
  authorities.
- Reviewers who need to inspect product truth, design language, product
  experience, and Explorer projections without mistaking a proposal for a
  shipped capability.

## Non-goals

Media does not own generic identity, Document Intelligence/OCR execution, Data Cloud read
models, event delivery mechanics, generic model/provider mechanics, or
privileged effects. The Product Experience Explorer projects canonical meaning
and may change synthetic fixture state for inspection. It sits outside PDP phase
numbering and is not a production runtime or acceptance authority.

This repository does not claim that a capability, provider, model, asset,
package, route, or fixture is licensed, qualified, available, or production
ready merely because it is described or present in the tree.

Per accepted MDI-001, Media owns only scene-text meaning and its temporal,
region, tracking, scene-association, and editing semantics. Generic OCR and
document extraction remain platform-owned. Media runtime use remains gated on
the published, consumer-verified Document Intelligence client; existing OCR
code is not itself a binding or qualification claim.

## Phase progression

The user's Four-Phase Product Definition Hardening Plan requires exactly PDP-0
Product Truth, PDP-1 Canonical Domain & Data Model, PDP-2 Design Language &
Interface System, and PDP-3 Complete Product Experience, followed by an Explorer
projection outside those phases. The authoring tree now uses
`pdp-0-product-truth/`, `pdp-1-domain-data/`,
`pdp-2-design-interface-system/`, `pdp-3-product-experience/`, and `explorer/`
beneath `.product-experience/`.

Intended consumer surfaces are indexed in the
[surface registry](../.product-experience/surface-registry.yaml). The
expert-reviewed migration plan remains a provenance reference; it does not
override meaning in the owning PDP authority. This page is a reader summary,
not a second source for requirements, coverage, or phase status.

Canonical outcomes and requirements are in
[Product Truth](../.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md).
The single vision-to-requirement-to-experience crosswalk is
[`vision-requirements-coverage.yaml`](../.product-experience/vision-requirements-coverage.yaml).
Current phase status is recorded in the source-pinned records linked from the
[PDP source index](../.product-experience/README.md). No Media application has
been released.
