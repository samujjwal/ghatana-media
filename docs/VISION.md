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

Intended consumer surfaces and their proposal, implementation, and
qualification dispositions are indexed in
[surface-registry.yaml](../.product-experience/surface-registry.yaml). The
expert-reviewed migration plan remains an execution and provenance reference;
it does not override meaning in the owning PDP authority.

This directory normalization establishes the intended structure; it does not
accept the semantics in those directories. Existing task IDs remain planning
provenance, and source presence or relocation does not accept product meaning.

The complete vision-to-requirement-to-experience crosswalk is maintained in
[PRODUCT-DEFINITION-COVERAGE.md](PRODUCT-DEFINITION-COVERAGE.md) and its
machine-readable ledger
[../.product-experience/vision-requirements-coverage.yaml](../.product-experience/vision-requirements-coverage.yaml).
Each of the ten P0 outcomes is linked to requirement groups and either a
canonical journey or an explicitly classified supporting view. Each later
phase retains those links; implementation, owner acceptance, currentness, and
native evidence remain separate statuses.

Only the P0-001 migration boundary slice is accepted in the current source
tree; the remaining phase material is proposal or local implementation work
until its owner and native evidence gates are satisfied.
